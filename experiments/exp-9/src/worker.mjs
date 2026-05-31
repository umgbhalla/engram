// EXP-9 Worker entry + KernelDO Durable Object.
//
// Builds on EXP-5a (proven thesis: QuickJS namespace survives DO eviction via an
// R2 memory+globals snapshot). EXP-9 tests TWO additional robustness properties:
//
//   (1) CRASH-ROBUSTNESS via per-cell move-forward checkpoints.
//       We snapshot to R2 after EACH eval cell. An abrupt eviction WITHOUT a clean
//       onSleep/final-snapshot still restores from the LAST per-cell checkpoint, so
//       state is recovered at the last *committed* cell (no lost-but-promised work).
//
//   (2) UPGRADE GUARD via interpreter content-hash.
//       Each checkpoint is tagged with the SHA-256 hash of the interpreter wasm
//       module. On restore we compare the snapshot's engine hash against the current
//       engine hash. A mismatch (e.g. a v2 engine build) is REJECTED with a typed
//       error (EngineHashMismatchError) instead of silently blitting incompatible
//       memory into a different engine and corrupting state.
//
// Reuses the proven EXP-1/5a snapshot lib (quickjs-wasi 3.0.0) and the same
// quickjs.wasm bundled as a CompiledWasm module.

import { QuickJS } from "quickjs-wasi";
import quickjsModule from "./quickjs.wasm"; // WebAssembly.Module (CompiledWasm)
import quickjsBytes from "./quickjs.wasm.bin"; // ArrayBuffer (Data module) for hashing

// ---- interpreter content-hash (the "engine version" identity) ----
let ENGINE_HASH_PROMISE = null;
async function engineHash() {
  if (!ENGINE_HASH_PROMISE) {
    ENGINE_HASH_PROMISE = (async () => {
      const digest = await crypto.subtle.digest("SHA-256", quickjsBytes);
      return [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    })();
  }
  return ENGINE_HASH_PROMISE;
}

// Typed error for the upgrade guard. A restore against a different engine build
// throws THIS, cleanly, before any memory is blitted.
class EngineHashMismatchError extends Error {
  constructor(expected, actual) {
    super(
      `engine hash mismatch: snapshot was taken with engine ${expected} but ` +
        `current engine is ${actual}; refusing to restore (would corrupt state)`,
    );
    this.name = "EngineHashMismatchError";
    this.code = "ENGINE_HASH_MISMATCH";
    this.expected = expected;
    this.actual = actual;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok", { status: 200 });
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const sessionId = url.searchParams.get("id") || "default";
      const id = env.KERNEL_DO.idFromName(sessionId);
      const stub = env.KERNEL_DO.get(id);
      return stub.fetch(request);
    }
    return new Response("montydyn-exp9: try /ws?id=<session>\n", { status: 404 });
  },
};

export class KernelDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
    this.sql = state.storage.sql;

    // Live QuickJS instance lives ONLY here, in memory. Abrupt eviction destroys it.
    this.kernel = null;
    this.doId = state.id.toString();

    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        cell INTEGER PRIMARY KEY,
        key TEXT,
        size_raw INTEGER,
        size_gz INTEGER,
        engine_hash TEXT,
        created_ms INTEGER
      );
    `);

    // generation: bumped on every (re)hydration => evidence of DO reconstruction.
    const cur = this.#getInt("generation", 0);
    this.generation = cur + 1;
    this.#setMeta("generation", String(this.generation));

    // committedCell: index of the last cell whose checkpoint is durable in R2.
    this.committedCell = this.#getInt("committedCell", -1);
  }

  #getInt(k, dflt) {
    const rows = [...this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k)];
    if (rows.length === 0) return dflt;
    const n = parseInt(rows[0].v, 10);
    return Number.isNaN(n) ? dflt : n;
  }
  #setMeta(k, v) {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      k,
      v,
    );
  }

  #ckptKey(cell) {
    return `exp9/${this.doId}/cell-${cell}.qjs.gz`;
  }
  #lastCommittedCkpt() {
    const rows = [
      ...this.sql.exec(
        `SELECT cell, key, engine_hash, size_raw, size_gz FROM checkpoints
         ORDER BY cell DESC LIMIT 1`,
      ),
    ];
    return rows.length ? rows[0] : null;
  }

  // Restore from a specific R2 checkpoint, enforcing the engine-hash upgrade guard.
  // `expectHashOverride` lets the test pretend the running engine is a different
  // (v2) build to prove clean rejection.
  async #restoreFrom(key, snapshotEngineHash, expectHashOverride) {
    const currentHash = expectHashOverride ?? (await engineHash());
    if (snapshotEngineHash && snapshotEngineHash !== currentHash) {
      // UPGRADE GUARD: reject BEFORE touching memory. No corruption.
      throw new EngineHashMismatchError(snapshotEngineHash, currentHash);
    }
    const obj = await this.env.SNAPSHOTS.get(key);
    if (!obj) throw new Error(`checkpoint object missing in R2: ${key}`);
    const gz = new Uint8Array(await obj.arrayBuffer());
    const serialized = await gunzip(gz);
    const snap = QuickJS.deserializeSnapshot(serialized);
    this.kernel = await QuickJS.restore(snap, { wasm: quickjsModule });
    this.kernel.executePendingJobs();
  }

  // Ensure a live kernel. On a cold/abrupt wake, restore from the LAST committed
  // per-cell checkpoint (the crash-robustness path).
  async #ensureKernel(expectHashOverride) {
    if (this.kernel) {
      return {
        restoredColdThisCall: false,
        source: "warm",
        latencyMs: 0,
        cell: this.committedCell,
      };
    }
    const t0 = Date.now();
    const last = this.#lastCommittedCkpt();
    if (last) {
      await this.#restoreFrom(last.key, last.engine_hash, expectHashOverride);
      return {
        restoredColdThisCall: true,
        source: "checkpoint-restore",
        latencyMs: Date.now() - t0,
        cell: last.cell,
      };
    }
    this.kernel = await QuickJS.create({ wasm: quickjsModule });
    return { restoredColdThisCall: true, source: "fresh", latencyMs: Date.now() - t0, cell: -1 };
  }

  // Snapshot AFTER a cell and commit it as the new recovery anchor.
  async #checkpointCell(cell) {
    const t0 = Date.now();
    const snap = this.kernel.snapshot();
    const serialized = QuickJS.serializeSnapshot(snap);
    const gz = await gzip(serialized);
    const dumpMs = Date.now() - t0;

    const hash = await engineHash();
    const key = this.#ckptKey(cell);
    const tPut = Date.now();
    await this.env.SNAPSHOTS.put(key, gz, {
      customMetadata: { engineHash: hash, cell: String(cell) },
    });
    const putMs = Date.now() - tPut;

    // Commit: the checkpoint is durable in R2 -> advance committedCell.
    this.sql.exec(
      `INSERT INTO checkpoints (cell, key, size_raw, size_gz, engine_hash, created_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(cell) DO UPDATE SET
         key=excluded.key, size_raw=excluded.size_raw, size_gz=excluded.size_gz,
         engine_hash=excluded.engine_hash, created_ms=excluded.created_ms`,
      cell,
      key,
      serialized.byteLength,
      gz.byteLength,
      hash,
      Date.now(),
    );
    this.committedCell = cell;
    this.#setMeta("committedCell", String(cell));

    return {
      cell,
      key,
      sizeRaw: serialized.byteLength,
      sizeGz: gz.byteLength,
      engineHash: hash,
      dumpMs,
      putMs,
    };
  }

  // ---- WebSocket plumbing (hibernatable) ----
  async fetch() {
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
          errorName: err && err.name,
          errorCode: err && err.code,
          generation: this.generation,
        }),
      );
    }
  }

  async #handle(msg) {
    switch (msg.t) {
      case "gen": {
        return {
          ok: true,
          t: "gen",
          generation: this.generation,
          inMemoryKernelPresent: this.kernel !== null,
          committedCell: this.committedCell,
          engineHash: await engineHash(),
        };
      }

      // Run a cell, then CHECKPOINT it (move-forward). `cell` is the cell index.
      case "cell": {
        const ek = await this.#ensureKernel();
        const handle = this.kernel.evalCode(String(msg.src ?? ""));
        const value = handleToJs(handle);
        const cellIdx = Number(msg.cell);
        const ckpt = await this.#checkpointCell(cellIdx);
        return {
          ok: true,
          t: "cell",
          cell: cellIdx,
          value,
          generation: this.generation,
          restoredColdThisCall: ek.restoredColdThisCall,
          restoreSource: ek.source,
          restoreLatencyMs: ek.latencyMs,
          checkpoint: ckpt,
        };
      }

      // Run a cell but DO NOT checkpoint (simulates a cell that started after the
      // last commit and was lost to an abrupt crash). Recovery must land on the
      // last COMMITTED cell, not this uncommitted one.
      case "cellNoCheckpoint": {
        await this.#ensureKernel();
        const handle = this.kernel.evalCode(String(msg.src ?? ""));
        const value = handleToJs(handle);
        return {
          ok: true,
          t: "cellNoCheckpoint",
          value,
          committedCell: this.committedCell,
          note: "ran in-memory but NOT checkpointed; an abrupt crash now loses this cell",
        };
      }

      // Plain eval against the kernel (cold-restores if needed), no checkpoint.
      case "eval": {
        const before = this.kernel !== null;
        const ek = await this.#ensureKernel(msg.expectEngineHash);
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
          restoredFromCell: ek.cell,
        };
      }

      // ABRUPT/UNCLEAN eviction: drop the in-memory kernel with NO final snapshot.
      case "crash": {
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
          t: "crash",
          droppedInMemoryKernel: had,
          committedCell: this.committedCell,
          generation: this.generation,
          note: "abrupt in-memory eviction with NO clean snapshot (unclean crash)",
        };
      }

      // UPGRADE GUARD test: force a cold restore while pretending the running engine
      // is a different build (expectEngineHash). Must reject with a typed error.
      case "restoreWithHash": {
        this.kernel = null; // force cold path
        const fakeHash = String(msg.expectEngineHash || "deadbeefv2engine");
        try {
          const ek = await this.#ensureKernel(fakeHash);
          return {
            ok: true,
            t: "restoreWithHash",
            rejected: false,
            note: "GUARD FAILED: restore proceeded against mismatched engine hash",
            restoreSource: ek.source,
          };
        } catch (err) {
          return {
            ok: true,
            t: "restoreWithHash",
            rejected: true,
            errorName: err.name,
            errorCode: err.code,
            expected: err.expected,
            actual: err.actual,
            kernelStillNull: this.kernel === null,
            note: "guard rejected cleanly; no memory blitted",
          };
        }
      }

      default:
        return { ok: false, error: `unknown message type: ${msg.t}` };
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }
  async webSocketError() {}
}

// ---- helpers ----
function handleToJs(handle) {
  try {
    if (handle == null) return null;
    if (typeof handle.toNumber === "function") {
      const n = handle.toNumber();
      if (!Number.isNaN(n)) return n;
    }
    if (typeof handle.toString === "function") return handle.toString();
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
