// restore-cliff.mjs — DEEP TEST: measure the real cold-restore transient-OOM cliff.
//
// Resolves the open question in docs/CHAOS-CASE1-VERDICT.md: is MAX_RESTORE_RAW_BYTES (76MB)
// above the true restore cliff? The kernel's admission DISCOUNTS 31MB of zero-scratch
// (kernel-glue.ts:2574), betting that a large-raw / low-incompressible image restores cheaply
// (zero pages are cheap to gunzip + instantiate). This harness tests that bet directly.
//
// Method: for each target buffer size N, a fresh session spikes the WASM linear buffer to ~N MB
// of MOSTLY-ZERO content (low incompressible extent, so the 24MB incompressible gate ADMITS it),
// frees it (buffer stays N MB — WASM memory is monotonic), commits a checkpoint of that
// high-water base, then genuinely cold-restores. A surviving canary = restorable; a
// timeout/socket-death = the WS-1006 transient-OOM cliff (the real bug, silent durable loss);
// a typed SizeAdmissionError = the guard caught it (safe, by design).
//
//   ENGRAM_KERNEL_KEY=...  node tests/chaos/restore-cliff.mjs [loMB] [hiMB] [stepMB]
//   defaults: 24 76 8   (also probes 78 to confirm the absolute cap rejects cleanly)
//
// PREREQ: a HEALTHY engram-kernel (run a `1+1` liveness ping first). Each trial allocates up to
// ~76MB on the shared kernel worker — run sparsely, not in a tight loop, to avoid worker pressure.

import { Engram } from "../../packages/sdk/dist/index.mjs";
const { default: WebSocket } = await import("ws");

const url = process.env.ENGRAM_URL ?? "wss://engram.umgbhalla.xyz";
// ENGRAM_KERNEL_KEY is often EMPTY in a fresh shell (lives in repo .env). Fall back to .env.
const _fs = await import("node:fs"), _path = await import("node:path"), _url = await import("node:url");
function envKey() {
  if (process.env.ENGRAM_KERNEL_KEY) return process.env.ENGRAM_KERNEL_KEY;
  try {
    const root = _path.resolve(_path.dirname(_url.fileURLToPath(import.meta.url)), "../..");
    const line = _fs.readFileSync(_path.join(root, ".env"), "utf8").split("\n").find((l) => l.startsWith("ENGRAM_KERNEL_KEY="));
    return line ? line.slice("ENGRAM_KERNEL_KEY=".length).trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}
const apiKey = envKey();
if (!apiKey) { console.error("ENGRAM_KERNEL_KEY required (shell env or repo .env)"); process.exit(2); }

const MB = 1024 * 1024;
const lo = Number(process.argv[2] ?? 24);
const hi = Number(process.argv[3] ?? 76);
const step = Number(process.argv[4] ?? 8);
const tag = () => `cliff-${Math.floor(performance.now())}-${Math.floor(performance.timeOrigin)}`;

// Classify one trial at N MB. Returns one of:
//   "restored"  — canary survived cold restore (image is safe at this size)
//   "rejected"  — typed SizeAdmissionError at dump (guard caught it; safe by design)
//   "CLIFF"     — restore crashed / socket died / timed out (silent-loss risk — the real bug)
//   "no-spike"  — precondition failed (alloc didn't land); inconclusive
async function trial(nMB) {
  // bare engram-kernel wants kernelKey (/ws?id=); apiKey routes to the cloud /connect path and hangs.
  const s = await Engram.connect({ url, kernelKey: apiKey, session: `${tag()}-${nMB}`, WebSocket, timeoutMs: 120_000 });
  try {
    await s.eval(`globalThis.canary = 'cliff-${nMB}'`);

    // Spike the linear buffer to ~N MB. Touch both ends so the alloc is real; keep it MOSTLY ZERO
    // (only 2 non-zero bytes) so the incompressible extent stays tiny and the 24MB gate ADMITS.
    const bytes = nMB * MB;
    let spike;
    try {
      spike = await s.eval(
        `globalThis.__s = new Uint8Array(${bytes}); __s[0] = 1; __s[${bytes - 1}] = 1; __s.length`,
        { timeoutMs: 120_000 },
      );
    } catch (e) {
      // a dump/admission error can surface here if the spike itself trips a mid-cell guard
      return { nMB, outcome: /SizeAdmission|MemoryLimit/.test(e.message) ? "rejected" : "CLIFF", detail: e.message };
    }
    if (spike?.value !== bytes) return { nMB, outcome: "no-spike", detail: `readback ${JSON.stringify(spike?.value)}` };

    // Free → buffer stays at N MB high-water (monotonic). The post-eval checkpoint of THIS cell
    // commits the scrubbed N-MB base (the one we want to test for restorability).
    try {
      await s.eval(`globalThis.__s = null; 1`, { timeoutMs: 120_000 });
    } catch (e) {
      return { nMB, outcome: /SizeAdmission/.test(e.message) ? "rejected" : "CLIFF", detail: `commit: ${e.message}` };
    }

    // Genuine cold restore from the committed high-water base.
    let restoreSource, generation;
    try {
      ({ restoreSource, generation } = await s.hibernateThenResume());
    } catch (e) {
      return { nMB, outcome: /SizeAdmission/.test(e.message) ? "rejected" : "CLIFF", detail: `restore: ${e.message}` };
    }

    // Did the acked-durable canary survive?
    let after;
    try { after = (await s.eval(`globalThis.canary ?? null`, { timeoutMs: 60_000 })).value; }
    catch (e) { return { nMB, outcome: "CLIFF", detail: `post-restore eval: ${e.message}`, restoreSource }; }

    if (after === `cliff-${nMB}`) return { nMB, outcome: "restored", detail: `gen=${generation} src=${restoreSource}` };
    return { nMB, outcome: "CLIFF", detail: `canary LOST (got ${JSON.stringify(after)}) src=${restoreSource}` };
  } finally { s.close(); }
}

console.log(`\n══ restore-cliff sweep: ${lo}→${hi} MB step ${step} (+78 cap probe) ══`);
console.log(`   restored=safe · rejected=guard-caught(safe) · CLIFF=silent-loss-risk(BUG)\n`);

const sizes = [];
for (let n = lo; n <= hi; n += step) sizes.push(n);
sizes.push(78); // above SAFE_SERIALIZE_BUFFER_BYTES(76) — MUST be a clean typed reject, never a CLIFF

const rows = [];
let firstCliff = null;
for (const n of sizes) {
  const r = await trial(n);
  const mark = { restored: "🟢", rejected: "🟡", CLIFF: "🔴", "no-spike": "⚪" }[r.outcome] ?? "❓";
  console.log(`  ${mark} ${String(n).padStart(3)}MB  ${r.outcome.padEnd(9)}  ${r.detail ?? ""}`);
  rows.push(r);
  if (r.outcome === "CLIFF" && firstCliff == null) firstCliff = n;
  // breathe between trials so we don't pile 76MB allocs onto the shared worker
  await new Promise((res) => setTimeout(res, 1500));
}

console.log(`\n════ CLIFF VERDICT ════`);
if (firstCliff == null) {
  console.log(`  🟢 NO CLIFF in [${lo},${hi}]MB. The 31MB discount + 76MB cap are SAFE on this path.`);
  console.log(`     → Chaos case1 CRITICAL is a FALSE POSITIVE; keep the discount, document verified-safe.`);
} else {
  console.log(`  🔴 CLIFF at ${firstCliff}MB raw (below the 76MB admit cap). Silent-loss risk CONFIRMED.`);
  console.log(`     → Fix: lower SAFE_SERIALIZE_BUFFER_BYTES + MAX_RESTORE_RAW_BYTES to < ${firstCliff}MB`);
  console.log(`        (lockstep), OR adopt keep-prior-verified-base. See docs/CHAOS-CASE1-VERDICT.md.`);
}
const cap78 = rows.find((r) => r.nMB === 78);
if (cap78 && cap78.outcome === "CLIFF") {
  console.log(`  ⚠️  78MB probe CRASHED instead of clean-rejecting — the absolute cap itself is unsafe.`);
}
process.exit(firstCliff != null ? 1 : 0);
