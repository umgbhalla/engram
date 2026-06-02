// entry.mjs — worker entry. Imports the precompiled QuickJS WebAssembly.Module as a
// CompiledWasm asset (same delivery pattern as apps/kernel; workerd forbids runtime
// WebAssembly.compile of arbitrary bytes) and exposes it on globalThis BEFORE the DO
// module runs. The npm `quickjs-wasi` package accepts a precompiled WebAssembly.Module
// directly (QuickJS.create({ wasm: <Module> })), so no Rust glue is needed here.
import QJS_MODULE from "./quickjs.wasm"; // WebAssembly.Module (CompiledWasm rule)

globalThis.__QJS_MODULE = QJS_MODULE;

export { default, KernelDO } from "./worker.mjs";
