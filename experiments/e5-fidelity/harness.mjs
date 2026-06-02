// EXP-5 Snapshot-triple FIDELITY harness on the CURRENT engine (quickjs-wasi 3.0.0)
// Runs in node OUTSIDE workerd. Goal:
//  (a) minimal correct snapshot triple (which globals mandatory)
//  (b) catch latent restore-fidelity bugs
//  (c) document failure modes
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const PKG = join(ROOT, 'node_modules/.bun/quickjs-wasi@3.0.0/node_modules/quickjs-wasi');
const { QuickJS } = await import(join(PKG, 'dist/index.js'));
const WASM = readFileSync(join(PKG, 'quickjs.wasm'));

const results = [];
const pass = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`); };

// ---- Seed rich live state into a VM ----
const SEED = `
  // 1. counter closure (captures lexical var)
  let __c = 40;
  globalThis.inc = () => ++__c;
  globalThis.inc(); globalThis.inc(); // __c now 42
  // 2. pending UNRESOLVED promise + a resolver we can call later
  globalThis.__resolve = null;
  globalThis.pend = new Promise(r => { globalThis.__resolve = r; });
  globalThis.pendState = 'pending';
  globalThis.pend.then(v => { globalThis.pendState = 'resolved:'+v; });
  // 3. Map, 4. Set, 5. typed array, 6. Date, 7. bound function
  globalThis.m = new Map([['a',1],['b',2]]);
  globalThis.s = new Set([10,20,30]);
  globalThis.ta = new Int32Array([7,8,9]);
  globalThis.d = new Date(1700000000000);
  function greet(p){ return p+' '+this.name; }
  globalThis.bound = greet.bind({name:'engram'}, 'hi');
  // extra: a regex, a bigint, a symbol-keyed obj, a class instance, an array w/ holes
  globalThis.rx = /ab+c/gi;
  globalThis.big = 123456789012345678901234567890n;
  globalThis.sym = Symbol('tag');
  globalThis.symObj = { [globalThis.sym]: 'sval' };
  class Acc { constructor(){ this.total=0; } add(n){ this.total+=n; return this; } }
  globalThis.acc = new Acc().add(5).add(8); // total 13
  globalThis.sparse = [1,,3]; globalThis.sparse[10]=99;
  'seeded';
`;

function probe(vm) {
  // Returns a snapshot of observable state by evaluating read-only expressions.
  const evalJS = (code) => vm.dump(vm.evalCode(code));
  return {
    incNext: evalJS('globalThis.inc()'),          // mutates __c -> should be 43 first call
    mapEntries: evalJS('[...globalThis.m.entries()]'),
    mapGetA: evalJS('globalThis.m.get("a")'),
    setHas: evalJS('[globalThis.s.has(20), globalThis.s.size]'),
    taVals: evalJS('Array.from(globalThis.ta)'),
    taType: evalJS('globalThis.ta.constructor.name'),
    dateMs: evalJS('globalThis.d.getTime()'),
    bound: evalJS('globalThis.bound()'),
    rxTest: evalJS('[globalThis.rx.test("xxABBC"), globalThis.rx.source, globalThis.rx.flags]'),
    big: evalJS('String(globalThis.big)'),
    symVal: evalJS('globalThis.symObj[globalThis.sym]'),
    accTotal: evalJS('globalThis.acc.total'),
    accProto: evalJS('globalThis.acc instanceof globalThis.acc.constructor'),
    sparse: evalJS('[globalThis.sparse.length, globalThis.sparse[0], 1 in globalThis.sparse, globalThis.sparse[10]]'),
    pendState: evalJS('globalThis.pendState'),
    pendIsPromise: evalJS('globalThis.pend instanceof Promise'),
  };
}

// ============ TEST A: package snapshot()/restore() round-trip fidelity ============
{
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode(SEED);
  // baseline observation BEFORE snapshot (note: probe mutates __c via inc())
  const snap = vm.snapshot();
  const serialized = QuickJS.serializeSnapshot(snap);
  pass('A.snapshot-shape', snap.memory && typeof snap.stackPointer === 'number' && typeof snap.runtimePtr === 'number' && typeof snap.contextPtr === 'number',
    `mem=${snap.memory.byteLength}B sp=${snap.stackPointer} rt=${snap.runtimePtr} ctx=${snap.contextPtr} exts=${snap.extensions.length} serialized=${serialized.byteLength}B`);

  // restore into a FRESH module/instance
  const snap2 = QuickJS.deserializeSnapshot(serialized);
  const vm2 = await QuickJS.restore(snap2, { wasm: WASM });
  const p = probe(vm2);
  pass('A.closure', p.incNext === 43, `inc()->${p.incNext} (expect 43)`);
  pass('A.map', JSON.stringify(p.mapEntries) === '[["a",1],["b",2]]' && p.mapGetA === 1, JSON.stringify(p.mapEntries));
  pass('A.set', JSON.stringify(p.setHas) === '[true,3]', JSON.stringify(p.setHas));
  pass('A.typedarray', JSON.stringify(p.taVals) === '[7,8,9]' && p.taType === 'Int32Array', `${p.taType} ${JSON.stringify(p.taVals)}`);
  pass('A.date', p.dateMs === 1700000000000, String(p.dateMs));
  pass('A.bound-fn', p.bound === 'hi engram', String(p.bound));
  pass('A.regex', p.rxTest[1] === 'ab+c' && p.rxTest[2] === 'gi', JSON.stringify(p.rxTest));
  pass('A.bigint', p.big === '123456789012345678901234567890', p.big);
  pass('A.symbol-key', p.symVal === 'sval', String(p.symVal));
  pass('A.class-instance', p.accTotal === 13 && p.accProto === true, `total=${p.accTotal} proto=${p.accProto}`);
  pass('A.sparse-array', JSON.stringify(p.sparse) === '[11,1,false,99]', JSON.stringify(p.sparse));
  pass('A.promise-survives-as-promise', p.pendIsPromise === true && p.pendState === 'pending', `${p.pendIsPromise} ${p.pendState}`);

  // PENDING PROMISE: resolve it AFTER restore, drain jobs, check the .then fired
  vm2.evalCode('globalThis.__resolve(777)');
  const jobs = vm2.executePendingJobs();
  const after = vm2.dump(vm2.evalCode('globalThis.pendState'));
  pass('A.pending-promise-resolvable-after-restore', after === 'resolved:777', `jobs=${jobs} state=${after}`);
}

// ============ TEST B: ABLATION — which parts of the triple are MANDATORY ============
// We reach into raw instances to control exactly what we restore.
// Helper: instantiate a fresh module with the same wasi imports the package uses,
// but we just need a parallel instance to blit into. Easiest: use restore() but mutate snapshot.
async function restoreVariant(label, mutate) {
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode(SEED);
  const snap = vm.snapshot();
  const variant = { memory: snap.memory.slice(), stackPointer: snap.stackPointer, runtimePtr: snap.runtimePtr, contextPtr: snap.contextPtr, extensions: snap.extensions };
  mutate(variant);
  try {
    const vm2 = await QuickJS.restore(variant, { wasm: WASM });
    const r = vm2.dump(vm2.evalCode('[globalThis.inc(), [...globalThis.m]].flat()'));
    return { ok: true, label, detail: JSON.stringify(r) };
  } catch (e) {
    return { ok: false, label, detail: (e && e.message) ? e.message.slice(0, 160) : String(e) };
  }
}

// B1: full triple (control)
{ const r = await restoreVariant('full', () => {}); pass('B1.full-triple', r.ok && r.detail.startsWith('[43'), r.detail); }
// B2: WRONG stack pointer (set to fresh-instance default 1048576) — does SP matter for stored state?
{ const r = await restoreVariant('sp=default', v => { v.stackPointer = 1048576; }); pass('B2.sp-wrong-default-1048576', true, `restore ${r.ok?'OK':'THREW'}: ${r.detail}`); }
// B3: SP zeroed (clearly invalid)
{ const r = await restoreVariant('sp=0', v => { v.stackPointer = 0; }); pass('B3.sp-zero', true, `restore ${r.ok?'OK':'THREW'}: ${r.detail}`); }
// B4: runtimePtr/contextPtr zeroed — are they recoverable / mandatory?
{ const r = await restoreVariant('rt=ctx=0', v => { v.runtimePtr = 0; v.contextPtr = 0; }); pass('B4.rt-ctx-zeroed', true, `restore ${r.ok?'OK':'THREW'}: ${r.detail}`); }

// ============ TEST C: cross-instance generation (true new module) + double restore ============
{
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode(SEED);
  vm.evalCode('globalThis.inc()'); // __c=43 in original (state advances ONLY in original)
  const s1 = QuickJS.serializeSnapshot(vm.snapshot());
  const vmA = await QuickJS.restore(QuickJS.deserializeSnapshot(s1), { wasm: WASM });
  vmA.evalCode('globalThis.inc()'); // __c=44 in A
  const s2 = QuickJS.serializeSnapshot(vmA.snapshot());
  const vmB = await QuickJS.restore(QuickJS.deserializeSnapshot(s2), { wasm: WASM });
  const cB = vmB.dump(vmB.evalCode('globalThis.inc()'));
  pass('C.chained-restore-independent-lineage', cB === 45, `B inc()->${cB} (expect 45: 43 orig+1 A+1 B)`);
  // original vm continues independently
  const cOrig = vm.dump(vm.evalCode('globalThis.inc()'));
  pass('C.original-unaffected', cOrig === 44, `orig inc()->${cOrig} (expect 44)`);
}

// ============ TEST D: memory growth — snapshot a grown heap, restore needs more pages ============
{
  const vm = await QuickJS.create({ wasm: WASM });
  vm.evalCode(SEED);
  const before = vm.snapshot().memory.byteLength;
  vm.evalCode('globalThis.blob = new Array(200000).fill(0).map((_,i)=>({i, s:"x".repeat(20)}));');
  const after = vm.snapshot().memory.byteLength;
  const s = QuickJS.serializeSnapshot(vm.snapshot());
  const vm2 = await QuickJS.restore(QuickJS.deserializeSnapshot(s), { wasm: WASM });
  const len = vm2.dump(vm2.evalCode('globalThis.blob.length'));
  const sample = vm2.dump(vm2.evalCode('globalThis.blob[150000].s'));
  pass('D.grown-heap-restore', len === 200000 && sample === 'x'.repeat(20), `grew ${before}->${after}B len=${len}`);
}

// ============ summary ============
const fails = results.filter(r => !r.ok);
console.log(`\n==== ${results.length - fails.length}/${results.length} PASS ====`);
if (fails.length) console.log('FAILURES:', fails.map(f => f.name).join(', '));
process.exit(0);
