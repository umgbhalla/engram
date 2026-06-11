// TRACK B — engram-cloud-rust SupervisorDO: per-session facets running the RUST kernel.
// PRODUCTION-COMPLETE: the proven Rust-facet prototype (per-tenant API-key auth, per-session
// Rust kernel facet with isolated SQLite, codeId-versioned loader, /frame RPC proxy, genuine
// cold-restore across ctx.facets.abort) with the four trimmed JS-supervisor features ported in:
//
//   (1) ADAPTIVE KEEP-WARM / IDLE-TTL — supervisor-side alarm + EWMA cadence (facets cannot set
//       alarms, so the SupervisorDO owns the alarm and heartbeats predicted-active facets via a
//       /frame {t:ping} before the idle TTL would abort them).
//   (2) AE METERING — per-tenant usage datapoints (tenant/metric/session blob schema, distinct
//       from the Rust DO's own per-op rows) + the Worker-entry GET /usage AE-SQL aggregate route.
//   (3) PER-TENANT MEDIATED EGRESS — host.fetch routes through a per-tenant HttpGateway
//       (ctx.exports.HttpGateway), replacing globalOutbound:null, so the Rust DO's DO-side
//       fetch() is fronted by a tenant-scoped, allow/deny-list gateway instead of fully blocked.
//   (4) 64-SHARD ROUTING + SESSIONS REGISTRY — Worker-entry FNV-1a shard + bounded facet count.
//
// Protocol difference vs the JS facet: the Rust DO exposes no evalCell/handleMessage RPC; its
// protocol is the WS/{t:...} frame dispatch. The supervisor RPCs each frame via stub.fetch
// (POST /frame — proxy model; facet-held client sockets don't work). One Rust DO handle() runs
// per /frame. So the keep-warm heartbeat is a {t:ping} /frame, NOT a facet.ping() RPC.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  FACET_MAIN_SRC,
  KERNEL_INDEX_JS,
  INDEX_BG_WASM_B64,
  ENGINE_WASM_B64,
  STDLIB_BUNDLE_TXT,
  STDLIB_META_SRC,
  KERNEL_CODE_ID,
  ENGINE_HASH,
} from "./modules.rust.gen.js";

// ---- Worker bindings / env -----------------------------------------------------------------
interface Env {
  SUPERVISOR: DurableObjectNamespace;
  LOADER: WorkerLoader;
  AE?: AnalyticsEngineDataset;
  MEDIATED_FETCH_ALLOW?: string;
  MEDIATED_FETCH_DENY?: string;
  CF_ACCOUNT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  ADMIN_TOKEN?: string;
}

// ---- Worker-Loader + facets surface (not in @cloudflare/workers-types) ----------------------
interface WorkerLoaderModuleSpec {
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  modules: Record<string, string | { wasm: ArrayBuffer } | { text: string } | { data: ArrayBuffer }>;
  globalOutbound: Fetcher | null;
}
interface LoadedWorker {
  getDurableObjectClass(name: string): DurableObjectClass;
}
interface WorkerLoader {
  get(codeId: string, factory: () => Promise<WorkerLoaderModuleSpec>): LoadedWorker;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DurableObjectClass = any;
interface FacetStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
interface FacetManager {
  get(name: string, factory: () => Promise<{ class: DurableObjectClass }>): FacetStub;
  abort(name: string, reason: Error): void;
}
// The runtime DurableObjectState carries `facets` + `exports` (ctx.exports via enable_ctx_exports)
// surfaces not yet in @cloudflare/workers-types — narrow via intersection rather than `extends`
// (the lib's own DurableObjectFacets shape conflicts).
type SupervisorState = DurableObjectState & {
  facets: FacetManager;
  exports?: { HttpGateway?: (opts: { props: { tenant: string } }) => Fetcher };
};

// ---- session-registry row shape -------------------------------------------------------------
// SQL row types carry an index signature so they satisfy the SqlStorage `exec<T>` constraint
// (Record<string, SqlStorageValue>); extra columns (e.g. api_key_hash on tenants) are tolerated.
interface SessionRow {
  facet: string;
  tenant: string;
  session_id: string;
  created_at: number;
  last_activity: number;
  eval_count: number;
  inter_arrival_ewma_ms: number;
  last_inter_arrival_ms: number;
  warm_until: number;
  latency_sensitive: number;
  last_size_gz: number;
  [k: string]: SqlStorageValue;
}
interface TenantRow {
  tenant_id: string;
  plan: string;
  revoked: number;
  [k: string]: SqlStorageValue;
}
interface ResolvedTenant {
  tenantId: string;
  plan: string;
  hash: string;
}
// Generic kernel /frame reply (the Rust DO returns arbitrary JSON; checkpoint is the one field
// the supervisor reads for keep-warm sizing/metering).
interface FrameReply {
  checkpoint?: { ok?: boolean; sizeGz?: number };
  [k: string]: unknown;
}

const SHARD_COUNT = 64;
const MAX_FACETS_PER_SUPERVISOR = 128;

// Idle TTL: a facet untouched this long is hard-evicted (ctx.facets.abort). Its SQLite snapshot
// survives -> next /frame cold-restores. Supervisor-alarm-driven (facets can't alarm).
const FACET_IDLE_TTL_MS = 5 * 60 * 1000;
// Adaptive keep-warm sweep cadence (shorter than idle TTL so heartbeats land first).
const WARM_SWEEP_INTERVAL_MS = 30 * 1000;
const WARM_EWMA_ALPHA = 0.4; // EWMA smoothing for inter-arrival cadence
const WARM_MIN_EVALS = 2; // one-shot sessions aren't worth warming
const WARM_MAX_EWMA_MS = 90 * 1000; // naturally-slow cadence tolerates the cold-wake
const WARM_RECENCY_K = 2.5; // beyond K x cadence the user likely walked away
const WARM_HORIZON_MS = 4 * 60 * 1000; // a heartbeat delays eviction to this horizon
const WARM_MAX_SIZE_GZ_NONSENSITIVE = 512 * 1024; // big non-sensitive images may hibernate

async function sha256Hex(s: unknown): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function mintRawKey(): string {
  const u8 = new Uint8Array(32);
  crypto.getRandomValues(u8);
  return "md_" + [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}
function shardFor(sessionId: unknown, n: number): string {
  let h = 0x811c9dc5;
  const s = String(sessionId);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return "sup-" + (h % n);
}
function facetName(tenant: unknown, sessionId: unknown): string {
  return "kr:" + String(tenant) + ":" + String(sessionId);
}

export class SupervisorDO extends DurableObject<Env> {
  private readonly sctx: SupervisorState;
  // The loader closure reads this to scope the gateway props (single-threaded DO, no race).
  private _egressTenant?: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sctx = ctx as unknown as SupervisorState;
    // sessions registry: routing + access-cadence stats for the adaptive keep-warm sweep.
    this.sctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         facet TEXT PRIMARY KEY, tenant TEXT, session_id TEXT,
         created_at INTEGER, last_activity INTEGER, eval_count INTEGER DEFAULT 0,
         inter_arrival_ewma_ms INTEGER DEFAULT 0, last_inter_arrival_ms INTEGER DEFAULT 0,
         warm_until INTEGER DEFAULT 0, latency_sensitive INTEGER DEFAULT 0,
         last_size_gz INTEGER DEFAULT 0);`,
    );
    // Forward-compat: add keep-warm columns if an older table predates this build (idempotent).
    for (const col of [
      "eval_count INTEGER DEFAULT 0",
      "inter_arrival_ewma_ms INTEGER DEFAULT 0",
      "last_inter_arrival_ms INTEGER DEFAULT 0",
      "warm_until INTEGER DEFAULT 0",
      "latency_sensitive INTEGER DEFAULT 0",
      "last_size_gz INTEGER DEFAULT 0",
    ]) {
      try { this.sctx.storage.sql.exec(`ALTER TABLE sessions ADD COLUMN ${col};`); } catch (_) {}
    }
    // Tenant registry (control-plane SQLite; a facet provably cannot read it). PRESERVED schema
    // from the prototype so existing minted keys survive.
    this.sctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS tenants (
         api_key_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
         created_at INTEGER, plan TEXT DEFAULT 'free', revoked INTEGER DEFAULT 0);`,
    );
  }

  // ---- auth (control-plane registry; a facet provably cannot read this SQLite) ----
  async _mintKey(tenantId: string, plan: string): Promise<{ tenantId: string; plan: string; apiKey: string; apiKeyHash: string }> {
    const raw = mintRawKey();
    const hash = await sha256Hex(raw);
    this.sctx.storage.sql.exec(
      "INSERT INTO tenants(api_key_hash,tenant_id,created_at,plan,revoked) VALUES(?,?,?,?,0);",
      hash, String(tenantId), Date.now(), String(plan || "free"),
    );
    return { tenantId: String(tenantId), plan: String(plan || "free"), apiKey: raw, apiKeyHash: hash };
  }
  _listKeys(): TenantRow[] {
    return this.sctx.storage.sql
      .exec<TenantRow>("SELECT api_key_hash, tenant_id, created_at, plan, revoked FROM tenants ORDER BY created_at;")
      .toArray();
  }
  async _resolveLocal(rawKey: string): Promise<ResolvedTenant | null> {
    if (!rawKey) return null;
    const hash = await sha256Hex(rawKey);
    const row = this.sctx.storage.sql
      .exec<TenantRow>("SELECT tenant_id, plan, revoked FROM tenants WHERE api_key_hash=?;", hash).toArray()[0];
    if (!row || row.revoked) return null;
    return { tenantId: row.tenant_id, plan: row.plan, hash };
  }
  async authResolve(rawKey: string): Promise<ResolvedTenant | null> { return await this._resolveLocal(rawKey); }
  async _revokeKey({ apiKey, apiKeyHash, tenantId }: { apiKey?: string | null; apiKeyHash?: string | null; tenantId?: string | null }): Promise<Record<string, unknown>> {
    if (apiKey) apiKeyHash = await sha256Hex(apiKey);
    if (apiKeyHash) {
      const r = this.sctx.storage.sql.exec("UPDATE tenants SET revoked=1 WHERE api_key_hash=?;", apiKeyHash);
      return { revoked: apiKeyHash, rows: r.rowsWritten | 0 };
    }
    if (tenantId) {
      const r = this.sctx.storage.sql.exec(
        "UPDATE tenants SET revoked=1 WHERE tenant_id=? AND revoked=0;", String(tenantId));
      return { tenantId: String(tenantId), revoked: r.rowsWritten | 0 };
    }
    return { revoked: null };
  }

  // ---- (2) AE METERING. metric in {eval, bytes, warm, facet}; blob1=tenant (GROUP BY dim),
  // blob2=metric, blob3=session. double1=value. Distinct blob schema from the Rust DO's own
  // per-op rows (which carry op-name in blob1) so /usage's blob2 filter excludes them cleanly.
  _meter(tenant: string, metric: string, value: number, sessionId?: string): void {
    try {
      if (!this.env || !this.env.AE || typeof this.env.AE.writeDataPoint !== "function") return;
      this.env.AE.writeDataPoint({
        indexes: [String(tenant)],
        blobs: [String(tenant), String(metric), String(sessionId || "")],
        doubles: [Number(value) || 0, 1],
      });
    } catch (_) {}
  }

  // ---- Worker Loader: the RUST kernel facet class. BOTH wasm via {wasm}. ----
  // (3) PER-TENANT MEDIATED EGRESS: globalOutbound is a per-tenant HttpGateway (was null).
  #loadKernel(): LoadedWorker {
    return this.env.LOADER.get(KERNEL_CODE_ID, async (): Promise<WorkerLoaderModuleSpec> => {
      const modules: WorkerLoaderModuleSpec["modules"] = {
        "facet-rust.js": FACET_MAIN_SRC,
        "index.js": KERNEL_INDEX_JS,
        "index_bg.wasm": { wasm: b64ToArrayBuffer(INDEX_BG_WASM_B64) },
        "engine.wasm": { wasm: b64ToArrayBuffer(ENGINE_WASM_B64) },
        "stdlib.bundle.txt": { text: STDLIB_BUNDLE_TXT },
        "stdlib-meta.js": STDLIB_META_SRC,
      };
      return {
        compatibilityDate: "2026-04-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "facet-rust.js",
        modules,
        // Route the facet/Rust-DO outbound fetch through the per-tenant gateway instead of
        // null-blocking all egress. The gateway enforces a coarse host allow/deny-list and
        // scopes/meters egress per tenant. Falls back to null (fully blocked) on older runtimes.
        globalOutbound: this.#egress(this._egressTenant || "anon"),
      };
    });
  }

  // Per-tenant egress gateway WorkerEntrypoint instance handed to the facet as globalOutbound.
  // REQUIRES the `enable_ctx_exports` compat flag (see wrangler.jsonc) — without it ctx.exports is
  // undefined and this falls back to null (fully-blocked egress), the root cause of the prior
  // mediated-egress FAIL. We surface a console.warn on the fallback so a misconfig is loud, not
  // silently degraded to "internet blocked".
  #egress(tenant: string): Fetcher | null {
    try {
      const exports = this.sctx && this.sctx.exports;
      if (!exports || typeof exports.HttpGateway !== "function") {
        console.warn(
          "[engram-cloud] ctx.exports.HttpGateway unavailable — mediated egress DISABLED " +
            "(facet outbound fully blocked). Ensure compat flag `enable_ctx_exports` is set and " +
            "HttpGateway is a top-level export of supervisor.ts.",
        );
        return null;
      }
      return exports.HttpGateway({ props: { tenant: String(tenant) } });
    } catch (e) {
      console.warn("[engram-cloud] #egress() failed; egress blocked:", String((e && (e as Error).message) || e));
      return null; // safe default: fully-blocked egress
    }
  }

  #facet(tenant: string, sessionId: string): FacetStub {
    const name = facetName(tenant, sessionId);
    // The loader closure reads this._egressTenant to scope the gateway props. Set it just before
    // #loadKernel runs inside the facet factory (single-threaded DO, no race).
    this._egressTenant = String(tenant);
    return this.sctx.facets.get(name, async () => {
      const worker = this.#loadKernel();
      return { class: worker.getDurableObjectClass("KernelDO") };
    });
  }

  // (1) keep-warm: record/refresh a session, enforce the bound, update EWMA cadence, arm alarm.
  _touch(tenant: string, sessionId: string): void {
    const name = facetName(tenant, sessionId);
    const now = Date.now();
    const row = this.sctx.storage.sql.exec<SessionRow>("SELECT * FROM sessions WHERE facet=?;", name).toArray()[0];
    if (!row) {
      const count = this.sctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM sessions;").toArray()[0].c | 0;
      if (count >= MAX_FACETS_PER_SUPERVISOR)
        throw new Error(`supervisor facet cap reached (${count}/${MAX_FACETS_PER_SUPERVISOR}); session rejected (shard is full)`);
      this.sctx.storage.sql.exec(
        "INSERT INTO sessions(facet,tenant,session_id,created_at,last_activity,eval_count) VALUES(?,?,?,?,?,1);",
        name, String(tenant), String(sessionId), now, now,
      );
    } else {
      // Inter-arrival gap since last real activity. NEVER `| 0` ms timestamps (>2^31 truncates).
      const prev = Number(row.last_activity) || 0;
      let ewma = Number(row.inter_arrival_ewma_ms) || 0;
      let gap = Number(row.last_inter_arrival_ms) || 0;
      if (prev > 0) {
        gap = Math.max(0, now - prev);
        ewma = ewma > 0 ? Math.round(WARM_EWMA_ALPHA * gap + (1 - WARM_EWMA_ALPHA) * ewma) : gap;
      }
      this.sctx.storage.sql.exec(
        "UPDATE sessions SET last_activity=?, eval_count=eval_count+1, inter_arrival_ewma_ms=?, last_inter_arrival_ms=? WHERE facet=?;",
        now, ewma, gap, name,
      );
    }
    this._armAlarm();
  }

  _setLatencySensitive(tenant: string, sessionId: string, on: boolean): void {
    this.sctx.storage.sql.exec(
      "UPDATE sessions SET latency_sensitive=? WHERE facet=?;", on ? 1 : 0, facetName(tenant, sessionId));
  }
  _recordSize(tenant: string, sessionId: string, sizeGz: number): void {
    if (!(sizeGz > 0)) return;
    this.sctx.storage.sql.exec(
      "UPDATE sessions SET last_size_gz=? WHERE facet=?;", sizeGz | 0, facetName(tenant, sessionId));
  }
  async _armAlarm(): Promise<void> {
    const cur = await this.sctx.storage.getAlarm();
    if (cur == null) await this.sctx.storage.setAlarm(Date.now() + WARM_SWEEP_INTERVAL_MS);
  }

  // Should this session be KEPT WARM (predicted-active) vs allowed to hibernate? Returns true
  // ONLY for genuinely interactive sessions that would otherwise eat the deep cold-wake.
  _shouldWarm(row: SessionRow | null, now: number): boolean {
    if (!row || (Number(row.last_activity) || 0) <= 0) return false; // evicted/never-active
    if (row.latency_sensitive) return true; // explicit opt-in always wins
    const evals = row.eval_count | 0;
    const ewma = Number(row.inter_arrival_ewma_ms) || 0;
    const recency = now - (Number(row.last_activity) || 0);
    if (evals < WARM_MIN_EVALS) return false; // one-shot: not worth warming
    if (ewma <= 0) return false; // no usable cadence yet: conservative
    if (ewma >= WARM_MAX_EWMA_MS) return false; // naturally slow: tolerate cold-wake
    if (recency > WARM_RECENCY_K * ewma) return false; // walked away: hibernate
    if ((row.last_size_gz | 0) > WARM_MAX_SIZE_GZ_NONSENSITIVE) return false; // big image: hibernate
    return true;
  }

  // (1) ALARM: adaptive keep-warm + idle-TTL sweep. Heartbeats predicted-active facets via a
  // /frame {t:ping} (keeps the Rust DO isolate resident, pushes warm_until forward); hard-evicts
  // idle non-active facets via ctx.facets.abort (SQLite snapshot survives -> next /frame cold-
  // restores). Facets can't alarm — this is supervisor duty.
  override async alarm(): Promise<void> {
    const now = Date.now();
    const rows = this.sctx.storage.sql.exec<SessionRow>("SELECT * FROM sessions WHERE last_activity > 0;").toArray();
    for (const row of rows) {
      const idle = now - (Number(row.last_activity) || 0);
      const insideHorizon = (Number(row.warm_until) || 0) > now;
      if (this._shouldWarm(row, now)) {
        try {
          // Heartbeat via the /frame ping seam (proxy model — no facet RPC method on the Rust DO).
          await this._frame(row.tenant, row.session_id, { t: "ping" });
        } catch (_) {}
        this.sctx.storage.sql.exec(
          "UPDATE sessions SET warm_until=? WHERE facet=?;", now + WARM_HORIZON_MS, row.facet);
        this._meter(row.tenant, "warm", WARM_SWEEP_INTERVAL_MS / 1000, row.session_id);
        continue;
      }
      if (idle >= FACET_IDLE_TTL_MS && !insideHorizon) {
        try { this.sctx.facets.abort(row.facet, new Error("idle TTL eviction (supervisor alarm)")); } catch (_) {}
        this.sctx.storage.sql.exec(
          "UPDATE sessions SET last_activity=0, warm_until=0 WHERE facet=?;", row.facet);
      }
    }
    // Per-tenant live facet-count snapshot (for /usage facetPeak).
    try {
      const perTenant = this.sctx.storage.sql
        .exec<{ tenant: string; c: number }>("SELECT tenant, COUNT(*) AS c FROM sessions WHERE last_activity > 0 GROUP BY tenant;").toArray();
      for (const t of perTenant) this._meter(t.tenant, "facet", t.c | 0);
    } catch (_) {}
    const active = this.sctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE last_activity > 0;").toArray()[0].c | 0;
    if (active > 0) await this.sctx.storage.setAlarm(now + WARM_SWEEP_INTERVAL_MS);
  }

  // RPC one Rust-kernel protocol frame into the facet via its POST /frame seam.
  async _frame(tenant: string, sessionId: string, msg: Record<string, unknown>): Promise<FrameReply> {
    const facet = this.#facet(tenant, sessionId);
    const res = await facet.fetch("https://facet/frame", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
    });
    return (await res.json()) as FrameReply;
  }

  // Eval one cell + meter the result + record snapshot size (keep-warm cost input).
  async _evalMetered(tenant: string, sessionId: string, src: string, cell: number): Promise<FrameReply> {
    const reply = await this._frame(tenant, sessionId, { t: "eval", src, cell });
    this._meter(tenant, "eval", 1, sessionId);
    const ckpt = reply && reply.checkpoint;
    if (ckpt && ckpt.ok && ckpt.sizeGz) {
      this._recordSize(tenant, sessionId, ckpt.sizeGz);
      this._meter(tenant, "bytes", ckpt.sizeGz, sessionId);
    }
    return reply;
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const J = (o: unknown, code = 200): Response =>
      new Response(JSON.stringify(o, null, 2), { status: code, headers: { "content-type": "application/json" } });
    const tenant = req.headers.get("x-md-tenant") || url.searchParams.get("tenant") || "anon";
    const sessionId = url.searchParams.get("session") || "default";

    // ---- control-plane RPC routes (entry -> AUTH shard), not client-facing ----
    if (p === "/_auth/resolve") {
      const key = url.searchParams.get("key") || req.headers.get("x-api-key") || "";
      return J(await this._resolveLocal(key));
    }
    if (p === "/_admin/mint") {
      const t = url.searchParams.get("tenantId") || url.searchParams.get("tenant");
      if (!t) return J({ error: "tenantId required" }, 400);
      return J(await this._mintKey(t, url.searchParams.get("plan") || "free"));
    }
    if (p === "/_admin/list") return J({ tenants: this._listKeys() });
    if (p === "/_admin/revoke") {
      return J(await this._revokeKey({
        apiKey: url.searchParams.get("apiKey"),
        apiKeyHash: url.searchParams.get("apiKeyHash"),
        tenantId: url.searchParams.get("tenantId"),
      }));
    }

    try {
      // create a session kernel (config: clock/rngSeed/cellBudgetTicks/etc).
      if (p === "/create") {
        this._touch(tenant, sessionId);
        let config: unknown = {};
        try { config = JSON.parse((await req.text()) || "{}"); } catch (_) {}
        return J({ tenant, sessionId, ...(await this._frame(tenant, sessionId, { t: "create", config })) });
      }
      // eval one cell (metered).
      if (p === "/eval") {
        this._touch(tenant, sessionId);
        const src = url.searchParams.get("src") || "1+1";
        return J({ tenant, sessionId, ...(await this._evalMetered(tenant, sessionId, src, Date.now() & 0xffff)) });
      }
      if (p === "/frame") {
        this._touch(tenant, sessionId);
        let frame: Record<string, unknown> = {};
        try { frame = JSON.parse((await req.text()) || "{}"); } catch (_) {}
        return J({ tenant, sessionId, ...(await this._frame(tenant, sessionId, frame)) });
      }
      if (p === "/gen") return J(await this._frame(tenant, sessionId, { t: "gen" }));
      if (p === "/ping") return J(await this._frame(tenant, sessionId, { t: "ping" }));
      if (p === "/reset") return J(await this._frame(tenant, sessionId, { t: "reset" }));

      // (1) keep-warm view for a session: cadence stats + whether the sweep would warm it now.
      if (p === "/warm") {
        const ls = url.searchParams.get("latencySensitive");
        if (ls != null) this._setLatencySensitive(tenant, sessionId, ls === "1" || ls === "true");
        const row = this.sctx.storage.sql
          .exec<SessionRow>("SELECT * FROM sessions WHERE facet=?;", facetName(tenant, sessionId)).toArray()[0] || null;
        return J({ tenant, sessionId, willWarm: this._shouldWarm(row, Date.now()), session: row });
      }

      // hard-evict the facet (ctx.facets.abort). SQLite snapshot survives -> next eval cold-restores.
      if (p === "/evict") {
        this.sctx.facets.abort(facetName(tenant, sessionId), new Error("manual evict"));
        this.sctx.storage.sql.exec(
          "UPDATE sessions SET last_activity=0, warm_until=0 WHERE facet=?;", facetName(tenant, sessionId));
        return J({ op: "evict", tenant, sessionId, aborted: true });
      }
      if (p === "/sessions") {
        const rows = this.sctx.storage.sql.exec<SessionRow>("SELECT * FROM sessions;").toArray();
        return J({ count: rows.length, max: MAX_FACETS_PER_SUPERVISOR, sessions: rows });
      }
      if (p === "/health") return J({ ok: true, codeId: KERNEL_CODE_ID, engineHash: ENGINE_HASH, kernel: "rust" });
      return J({
        service: "engram-cloud-rust",
        arch: "SupervisorDO (per-tenant API-key auth + AE metering + 64-shard routing + adaptive-keep-warm + mediated per-tenant egress) + per-session RUST KernelFacet (Rust DO + engine.wasm via {wasm}, own SQLite, POST /frame RPC proxy)",
        auth: "data-plane routes require x-api-key (or ?apiKey=) mapping to a tenant; else 401. Admin routes require x-admin-token.",
        routes: ["POST /create", "/eval?src=", "/gen", "/ping", "/reset", "/warm[?latencySensitive=1]", "/evict", "/sessions", "/health", "GET /usage?tenant=&window=", "POST /admin/keys (mint)", "GET /admin/keys (list)", "DELETE /admin/keys (revoke)"],
      });
    } catch (e) {
      return J({ ok: false, error: String((e && (e as Error).stack) || e) }, 500);
    }
  }
}

// ---- (3) MEDIATED FETCH GATEWAY -----------------------------------------------------------
// The per-tenant egress gateway handed to each facet as globalOutbound. The Rust DO's DO-side
// fetch() (host.fetch egress) arrives HERE instead of going straight to the Internet. The in-VM
// config.fetch allowlist is the fine-grained per-session control (typed FetchBlockedError before
// the request leaves the VM); this gateway is the coarse, tenant-scoped backstop + the place to
// meter or hard-deny. Defaults to forward (in-VM allowlist governs); env MEDIATED_FETCH_ALLOW
// (comma-separated hostnames) hard-restricts egress for ALL tenants, MEDIATED_FETCH_DENY blocklists.
export class HttpGateway extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx as unknown as { props?: { tenant?: string } }).props;
    const tenant = (props && props.tenant) || "anon";
    let host = "";
    try { host = new URL(request.url).hostname.toLowerCase(); } catch (_) {}
    const parseList = (v: unknown): string[] | null =>
      typeof v === "string" && v.length ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
    const allow = parseList(this.env && this.env.MEDIATED_FETCH_ALLOW);
    const deny = parseList(this.env && this.env.MEDIATED_FETCH_DENY);
    const block = (why: string): Response =>
      new Response(JSON.stringify({ error: "egress blocked by gateway", host, tenant, why }), {
        status: 403, headers: { "content-type": "application/json", "x-engram-egress": "blocked" },
      });
    if (!host) return block("unresolvable-host");
    if (deny && deny.includes(host)) return block("denylisted");
    if (allow && !allow.includes(host)) return block("not-in-gateway-allowlist");
    return fetch(request); // real Internet egress (the facet never had it directly)
  }
}

// ---- Worker entry: auth gate -> (4) 64-shard -> SupervisorDO; + admin + /usage ----
const AUTH_SHARD = "sup-auth";
const AE_DATASET = "engram_kernel";
function j(o: unknown, code = 200): Response {
  return new Response(JSON.stringify(o, null, 2), { status: code, headers: { "content-type": "application/json" } });
}
function getApiKey(req: Request, url: URL): string {
  return req.headers.get("x-api-key") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("apiKey") || "";
}
function authStub(env: Env): DurableObjectStub { return env.SUPERVISOR.get(env.SUPERVISOR.idFromName(AUTH_SHARD)); }

interface UsageTenant {
  tenant: string;
  evals: number;
  bytes: number;
  warmSeconds: number;
  facetPeak: number;
  activeSessions: number;
}

// (2) GET /usage: per-tenant AE-SQL aggregates over a time window (default 24h). blob1=tenant,
// blob2=metric, blob3=session, double1=value. The blob2 filter excludes the Rust DO's own per-op
// rows (those carry op-name in blob1, not a metric discriminator in blob2).
async function queryUsage(env: Env, tenant: string | null, windowMinutes: number): Promise<unknown> {
  const acct = env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (!acct || !token) return { error: "usage query unconfigured: CF_ACCOUNT_ID / CF_API_TOKEN secrets missing" };
  const since = `INTERVAL '${windowMinutes | 0}' MINUTE`;
  const metricFilter = `blob2 IN ('eval','bytes','warm','facet')`;
  const where = tenant ? `AND blob1 = '${String(tenant).replace(/'/g, "")}'` : "";
  const sql =
    `SELECT blob1 AS tenant, blob2 AS metric, SUM(_sample_interval * double1) AS total, ` +
    `count() AS points, MAX(double1) AS peak FROM ${AE_DATASET} ` +
    `WHERE timestamp > NOW() - ${since} AND ${metricFilter} ${where} GROUP BY tenant, metric`;
  const sessSql =
    `SELECT blob1 AS tenant, COUNT(DISTINCT blob3) AS active_sessions FROM ${AE_DATASET} ` +
    `WHERE timestamp > NOW() - ${since} AND blob2 = 'eval' ${where} GROUP BY tenant`;
  const run = async (q: string): Promise<Array<Record<string, unknown>>> => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/analytics_engine/sql`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: q,
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`AE SQL ${r.status}: ${txt.slice(0, 300)}`);
    try { return (JSON.parse(txt).data as Array<Record<string, unknown>>) || []; } catch (_) { return []; }
  };
  const [metricRows, sessRows] = await Promise.all([run(sql), run(sessSql)]);
  const byTenant: Record<string, UsageTenant> = {};
  for (const row of metricRows) {
    const t = String(row.tenant);
    byTenant[t] = byTenant[t] || { tenant: t, evals: 0, bytes: 0, warmSeconds: 0, facetPeak: 0, activeSessions: 0 };
    const v = Number(row.total) || 0;
    if (row.metric === "eval") byTenant[t].evals = Math.round(v);
    else if (row.metric === "bytes") byTenant[t].bytes = Math.round(v);
    else if (row.metric === "warm") byTenant[t].warmSeconds = Math.round(v);
    else if (row.metric === "facet") byTenant[t].facetPeak = Math.round(Number(row.peak) || 0);
  }
  for (const row of sessRows) {
    const t = String(row.tenant);
    byTenant[t] = byTenant[t] || { tenant: t, evals: 0, bytes: 0, warmSeconds: 0, facetPeak: 0, activeSessions: 0 };
    byTenant[t].activeSessions = Number(row.active_sessions) || 0;
  }
  return { windowMinutes: windowMinutes | 0, tenants: Object.values(byTenant) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- ADMIN routes (gated by ADMIN_TOKEN secret) ----
    if (p === "/admin/keys") {
      const adminTok = req.headers.get("x-admin-token") || url.searchParams.get("adminToken") || "";
      if (!env.ADMIN_TOKEN || !safeEqual(adminTok, env.ADMIN_TOKEN)) return j({ error: "admin auth required (x-admin-token)" }, 401);
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

    // ---- (2) GET /usage: admin token OR a tenant's own key for itself ----
    if (p === "/usage") {
      const adminTok = req.headers.get("x-admin-token") || url.searchParams.get("adminToken") || "";
      const isAdmin = env.ADMIN_TOKEN && safeEqual(adminTok, env.ADMIN_TOKEN);
      let tenant = url.searchParams.get("tenant") || "";
      if (!isAdmin) {
        const key = getApiKey(req, url);
        const resolved = await authStub(env).fetch(`https://do/_auth/resolve?key=${encodeURIComponent(key)}`).then((r) => r.json() as Promise<ResolvedTenant | null>).catch(() => null);
        if (!resolved || !resolved.tenantId) return j({ error: "unauthorized" }, 401);
        tenant = resolved.tenantId; // ignore any client-supplied tenant
      }
      const windowMinutes = Number(url.searchParams.get("window") || url.searchParams.get("windowMinutes") || 1440) || 1440;
      try { return j(await queryUsage(env, tenant || null, windowMinutes)); }
      catch (e) { return j({ error: String((e && (e as Error).message) || e) }, 502); }
    }

    // ---- Health/info pass-through (no auth) ----
    if (p === "/health" || p === "/") {
      const sessionId = url.searchParams.get("session") || "default";
      return env.SUPERVISOR.get(env.SUPERVISOR.idFromName(shardFor(sessionId, SHARD_COUNT))).fetch(req);
    }

    // ---- DATA-PLANE: require valid API key -> tenant; inject x-md-tenant; (4) shard + route ----
    const key = getApiKey(req, url);
    if (!key) return j({ error: "missing API key (x-api-key header or ?apiKey=)" }, 401);
    const resolved = await authStub(env)
      .fetch(`https://do/_auth/resolve?key=${encodeURIComponent(key)}`).then((r) => r.json() as Promise<ResolvedTenant | null>).catch(() => null);
    if (!resolved || !resolved.tenantId) return j({ error: "invalid or revoked API key" }, 401);

    const sessionId = url.searchParams.get("session") || "default";
    const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(shardFor(sessionId, SHARD_COUNT)));
    const headers = new Headers(req.headers);
    headers.set("x-md-tenant", resolved.tenantId);
    headers.set("x-md-plan", resolved.plan || "free");
    return stub.fetch(new Request(req.url, { method: req.method, headers, body: req.body, redirect: "manual" }));
  },
};
