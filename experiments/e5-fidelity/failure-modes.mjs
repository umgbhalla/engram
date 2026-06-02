// Failure-mode + latent-bug catalog for the Engram snapshot triple.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dir, '..', '..', 'node_modules/.bun/quickjs-wasi@3.0.0/node_modules/quickjs-wasi');
const { QuickJS } = await import(join(PKG, 'dist/index.js'));
const WASM = readFileSync(join(PKG, 'quickjs.wasm'));
const log = (n, d) => console.log(`${n}  ::  ${d}`);

// F1: host callbacks are NOT in the heap — they live host-side and MUST be re-registered.
{
  const vm = await QuickJS.create({ wasm: WASM });
  const fn = vm.newFunction('hostAdd', (a, b) => vm.hostToHandle(vm.dump(a) + vm.dump(b)));
  vm.global.setProp('hostAdd', fn);
  vm.evalCode('globalThis.cached = hostAdd; globalThis.sum0 = hostAdd(2,3);');
  log('F1 pre-snapshot hostAdd', vm.dump(vm.evalCode('globalThis.sum0')));
  const s = QuickJS.serializeSnapshot(vm.snapshot());
  const vm2 = await QuickJS.restore(QuickJS.deserializeSnapshot(s), { wasm: WASM });
  // calling the host fn WITHOUT re-registration:
  let err1 = null; try { vm2.evalCode('globalThis.cached(4,5)'); } catch (e) { err1 = e.message.slice(0, 80); }
  log('F1 call host-fn after restore WITHOUT re-register', err1 ? 'THREW: ' + err1 : 'returned (unexpected)');
  // with re-registration via registerHostCallback:
  vm2.registerHostCallback('hostAdd', (a, b) => vm2.hostToHandle(vm2.dump(a) + vm2.dump(b)));
  let r2; try { r2 = vm2.dump(vm2.evalCode('globalThis.cached(4,5)')); } catch (e) { r2 = 'THREW:' + e.message.slice(0, 60); }
  log('F1 after registerHostCallback', r2);
}

// F2: image TRUNCATION — restore from a snapshot whose memory was clipped (simulates partial write).
{
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode('globalThis.big = "x".repeat(500000); globalThis.k=1;');
  const snap = vm.snapshot();
  const truncated = { ...snap, memory: snap.memory.slice(0, snap.memory.byteLength - 65536) };
  let res; try { const vm2 = await QuickJS.restore(truncated, { wasm: WASM }); res = 'restored, k=' + vm2.dump(vm2.evalCode('globalThis.k')); }
  catch (e) { res = 'THREW: ' + e.message.slice(0, 80); }
  log('F2 truncated-image restore', res);
}

// F3: corrupted runtimePtr (points into valid memory but wrong) -> silent corruption vs crash?
{
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode('globalThis.v=42;');
  const snap = vm.snapshot();
  const bad = { ...snap, memory: snap.memory.slice(), runtimePtr: snap.runtimePtr + 16 };
  let res; try { const vm2 = await QuickJS.restore(bad, { wasm: WASM }); res = 'v=' + vm2.dump(vm2.evalCode('globalThis.v')); }
  catch (e) { res = 'THREW: ' + e.message.slice(0, 80); }
  log('F3 runtimePtr+16 corruption', res);
}

// F4: NON-DETERMINISM leak — Math.random / Date.now baked into state before snapshot are FROZEN
//     into the heap (a value), but FUTURE calls after restore depend on host wasi entropy/clock.
{
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode('globalThis.frozenRand = Math.random(); globalThis.frozenNow = Date.now();');
  const fr = vm.dump(vm.evalCode('globalThis.frozenRand'));
  const s = QuickJS.serializeSnapshot(vm.snapshot());
  const vm2 = await QuickJS.restore(QuickJS.deserializeSnapshot(s), { wasm: WASM });
  const fr2 = vm2.dump(vm2.evalCode('globalThis.frozenRand'));
  const newRand = vm2.dump(vm2.evalCode('Math.random()'));
  log('F4 frozen Math.random survives', `${fr === fr2} (val ${fr2})`);
  log('F4 NEW Math.random after restore is fresh entropy', `${newRand} (differs from frozen: ${newRand !== fr2})`);
}

// F5: WeakRef / FinalizationRegistry — GC-sensitive; do they survive byte-blit?
{
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode('globalThis.target={tag:"alive"}; globalThis.wr=new WeakRef(globalThis.target);');
  const s = QuickJS.serializeSnapshot(vm.snapshot());
  const vm2 = await QuickJS.restore(QuickJS.deserializeSnapshot(s), { wasm: WASM });
  const deref = vm2.dump(vm2.evalCode('globalThis.wr.deref()?.tag'));
  log('F5 WeakRef.deref after restore', deref);
}

// F6: serialize/deserialize is BYTE-LOSSLESS for memory?
{
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode('globalThis.z=[1,2,3];');
  const snap = vm.snapshot();
  const round = QuickJS.deserializeSnapshot(QuickJS.serializeSnapshot(snap));
  let same = round.memory.byteLength === snap.memory.byteLength && round.stackPointer === snap.stackPointer && round.runtimePtr === snap.runtimePtr && round.contextPtr === snap.contextPtr;
  if (same) for (let i = 0; i < snap.memory.byteLength; i++) if (snap.memory[i] !== round.memory[i]) { same = false; break; }
  log('F6 serialize roundtrip byte-identical', same);
}
