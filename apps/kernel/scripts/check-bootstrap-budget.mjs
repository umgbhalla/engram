#!/usr/bin/env node
/**
 * check-bootstrap-budget.mjs
 *
 * CI gate: ensures snapshot-taxing artifacts stay within committed size ceilings.
 * Every byte in BOOTSTRAP is carried in every heap snapshot forever — if it grows
 * silently the durability moat degrades without anyone noticing. Same for the
 * compiled engine and the stdlib bundle.
 *
 * Run:  node scripts/check-bootstrap-budget.mjs
 * Exit: 0 = all OK, 1 = at least one ceiling breached.
 *
 * ─── CEILINGS ────────────────────────────────────────────────────────────────
 * Raising a ceiling is a deliberate, reviewable act. Update the number below,
 * commit the change with a rationale in the commit message, and land it through
 * normal PR review so the tradeoff is visible in git history.
 *
 * Baselines measured 2026-06-11:
 *   BOOTSTRAP string   183 065 bytes
 *   engine.wasm        899 308 bytes
 *   stdlib.bundle.txt  1 055 472 bytes
 *
 * Ceilings = baseline × 1.15, rounded up to the nearest 10 000.
 */

const CEILINGS = {
  // The raw UTF-8 byte length of the BOOTSTRAP: &str = r#"..."#; string literal
  // inside engine/src/lib.rs. Every shim added here is present in EVERY snapshot.
  // Raise deliberately: justify against durability (see docs/ENV-SURFACE-POLICY.md).
  BOOTSTRAP_BYTES: 220_000,

  // Compiled WASM engine binary (src/engine.wasm). Affects cold-start download
  // and instantiate time — larger engine means slower wake on a cold isolate.
  ENGINE_WASM_BYTES: 1_040_000,

  // Bundled stdlib text (src/stdlib.bundle.txt). Injected into the QuickJS heap
  // at create-time; too large pushes past the safe snapshot ceiling (~18 MB raw).
  STDLIB_BUNDLE_BYTES: 1_220_000,

  // The DEFAULT stdlib preload set (STDLIB_META.defaults) — eval'd into EVERY no-config
  // session's heap, so its combined source is a permanent per-snapshot tax. Keep it well
  // below MAX_STDLIB_SOURCE_BYTES (500 KB hard cap in kernel-glue.ts). Raise deliberately.
  DEFAULT_STDLIB_BYTES: 220_000,
};

// ─── helpers ─────────────────────────────────────────────────────────────────

import { readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function fmt(n) {
  return n.toLocaleString("en-US").padStart(12);
}

function mkrow(metric, current, ceiling) {
  const ok = current <= ceiling;
  const status = ok ? "OK  " : "FAIL";
  const pct = ((current / ceiling) * 100).toFixed(1).padStart(5);
  const line = `  ${status} │ ${metric.padEnd(30)} │ ${fmt(current)} │ ${fmt(ceiling)} │ ${pct}%`;
  return { metric, current, ceiling, ok, line };
}

// ─── measure BOOTSTRAP ───────────────────────────────────────────────────────

function measureBootstrap() {
  const src = readFileSync(path.join(ROOT, "engine/src/lib.rs"), "utf8");
  const startMarker = 'const BOOTSTRAP: &str = r#"';
  const endMarker = '"#;';

  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error("Could not find BOOTSTRAP constant in engine/src/lib.rs");
  }

  const contentStart = startIdx + startMarker.length;
  const endIdx = src.indexOf(endMarker, contentStart);
  if (endIdx === -1) {
    throw new Error('Could not find closing "#; for BOOTSTRAP in engine/src/lib.rs');
  }

  const bootstrapStr = src.slice(contentStart, endIdx);
  return Buffer.byteLength(bootstrapStr, "utf8");
}

// ─── measure optional artifact ───────────────────────────────────────────────

function measureFile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!existsSync(abs)) return null;
  return statSync(abs).size;
}

// ─── main ────────────────────────────────────────────────────────────────────

const rows = [];
let failed = false;

// BOOTSTRAP — always required
try {
  const bootstrapBytes = measureBootstrap();
  rows.push(mkrow("BOOTSTRAP (engine/src/lib.rs)", bootstrapBytes, CEILINGS.BOOTSTRAP_BYTES));
} catch (e) {
  console.error("ERROR measuring BOOTSTRAP:", e.message);
  process.exit(1);
}

// engine.wasm — skip if not yet built
const wasmSize = measureFile("src/engine.wasm");
if (wasmSize !== null) {
  rows.push(mkrow("engine.wasm", wasmSize, CEILINGS.ENGINE_WASM_BYTES));
} else {
  console.warn("  SKIP │ src/engine.wasm not present — run build:engine first");
}

// stdlib.bundle.txt — skip if not yet built
const stdlibSize = measureFile("src/stdlib.bundle.txt");
if (stdlibSize !== null) {
  rows.push(mkrow("stdlib.bundle.txt", stdlibSize, CEILINGS.STDLIB_BUNDLE_BYTES));
} else {
  console.warn("  SKIP │ src/stdlib.bundle.txt not present — run build:worker first");
}

// DEFAULT stdlib preload source — the combined byte size of the modules eval'd into every
// no-config session (STDLIB_META.defaults × sizes). Parsed from src/stdlib-meta.ts (the bake
// manifest). This is the always-on per-snapshot tax of the sensible-defaults feature.
try {
  const metaTxt = readFileSync(path.join(ROOT, "src/stdlib-meta.ts"), "utf8");
  const m = metaTxt.match(/STDLIB_META:\s*StdlibMeta\s*=\s*(\{[\s\S]*?\});/);
  if (m) {
    const meta = JSON.parse(m[1]);
    const defaults = Array.isArray(meta.defaults) ? meta.defaults : [];
    const sizes = meta.sizes || {};
    const defaultBytes = defaults.reduce((a, n) => a + (Number(sizes[n]) || 0), 0);
    rows.push(mkrow("default stdlib (" + defaults.length + " mods)", defaultBytes, CEILINGS.DEFAULT_STDLIB_BYTES));
  } else {
    console.warn("  SKIP │ could not parse STDLIB_META.defaults from src/stdlib-meta.ts");
  }
} catch (e) {
  console.warn("  SKIP │ default-stdlib measure failed: " + e.message);
}

// ─── report ──────────────────────────────────────────────────────────────────

const div = "  ──────┼────────────────────────────────┼──────────────┼──────────────┼───────";
console.log("\n  Engram kernel — snapshot-byte budget check");
console.log("  ──────┬────────────────────────────────┬──────────────┬──────────────┬───────");
console.log("  stat  │ metric                         │      current │      ceiling │   use%");
console.log(div);

for (const r of rows) {
  console.log(r.line);
  if (!r.ok) failed = true;
}

console.log(div);
console.log();

if (failed) {
  console.error(
    "  FAIL: one or more budget ceilings exceeded.\n\n" +
    "  BOOTSTRAP grew past budget — every shim is carried in every snapshot\n" +
    "  forever; justify against durability or raise the ceiling deliberately.\n" +
    "  See docs/ENV-SURFACE-POLICY.md for the compat line and the three gates\n" +
    "  a shim must pass before it earns a place in BOOTSTRAP.\n\n" +
    "  To raise a ceiling: edit CEILINGS in scripts/check-bootstrap-budget.mjs,\n" +
    "  commit with a rationale, land via PR review.\n"
  );
  process.exit(1);
} else {
  console.log("  All metrics within budget.\n");
}
