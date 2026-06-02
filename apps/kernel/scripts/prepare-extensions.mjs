// v0.8 — TIER-0 EXTENSIONS. Copy the 5 prebuilt quickjs-wasi native extension
// shared libraries (.so) out of node_modules into src/ext/ so wrangler can bundle each
// as a CompiledWasm asset (importable as a precompiled WebAssembly.Module from entry.mjs).
//
// WHY copy (not import from node_modules): wrangler's CompiledWasm rule globs match files
// under the project src tree; and workerd forbids runtime WebAssembly.compile of arbitrary
// bytes, so the .so MUST arrive as a precompiled Module (CompiledWasm), exactly like
// quickjs.wasm. loadExtension() accepts `descriptor.wasm instanceof WebAssembly.Module`
// (no compile), and parses dylink.0 / imports / exports / instantiate(module,...) — all of
// which are permitted on a precompiled Module in workerd.
//
// The .so files are NOT committed (derived from node_modules at build time). Idempotent.
import { stat, copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

// Order is SIGNIFICANT and must match between create and restore (the snapshot records
// extensions in load order). Keep this list as the single source of truth.
export const EXTENSIONS = ["crypto", "encoding", "url", "structured-clone", "headers"];

const extRoot = join(dirname(require.resolve("quickjs-wasi/package.json")), "extensions");
const outDir = join(root, "src", "ext");
await mkdir(outDir, { recursive: true });

for (const name of EXTENSIONS) {
  const src = join(extRoot, name, `${name}.so`);
  // Copy to src/ext/<name>.wasm (NOT .so): wrangler's bundler (esbuild) recognizes the
  // CompiledWasm rule by the .wasm file extension; a ".so" extension errors with "no loader
  // configured". The bytes are the unchanged WASM shared library — only the on-disk name differs.
  const out = join(outDir, `${name}.wasm`);
  try {
    await stat(out);
    console.log(`[prepare-extensions] src/ext/${name}.wasm present — skipping`);
    continue;
  } catch (_) {
    /* not present */
  }
  await copyFile(src, out);
  console.log(`[prepare-extensions] copied ${name}.so -> src/ext/${name}.wasm`);
}
