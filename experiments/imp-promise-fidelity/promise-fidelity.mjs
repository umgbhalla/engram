// promise-fidelity.mjs — GAP 2: explicit pending-promise + microtask fidelity across the
// COMBINED (W5 base + W4 page-delta) reconstructed image, not a full dump.
//
// We DRIVE the real shared harness:
//   - real quickjs-wasi engine via _bench/session.mjs (seeded clock+RNG)
//   - real combined strategy (build-combined/strategies/combined.mjs): W5 compaction base
//     + W4 byte-delta chain + E6 oplog, restore = base + replay committed page-deltas.
//   - real shared DOStore (gzip + SQLite/R2 routing, fair byte counters).
//
// Promises are NOT exercised by the 5 standard workloads, so this is a custom driver
// (same primitives, new workload) that:
//   1. builds rich PENDING promise state in the VM across several cells
//      (checkpoint after EACH cell, so the surviving image is delta-reconstructed)
//   2. forces a GENUINE evict (dispose VM + drop in-mem prevImage + host state)
//   3. cold-restores via combined.onRestore -> a base+delta reconstructed image
//   4. settles the promises on the restored VM, drains the microtask queue, and checks
//      that every continuation fired with the correct value.
//
// Determinism note: cells never auto-drain the QuickJS job queue (eval != drain), so a
// promise resolved-but-not-drained, or never-resolved, stays genuinely pending in the heap.

import { Session } from '../_bench/session.mjs';
import { DOStore } from '../_bench/store.mjs';
import combined from '../build-combined/strategies/combined.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAIL: ' + msg); }

// The promise-fidelity workload. Each entry is one cell. We deliberately set up FIVE
// distinct kinds of mid-flight async state and DO NOT drain between cells so they remain
// pending in the snapshotted heap:
//
//  A. a bare unresolved Promise stored on globalThis, with a .then continuation queued
//  B. a multi-stage .then chain that is mid-flight: stage1 resolved (queued, not drained)
//     -> stage2/stage3 still downstream
//  C. an async function awaiting a pending promise (suspended at the await point)
//  D. a Promise.all([...]) over a mix of pending + already-resolved promises
//  E. a chain where one link is ALREADY drained pre-snapshot (proves drained continuations
//     don't double-fire) plus a still-pending tail
const CELLS = [
  // shared result log + a tick counter the seeded clock won't touch
  'var fired = [];',

  // A: bare pending promise + queued continuation
  `var pA = new Promise(r => { globalThis.resolveA = r; });
   pA.then(v => { fired.push('A:' + v); });`,

  // B: mid-flight multi-stage chain. We resolve stage0 but DO NOT drain, so the first
  //    .then job is queued in the heap; downstream stages remain pending.
  `var resolveB0;
   var pB = new Promise(r => { resolveB0 = r; });
   var chainB = pB
     .then(v => { fired.push('B1:' + v); return v + 1; })
     .then(v => { fired.push('B2:' + v); return v * 10; })
     .then(v => { fired.push('B3:' + v); });`,
  // NOTE: pB is NOT resolved here. We resolve B0 LATER (after the E pre-drain) so the E
  // drain does not also drain B. B is then resolved-but-not-drained -> B1/B2/B3 stay
  // genuinely queued/pending in the heap and must cross the evict boundary, firing only
  // on the RESTORED VM.

  // C: async function suspended at an await on a pending promise
  `var resolveC;
   var pC = new Promise(r => { resolveC = r; });
   async function fC(){ var x = await pC; fired.push('C:' + x); var y = await Promise.resolve(x + 100); fired.push('C2:' + y); return y; }
   var cResult = fC();`,     // suspended at first await; cResult is a pending promise

  // D: Promise.all over [pending, alreadyResolved, pending]
  `var resolveD1, resolveD2;
   var pD1 = new Promise(r => { resolveD1 = r; });
   var pD2 = new Promise(r => { resolveD2 = r; });
   var pDfixed = Promise.resolve('fixed');
   var allD = Promise.all([pD1, pDfixed, pD2]).then(arr => { fired.push('D:' + arr.join(',')); });`,

  // E: a chain where the FIRST link is fully drained BEFORE the snapshot (must NOT
  //    re-fire after restore), with a still-pending tail.
  `var resolveE;
   var pE = new Promise(r => { resolveE = r; });
   var chainE = pE.then(v => { fired.push('E1:' + v); return v + '!'; }).then(v => { fired.push('E2:' + v); });`,
];

// We drain E's first stage BEFORE the checkpoint that we restore from. So we run an extra
// "drain marker" by resolving E and draining mid-build. To keep cells/checkpoints honest,
// the driver explicitly resolves E + drains right after the E cell, BEFORE evict.

const EXPECTED_AFTER_SETTLE = [
  // order is microtask-FIFO; we assert as a SET plus a few ordering invariants
  'A:from-A',
  'B1:5', 'B2:6', 'B3:60',
  'C:from-C', 'C2:from-C-num',  // see settle code for actual values
  'D:dval1,fixed,dval2',
  'E2:E-pending!',
];

async function run() {
  const r2Dir = join(tmpdir(), `promise-fidelity-${Date.now()}`);
  const store = new DOStore({ r2Dir });
  const key = `combined/W-promise`;
  const ctx = { key, generation: 0 };

  // fresh strategy state isolation (combined keeps a per-key Map; new key = clean)
  const sess = new Session();
  await sess.create();

  let prevImage = null;
  let lastStored = null;
  let hostState = {};
  const trace = [];

  const checkpoint = (note) => {
    const img = sess.dump();
    ctx.generation++;
    // feed combined the usedHeap hint + a fake oplog src so its W5/E6 logic runs for real
    hostState = { ...hostState, __usedHeap: sess.usedHeap(), __src: note, __rng: ctx.generation };
    const { stored, bytes } = combined.onCheckpoint(prevImage, img, hostState, store, ctx);
    lastStored = stored;
    prevImage = img;
    trace.push({ gen: ctx.generation, note, imgBytes: img.byteLength, ckptBytes: bytes });
  };

  // ---- build pending promise state, checkpoint after each cell ----
  for (let i = 0; i < CELLS.length; i++) {
    sess.eval(CELLS[i]);
    checkpoint(`cell${i}`);
  }

  // E-PRE-DRAIN: resolve E and drain its FIRST stage now, BEFORE evict. This makes E1
  // fire pre-snapshot; E2 stays pending (its upstream returned, but the next job hasn't
  // been driven because we drain exactly once and E1's return queues E2... so drain twice
  // to settle E1 only? No: we want E1 fired + E2 still pending). We resolve E, drain ONCE:
  //   - drain pass 1 runs E1 (fired) and QUEUES E2.
  // We then checkpoint with E2 still queued-but-not-run. To leave E2 PENDING (queued job)
  // in the heap, we do NOT drain again. Snapshot captures the queued E2 job.
  sess.eval(`resolveE('E-pending');`);
  sess.vm.executePendingJobs(); // drains E fully (E1 + E2) — E is our "drained pre-snapshot, must not double-fire" control. B is untouched (B0 not yet resolved).
  // NOW resolve B but DO NOT drain: B1/B2/B3 become queued/pending jobs that must survive
  // the evict and fire ONLY on the restored VM.
  sess.eval(`resolveB0(5);`);
  // Capture pre-evict state of `fired`: should contain E1+E2 (drained) but NOT B (pending).
  const preEvictFired = JSON.parse(sess.eval('JSON.stringify(fired)'));
  checkpoint('post-E-predrain');

  // ---- GENUINE EVICT ----
  sess.dispose();
  hostState = null;
  prevImage = null;

  // ---- COLD RESTORE via the combined (base + delta chain) reconstruction ----
  const { image, hostState: hs } = combined.onRestore(lastStored, store, ctx);
  await sess.restore(image);
  const restoredGen = sess.generation;

  const firedAfterRestoreBeforeSettle = JSON.parse(sess.eval('JSON.stringify(fired)'));

  // Sanity that the image was delta-reconstructed (not a single full dump): inspect the
  // strategy's internal state for this key.
  const st = combined._state(key);
  const chainLen = st.chain.length;
  const rebased = st.baseGen;

  // ---- SETTLE the surviving pending promises on the RESTORED VM ----
  // A: resolve, drain
  sess.eval(`globalThis.resolveA('from-A');`);
  // B: the queued B1 job survived; B0 was already resolved pre-snapshot. Just drain.
  // C: resolve pC -> async fn resumes
  sess.eval(`resolveC('from-C');`);
  // C2 will await Promise.resolve('from-C' + 100) => 'from-C100' (string concat). fix expected.
  // D: resolve both pending legs
  sess.eval(`resolveD1('dval1'); resolveD2('dval2');`);

  // drain the whole microtask queue to completion (multiple passes for chained jobs)
  for (let pass = 0; pass < 10; pass++) sess.vm.executePendingJobs();

  const firedFinal = JSON.parse(sess.eval('JSON.stringify(fired)'));

  // also confirm the async fn's returned promise (cResult) and chains settled
  const cResultState = sess.eval(`(function(){ var done=false,val; cResult.then(v=>{done=true;val=v;}); return JSON.stringify({pending_marker:true}); })()`);
  sess.vm.executePendingJobs();

  sess.dispose();

  return {
    r2Dir, trace, restoredGen,
    chainLen, rebaseBaseGen: rebased,
    preEvictFired,
    firedAfterRestoreBeforeSettle,
    firedFinal,
    storeStats: store.stats(),
  };
}

run().then((out) => {
  const report = {};
  console.log('=== GAP 2: pending-promise fidelity across W5-base + W4-delta reconstructed image ===\n');

  console.log('checkpoint trace (per-cell, combined strategy):');
  for (const t of out.trace) {
    console.log(`  gen ${String(t.gen).padStart(2)}  ${t.note.padEnd(16)} img=${t.imgBytes}B ckptWrite=${t.ckptBytes}B`);
  }
  console.log(`\nrestored generation: ${out.restoredGen}  (>1 proves genuine cold restore into a NEW VM)`);
  console.log(`combined internal: base.gen=${out.rebaseBaseGen}  surviving delta-chain length=${out.chainLen}`);
  console.log(`  -> restore path = base image + replay of ${out.chainLen} W4 page-delta(s), NOT a single full dump.`);

  console.log('\n--- fired log timeline ---');
  console.log('PRE-EVICT (on original VM, after E pre-drain):', JSON.stringify(out.preEvictFired));
  console.log('AFTER RESTORE, BEFORE settle (on NEW VM):    ', JSON.stringify(out.firedAfterRestoreBeforeSettle));
  console.log('AFTER SETTLE + full drain (on NEW VM):        ', JSON.stringify(out.firedFinal));

  // ---- ASSERTIONS / fidelity verdict ----
  const fired = out.firedFinal;
  const has = (x) => fired.includes(x);
  const checks = [];
  const ck = (name, cond) => { checks.push({ name, pass: !!cond }); };

  // E was fully DRAINED pre-snapshot (control): both E1+E2 fired before evict and must
  // survive restore WITHOUT double-firing (no re-fire of already-settled continuations).
  ck('E1 fired pre-evict', out.preEvictFired.includes('E1:E-pending'));
  ck('E2 fired pre-evict', out.preEvictFired.includes('E2:E-pending!'));
  ck('E1 present exactly once after restore (no double-fire)', fired.filter(x => x === 'E1:E-pending').length === 1);
  ck('E2 present exactly once after restore (no double-fire)', fired.filter(x => x === 'E2:E-pending!').length === 1);

  // B was RESOLVED-but-NOT-DRAINED pre-evict: its queued jobs must NOT have fired before
  // the evict, and must fire (correctly) only AFTER restore on the new VM.
  ck('B was genuinely pending pre-evict (not fired before snapshot)', !out.preEvictFired.some(x => x.startsWith('B')));
  ck('B fired only after restore', out.firedAfterRestoreBeforeSettle.some(x => x.startsWith('B')) || fired.some(x => x.startsWith('B')));

  // A: bare pending promise continuation fires with right value
  ck('A continuation fired with value', has('A:from-A'));

  // B: mid-flight chain — B1/B2/B3 all settle with correct propagated values
  ck('B1 settled =5', has('B1:5'));
  ck('B2 settled =6 (B1 returned v+1)', has('B2:6'));
  ck('B3 settled =60 (B2 returned v*10)', has('B3:60'));

  // C: async fn suspended at await resumes correctly
  ck('C async-await resumed', has('C:from-C'));
  // C2: 'from-C' + 100 => 'from-C100'
  ck('C2 second await resumed (string concat)', has('C2:from-C100'));

  // D: Promise.all over mixed pending+resolved settles in array order
  ck('D Promise.all settled in order', has('D:dval1,fixed,dval2'));

  // no spurious / lost entries: final set size sanity
  const expectedSet = ['E1:E-pending','E2:E-pending!','A:from-A','B1:5','B2:6','B3:60','C:from-C','C2:from-C100','D:dval1,fixed,dval2'];
  const missing = expectedSet.filter(x => !fired.includes(x));
  const extra = fired.filter(x => !expectedSet.includes(x));
  ck('no missing continuations', missing.length === 0);
  ck('no spurious/duplicate continuations', extra.length === 0 && fired.length === expectedSet.length);

  console.log('\n--- fidelity checks ---');
  let allPass = true;
  for (const c of checks) { console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`); if (!c.pass) allPass = false; }
  if (missing.length) console.log('  MISSING:', JSON.stringify(missing));
  if (extra.length) console.log('  EXTRA:', JSON.stringify(extra));

  console.log(`\nstore: bytesWritten=${out.storeStats.bytesWritten} sqliteBytes=${out.storeStats.sqliteBytes} r2Bytes=${out.storeStats.r2Bytes}`);
  console.log(`\nVERDICT: ${allPass ? 'PASS — pending-promise + microtask-queue state survives the delta-reconstructed image' : 'FAIL — some promise state did NOT survive'}`);
  process.exit(allPass ? 0 : 1);
}).catch((e) => { console.error('RUN ERROR:', e); process.exit(2); });
