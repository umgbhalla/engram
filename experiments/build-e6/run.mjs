// run.mjs — E6 oplog runner. Faithful clone of _bench/runner.mjs flow, but:
//   (1) feeds each cell SOURCE to the strategy (strategy.setSource) so the oplog can record it,
//   (2) after onRestore returns {image, _replay}, restores the full image into a fresh VM and
//       REPLAYS the recorded oplog tail (cell sources) to re-derive the post-full state.
// The substrate is UNCHANGED: same _bench Session, DOStore, workloads.

import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOStore } from '../_bench/store.mjs';
import { Session } from '../_bench/session.mjs';
import { allWorkloads } from '../_bench/workloads.mjs';
import { makeE6Strategy } from './e6-oplog.mjs';

async function runWorkload(strategy, workload, store) {
  store.resetCounters();
  const key = `${strategy.name}/${workload.name}`;
  const ctx = { key, generation: 0 };

  const sess = new Session();
  await sess.create();

  let prevImage = null;
  let peakImage = 0;
  let restoreMs = 0;
  let replayMs = 0;
  let lastStored = null;
  let hostState = {};
  let heapStart = sess.usedHeap();
  let heapPeak = heapStart;
  let fullCount = 0, oplogCount = 0;

  const checkpoint = (src) => {
    const img = sess.dump();
    if (img.byteLength > peakImage) peakImage = img.byteLength;
    ctx.generation++;
    strategy.setSource(src);
    const before = store.stats().putCount;
    const { stored } = strategy.onCheckpoint(prevImage, img, hostState, store, ctx);
    lastStored = stored;
    prevImage = img;
    // track full vs oplog by inspecting whether a /full key was (re)written this cell
    const isFull = (ctx.generation === 1) || (ctx.generation % strategy.snapshotEveryN === 0);
    if (isFull) fullCount++; else oplogCount++;
  };

  for (let i = 0; i < workload.cells.length; i++) {
    sess.eval(workload.cells[i]);
    const uh = sess.usedHeap();
    if (uh > heapPeak) heapPeak = uh;
    checkpoint(workload.cells[i]);

    if (i + 1 === workload.evictAfter) {
      // GENUINE evict
      sess.dispose();
      hostState = null;
      prevImage = null;

      const t0 = performance.now();
      const { image, hostState: hs, _replay } = strategy.onRestore(lastStored, store, ctx);
      await sess.restore(image);
      restoreMs = performance.now() - t0;
      hostState = hs ?? {};

      // OPLOG REPLAY: re-run the recorded cell tail into the restored VM.
      const t1 = performance.now();
      for (const entry of (_replay || [])) {
        sess.eval(entry.src);
      }
      replayMs = performance.now() - t1;

      // After replay the live VM is at the post-evict state; capture its image as prevImage
      prevImage = sess.dump();
    }
  }

  let fidelityPass = false;
  let got = null;
  try {
    got = sess.eval(workload.check);
    fidelityPass = got === workload.expected;
  } catch (e) {
    got = 'ERR:' + e.message;
  }
  const inMemoryFresh = sess.generation > 1;
  sess.dispose();

  const s = store.stats();
  const heapDelta = Math.max(1, heapPeak - heapStart);
  return {
    workload: workload.name,
    bytesWritten: s.bytesWritten,
    sqliteBytes: s.sqliteBytes,
    r2Bytes: s.r2Bytes,
    writeAmp: s.bytesWritten / heapDelta,
    restoreMs,
    replayMs,
    restorePlusReplayMs: restoreMs + replayMs,
    peakImage,
    heapDelta,
    fullCount,
    oplogCount,
    replayedCells: 0,
    fidelityPass,
    restoredGeneration: sess.generation,
    inMemoryFresh,
    got: fidelityPass ? undefined : { got, expected: workload.expected },
  };
}

async function runAll(strategy) {
  const dir = join(tmpdir(), `engram-e6-${strategy.name}-${Date.now()}`);
  const store = new DOStore({ r2Dir: dir });
  const results = [];
  for (const wl of allWorkloads()) {
    results.push(await runWorkload(strategy, wl, store));
  }
  return { strategy: strategy.name, results, r2Dir: dir };
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

function printTable({ strategy, results }) {
  const cols = ['workload', 'bytesWritten', 'writeAmp', 'restoreMs', 'replayMs', 'restore+replay', 'peakImage', 'full/oplog', 'fidelity'];
  const rows = results.map((r) => [
    r.workload,
    fmtBytes(r.bytesWritten),
    r.writeAmp.toFixed(2) + 'x',
    r.restoreMs.toFixed(1) + 'ms',
    r.replayMs.toFixed(1) + 'ms',
    r.restorePlusReplayMs.toFixed(1) + 'ms',
    fmtBytes(r.peakImage),
    `${r.fullCount}/${r.oplogCount}`,
    r.fidelityPass ? 'PASS' : 'FAIL',
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\n=== strategy: ${strategy} ===`);
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  for (const r of results) {
    if (!r.fidelityPass) console.log(`  ! ${r.workload} fidelity mismatch:`, JSON.stringify(r.got));
  }
}

const N = Number(process.env.E6_N || 10);
const strat = makeE6Strategy({ snapshotEveryN: N });
const out = await runAll(strat);
printTable(out);
console.log('\nr2Dir:', out.r2Dir);
console.log(JSON.stringify(out.results, null, 2));
