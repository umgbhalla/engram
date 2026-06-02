// asyncify-engine.mjs — W3 ASYNCIFY mechanism (mid-cell preemption axis).
//
// This is NOT a durability-bytes strategy. It is the ORTHOGONAL axis: the ability
// to PREEMPT a running cell MID-EXECUTION (between bytecode steps / at a host
// interrupt point), UNWIND the native call stack into linear memory, snapshot the
// whole heap, and on a fresh (cold) instance REWIND back to the exact suspend point
// and continue — so an unbounded/long cell can be checkpointed and survive eviction
// WITHOUT losing its in-flight computation.
//
// Binaryen's `wasm-opt --asyncify` instruments a wasm module with:
//   asyncify_start_unwind(dataPtr) / asyncify_stop_unwind()
//   asyncify_start_rewind(dataPtr) / asyncify_stop_rewind()
//   asyncify_get_state()  -> 0 normal, 1 unwinding, 2 rewinding
// The "asyncify data" struct lives in linear memory: [stackPtr:i32, stackEnd:i32]
// followed by reserved stack space. Because the unwound call-stack is written INTO
// linear memory, a plain snapshot of memory.buffer captures the suspended fiber.
//
// Representative module: a tight compute loop that calls an imported `host.tick()`
// on every iteration — exactly the kernel's per-bytecode interrupt-handler tripwire
// (the place where the real kernel preempts runaway cells). This models a "long cell".

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// asyncify data struct + reserved fiber stack, laid out in linear memory.
// Our representative module keeps its app counter at addr 0, so we place the
// asyncify struct safely above it.
const DATA_ADDR = 16;
const STACK_BEGIN = 1024;
const STACK_END = 16384; // generous fiber-stack reservation

export class AsyncifyLoop {
  constructor(wasmPath) {
    this.bytes = readFileSync(wasmPath);
    this.mod = new WebAssembly.Module(this.bytes);
    this.inst = null;
    // control flags read inside the host.tick import
    this._preemptAt = Infinity; // counter value at which to unwind
    this._armed = false; // unwind requested
    this._fired = false; // unwind already started this run
    this._preemptTs = 0; // perf timestamp when unwind fired
    this._tickTsAtArm = 0;
  }

  _imports() {
    const self = this;
    return {
      host: {
        tick() {
          const ex = self.inst.exports;
          const st = ex.asyncify_get_state();
          if (st === 2) {
            // we are REWINDING: this tick is the replayed suspend point — stop rewinding
            ex.asyncify_stop_rewind();
            return;
          }
          if (st === 0 && self._armed && !self._fired) {
            const counter = new Int32Array(ex.memory.buffer)[0];
            if (counter >= self._preemptAt) {
              self._fired = true;
              self._preemptTs = performance.now();
              const dv = new DataView(ex.memory.buffer);
              dv.setInt32(DATA_ADDR, STACK_BEGIN, true);
              dv.setInt32(DATA_ADDR + 4, STACK_END, true);
              ex.asyncify_start_unwind(DATA_ADDR);
            }
          }
        },
      },
    };
  }

  _instantiate(memoryToRestore) {
    this.inst = new WebAssembly.Instance(this.mod, this._imports());
    if (memoryToRestore) {
      // grow if needed then blit the snapshot bytes back — genuine cold restore
      const cur = this.inst.exports.memory.buffer.byteLength;
      if (memoryToRestore.length > cur) {
        const pages = Math.ceil((memoryToRestore.length - cur) / 65536);
        this.inst.exports.memory.grow(pages);
      }
      new Uint8Array(this.inst.exports.memory.buffer).set(memoryToRestore);
    }
    return this.inst;
  }

  /**
   * Run the loop, preempting (unwinding) when the app counter reaches `preemptAt`.
   * Returns { counter, snapshot, armTs, preemptTs } — snapshot is the full linear
   * memory at the suspend point (the in-flight fiber lives inside it).
   */
  runAndPreempt(preemptAt) {
    this._preemptAt = preemptAt;
    this._armed = true;
    this._fired = false;
    this._instantiate(null);
    this._tickTsAtArm = performance.now();
    this.inst.exports.run(); // returns when the loop unwinds back out
    // unwind cost = from the moment start_unwind fired until control returns here
    this._unwindCost = performance.now() - this._preemptTs;
    this.inst.exports.asyncify_stop_unwind();
    const counter = new Int32Array(this.inst.exports.memory.buffer)[0];
    const snapshot = new Uint8Array(this.inst.exports.memory.buffer).slice();
    return { counter, snapshot, preemptTs: this._preemptTs };
  }

  /**
   * Cold restore: brand-new instance, blit the snapshot, REWIND to the suspend
   * point and run to completion. Returns { restoreMs, finalCounter }.
   */
  restoreAndResume(snapshot) {
    this._armed = false; // do not unwind again
    this._fired = true;
    const t0 = performance.now();
    this._instantiate(snapshot);
    this.inst.exports.asyncify_start_rewind(DATA_ADDR);
    this.inst.exports.run(); // rewinds into the loop, continues to completion
    const restoreMs = performance.now() - t0;
    const finalCounter = new Int32Array(this.inst.exports.memory.buffer)[0];
    return { restoreMs, finalCounter };
  }

  /** Run uninterrupted to completion (baseline for preempt-latency / overhead). */
  runToEnd() {
    this._armed = false;
    this._fired = true;
    const t0 = performance.now();
    this._instantiate(null);
    this.inst.exports.run();
    return { ms: performance.now() - t0, counter: new Int32Array(this.inst.exports.memory.buffer)[0] };
  }
}
