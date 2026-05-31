// EXP-7 Worker entry + KernelDO Durable Object — RESTORE LATENCY DISTRIBUTION.
//
// Builds on the proven EXP-5a thesis path (QuickJS WASM linear-memory + globals
// snapshot to R2, restore into a fresh instance inside a re-constructed DO).
//
// EXP-7 goal: measure the cold-restore latency as a function of snapshot size.
// We grow the QuickJS namespace to a target size (via a big allocated buffer of
// pseudo-random bytes so it does not compress to nothing), snapshot it to R2,
// then repeatedly evict + restore to build a p50/p95 latency table per size.
//
// The restore path stages are timed individually:
//   r2GetMs   : R2 get + arrayBuffer read (the network RTT component)
//   gunzipMs  : DecompressionStream gunzip
//   deserMs   : QuickJS.deserializeSnapshot
//   instMs    : QuickJS.restore (instantiate + memory.set() blit + globals)
//   jobsMs    : executePendingJobs
//   totalMs   : wall (message -> ready)
//
// quickjs.wasm is a CompiledWasm import => a WebAssembly.Module passed straight
// to QuickJS.create/restore (workerd bans WebAssembly.compile of arbitrary bytes).

import { QuickJS } from "quickjs-wasi";
import quickjsModule from "./quickjs.wasm"; // WebAssembly.Module (CompiledWasm)

const EXP = "exp7";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const sessionId = url.searchParams.get("id") || "default";
      const id = env.KERNEL_DO.idFromName(sessionId);
      const stub = env.KERNEL_DO.get(id);
      return stub.fetch(request);
    }

    return new Response("montydyn-exp7: try /ws?id=<session>\n", { status: 404 });
  },
};

export class KernelDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    this.sql = state.storage.sql;
    this.kernel = null;
    this.doId = state.id.toString();

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        key TEXT PRIMARY KEY,
        target_mb REAL,
        size_raw INTEGER,
        size_gz INTEGER,
        generation INTEGER,
        created_ms INTEGER
      );
    `);

    const cur = this.#getInt("generation", 0);
    this.generation = cur + 1;
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('generation', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      String(this.generation),
    );
  }

  #getInt(k, dflt) {
    const rows = [...this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k)];
    if (rows.length === 0) return dflt;
    const n = parseInt(rows[0].v, 10);
    return Number.isNaN(n) ? dflt : n;
  }

  // R2 key namespaced by experiment + session, so EXP-7 keys don't collide with
  // EXP-5a's snap/<doId>.qjs.gz keys in the shared bucket.
  #r2Key() {
    return `${EXP}/snap/${this.doId}.qjs.gz`;
  }

  async #freshKernel() {
    this.kernel = await QuickJS.create({ wasm: quickjsModule });
  }

  // Restore the live kernel from R2, timing each stage of the cold path.
  async #restoreFromR2() {
    const t0 = Date.now();
    const obj = await this.env.SNAPSHOTS.get(this.#r2Key());
    if (!obj) return { found: false };

    const gz = new Uint8Array(await obj.arrayBuffer());
    const r2GetMs = Date.now() - t0;

    const tG = Date.now();
    const serialized = await gunzip(gz);
    const gunzipMs = Date.now() - tG;

    const tD = Date.now();
    const snap = QuickJS.deserializeSnapshot(serialized);
    const deserMs = Date.now() - tD;

    const tI = Date.now();
    this.kernel = await QuickJS.restore(snap, { wasm: quickjsModule });
    const instMs = Date.now() - tI;

    const tJ = Date.now();
    this.kernel.executePendingJobs();
    const jobsMs = Date.now() - tJ;

    const totalMs = Date.now() - t0;
    return {
      found: true,
      totalMs,
      stages: {
        r2GetMs, gunzipMs, deserMs, instMs, jobsMs,
        gzBytes: gz.byteLength, rawBytes: serialized.byteLength,
      },
    };
  }

  async #ensureKernel() {
    if (this.kernel) return { restored: false, source: "warm" };
    const r = await this.#restoreFromR2();
    if (r.found) return { restored: true, source: "r2-restore", ...r };
    await this.#freshKernel();
    return { restored: true, source: "fresh" };
  }

  // Grow the namespace to ~targetMb of live, low-compressibility data held in a
  // global. We build a high-entropy JS string inside QuickJS (xorshift PRNG) so
  // the linear memory genuinely contains ~targetMb that survives gzip.
  async #allocTo(targetMb) {
    await this.#ensureKernel();
    const bytes = Math.floor(targetMb * 1024 * 1024);
    const src = `
      (function(){
        var n = ${bytes};
        var s = 0x9e3779b9 >>> 0;
        function r(){ s^=s<<13; s>>>=0; s^=s>>17; s^=s<<5; s>>>=0; return s & 0xff; }
        var CH = 1<<16;
        var parts = [];
        var made = 0;
        while (made < n) {
          var len = Math.min(CH, n - made);
          var arr = new Array(len);
          for (var i=0;i<len;i++) arr[i] = String.fromCharCode(32 + (r() % 95));
          parts.push(arr.join(''));
          made += len;
        }
        globalThis.__payload = parts.join('');
        globalThis.x = 42;
        globalThis.inc = function(){ return ++globalThis.x; };
        return globalThis.__payload.length;
      })()
    `;
    const handle = this.kernel.evalCode(src);
    const len = handleToNum(handle);
    return { payloadLen: len };
  }

  async #doSnapshot(targetMb) {
    await this.#ensureKernel();
    const t0 = Date.now();
    const snap = this.kernel.snapshot();
    const serialized = QuickJS.serializeSnapshot(snap);
    const tgz = Date.now();
    const gz = await gzip(serialized);
    const gzipMs = Date.now() - tgz;
    const dumpMs = Date.now() - t0;

    const key = this.#r2Key();
    const tPut = Date.now();
    await this.env.SNAPSHOTS.put(key, gz);
    const putMs = Date.now() - tPut;

    this.sql.exec(
      `INSERT INTO snapshots (key, target_mb, size_raw, size_gz, generation, created_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         target_mb=excluded.target_mb, size_raw=excluded.size_raw,
         size_gz=excluded.size_gz, generation=excluded.generation,
         created_ms=excluded.created_ms`,
      key, targetMb ?? null, serialized.byteLength, gz.byteLength,
      this.generation, Date.now(),
    );

    return {
      ok: true, key, targetMb,
      sizeRaw: serialized.byteLength,
      sizeGz: gz.byteLength,
      ratio: +(serialized.byteLength / Math.max(1, gz.byteLength)).toFixed(2),
      stackPointer: snap.stackPointer,
      dumpMs, gzipMs, putMs,
    };
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ ok: false, error: "bad json" }));
      return;
    }
    try {
      const reply = await this.#handle(msg);
      ws.send(JSON.stringify(reply));
    } catch (err) {
      ws.send(
        JSON.stringify({
          ok: false,
          error: String(err && err.stack ? err.stack : err),
          generation: this.generation,
        }),
      );
    }
  }

  async #handle(msg) {
    switch (msg.t) {
      case "gen":
        return {
          ok: true, t: "gen", generation: this.generation,
          inMemoryKernelPresent: this.kernel !== null,
        };

      case "alloc": {
        const r = await this.#allocTo(Number(msg.mb));
        return { ok: true, t: "alloc", mb: Number(msg.mb), ...r };
      }

      case "snapshot":
        return { t: "snapshot", ...(await this.#doSnapshot(msg.mb != null ? Number(msg.mb) : null)) };

      case "evict": {
        const had = this.kernel !== null;
        if (this.kernel) { try { this.kernel.dispose(); } catch {} }
        this.kernel = null;
        return { ok: true, t: "evict", droppedInMemoryKernel: had, generation: this.generation };
      }

      // Full timed cold-restore. Drops the in-memory kernel then restores from
      // R2, returning per-stage timings + a namespace sanity check.
      case "restore": {
        if (this.kernel) { try { this.kernel.dispose(); } catch {} this.kernel = null; }
        const r = await this.#restoreFromR2();
        if (!r.found) return { ok: false, t: "restore", error: "no snapshot in R2" };
        const xh = this.kernel.evalCode("globalThis.x");
        const x = handleToNum(xh);
        const ih = this.kernel.evalCode("inc()");
        const inc = handleToNum(ih);
        const ph = this.kernel.evalCode("globalThis.__payload ? globalThis.__payload.length : 0");
        const payloadLen = handleToNum(ph);
        return {
          ok: true, t: "restore", generation: this.generation,
          x, inc, payloadLen,
          totalMs: r.totalMs, ...r.stages,
        };
      }

      // Isolated R2-get RTT only (get + arrayBuffer read), no decode/instantiate.
      case "r2rtt": {
        const t0 = Date.now();
        const obj = await this.env.SNAPSHOTS.get(this.#r2Key());
        if (!obj) return { ok: false, t: "r2rtt", error: "no snapshot" };
        const buf = await obj.arrayBuffer();
        const r2GetMs = Date.now() - t0;
        return { ok: true, t: "r2rtt", r2GetMs, gzBytes: buf.byteLength };
      }

      case "eval": {
        const ek = await this.#ensureKernel();
        const handle = this.kernel.evalCode(String(msg.src ?? ""));
        return {
          ok: true, t: "eval", value: handleToNum(handle) ?? handleToStr(handle),
          generation: this.generation, restoreSource: ek.source,
        };
      }

      default:
        return { ok: false, error: `unknown message type: ${msg.t}` };
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
  }
  async webSocketError() {}
}

// ---- helpers ----
function handleToNum(handle) {
  try {
    if (handle == null) return null;
    if (typeof handle.toNumber === "function") {
      const n = handle.toNumber();
      if (!Number.isNaN(n)) return n;
    }
    return null;
  } catch { return null; }
}
function handleToStr(handle) {
  try {
    if (handle == null) return null;
    if (typeof handle.toString === "function") return handle.toString();
    return String(handle);
  } catch (e) { return `<unconvertible: ${String(e)}>`; }
}

async function gzip(u8) {
  const cs = new CompressionStream("gzip");
  const stream = new Response(u8).body.pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
async function gunzip(u8) {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(u8).body.pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
