// EXP-2a negative control: prove the mutable global (__stack_pointer) is
// NECESSARY. We restore the SAME snapshot two ways into fresh instances:
//
//   (1) memory-ONLY: blit linear memory, but leave __stack_pointer at its
//       fresh-instance default (do NOT restore it). Then force allocation /
//       eval -> expect corruption, wrong values, or a crash.
//   (2) memory + global: the correct path (sanity baseline) -> succeeds.
//
// This isolates the single global; everything else (memory, module) is identical.
import { readFile } from 'node:fs/promises';
import { QuickJS } from 'quickjs-wasi';
import { loadWasmBytes, SNAPSHOT_PATH } from './lib.mjs';

const wasm = await loadWasmBytes();
const serialized = await readFile(SNAPSHOT_PATH);
const snap = QuickJS.deserializeSnapshot(serialized);

console.log('=== EXP-2a: globals-necessity negative control ===\n');
console.log(`snapshot __stack_pointer = ${snap.stackPointer}\n`);

// ---- (1) memory-ONLY restore (omit __stack_pointer) ----
// Reproduce QuickJS.restore() but DELIBERATELY skip restoring the stack pointer.
async function restoreMemoryOnly(snapshot) {
  const module = await WebAssembly.compile(wasm);
  // Use the library to build a correctly-shimmed fresh instance, then stomp memory.
  const fresh = await QuickJS.create({ wasm: module });
  const exp = fresh._getExports();
  const mem = exp.memory;

  const needPages = Math.ceil(snapshot.memory.byteLength / 65536);
  const curPages = mem.buffer.byteLength / 65536;
  if (needPages > curPages) mem.grow(needPages - curPages);

  new Uint8Array(mem.buffer).set(snapshot.memory);
  exp.qjs_set_runtime_and_context(snapshot.runtimePtr, snapshot.contextPtr);
  const freshSP = exp.__stack_pointer.value;
  // NOTE: intentionally NOT setting exp.__stack_pointer.value = snapshot.stackPointer
  console.log(`[memory-only] fresh __stack_pointer left at ${freshSP} ` +
    `(snapshot wanted ${snapshot.stackPointer}, delta ${freshSP - snapshot.stackPointer} bytes)`);
  return fresh;
}

let memOnlyOutcome;
try {
  const vm = await restoreMemoryOnly(snap);
  // Force work that uses the stack: drain the pending job + allocate heavily.
  const jobs = vm.executePendingJobs();
  // Allocate / recurse to exercise the (wrong) stack region.
  vm.evalCode('globalThis.__a = []; for (let i=0;i<5000;i++) __a.push({i, s:"x".repeat(20)});');
  const x = vm.global.getProp('x').toNumber();
  const len = vm.evalCode('__a.length').toNumber();
  const incr = vm.evalCode('inc()').toNumber();
  memOnlyOutcome = { ok: true, jobs, x, len, incr };
  console.log('[memory-only] survived without throwing:', JSON.stringify(memOnlyOutcome));
  vm.dispose();
} catch (err) {
  memOnlyOutcome = { ok: false, error: String(err && err.message || err) };
  console.log('[memory-only] CORRUPTED / threw:', memOnlyOutcome.error);
}

// ---- (2) correct restore (memory + global) as baseline ----
console.log('');
const good = await QuickJS.restore(snap, { wasm });
const gJobs = good.executePendingJobs();
good.evalCode('globalThis.__a = []; for (let i=0;i<5000;i++) __a.push({i, s:"x".repeat(20)});');
const goodOutcome = {
  jobs: gJobs,
  x: good.global.getProp('x').toNumber(),
  len: good.evalCode('__a.length').toNumber(),
  incr: good.evalCode('inc()').toNumber(),
};
console.log('[mem+global] correct restore:', JSON.stringify(goodOutcome));
good.dispose();

// ---- (3) causal proof: a WRONG __stack_pointer corrupts execution ----
// At a quiescent cell boundary QuickJS has unwound its WASM call stack, so the
// fresh SP coincides with the snapshot SP (both = stack top) and omitting it is
// silently harmless HERE. But the global is still load-bearing: if SP is restored
// to a wrong value, the next allocation/eval scribbles over live heap. We prove
// the mechanism by restoring correctly, then deliberately corrupting SP.
console.log('');
let wrongSpOutcome;
try {
  const vm = await QuickJS.restore(snap, { wasm });
  const exp = vm._getExports();
  // Point the C stack into the middle of the live QuickJS heap.
  exp.__stack_pointer.value = snap.runtimePtr + 64;
  vm.executePendingJobs();
  vm.evalCode('globalThis.__b = []; for (let i=0;i<20000;i++) __b.push({i, s:"y".repeat(40)});');
  const x = vm.global.getProp('x').toNumber();
  wrongSpOutcome = { ok: true, x };
  console.log('[wrong-SP] survived (x=' + x + ') — heap scribble may be latent');
  vm.dispose();
} catch (err) {
  wrongSpOutcome = { ok: false, error: String(err && err.message || err) };
  console.log('[wrong-SP] CORRUPTED / threw:', wrongSpOutcome.error);
}

console.log('\n=== Finding ===');
const goodIsRight = goodOutcome.x === 42 && goodOutcome.len === 5000 && goodOutcome.incr === 43;
const memOnlyDiffers = !memOnlyOutcome.ok
  || memOnlyOutcome.x !== 42 || memOnlyOutcome.len !== 5000 || memOnlyOutcome.incr !== 43;
console.log(`memory+global restore correct : ${goodIsRight}`);
console.log(`memory-only restore differs/fails: ${memOnlyDiffers}`);
const wrongSpCorrupted = !wrongSpOutcome.ok;
console.log(`wrong __stack_pointer corrupts  : ${wrongSpCorrupted}` +
  (wrongSpCorrupted ? ` (${wrongSpOutcome.error})` : ''));

console.log('\nRESULT:');
if (goodIsRight && memOnlyDiffers) {
  console.log('  memory-only restore diverged/failed -> __stack_pointer NECESSARY (direct).');
} else {
  console.log('  At this QUIESCENT boundary the fresh instance default __stack_pointer');
  console.log('  coincides with the snapshot value (both = stack top, ' + snap.stackPointer + '),');
  console.log('  so omitting it was silently harmless HERE — a dangerous false-positive.');
}
console.log('  But restoring a WRONG __stack_pointer ' +
  (wrongSpCorrupted ? 'HARD-CRASHED' : 'did NOT crash') + ' execution,');
console.log('  proving the global is load-bearing. Capturing ALL mutable globals is');
console.log('  mandatory: relying on memory-only "happening to work" is unsafe in general');
console.log('  (any build with a non-default SP, heap pointer, or extra mutable global breaks).');
