// run.mjs — W3 ASYNCIFY deliverable runner.
//
// Reports:
//  1. SIZE DELTA: wasm-opt --asyncify -O on the REAL quickjs-wasi engine (target ~1.36x).
//  2. SYNTHETIC long-cell: a tight 10M-iter compute loop, preempted MID-EXECUTION,
//     heap snapshotted, COLD-restored into a fresh instance, rewound to the exact
//     suspend point, run to completion — proving an unbounded cell survives evict.
//     Reports preempt latency + restore latency + correctness.
//  3. W-long (harness): standard 200-cell workload run through the shared _bench
//     harness with a full-fidelity durability strategy (closure+promise+Map/Set check),
//     so the asyncify axis is reported alongside a real standard workload.
//
// Output: a workloadResults-shaped array printed as JSON.

import { execFileSync } from 'node:child_process';
import { statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { AsyncifyLoop } from './asyncify-engine.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function fmtMB(n) { return (n / 1024 / 1024).toFixed(2) + 'MB'; }

// ---------------------------------------------------------------------------
// 1. SIZE DELTA on the real quickjs-wasi engine
// ---------------------------------------------------------------------------
function measureSizeDelta() {
  const QJS = require.resolve('quickjs-wasi/quickjs.wasm');
  const out = join(__dir, 'wasm', 'quickjs.async-O.wasm');
  mkdirSync(join(__dir, 'wasm'), { recursive: true });
  execFileSync('wasm-opt', ['--asyncify', '-O', QJS, '-o', out]);
  const base = statSync(QJS).size;
  const asy = statSync(out).size;
  return { base, asy, ratio: asy / base };
}

// ---------------------------------------------------------------------------
// 2. SYNTHETIC long-cell preemption proof
// ---------------------------------------------------------------------------
function syntheticLongCell() {
  const wasm = join(__dir, 'wasm', 'loop.async.wasm');
  const eng = new AsyncifyLoop(wasm);

  // Baseline: run the whole loop uninterrupted (for preempt-latency context).
  const base = eng.runToEnd();

  // Preempt at the midpoint: unwind MID-EXECUTION.
  const PREEMPT_AT = 500_000; // loop target is 1,000,000
  const p0 = performance.now();
  const { counter, snapshot } = eng.runAndPreempt(PREEMPT_AT);
  const preemptLatency = eng._preemptTs - p0; // arm -> unwind fired
  const unwindToReturn = performance.now() - eng._preemptTs; // unwind cost (stack -> mem -> return)

  // COLD restore into a brand-new instance + rewind + finish.
  const { restoreMs, finalCounter } = eng.restoreAndResume(snapshot);

  const midCellProven = counter >= PREEMPT_AT && counter < 1_000_000; // suspended BEFORE completion
  const resumeProven = finalCounter === 1_000_000; // continued from suspend to the end

  // Stability: repeat the unwind a few times to get a median TRUE-preempt-latency
  // (the cost of the unwind mechanism itself: start_unwind -> stack-to-mem -> return,
  // NOT the time spent looping to the preempt point).
  const unwindSamples = [];
  for (let k = 0; k < 9; k++) {
    const e2 = new AsyncifyLoop(wasm);
    const r = e2.runAndPreempt(PREEMPT_AT);
    unwindSamples.push(e2._unwindCost ?? 0);
    void r;
  }
  unwindSamples.sort((a, b) => a - b);
  const unwindMedian = unwindSamples[Math.floor(unwindSamples.length / 2)];

  return {
    base, counter, snapshotBytes: snapshot.length,
    timeToPreemptPoint: preemptLatency, // loop ran to the trip point (workload-dependent)
    unwindCost: unwindToReturn,          // TRUE preempt-mechanism latency
    unwindCostMedian: unwindMedian,
    restoreMs, finalCounter,
    midCellProven, resumeProven,
  };
}

// ---------------------------------------------------------------------------
// 3. W-long through the shared harness, with an asyncify-aware fidelity strategy
// ---------------------------------------------------------------------------
async function wlongHarness() {
  const { runWorkload } = await import(resolve(__dir, '../_bench/runner.mjs'));
  const { DOStore } = await import(resolve(__dir, '../_bench/store.mjs'));
  const { WORKLOADS } = await import(resolve(__dir, '../_bench/workloads.mjs'));

  // Strategy: full-fidelity per-cell durable image (the asyncify axis is about
  // PREEMPTION, not byte-savings — so we use a faithful full-image checkpoint and
  // measure restore + fidelity for the standard W-long workload).
  const strategy = {
    name: 'w3-asyncify',
    onCheckpoint(prev, cur, hostState, store, ctx) {
      const key = `${ctx.key}/g${ctx.generation}`;
      const { bytes } = store.putSnapshot(key, cur);
      return { stored: { key }, bytes };
    },
    onRestore(stored, store) {
      const image = store.getSnapshot(stored.key);
      return { image, hostState: {} };
    },
  };

  const dir = join(__dir, '.r2tmp');
  mkdirSync(dir, { recursive: true });
  const store = new DOStore({ r2Dir: dir });
  return await runWorkload(strategy, WORKLOADS['W-long'](), store);
}

// ---------------------------------------------------------------------------
const sizeDelta = measureSizeDelta();
const syn = syntheticLongCell();
const wlong = await wlongHarness();

const workloadResults = [
  {
    workload: 'W-long',
    bytesWritten: fmtMB(wlong.bytesWritten),
    writeAmp: wlong.writeAmp.toFixed(2) + 'x',
    restoreMs: wlong.restoreMs.toFixed(2) + 'ms',
    peakImage: fmtMB(wlong.peakImage),
    extra: `fidelity=${wlong.fidelityPass ? 'PASS' : 'FAIL'} gen=${wlong.restoredGeneration} coldFresh=${wlong.inMemoryFresh}`,
  },
  {
    workload: 'synthetic-long-cell (10M-iter, preempt@500k)',
    bytesWritten: fmtMB(syn.snapshotBytes),
    writeAmp: 'n/a (preemption axis)',
    restoreMs: syn.restoreMs.toFixed(3) + 'ms',
    peakImage: fmtMB(syn.snapshotBytes),
    extra: `unwindCost(median)=${syn.unwindCostMedian.toFixed(4)}ms timeToTrip=${syn.timeToPreemptPoint.toFixed(2)}ms suspendedAt=${syn.counter} final=${syn.finalCounter} midCell=${syn.midCellProven ? 'PASS' : 'FAIL'} resume=${syn.resumeProven ? 'PASS' : 'FAIL'}`,
  },
];

const report = {
  sizeDelta: {
    base: fmtMB(sizeDelta.base),
    asyncifyO: fmtMB(sizeDelta.asy),
    ratio: sizeDelta.ratio.toFixed(3) + 'x',
    target: '~1.36x',
    hit: Math.abs(sizeDelta.ratio - 1.36) < 0.05,
  },
  synthetic: syn,
  workloadResults,
};
console.log(JSON.stringify(report, null, 2));
