// Wrapper entry bundled by WRANGLER (not worker-build). Its only job is to import
// the precompiled QuickJS WebAssembly.Module as a CompiledWasm asset and expose it
// on globalThis BEFORE the worker-build output (which contains the Rust DO shim and
// the quickjs-wasi JS glue) runs. The CompiledWasm import must live here because
// workerd forbids WebAssembly.compile of arbitrary bytes and worker-build's internal
// esbuild has no .wasm loader.
import quickjsModule from "./src/quickjs.wasm"; // WebAssembly.Module (CompiledWasm rule)
globalThis.__QJS_MODULE = quickjsModule;

export { default } from "./build/worker/shim.mjs";
export { KernelDO } from "./build/worker/shim.mjs";
