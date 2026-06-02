import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'wss://engram-bench-w4.umg-bhalla88.workers.dev';

function connect(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${id}`);
  const q = [];
  let waiter = null;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (waiter) { const w = waiter; waiter = null; w(m); } else q.push(m);
  });
  return {
    ws,
    open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (o) => new Promise((res) => {
      const take = () => { if (q.length) res(q.shift()); else waiter = res; };
      ws.send(JSON.stringify(o)); take();
    }),
    close: () => ws.close(),
  };
}
const evalCell = (c, src, config) => c.send({ t: 'eval', src, ...(config ? { config } : {}) });

const results = [];
function rec(name, pass, detail) { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); }

// TEST 1: fidelity over a base+DELTA chain. Build state, then mutate across several
// cells (each appends a per-cell byte-delta on top of the base), THEN evict and cold-restore.
// Verifies closure counter + pending promise + Map/Set survive a base+delta-chain reconstruction.
async function test1_fidelity() {
  const id = 'w4-fid-' + Date.now();
  const c = connect(id);
  await c.open();
  await c.send({ t: 'create', config: { clock: 'seeded', rngSeed: 42 } });
  await evalCell(c, `
    globalThis.mk = (function(){ let n = 10; return () => ++n; })();
    globalThis.inc = mk;
    globalThis.pend = new Promise(r => { globalThis.resolvePend = r; });
    globalThis.pendResolved = null;
    globalThis.pend.then(v => { globalThis.pendResolved = v; });
    globalThis.m = new Map([['a',1],['b',2]]);
    globalThis.s = new Set([7,8,9]);
    inc(); 'built'`);  // n -> 11  (base or first delta)
  // Several small mutating cells => delta chain grows on top of the base.
  let lastCk = null;
  for (let i = 0; i < 5; i++) {
    const r = await evalCell(c, `inc(); m.set('k${i}', ${i}); s.add(${100 + i}); 'm${i}'`);
    lastCk = r.checkpoint;
  }
  // After base + 5 mutating cells, inc() called 1 + 5 = 6 times after init => n = 10 -> 16, last inc returns... track:
  // built: inc()->11. loop i0..4: inc() => 12,13,14,15,16. So next inc()===17.
  const beforeGen = await c.send({ t: 'gen' });
  await c.send({ t: 'evict' });
  const evGen = await c.send({ t: 'gen' });
  // Cold restore via eval: reconstructs base + delta chain.
  const m1 = await evalCell(c, `JSON.stringify([typeof inc==='function', inc(), [...m.entries()], [...s.values()], typeof resolvePend, pendResolved])`);
  const afterGen = await c.send({ t: 'gen' });
  const val = JSON.parse(m1.value);
  await evalCell(c, `resolvePend('RESOLVED-AFTER-RESTORE'); 'kick'`);
  const m2 = await evalCell(c, `pendResolved`);

  const restored = beforeGen.inMemory === true && evGen.inMemory === false && /restore/.test(m1.restoreSource || '') && afterGen.inMemory === true;
  const okClosure = val[0] === true && val[1] === 17;
  const expM = [['a',1],['b',2],['k0',0],['k1',1],['k2',2],['k3',3],['k4',4]];
  const okMap = JSON.stringify(val[2]) === JSON.stringify(expM);
  const okSet = JSON.stringify(val[3]) === JSON.stringify([7,8,9,100,101,102,103,104]);
  const okPend = val[4] === 'function' && m2.value === 'RESOLVED-AFTER-RESTORE';

  rec('1.fidelity: cold restore via base+delta-chain (evict dropped in-mem, restored)', restored,
    `inMemAfterEvict=${evGen.inMemory} restoreSource=${m1.restoreSource} lastCkMode=${lastCk && lastCk.mode} deltaSeq=${lastCk && lastCk.deltaSeq}`);
  rec('1.fidelity: closure counter survives chain (inc()===17)', okClosure, JSON.stringify(val.slice(0,2)));
  rec('1.fidelity: Map survives (base + 5 deltas)', okMap, JSON.stringify(val[2]));
  rec('1.fidelity: Set survives (base + 5 deltas)', okSet, JSON.stringify(val[3]));
  rec('1.fidelity: pending promise + resolver survive & resolve post-restore', okPend, `resolver=${val[4]} resolved=${m2.value}`);
  // Surface that deltas actually happened (W4 not collapsing to full every cell)
  rec('1.fidelity: a delta chain was built (>=1 delta mode checkpoint)', (lastCk && lastCk.deltaSeq > 0) || (lastCk && lastCk.mode === 'delta'),
    `lastCk=${JSON.stringify(lastCk)}`);
  c.close();
}

// TEST 2: W5 regression — spike-then-free still checkpoints (W4 did not regress un-wedge).
async function test2_w5_regression() {
  const id = 'w4-wedge-' + Date.now();
  const c = connect(id);
  await c.open();
  await c.send({ t: 'create', config: { clock: 'seeded', rngSeed: 123, cellBudgetTicks: 200000 } });
  await evalCell(c, `globalThis.keep = 'before-spike'; 'p1'`);
  const w = await c.send({ t: 'wedgeTest', spikeMb: 22 });
  const checkpointed = w && w.checkpoint && w.checkpoint.ok !== false && (w.checkpoint.sizeGz !== undefined || w.checkpoint.store);
  rec('2.w5-regression: spike-then-free still checkpoints (no SizeAdmissionError / un-wedge intact)', !!checkpointed,
    `wedge=${JSON.stringify({ckpt: w.checkpoint, spiked: w.memSpiked, freed: w.memFreed})}`);
  // And the session still cold-restores after the wedge.
  await c.send({ t: 'evict' });
  const r = await evalCell(c, `keep`);
  rec('2.w5-regression: session survives evict→cold-restore after wedge', r.value === 'before-spike',
    `value=${r.value} restoreSource=${r.restoreSource}`);
  c.close();
}

// TEST 3: determinism — two seeded sessions, identical program -> byte-identical stored image.
async function test3_determinism() {
  async function run(id) {
    const c = connect(id);
    await c.open();
    await c.send({ t: 'create', config: { clock: 'seeded', rngSeed: 555, cellBudgetTicks: 200000 } });
    let ck = null;
    for (let i = 0; i < 4; i++) {
      const r = await evalCell(c, `
        globalThis.acc = (globalThis.acc||[]);
        for (let j=0;j<50;j++){ acc.push(Math.random()); }
        globalThis.sum = acc.reduce((a,b)=>a+b,0);
        'c${i}'`);
      ck = r.checkpoint;
    }
    c.close();
    return ck;
  }
  const a = await run('w4-det-A-' + Date.now());
  const b = await run('w4-det-B-' + Date.now());
  const norm = (ck) => { if (!ck) return 'null'; const x = { ...ck }; delete x.r2Key; delete x.r2Url; return JSON.stringify(x); };
  const na = norm(a), nb = norm(b);
  rec('3.determinism: two seeded sessions -> byte-identical checkpoint image', na === nb && a && a.ok !== false,
    `A=${na} B=${nb}`);
}

(async () => {
  try { await test1_fidelity(); await test2_w5_regression(); await test3_determinism(); }
  catch (e) { console.error('ERROR', e); rec('harness', false, String(e)); }
  const fails = results.filter(r => !r.pass);
  console.log(`\n==== ${results.length - fails.length}/${results.length} PASS ====`);
  process.exit(fails.length ? 1 : 0);
})();
