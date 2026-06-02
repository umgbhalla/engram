// Wrapper entry bundled by WRANGLER (not worker-build). Imports the precompiled
// QuickJS WebAssembly.Module as a CompiledWasm asset and exposes it on globalThis
// BEFORE the worker-build output (Rust DO shim + quickjs-wasi JS glue) runs.
// The CompiledWasm import must live here: workerd forbids WebAssembly.compile of
// arbitrary bytes and worker-build's internal esbuild has no .wasm loader.
import quickjsModule from "./src/quickjs.wasm"; // WebAssembly.Module (CompiledWasm rule)
import { ENGINE_HASH } from "./src/engine-hash.js"; // build-time SHA-256 of quickjs.wasm

// v0.6 — CONFIGURABLE IN-VM STDLIB. The curated lib set is esbuilt into ONE bundled
// JSON string {moduleName: iifeString} and shipped as a wrangler TEXT MODULE (imported
// here as a plain STRING — see the Text rule in wrangler.jsonc). The glue parses it and,
// at {t:create}, evals ONLY the IIFEs selected by config.modules into the live QuickJS
// global namespace, so the libs land in the heap and are captured by the snapshot
// (persist across hibernation for free; never re-injected on cold restore).
import STDLIB_BUNDLE from "./src/stdlib.bundle.txt"; // Text module -> string (JSON object)
import { STDLIB_META } from "./src/stdlib-meta.js"; // default module list + sizes (diagnostics)

// v0.8 — TIER-0 EXTENSIONS. The 5 prebuilt quickjs-wasi native extension shared libraries
// (.so) are imported as precompiled WebAssembly.Module assets (CompiledWasm rule in
// wrangler.jsonc, the SAME mechanism as quickjs.wasm) and exposed on globalThis. glue.js
// wires them into QuickJS at create AND restore (the snapshot records extensions in load
// order, so the SAME modules in the SAME order MUST be supplied on cold wake). They add
// crypto.subtle / crypto.getRandomValues / crypto.randomUUID / TextEncoder/Decoder /
// URL/URLSearchParams / structuredClone / Headers to the VM.
//
// DETERMINISM: preserved. The crypto extension's getRandomValues/randomUUID route through the
// WASI `random_get` import, which glue.js's WASI factory ALREADY seeds (seeded mulberry32) —
// so on a seeded session the byte sequence is reproducible and survives restore byte-identical.
// crypto.subtle (digest/sign/verify) is a pure function of its input (no entropy) so it is
// deterministic regardless. We must arrive at the .so as a PRECOMPILED Module because workerd
// forbids runtime WebAssembly.compile of arbitrary bytes (loadExtension accepts a Module).
// (.wasm extension so wrangler's bundler applies the CompiledWasm loader; bytes are the
// unchanged quickjs-wasi .so shared libraries — see scripts/prepare-extensions.mjs.)
import EXT_CRYPTO from "./src/ext/crypto.wasm"; // WebAssembly.Module (CompiledWasm rule)
import EXT_ENCODING from "./src/ext/encoding.wasm";
import EXT_URL from "./src/ext/url.wasm";
import EXT_STRUCTURED_CLONE from "./src/ext/structured-clone.wasm";
import EXT_HEADERS from "./src/ext/headers.wasm";

globalThis.__QJS_MODULE = quickjsModule;
globalThis.__ENGINE_HASH = ENGINE_HASH;
globalThis.__STDLIB_BUNDLE = STDLIB_BUNDLE;
globalThis.__STDLIB_META = STDLIB_META;
// name -> precompiled WebAssembly.Module. glue.js owns the canonical load order
// (EXTENSION_ORDER); this map is just the module registry keyed by extension name.
globalThis.__QJS_EXT_MODULES = {
  crypto: EXT_CRYPTO,
  encoding: EXT_ENCODING,
  url: EXT_URL,
  "structured-clone": EXT_STRUCTURED_CLONE,
  headers: EXT_HEADERS,
};

export { default } from "./build/worker/shim.mjs";
export { KernelDO } from "./build/worker/shim.mjs";
