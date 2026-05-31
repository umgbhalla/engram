// Phase A: fresh VM, eval cell 1 (var + closure + PENDING promise), snapshot
// memory + ALL mutable globals to disk. Does NOT drain the promise — we want
// the pending job to survive into the restored instance.
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { QuickJS } from 'quickjs-wasi';
import { loadWasmBytes, CELL_1, SNAPSHOT_PATH } from './lib.mjs';

const wasm = await loadWasmBytes();
const vm = await QuickJS.create({ wasm });

// Eval cell 1. The .then() callback is now a PENDING microtask job.
vm.evalCode(CELL_1);

// Sanity: x must still be 41 (promise NOT yet drained), inc is a closure.
const xBefore = vm.global.getProp('x').toNumber();
const jobsPending = vm.evalCode('typeof p').toString(); // p exists
if (xBefore !== 41) throw new Error(`pre-snapshot x expected 41, got ${xBefore}`);

// This build exports exactly ONE mutable global: __stack_pointer (verified via
// WebAssembly.Module.exports). snapshot() captures it + linear memory, which is
// the complete mutable state for this module.
const tSnap0 = performance.now();
const snap = vm.snapshot(); // { memory, stackPointer, runtimePtr, contextPtr, extensions }
const serialized = QuickJS.serializeSnapshot(snap);
const tSnap1 = performance.now();

const gz = gzipSync(serialized);
await writeFile(SNAPSHOT_PATH, serialized);

vm.dispose();

const result = {
  xBefore,
  pType: jobsPending,
  stackPointer: snap.stackPointer,
  runtimePtr: snap.runtimePtr,
  contextPtr: snap.contextPtr,
  memoryBytes: snap.memory.byteLength,
  rawBytes: serialized.byteLength,
  gzipBytes: gz.byteLength,
  snapshotMs: +(tSnap1 - tSnap0).toFixed(3),
};
process.stdout.write(JSON.stringify(result));
