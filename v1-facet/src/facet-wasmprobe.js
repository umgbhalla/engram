// Dynamic facet code: probes whether a WebAssembly module shipped as a {data:
// ArrayBuffer} module can be COMPILED + INSTANTIATED at RUNTIME inside a
// dynamically-loaded facet. This is THE key V1 unknown: Worker Loader's module map
// has no CompiledWasm type, only {data: ArrayBuffer}, so the v0.2 kernel's
// `import quickjs.wasm` (CompiledWasm) cannot be used — we must
// WebAssembly.compile(bytes) at runtime, which workerd forbids in ordinary Workers.
import { DurableObject } from "cloudflare:workers";
// Two imports of the SAME tiny wasm (add two i32s):
//  - ./tiny.wasm shipped as {wasm} → should arrive as a WebAssembly.Module (CompiledWasm).
//  - ./tiny.data shipped as {data} → should arrive as an ArrayBuffer (runtime-compile path).
import tinyCompiled from "./tiny.wasm";
import tinyWasm from "./tiny.data";

export class WasmProbeFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  // Probe A: what do the two import types arrive as?
  async probeDataModule() {
    return {
      data_type: Object.prototype.toString.call(tinyWasm),
      data_byteLength: tinyWasm && tinyWasm.byteLength,
      data_isArrayBuffer: tinyWasm instanceof ArrayBuffer,
      data_isUint8Array: tinyWasm instanceof Uint8Array,
      wasm_type: Object.prototype.toString.call(tinyCompiled),
      wasm_isModule: tinyCompiled instanceof WebAssembly.Module,
    };
  }

  // Probe E: instantiate the {wasm}-imported CompiledWasm module directly (no runtime
  // compile). If this works, the v0.2 kernel can ship quickjs.wasm as {wasm} unchanged.
  async probeCompiledImport() {
    try {
      const { instance } =
        tinyCompiled instanceof WebAssembly.Module
          ? { instance: await WebAssembly.instantiate(tinyCompiled, {}) }
          : { instance: null };
      if (!instance) return { ok: false, error: "not a WebAssembly.Module" };
      return { ok: true, add_40_2: instance.exports.add(40, 2) };
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) };
    }
  }

  // Probe B: can we WebAssembly.compile() raw bytes at runtime inside the facet?
  async probeCompile() {
    try {
      const bytes = tinyWasm instanceof ArrayBuffer ? tinyWasm : tinyWasm.buffer || tinyWasm;
      const mod = await WebAssembly.compile(bytes);
      return { ok: true, exports: WebAssembly.Module.exports(mod).map((e) => e.name) };
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) };
    }
  }

  // Probe C: can we INSTANTIATE + CALL the runtime-compiled module?
  async probeInstantiate() {
    try {
      const bytes = tinyWasm instanceof ArrayBuffer ? tinyWasm : tinyWasm.buffer || tinyWasm;
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const r = instance.exports.add(40, 2);
      return { ok: true, add_40_2: r };
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) };
    }
  }

  // Probe D: also try `new WebAssembly.Module(bytes)` (sync) — sometimes gated separately.
  async probeSyncModule() {
    try {
      const bytes = tinyWasm instanceof ArrayBuffer ? tinyWasm : tinyWasm.buffer || tinyWasm;
      const mod = new WebAssembly.Module(bytes);
      return { ok: true, exports: WebAssembly.Module.exports(mod).map((e) => e.name) };
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) };
    }
  }
}
