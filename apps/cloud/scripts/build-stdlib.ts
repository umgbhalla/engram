// v1.1 — build the configurable in-VM stdlib bundle (ported from v0.8/scripts/build-stdlib.mjs).
//
// Each curated lib has an entry in stdlib-src/<name>.js that imports the lib and assigns it
// to a QuickJS global. We esbuild each entry independently into a self-contained IIFE string
// (platform=browser, NO Node builtins). The per-lib IIFE strings are written into ONE JSON
// object src/stdlib.bundle.txt keyed by module name, plus src/stdlib-meta.js for diagnostics.
//
// Unlike v0.8 (which shipped the bundle as a wrangler Text module via entry.mjs), the V1.1
// facet has NO entry.mjs — so the bake step embeds this bundle string into modules.gen.js and
// the supervisor ships it to the facet as a {js} loader module that sets globalThis.__STDLIB_*.
import { build } from "esbuild";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
// stdlib entry sources are DEDUPED to the kernel's canonical stdlib-src/ (the 6 libs cloud
// bundles — lodash/dayjs/nanoid/uuid/zod/mathjs — are byte-identical there). We keep cloud's
// own MODULES set below (NO `lambda`) so the BUNDLED set, and thus the baked engineHash, stays
// byte-stable; only the on-disk source location is shared. Kernel stays canonical for the
// wasm-bindgen module path; cloud reads cross-app.
const srcDir = join(root, "..", "kernel", "stdlib-src");
const require = createRequire(import.meta.url);

const MODULES = ["lodash", "dayjs", "nanoid", "uuid", "zod"];
const OPT_IN = ["mathjs"];
const ALL = [...MODULES, ...OPT_IN];

const PKG_OF = {
  lodash: "lodash-es",
  dayjs: "dayjs",
  nanoid: "nanoid",
  uuid: "uuid",
  zod: "zod",
  mathjs: "mathjs",
};

function pkgVersion(pkg) {
  try {
    return require(`${pkg}/package.json`).version;
  } catch (_) {
    return "unknown";
  }
}

async function bundleOne(name) {
  const entry = join(srcDir, `${name}.js`);
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (res.outputFiles.length !== 1) {
    throw new Error(`expected 1 output for ${name}, got ${res.outputFiles.length}`);
  }
  return res.outputFiles[0].text;
}

const bundle = {};
const sizes = {};
for (const name of ALL) {
  const iife = await bundleOne(name);
  bundle[name] = iife;
  sizes[name] = iife.length;
  const tag = OPT_IN.includes(name) ? " [OPT-IN]" : "";
  console.log(
    `[build-stdlib] ${name} (${PKG_OF[name]}@${pkgVersion(PKG_OF[name])}) -> ${(iife.length / 1024).toFixed(1)} KB iife${tag}`,
  );
}

const text = JSON.stringify(bundle);
const outDir = join(root, "src");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "stdlib.bundle.txt"), text);

const total = text.length;
console.log(
  `[build-stdlib] wrote src/stdlib.bundle.txt: ${ALL.length} modules (${MODULES.length} default + ${OPT_IN.length} opt-in), ${(total / 1024).toFixed(1)} KB total`,
);

const meta = {
  modules: MODULES,
  optIn: OPT_IN,
  sizes,
  totalBytes: total,
  versions: Object.fromEntries(ALL.map((m) => [m, pkgVersion(PKG_OF[m])])),
  builtAt: Date.now(),
};
await writeFile(
  join(outDir, "stdlib-meta.json"),
  JSON.stringify(meta),
);
console.log(`[build-stdlib] wrote src/stdlib-meta.json`);
