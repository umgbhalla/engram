// Deep-dive: is __stack_pointer mandatory in the triple? When?
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dir, '..', '..', 'node_modules/.bun/quickjs-wasi@3.0.0/node_modules/quickjs-wasi');
const { QuickJS } = await import(join(PKG, 'dist/index.js'));
const WASM = readFileSync(join(PKG, 'quickjs.wasm'));

const log = (n, d) => console.log(`${n}  ::  ${d}`);

// Observe the stack pointer at rest vs after evals. QuickJS unwinds the C stack
// after each eval returns, so at snapshot() time (between evals) SP is back at base.
{
  const vm = await QuickJS.create({ wasm: WASM });
  log('SP fresh', vm.snapshot().stackPointer);
  vm.evalCode('let a=1; function f(n){return n<=0?0:f(n-1);} f(500);');
  log('SP after deep recursion returns', vm.snapshot().stackPointer);
  vm.evalCode('globalThis.x = 1;');
  log('SP after simple eval', vm.snapshot().stackPointer);
}

// The interpreter's JS call stack lives in LINEAR MEMORY (qjs stack frames are heap/value-stack),
// NOT the wasm C shadow stack, EXCEPT during an in-progress native call. Since eval() returns
// before snapshot(), the wasm shadow stack is always unwound to base. Therefore __stack_pointer
// is ALWAYS at its base value at a between-eval snapshot point -> capturing it is harmless but
// in practice equals the fresh default. Prove: restore with SP left at FRESH default works even
// for a pending promise (whose continuation lives in linear memory, not the C stack).
{
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode(`
    globalThis.r=null; globalThis.st='pending';
    globalThis.p=new Promise(res=>{globalThis.r=res;});
    globalThis.p.then(v=>{globalThis.st='got:'+v;});
  `);
  const snap = vm.snapshot();
  log('SP with pending promise', snap.stackPointer + ' (== fresh default 1048576? ' + (snap.stackPointer === 1048576) + ')');
  // Restore but DELIBERATELY leave SP unset (use fresh instance default by passing base)
  const variant = { ...snap, memory: snap.memory.slice(), stackPointer: 1048576 };
  const vm2 = await QuickJS.restore(variant, { wasm: WASM });
  vm2.evalCode('globalThis.r(99)'); vm2.executePendingJobs();
  log('pending promise resolves w/ SP=default', vm2.dump(vm2.evalCode('globalThis.st')));
}

// CONCLUSION TEST: is runtimePtr/contextPtr recoverable from memory alone, or truly needed?
// They are pointers stored at a KNOWN location? No public API to find them post-restore w/o the call.
// Demonstrate they MUST be supplied (B4 showed zeroing them => crash). Confirm correct values are
// deterministic across runs (so could be hardcoded) OR vary.
{
  for (let i = 0; i < 3; i++) {
    const vm = await QuickJS.create({ wasm: WASM });
    const s = vm.snapshot();
    log(`run${i} rt/ctx`, `${s.runtimePtr}/${s.contextPtr}`);
  }
}
