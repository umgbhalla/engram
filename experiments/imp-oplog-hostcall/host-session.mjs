// host-session.mjs — a Session variant that supports SIDE-EFFECTING host calls.
//
// The shared _bench/session.mjs intentionally has no host-call bridge (its eval is a
// bare global eval). GAP 1 is precisely about host calls, so we need a VM wrapper that
// exposes a `host.*` bridge into the QuickJS VM. We reuse the SAME engine, the SAME
// seeded WASI (xorshift32 RNG + fixed epoch clock) as _bench/session.mjs verbatim, so
// determinism is identical to the shared substrate — only a host bridge is added.
//
// Host bridge model (mirrors the real kernel's `host.<name>` -> `__hostCall`):
//   * VM-side: a global `host` object whose methods serialize args to JSON and call the
//     host function `__hostCall(name, argsJson)` -> returns a JSON string -> parsed.
//   * Host-side: `__hostCall` is a registered host callback (newFunction). Crucially,
//     host callbacks registered by name do NOT survive snapshot/restore in quickjs-wasi
//     (the C closure is not serialized) — they MUST be re-bound on restore via
//     registerHostCallback. We exploit that: on cold-restore we re-bind `__hostCall` to a
//     REPLAY-MODE handler that returns RECORDED results and never fires the side effect.

import { QuickJS } from 'quickjs-wasi';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WASM_PATH = require.resolve('quickjs-wasi/quickjs.wasm');
const WASM_BYTES = new Uint8Array(readFileSync(WASM_PATH));

// IDENTICAL seeded WASI to _bench/session.mjs (do not diverge — fairness/determinism).
function makeWasi(seed, clockMs) {
  return (memory) => {
    let s = seed >>> 0;
    const nextByte = () => {
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

// The VM-side glue installed once per (re)instantiation: builds a `host` namespace whose
// methods all route through the single `__hostCall` host callback. Names are data-driven.
function hostGlueSrc(toolNames) {
  const methods = toolNames.map((n) =>
    `  ${n}: function(...args){ return JSON.parse(__hostCall(${JSON.stringify(n)}, JSON.stringify(args))); }`
  ).join(',\n');
  return `globalThis.host = {\n${methods}\n};`;
}

export class HostSession {
  // `tools` is a list of tool method names exposed under `host.*`.
  constructor({ seed = 0x12345678, clockMs = 1_700_000_000_000, tools = [] } = {}) {
    this.seed = seed;
    this.clockMs = clockMs;
    this.tools = tools;
    this.vm = null;
    this.generation = 0;
    // The host-call dispatcher. Replaceable so we can swap LIVE vs REPLAY behavior.
    // signature: (name:string, args:any[]) -> any  (the result handed back to the VM)
    this._dispatch = () => { throw new Error('no host dispatcher set'); };
  }

  setDispatch(fn) { this._dispatch = fn; }

  _opts() {
    return { wasm: WASM_BYTES, wasi: makeWasi(this.seed, this.clockMs) };
  }

  // The host callback bound to the name '__hostCall'. Reads (name, argsJson) handles,
  // calls this._dispatch, returns a JSON string handle.
  _hostCallback() {
    const vm = this.vm;
    return (nameH, argsH) => {
      const name = vm.dump(nameH);
      const args = JSON.parse(vm.dump(argsH));
      const result = this._dispatch(name, args);
      return vm.newString(JSON.stringify(result === undefined ? null : result));
    };
  }

  async create() {
    this.vm = await QuickJS.create(this._opts());
    // register the host callback by name (must be re-bound after restore) and attach it
    // as a global so the VM-side glue can call it.
    const fn = this.vm.newFunction('__hostCall', this._hostCallback());
    this.vm.setProp(this.vm.getGlobal(), '__hostCall', fn);
    this.vm.evalCode(hostGlueSrc(this.tools), '<host-glue>');
    this.generation = 1;
    return this;
  }

  eval(src) {
    const h = this.vm.evalCode(src, '<cell>');
    return this.vm.dump(h);
  }

  dump() {
    this.vm.runGC();
    const snap = this.vm.snapshot();
    return QuickJS.serializeSnapshot(snap);
  }

  dispose() {
    if (this.vm) { this.vm.dispose(); this.vm = null; }
  }

  // Cold-restore: brand new VM from image, then RE-BIND the host callback (it did not
  // survive the snapshot). The caller decides whether the re-bound dispatcher is LIVE or
  // REPLAY before driving any cells.
  async restore(heapImage) {
    const snap = QuickJS.deserializeSnapshot(heapImage);
    this.vm = await QuickJS.restore(snap, this._opts());
    // re-bind __hostCall by name — REQUIRED, the C closure is not in the snapshot.
    this.vm.registerHostCallback('__hostCall', this._hostCallback());
    this.generation++;
    return this;
  }

  usedHeap() { return this.vm.getMemoryUsage().memoryUsedSize; }
}
