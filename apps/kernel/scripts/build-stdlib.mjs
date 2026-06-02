// v0.6 — build the configurable in-VM stdlib bundle.
//
// Each curated lib has an entry in stdlib-src/<name>.js that imports the lib and
// assigns it to a QuickJS global (globalThis._, globalThis.dayjs, ...). We esbuild
// each entry INDEPENDENTLY into a self-contained IIFE string (platform=browser, NO
// Node builtins, NO require/fs/Buffer/process — QuickJS has none). The per-lib IIFE
// strings are written into ONE Text module (src/stdlib.bundle.txt) as a JSON object
// keyed by module name. wrangler ships that file as a Text module (importable as a
// STRING). At {t:create} the glue parses the JSON and evals ONLY the IIFEs for the
// modules selected by config.modules into the live QuickJS namespace — so the libs
// land in the heap and are captured by the snapshot (persist across hibernation for
// free, no re-inject on cold restore).
//
// platform:"browser" + the empty alias map below guarantee a Node-builtin dependence
// FAILS THE BUILD LOUDLY (esbuild can't resolve the builtin) rather than silently
// shipping a bundle that throws inside QuickJS.

import { build } from "esbuild";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcDir = join(root, "stdlib-src");
const require = createRequire(import.meta.url);

// Curated DEFAULT lib set. Order here = the documented default bundle. A config can
// select a subset via config.modules:["lodash","dayjs"]. All pure-JS / QuickJS-safe.
// v0.9.2: `lambda` is the LAMBDA-RLM typed-combinator module (SPLIT/MAP/REDUCE + bounded
// recursion driver). It is pure in-VM JS with NO npm dependency (it composes host.ctx.*/host.subLM
// at runtime), so it has no stdlib-src import and PKG_OF entry; it ships in the default set so
// `globalThis.lambda` / host.lambda.* is available without an explicit modules selection.
const MODULES = ["lodash", "dayjs", "nanoid", "uuid", "zod", "lambda"];

// V0.7 GUARD 2: OPT-IN-ONLY libs. These ship in the bundle (so they CAN be selected by an
// explicit config.modules:[...]) but are NEVER in the default set (config.modules:true
// EXCLUDES them) because of their heap amplification (mathjs ~29x src->heap trips the
// snapshot OOM cliff). The glue treats an OPT_IN module as opt-in: it loads ONLY when
// explicitly named, and (even then) its source still counts against the injected-source cap.
const OPT_IN = ["mathjs"];

// Everything bundled = defaults + opt-in libs.
const ALL = [...MODULES, ...OPT_IN];

// Map each entry-file module name to the npm package it exposes (for the version log).
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
    platform: "browser", // NO node builtins; a builtin dep fails the build
    target: "es2020", // QuickJS-ng supports modern JS
    minify: true,
    legalComments: "none",
    write: false,
    define: {
      // some libs branch on process.env.NODE_ENV; pin it so the dead branch drops.
      "process.env.NODE_ENV": '"production"',
    },
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

// The Text module the worker ships: a JSON object {name: iifeString}. Single string
// import on the worker side; parsed + selectively eval'd by the glue at create time.
const text = JSON.stringify(bundle);
const outDir = join(root, "src");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "stdlib.bundle.txt"), text);

const total = text.length;
console.log(
  `[build-stdlib] wrote src/stdlib.bundle.txt: ${ALL.length} modules (${MODULES.length} default + ${OPT_IN.length} opt-in), ${(total / 1024).toFixed(1)} KB total (Text module)`,
);

// A tiny JS meta export the worker can import for diagnostics (default module list +
// opt-in list + per-module sizes). Powers {t:"stdlib"} introspection AND the v0.7 guards:
// `modules` = the DEFAULT set selected by config.modules:true; `optIn` = libs loadable only
// when explicitly named; `sizes` = per-module iife byte length (drives the source cap).
const meta = {
  modules: MODULES,
  optIn: OPT_IN,
  sizes,
  totalBytes: total,
  versions: Object.fromEntries(ALL.map((m) => [m, pkgVersion(PKG_OF[m])])),
  builtAt: Date.now(),
};
await writeFile(
  join(outDir, "stdlib-meta.js"),
  `// AUTO-GENERATED by scripts/build-stdlib.mjs. Do not edit.\n` +
    `export const STDLIB_META = ${JSON.stringify(meta)};\n`,
);
console.log(`[build-stdlib] wrote src/stdlib-meta.js`);
