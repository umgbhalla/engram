// Wrapper entry bundled by WRANGLER. Imports the precompiled rquickjs ENGINE wasm as
// a CompiledWasm asset (WebAssembly.Module) and exposes it on globalThis BEFORE the
// worker-build output (Rust DO shim + kernel-glue.mjs) runs. The CompiledWasm import
// must live here: workerd forbids WebAssembly.compile of arbitrary bytes.
import engineModule from "./src/engine.wasm"; // WebAssembly.Module (CompiledWasm rule)
import { ENGINE_HASH } from "./src/engine-hash.js"; // build-time SHA-256 of engine.wasm
import STDLIB_BUNDLE from "./src/stdlib.bundle.txt"; // Text module: {name: iifeString}
import { STDLIB_META } from "./src/stdlib-meta.js";  // module catalog + opt-in set

globalThis.__ENGINE_MODULE = engineModule;
globalThis.__ENGINE_HASH = ENGINE_HASH;
globalThis.__STDLIB_BUNDLE = STDLIB_BUNDLE;
globalThis.__STDLIB_META = STDLIB_META;

export { default } from "./build/worker/shim.mjs";
export { KernelDO } from "./build/worker/shim.mjs";
