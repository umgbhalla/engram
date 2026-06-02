// Kernel: QuickJS-in-wasm holding the live heap, with host.fs wired across the
// host boundary. Models the Engram DO: heap snapshot -> SQLite-first store,
// host.fs -> SQLite/R2, evict (drop instance) -> cold restore (fresh instance +
// blit heap + re-bind host handles from durable storage).

import { QuickJS } from '../../node_modules/.bun/quickjs-wasi@3.0.0/node_modules/quickjs-wasi/dist/index.js';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

const WASM = readFileSync(new URL(
  '../../node_modules/.bun/quickjs-wasi@3.0.0/node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
const wasmModule = await WebAssembly.compile(WASM);

// Bridge host.fs into the VM. host calls cross the boundary as JSON in/out.
function installHostFs(vm, hostfs) {
  const fn = vm.newFunction('__hostFs', (reqH) => {
    const req = JSON.parse(vm.dump(reqH)); // {op, args}
    let res;
    switch (req.op) {
      case 'writeFile': res = hostfs.writeFile(req.args[0], req.args[1]); break;
      case 'readFile':  res = hostfs.readFile(req.args[0]); break;
      case 'list':      res = hostfs.list(req.args[0]); break;
      case 'stat':      res = hostfs.stat(req.args[0]); break;
      case 'rm':        res = hostfs.rm(req.args[0]); break;
      default: res = { __err: 'unknown op ' + req.op };
    }
    return vm.newString(JSON.stringify(res === undefined ? null : res));
  });
  vm.global.setProp('__hostFs', fn);
  fn.dispose();
  // JS-side host.fs shim installed into the heap (becomes part of snapshot)
  vm.evalCode(`
    globalThis.host = globalThis.host || {};
    host.fs = {
      writeFile: (p,d) => JSON.parse(__hostFs(JSON.stringify({op:'writeFile',args:[p,d]}))),
      readFile:  (p)   => JSON.parse(__hostFs(JSON.stringify({op:'readFile',args:[p]}))),
      list:      (pre) => JSON.parse(__hostFs(JSON.stringify({op:'list',args:[pre||'']}))),
      stat:      (p)   => JSON.parse(__hostFs(JSON.stringify({op:'stat',args:[p]}))),
      rm:        (p)   => JSON.parse(__hostFs(JSON.stringify({op:'rm',args:[p]}))),
    };
  `);
}

export async function createKernel(hostfs) {
  const vm = await QuickJS.create(wasmModule);
  installHostFs(vm, hostfs);
  return vm;
}

// Heap snapshot -> gzipped raw bytes (DO-SQLite-first store decides where it lands;
// here we just return the bytes + size to model the admission/store decision).
export function snapshotHeap(vm) {
  const raw = QuickJS.serializeSnapshot(vm.snapshot());
  const gz = gzipSync(raw, { level: 6 });
  return { raw, gz, rawLen: raw.length, gzLen: gz.length };
}

// Cold restore: fresh instance + blit heap + RE-BIND host handles (the host
// function __hostFs must be re-installed because it is a live native callback,
// not part of the heap; the JS shim host.fs IS in the heap and survives).
export async function restoreKernel(gz, hostfs) {
  const raw = gunzipSync(gz);
  const vm = await QuickJS.restore(QuickJS.deserializeSnapshot(raw), wasmModule);
  // re-bind the native host callback (handles are NOT in the heap)
  const fn = vm.newFunction('__hostFs', (reqH) => {
    const req = JSON.parse(vm.dump(reqH));
    let res;
    switch (req.op) {
      case 'writeFile': res = hostfs.writeFile(req.args[0], req.args[1]); break;
      case 'readFile':  res = hostfs.readFile(req.args[0]); break;
      case 'list':      res = hostfs.list(req.args[0]); break;
      case 'stat':      res = hostfs.stat(req.args[0]); break;
      case 'rm':        res = hostfs.rm(req.args[0]); break;
      default: res = { __err: 'unknown op' };
    }
    return vm.newString(JSON.stringify(res === undefined ? null : res));
  });
  vm.global.setProp('__hostFs', fn);
  fn.dispose();
  return vm;
}
