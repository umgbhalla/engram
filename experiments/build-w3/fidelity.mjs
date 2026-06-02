// fidelity.mjs — explicit closure + pending-promise + Map/Set round-trip across a
// genuine evict -> cold-restore, on the shared harness Session (real quickjs-wasi).
// Proves the W3 snapshot/restore preserves live state byte-for-fidelity.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dir = dirname(fileURLToPath(import.meta.url));
const { Session } = await import(resolve(__dir, '../_bench/session.mjs'));

const s = new Session();
await s.create();

// build live state: a closure counter, a pending (unresolved) promise captured in a
// global, a Map and a Set.
s.eval(`
  var mkCounter = (n)=>()=>++n;
  var inc = mkCounter(40);
  inc(); inc();                       // closure now at 42 on next call -> 43
  var pend = new Promise((res)=>{ globalThis.__resolve = res; });
  var pendState = "pending";
  pend.then((v)=>{ pendState = "resolved:"+v; });
  var m = new Map([["a",1],["b",2]]);
  var st = new Set([10,20,30]);
`);

const before = s.eval('JSON.stringify({next: inc(), mapB: m.get("b"), setHas20: st.has(20), setSize: st.size})');

// snapshot, genuine evict, cold restore into a NEW vm
const img = s.dump();
s.dispose();
await s.restore(img);
const genAfter = s.generation;

// after cold restore: closure continues, Map/Set intact, pending promise still pending
// then resolve it and let microtask run to prove the promise survived as a live object.
const after = s.eval('JSON.stringify({next: inc(), mapB: m.get("b"), setHas20: st.has(20), setSize: st.size, pendStateBefore: pendState})');
s.eval('__resolve(99);');
// drain the VM job queue so the .then() runs (eval does not auto-pump jobs)
s.vm.executePendingJobs();
const promiseFinal = s.eval('pendState');

s.dispose();

// expectations:
//  - before: inc() == 43 (40 +2 prior +1 here); mapB 2; setHas20 true; setSize 3
//  - after cold restore: inc() == 44 (closure continued); map/set intact; pend still pending
//  - after resolve: pendState == "resolved:99"
const pass =
  before === JSON.stringify({ next: 43, mapB: 2, setHas20: true, setSize: 3 }) &&
  after === JSON.stringify({ next: 44, mapB: 2, setHas20: true, setSize: 3, pendStateBefore: 'pending' }) &&
  promiseFinal === 'resolved:99' &&
  genAfter === 2;

console.log(JSON.stringify({ before, after, promiseFinal, genAfter, pass }, null, 2));
process.exit(pass ? 0 : 1);
