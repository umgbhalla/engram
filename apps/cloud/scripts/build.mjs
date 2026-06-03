// Deterministic build pipeline for the engram-cloud (Rust-facet) worker.
//   (1) tsc --noEmit   — strict typecheck of supervisor.ts + bake-rust.ts (catches type errors).
//   (2) bake-rust      — generate src/modules.rust.gen.js (Rust DO + engine.wasm + stdlib baked).
//   (3) esbuild bundle — src/supervisor.ts -> dist/worker.mjs (the entry wrangler loads).
// The runtime contract is unchanged: dist/worker.mjs exports `default`, `SupervisorDO`, and
// `HttpGateway` exactly as the prior src/supervisor-rust.js did. esbuild bundles the baked
// modules.rust.gen.js inline (its strings are the facet payload) so the worker is self-contained.
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });

// (1) strict typecheck (no emit) — worker (src/) + build tools (scripts/). Fails on any type error.
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
console.log("[build] tsc --noEmit (strict typecheck: worker + scripts)…");
run("node", [tsc, "--noEmit", "-p", join(root, "tsconfig.json")]);
run("node", [tsc, "--noEmit", "-p", join(root, "scripts", "tsconfig.json")]);

// (2) bake the Rust kernel facet modules -> src/modules.rust.gen.js (consumed by supervisor.ts).
console.log("[build] bake-rust (generate modules.rust.gen.js)…");
run("node", [join(root, "scripts", "bake-rust.ts")]);

// (3) esbuild-bundle the TS supervisor -> dist/worker.mjs (the wrangler entry).
console.log("[build] esbuild bundle supervisor.ts -> dist/worker.mjs…");
await build({
  entryPoints: [join(root, "src", "supervisor.ts")],
  outfile: join(root, "dist", "worker.mjs"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  // cloudflare:workers stays external (provided by the runtime); everything else (incl. the baked
  // modules.rust.gen.js with the facet payload) bundles inline.
  external: ["cloudflare:workers"],
  legalComments: "none",
  logLevel: "info",
});
console.log("[build] done -> dist/worker.mjs");
