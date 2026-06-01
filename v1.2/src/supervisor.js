// montydyn V1.0 — SupervisorDO (a NORMAL SQLite-backed DurableObject) + Worker entry.
//
// ADR-0003 architecture. The supervisor owns everything a facet cannot:
//   - ROUTING: sessionId -> kernel FACET (ctx.facets.get(facetName, ...)). Sharded at
//     the Worker entry (hash sessionId -> supervisorId) with a BOUNDED facet count per
//     supervisor, so we never pile thousands of facets under one (scale guardrail from
//     docs/research/coldstart-and-v1.md).
//   - PER-TENANT auth/metering hooks (tenant -> allowed sessions; here a thin scaffold).
//   - ALARMS / TTL: facets CANNOT set alarms, so idle-eviction is driven here.
//   - worker_loaders binding (LOADER): loads the kernel facet class, ships quickjs.wasm
//     as a {wasm} module. codeId is content-versioned (the loader caches by codeId; a
//     stale codeId silently reuses the old isolate — proven foot-gun).
//   - WS HIBERNATION: the supervisor accepts the client WebSocket (acceptWebSocket works
//     on a normal DO) and proxies each frame into the facet via RPC. A facet-held client
//     socket does NOT work (DataCloneError / no inbound frame delivery) — proven.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  KERNEL_FACET_SRC,
  KERNEL_GLUE_SRC,
  QUICKJS_WASM_B64,
  QJS_DIST,
  STDLIB_BUNDLE_TXT,
  STDLIB_META_SRC,
  EXT_WASM_B64,
  EXTENSION_ORDER,
  KERNEL_CODE_ID,
  ENGINE_HASH,
} from "./modules.gen.js";

// Bounded facets per supervisor shard (scale guardrail). The Worker entry hashes
// sessionId across SHARD_COUNT supervisors, each holding tens-to-low-hundreds.
const SHARD_COUNT = 64;
const MAX_FACETS_PER_SUPERVISOR = 128;
// Idle TTL: a facet untouched for this long is hard-evicted (ctx.facets.abort). Its
// SQLite snapshot survives, so the next frame cold-restores. Supervisor alarm-driven.
const FACET_IDLE_TTL_MS = 5 * 60 * 1000;
const ALARM_INTERVAL_MS = 60 * 1000;
// V1.1 ADAPTIVE KEEP-WARM (supervisor-side; facets cannot self-warm or alarm). The sweep
// runs on a shorter cadence so it can heartbeat predicted-active facets BEFORE the idle TTL
// would abort them. A heartbeat is a cheap RPC ping into the facet (touches _lastActivity,
// keeps the isolate resident) that pushes warm_until forward. We keep-warm ONLY sessions
// that look genuinely active and would otherwise eat the ~1.5s deep cold-wake; everything
// else (one-shot, walked-away, naturally-slow, big-image-non-sensitive) is allowed to
// hibernate — the explicit "decide WHEN NOT to warm" goal.
const WARM_SWEEP_INTERVAL_MS = 30 * 1000; // heartbeat sweep cadence
const WARM_EWMA_ALPHA = 0.4; // EWMA smoothing for inter-arrival cadence
// A session is a keep-warm candidate only if it has been used at least this many times
// (one-shot sessions are NOT worth warming — they likely won't come back).
const WARM_MIN_EVALS = 2;
// Only warm if the observed cadence is faster than this (a fast, interactive loop). A
// naturally-slow-cadence session (gap >= this) tolerates the cold-wake and is NOT warmed.
const WARM_MAX_EWMA_MS = 90 * 1000;
// Recency gate: only warm if the last access is within K x the cadence (still "in a burst").
// Beyond this the user has likely walked away -> let it hibernate.
const WARM_RECENCY_K = 2.5;
// A predicted-active session's eviction is DELAYED to this horizon past now on each heartbeat.
const WARM_HORIZON_MS = 4 * 60 * 1000;
// Big snapshots are expensive to keep churning warm; a non-latency-sensitive session whose
// image exceeds this is allowed to hibernate (cold-restore cost is bounded and acceptable).
const WARM_MAX_SIZE_GZ_NONSENSITIVE = 512 * 1024;

// V1.2 metering: the AE dataset (writeDataPoint) records per-tenant usage events. We pack
// a single "metric" discriminator into blob2 so /usage can aggregate by metric. blob1 =
// tenantId (the dimension we GROUP BY); index1 = tenantId (cheap AE SQL filter). double1
// carries the numeric metric value (evals=1, snapshot bytes sizeGz, warm-seconds, facets).
// double2 carries a session marker (1) used to count distinct-ish active sessions.

// V1.2 auth: API keys are stored HASHED (never plaintext) in the control-plane SQLite.
// SHA-256 hex of the raw key; the raw key is shown ONCE at mint time and never persisted.
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mint a random opaque key: "md_" + 32 random bytes hex. Shown once at mint time.
function mintRawKey() {
  const u8 = new Uint8Array(32);
  crypto.getRandomValues(u8);
  return "md_" + [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish string compare for the admin token (avoid trivial timing oracle).
function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

// FNV-1a -> shard index. Stable, dependency-free.
function shardFor(sessionId, n) {
  let h = 0x811c9dc5;
  const s = String(sessionId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "sup-" + (h % n);
}

// Per-tenant facet name. Tenant is part of the key so two tenants NEVER share a facet
// even if they pick the same sessionId — hard storage isolation (facet-per-name).
function facetName(tenant, sessionId) {
  return "k:" + String(tenant) + ":" + String(sessionId);
}

export class SupervisorDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    // Supervisor control plane (its OWN isolated SQLite — a facet provably cannot read it).
    // V1.1 keep-warm: the sessions registry now also tracks per-session access CADENCE so the
    // adaptive sweep can decide WHEN NOT to warm. eval_count, inter_arrival_ewma_ms (EWMA of
    // gaps between touches), last_inter_arrival_ms, warm_until (a heartbeat pushes this
    // forward), latency_sensitive (explicit opt-in), and last_size_gz (image cost) inform it.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         facet TEXT PRIMARY KEY,
         tenant TEXT,
         session_id TEXT,
         created_at INTEGER,
         last_activity INTEGER,
         eval_count INTEGER DEFAULT 0,
         inter_arrival_ewma_ms INTEGER DEFAULT 0,
         last_inter_arrival_ms INTEGER DEFAULT 0,
         warm_until INTEGER DEFAULT 0,
         latency_sensitive INTEGER DEFAULT 0,
         last_size_gz INTEGER DEFAULT 0
       );`,
    );
    // Forward-compat: add columns if an older sessions table predates V1.1 (idempotent).
    for (const col of [
      "eval_count INTEGER DEFAULT 0",
      "inter_arrival_ewma_ms INTEGER DEFAULT 0",
      "last_inter_arrival_ms INTEGER DEFAULT 0",
      "warm_until INTEGER DEFAULT 0",
      "latency_sensitive INTEGER DEFAULT 0",
      "last_size_gz INTEGER DEFAULT 0",
    ]) {
      try { this.ctx.storage.sql.exec(`ALTER TABLE sessions ADD COLUMN ${col};`); } catch (_) {}
    }

    // V1.2 TENANT REGISTRY (control-plane SQLite — a facet provably cannot read it). Maps a
    // tenantId to a HASHED apiKey (SHA-256 hex; raw key shown once at mint, never persisted),
    // its created timestamp, plan, and revoked flag. The WS upgrade + control routes require
    // a key (header x-api-key or ?apiKey=) that hashes to a live, non-revoked row, else 401;
    // the resolved tenantId is then the routing/isolation scope (facetName keys by tenant).
    // NOTE: tenants are minted on a single supervisor shard (the AUTH shard), but auth must
    // work from ANY shard a session hashes to — so reads go through the AUTH shard (see
    // _resolveTenant / Worker entry). This table is the authoritative copy on the AUTH shard;
    // other shards keep a local mirror populated lazily on first successful auth (cache).
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS tenants (
         api_key_hash TEXT PRIMARY KEY,
         tenant_id    TEXT NOT NULL,
         created_at   INTEGER,
         plan         TEXT DEFAULT 'free',
         revoked      INTEGER DEFAULT 0
       );`,
    );
  }

  // ---- V1.2 AUTH (control-plane tenant registry) ----
  // Admin: mint a key for a tenant. Returns the RAW key ONCE (only its hash is stored).
  async _mintKey(tenantId, plan) {
    const raw = mintRawKey();
    const hash = await sha256Hex(raw);
    this.ctx.storage.sql.exec(
      "INSERT INTO tenants(api_key_hash,tenant_id,created_at,plan,revoked) VALUES(?,?,?,?,0);",
      hash, String(tenantId), Date.now(), String(plan || "free"),
    );
    return { tenantId: String(tenantId), plan: String(plan || "free"), apiKey: raw, apiKeyHash: hash };
  }

  // Admin: list keys (hashes + metadata only; raw keys are never recoverable).
  _listKeys() {
    return this.ctx.storage.sql
      .exec("SELECT api_key_hash, tenant_id, created_at, plan, revoked FROM tenants ORDER BY created_at;")
      .toArray();
  }

  // Admin: revoke a key by its hash (or revoke every key for a tenant).
  async _revokeKey({ apiKey, apiKeyHash, tenantId }) {
    if (apiKey) apiKeyHash = await sha256Hex(apiKey);
    if (apiKeyHash) {
      this.ctx.storage.sql.exec("UPDATE tenants SET revoked=1 WHERE api_key_hash=?;", apiKeyHash);
      return { revoked: apiKeyHash };
    }
    if (tenantId) {
      this.ctx.storage.sql.exec("UPDATE tenants SET revoked=1 WHERE tenant_id=?;", String(tenantId));
      return { revokedTenant: String(tenantId) };
    }
    return { revoked: null };
  }

  // Resolve a raw API key -> tenantId on THIS shard's registry. Returns null if absent/revoked.
  async _resolveLocal(rawKey) {
    if (!rawKey) return null;
    const hash = await sha256Hex(rawKey);
    const row = this.ctx.storage.sql
      .exec("SELECT tenant_id, plan, revoked FROM tenants WHERE api_key_hash=?;", hash)
      .toArray()[0];
    if (!row || row.revoked) return null;
    return { tenantId: row.tenant_id, plan: row.plan, hash };
  }

  // Mirror an authoritative tenant row onto a non-AUTH shard (cache for fast local auth).
  _cacheTenant({ hash, tenantId, plan }) {
    if (!hash || !tenantId) return;
    try {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO tenants(api_key_hash,tenant_id,created_at,plan,revoked) VALUES(?,?,?,?,0);",
        hash, String(tenantId), Date.now(), String(plan || "free"),
      );
    } catch (_) {}
  }

  // RPC used by other shards to authoritatively resolve a key against the AUTH shard.
  async authResolve(rawKey) {
    return await this._resolveLocal(rawKey);
  }

  // ---- V1.2 METERING (Analytics Engine) ----
  // Record one usage event. metric in {eval, bytes, warm, facet}; value is the numeric.
  _meter(tenant, metric, value, sessionId) {
    try {
      if (!this.env || !this.env.AE || typeof this.env.AE.writeDataPoint !== "function") return;
      this.env.AE.writeDataPoint({
        indexes: [String(tenant)],
        blobs: [String(tenant), String(metric), String(sessionId || "")],
        doubles: [Number(value) || 0, 1],
      });
    } catch (_) {}
  }

  // ---- Worker Loader: kernel facet class, codeId-versioned, quickjs.wasm via {wasm} ----
  // V1.1: the module map now ALSO ships the configurable in-VM stdlib bundle (as a {text}
  // module), the stdlib meta (as a {js} module that sets globalThis.__STDLIB_META), and the
  // 5 Tier-0 native extension .wasm (each as a {wasm} module — the only in-facet wasm path).
  #loadKernel() {
    // codeId = KERNEL_CODE_ID (content hash of glue+facet+wasm+dist+stdlib+ext, ordered).
    // Any source/lib/extension change -> new codeId -> fresh compile (no stale-isolate foot-gun).
    return this.env.LOADER.get(KERNEL_CODE_ID, async () => {
      const modules = {
        "facet-kernel.js": KERNEL_FACET_SRC,
        "glue.js": KERNEL_GLUE_SRC,
        "quickjs.wasm": { wasm: b64ToArrayBuffer(QUICKJS_WASM_B64) },
        // V1.1 SLICE A: stdlib bundle (text) + meta (js sets __STDLIB_META).
        "stdlib.bundle.txt": { text: STDLIB_BUNDLE_TXT },
        "stdlib-meta.js": STDLIB_META_SRC,
      };
      for (const [f, src] of Object.entries(QJS_DIST)) modules["qjs/" + f] = src;
      // V1.1 SLICE B: each extension Module as a {wasm} loader module under ext/.
      for (const name of EXTENSION_ORDER) {
        modules["ext/" + name + ".wasm"] = { wasm: b64ToArrayBuffer(EXT_WASM_B64[name]) };
      }
      return {
        compatibilityDate: "2026-04-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "facet-kernel.js",
        modules,
        // V1.1 SLICE (mediated fetch): instead of null-blocking ALL egress, route the
        // facet's outbound fetch through a per-tenant HttpGateway WorkerEntrypoint. The
        // gateway enforces a coarse host allowlist (env MEDIATED_FETCH_DENY/ALLOW); the
        // fine-grained per-session allowlist is the in-VM config.fetch (FetchBlockedError).
        // host.fetch defaults to disabled per session (config.fetch:false) until configured.
        globalOutbound: this.#egress(this._egressTenant || "anon"),
      };
    });
  }

  // Build the per-tenant egress gateway WorkerEntrypoint instance handed to the facet as
  // globalOutbound. ctx.exports.HttpGateway({props}) instantiates the entrypoint with
  // per-facet props (the tenant) so the gateway can scope/meter egress per tenant.
  #egress(tenant) {
    try {
      return this.ctx.exports.HttpGateway({ props: { tenant: String(tenant) } });
    } catch (_) {
      // Older runtime without ctx.exports: fall back to fully blocked egress (safe default).
      return null;
    }
  }

  #facet(tenant, sessionId) {
    const name = facetName(tenant, sessionId);
    // The loader closure reads this._egressTenant to scope the gateway props. Set it just
    // before #loadKernel runs inside the facet factory (single-threaded DO, no race).
    this._egressTenant = String(tenant);
    return this.ctx.facets.get(name, async () => {
      const worker = this.#loadKernel();
      return { class: worker.getDurableObjectClass("KernelFacet") };
    });
  }

  // Record/refresh a session in the control plane, enforce the per-supervisor bound,
  // update the access-cadence stats (EWMA of inter-arrival gaps) used by the adaptive
  // keep-warm sweep, and (re)arm the alarm.
  _touch(tenant, sessionId) {
    const name = facetName(tenant, sessionId);
    const now = Date.now();
    const row = this.ctx.storage.sql.exec("SELECT * FROM sessions WHERE facet=?;", name).toArray()[0];
    if (!row) {
      const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM sessions;").toArray()[0].c | 0;
      if (count >= MAX_FACETS_PER_SUPERVISOR) {
        throw new Error(
          `supervisor facet cap reached (${count}/${MAX_FACETS_PER_SUPERVISOR}); session rejected (shard is full)`,
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO sessions(facet,tenant,session_id,created_at,last_activity,eval_count) VALUES(?,?,?,?,?,1);",
        name, String(tenant), String(sessionId), now, now,
      );
    } else {
      // Inter-arrival gap since the last real activity (skip when the row was reset to 0 by
      // an eviction — a post-eviction touch is a fresh burst start, not a cadence sample).
      // NOTE: ms timestamps exceed 2^31, so NEVER use `| 0` on them (it truncates to garbage).
      const prev = Number(row.last_activity) || 0;
      let ewma = Number(row.inter_arrival_ewma_ms) || 0;
      let gap = Number(row.last_inter_arrival_ms) || 0;
      if (prev > 0) {
        gap = Math.max(0, now - prev);
        ewma = ewma > 0 ? Math.round(WARM_EWMA_ALPHA * gap + (1 - WARM_EWMA_ALPHA) * ewma) : gap;
      }
      this.ctx.storage.sql.exec(
        "UPDATE sessions SET last_activity=?, eval_count=eval_count+1, inter_arrival_ewma_ms=?, last_inter_arrival_ms=? WHERE facet=?;",
        now, ewma, gap, name,
      );
    }
    this._armAlarm();
  }

  // Mark a session latency-sensitive (opt-in): it is kept warm regardless of cadence.
  _setLatencySensitive(tenant, sessionId, on) {
    this.ctx.storage.sql.exec(
      "UPDATE sessions SET latency_sensitive=? WHERE facet=?;",
      on ? 1 : 0, facetName(tenant, sessionId),
    );
  }

  // Record the latest snapshot size for a session (cost input to the keep-warm decision).
  _recordSize(tenant, sessionId, sizeGz) {
    if (!(sizeGz > 0)) return;
    this.ctx.storage.sql.exec(
      "UPDATE sessions SET last_size_gz=? WHERE facet=?;",
      sizeGz | 0, facetName(tenant, sessionId),
    );
  }

  async _armAlarm() {
    const cur = await this.ctx.storage.getAlarm();
    // Use the SHORTER keep-warm sweep cadence so heartbeats land before the idle TTL.
    if (cur == null) await this.ctx.storage.setAlarm(Date.now() + WARM_SWEEP_INTERVAL_MS);
  }

  // Decide whether a session should be KEPT WARM (predicted-active) vs allowed to hibernate.
  // Returns true ONLY for sessions that are genuinely interactive AND would otherwise eat the
  // deep cold-wake. Everything else returns false — the deliberate "decide when NOT to warm".
  _shouldWarm(row, now) {
    if (!row || (Number(row.last_activity) || 0) <= 0) return false; // evicted/never-active
    if (row.latency_sensitive) return true; // explicit opt-in always wins
    const evals = row.eval_count | 0;
    const ewma = Number(row.inter_arrival_ewma_ms) || 0;
    const recency = now - (Number(row.last_activity) || 0);
    // One-shot sessions: not worth warming.
    if (evals < WARM_MIN_EVALS) return false;
    // No usable cadence yet (single gap, etc.): be conservative, do not warm.
    if (ewma <= 0) return false;
    // Naturally-slow cadence: tolerate the cold-wake.
    if (ewma >= WARM_MAX_EWMA_MS) return false;
    // Walked away (last access far beyond the expected cadence): let it hibernate.
    if (recency > WARM_RECENCY_K * ewma) return false;
    // Big image + not latency-sensitive: churning a large snapshot warm is not worth it.
    if ((row.last_size_gz | 0) > WARM_MAX_SIZE_GZ_NONSENSITIVE) return false;
    return true;
  }

  // ALARM: adaptive keep-warm + idle-TTL sweep. For predicted-active sessions we HEARTBEAT
  // the facet (a cheap RPC ping that keeps the isolate resident and pushes warm_until
  // forward) instead of evicting — so an active session never falls to the ~1.5s deep
  // cold-wake. Sessions past the idle TTL that are NOT predicted-active (and not inside a
  // live warm horizon) are hard-evicted via ctx.facets.abort; their SQLite snapshot
  // survives so the next frame cold-restores. Facets can't alarm — this is supervisor duty.
  async alarm() {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM sessions WHERE last_activity > 0;")
      .toArray();
    for (const row of rows) {
      const idle = now - (Number(row.last_activity) || 0);
      const warmUntil = Number(row.warm_until) || 0;
      const insideHorizon = warmUntil > now;
      const warm = this._shouldWarm(row, now);
      if (warm) {
        // HEARTBEAT: keep the facet resident. The ping touches the facet's _lastActivity and
        // (cheaply) ensures the kernel stays live, dodging the idle TTL. Push the warm horizon.
        try {
          const [, tenant, sessionId] = row.facet.split(":");
          const facet = this.#facet(tenant, sessionId);
          await facet.ping();
        } catch (_) {}
        this.ctx.storage.sql.exec(
          "UPDATE sessions SET warm_until=? WHERE facet=?;",
          now + WARM_HORIZON_MS, row.facet,
        );
        // METERING: each heartbeat keeps the isolate resident for ~one sweep interval; bill
        // that as warm-seconds against the tenant (the keep-warm cost is what /usage exposes).
        this._meter(row.tenant, "warm", WARM_SWEEP_INTERVAL_MS / 1000, row.session_id);
        continue;
      }
      // Not predicted-active. Evict only once past the idle TTL AND outside any live warm
      // horizon (a recently-de-prioritised session gets to coast out its horizon first).
      if (idle >= FACET_IDLE_TTL_MS && !insideHorizon) {
        try {
          this.ctx.facets.abort(row.facet, new Error("idle TTL eviction (supervisor alarm)"));
        } catch (_) {}
        this.ctx.storage.sql.exec(
          "UPDATE sessions SET last_activity=0, warm_until=0 WHERE facet=?;",
          row.facet,
        );
      }
    }
    // METERING: per-tenant live facet count snapshot (active sessions this sweep). One point
    // per tenant so /usage can report max/avg concurrent facets over the window.
    try {
      const perTenant = this.ctx.storage.sql
        .exec("SELECT tenant, COUNT(*) AS c FROM sessions WHERE last_activity > 0 GROUP BY tenant;")
        .toArray();
      for (const t of perTenant) this._meter(t.tenant, "facet", t.c | 0);
    } catch (_) {}
    // Re-arm while any session is still active (non-evicted).
    const active = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS c FROM sessions WHERE last_activity > 0;")
      .toArray()[0].c | 0;
    if (active > 0) await this.ctx.storage.setAlarm(now + WARM_SWEEP_INTERVAL_MS);
  }

  // ---- WS proxy: supervisor holds the hibernatable socket, proxies frames to the facet ----
  async webSocketMessage(ws, message) {
    const tags = this.ctx.getTags ? this.ctx.getTags(ws) : [];
    const tenant = (tags.find((t) => t.startsWith("t:")) || "t:anon").slice(2);
    const sessionId = (tags.find((t) => t.startsWith("s:")) || "s:default").slice(2);
    try {
      this._touch(tenant, sessionId);
      const facet = this.#facet(tenant, sessionId);
      const reply = await facet.handleMessage(String(message));
      // METERING: a WS frame that evaluated a cell counts as one eval; bill snapshot bytes.
      if (reply && (reply.type === "result" || reply.ok || reply.value !== undefined)) {
        this._meter(tenant, "eval", 1, sessionId);
      }
      if (reply && reply.checkpoint && reply.checkpoint.ok && reply.checkpoint.sizeGz) {
        this._recordSize(tenant, sessionId, reply.checkpoint.sizeGz);
        this._meter(tenant, "bytes", reply.checkpoint.sizeGz, sessionId);
      }
      ws.send(JSON.stringify({ ...reply, servedBy: "supervisor-proxy->facet" }));
    } catch (e) {
      ws.send(JSON.stringify({ ok: false, proxyError: String((e && e.message) || e) }));
    }
  }
  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (_) {}
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const J = (o, code = 200) =>
      new Response(JSON.stringify(o, null, 2), { status: code, headers: { "content-type": "application/json" } });
    // V1.2: the tenant is resolved by the Worker entry from the API key (NOT the client). It
    // is passed in via x-md-tenant so the client can never spoof a tenant by ?tenant=. The
    // entry rejects unauthenticated data-plane calls with 401 before they ever reach here.
    const tenant = req.headers.get("x-md-tenant") || url.searchParams.get("tenant") || "anon";
    const sessionId = url.searchParams.get("session") || "default";

    // ---- V1.2 control-plane RPC routes (entry -> AUTH shard), not client-facing ----
    // Resolve a key against this (authoritative) registry. Returns {tenantId,plan,hash}|null.
    if (p === "/_auth/resolve") {
      const key = url.searchParams.get("key") || req.headers.get("x-api-key") || "";
      return J(await this._resolveLocal(key));
    }
    if (p === "/_admin/mint") {
      const t = url.searchParams.get("tenantId") || url.searchParams.get("tenant");
      const plan = url.searchParams.get("plan") || "free";
      if (!t) return J({ error: "tenantId required" }, 400);
      return J(await this._mintKey(t, plan));
    }
    if (p === "/_admin/list") return J({ tenants: this._listKeys() });
    if (p === "/_admin/revoke") {
      const apiKey = url.searchParams.get("apiKey");
      const apiKeyHash = url.searchParams.get("apiKeyHash");
      const tenantId = url.searchParams.get("tenantId");
      return J(await this._revokeKey({ apiKey, apiKeyHash, tenantId }));
    }

    try {
      // WebSocket REPL: supervisor accepts + tags with tenant/session for routing.
      if (p === "/connect") {
        if (req.headers.get("Upgrade") !== "websocket")
          return new Response("expected websocket", { status: 426 });
        this._touch(tenant, sessionId);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], ["t:" + tenant, "s:" + sessionId]);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      // HTTP eval (one cell). Routes to the tenant/session facet.
      if (p === "/eval") {
        this._touch(tenant, sessionId);
        const src = url.searchParams.get("src") || "1+1";
        const facet = this.#facet(tenant, sessionId);
        const reply = await facet.evalCell(src);
        // METERING: one eval event + (if checkpointed) the snapshot bytes for this tenant.
        this._meter(tenant, "eval", 1, sessionId);
        // Keep-warm cost input: record the latest snapshot size for the warm decision.
        if (reply && reply.checkpoint && reply.checkpoint.ok && reply.checkpoint.sizeGz) {
          this._recordSize(tenant, sessionId, reply.checkpoint.sizeGz);
          this._meter(tenant, "bytes", reply.checkpoint.sizeGz, sessionId);
        }
        return J({ tenant, sessionId, ...reply });
      }

      // Stdlib + extensions introspection for a session (what loaded, what's available).
      if (p === "/stdlib") {
        this._touch(tenant, sessionId);
        const facet = this.#facet(tenant, sessionId);
        return J({ tenant, sessionId, ...(await facet.stdlib()) });
      }

      // Configure a session's kernel (clock/seed/fetch allowlist/budgets). The query param
      // ?latencySensitive=1 opts the session into the keep-warm pin (supervisor-side flag).
      if (p === "/configure" && req.method === "POST") {
        this._touch(tenant, sessionId);
        const ls = url.searchParams.get("latencySensitive");
        if (ls != null) this._setLatencySensitive(tenant, sessionId, ls === "1" || ls === "true");
        const body = await req.text();
        const facet = this.#facet(tenant, sessionId);
        return J({ tenant, sessionId, ...(await facet.configure(body || "{}")) });
      }

      // Keep-warm view for a session: cadence stats + whether the sweep would warm it now.
      if (p === "/warm") {
        const ls = url.searchParams.get("latencySensitive");
        if (ls != null) this._setLatencySensitive(tenant, sessionId, ls === "1" || ls === "true");
        const row = this.ctx.storage.sql
          .exec("SELECT * FROM sessions WHERE facet=?;", facetName(tenant, sessionId))
          .toArray()[0] || null;
        return J({ tenant, sessionId, willWarm: this._shouldWarm(row, Date.now()), session: row });
      }

      // Explicit checkpoint.
      if (p === "/checkpoint") {
        const facet = this.#facet(tenant, sessionId);
        return J({ tenant, sessionId, ...(await facet.checkpoint()) });
      }

      // Facet status.
      if (p === "/status") {
        const facet = this.#facet(tenant, sessionId);
        return J({ tenant, sessionId, facet: facetName(tenant, sessionId), ...(await facet.status()) });
      }

      // Hard-evict a facet (ctx.facets.abort). Snapshot survives -> next call cold-restores.
      if (p === "/evict") {
        this.ctx.facets.abort(facetName(tenant, sessionId), new Error("manual evict"));
        return J({ op: "evict", tenant, sessionId, aborted: true });
      }

      // Supervisor control-plane view (sessions it routes).
      if (p === "/sessions") {
        const rows = this.ctx.storage.sql.exec("SELECT * FROM sessions;").toArray();
        return J({ shard: "self", count: rows.length, max: MAX_FACETS_PER_SUPERVISOR, sessions: rows });
      }

      if (p === "/health") return J({ ok: true, codeId: KERNEL_CODE_ID, engineHash: ENGINE_HASH });

      return J({
        service: "montydyn-v12",
        arch: "SupervisorDO (per-tenant API-key auth + AE metering + routing + adaptive-keep-warm + WS-proxy + mediated-egress) + per-session KernelFacet ({wasm}, own SQLite, stdlib+Tier-0 extensions)",
        auth: "data-plane routes require x-api-key (or ?apiKey=) mapping to a tenant; else 401. Admin routes (/admin/keys ...) require x-admin-token.",
        routes: ["/connect (WS)", "/eval?session=&src=", "POST /configure[?latencySensitive=1]", "/stdlib", "/warm", "/checkpoint", "/status", "/evict", "/sessions", "/health", "GET /usage?tenant=&window=", "POST /admin/keys (mint)", "GET /admin/keys (list)", "DELETE /admin/keys (revoke)"],
      });
    } catch (e) {
      return J({ ok: false, error: String((e && e.stack) || e) }, 500);
    }
  }
}

// ---- V1.1 MEDIATED FETCH GATEWAY ----------------------------------------------------------
// The per-tenant egress gateway handed to each facet as globalOutbound (ctx.exports.HttpGateway).
// The facet itself can make NO direct Internet calls; every fetch()/connect() it issues arrives
// HERE. This is the supervisor-mediated egress seam: the facet's in-VM config.fetch allowlist is
// the fine-grained per-session control (typed FetchBlockedError before the request ever leaves
// the VM), and this gateway is the coarse, tenant-scoped backstop + the place to inject creds,
// meter, or hard-deny. By default it forwards (so the in-VM allowlist governs); set the env var
// MEDIATED_FETCH_ALLOW (comma-separated hostnames) to hard-restrict egress for ALL tenants, or
// MEDIATED_FETCH_DENY to blocklist. A blocked request returns a 403 the VM surfaces as a typed
// rejection (host.fetch's FetchError), keeping the socket alive.
export class HttpGateway extends WorkerEntrypoint {
  async fetch(request) {
    const tenant = (this.ctx && this.ctx.props && this.ctx.props.tenant) || "anon";
    let host = "";
    try { host = new URL(request.url).hostname.toLowerCase(); } catch (_) {}
    const parseList = (v) =>
      typeof v === "string" && v.length ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
    const allow = parseList(this.env && this.env.MEDIATED_FETCH_ALLOW);
    const deny = parseList(this.env && this.env.MEDIATED_FETCH_DENY);
    const block = (why) =>
      new Response(JSON.stringify({ error: "egress blocked by gateway", host, tenant, why }), {
        status: 403,
        headers: { "content-type": "application/json", "x-montydyn-egress": "blocked" },
      });
    if (!host) return block("unresolvable-host");
    if (deny && deny.includes(host)) return block("denylisted");
    if (allow && !allow.includes(host)) return block("not-in-gateway-allowlist");
    // Forward. (this.env's fetch is the real Internet egress; the facet never had it.)
    return fetch(request);
  }
}

// ---- V1.2 WORKER ENTRY: auth gateway + admin + usage, then shard to a SupervisorDO ----------
// The entry is the multi-tenant SaaS seam. It (1) gates every data-plane route on a valid API
// key resolved to a tenant via the AUTH shard's registry (else 401); (2) exposes admin routes
// to mint/list/revoke keys, gated by the ADMIN_TOKEN secret; (3) exposes GET /usage which
// queries Analytics Engine SQL for per-tenant aggregates. The resolved tenant is injected as
// the x-md-tenant header so the SupervisorDO routes/isolates by the key's tenant — a client
// can never pick another tenant's scope.
const AUTH_SHARD = "sup-auth"; // the canonical shard that owns the authoritative tenant registry
const AE_DATASET = "montydyn_kernel"; // the Analytics Engine dataset name (AE SQL FROM clause)

function j(o, code = 200) {
  return new Response(JSON.stringify(o, null, 2), { status: code, headers: { "content-type": "application/json" } });
}

function getApiKey(req, url) {
  return (
    req.headers.get("x-api-key") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("apiKey") ||
    ""
  );
}

function authStub(env) {
  return env.SUPERVISOR.get(env.SUPERVISOR.idFromName(AUTH_SHARD));
}

// Query Analytics Engine SQL for per-tenant aggregates over a time window (default 24h).
async function queryUsage(env, tenant, windowMinutes) {
  const acct = env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (!acct || !token) {
    return { error: "usage query unconfigured: CF_ACCOUNT_ID / CF_API_TOKEN secrets missing" };
  }
  const since = `INTERVAL '${windowMinutes | 0}' MINUTE`;
  // blob1=tenant, blob2=metric, blob3=session, double1=value. Aggregate per metric.
  // Filter blob2 to the v1.2 metric discriminators so stale v1.1 AE rows (which shared this
  // dataset with a different blob schema — op-name in blob1) are excluded from /usage.
  const metricFilter = `blob2 IN ('eval','bytes','warm','facet')`;
  const where = tenant ? `AND blob1 = '${String(tenant).replace(/'/g, "")}'` : "";
  const sql =
    `SELECT blob1 AS tenant, blob2 AS metric, ` +
    `SUM(_sample_interval * double1) AS total, ` +
    `count() AS points, ` +
    `MAX(double1) AS peak ` +
    `FROM ${AE_DATASET} ` +
    `WHERE timestamp > NOW() - ${since} AND ${metricFilter} ${where} ` +
    `GROUP BY tenant, metric`;
  const sessSql =
    `SELECT blob1 AS tenant, COUNT(DISTINCT blob3) AS active_sessions ` +
    `FROM ${AE_DATASET} ` +
    `WHERE timestamp > NOW() - ${since} AND blob2 = 'eval' ${where} ` +
    `GROUP BY tenant`;
  const run = async (q) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: q,
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`AE SQL ${r.status}: ${txt.slice(0, 300)}`);
    try { return JSON.parse(txt).data || []; } catch (_) { return []; }
  };
  const [metricRows, sessRows] = await Promise.all([run(sql), run(sessSql)]);
  // Fold metric rows into a per-tenant aggregate object.
  const byTenant = {};
  for (const row of metricRows) {
    const t = row.tenant;
    byTenant[t] = byTenant[t] || { tenant: t, evals: 0, bytes: 0, warmSeconds: 0, facetPeak: 0, activeSessions: 0 };
    const v = Number(row.total) || 0;
    if (row.metric === "eval") byTenant[t].evals = Math.round(v);
    else if (row.metric === "bytes") byTenant[t].bytes = Math.round(v);
    else if (row.metric === "warm") byTenant[t].warmSeconds = Math.round(v);
    else if (row.metric === "facet") byTenant[t].facetPeak = Math.round(Number(row.peak) || 0);
  }
  for (const row of sessRows) {
    const t = row.tenant;
    byTenant[t] = byTenant[t] || { tenant: t, evals: 0, bytes: 0, warmSeconds: 0, facetPeak: 0, activeSessions: 0 };
    byTenant[t].activeSessions = Number(row.active_sessions) || 0;
  }
  return { windowMinutes: windowMinutes | 0, tenants: Object.values(byTenant) };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- ADMIN routes (gated by the ADMIN_TOKEN secret) -------------------------------------
    if (p === "/admin/keys") {
      const adminTok = req.headers.get("x-admin-token") || url.searchParams.get("adminToken") || "";
      if (!env.ADMIN_TOKEN || !safeEqual(adminTok, env.ADMIN_TOKEN)) {
        return j({ error: "admin auth required (x-admin-token)" }, 401);
      }
      const stub = authStub(env);
      if (req.method === "POST") {
        const tenantId = url.searchParams.get("tenantId") || url.searchParams.get("tenant");
        const plan = url.searchParams.get("plan") || "free";
        if (!tenantId) return j({ error: "tenantId required" }, 400);
        const res = await stub.fetch(`https://do/_admin/mint?tenantId=${encodeURIComponent(tenantId)}&plan=${encodeURIComponent(plan)}`);
        return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
      }
      if (req.method === "GET") {
        const res = await stub.fetch("https://do/_admin/list");
        return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
      }
      if (req.method === "DELETE") {
        const qs = new URLSearchParams();
        for (const k of ["apiKey", "apiKeyHash", "tenantId"]) {
          const v = url.searchParams.get(k);
          if (v) qs.set(k, v);
        }
        const res = await stub.fetch(`https://do/_admin/revoke?${qs.toString()}`);
        return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
      }
      return j({ error: "method not allowed" }, 405);
    }

    // ---- USAGE (per-tenant AE aggregates). Admin token OR a tenant's own key for itself. ----
    if (p === "/usage") {
      const adminTok = req.headers.get("x-admin-token") || url.searchParams.get("adminToken") || "";
      const isAdmin = env.ADMIN_TOKEN && safeEqual(adminTok, env.ADMIN_TOKEN);
      let tenant = url.searchParams.get("tenant") || "";
      if (!isAdmin) {
        // A tenant may query its OWN usage with its API key (tenant forced to the key's scope).
        const key = getApiKey(req, url);
        const resolved = await authStub(env).fetch(`https://do/_auth/resolve?key=${encodeURIComponent(key)}`).then((r) => r.json());
        if (!resolved || !resolved.tenantId) return j({ error: "unauthorized" }, 401);
        tenant = resolved.tenantId; // ignore any client-supplied tenant
      }
      const windowMinutes = Number(url.searchParams.get("window") || url.searchParams.get("windowMinutes") || 1440) || 1440;
      try {
        return j(await queryUsage(env, tenant || null, windowMinutes));
      } catch (e) {
        return j({ error: String((e && e.message) || e) }, 502);
      }
    }

    // ---- Health/info pass-through (no auth) ------------------------------------------------
    if (p === "/health" || p === "/") {
      const sessionId = url.searchParams.get("session") || "default";
      const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(shardFor(sessionId, SHARD_COUNT)));
      return stub.fetch(req);
    }

    // ---- DATA-PLANE: require a valid API key -> tenant; inject x-md-tenant; shard + route. --
    const key = getApiKey(req, url);
    if (!key) return j({ error: "missing API key (x-api-key header or ?apiKey=)" }, 401);
    const resolved = await authStub(env)
      .fetch(`https://do/_auth/resolve?key=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .catch(() => null);
    if (!resolved || !resolved.tenantId) {
      return j({ error: "invalid or revoked API key" }, 401);
    }
    const tenant = resolved.tenantId;

    const sessionId = url.searchParams.get("session") || "default";
    const supId = shardFor(sessionId, SHARD_COUNT);
    const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(supId));
    // Inject the resolved tenant (client cannot spoof) + the cache hint for the local mirror.
    const headers = new Headers(req.headers);
    headers.set("x-md-tenant", tenant);
    headers.set("x-md-plan", resolved.plan || "free");
    headers.set("x-md-keyhash", resolved.hash || "");
    const fwd = new Request(req.url, { method: req.method, headers, body: req.body, redirect: "manual" });
    return stub.fetch(fwd);
  },
};
