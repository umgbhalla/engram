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
//   telemetry: the DEPLOYED kernel does NOT echo sizeRaw/usedHeap to the client (they read
//         0.0MB live). NO precondition in this harness trusts them — spikes/pins are
//         confirmed by in-VM readback (`__b.length`, fill-byte samples, a fresh-alloc
//         pressure probe). If a precondition can't be confirmed, the case THROWS a harness
//         error instead of emitting a false 🟢 held.

import { Engram } from "../../packages/sdk/dist/index.mjs";
const { default: WebSocket } = await import("ws");

const url = process.env.ENGRAM_URL ?? "wss://engram.umgbhalla.xyz";
// ENGRAM_KERNEL_KEY is often EMPTY in a fresh shell (it lives in repo .env, not the shell env).
// Fall back to .env so runs don't silently send an empty token (-> 401 "kernel down" red herring).
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
const tag = () => `chaos-${Math.floor(performance.now())}-${Math.floor(performance.timeOrigin)}`;
const verdicts = [];
function reproduced(name, detail) { console.log(`\n  🔴 REPRODUCED — ${name}\n     ${detail}`); verdicts.push({ name, reproduced: true, detail }); }
function held(name, detail) { console.log(`\n  🟢 not reproduced (guard held) — ${name}\n     ${detail}`); verdicts.push({ name, reproduced: false, detail }); }
async function connect(t, config = {}, timeoutMs) {
  // ConnectOptions.timeoutMs (packages/sdk/src/index.ts, default 60000) is the per-frame wire
  // timeout — it also bounds hibernateThenResume()'s cold-restore touch eval.
  // bare engram-kernel wants kernelKey (/ws?id=&apiKey=<kernelKey>); `apiKey` routes to the cloud
  // /connect supervisor path and the handshake hangs. See MEMORY: "SDK kernelKey not apiKey over wss".
  return Engram.connect({ url, kernelKey: apiKey, session: `${t}-${tag()}`, WebSocket, config, ...(timeoutMs ? { timeoutMs } : {}) });
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
  // 120s wire timeout: the 46MB-spike checkpoint + the cold restore of a big base are slow.
  const s = await connect("c1", {}, 120_000);
  try {
    // durable canary established BEFORE the spike — must survive
    await s.eval(`globalThis.canary = { id: 'c1-canary', n: 12345, arr: [1,2,3] }`);

    // Cell 1: prime high-water-mark ~46MB single native alloc (< 64MB grow cap, no trip).
    // CALIBRATION FIX: the deployed kernel does NOT echo sizeRaw/usedHeap (read 0.0MB live),
    // so we confirm the spike landed by IN-VM READBACK — length + fill-byte samples — not telemetry.
    const SPIKE = 46 * MB;
    const c1 = await s.eval(
      `globalThis.__b = new Uint8Array(${SPIKE}); __b.fill(7);
       [__b.length, __b[0], __b[${SPIKE >> 1}], __b[${SPIKE - 1}]]`,
      { timeoutMs: 120_000 },
    );
    const [len, b0, bMid, bEnd] = Array.isArray(val(c1)) ? val(c1) : [];
    if (len !== SPIKE || b0 !== 7 || bMid !== 7 || bEnd !== 7) {
      throw new Error(`case1 PRECONDITION FAILED — 46MB spike did not land (readback ${JSON.stringify(val(c1))}); case not exercised`);
    }
    console.log(`     spike alloc CONFIRMED by readback -> __b.length=${(len/MB).toFixed(1)}MB, fill bytes 7/7/7`);

    // Memory-pressure probe: a SECOND real allocation on top of the live 46MB spike. Its
    // success is a genuine signal the linear buffer grew past the spike high-water-mark
    // (an alloc-success readback, not a trusted size counter).
    const probe = await s.eval(
      `{ const p = new Uint8Array(4*1024*1024); p.fill(3); p[p.length - 1] }`,
      { timeoutMs: 120_000 },
    );
    if (val(probe) !== 3) {
      throw new Error(`case1 PRECONDITION FAILED — pressure probe alloc did not land (got ${JSON.stringify(val(probe))})`);
    }
    console.log(`     pressure probe -> +4MB alloc succeeded on top of live spike (high-water ≥ ~50MB)`);

    // Cell 2: free
    await s.eval(`globalThis.__b = null; 1`);

    // Cell 3: force GC + settle to tiny used_heap → this checkpoint is the one that ADMITS
    // the ~46MB-high-water W4 base. (sizeRaw/usedHeap intentionally NOT read — see header note.)
    const c3 = await s.eval(`(globalThis.gc?.(), globalThis.canary.n)`);
    console.log(`     settle commit -> committed=${c3.ok !== false} (admits the ~${(SPIKE/MB).toFixed(0)}MB high-water base)`);

    // Now the bomb: genuine cold restore from that committed high-water base
    const { restoreSource, generation } = await s.hibernateThenResume();
    console.log(`     cold restore -> source=${restoreSource} gen=${generation}`);

    // Did the acked-durable canary survive the restore?
    const after = await s.eval(`globalThis.canary?.n ?? null`).catch((e) => ({ __err: e.message }));
    if (after?.__err) {
      reproduced("case1", `cold restore THREW / lost session after committing a readback-confirmed ~46MB-high-water base: ${after.__err}`);
    } else if (val(after) !== 12345) {
      reproduced("case1", `canary LOST across restore (got ${JSON.stringify(val(after))}, expected 12345) from a readback-confirmed ~46MB-high-water admitted base`);
    } else {
      held("case1", `canary survived (n=12345) restore=${restoreSource}; readback-confirmed ~46MB-high-water base instantiated OK this run`);
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
  // CALIBRATION FIX: 21 sequential evals each checkpointing over a 9MB pinned heap blew the
  // default 60s wire timeout → 180s via ConnectOptions.timeoutMs (also bounds the
  // hibernateThenResume restore touch); the pin cell additionally gets EvalOptions.timeoutMs.
  const s = await connect("c2", {}, 180_000);
  try {
    // pin usedHeap > 8MB SQLITE_HOT_MAX so the rollover base spills to R2.
    // Pin confirmed by IN-VM READBACK (big.length) — sizeRaw/usedHeap are NOT echoed by the
    // deployed kernel (read 0.0MB live), so the R2-spill itself is NOT client-observable;
    // we can only confirm the >8MB precondition that forces it.
    const PIN = 9 * MB;
    const pinned = val(await s.eval(
      `globalThis.big = new Uint8Array(${PIN}).fill(1); globalThis.acc = []; big.length`,
      { timeoutMs: 180_000 },
    ));
    if (pinned !== PIN) {
      throw new Error(`case2 PRECONDITION FAILED — 9MB pin did not land (big.length=${JSON.stringify(pinned)}); case not exercised`);
    }
    const BASE_EVERY = 20;
    for (let i = 0; i <= BASE_EVERY; i++) {
      await s.eval(`acc.push({ i: ${i}, blob: big.slice(0, 1024) }); globalThis.last = acc.length; last`);
    }
    const pre = val(await s.eval(`acc.length`));
    console.log(`     drove ${BASE_EVERY + 1} non-idempotent cells over rollover; acc.length=${pre}; pin confirmed=${(pinned/MB).toFixed(0)}MB (R2 spill forced, not client-observable)`);

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
    // CALIBRATION FIX (the real harness bug): the old racer used `racer.eval(...)`, which
    // TAKES the kernel eval mutex (lib.rs "eval" arm acquires self.mutex) — it queued BEHIND
    // the parked frame and timed out instead of racing it. Mutex-free dispatch paths per
    // apps/kernel/src/lib.rs:2196-2229:
    //   - vfs-write/vfs-read/vfs-ls/vfs-stat: serviced directly against R2 + fs_files,
    //     "These arms do NOT acquire self.mutex" — fully mutex-free AND land in the SAME
    //     fs/<doId>/ + fs_files namespace the eval's staged flush targets. ← USED HERE
    //     (SDK: s.writeFile -> {t:"vfs-write"}).
    //   - sandbox (s.sandbox.exec): the exec itself is mutex-free, BUT a container write goes
    //     direct-to-R2 via s3fs with NO fs_files row — invisible to the eval's namespace until
    //     vfs-sync, and vfs-sync ACQUIRES the mutex (would deadlock behind the parked frame).
    //     Not usable as an observable racer while the eval is parked.
    //   - worker-invoke (s.registerWorker/s.invokeWorker via env.VFS): the dispatch arm is
    //     mutex-free, but worker_invoke acquires the mutex for its post-invoke fs_files
    //     reconcile (lib.rs:2213-2215) — it would block behind the parked frame too.
    // So vfs-write is the ONLY fully mutex-free commit path observable in the eval's fs view.
    // Drive it via a fresh transport on the SAME session (the SDK WS transport allows one
    // in-flight frame per socket, and s's socket is occupied by the parked eval).
    const racer = await Engram.connect({ url, kernelKey: apiKey, session: s.session ?? undefined, WebSocket });
    let racerNote = "racer vfs-write committed (mutex-free)";
    let racerOk = true;
    try {
      // s.writeFile -> {t:"vfs-write"} frames: direct R2 + fs_files commit, no eval mutex.
      await racer.writeFile(PATH, "RACED_MUTEX_FREE", { timeoutMs: 15_000 });
    } catch (e) { racerOk = false; racerNote = `racer vfs-write err: ${e.message}`; }
    racer.close();

    // release the parked eval → it now flushes staged_fs at checkpoint over the raced write
    release();
    const parkedRes = await parked;
    const evalSaw = parkedRes?.__err ? `THREW ${parkedRes.__err}` : JSON.stringify(val(parkedRes));

    // If the mutex-free racer write never landed, the race was NOT exercised — throw a
    // harness error rather than emit a false 🟢 held. (A timeout here would mean the path
    // was NOT mutex-free after all — that itself is worth surfacing, not hiding.)
    if (!racerOk) {
      throw new Error(`case3 NOT EXERCISED — ${racerNote}; the parked frame was released but no mutex-free write raced it`);
    }

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
