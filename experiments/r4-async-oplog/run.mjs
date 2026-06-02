// run.mjs — RESIDUAL 1: ASYNC host-call inside the E6 oplog-replay window.
//
// GAP1 proved SYNC host calls fire exactly-once across the crash boundary. Async was
// explicitly unstressed. This experiment closes that:
//
//   * Cells do an ASYNC effectful host call: `await host.fetch(...)` that bumps an
//     EXTERNAL tally (the stand-in for a network POST / KV increment living OUTSIDE the
//     VM) and resolves to a value the cell awaits.
//   * E6 strategy: FULL snapshot every N cells + an OPLOG of { seq, src, hostResults }
//     where hostResults is the ORDERED list of RESOLVED async values for that cell.
//   * CRASH mid-window. RESTORE = last full snapshot + replay the oplog tail in REPLAY
//     mode: the host returns the RECORDED resolved value (as a pre-resolved promise) and
//     DOES NOT re-issue the async effect. The awaiting continuation resumes with the
//     recorded value.
//
//   * CONCURRENCY: some cells issue Promise.all([host.fetch(a), host.fetch(b),
//     host.fetch(c)]) — 3 concurrent in-flight async calls. We assert the recorded order
//     is preserved across the crash boundary and replay reproduces it exactly.
//
// PROOF (exactly-once + ordering):
//   - external tally == number of LIVE host calls only (replay fires ZERO).
//   - fireLog has no duplicate/gap (no double-fire of the replayed window).
//   - VM state rebuilt to the same totals as a no-crash run.
//   - Promise.all result arrays in the replayed cells match the recorded order.

import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextEncoder, TextDecoder } from 'node:util';
import { DOStore } from '../_bench/store.mjs';
import { AsyncSession } from './async-session.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- External async side-effect target (lives entirely OUTSIDE the VM) ----
function makeExternalKV() {
  return {
    tally: 0,
    fireLog: [],
    // The "async network effect": bump the tally, return next value. In a real kernel
    // this is an awaited fetch POST whose server-side write is the side effect.
    fire(tag) { this.tally += 1; this.fireLog.push({ tag, tally: this.tally }); return this.tally; },
  };
}

// ---- E6 oplog strategy with recorded ASYNC host-call results ----
function makeE6({ snapshotEveryN }) {
  return {
    name: `r4-async-e6-N${snapshotEveryN}`,
    snapshotEveryN,
    onCheckpoint(curImage, cellRecord, store, ctx) {
      const seq = ctx.generation;
      const baseKey = ctx.key;
      const isFull = (seq === 1) || (seq % snapshotEveryN === 0);
      if (isFull) {
        const fullKey = `${baseKey}/full`;
        const res = store.putSnapshot(fullKey, curImage);
        const meta = { fullKey, fullSeq: seq, oplog: [] };
        store.putRaw(`${baseKey}/meta`, enc.encode(JSON.stringify(meta)));
        return { bytes: res.bytes, isFull: true };
      }
      const prev = store.getRaw(`${baseKey}/meta`);
      const meta = prev ? JSON.parse(dec.decode(prev))
                        : { fullKey: `${baseKey}/full`, fullSeq: 1, oplog: [] };
      meta.oplog.push({ seq, src: cellRecord.src, hostResults: cellRecord.hostResults });
      const mb = enc.encode(JSON.stringify(meta));
      store.putRaw(`${baseKey}/meta`, mb);
      return { bytes: mb.byteLength, isFull: false };
    },
    onRestore(baseKey, store) {
      const meta = JSON.parse(dec.decode(store.getRaw(`${baseKey}/meta`)));
      return { image: store.getSnapshot(meta.fullKey), oplog: meta.oplog, fullSeq: meta.fullSeq };
    },
  };
}

// ---- Cell templates ----
// Single async await cell: one host call, awaited, value*10 accumulated.
function singleCell(i) {
  return `globalThis.acc = globalThis.acc || 0;
globalThis.log = globalThis.log || [];
(async () => {
  const r = await host.fetch(${JSON.stringify('single#' + i)});
  globalThis.acc += r;
  globalThis.log.push(r);
  globalThis.n = (globalThis.n||0) + 1;
})();`;
}
// Concurrent cell: Promise.all of 3 in-flight async host calls; record their ordered values.
function concurrentCell(i) {
  return `globalThis.acc = globalThis.acc || 0;
globalThis.log = globalThis.log || [];
globalThis.allLog = globalThis.allLog || [];
(async () => {
  const rs = await Promise.all([
    host.fetch(${JSON.stringify('c' + i + '.a')}),
    host.fetch(${JSON.stringify('c' + i + '.b')}),
    host.fetch(${JSON.stringify('c' + i + '.c')}),
  ]);
  globalThis.allLog.push(rs);          // ordered triple
  for (const r of rs) { globalThis.acc += r; globalThis.log.push(r); }
  globalThis.n = (globalThis.n||0) + 1;
})();`;
}

async function run({ totalCells = 16, crashAfter = 11, snapshotEveryN = 5 } = {}) {
  const dir = join(tmpdir(), `r4-async-oplog-${Date.now()}`);
  const store = new DOStore({ r2Dir: dir });
  const strat = makeE6({ snapshotEveryN });
  const key = strat.name;
  const ctx = { key, generation: 0 };

  const kv = makeExternalKV();

  // Mix single and concurrent cells. Make cells 3, 7, 9 concurrent (triple host calls)
  // so the crash window (cells 5..10 with crashAfter=11, N=5 -> full at seq 10) contains a
  // concurrent cell that must replay with preserved ordering.
  const concurrentIdx = new Set([3, 7, 9, 12, 14]);
  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    cells.push(concurrentIdx.has(i) ? { kind: 'concurrent', src: concurrentCell(i) }
                                    : { kind: 'single', src: singleCell(i) });
  }

  const sess = new AsyncSession({ tools: ['fetch'] });
  await sess.create();

  let recording = null;   // ordered host-call results captured this cell (LIVE)
  let mode = 'live';
  let replayQueue = null, replayIdx = 0;

  sess.setDispatch((name, args) => {
    if (name !== 'fetch') throw new Error('unknown tool ' + name);
    if (mode === 'live') {
      const tag = args[0];
      const r = kv.fire(tag);     // <-- REAL async effect (external tally bumps)
      recording.push(r);          // record resolved value in issue order
      return r;
    } else { // replay: return RECORDED value, fire NOTHING
      if (!replayQueue || replayIdx >= replayQueue.length) {
        throw new Error('replay underflow: more host calls than recorded for this cell');
      }
      return replayQueue[replayIdx++];
    }
  });

  const liveCell = (i) => {
    recording = [];
    sess.evalCell(cells[i].src);
    ctx.generation++;
    const img = sess.dump();
    strat.onCheckpoint(img, { src: cells[i].src, hostResults: recording.slice() }, store, ctx);
  };

  // === PHASE 1: LIVE through cells 0..crashAfter-1 ===
  for (let i = 0; i < crashAfter; i++) liveCell(i);
  const tallyAtCrash = kv.tally;
  const fireCountAtCrash = kv.fireLog.length;
  const accAtCrash = sess.read('globalThis.acc');
  const nAtCrash = sess.read('globalThis.n');

  // === CRASH: VM + host bridge evaporate mid-window ===
  sess.dispose();

  // === PHASE 2: RESTORE = last full + oplog replay (REPLAY mode, no re-fire) ===
  const t0 = performance.now();
  const { image, oplog, fullSeq } = strat.onRestore(key, store);
  await sess.restore(image);
  mode = 'replay';
  let replayedCells = 0;
  const replayAllLogSeen = [];
  for (const entry of oplog) {
    replayQueue = entry.hostResults;
    replayIdx = 0;
    sess.evalCell(entry.src);
    if (replayIdx !== replayQueue.length) {
      throw new Error(`replay mismatch seq=${entry.seq}: consumed ${replayIdx} of ${replayQueue.length}`);
    }
    replayedCells++;
  }
  const restoreMs = performance.now() - t0;
  const tallyAfterReplay = kv.tally;     // MUST equal tallyAtCrash (replay no-fire)
  const accAfterReplay = sess.read('globalThis.acc');
  const nAfterReplay = sess.read('globalThis.n');

  // === PHASE 3: continue LIVE for remaining cells ===
  mode = 'live';
  for (let i = crashAfter; i < totalCells; i++) liveCell(i);

  // === Read final VM state ===
  const vmN = sess.read('globalThis.n');
  const vmAcc = sess.read('globalThis.acc');
  const vmLogLen = sess.read('globalThis.log.length');
  const vmAllLog = sess.read('JSON.stringify(globalThis.allLog)');
  sess.dispose();

  // === GROUND TRUTH: a no-crash run for comparison ===
  const truth = await noCrashRun({ totalCells, snapshotEveryN, concurrentIdx });

  return {
    snapshotEveryN, totalCells, crashAfter, fullSeq,
    tallyAtCrash, fireCountAtCrash, accAtCrash, nAtCrash,
    replayedCells, oplogTailLen: oplog.length, tallyAfterReplay, accAfterReplay, nAfterReplay,
    finalTally: kv.tally, vmN, vmAcc, vmLogLen,
    vmAllLog: JSON.parse(vmAllLog),
    fireLog: kv.fireLog,
    restoreMs: +restoreMs.toFixed(2),
    truth,
  };
}

// A clean run with NO crash — establishes the ground-truth final state.
async function noCrashRun({ totalCells, snapshotEveryN, concurrentIdx }) {
  const kv = makeExternalKV();
  const sess = new AsyncSession({ tools: ['fetch'] });
  await sess.create();
  let recording = null;
  sess.setDispatch((name, args) => { const r = kv.fire(args[0]); recording.push(r); return r; });
  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    cells.push(concurrentIdx.has(i) ? concurrentCell(i) : singleCell(i));
  }
  for (let i = 0; i < totalCells; i++) { recording = []; sess.evalCell(cells[i]); }
  const out = {
    tally: kv.tally,
    n: sess.read('globalThis.n'),
    acc: sess.read('globalThis.acc'),
    logLen: sess.read('globalThis.log.length'),
    allLog: JSON.parse(sess.read('JSON.stringify(globalThis.allLog)')),
  };
  sess.dispose();
  return out;
}

// crashAfter=14, N=5 -> last full at seq 10; oplog tail = cells 11,12,13 (seq 11..13).
// Cell 12 is concurrent (Promise.all of 3) so the REPLAY tail re-runs a concurrent batch
// across the crash boundary — the core async-ordering stress.
const r = await run({ totalCells: 16, crashAfter: 14, snapshotEveryN: 5 });

const PASS = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); return cond; };
console.log('\n=== RESIDUAL 1 — ASYNC host-call exactly-once across E6 oplog replay ===');
console.log(JSON.stringify({
  totalCells: r.totalCells, crashAfter: r.crashAfter, snapshotEveryN: r.snapshotEveryN,
  fullSeqUsedForRestore: r.fullSeq, oplogTailReplayed: r.oplogTailLen, replayedCells: r.replayedCells,
  tallyAtCrash: r.tallyAtCrash, tallyAfterReplay: r.tallyAfterReplay, finalTally: r.finalTally,
  groundTruthTally: r.truth.tally,
  vmN: r.vmN, vmAcc: r.vmAcc, truthN: r.truth.n, truthAcc: r.truth.acc,
  restoreMs: r.restoreMs,
}, null, 2));
console.log('fireLog tags (every LIVE async fire, in order):');
console.log('  ' + r.fireLog.map(e => e.tag).join(' '));
console.log('replayed-window concurrent triples (VM allLog):', JSON.stringify(r.vmAllLog));
console.log('ground-truth concurrent triples           :', JSON.stringify(r.truth.allLog));
console.log('');

const results = [];
results.push(PASS(r.tallyAfterReplay === r.tallyAtCrash,
  `external tally UNCHANGED by replay (${r.tallyAtCrash} -> ${r.tallyAfterReplay}): replayed ${r.replayedCells} cells fired ZERO async effects`));
results.push(PASS(r.finalTally === r.truth.tally,
  `final external tally == ground-truth (${r.finalTally} == ${r.truth.tally}): exactly-once, no double-fire/no-loss`));
// no duplicate/gap in fire order
const expectedTags = (() => {
  // reconstruct: live cells 0..10 then 11..15, all fired once in order; build from truth count
  return r.fireLog.length;
})();
const fireTags = r.fireLog.map(e => e.tag);
const noDup = new Set(fireTags).size === fireTags.length;
results.push(PASS(noDup, `fireLog has NO duplicate tag (${fireTags.length} unique fires) — replayed window did NOT re-fire`));
results.push(PASS(r.fireLog.length === r.truth.tally,
  `exactly ${r.truth.tally} LIVE fires total (got ${r.fireLog.length})`));
results.push(PASS(r.vmN === r.truth.n, `VM cell-counter rebuilt to ground-truth (${r.vmN} == ${r.truth.n})`));
results.push(PASS(r.vmAcc === r.truth.acc, `VM acc (sum of awaited values) == ground-truth (${r.vmAcc} == ${r.truth.acc}) — continuations resumed with recorded values`));
// ordering: replayed concurrent triples must match ground-truth byte-for-byte
const allLogMatch = JSON.stringify(r.vmAllLog) === JSON.stringify(r.truth.allLog);
results.push(PASS(allLogMatch, `Promise.all concurrent triples match ground-truth ORDER exactly across crash boundary`));
// each triple is strictly increasing (issue order preserved within the concurrent batch)
const triplesOrdered = r.vmAllLog.every(t => t[0] < t[1] && t[1] < t[2]);
results.push(PASS(triplesOrdered, `each concurrent triple is in issue order (a<b<c) — 3 in-flight calls ordered deterministically`));

const allPass = results.every(Boolean);
console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(allPass ? 0 : 1);
