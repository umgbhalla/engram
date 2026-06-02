// session.mjs — QuickJS session driver for workerd, ported from experiments/_bench/session.mjs.
// Uses the precompiled WebAssembly.Module placed on globalThis.__QJS_MODULE by entry.mjs
// (quickjs-wasi accepts a WebAssembly.Module directly). Seeded clock + RNG via the WASI
// override factory keep snapshots deterministic, identical to the kernel.

import { QuickJS } from "quickjs-wasi";

function makeWasi(seed, clockMs) {
  return (memory) => {
    let s = seed >>> 0;
    const nextByte = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;
      s >>>= 0;
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
  constructor({ seed = 0x12345678, clockMs = 1_700_000_000_000 } = {}) {
    this.seed = seed;
    this.clockMs = clockMs;
    this.vm = null;
    this.generation = 0;
  }

  _opts() {
    return { wasm: globalThis.__QJS_MODULE, wasi: makeWasi(this.seed, this.clockMs) };
  }

  async create() {
    this.vm = await QuickJS.create(this._opts());
    this.generation = 1;
    return this;
  }

  eval(src) {
    const h = this.vm.evalCode(src, "<cell>");
    return this.vm.dump(h);
  }

  // serialize current heap to a raw (uncompressed) heapImage
  dump() {
    this.vm.runGC();
    const snap = this.vm.snapshot();
    return QuickJS.serializeSnapshot(snap);
  }

  // QuickJS used-heap bytes (the size-admission metric)
  usedHeap() {
    return this.vm.getMemoryUsage().memoryUsedSize;
  }

  bufferBytes() {
    return this.vm.snapshot().memory.byteLength;
  }

  dispose() {
    if (this.vm) {
      this.vm.dispose();
      this.vm = null;
    }
  }

  async restore(heapImage) {
    const snap = QuickJS.deserializeSnapshot(heapImage);
    this.vm = await QuickJS.restore(snap, this._opts());
    this.generation++;
    return this;
  }
}
