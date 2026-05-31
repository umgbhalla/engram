// EXP-5a Worker entry + KernelDO Durable Object.
//
// Thesis under test: a live QuickJS REPL namespace survives a Durable Object
// being evicted from memory (hibernation / cold wake), by dumping QuickJS WASM
// linear memory + mutable globals to durable storage (R2) and restoring into a
// fresh QuickJS instance inside a freshly re-constructed DO.
//
// Reuses the proven EXP-1 snapshot lib (quickjs-wasi 3.0.0). The quickjs.wasm
// binary is bundled as a CompiledWasm module => a WebAssembly.Module we can pass
// straight to QuickJS.create/restore (avoids workerd's ban on WebAssembly.compile
// of arbitrary bytes).

import { QuickJS } from "quickjs-wasi";
import quickjsModule from "./quickjs.wasm"; // WebAssembly.Module (CompiledWasm)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Route a websocket to a named DO instance. Session id from query (?id=)
    // so the test client can target a stable kernel session.
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const sessionId = url.searchParams.get("id") || "default";
      const id = env.KERNEL_DO.idFromName(sessionId);
      const stub = env.KERNEL_DO.get(id);
      return stub.fetch(request);
    }

    return new Response("montydyn-exp5a: try /ws?id=<session>\n", { status: 404 });
  },
};

export class KernelDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    this.sql = state.storage.sql;

    // Live QuickJS instance lives ONLY here, in memory. Eviction/hibernation
    // destroys `this.kernel` — that loss is exactly what we must survive.
    this.kernel = null;

    // Stable per-DO id string used as the R2 snapshot key.
    this.doId = state.id.toString();

    // Schema + generation counter. The constructor runs on every (re)hydration
    // of the DO, so bumping `generation` here is hard evidence of how many times
    // this DO has been instantiated (i.e. how many cold wakes / evictions).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        key TEXT PRIMARY KEY,
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

  // ---- Snapshot key in R2 (one live snapshot per DO id) ----
  #r2Key() {
    return `snap/${this.doId}.qjs.gz`;
  }

  // Ensure a live QuickJS kernel exists in memory. Returns
  // { restoredColdThisCall, source, latencyMs } describing whether we had to
  // cold-restore from R2 this call (the cold-wake path) and how long it took.
  async #ensureKernel() {
    if (this.kernel) {
      return { restoredColdThisCall: false, source: "warm", latencyMs: 0 };
    }

    // No live kernel in memory. Try to restore from the R2 snapshot.
    const t0 = Date.now();
    const obj = await this.env.SNAPSHOTS.get(this.#r2Key());

    if (obj) {
      // message -> R2 get -> gunzip -> deserialize -> instantiate+blit -> ready
      const gz = new Uint8Array(await obj.arrayBuffer());
      const serialized = await gunzip(gz);
      const snap = QuickJS.deserializeSnapshot(serialized);
      this.kernel = await QuickJS.restore(snap, { wasm: quickjsModule });
      // Drain any pending microtask jobs that were live at snapshot time.
      this.kernel.executePendingJobs();
      const latencyMs = Date.now() - t0;
      return { restoredColdThisCall: true, source: "r2-restore", latencyMs };
    }

    // No snapshot yet => brand-new fresh kernel.
    this.kernel = await QuickJS.create({ wasm: quickjsModule });
    const latencyMs = Date.now() - t0;
    return { restoredColdThisCall: true, source: "fresh", latencyMs };
  }

  async #doSnapshot() {
    const ek = await this.#ensureKernel();
    const t0 = Date.now();
    const snap = this.kernel.snapshot();
    const serialized = QuickJS.serializeSnapshot(snap);
    const gz = await gzip(serialized);
    const dumpMs = Date.now() - t0;

    const key = this.#r2Key();
    const tPut = Date.now();
    await this.env.SNAPSHOTS.put(key, gz);
    const putMs = Date.now() - tPut;

    this.sql.exec(
      `INSERT INTO snapshots (key, size_raw, size_gz, generation, created_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         size_raw = excluded.size_raw,
         size_gz = excluded.size_gz,
         generation = excluded.generation,
         created_ms = excluded.created_ms`,
      key,
      serialized.byteLength,
      gz.byteLength,
      this.generation,
      Date.now(),
    );

    return {
      ok: true,
      key,
      sizeRaw: serialized.byteLength,
      sizeGz: gz.byteLength,
      stackPointer: snap.stackPointer,
      generation: this.generation,
      dumpMs,
      putMs,
      restoredBeforeSnapshot: ek.restoredColdThisCall,
    };
  }

  // ---- WebSocket plumbing (hibernatable) ----
  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable accept: state.acceptWebSocket keeps the socket alive across
    // DO eviction without keeping user JS in memory.
    this.state.acceptWebSocket(server);

    // Auto-respond to pings without waking user code, so idle ping/pong does NOT
    // prevent hibernation/eviction.
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
      case "gen": {
        // Report generation + whether a live in-memory kernel is present.
        // Called first after an idle gap to prove the DO was reconstructed
        // (generation bumped) and lost its in-memory kernel.
        return {
          ok: true,
          t: "gen",
          generation: this.generation,
          inMemoryKernelPresent: this.kernel !== null,
        };
      }

      case "eval": {
        const before = this.kernel !== null;
        const ek = await this.#ensureKernel();
        const handle = this.kernel.evalCode(String(msg.src ?? ""));
        const value = handleToJs(handle);
        return {
          ok: true,
          t: "eval",
          value,
          generation: this.generation,
          inMemoryKernelPresentBefore: before,
          restoredColdThisCall: ek.restoredColdThisCall,
          restoreSource: ek.source,
          restoreLatencyMs: ek.latencyMs,
        };
      }

      case "snapshot": {
        return { t: "snapshot", ...(await this.#doSnapshot()) };
      }

      case "evict": {
        // DEBUG: simulate eviction by dropping the in-memory kernel. Proves the
        // R2 restore path works even if real idle-hibernation cannot be forced.
        const had = this.kernel !== null;
        if (this.kernel) {
          try {
            this.kernel.dispose();
          } catch {
            /* ignore */
          }
        }
        this.kernel = null;
        return {
          ok: true,
          t: "evict",
          droppedInMemoryKernel: had,
          generation: this.generation,
          note: "simulated in-memory eviction (does NOT reconstruct the DO; generation unchanged)",
        };
      }

      default:
        return { ok: false, error: `unknown message type: ${msg.t}` };
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  async webSocketError(ws, err) {
    // best-effort; nothing to clean up beyond GC
  }
}

// ---- helpers ----

// Convert a quickjs-wasi JSValueHandle to a plain JS value for the reply.
function handleToJs(handle) {
  try {
    if (handle == null) return null;
    // Prefer a JSON round-trip through the VM-agnostic accessors the lib exposes.
    if (typeof handle.toNumber === "function") {
      const n = handle.toNumber();
      if (!Number.isNaN(n)) return n;
    }
    if (typeof handle.toString === "function") {
      return handle.toString();
    }
    return String(handle);
  } catch (e) {
    return `<unconvertible: ${String(e)}>`;
  }
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
