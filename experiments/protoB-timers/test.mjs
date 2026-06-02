import { TimerKernel } from './kernel.mjs';
import { SqliteSim, R2Sim } from './store.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const results = [];
const ok = (n, c, d = '') => { results.push({ n, c }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`); };

// fresh durable backends per test, but the SAME backend instances survive evict (that's the point)
function backends(tag) { return [new SqliteSim(), new R2Sim(join(__dir, '.r2-' + tag))]; }

const EPOCH = 1700000000000;

// ---------------------------------------------------------------------------
// TEST 1 — THE CORE TEST: setTimeout, snapshot, EVICT, cold-restore, advance, fired===1
// ---------------------------------------------------------------------------
{
  const [sq, r2] = backends('t1');
  let k = new TimerKernel(sq, r2, 's1');
  await k.create();
  k.eval(`globalThis.fired = 0; setTimeout(() => { globalThis.fired = (globalThis.fired||0) + 1; }, 5000);`);
  const beforeFired = k.eval('globalThis.fired');
  const cp = k.checkpoint();

  // GENUINE EVICTION: drop instance + scheduler
  k.evict();
  ok('T1 evicted (VM gone)', k.vm === null && k.inMemory === false);

  // COLD RESTORE into a brand-new kernel object too (no shared in-memory state)
  const k2 = new TimerKernel(sq, r2, 's1');
  const rs = await k2.restore();
  ok('T1 cold-restore reconstructed', k2.generation >= 1 && k2.inMemory, rs.source);
  ok('T1 timer not yet fired post-restore', k2.eval('globalThis.fired') === 0, `fired=${k2.eval('globalThis.fired')}`);

  // advance seeded clock past 5000 ticks
  k2.advanceClock(EPOCH + 6000);
  const fired = k2.eval('globalThis.fired');
  ok('T1 EXACTLY-ONCE across restore (fired===1)', fired === 1, `fired=${fired} cp=${JSON.stringify(cp)} before=${beforeFired}`);

  // advancing further must NOT re-fire (one-shot consumed)
  k2.advanceClock(EPOCH + 100000);
  ok('T1 no double-fire on further advance', k2.eval('globalThis.fired') === 1, `fired=${k2.eval('globalThis.fired')}`);
  k2.evict();
}

// ---------------------------------------------------------------------------
// TEST 2 — setInterval fires N times deterministically (across an evict mid-stream)
// ---------------------------------------------------------------------------
{
  const [sq, r2] = backends('t2');
  let k = new TimerKernel(sq, r2, 's2');
  await k.create();
  k.eval(`globalThis.ticks = []; setInterval(() => { globalThis.ticks.push(globalThis.__nowTick); }, 1000);`);
  // warm fire twice (advance to +2500 => fires at 1000, 2000)
  k.advanceClock(EPOCH + 2500);
  ok('T2 interval fired 2x warm', JSON.stringify(k.eval('globalThis.ticks')) === JSON.stringify([EPOCH + 1000, EPOCH + 2000]),
     JSON.stringify(k.eval('globalThis.ticks')));
  k.checkpoint();
  k.evict();

  const k2 = new TimerKernel(sq, r2, 's2');
  await k2.restore();
  // advance to +5500 => should fire at 3000,4000,5000  (NOT re-fire 1000/2000)
  k2.advanceClock(EPOCH + 5500);
  const ticks = k2.eval('globalThis.ticks');
  ok('T2 interval deterministic 5 total, no replay of old fires',
     JSON.stringify(ticks) === JSON.stringify([EPOCH+1000,EPOCH+2000,EPOCH+3000,EPOCH+4000,EPOCH+5000]),
     JSON.stringify(ticks));
  k2.evict();
}

// ---------------------------------------------------------------------------
// TEST 3 — timer cleared before fire never fires (across restore)
// ---------------------------------------------------------------------------
{
  const [sq, r2] = backends('t3');
  let k = new TimerKernel(sq, r2, 's3');
  await k.create();
  k.eval(`globalThis.fired = 0; globalThis.tid = setTimeout(() => { globalThis.fired++; }, 5000);`);
  k.eval(`clearTimeout(globalThis.tid);`);
  k.checkpoint();
  k.evict();
  const k2 = new TimerKernel(sq, r2, 's3');
  await k2.restore();
  k2.advanceClock(EPOCH + 100000);
  ok('T3 cleared timer never fires across restore', k2.eval('globalThis.fired') === 0, `fired=${k2.eval('globalThis.fired')}`);
  // registry should be empty (no orphan rows)
  const reg = sq.getManifest('s3:timers') || {};
  ok('T3 no orphan registry rows', Object.keys(reg).length === 0, JSON.stringify(reg));
  k2.evict();
}

// ---------------------------------------------------------------------------
// TEST 4 — DETERMINISM: two independent runs through evict produce byte-identical heap snapshots
// ---------------------------------------------------------------------------
{
  async function run(tag) {
    const [sq, r2] = backends('t4' + tag);
    const k = new TimerKernel(sq, r2, 's4');
    await k.create();
    k.eval(`globalThis.log=[]; setInterval(()=>{globalThis.log.push(globalThis.__nowTick)},700); setTimeout(()=>{globalThis.log.push('once')},1500);`);
    k.advanceClock(EPOCH + 2200);
    k.checkpoint();
    k.evict();
    const k2 = new TimerKernel(sq, r2, 's4');
    await k2.restore();
    k2.advanceClock(EPOCH + 4000);
    const cp = k2.checkpoint();
    const blob = sq.getManifest('s4:snapmeta');
    // hash the stored heap bytes
    const { createHash } = await import('node:crypto');
    const gz = sq.getBlob('s4.heap');
    return { hash: createHash('sha256').update(Buffer.from(gz)).digest('hex'), log: k2.eval('globalThis.log'), gz: blob.gzLen };
  }
  const a = await run('a'); const b = await run('b');
  ok('T4 deterministic firing order/values', JSON.stringify(a.log) === JSON.stringify(b.log), JSON.stringify(a.log));
  ok('T4 byte-identical heap snapshot across independent runs', a.hash === b.hash, `${a.hash.slice(0,16)} vs ${b.hash.slice(0,16)}`);
}

// ---------------------------------------------------------------------------
// TEST 5 — long real-hibernation mapping: a timer due during the "sleep" fires once on wake,
//          even if many virtual ms elapsed; verify no per-elapsed-ms duplicate and exactly-once.
// ---------------------------------------------------------------------------
{
  const [sq, r2] = backends('t5');
  const k = new TimerKernel(sq, r2, 's5');
  await k.create();
  k.eval(`globalThis.fired=0; setTimeout(()=>{globalThis.fired++}, 3000);`);
  k.checkpoint();
  k.evict();
  // "real hibernation" of arbitrary length; on alarm wake we map elapsed -> +50000 virtual ticks
  const k2 = new TimerKernel(sq, r2, 's5');
  const rs = await k2.restore();
  k2.advanceClock(EPOCH + 50000);   // huge jump past the 3000 due time in ONE alarm
  ok('T5 due-during-sleep timer fires exactly once on wake', k2.eval('globalThis.fired') === 1,
     `fired=${k2.eval('globalThis.fired')} via ${rs.source}`);
  k2.evict();
}

// ---------------------------------------------------------------------------
// TEST 6 — combined host+VM state coherence + no double-fire of side effect across restore.
//   The timer callback writes to host.kv (persisted in manifest). Prove the kv side effect fires
//   exactly once even though we evict between schedule and fire.
// ---------------------------------------------------------------------------
{
  const [sq, r2] = backends('t6');
  const k = new TimerKernel(sq, r2, 's6');
  await k.create();
  // host.kv shim backed by manifest, exposed in VM via a host callback
  const kvWrite = k.vm.newFunction('__kvIncr', (keyH) => {
    const key = k.vm.dump(keyH);
    const kv = sq.getManifest('s6:kv') || {};
    kv[key] = (kv[key] || 0) + 1;
    sq.putManifest('s6:kv', kv);
    return k.vm.hostToHandle(kv[key]);
  });
  k.vm.setProp(k.vm.global, '__kvIncr', kvWrite);
  k.eval(`setTimeout(() => { __kvIncr('hits'); }, 2000);`);
  k.checkpoint();
  k.evict();

  const k2 = new TimerKernel(sq, r2, 's6');
  await k2.restore();
  // rebind the kv host callback after restore (host handle died on evict)
  k2.vm.registerHostCallback('__kvIncr', (keyH) => {
    const key = k2.vm.dump(keyH);
    const kv = sq.getManifest('s6:kv') || {};
    kv[key] = (kv[key] || 0) + 1;
    sq.putManifest('s6:kv', kv);
    return k2.vm.hostToHandle(kv[key]);
  });
  k2.advanceClock(EPOCH + 5000);
  const kv = sq.getManifest('s6:kv') || {};
  ok('T6 host-side side effect fired exactly once across restore', kv.hits === 1, `kv=${JSON.stringify(kv)}`);
  // fire window again — must not re-fire
  k2.advanceClock(EPOCH + 9000);
  ok('T6 no double side-effect on further advance', (sq.getManifest('s6:kv')||{}).hits === 1, JSON.stringify(sq.getManifest('s6:kv')));
  k2.evict();
}

// ---------------------------------------------------------------------------
console.log('\n=== SUMMARY ===');
const passed = results.filter(r => r.c).length;
console.log(`${passed}/${results.length} PASS`);
process.exit(passed === results.length ? 0 : 1);
