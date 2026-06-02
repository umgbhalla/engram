// run.mjs — GAP 1 proof: E6 oplog with RECORDED HOST-CALL RESULTS => exactly-once.
//
// Stresses the E6 "recorded-host-call-result slot" that the 5 standard workloads leave
// untested. Workload: 20 cells, each does ONE side-effecting host call (host.kvIncrement)
// which bumps an EXTERNAL tally living OUTSIDE the VM (a plain host-side counter — the
// stand-in for a real network side effect like host.fetch POST or host.kv.increment).
//
// E6 strategy:
//   * FULL SNAPSHOT every N cells (heap image via the shared DOStore, gzip+kernel-routed).
//   * OPLOG between fulls: each entry = { seq, src, hostResults:[...] } where hostResults
//     is the ORDERED list of values returned by every host call that cell made, LIVE.
//   * CRASH mid-window (after cell 13) — VM gone, in-mem host bridge gone.
//   * RESTORE = load last full (<= seq 13's full boundary), restore VM, then REPLAY the
//     oplog tail. During replay the host dispatcher is in REPLAY MODE: it returns the
//     RECORDED result for each call IN ORDER and DOES NOT touch the external tally.
//
// PROOF: external tally must equal the number of cells that actually executed LIVE
// (20 total cells, but the ones in the replayed tail must NOT re-fire). We assert the
// external tally == 20 exactly — never 26 (double-fire of replayed window) and never 7
// (lost the window). The VM-side mirror (a JS counter the cell also keeps) must reach 20
// too, proving replay rebuilt VM state correctly while side effects fired exactly once.

import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextEncoder, TextDecoder } from 'node:util';
import { DOStore } from '../_bench/store.mjs';
import { HostSession } from './host-session.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- The external side-effect target (lives entirely OUTSIDE the VM) ----
// In the real kernel this is a network POST / DO SQLite row / KV counter. Here it is a
// plain object so we can count fires unambiguously.
function makeExternalKV() {
  return {
    tally: 0,
    fireLog: [],            // records every LIVE increment for forensics
    increment(by = 1) { this.tally += by; this.fireLog.push(this.tally); return this.tally; },
  };
}

// ---- The E6 oplog strategy with recorded host-call results ----
function makeE6({ snapshotEveryN = 10 }) {
  return {
    name: `e6-hostcall-N${snapshotEveryN}`,
    snapshotEveryN,
    // checkpoint after a cell. `cellRecord` = { src, hostResults:[...] } captured this cell.
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
      // OPLOG: append { seq, src, hostResults } to meta.
      const prev = store.getRaw(`${baseKey}/meta`);
      const meta = prev ? JSON.parse(dec.decode(prev)) : { fullKey: `${baseKey}/full`, fullSeq: 1, oplog: [] };
      meta.oplog.push({ seq, src: cellRecord.src, hostResults: cellRecord.hostResults });
      const mb = enc.encode(JSON.stringify(meta));
      store.putRaw(`${baseKey}/meta`, mb);
      return { bytes: mb.byteLength, isFull: false };
    },
    onRestore(baseKey, store) {
      const meta = JSON.parse(dec.decode(store.getRaw(`${baseKey}/meta`)));
      const image = store.getSnapshot(meta.fullKey);
      return { image, oplog: meta.oplog, fullSeq: meta.fullSeq };
    },
  };
}

async function run({ totalCells = 20, crashAfter = 13, snapshotEveryN = 5 } = {}) {
  const dir = join(tmpdir(), `imp-oplog-hostcall-${Date.now()}`);
  const store = new DOStore({ r2Dir: dir });
  const strat = makeE6({ snapshotEveryN });
  const key = strat.name;
  const ctx = { key, generation: 0 };

  const kv = makeExternalKV();

  // Build the 20 cells. Each cell: call host.kvIncrement() (side-effecting), store the
  // returned value into a VM-side array, and maintain a VM-side mirror counter `n`.
  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    cells.push(`globalThis.results = globalThis.results || []; globalThis.results.push(host.kvIncrement()); globalThis.n = globalThis.results.length;`);
  }

  const sess = new HostSession({ tools: ['kvIncrement'] });
  await sess.create();

  // --- LIVE dispatcher: fires the external side effect, records result into current cell.
  let recording = null; // array collecting host-call results for the cell being evaluated
  let mode = 'live';
  // replay state:
  let replayQueue = null;     // array of recorded results for the current replayed cell
  let replayIdx = 0;

  sess.setDispatch((name, args) => {
    if (mode === 'live') {
      if (name !== 'kvIncrement') throw new Error('unknown tool ' + name);
      const r = kv.increment(1);       // <-- the REAL side effect (external tally bumps)
      recording.push(r);               // record for the oplog
      return r;
    } else { // replay
      // RETURN RECORDED RESULT, DO NOT FIRE. This is the exactly-once guarantee.
      if (!replayQueue || replayIdx >= replayQueue.length) {
        throw new Error('replay underflow: more host calls than recorded for this cell');
      }
      return replayQueue[replayIdx++];
    }
  });

  // helper: live-eval one cell, capturing host-call results, then checkpoint.
  const liveCell = (i) => {
    recording = [];
    sess.eval(cells[i]);
    ctx.generation++;
    const img = sess.dump();
    strat.onCheckpoint(img, { src: cells[i], hostResults: recording.slice() }, store, ctx);
  };

  // === PHASE 1: run cells 0..crashAfter-1 LIVE, checkpointing each ===
  for (let i = 0; i < crashAfter; i++) liveCell(i);

  const tallyAtCrash = kv.tally;            // should be == crashAfter (13)
  const fireCountAtCrash = kv.fireLog.length;

  // === CRASH: VM evaporates mid-window (after cell 13, before cell 14). ===
  sess.dispose();

  // === PHASE 2: RESTORE = last full + oplog replay (NO re-fire) ===
  const t0 = performance.now();
  const { image, oplog, fullSeq } = strat.onRestore(key, store);
  await sess.restore(image);              // re-binds __hostCall (REQUIRED)
  // switch to replay mode and re-run the recorded oplog tail
  mode = 'replay';
  let replayedCells = 0;
  for (const entry of oplog) {
    replayQueue = entry.hostResults;
    replayIdx = 0;
    sess.eval(entry.src);
    if (replayIdx !== replayQueue.length) {
      throw new Error(`replay mismatch cell seq=${entry.seq}: consumed ${replayIdx} of ${replayQueue.length}`);
    }
    replayedCells++;
  }
  const restoreMs = performance.now() - t0;
  const tallyAfterReplay = kv.tally;       // MUST be unchanged from tallyAtCrash (replay no-fire)

  // === PHASE 3: continue LIVE for the remaining cells (crashAfter..totalCells-1) ===
  mode = 'live';
  for (let i = crashAfter; i < totalCells; i++) liveCell(i);

  // === ASSERTIONS ===
  const vmN = sess.eval('globalThis.n');                 // VM-side cell counter
  const vmResultsLen = sess.eval('globalThis.results.length');
  const vmLast = sess.eval('globalThis.results[globalThis.results.length-1]');
  sess.dispose();

  const finalTally = kv.tally;

  return {
    snapshotEveryN, totalCells, crashAfter, fullSeq,
    tallyAtCrash, fireCountAtCrash,
    replayedCells, oplogTailLen: oplog.length,
    tallyAfterReplay,
    finalTally, vmN, vmResultsLen, vmLast,
    restoreMs: +restoreMs.toFixed(2),
    fireLog: kv.fireLog,
    storeStats: store.stats(),
  };
}

const r = await run({ totalCells: 20, crashAfter: 13, snapshotEveryN: 5 });

const PASS = (cond, msg) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
console.log('\n=== GAP 1 — E6 host-call exactly-once proof ===');
console.log(JSON.stringify({
  totalCells: r.totalCells, crashAfter: r.crashAfter, snapshotEveryN: r.snapshotEveryN,
  fullSeqUsedForRestore: r.fullSeq, oplogTailReplayed: r.oplogTailLen, replayedCells: r.replayedCells,
  tallyAtCrash: r.tallyAtCrash, tallyAfterReplay: r.tallyAfterReplay, finalTally: r.finalTally,
  vmN: r.vmN, vmResultsLen: r.vmResultsLen, vmLastValue: r.vmLast, restoreMs: r.restoreMs,
}, null, 2));
console.log('fireLog (every LIVE external increment, in order):', JSON.stringify(r.fireLog));
console.log('');
PASS(r.tallyAtCrash === 13, `external tally at crash == 13 (got ${r.tallyAtCrash})`);
PASS(r.tallyAfterReplay === 13, `external tally UNCHANGED by replay == 13 (got ${r.tallyAfterReplay}) — replayed ${r.replayedCells} cells fired ZERO side effects`);
PASS(r.finalTally === 20, `external tally == 20 exactly (got ${r.finalTally}); NOT 26 (double-fire) NOT 7`);
PASS(r.vmN === 20, `VM-side counter rebuilt to 20 (got ${r.vmN}) — replay restored VM state`);
PASS(r.vmResultsLen === 20, `VM results array length == 20 (got ${r.vmResultsLen})`);
PASS(r.vmLast === 20, `VM last recorded host-result == 20 (got ${r.vmLast}) — recorded values match live`);
PASS(r.fireLog.length === 20, `exactly 20 LIVE fires total (got ${r.fireLog.length})`);
PASS(JSON.stringify(r.fireLog) === JSON.stringify([...Array(20)].map((_, i) => i + 1)),
  `fire order is 1..20 with NO duplicate/gap (proves no double-fire of replayed window)`);
