// Demonstrate the EXACTLY ONE thing the hybrid sacrifices: the pure
// no-replay guarantee WITHIN the oplog window. We prove that side effects in
// replayed cells DO re-fire unless the host result is recorded+suppressed.
import { QuickJS } from './node_modules/quickjs-wasi/dist/index.js';
import { readFileSync } from 'node:fs';
const WASM = readFileSync(new URL('./node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
const mod = await WebAssembly.compile(WASM);

// A host "fetch" that has a REAL side effect (increments external counter).
let externalEffects = 0;
function install(vm, replayLog /* null = live */) {
  let idx = 0;
  const fn = vm.newFunction('fetchThing', function () {
    if (replayLog) { return vm.newNumber(replayLog[idx++]); } // suppressed: no re-fire
    externalEffects++;                                         // LIVE side effect
    return vm.newNumber(externalEffects);
  });
  vm.global.setProp('fetchThing', fn);
}

// live run: 1 full snapshot then 3 oplog cells each doing a fetch
const vm = await QuickJS.create(mod);
const recorded = [];
install(vm, null);
vm.evalCode(`globalThis.tot=0;`);
const snapRaw = QuickJS.serializeSnapshot(vm.snapshot()); // checkpoint here
const liveFetchBefore = externalEffects;
for (const src of [`tot+=fetchThing();tot`, `tot+=fetchThing();tot`, `tot+=fetchThing();tot`]) {
  vm.evalCode(src); vm.executePendingJobs();
}
// record what the host returned during those cells
for (let i = liveFetchBefore; i < externalEffects; i++) recorded.push(i + 1);
const liveTot = vm.dump(vm.evalCode('tot'));
vm.dispose();
const effectsAfterLive = externalEffects;

console.log('# Oplog-window tradeoff proof\n');
console.log(`Live run: tot=${liveTot}, external side-effects fired = ${effectsAfterLive}`);

// RESTORE NAIVE (replay WITHOUT recorded results) -> side effects RE-FIRE
externalEffects = 0; // pretend fresh process; external world is fresh
{
  const v = await QuickJS.restore(QuickJS.deserializeSnapshot(snapRaw), mod);
  install(v, null); // live host -> re-fires!
  for (const src of [`tot+=fetchThing();tot`,`tot+=fetchThing();tot`,`tot+=fetchThing();tot`]) { v.evalCode(src); v.executePendingJobs(); }
  console.log(`\nNAIVE replay (no recorded results): side-effects re-fired = ${externalEffects}  <-- DOUBLE-FIRE, violates no-replay`);
  v.dispose();
}

// RESTORE WITH RECORDED RESULTS -> side effects SUPPRESSED, no re-fire
externalEffects = 0;
{
  const v = await QuickJS.restore(QuickJS.deserializeSnapshot(snapRaw), mod);
  install(v, recorded); // replay host fed recorded values -> NO re-fire
  for (const src of [`tot+=fetchThing();tot`,`tot+=fetchThing();tot`,`tot+=fetchThing();tot`]) { v.evalCode(src); v.executePendingJobs(); }
  const tot = v.dump(v.evalCode('tot'));
  console.log(`RECORDED replay (oplog stores host results): side-effects re-fired = ${externalEffects}, tot=${tot}  <-- suppressed, state matches (${tot===liveTot})`);
  v.dispose();
}
console.log('\nConclusion: the oplog MUST capture host-call results to keep no-replay-of-effects.');
console.log('What is genuinely lost: a CRASH mid-window replays cell SOURCE (CPU re-execution),');
console.log('and any effect NOT mediated by the recorded host boundary (e.g. direct nondeterminism');
console.log('inside the VM) would diverge. Within Engram all I/O already crosses host -> recordable.');
