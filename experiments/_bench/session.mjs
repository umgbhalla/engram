// session.mjs — QuickJS session driver + the pluggable STRATEGY interface.
//
// A "session" wraps a single QuickJS VM with the determinism controls the kernel uses
// (seeded clock + seeded RNG via WASI overrides) and exposes:
//
//   create()                  -> fresh VM
//   eval(src)                 -> run a cell, return host-dumped value (sync, like kernel global eval)
//   dump()  -> heapImage      -> serialized VM snapshot bytes (raw, uncompressed)
//   restore(heapImage)        -> rebuild a fresh VM from a heapImage (genuine new instance)
//   usedHeap()                -> QuickJS used-heap bytes (the kernel's size-admission metric)
//   bufferBytes()             -> WASM linear-memory byteLength (monotonic high-water-mark)
//   dispose()                 -> tear down the VM (simulates eviction)
//
// heapImage == QuickJS.serializeSnapshot(vm.snapshot()) — a versioned binary buffer that
// already contains the FULL linear memory. Strategies decide what subset of it to persist.
//
// ---- STRATEGY INTERFACE (the contract every parallel build must implement) ----
//
//   const strategy = {
//     name: 'full-dump',
//     // Called when the session checkpoints. Receives:
//     //   prevImage : Uint8Array|null  — the heapImage from the PREVIOUS checkpoint (for deltas), null on first
//     //   curImage  : Uint8Array       — the heapImage from the CURRENT VM state
//     //   hostState : object           — opaque host-side state to persist alongside the heap (kv tools etc.)
//     //   store     : DOStore          — the shared store (count bytesWritten through it)
//     //   ctx       : { key, generation } — stable session key + monotonic checkpoint counter
//     // Returns { stored, bytes } where `stored` is whatever opaque token onRestore needs.
//     onCheckpoint(prevImage, curImage, hostState, store, ctx) { ... return { stored, bytes }; },
//
//     // Called on cold-restore. Receives the token from the LATEST onCheckpoint + the store.
//     // Must return { image, hostState } — `image` is a heapImage byte-identical to the
//     // curImage that was checkpointed (full fidelity required), hostState round-tripped.
//     onRestore(stored, store, ctx) { ... return { image, hostState }; },
//   };
//
// Fairness note: ALL strategies share ONE DOStore and ONE session driver. The only thing
// that varies is what bytes a strategy chooses to write/read. See README.md.

import { QuickJS } from 'quickjs-wasi';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WASM_PATH = require.resolve('quickjs-wasi/quickjs.wasm');
const WASM_BYTES = new Uint8Array(readFileSync(WASM_PATH));

// Deterministic clock + RNG, identical to the kernel's seeded externalization.
// clock_time_get returns a fixed epoch; random_get is a seeded LCG byte stream.
function makeWasi(seed, clockMs) {
  return (memory) => {
    let s = seed >>> 0;
    const nextByte = () => {
      // xorshift32
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s & 0xff;
    };
    return {
      clock_time_get(_clockId, _precision, resultPtr) {
        new DataView(memory.buffer).setBigUint64(resultPtr, BigInt(clockMs) * 1_000_000n, true);
        return 0;
      },
      random_get(bufPtr, bufLen) {
        const view = new Uint8Array(memory.buffer, bufPtr, bufLen);
        for (let i = 0; i < bufLen; i++) view[i] = nextByte();
        return 0;
      },
    };
  };
}

export class Session {
  constructor({ seed = 0x12345678, clockMs = 1_700_000_000_000, interruptBudget = 0 } = {}) {
    this.seed = seed;
    this.clockMs = clockMs;
    this.interruptBudget = interruptBudget; // 0 = no interrupt
    this.vm = null;
    this.generation = 0;
  }

  _opts() {
    const o = { wasm: WASM_BYTES, wasi: makeWasi(this.seed, this.clockMs) };
    if (this.interruptBudget > 0) {
      let n = this.interruptBudget;
      o.interruptHandler = () => (--n <= 0);
    }
    return o;
  }

  async create() {
    this.vm = await QuickJS.create(this._opts());
    this.generation = 1;
    return this;
  }

  /** Run a cell in global scope; returns host-dumped completion value. Throws on JS error. */
  eval(src) {
    const h = this.vm.evalCode(src, '<cell>');
    return this.vm.dump(h);
  }

  /** Serialize the current VM heap to a raw (uncompressed) heapImage. */
  dump() {
    this.vm.runGC();
    const snap = this.vm.snapshot();
    return QuickJS.serializeSnapshot(snap);
  }

  /** Tear down VM (simulate eviction). */
  dispose() {
    if (this.vm) { this.vm.dispose(); this.vm = null; }
  }

  /** Genuine cold-restore: build a brand-new VM instance from a heapImage. */
  async restore(heapImage) {
    const snap = QuickJS.deserializeSnapshot(heapImage);
    this.vm = await QuickJS.restore(snap, this._opts());
    this.generation++;
    return this;
  }

  usedHeap() {
    return this.vm.getMemoryUsage().memoryUsedSize;
  }
  bufferBytes() {
    // exports.memory.buffer.byteLength via a probe: serialize header carries mem size,
    // but cheaper: read from a fresh snapshot's memory length.
    return this.vm.snapshot().memory.byteLength;
  }
}
