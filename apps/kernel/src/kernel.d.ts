// Ambient declarations for the kernel's authored TS.
//
// Covers the wrangler-special module imports (resolved by wrangler rules at bundle time,
// kept EXTERNAL by esbuild) and the build-time-generated modules.

// engine.wasm (CompiledWasm rule) + stdlib.bundle.txt (Text rule) are wrangler asset imports;
// their TS shape is provided by the arbitrary-extension sidecars src/engine.d.wasm.ts and
// src/stdlib.bundle.d.txt.ts (allowArbitraryExtensions). No ambient module needed here.

// build/worker/shim.mjs — emitted by worker-build (Rust DO shim). Re-exported by entry.ts.
declare module "./build/worker/shim.mjs" {
  const def: unknown;
  export default def;
  export const KernelDO: unknown;
}

// engine-hash.js — generated at build time by scripts/engine-hash.mjs.
declare module "./src/engine-hash.js" {
  export const ENGINE_HASH: string;
}

declare global {
  // The stdlib module catalog (built TS, imported by entry; stamped onto globalThis).
  interface StdlibMeta {
    modules: string[];
    optIn: string[];
    sizes: Record<string, number>;
    totalBytes: number;
    versions: Record<string, string>;
    builtAt: number;
  }

  // globals stamped by entry.ts onto globalThis for the glue + engine to read.
  // eslint-disable-next-line no-var
  var __ENGINE_MODULE: WebAssembly.Module | undefined;
  // eslint-disable-next-line no-var
  var __ENGINE_HASH: string | undefined;
  // eslint-disable-next-line no-var
  var __STDLIB_BUNDLE: string | undefined;
  // eslint-disable-next-line no-var
  var __STDLIB_META: StdlibMeta | undefined;
}

export {};
