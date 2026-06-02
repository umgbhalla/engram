// async-session.mjs — HostSession variant with ASYNC effectful host calls.
//
// Mirrors imp-oplog-hostcall/host-session.mjs (same seeded WASI, same engine) but the
// `host.<name>` bridge returns a PROMISE. The cell does `await host.fetch(...)`. The host
// returns a VM promise HANDLE (via vm.newPromise()); the host then resolves it (LIVE) or
// pre-resolves it with a RECORDED value (REPLAY). After driving a cell we pump
// `executePendingJobs()` so suspended `await` continuations resume — at a CELL BOUNDARY,
// never mid-await (a mid-await snapshot survives but its resolve-handle dies with the host,
// which is exactly why E6 records resolved values and replays at boundaries).
//
// Concurrency: a cell may issue Promise.all([host.fetch(a), host.fetch(b), host.fetch(c)]).
// All 3 promises are created+queued, the host resolves them in issue order, and the cell's
// recorded `hostResults` preserves that order. Replay returns the same ordered values.

import { QuickJS } from 'quickjs-wasi';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WASM_PATH = require.resolve('quickjs-wasi/quickjs.wasm');
const WASM_BYTES = new Uint8Array(readFileSync(WASM_PATH));

// IDENTICAL seeded WASI to imp-oplog-hostcall / _bench (determinism parity).
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
      clock_time_get(_c, _p, resultPtr) {
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

function hostGlueSrc(toolNames) {
  // Each tool returns the promise that __hostAsync hands back. Args are JSON in, value out.
  const methods = toolNames.map((n) =>
    `  ${n}: function(...args){ return __hostAsync(${JSON.stringify(n)}, JSON.stringify(args)); }`
  ).join(',\n');
  return `globalThis.host = {\n${methods}\n};`;
}

export class AsyncSession {
  constructor({ seed = 0x12345678, clockMs = 1_700_000_000_000, tools = [] } = {}) {
    this.seed = seed;
    this.clockMs = clockMs;
    this.tools = tools;
    this.vm = null;
    this.generation = 0;
    // dispatcher: (name, args) -> resolved JS value. Replaceable for LIVE vs REPLAY.
    this._dispatch = () => { throw new Error('no host dispatcher set'); };
  }

  setDispatch(fn) { this._dispatch = fn; }
  _opts() { return { wasm: WASM_BYTES, wasi: makeWasi(this.seed, this.clockMs) }; }

  // The host callback: synchronously creates a VM promise, computes the result via
  // this._dispatch, and resolves the promise BEFORE returning the handle. Resolving
  // immediately (not deferring) keeps issue-order deterministic: promises settle in the
  // exact order the cell issued the calls, so Promise.all preserves order and the recorded
  // hostResults array matches the await/Promise.all resolution order.
  _hostCallback() {
    const vm = this;
    return (nameH, argsH) => {
      const name = vm.vm.dump(nameH);
      const args = JSON.parse(vm.vm.dump(argsH));
      const p = vm.vm.newPromise();
      const result = vm.vm.dispatchOuter(name, args); // may be {value} or {error}
      if (result && result.__err) {
        p.reject(vm.vm.newError(String(result.__err)));
      } else {
        p.resolve(vm._toHandle(result.value));
      }
      return p.handle;
    };
  }

  _toHandle(v) {
    // minimal JSON-value -> handle (numbers/strings/bool/null/objects-as-string).
    if (v === null || v === undefined) return this.vm.getNull();
    if (typeof v === 'number') return this.vm.newNumber(v);
    if (typeof v === 'string') return this.vm.newString(v);
    if (typeof v === 'boolean') return v ? this.vm.getTrue() : this.vm.getFalse();
    // objects/arrays: round-trip through JSON.parse inside the VM for fidelity
    return this.vm.evalCode(`(${JSON.stringify(v)})`);
  }

  // Bridge so the callback closure can reach this._dispatch with a stable shape.
  dispatchOuter(name, args) {
    try { return { value: this._dispatch(name, args) }; }
    catch (e) { return { __err: e && e.message ? e.message : String(e) }; }
  }

  async create() {
    this.vm = await QuickJS.create(this._opts());
    this.vm.dispatchOuter = (n, a) => this.dispatchOuter(n, a);
    const fn = this.vm.newFunction('__hostAsync', this._hostCallback());
    this.vm.setProp(this.vm.getGlobal(), '__hostAsync', fn);
    this.vm.evalCode(hostGlueSrc(this.tools), '<host-glue>');
    this.generation = 1;
    return this;
  }

  // Drive one cell: eval the (async-IIFE) source, then pump pending jobs so awaits resume.
  // Returns nothing; the cell records its results into globalThis as needed.
  evalCell(src) {
    this.vm.evalCode(src, '<cell>');
    this.vm.executePendingJobs();
  }

  // Synchronous read of a JS expression value (for assertions).
  read(expr) { return this.vm.dump(this.vm.evalCode(expr, '<read>')); }

  dump() { this.vm.runGC(); return QuickJS.serializeSnapshot(this.vm.snapshot()); }
  dispose() { if (this.vm) { this.vm.dispose(); this.vm = null; } }

  async restore(image) {
    this.vm = await QuickJS.restore(QuickJS.deserializeSnapshot(image), this._opts());
    this.vm.dispatchOuter = (n, a) => this.dispatchOuter(n, a);
    this.vm.registerHostCallback('__hostAsync', this._hostCallback());
    this.generation++;
    return this;
  }
}
