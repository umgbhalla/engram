// runner.mjs — runs a strategy through all 5 standard workloads and emits metrics.
//
// For each workload:
//   1. fresh Session.create()
//   2. eval cells; checkpoint (strategy.onCheckpoint) after EVERY cell (kernel per-cell durability)
//   3. at workload.evictAfter, force a GENUINE evict: dispose VM + drop in-mem host state,
//      then strategy.onRestore(...) -> cold-restore into a brand-new VM instance
//   4. continue remaining cells (with checkpoints)
//   5. eval workload.check, deep-compare to workload.expected -> fidelityPass
//
// Metrics per workload: bytesWritten, writeAmp (bytesWritten / heapDelta), restoreMs,
// peakImage (max raw heapImage bytes seen), fidelityPass.
//
// Usage:  node runner.mjs [strategyModulePath]    (default: ./strategies/full-dump.mjs)

import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOStore } from './store.mjs';
import { Session } from './session.mjs';
import { allWorkloads } from './workloads.mjs';

export async function runWorkload(strategy, workload, store) {
  store.resetCounters();
  const key = `${strategy.name}/${workload.name}`;
  const ctx = { key, generation: 0 };

  const sess = new Session();
  await sess.create();

  let prevImage = null;
  let peakImage = 0;
  let restoreMs = 0;
  let lastStored = null;
  let hostState = {}; // simulated host-side tool state (kv); workloads here don't mutate it
  let heapStart = sess.usedHeap();
  let heapPeak = heapStart;

  const checkpoint = () => {
    const img = sess.dump();
    if (img.byteLength > peakImage) peakImage = img.byteLength;
    ctx.generation++;
    const { stored } = strategy.onCheckpoint(prevImage, img, hostState, store, ctx);
    lastStored = stored;
    prevImage = img;
  };

  for (let i = 0; i < workload.cells.length; i++) {
    sess.eval(workload.cells[i]);
    const uh = sess.usedHeap();
    if (uh > heapPeak) heapPeak = uh;
    checkpoint();

    if (i + 1 === workload.evictAfter) {
      // GENUINE evict: dispose VM, drop in-memory host state entirely.
      sess.dispose();
      hostState = null;
      prevImage = null; // a cold process would not retain the prev image either

      const t0 = performance.now();
      const { image, hostState: hs } = strategy.onRestore(lastStored, store, ctx);
      await sess.restore(image);
      restoreMs = performance.now() - t0;
      hostState = hs ?? {};
      prevImage = image;
    }
  }

  // fidelity gate
  let fidelityPass = false;
  let got = null;
  try {
    got = sess.eval(workload.check);
    fidelityPass = got === workload.expected;
  } catch (e) {
    got = 'ERR:' + e.message;
  }
  const inMemoryFresh = sess.generation > 1; // proves a genuine restore happened

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
    peakImage,
    heapDelta,
    fidelityPass,
    restoredGeneration: sess.generation,
    inMemoryFresh,
    got: fidelityPass ? undefined : { got, expected: workload.expected },
  };
}

export async function runAll(strategy, { r2Dir } = {}) {
  const dir = r2Dir || join(tmpdir(), `engram-bench-${strategy.name}-${Date.now()}`);
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

export function printTable({ strategy, results }) {
  const cols = ['workload', 'bytesWritten', 'writeAmp', 'restoreMs', 'peakImage', 'fidelity'];
  const rows = results.map((r) => [
    r.workload,
    fmtBytes(r.bytesWritten),
    r.writeAmp.toFixed(2) + 'x',
    r.restoreMs.toFixed(1) + 'ms',
    fmtBytes(r.peakImage),
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

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const stratPath = process.argv[2] || './strategies/full-dump.mjs';
  const mod = await import(stratPath);
  const strategy = mod.default || mod.fullDump || Object.values(mod).find((v) => v && v.onCheckpoint);
  if (!strategy) { console.error('no strategy export found in', stratPath); process.exit(1); }
  const out = await runAll(strategy);
  printTable(out);
  console.log('\nr2Dir:', out.r2Dir);
  console.log(JSON.stringify(out.results, null, 2));
}
