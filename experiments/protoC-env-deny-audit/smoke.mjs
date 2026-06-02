// Smoke: env frozen + host.fs + timers + the CRITICAL eviction/cold-restore coherence test.
import { createKernel, restoreKernel, takeSnapshot, evalCell } from './kernel.mjs';
import { SqliteSim, R2Sim, HostFs, storeSnapshot, loadSnapshot, makeHostState } from './host.mjs';

const SID = 'sess-A';
function freshCtx(sqlite, r2) {
  const state = makeHostState();
  return {
    state, sessionId: SID,
    fs: new HostFs(sqlite, SID),
    kv: {},
    fetchAllow: ['api.example.com'],
    timers: { pending: {}, max: 64 },
  };
}

const sqlite = new SqliteSim();
const r2 = new R2Sim(new URL('./r2', import.meta.url).pathname);
let ctx = freshCtx(sqlite, r2);
let vm = await createKernel({ env: { TIER: 'pro', REGION: 'us', secrets: { k: 1 } } }, ctx);

const log = [];
const t = (name, cond, extra='') => { log.push((cond?'PASS':'FAIL')+' '+name+(extra?' :: '+extra:'')); };

// env frozen + readable
t('env readable', evalCell(vm, 'env.TIER').value === 'pro');
t('process.env shim', evalCell(vm, 'process.env.REGION').value === 'us');
t('env write rejected (silent strict-less)', evalCell(vm, '"use strict"; try{env.TIER="x"; "nothrow"}catch(e){e.name}').value === 'TypeError');
t('env still pro after write attempt', evalCell(vm, 'env.TIER').value === 'pro');
t('env deep-frozen', evalCell(vm, 'Object.isFrozen(env.secrets)').value === true);

// host.fs round-trip + state spanning VM heap AND host side
evalCell(vm, 'globalThis.counter = 41');
t('fs.write', evalCell(vm, 'host.fs.write("/notes/a.txt", "hello-"+(++counter))').ok);
t('fs.read', evalCell(vm, 'host.fs.read("/notes/a.txt")').value === 'hello-42');
t('counter in heap', evalCell(vm, 'counter').value === 42);

// kv (manifest-persisted host state)
evalCell(vm, 'host.kv.set("seen", true)');
// timers (host-mediated)
t('timer arm', evalCell(vm, 'globalThis.fired=0; setTimeout(()=>{fired++},5); typeof __pendingTimers').value === 'object');

// deterministic clock/RNG
const r1 = evalCell(vm, '[Date.now(), Math.random()]').value;

// ---- snapshot ----
const snapBytes = takeSnapshot(vm);
const manifest = { sessionId: SID, kv: ctx.kv, rngState: ctx.state.rngState, clockMs: ctx.state.clockMs,
  entropy: ctx.state.entropy, timers: ctx.timers };
const stored = storeSnapshot(sqlite, r2, SID, snapBytes, manifest);
log.push('INFO snapshot source='+stored.source+' sizeGz='+stored.sizeGz);

// ---- SIMULATE GENUINE EVICTION: drop the instance + the in-memory host scheduler ----
vm.dispose(); vm = null; ctx = null;

// ---- COLD RESTORE: fresh instance + blit heap + RE-BIND host from durable storage ----
const { snapBytes: rb, manifest: rm } = loadSnapshot(sqlite, r2, SID);
const ctx2 = freshCtx(sqlite, r2);
// re-hydrate durable host state from manifest (kv, rng/clock, entropy, timers)
ctx2.kv = rm.kv; ctx2.state.rngState = rm.rngState; ctx2.state.clockMs = rm.clockMs;
ctx2.state.entropy = rm.entropy; ctx2.timers = rm.timers;
const vm2 = await restoreKernel(rb, {}, ctx2);

// coherence: VM heap survived
t('[restore] counter survived heap', evalCell(vm2, 'counter').value === 42);
t('[restore] env survived heap', evalCell(vm2, 'env.TIER').value === 'pro');
t('[restore] env still frozen', evalCell(vm2, 'Object.isFrozen(env)').value === true);
// host.fs re-bound to SAME durable storage (file written pre-eviction is readable)
t('[restore] fs.read across eviction', evalCell(vm2, 'host.fs.read("/notes/a.txt")').value === 'hello-42');
// kv re-bound
t('[restore] kv across eviction', evalCell(vm2, 'host.kv.get("seen")').value === true);
// determinism: continuing RNG/clock from rehydrated state, no re-fire
const r2v = evalCell(vm2, '[Date.now(), Math.random()]').value;
t('[restore] clock advanced (no reset)', r2v[0] > r1[0]);
t('[restore] no double-fire: fs file count == 1', evalCell(vm2, 'host.fs.list().length').value === 1);
// write a new file post-restore, ensure isolation key still namespaced
evalCell(vm2, 'host.fs.write("/notes/b.txt","world")');
t('[restore] new write isolated under session', sqlite.list('fs:sess-A:/notes/b.txt').length === 1);

console.log(log.join('\n'));
const fails = log.filter(l=>l.startsWith('FAIL'));
console.log('\n'+(log.filter(l=>l.startsWith('PASS')).length)+' PASS / '+fails.length+' FAIL');
if (fails.length) process.exit(1);
