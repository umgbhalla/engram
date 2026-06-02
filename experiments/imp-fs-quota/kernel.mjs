// kernel.mjs — real quickjs-wasi VM holding the heap, host.fs bridged across the
// boundary, seeded determinism (epoch 1.7e12, xorshift32 RNG) per the shared harness.
//
// Evict = drop the VM instance. Cold restore = fresh instance + heap blit +
// re-bind the native __hostFs callback (handles are NOT in the heap) + re-hydrate
// the quota counter from the durable manifest.

import { QuickJS } from 'quickjs-wasi';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WASM_BYTES = new Uint8Array(readFileSync(require.resolve('quickjs-wasi/quickjs.wasm')));

const SEED = 0x12345678;
const CLOCK_MS = 1_700_000_000_000; // epoch 1.7e12

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

function opts() { return { wasm: WASM_BYTES, wasi: makeWasi(SEED, CLOCK_MS) }; }

// Native bridge: JSON in/out. If the host returns {__err}, we throw a typed Error
// IN THE VM so guest try/catch sees it and the VM stays alive.
function bindHostFs(vm, hostfs) {
  const fn = vm.newFunction('__hostFs', (reqH) => {
    const req = JSON.parse(vm.dump(reqH));
    let res;
    switch (req.op) {
      case 'writeFile': res = hostfs.writeFile(req.args[0], req.args[1]); break;
      case 'readFile':  res = hostfs.readFile(req.args[0]); break;
      case 'list':      res = hostfs.list(req.args[0]); break;
      case 'stat':      res = hostfs.stat(req.args[0]); break;
      case 'rm':        res = hostfs.rm(req.args[0]); break;
      case 'usage':     res = hostfs.usage(); break;
      default: res = { __err: { name: 'DenyError', message: 'unknown op ' + req.op } };
    }
    return vm.newString(JSON.stringify(res === undefined ? null : res));
  });
  vm.global.setProp('__hostFs', fn);
  fn.dispose();
}

const SHIM = `
  globalThis.host = globalThis.host || {};
  (function(){
    function call(op, args){
      var r = JSON.parse(__hostFs(JSON.stringify({op:op,args:args||[]})));
      if (r && r.__err){ var e = new Error(r.__err.message); e.name = r.__err.name;
        e.used = r.__err.used; e.cap = r.__err.cap; throw e; }
      return r;
    }
    host.fs = {
      writeFile: function(p,d){ return call('writeFile',[p,d]); },
      readFile:  function(p){ return call('readFile',[p]); },
      list:      function(pre){ return call('list',[pre||'']); },
      stat:      function(p){ return call('stat',[p]); },
      rm:        function(p){ return call('rm',[p]); },
      usage:     function(){ return call('usage',[]); },
    };
  })();
`;

export async function createKernel(hostfs) {
  const vm = await QuickJS.create(opts());
  bindHostFs(vm, hostfs);
  vm.evalCode(SHIM);
  return vm;
}

export function snapshotHeap(vm) {
  vm.runGC();
  const raw = QuickJS.serializeSnapshot(vm.snapshot());
  const gz = gzipSync(raw, { level: 6 });
  return { raw, gz, rawLen: raw.length, gzLen: gz.length };
}

export async function restoreKernel(gz, hostfs) {
  const raw = gunzipSync(gz);
  const vm = await QuickJS.restore(QuickJS.deserializeSnapshot(raw), opts());
  bindHostFs(vm, hostfs); // re-bind native callback (not in heap)
  // host.fs shim IS in the heap (survives blit); quota counter re-hydrated inside makeHostFs
  return vm;
}

// helper: eval a cell and return dumped value
export function ev(vm, src) { return vm.dump(vm.evalCode(src)); }
