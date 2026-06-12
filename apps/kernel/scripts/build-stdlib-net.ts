// build-stdlib-net.ts — esbuild the VM-side net/tls client shims (stdlib-src/shims/{net,tls}.js)
// into self-contained IIFE strings and MERGE them into src/stdlib.bundle.txt + src/stdlib-meta.ts,
// preserving every existing curated module byte-for-byte.
//
// These shims self-install into globalThis.__mods under 'net'/'node:net' and 'tls'/'node:tls' so
// require('net')/require('tls') resolve from the in-VM stdlib bundle. They are added to the DEFAULT
// set (not optIn) — tiny pure-JS shims, broadly useful — so they load at create without config.
// All real I/O crosses host['socket.*'] (cloudflare:sockets, DO-side); see src/host-sockets.mjs.
//
// Order matters: net FIRST (tls.js reads globalThis.__mods['net'] at IIFE eval).
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcDir = resolve(root, "stdlib-src");

const NET_MODULES = ["net", "tls"];

async function bundleOne(name: string): Promise<string> {
  const entry = resolve(srcDir, `shims/${name}.js`);
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    write: false,
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    logLevel: "warning",
  });
  if (res.outputFiles.length !== 1) throw new Error(`expected 1 output for ${name}`);
  return res.outputFiles[0].text;
}

const bundlePath = resolve(root, "src/stdlib.bundle.txt");
const bundle: Record<string, string> = JSON.parse(readFileSync(bundlePath, "utf8"));

const sizes: Record<string, number> = {};
for (const name of NET_MODULES) {
  const iife = await bundleOne(name);
  bundle[name] = iife;
  sizes[name] = iife.length;
  console.log(`[build-stdlib-net] ${name} -> ${(iife.length / 1024).toFixed(1)} KB iife`);
}

const text = JSON.stringify(bundle);
writeFileSync(bundlePath, text);
console.log(`[build-stdlib-net] wrote ${bundlePath}: ${Object.keys(bundle).length} modules, ${(text.length / 1024).toFixed(1)} KB`);

// merge into stdlib-meta.ts — add net/tls to `modules` + `defaults` (load at create) and sizes.
const metaPath = resolve(root, "src/stdlib-meta.ts");
const metaTxt = readFileSync(metaPath, "utf8");
const m = metaTxt.match(/STDLIB_META:\s*StdlibMeta\s*=\s*(\{[\s\S]*\});?/);
if (!m) throw new Error("could not parse stdlib-meta.ts");
const meta = JSON.parse(m[1]);
for (const name of NET_MODULES) {
  if (Array.isArray(meta.modules) && !meta.modules.includes(name)) meta.modules.push(name);
  if (Array.isArray(meta.defaults) && !meta.defaults.includes(name)) meta.defaults.push(name);
  meta.sizes[name] = sizes[name];
  meta.versions[name] = "builtin";
}
meta.totalBytes = text.length;
const out = metaTxt.slice(0, m.index!) + `STDLIB_META: StdlibMeta = ${JSON.stringify(meta)};` + metaTxt.slice(m.index! + m[0].length);
writeFileSync(metaPath, out);
console.log(`[build-stdlib-net] updated ${metaPath} (defaults: ${meta.defaults.join(", ")})`);
