// Phase B: FRESH process (no cell-1 source ever evaluated here). Read snapshot
// from disk, restore into a brand-new WASM instance, drain pending jobs (the
// promise fires -> x becomes 42), then eval cell 2 `inc()` (closure -> x=43).
import { readFile } from 'node:fs/promises';
import { QuickJS } from 'quickjs-wasi';
import { loadWasmBytes, SNAPSHOT_PATH } from './lib.mjs';

const wasm = await loadWasmBytes();
const serialized = await readFile(SNAPSHOT_PATH);

const snap = QuickJS.deserializeSnapshot(serialized);

const tR0 = performance.now();
const vm = await QuickJS.restore(snap, { wasm });
const tR1 = performance.now();

// Right after restore, BEFORE draining: x should be the pre-snapshot 41,
// proving the pending promise has NOT yet run.
const xAtRestore = vm.global.getProp('x').toNumber();

// Drain the pending microtask job queue. The surviving `.then()` callback runs.
const jobsDrained = vm.executePendingJobs();
const xAfterDrain = vm.global.getProp('x').toNumber();

// Cell 2: invoke the closure `inc` that was defined in cell 1 (never replayed).
const incResult = vm.evalCode('inc()').toNumber();
const xFinal = vm.global.getProp('x').toNumber();

vm.dispose();

process.stdout.write(JSON.stringify({
  restoreMs: +(tR1 - tR0).toFixed(3),
  xAtRestore,
  jobsDrained,
  xAfterDrain,
  incResult,
  xFinal,
}));
