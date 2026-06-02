// v0.6 — ensure src/quickjs.wasm exists (wasm-opt -Oz'd, per v0.4 B3 win: -8.8%,
// byte-identical correctness). quickjs.wasm is NOT committed; it is derived at build
// time from node_modules/quickjs-wasi/quickjs.wasm. Idempotent: skips if already built.
import { stat, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const require = createRequire(import.meta.url);

const out = join(root, "src", "quickjs.wasm");
const src = join(dirname(require.resolve("quickjs-wasi/package.json")), "quickjs.wasm");
const wasmOpt = join(dirname(require.resolve("binaryen/package.json")), "bin", "wasm-opt");

try {
  await stat(out);
  console.log(`[prepare-wasm] src/quickjs.wasm already present — skipping`);
  process.exit(0);
} catch (_) {
  /* not present — build it */
}

try {
  execFileSync(wasmOpt, ["-Oz", src, "-o", out], { stdio: "inherit" });
  console.log(`[prepare-wasm] wasm-opt -Oz ${src} -> src/quickjs.wasm`);
} catch (e) {
  // Fallback: ship the unoptimized engine rather than fail the build.
  console.warn(`[prepare-wasm] wasm-opt failed (${e?.message || e}); copying raw engine`);
  await copyFile(src, out);
}
