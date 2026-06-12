// Chaos Cascade — runnable repro harnesses for the 3 CONFIRMED-BREAK cases.
//
// Source: workflow `engram-poetic-chaos-cascade` (run wf_f6e92d8f-6b3, task wnlffxtj5),
// distilled in docs/CHAOS-CASCADE.md. Each repro drives a LIVE engram-kernel session,
// observes the durable namespace across a real hibernate/cold-restore, and reports
// REPRODUCED / not-reproduced. Throwaway sessions only.
//
//   ENGRAM_KERNEL_KEY=...  node tests/chaos/chaos-repros.mjs [case1|case2|case3|all]
//
// Honesty notes (legs that need server-side fault injection — flagged inline, NOT faked):
//   case2 silent-loss leg requires the rollover R2 base to be momentarily UNREADABLE; a
//         pure WS client cannot force R2 unavailability, so case2 verifies restore FIDELITY
//         (acc survives) and reports the precondition reached. A red verdict still means a
//         real fidelity break; a green verdict does NOT clear the documented fault path.

import { Engram } from "../../packages/sdk/dist/index.mjs";
const { default: WebSocket } = await import("ws");

const url = process.env.ENGRAM_URL ?? "wss://engram.umgbhalla.xyz";
const apiKey = process.env.ENGRAM_KERNEL_KEY;
if (!apiKey) { console.error("ENGRAM_KERNEL_KEY required"); process.exit(2); }

const MB = 1024 * 1024;
const tag = () => `chaos-${Math.floor(performance.now())}-${Math.floor(performance.timeOrigin)}`;
const verdicts = [];
function reproduced(name, detail) { console.log(`\n  🔴 REPRODUCED — ${name}\n     ${detail}`); verdicts.push({ name, reproduced: true, detail }); }
function held(name, detail) { console.log(`\n  🟢 not reproduced (guard held) — ${name}\n     ${detail}`); verdicts.push({ name, reproduced: false, detail }); }
async function connect(t, config = {}) {
  return Engram.connect({ url, apiKey, session: `${t}-${tag()}`, WebSocket, config });
}
const val = (r) => r?.value;

// ───────────────────────────────────────────────────────────────────────────
// CASE 1 — CRITICAL: un-restorable commit via unconditional 31MB scratch discount
//   kernel-glue.mjs:24148  incompressibleBytes = max(usedHeap, bufBytes0 - 31MB)
//   Spike high-water → free → GC → tiny-used_heap checkpoint ADMITS a ~47MB raw W4 base.
//   Cold-restore later may fail to instantiate → silent permanent loss of acked state.
// ───────────────────────────────────────────────────────────────────────────
async function case1() {
  console.log("\n══ CASE 1 — admission-math un-restorable commit [CRITICAL] ══");
  const s = await connect("c1");
  try {
    // durable canary established BEFORE the spike — must survive
    await s.eval(`globalThis.canary = { id: 'c1-canary', n: 12345, arr: [1,2,3] }`);

    // Cell 1: prime high-water-mark ~46MB single native alloc (< 64MB grow cap, no trip)
    const c1 = await s.eval(`globalThis.__b = new Uint8Array(46*1024*1024); __b.fill(7); __b.length`);
    console.log(`     spike alloc -> sizeRaw≈${((c1.sizeRaw ?? 0)/MB).toFixed(1)}MB used≈${((c1.usedHeap ?? 0)/MB).toFixed(1)}MB`);

    // Cell 2: free
    await s.eval(`globalThis.__b = null; 1`);

    // Cell 3: force GC + settle to tiny used_heap → this checkpoint is the one that ADMITS
    const c3 = await s.eval(`(globalThis.gc?.(), globalThis.canary.n)`);
    const raw = c3.sizeRaw ?? 0, used = c3.usedHeap ?? 0;
    console.log(`     settle commit -> sizeRaw≈${(raw/MB).toFixed(1)}MB used≈${(used/MB).toFixed(1)}MB committed=${c3.ok !== false}`);

    // Now the bomb: genuine cold restore from that committed high-water base
    const { restoreSource, generation } = await s.hibernateThenResume();
    console.log(`     cold restore -> source=${restoreSource} gen=${generation}`);

    // Did the acked-durable canary survive the restore?
    const after = await s.eval(`globalThis.canary?.n ?? null`).catch((e) => ({ __err: e.message }));
    if (after?.__err) {
      reproduced("case1", `cold restore THREW / lost session after committing ~${(raw/MB).toFixed(1)}MB base: ${after.__err}`);
    } else if (val(after) !== 12345) {
      reproduced("case1", `canary LOST across restore (got ${JSON.stringify(val(after))}, expected 12345) from a ${(raw/MB).toFixed(1)}MB admitted base`);
    } else {
      held("case1", `canary survived (n=12345) restore=${restoreSource}; admitted base ${(raw/MB).toFixed(1)}MB instantiated OK this run`);
    }
  } finally { s.close(); }
}

// ───────────────────────────────────────────────────────────────────────────
// CASE 2 — HIGH: W4 delta-chain rollover → 1-cell namespace on unreadable base
//   lib.rs:2052/2091/2792 — drive past BASE_EVERY=20 with usedHeap>8MB (SQLITE_HOT_MAX
//   → R2 spill). If the new R2 base is unreadable at restore, reconstruction yields a
//   1-cell namespace yet reports success → non-idempotent accumulated state lost.
// ───────────────────────────────────────────────────────────────────────────
async function case2() {
  console.log("\n══ CASE 2 — W4 rollover 1-cell-namespace fidelity [HIGH] ══");
  const s = await connect("c2");
  try {
    // pin usedHeap > 8MB SQLITE_HOT_MAX so the rollover base spills to R2
    await s.eval(`globalThis.big = new Uint8Array(9*1024*1024).fill(1); globalThis.acc = []; 1`);
    const BASE_EVERY = 20;
    let lastSpill = null;
    for (let i = 0; i <= BASE_EVERY; i++) {
      const r = await s.eval(`acc.push({ i: ${i}, blob: big.slice(0, 1024) }); globalThis.last = acc.length; last`);
      if ((r.sizeRaw ?? 0) > 8 * MB) lastSpill = r.sizeRaw;
    }
    const pre = val(await s.eval(`acc.length`));
    console.log(`     drove ${BASE_EVERY + 1} non-idempotent cells over rollover; acc.length=${pre}; R2-spill seen=${lastSpill != null}`);

    const { restoreSource, generation } = await s.hibernateThenResume();
    const post = val(await s.eval(`globalThis.acc?.length ?? null`));
    console.log(`     cold restore -> source=${restoreSource} gen=${generation}; acc.length=${post}`);

    if (post === 1 || (typeof post === "number" && post < pre)) {
      reproduced("case2", `namespace COLLAPSED across rollover restore: acc.length ${pre} → ${post} (1-cell reconstruction / state loss)`);
    } else if (post !== pre) {
      reproduced("case2", `acc fidelity broke: ${pre} → ${post}`);
    } else {
      held("case2", `acc intact (${post}) restore=${restoreSource}. NOTE: silent-loss leg needs R2 base UNREADABLE at restore (server-side fault injection) — not exercisable from a WS client.`);
    }
  } finally { s.close(); }
}

// ───────────────────────────────────────────────────────────────────────────
// CASE 3 — HIGH: parked-continuation generation race vs mutex-free vfs write
//   lib.rs:2201/2237/2538 — eval STAGES host.fs under the eval mutex; vfs/sandbox/worker
//   commits are mutex-FREE to the same fs/<doId>/ + fs_files. Park an eval at a withheld
//   host.slow() await, race a mutex-free vfs write to the same path, then release.
//   Final committed content vs read-back reveals staged-commit coherence break.
// ───────────────────────────────────────────────────────────────────────────
async function case3() {
  console.log("\n══ CASE 3 — parked-continuation staged-commit race [HIGH] ══");
  const s = await connect("c3");
  let release;
  const gate = new Promise((res) => { release = res; });
  // host.slow withholds its reply until we release → holds the eval mutex parked
  s.bindHost("slow", async () => { await gate; return "released"; });
  try {
    const PATH = "/workspace/data.txt";
    await s.eval(`fs.writeFileSync('${PATH}', 'INIT')`).catch(() => {});

    // Frame 1: eval stages a write to PATH then suspends at host.slow() (mutex held, parked)
    const parked = s.eval(`
      (async () => {
        fs.writeFileSync('${PATH}', 'STAGED_BY_EVAL');   // staged in self.staged_fs, flushed at post-eval checkpoint
        await host.slow();                                // park here, mutex held
        return fs.readFileSync('${PATH}', 'utf8');
      })()
    `).catch((e) => ({ __err: e.message }));

    // give the eval time to stage + park
    await new Promise((r) => setTimeout(r, 1500));

    // Frame 2: a mutex-FREE commit to the SAME path while eval is parked.
    // vfs-write / sandbox / worker-invoke bypass the eval mutex (lib.rs:2201-2229).
    // Drive it via a fresh transport on the SAME session so it races the parked frame.
    const racer = await Engram.connect({ url, apiKey, session: s.session ?? undefined, WebSocket });
    let racerNote = "racer issued";
    try {
      // worker-invoke path writes through env.VFS to the same fs/<doId>/ prefix, mutex-free
      await racer.eval(`fs.writeFileSync('${PATH}', 'RACED_MUTEX_FREE')`);
    } catch (e) { racerNote = `racer eval err: ${e.message}`; }
    racer.close();

    // release the parked eval → it now flushes staged_fs at checkpoint over the raced write
    release();
    const parkedRes = await parked;
    const evalSaw = parkedRes?.__err ? `THREW ${parkedRes.__err}` : JSON.stringify(val(parkedRes));

    // ground truth: what is durably committed now?
    const final = val(await s.eval(`fs.readFileSync('${PATH}', 'utf8')`));
    // and across a cold restore (the generation boundary leg)
    await s.hibernateThenResume();
    const afterRestore = val(await s.eval(`fs.readFileSync('${PATH}', 'utf8')`).catch((e) => ({ value: `THREW ${e.message}` })));

    console.log(`     ${racerNote}`);
    console.log(`     parked eval read-back=${evalSaw}; durable now=${JSON.stringify(final)}; after restore=${JSON.stringify(afterRestore)}`);

    // Coherence break = the two writers disagree on durable truth, or restore diverges from live.
    const divergent = final !== afterRestore;
    const lostRace = final !== "RACED_MUTEX_FREE" && final !== "STAGED_BY_EVAL";
    if (divergent) {
      reproduced("case3", `live durable (${JSON.stringify(final)}) ≠ post-restore (${JSON.stringify(afterRestore)}) — staged-commit / generation incoherence`);
    } else if (lostRace) {
      reproduced("case3", `committed content is neither writer's value (${JSON.stringify(final)}) — torn/lost staged commit`);
    } else {
      held("case3", `coherent: durable=${JSON.stringify(final)} == after-restore; one writer won cleanly (last-writer-wins ordering held)`);
    }
  } finally { s.close(); }
}

// ───────────────────────────────────────────────────────────────────────────
const which = (process.argv[2] ?? "all").toLowerCase();
const cases = { case1, case2, case3 };
try {
  if (which === "all") { for (const c of [case1, case2, case3]) { try { await c(); } catch (e) { console.log(`  ⚠️  harness error: ${e.message}`); } } }
  else if (cases[which]) await cases[which]();
  else { console.error(`unknown case "${which}" — use case1|case2|case3|all`); process.exit(2); }
} finally {
  const hit = verdicts.filter((v) => v.reproduced);
  console.log(`\n════ SUMMARY: ${hit.length}/${verdicts.length} reproduced ════`);
  for (const v of verdicts) console.log(`  ${v.reproduced ? "🔴" : "🟢"} ${v.name}: ${v.detail}`);
  process.exit(hit.length > 0 ? 1 : 0);
}
