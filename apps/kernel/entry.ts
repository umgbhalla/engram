// Wrapper entry. Authored in TS; esbuild emits entry.mjs (wrangler `main`) at build time,
// inlining stdlib-meta and keeping the wrangler-special imports (engine.wasm CompiledWasm,
// stdlib.bundle.txt Text, build/worker/shim.mjs) EXTERNAL so wrangler/worker-build resolve them.
//
// Imports the precompiled rquickjs ENGINE wasm as a CompiledWasm asset (WebAssembly.Module)
// and exposes it on globalThis BEFORE the worker-build output (Rust DO shim + kernel-glue.mjs)
// runs. The CompiledWasm import must live here: workerd forbids WebAssembly.compile of bytes.
import engineModule from "./src/engine.wasm"; // WebAssembly.Module (CompiledWasm rule)
import zstdCodecModule from "./src/zstd-codec.wasm"; // WebAssembly.Module (CompiledWasm rule) — issue #9 snapshot codec
import { ENGINE_HASH } from "./src/engine-hash.js"; // build-time SHA-256 of engine.wasm
import STDLIB_BUNDLE from "./src/stdlib.bundle.txt"; // Text module: {name: iifeString}
import { STDLIB_META } from "./src/stdlib-meta"; // module catalog + opt-in set (inlined from .ts)

globalThis.__ENGINE_MODULE = engineModule;
globalThis.__ZSTD_MODULE = zstdCodecModule;
globalThis.__ENGINE_HASH = ENGINE_HASH;
globalThis.__STDLIB_BUNDLE = STDLIB_BUNDLE;
globalThis.__STDLIB_META = STDLIB_META;

export { default } from "./build/worker/shim.mjs";
export { KernelDO } from "./build/worker/shim.mjs";
