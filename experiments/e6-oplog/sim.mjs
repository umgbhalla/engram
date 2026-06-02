// EXPEDITION 6 — Golem-style oplog-compaction hybrid prototype.
// Compares two durability schemes for an Engram-style live-heap REPL kernel:
//   A) BASELINE: full heap snapshot (serialize + gzip) after EVERY cell.
//   B) HYBRID:   full snapshot every N cells; between snapshots, append a small
//                OPLOG of (cell source + recorded host-call results). Restore =
//                load last full snapshot + replay the oplog cells.
//
// We measure per scheme: total bytes written, write-amplification, restore latency,
// and the monotonic high-water-mark / dump-ceiling behaviour.
//
// Run: node sim.mjs

import { QuickJS } from './node_modules/quickjs-wasi/dist/index.js';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const WASM = readFileSync(new URL('./node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
const wasmModule = await WebAssembly.compile(WASM);

// ---------------------------------------------------------------------------
// Host-call boundary. The kernel exposes a deterministic host function `hostCall`
// (stands in for time/random/fetch). In the HYBRID scheme we RECORD every host
// result so replay is faithful (no re-firing of side effects, no nondeterminism).
// ---------------------------------------------------------------------------
function makeHostState() {
  return { counter: 1000 }; // deterministic monotonic source
}

// A recording host: returns a value AND logs it. On replay we feed the log back.
function installHost(vm, recorder /* {mode:'record'|'replay', log:[], idx} */) {
  const fn = vm.newFunction('hostCall', function (argHandle) {
    const arg = vm.dump(argHandle);
    let result;
    if (recorder.mode === 'replay') {
      result = recorder.log[recorder.idx++];
    } else {
      // live: deterministic effect, but RECORD it (simulates fetch/time/random)
      result = recorder.hostState.counter++;
      recorder.log.push(result);
    }
    return vm.newNumber(result);
  });
  vm.global.setProp('hostCall', fn);
}

// ---------------------------------------------------------------------------
// Workload: 50 cells. Mix of: pure compute, state accumulation (grows heap),
// host calls (side effects), and a couple of big allocations to exercise the
// high-water-mark.
// ---------------------------------------------------------------------------
function makeCells(n) {
  const cells = [];
  // bootstrap state
  cells.push(`globalThis.store = []; globalThis.acc = 0; globalThis.log = [];`);
  for (let i = 1; i < n; i++) {
    if (i % 10 === 0) {
      // periodic big growth — push a chunk of strings (grows linear memory)
      cells.push(`for (let k=0;k<2000;k++){ store.push("row-"+${i}+"-"+k+"-"+Math.random.toString()); } store.length;`);
    } else if (i % 3 === 0) {
      // host call (side effect, recorded)
      cells.push(`log.push(hostCall(${i})); acc += log[log.length-1]; acc;`);
    } else {
      // pure accumulation
      cells.push(`acc += ${i}; store.push({i:${i}, v:acc}); store.length;`);
    }
  }
  return cells.slice(0, n);
}

function snapBytes(vm) {
  const snap = vm.snapshot();
  const raw = QuickJS.serializeSnapshot(snap);
  const gz = gzipSync(raw, { level: 6 });
  return { raw: raw.length, gz: gz.length, gzBuf: gz, rawBuf: raw, usedHeap: vm.getMemoryUsage().memoryUsedSize, bufBytes: snap.memory.length };
}

async function runBaseline(cells) {
  const recorder = { mode: 'record', log: [], hostState: makeHostState() };
  const vm = await QuickJS.create(wasmModule);
  installHost(vm, recorder);
  let totalGz = 0, totalRaw = 0;
  const snapshots = []; // we keep the last for a restore-latency probe
  let lastGz = null, lastRaw = null, lastHwm = 0;
  for (let i = 0; i < cells.length; i++) {
    vm.evalCode(cells[i]);
    vm.executePendingJobs();
    const s = snapBytes(vm); // FULL DUMP EVERY CELL
    totalGz += s.gz; totalRaw += s.raw;
    lastGz = s.gz; lastRaw = s.raw; lastHwm = s.bufBytes;
    lastSnapPayload = s;
  }
  var lastSnapPayload;
  const finalState = vm.dump(vm.evalCode('acc'));
  vm.dispose();
  return { totalGz, totalRaw, perCellGz: lastGz, finalState, hwm: lastHwm, recorder };
}

async function runHybrid(cells, N) {
  const recorder = { mode: 'record', log: [], hostState: makeHostState() };
  const vm = await QuickJS.create(wasmModule);
  installHost(vm, recorder);
  let totalGz = 0, totalRaw = 0;
  let oplogBytes = 0;
  let lastFullGz = null, lastFullRaw = null, lastFullBuf = null, lastFullCellIdx = -1;
  let lastFullHostLogLen = 0;
  const oplogSinceFull = []; // {src, hostResults:[]}
  let finalState;
  for (let i = 0; i < cells.length; i++) {
    const hostLenBefore = recorder.log.length;
    vm.evalCode(cells[i]);
    vm.executePendingJobs();
    if (i % N === 0) {
      // FULL SNAPSHOT checkpoint
      const s = snapBytes(vm);
      totalGz += s.gz; totalRaw += s.raw;
      lastFullGz = s.gz; lastFullRaw = s.rawBuf; lastFullBuf = s.bufBytes;
      lastFullCellIdx = i;
      lastFullHostLogLen = recorder.log.length;
      oplogSinceFull.length = 0;
    } else {
      // append to OPLOG: cell source + the host results it produced
      const hostResults = recorder.log.slice(hostLenBefore);
      const entry = { src: cells[i], hostResults };
      oplogSinceFull.push(entry);
      // oplog is written as gzipped JSON append (small)
      const enc = gzipSync(Buffer.from(JSON.stringify(entry)), { level: 6 });
      totalGz += enc.length;
      totalRaw += JSON.stringify(entry).length;
      oplogBytes += enc.length;
    }
  }
  finalState = vm.dump(vm.evalCode('acc'));
  vm.dispose();
  return { totalGz, totalRaw, oplogBytes, finalState, lastFullRaw, lastFullCellIdx, oplogTail: oplogSinceFull.slice(), recorder, hwm: lastFullBuf, lastFullHostLogLen };
}

// Restore-latency probe: hybrid = restore last full + replay oplog tail.
async function restoreHybrid(h) {
  const t0 = performance.now();
  const snap = QuickJS.deserializeSnapshot(h.lastFullRaw);
  const vm = await QuickJS.restore(snap, wasmModule);
  // replay: install a REPLAY host fed by the recorded results in the oplog tail
  const replayLog = [];
  for (const e of h.oplogTail) for (const r of e.hostResults) replayLog.push(r);
  const recorder = { mode: 'replay', log: replayLog, idx: 0 };
  installHost(vm, recorder);
  for (const e of h.oplogTail) {
    vm.evalCode(e.src);
    vm.executePendingJobs();
  }
  const state = vm.dump(vm.evalCode('acc'));
  const t1 = performance.now();
  vm.dispose();
  return { ms: t1 - t0, state };
}

async function restoreBaseline(payloadRaw) {
  const t0 = performance.now();
  const snap = QuickJS.deserializeSnapshot(payloadRaw);
  const vm = await QuickJS.restore(snap, wasmModule);
  const state = vm.dump(vm.evalCode('acc'));
  const t1 = performance.now();
  vm.dispose();
  return { ms: t1 - t0, state };
}

// ---------------------------------------------------------------------------
const NCELLS = 50;
const cells = makeCells(NCELLS);

console.log(`# EXP-6 oplog-compaction hybrid — ${NCELLS} cells\n`);

const base = await runBaseline(cells);
// capture a final baseline snapshot raw for restore probe
{
  const recorder = { mode: 'record', log: [], hostState: makeHostState() };
  const vm = await QuickJS.create(wasmModule);
  installHost(vm, recorder);
  for (const c of cells) { vm.evalCode(c); vm.executePendingJobs(); }
  const raw = QuickJS.serializeSnapshot(vm.snapshot());
  vm.dispose();
  base._finalRaw = raw;
}

const results = {};
for (const N of [5, 10, 25]) {
  const h = await runHybrid(cells, N);
  const r = await restoreHybrid(h);
  results[N] = { h, r };
}
const baseRestore = await restoreBaseline(base._finalRaw);

const KB = (b) => (b / 1024).toFixed(1) + 'KB';
const MB = (b) => (b / 1024 / 1024).toFixed(2) + 'MB';

console.log('## Baseline (full dump every cell)');
console.log(`  final acc state:      ${base.finalState}`);
console.log(`  total bytes written:  ${MB(base.totalGz)} gz  (${MB(base.totalRaw)} raw)`);
console.log(`  per-cell snapshot gz: ${KB(base.perCellGz)}`);
console.log(`  high-water buffer:    ${MB(base.hwm)}`);
console.log(`  restore latency:      ${baseRestore.ms.toFixed(2)}ms  -> acc=${baseRestore.state}`);
console.log(`  ↳ writes 50 full snapshots; write-amp = 50× last-snapshot\n`);

console.log('## Hybrid (full every N cells + oplog between)');
for (const N of [5, 10, 25]) {
  const { h, r } = results[N];
  const numFulls = Math.ceil(NCELLS / N);
  const writeAmpVsHybridFloor = (h.totalGz / base.perCellGz).toFixed(1);
  const savingVsBaseline = (100 * (1 - h.totalGz / base.totalGz)).toFixed(1);
  console.log(`  N=${N}  (${numFulls} full snapshots, oplog between)`);
  console.log(`    total bytes written: ${MB(h.totalGz)} gz  (${MB(h.totalRaw)} raw)`);
  console.log(`    of which oplog gz:   ${KB(h.oplogBytes)}`);
  console.log(`    savings vs baseline: ${savingVsBaseline}% fewer bytes`);
  console.log(`    write-amp vs 1 snap: ${writeAmpVsHybridFloor}× (baseline = ${(base.totalGz/base.perCellGz).toFixed(1)}×)`);
  console.log(`    restore latency:     ${r.ms.toFixed(2)}ms (deserialize+restore+replay ${h.oplogTail.length} oplog cells)  -> acc=${r.state}`);
  console.log(`    correctness:         ${r.state === base.finalState ? 'MATCH ✓' : 'MISMATCH ✗ (' + r.state + ' vs ' + base.finalState + ')'}`);
}

console.log('\n## High-water-mark / dump-ceiling note');
console.log(`  Monotonic WASM buffer at session end: ${MB(base.hwm)} (identical for both schemes — heap is the same live heap).`);
console.log(`  Hybrid does NOT shrink the buffer; it reduces WRITE volume + write-amp.`);
console.log(`  The dump-ceiling (a single full snapshot still ~${KB(base.perCellGz)} gz / ${MB(base.hwm)} raw buffer) is`);
console.log(`  UNCHANGED per full-snapshot event — hybrid just makes those events rarer.`);
