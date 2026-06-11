// Build the zstd CODEC wasm (codec/ crate) -> src/zstd-codec.wasm.
//
// Issue #9: the snapshot dump compresses the raw heap image. zstd (level 9) is measurably smaller
// AND faster than the platform gzip CompressionStream on representative images (fresh -31%,
// stdlib -16%, incompressible -7%; compress 0.56-0.90x gzip time; decompress 2-4x faster). workerd
// forbids runtime WebAssembly.compile, so the codec ships as a CompiledWasm module (like
// engine.wasm) imported in entry.ts and instantiated host-side in the glue with a stubbed WASI.
//
// This is a GLUE-side codec: it does NOT touch engine.wasm, so the ENGINE_HASH is unchanged and no
// live session is forced to oplog-replay on deploy. Back-compat: gzip snapshots still restore (the
// manifest carries a snap_codec tag; absent/'gzip' => gunzip, 'zstd' => this codec).
//
// The codec C (zstd-sys) needs a wasm-capable clang. We reuse the WASI SDK that the ENGINE build
// (rquickjs-sys) already downloaded into engine/target/.../out/wasi-sdk -- no extra toolchain.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const codecDir = resolve(root, "codec");

// Locate the WASI SDK clang the engine build produced (hash-named OUT_DIR under engine/target).
function findWasiSdk(): string | null {
  const bases = [
    resolve(root, "engine/target/wasm32-wasip1/release/build"),
    resolve(root, "engine/target/wasm32-wasip1/debug/build"),
  ];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      if (!d.startsWith("rquickjs-sys-")) continue;
      const sdk = join(base, d, "out", "wasi-sdk");
      if (existsSync(join(sdk, "bin", "clang"))) return sdk;
    }
  }
  if (process.env.WASI_SDK_PATH && existsSync(join(process.env.WASI_SDK_PATH, "bin", "clang"))) {
    return process.env.WASI_SDK_PATH;
  }
  return null;
}

const sdk = findWasiSdk();
if (!sdk) {
  throw new Error(
    "[build-codec] no WASI SDK clang found. Run scripts/build-engine.ts first (it downloads the " +
      "WASI SDK), or set WASI_SDK_PATH to a wasi-sdk install."
  );
}
console.log("[build-codec] WASI SDK:", sdk);

const env = {
  ...process.env,
  CC_wasm32_wasip1: join(sdk, "bin", "clang"),
  AR_wasm32_wasip1: join(sdk, "bin", "llvm-ar"),
  CFLAGS_wasm32_wasip1: "--sysroot=" + join(sdk, "share", "wasi-sysroot"),
  WASI_SDK_PATH: sdk,
};

console.log("[build-codec] cargo build --release --target wasm32-wasip1 (codec/)");
execSync("cargo build --release --target wasm32-wasip1", { cwd: codecDir, stdio: "inherit", env });

const built = resolve(codecDir, "target/wasm32-wasip1/release/zstdcodec.wasm");
if (!existsSync(built)) throw new Error("[build-codec] zstdcodec.wasm not produced at " + built);

const dest = resolve(root, "src/zstd-codec.wasm");
copyFileSync(built, dest);
console.log("[build-codec] copied zstd-codec.wasm ->", dest);

try {
  execSync(
    `wasm-opt -Oz --enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext ` +
      `--enable-mutable-globals "${dest}" -o "${dest}"`,
    { stdio: "ignore" }
  );
  console.log("[build-codec] wasm-opt -Oz applied");
} catch {
  console.log("[build-codec] wasm-opt not found / skipped (optional)");
}
