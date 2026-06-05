// build-stdlib-git.ts — esbuild the git stdlib entries (isomorphic-git + its http client) into
// self-contained IIFE strings and MERGE them into src/stdlib.bundle.txt + src/stdlib-meta.ts,
// preserving the existing curated modules byte-for-byte. (ADR-0012.)
//
// The git modules self-install into globalThis.__mods so require('isomorphic-git') /
// require('isomorphic-git-http') resolve from the in-VM stdlib bundle (no CDN, no ESM dep-tree).
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcDir = resolve(root, "stdlib-src");
const bufShim = resolve(srcDir, "shims/buffer.js");
const require = createRequire(import.meta.url);

// Order matters: the http client first (small), then isomorphic-git. Both keyed by their require
// names. isomorphic-git-http registers extra aliases (isomorphic-git/http) inside its IIFE.
const GIT_MODULES = ["isomorphic-git-http", "isomorphic-git"];

async function bundleOne(name: string): Promise<string> {
  const entry = resolve(srcDir, `${name}.js`);
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    write: false,
    alias: { buffer: bufShim, "node:buffer": bufShim },
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    logLevel: "warning",
  });
  if (res.outputFiles.length !== 1) throw new Error(`expected 1 output for ${name}`);
  return res.outputFiles[0].text;
}

const bundlePath = resolve(root, "src/stdlib.bundle.txt");
const bundle: Record<string, string> = JSON.parse(readFileSync(bundlePath, "utf8"));

const sizes: Record<string, number> = {};
for (const name of GIT_MODULES) {
  const iife = await bundleOne(name);
  bundle[name] = iife;
  sizes[name] = iife.length;
  console.log(`[build-stdlib-git] ${name} -> ${(iife.length / 1024).toFixed(1)} KB iife`);
}

const text = JSON.stringify(bundle);
writeFileSync(bundlePath, text);
console.log(`[build-stdlib-git] wrote ${bundlePath}: ${Object.keys(bundle).length} modules, ${(text.length / 1024).toFixed(1)} KB`);

// merge into stdlib-meta.ts (add to optIn so `modules:true` defaults DON'T auto-load the heavy
// git bundle — it loads only when explicitly named or via `modules:[..,'isomorphic-git']`).
const metaPath = resolve(root, "src/stdlib-meta.ts");
const metaTxt = readFileSync(metaPath, "utf8");
const m = metaTxt.match(/STDLIB_META:\s*StdlibMeta\s*=\s*(\{[\s\S]*\});?/);
if (!m) throw new Error("could not parse stdlib-meta.ts");
const meta = JSON.parse(m[1]);
let igVer = "unknown";
try { igVer = require("isomorphic-git/package.json").version; } catch { /* ignore */ }
for (const name of GIT_MODULES) {
  if (!meta.optIn.includes(name)) meta.optIn.push(name);
  meta.sizes[name] = sizes[name];
  meta.versions[name] = igVer;
}
meta.totalBytes = text.length;
meta.builtAt = Date.now();
const out =
  metaTxt.slice(0, m.index!) +
  `STDLIB_META: StdlibMeta = ${JSON.stringify(meta)};` +
  metaTxt.slice(m.index! + m[0].length);
writeFileSync(metaPath, out);
console.log(`[build-stdlib-git] updated ${metaPath} (optIn: ${meta.optIn.join(", ")})`);
