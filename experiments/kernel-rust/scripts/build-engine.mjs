// Build the rquickjs ENGINE (wasm32-wasip1) and copy it to src/engine.wasm.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const engineDir = resolve(root, "engine");

console.log("[build-engine] cargo build --release --target wasm32-wasip1");
execSync("cargo build --release --target wasm32-wasip1", {
  cwd: engineDir,
  stdio: "inherit",
});

const built = resolve(engineDir, "target/wasm32-wasip1/release/engine.wasm");
if (!existsSync(built)) throw new Error("engine.wasm not produced at " + built);

const dest = resolve(root, "src/engine.wasm");
copyFileSync(built, dest);
console.log("[build-engine] copied engine.wasm ->", dest);

// optional wasm-opt -Oz shrink if available (byte-identical correctness).
try {
  execSync(`wasm-opt -Oz "${dest}" -o "${dest}" 2>/dev/null`, { stdio: "ignore" });
  console.log("[build-engine] wasm-opt -Oz applied");
} catch {
  console.log("[build-engine] wasm-opt not found; skipping (optional)");
}
