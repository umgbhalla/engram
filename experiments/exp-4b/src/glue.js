// JS glue for EXP-4b. Two responsibilities:
//
//   (1) Expose the PRECOMPILED QuickJS `WebAssembly.Module` to Rust. workerd bans
//       WebAssembly.compile / new WebAssembly.Module(bytes) of arbitrary bytes, so
//       the only legal way to get a Module on Workers is to import a .wasm asset
//       bundled as a CompiledWasm module. Rust (path a) then instantiates it via
//       js-sys and reaches its Memory.buffer + __stack_pointer Global directly.
//
//   (2) Provide a full path-(b) driver built on quickjs-wasi: the JS glue does the
//       real QuickJS eval (x=42; closure) and the memory+globals dump/restore,
//       exactly the EXP-5a approach but invoked from a RUST Durable Object shell.

// quickjs-wasi: bare import, resolved by worker-build's esbuild from node_modules.
// (Do NOT list quickjs-wasi in the project package.json `dependencies`: worker-build
// 0.8.3 merges those into the wasm-bindgen snippet package.json and then mis-parses
// the nested shape — `invalid type: map, expected a string`. The bare import alone,
// with the package present in node_modules, bundles cleanly.)
import { QuickJS } from "quickjs-wasi";

// The precompiled QuickJS WebAssembly.Module is supplied by the wrapper entry
// (entry.mjs) via globalThis, NOT imported here. workerd bans WebAssembly.compile
// of arbitrary bytes, so the .wasm must be a CompiledWasm import — and that import
// must be bundled by WRANGLER, not by worker-build's esbuild (which has no .wasm
// loader and no way to mark it external from here). entry.mjs does the CompiledWasm
// import and stashes the Module on globalThis before the worker boots.
function quickjsModuleRef() {
  const m = globalThis.__QJS_MODULE;
  if (!m) throw new Error("globalThis.__QJS_MODULE (CompiledWasm) not set by entry");
  return m;
}

async function QJS() {
  return QuickJS;
}

// ---- shared: expose the precompiled module to Rust (path a) ----
export function getQuickjsModule() {
  return quickjsModuleRef();
}

// ---- gzip helpers (workerd CompressionStream, no node:zlib) ----
async function gzip(u8) {
  const cs = new CompressionStream("gzip");
  const stream = new Response(u8).body.pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(u8) {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(u8).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// =====================================================================
// PATH (b): Rust DO shell + JS glue does the real eval + dump/restore.
// One live kernel per glue-driver instance; the Rust DO holds it opaquely.
// =====================================================================
export class GlueKernel {
  constructor() {
    this.kernel = null;
  }

  // Restore from a gzip'd snapshot blob, else create fresh. Returns source string.
  async ensure(gzSnapshotOrNull) {
    if (this.kernel) return "warm";
    const QuickJS = await QJS();
    if (gzSnapshotOrNull) {
      const serialized = await gunzip(new Uint8Array(gzSnapshotOrNull));
      const snap = QuickJS.deserializeSnapshot(serialized);
      this.kernel = await QuickJS.restore(snap, { wasm: quickjsModuleRef() });
      this.kernel.executePendingJobs();
      return "r2-restore";
    }
    this.kernel = await QuickJS.create({ wasm: quickjsModuleRef() });
    return "fresh";
  }

  evalCode(src) {
    const h = this.kernel.evalCode(String(src));
    try {
      if (h == null) return null;
      if (typeof h.toNumber === "function") {
        const n = h.toNumber();
        if (!Number.isNaN(n)) return n;
      }
      if (typeof h.toString === "function") return h.toString();
      return String(h);
    } catch (e) {
      return `<unconvertible: ${String(e)}>`;
    }
  }

  // Dump memory+globals -> serialize -> gzip. Returns { gz, sizeRaw, sizeGz, stackPointer }.
  async dump() {
    const QuickJS = await QJS();
    const snap = this.kernel.snapshot();
    const serialized = QuickJS.serializeSnapshot(snap);
    const gz = await gzip(serialized);
    return {
      gz,
      sizeRaw: serialized.byteLength,
      sizeGz: gz.byteLength,
      stackPointer: snap.stackPointer ?? null,
    };
  }

  drop() {
    if (this.kernel) {
      try {
        this.kernel.dispose();
      } catch (_) {}
    }
    this.kernel = null;
  }
}

export function newGlueKernel() {
  return new GlueKernel();
}
