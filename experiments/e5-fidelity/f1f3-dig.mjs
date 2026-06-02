import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dir, '..', '..', 'node_modules/.bun/quickjs-wasi@3.0.0/node_modules/quickjs-wasi');
const { QuickJS } = await import(join(PKG, 'dist/index.js'));
const WASM = readFileSync(join(PKG, 'quickjs.wasm'));
const log = (n, d) => console.log(`${n}  ::  ${d}`);

// F1 dig: what does an un-re-registered host fn actually return after restore?
{
  const vm = await QuickJS.create({ wasm: WASM });
  const fn = vm.newFunction('hostAdd', (a, b) => vm.hostToHandle(vm.dump(a) + vm.dump(b)));
  vm.global.setProp('hostAdd', fn);
  const s = QuickJS.serializeSnapshot(vm.snapshot());
  const vm2 = await QuickJS.restore(QuickJS.deserializeSnapshot(s), { wasm: WASM });
  let out;
  try { out = vm2.dump(vm2.evalCode('var r = globalThis.hostAdd(4,5); typeof r + ":" + String(r)')); }
  catch (e) { out = 'THREW: ' + e.message.slice(0, 100); }
  log('F1-dig un-reregistered host call returns', out);
  // is the function even still a function?
  log('F1-dig typeof hostAdd', vm2.dump(vm2.evalCode('typeof globalThis.hostAdd')));
}

// F3 dig: sweep runtimePtr corruption to find where it goes silent-wrong vs crashes
{
  for (const off of [0, 4, 8, 64, 256, 4096, -8, -64]) {
    const vm = await QuickJS.create({ wasm: WASM });
    vm.evalCode('globalThis.v=42; globalThis.arr=[1,2,3,4,5];');
    const snap = vm.snapshot();
    const bad = { ...snap, memory: snap.memory.slice(), runtimePtr: snap.runtimePtr + off };
    let res;
    try {
      const vm2 = await QuickJS.restore(bad, { wasm: WASM });
      const v = vm2.dump(vm2.evalCode('globalThis.v'));
      const a = vm2.dump(vm2.evalCode('globalThis.arr.reduce((x,y)=>x+y,0)'));
      res = (v === 42 && a === 15) ? 'CORRECT(silent-ok)' : `SILENT-CORRUPT v=${v} arr=${a}`;
    } catch (e) { res = 'THREW: ' + e.message.slice(0, 50); }
    log(`F3-dig runtimePtr+${off}`, res);
  }
}
