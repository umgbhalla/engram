// EXP-6 — MEMORY CEILING PROBE.
//
// Hypothesis: the 128 MB isolate cap + ~2x transient copy during dump/restore
// trips OOM (Error 1102) well under 64 MB of QuickJS linear memory.
//
// Method: inside a DO, grow the live QuickJS namespace by allocating large JS
// arrays/strings (each step pins more linear memory). At each step take a FULL
// snapshot, which simultaneously holds:
//   (a) the live WASM linear memory (the kernel's own memory.buffer),
//   (b) a serialized copy (Uint8Array of the whole linear memory image), and
//   (c) the gzip output buffer.
// => peak transient ≈ 2x linear memory + gzip buffer, all in the 128 MB isolate.
//
// We step until snapshot throws / the isolate OOMs (Error 1102) / the kernel
// errors. The largest linear-memory size at which a full snapshot SUCCEEDS is
// the REAL usable namespace budget.
//
// Two snapshot strategies are measured:
//   - "buffered": serialize -> gzip whole buffer (peak = live + serialized + gz)
//   - "streamed": gzip the serialized bytes through a stream without holding a
//     second full materialized gz buffer beyond the stream's chunks; we still
//     must hold the serialized copy. (CompressionStream still buffers output to
//     compute byteLength here, so this mainly tests whether avoiding an extra
//     full materialization moves the ceiling.)

import { QuickJS } from "quickjs-wasi";
import quickjsModule from "./quickjs.wasm";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("expected websocket upgrade", { status: 426 });
      const sessionId = url.searchParams.get("id") || "default";
      const id = env.KERNEL_DO.idFromName(sessionId);
      return env.KERNEL_DO.get(id).fetch(request);
    }
    return new Response("montydyn-exp6: /ws?id=<session>\n", { status: 404 });
  },
};

export class KernelDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.kernel = null;
    this.doId = state.id.toString();
    // running tally of how much we've intentionally allocated (logical MB)
    this.allocatedLogicalMB = 0;
  }

  async #ensureKernel() {
    if (this.kernel) return;
    // Fresh kernel. Bump the QuickJS internal memory limit high so the QuickJS
    // runtime's own allocator does not cap us before the ISOLATE does — we want
    // to probe the CF isolate ceiling, not QuickJS's soft limit.
    this.kernel = await QuickJS.create({ wasm: quickjsModule, memoryLimit: -1 });
  }

  // Linear memory currently committed by the live kernel, in bytes.
  // quickjs-wasi keeps the WebAssembly.Memory on the (private) exports; reach it
  // by reading the snapshot memory length is cheaper, but for a cheap probe we
  // ask the VM for its own buffer via the documented `memory` field if present,
  // else fall back to -1 (callers use snap.memory.byteLength as ground truth).
  #liveLinearBytes() {
    try {
      // quickjs-wasi exposes the underlying instance; grab exported memory.
      const inst = this.kernel.instance || this.kernel._instance;
      const mem =
        (inst && inst.exports && inst.exports.memory) ||
        (this.kernel.exports && this.kernel.exports.memory) ||
        this.kernel.memory;
      if (mem && mem.buffer) return mem.buffer.byteLength;
    } catch {}
    return -1;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.send(JSON.stringify({ ok: false, error: "bad json" }));
    }
    try {
      ws.send(JSON.stringify(await this.#handle(msg)));
    } catch (err) {
      ws.send(
        JSON.stringify({
          ok: false,
          error: String(err && err.stack ? err.stack : err),
          where: msg.t,
          liveLinearBytes: this.kernel ? this.#liveLinearBytes() : -1,
        }),
      );
    }
  }

  async #handle(msg) {
    switch (msg.t) {
      case "reset": {
        // Drop the kernel and start fresh (new isolate state for the kernel,
        // though the isolate itself persists for the DO).
        if (this.kernel) {
          try {
            this.kernel.dispose();
          } catch {}
        }
        this.kernel = null;
        this.allocatedLogicalMB = 0;
        await this.#ensureKernel();
        return {
          ok: true,
          t: "reset",
          liveLinearBytes: this.#liveLinearBytes(),
        };
      }

      case "grow": {
        // Allocate `mb` more megabytes of LIVE, retained JS data inside the
        // QuickJS namespace. We retain it on a global array so it cannot be GC'd
        // and therefore must be captured by a snapshot.
        await this.#ensureKernel();
        const mb = Number(msg.mb || 0);
        // fill: "rand" (incompressible, CPU-heavy) or "fast" (single memset,
        // low CPU, compressible). Default fast so we probe the MEMORY ceiling
        // without the per-byte loop dominating CPU time.
        const fill = msg.fill || "fast";
        const t0 = Date.now();
        // Allocate as a typed array (1 byte/elem) filled so pages are committed,
        // pushed onto a global retainer. Allocate in 1MB chunks to avoid one
        // huge contiguous alloc failing spuriously.
        const fillRand = fill === "rand";
        const src = `
          (function(){
            globalThis.__keep = globalThis.__keep || [];
            let seed = (globalThis.__seed = (globalThis.__seed || 0x9e3779b1) >>> 0);
            const RAND = ${fillRand};
            for (let i = 0; i < ${mb}; i++) {
              const a = new Uint8Array(1024*1024);
              if (RAND) {
                // incompressible per-byte xorshift (CPU-heavy)
                for (let j = 0; j < a.length; j++) {
                  seed ^= seed << 13; seed >>>= 0;
                  seed ^= seed >> 17;
                  seed ^= seed << 5; seed >>>= 0;
                  a[j] = seed & 0xff;
                }
              } else {
                // low-CPU commit: single native fill of a non-zero byte so the
                // pages are committed (memory ceiling test, not CPU test).
                a.fill((i & 0xff) || 1);
              }
              globalThis.__keep.push(a);
            }
            globalThis.__seed = seed >>> 0;
            return globalThis.__keep.length;
          })()
        `;
        let evalOk = true;
        let evalErr = null;
        let chunks = -1;
        try {
          const h = this.kernel.evalCode(src);
          chunks = numOf(h);
        } catch (e) {
          evalOk = false;
          evalErr = String(e && e.message ? e.message : e);
        }
        if (evalOk) this.allocatedLogicalMB += mb;
        return {
          ok: evalOk,
          t: "grow",
          requestedMB: mb,
          allocatedLogicalMB: this.allocatedLogicalMB,
          keepChunks: chunks,
          liveLinearBytes: this.#liveLinearBytes(),
          liveLinearMB: round2(this.#liveLinearBytes() / 1048576),
          evalErr,
          ms: Date.now() - t0,
        };
      }

      case "snapcheck": {
        // Attempt a FULL snapshot and report whether it succeeded + peak
        // transient memory footprint of the operation. mode: "buffered" (default)
        // or "streamed".
        await this.#ensureKernel();
        const mode = msg.mode || "buffered";
        const liveBefore = this.#liveLinearBytes();
        const result = {
          ok: false,
          t: "snapcheck",
          mode,
          allocatedLogicalMB: this.allocatedLogicalMB,
          liveLinearBytes: liveBefore,
          liveLinearMB: round2(liveBefore / 1048576),
        };
        const t0 = Date.now();
        try {
          // (1) snapshot() — captures full linear memory by reference/copy
          const snap = this.kernel.snapshot();
          result.snapMemBytes = snap.memory ? snap.memory.byteLength : -1;
          // (2) serialize — produces a full Uint8Array copy of the image
          const serialized = QuickJS.serializeSnapshot(snap);
          result.serializedBytes = serialized.byteLength;
          // At this instant the isolate holds: live linear mem + snap.memory
          // (a copy) + serialized (another copy) => ~3x peak in buffered terms
          // (snap.memory is itself a fresh Uint8Array copy of the linear mem).
          // (3) gzip
          let gzBytes;
          if (mode === "nogz") {
            gzBytes = 0; // skip gzip entirely — isolate the snapshot+serialize cost
          } else if (mode === "streamed") {
            gzBytes = await gzipStreamedCount(serialized);
          } else {
            const gz = await gzip(serialized);
            gzBytes = gz.byteLength;
          }
          result.gzBytes = gzBytes;
          result.ratio = gzBytes > 0 ? round2(serialized.byteLength / gzBytes) : null;
          // Peak transient estimate (bytes simultaneously held at the worst
          // point): live linear + snap.memory copy + serialized copy.
          result.peakTransientBytes =
            liveBefore + (result.snapMemBytes > 0 ? result.snapMemBytes : 0) + result.serializedBytes;
          result.peakTransientMB = round2(result.peakTransientBytes / 1048576);
          result.ok = true;
          result.ms = Date.now() - t0;
        } catch (e) {
          result.ok = false;
          result.error = String(e && e.stack ? e.stack : e);
          result.ms = Date.now() - t0;
        }
        return result;
      }

      case "snapstore": {
        // Full snapshot + actually PUT to R2 (namespaced key) — exercises the
        // real persistence path at the probed size, separate from snapcheck.
        await this.#ensureKernel();
        const snap = this.kernel.snapshot();
        const serialized = QuickJS.serializeSnapshot(snap);
        const gz = await gzip(serialized);
        const key = `exp6/${this.doId}.qjs.gz`;
        const tPut = Date.now();
        await this.env.SNAPSHOTS.put(key, gz);
        return {
          ok: true,
          t: "snapstore",
          key,
          serializedBytes: serialized.byteLength,
          gzBytes: gz.byteLength,
          liveLinearMB: round2(this.#liveLinearBytes() / 1048576),
          putMs: Date.now() - tPut,
        };
      }

      case "stat": {
        await this.#ensureKernel();
        let mu = null;
        try {
          mu = this.kernel.computeMemoryUsage
            ? this.kernel.computeMemoryUsage()
            : null;
        } catch {}
        return {
          ok: true,
          t: "stat",
          allocatedLogicalMB: this.allocatedLogicalMB,
          liveLinearBytes: this.#liveLinearBytes(),
          liveLinearMB: round2(this.#liveLinearBytes() / 1048576),
          memoryUsed: mu && mu.memoryUsedSize ? mu.memoryUsedSize : undefined,
        };
      }

      default:
        return { ok: false, error: `unknown type: ${msg.t}` };
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }
  async webSocketError() {}
}

function numOf(h) {
  try {
    if (h && typeof h.toNumber === "function") {
      const n = h.toNumber();
      if (!Number.isNaN(n)) return n;
    }
    if (h && typeof h.toString === "function") return Number(h.toString());
  } catch {}
  return -1;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

async function gzip(u8) {
  const cs = new CompressionStream("gzip");
  const stream = new Response(u8).body.pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// Stream the bytes through gzip without materializing a single full output
// buffer up front — accumulate only the compressed length. Still must hold the
// serialized input; tests whether avoiding the extra full gz materialization
// shifts the ceiling.
async function gzipStreamedCount(u8) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  let total = 0;
  const pump = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
  })();
  // write in 1MB slices to avoid one giant enqueue
  const CHUNK = 1024 * 1024;
  for (let off = 0; off < u8.byteLength; off += CHUNK) {
    await writer.write(u8.subarray(off, Math.min(off + CHUNK, u8.byteLength)));
  }
  await writer.close();
  await pump;
  return total;
}
