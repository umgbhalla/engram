// montydyn V1.0 — Kernel FACET (dynamically loaded DurableObject class).
//
// The facet IS the kernel. It runs the ported v0.8 GlueKernel (real quickjs-wasi
// engine, seeded determinism, loop-budget + mid-cell memory tripwire + 18MB dump
// ceiling + size-admission guards) and snapshots its heap into the FACET's OWN
// isolated SQLite (ctx.storage.sql). Cold-restore is driven from that SQLite across
// a facet eviction (ctx.facets.abort by the supervisor) — no replay.
//
// Connection model (per the WS-hibernation spike): the SUPERVISOR holds the client
// WebSocket and proxies each frame into this facet via RPC (handleMessage / evalCell).
// Facets cannot set alarms, so TTL/idle/eviction live on the supervisor.
//
// WASM delivery: quickjs.wasm arrives as a {wasm} Worker-Loader module — a
// pre-compiled WebAssembly.Module (CompiledWasm). Raw-bytes WebAssembly.compile is
// blocked inside a facet, so {wasm} is the only path. We hand the Module to the
// ported glue via globalThis.__QJS_MODULE (the exact contract glue.js expects).
import { DurableObject } from "cloudflare:workers";
import quickjsModule from "./quickjs.wasm"; // {wasm} => WebAssembly.Module (CompiledWasm)
// V1.1 SLICE A — configurable in-VM stdlib. The esbuilt bundle (JSON string) arrives as a
// {text} loader module; the meta {js} module sets globalThis.__STDLIB_META itself when
// imported. glue.js reads __STDLIB_BUNDLE/__STDLIB_META lazily, so setting them at module
// top (before any kernel op) is sufficient. Injected ONLY on the fresh-create branch.
import STDLIB_BUNDLE_TXT from "./stdlib.bundle.txt"; // {text} => string (JSON {name:iife})
import "./stdlib-meta.js"; // {js} => sets globalThis.__STDLIB_META
// V1.1 SLICE B — Tier-0 native extensions. Each .so (renamed .wasm, bytes unchanged) arrives
// as a {wasm} loader module (a precompiled WebAssembly.Module — the ONLY in-facet wasm path;
// raw-bytes WebAssembly.compile is blocked). glue.js's buildExtensionDescriptors() reads
// globalThis.__QJS_EXT_MODULES and supplies the SAME descriptors in the SAME order to both
// QuickJS.create and QuickJS.restore (re-instantiated at fixed bases before the heap blit).
import EXT_CRYPTO from "./ext/crypto.wasm"; // WebAssembly.Module ({wasm})
import EXT_ENCODING from "./ext/encoding.wasm";
import EXT_URL from "./ext/url.wasm";
import EXT_STRUCTURED_CLONE from "./ext/structured-clone.wasm";
import EXT_HEADERS from "./ext/headers.wasm";
import { GlueKernel, getEngineHash } from "./glue.js";

// The engine hash guards restore against an engine-version mismatch (glue.js reads
// globalThis.__ENGINE_HASH). We derive it from the codeId baked into the source by
// the supervisor (the codeId already content-hashes glue + wasm + dist), so any
// engine change yields a different hash and a clean EngineHashMismatchError instead
// of a corrupt restore.
const ENGINE_HASH = "__ENGINE_HASH__";

// Hand the precompiled Module + engine hash to the ported glue BEFORE any kernel op.
globalThis.__QJS_MODULE = quickjsModule;
globalThis.__ENGINE_HASH = ENGINE_HASH;
// V1.1 SLICE A: the stdlib bundle string (the meta global is set by the imported
// stdlib-meta.js module). glue.js parses __STDLIB_BUNDLE lazily on first stdlibBundle().
globalThis.__STDLIB_BUNDLE = STDLIB_BUNDLE_TXT;
// V1.1 SLICE B: the extension Module registry, keyed by extension name. glue.js owns the
// canonical EXTENSION_ORDER; this map is just name -> precompiled WebAssembly.Module.
globalThis.__QJS_EXT_MODULES = {
  crypto: EXT_CRYPTO,
  encoding: EXT_ENCODING,
  url: EXT_URL,
  "structured-clone": EXT_STRUCTURED_CLONE,
  headers: EXT_HEADERS,
};

async function gzip(u8) {
  const cs = new CompressionStream("gzip");
  return new Uint8Array(await new Response(new Response(u8).body.pipeThrough(cs)).arrayBuffer());
}

export class KernelFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.glue = new GlueKernel();
    // The facet's OWN isolated SQLite. A different facet (different tenant/session)
    // cannot read this — proven by the facet-isolation spike. snap holds the single
    // latest committed heap image + the manifest fields needed for cold-restore.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS snap (
         id INTEGER PRIMARY KEY CHECK(id=1),
         gz BLOB,
         engine_hash TEXT,
         clock_calls INTEGER,
         rng_calls INTEGER,
         config_json TEXT,
         kv_json TEXT,
         used_heap INTEGER,
         size_raw INTEGER,
         size_gz INTEGER,
         gen INTEGER,
         updated_at INTEGER
       );`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`,
    );
    this._configJson = this._meta("config_json") || null;
    this._lastActivity = Date.now();
  }

  _meta(k) {
    const r = this.ctx.storage.sql.exec("SELECT v FROM meta WHERE k=?;", k).toArray();
    return r.length ? r[0].v : null;
  }
  _setMeta(k, v) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
      k,
      String(v),
    );
  }

  _snapRow() {
    const r = this.ctx.storage.sql
      .exec("SELECT * FROM snap WHERE id=1;")
      .toArray();
    return r.length ? r[0] : null;
  }

  // Bring the live kernel up: warm (already live), cold-restore (from this facet's
  // own SQLite snapshot — across an eviction), or fresh (first ever cell). Returns
  // the restoreSource label, exactly mirroring the v0.8 contract.
  async _ensure() {
    if (this.glue.isPresent()) return "warm";
    const row = this._snapRow();
    if (row && row.gz) {
      const gz = row.gz instanceof Uint8Array ? row.gz : new Uint8Array(row.gz);
      // glue.restore admits on the RECORDED used heap + raw-image ceiling, verifies
      // the engine hash, re-hydrates entropy counters + host kv, and rebinds host fns.
      const label = await this.glue.restore(
        gz,
        row.engine_hash,
        row.clock_calls | 0,
        row.rng_calls | 0,
        row.config_json || this._configJson || "{}",
        "cold-restore",
        row.kv_json || null,
        row.used_heap | 0,
      );
      return label;
    }
    await this.glue.createFresh(this._configJson || "{}");
    return "fresh";
  }

  // --- RPC surface (called by the SupervisorDO) ---

  // Configure this session's kernel (clock seed, fetch allowlist, budgets, ...).
  // Persisted so a cold-restore re-applies the same config. Only takes effect on the
  // next fresh create (or is carried in the snapshot for an already-live kernel).
  async configure(configJson) {
    this._configJson = configJson || "{}";
    this._setMeta("config_json", this._configJson);
    return { ok: true };
  }

  // Eval one cell. Returns the parsed v0.8 eval reply {ok,value,valuePreview,
  // valueType,logs,error?}. NEVER throws across the boundary. After a successful
  // (or contained-failure) cell we synchronously checkpoint the heap into SQLite so
  // durability never depends on alarms (facets can't set them anyway).
  async evalCell(src, opts) {
    this._lastActivity = Date.now();
    const restoreSource = await this._ensure();
    const replyJson = await this.glue.evalCode(String(src));
    const reply = JSON.parse(replyJson);
    reply.restoreSource = restoreSource;

    // Atomic per-cell checkpoint (the v0.8 durability model). A snapshot may be
    // refused by a size-admission guard (typed SizeAdmissionError) — we surface that
    // on the reply but keep the cell result + prior committed snapshot intact.
    if (!opts || opts.checkpoint !== false) {
      try {
        const c = await this.checkpoint();
        reply.checkpoint = { ok: true, sizeGz: c.sizeGz, gen: c.gen };
      } catch (e) {
        reply.checkpoint = { ok: false, error: String((e && e.message) || e) };
      }
    }
    return reply;
  }

  // WS proxy entry point: the supervisor forwards each client frame here. We treat a
  // frame as {id?, src} JSON (or a bare string = src) and return a reply the
  // supervisor relays back over the (supervisor-held, hibernatable) socket.
  async handleMessage(message) {
    let src = String(message);
    let id;
    try {
      const m = JSON.parse(message);
      if (m && typeof m === "object" && typeof m.src === "string") {
        src = m.src;
        id = m.id;
      }
    } catch (_) {}
    const reply = await this.evalCell(src);
    return { id, ...reply };
  }

  // Snapshot the live heap into THIS facet's own SQLite atomically (single UPSERT).
  // Carries the manifest fields cold-restore needs: engine hash, entropy counters,
  // config, host-kv, recorded used heap. Bumps a monotonic generation.
  async checkpoint() {
    await this._ensure();
    const d = await this.glue.dump(); // may throw SizeAdmissionError (18MB ceiling etc.)
    const gz = d.gz instanceof Uint8Array ? d.gz : new Uint8Array(d.gz);
    const prevGen = parseInt(this._meta("gen") || "0", 10) || 0;
    const gen = prevGen + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO snap(id,gz,engine_hash,clock_calls,rng_calls,config_json,kv_json,used_heap,size_raw,size_gz,gen,updated_at)
       VALUES(1,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         gz=excluded.gz, engine_hash=excluded.engine_hash, clock_calls=excluded.clock_calls,
         rng_calls=excluded.rng_calls, config_json=excluded.config_json, kv_json=excluded.kv_json,
         used_heap=excluded.used_heap, size_raw=excluded.size_raw, size_gz=excluded.size_gz,
         gen=excluded.gen, updated_at=excluded.updated_at;`,
      gz,
      getEngineHash(),
      d.clockCalls | 0,
      d.rngCalls | 0,
      this._configJson || "{}",
      d.kvJson || "{}",
      d.usedHeap | 0,
      d.sizeRaw | 0,
      d.sizeGz | 0,
      gen,
      Date.now(),
    );
    this._setMeta("gen", String(gen));
    return { ok: true, sizeRaw: d.sizeRaw, sizeGz: d.sizeGz, usedHeap: d.usedHeap, gen, scrubbed: d.scrubbed };
  }

  // Introspection (used by the supervisor + smokes): does a durable snapshot exist,
  // what generation, last activity, is the kernel currently live in this isolate.
  async status() {
    const row = this._snapRow();
    return {
      live: this.glue.isPresent(),
      gen: parseInt(this._meta("gen") || "0", 10) || 0,
      hasSnapshot: !!(row && row.gz),
      sizeGz: row ? row.size_gz | 0 : 0,
      usedHeap: row ? row.used_heap | 0 : 0,
      lastActivity: this._lastActivity,
      engineHash: getEngineHash(),
    };
  }

  // V1.1 keep-warm: a cheap heartbeat from the supervisor sweep. Ensures the kernel is live
  // (cold-restoring it if it had been released) and refreshes last activity so the isolate
  // stays resident — dodging the deep cold-wake for a predicted-active session. Does NOT eval
  // or mutate state. Returns whether the kernel is now live + the current generation.
  async ping() {
    this._lastActivity = Date.now();
    const restoreSource = await this._ensure();
    return {
      ok: true,
      live: this.glue.isPresent(),
      restoreSource,
      gen: parseInt(this._meta("gen") || "0", 10) || 0,
    };
  }

  // V1.1: stdlib + extensions introspection. Ensures the kernel is up (so a fresh create
  // has run the injection) then returns glue.stdlibInfo() (loaded/failed/available/optIn +
  // the wired Tier-0 extension names + caps). JSON-safe across the RPC boundary.
  async stdlib() {
    await this._ensure();
    return JSON.parse(this.glue.stdlibInfo());
  }

  // Drop the live kernel (free the isolate's heap) WITHOUT touching SQLite — the next
  // call cold-restores. Used by the supervisor for soft idle release. (Hard eviction
  // is ctx.facets.abort on the supervisor; both cold-restore from this SQLite.)
  async release() {
    this.glue.drop();
    return { ok: true };
  }
}
