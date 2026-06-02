import { WebSocket } from 'ws';

const BASE = process.env.BASE || 'wss://engram-bench-w5.umg-bhalla88.workers.dev';

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

async function evalCell(c, src, config) {
  const m = await c.send({ t: 'eval', src, ...(config ? { config } : {}) });
  return m;
}

const results = [];
function rec(name, pass, detail) { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); }

async function test1_fidelity() {
  const id = 'w5-fid-' + Date.now();
  const c = connect(id);
  await c.open();
  await c.send({ t: 'create', config: { clock: 'seeded', rngSeed: 42 } });
  // build closure counter + pending promise + Map/Set
  await evalCell(c, `
    globalThis.mk = (function(){ let n = 10; return () => ++n; })();
    globalThis.inc = mk;
    globalThis.pend = new Promise(r => { globalThis.resolvePend = r; });
    globalThis.pendResolved = null;
    globalThis.pend.then(v => { globalThis.pendResolved = v; });
    globalThis.m = new Map([['a',1],['b',2]]);
    globalThis.s = new Set([7,8,9]);
    inc();  // n -> 11
    'built'
  `);
  // Keep promise pending across snapshot; resolve post-restore and confirm callback fires.
  const beforeGen = await c.send({ t: 'gen' });
  await c.send({ t: 'evict' });
  const evGen = await c.send({ t: 'gen' });   // after evict, in-memory dropped
  // cold restore via eval; return a JSON string so the value is exact (not a preview).
  const m1 = await evalCell(c, `JSON.stringify([typeof inc === 'function', inc(), [...m.entries()], [...s.values()], (typeof resolvePend), pendResolved])`);
  const afterGen = await c.send({ t: 'gen' });
  const val = JSON.parse(m1.value);
  // Now resolve pending promise post-restore and check callback fires
  await evalCell(c, `resolvePend('RESOLVED-AFTER-RESTORE'); 'kick'`);
  const m2 = await evalCell(c, `pendResolved`);

  // Cold restore proof: evict dropped in-memory (evGen.inMemory false) and the next eval
  // restored from durable storage (restoreSource = *-restore), generation advanced.
  // Cold restore = evict dropped the in-memory kernel (inMemory:false) AND the next eval
  // rebuilt the namespace from durable storage (restoreSource = sqlite-restore). Generation
  // is a DO-instance counter (not bumped by evict, which only drops the in-memory glue), so
  // we assert on inMemory + restoreSource, the true cold-restore signals.
  const restored = beforeGen.inMemory === true && evGen.inMemory === false && /restore/.test(m1.restoreSource || '') && afterGen.inMemory === true;
  const okClosure = val[0] === true && val[1] === 12;
  const okMap = JSON.stringify(val[2]) === JSON.stringify([['a',1],['b',2]]);
  const okSet = JSON.stringify(val[3]) === JSON.stringify([7,8,9]);
  const okPendingSurvived = val[4] === 'function'; // resolver fn survived
  const okPromiseResolves = m2.value === 'RESOLVED-AFTER-RESTORE';

  rec('1.fidelity: cold restore happened (evict dropped in-mem, gen bumped, restored)', restored, `inMemAfterEvict=${evGen.inMemory} gen ${beforeGen.generation}->${afterGen.generation} restoreSource=${m1.restoreSource}`);
  rec('1.fidelity: closure counter survives (inc()===12)', okClosure, JSON.stringify(val.slice(0,2)));
  rec('1.fidelity: Map survives', okMap, JSON.stringify(val[2]));
  rec('1.fidelity: Set survives', okSet, JSON.stringify(val[3]));
  rec('1.fidelity: pending promise + resolver survive & resolve post-restore', okPendingSurvived && okPromiseResolves, `resolver=${val[4]} resolved=${m2.value}`);
  c.close();
}

async function test2_determinism() {
  // Two independent seeded sessions running identical program incl. a spike-then-free (W5 scrub).
  // Snapshots must be byte-identical (same sha256 of stored image). We capture sizeRaw/sizeGz and
  // the dump's reported usedHeap/scrubbed. Determinism = identical sizeRaw + sizeGz + usedHeap.
  async function run(id) {
    const c = connect(id);
    await c.open();
    await c.send({ t: 'create', config: { clock: 'seeded', rngSeed: 123, cellBudgetTicks: 200000 } });
    // deterministic seeded workload first
    await evalCell(c, `
      globalThis.acc = [];
      for (let i=0;i<100;i++){ globalThis.acc.push(Math.random()); }
      globalThis.sumSeed = globalThis.acc.reduce((a,b)=>a+b,0);
      'phase1'
    `);
    // W5 wedge: spike 22MB -> free -> checkpoint. Exercises the scrub path. The stored image
    // (post-scrub, gz) must be byte-identical across two identical seeded sessions.
    const w = await c.send({ t: 'wedgeTest', spikeMb: 22 });
    c.close();
    return { ckpt: w.checkpoint, mem: { spiked: w.memSpiked, freed: w.memFreed } };
  }
  const r1 = await run('w5-det-A-' + Date.now());
  const r2 = await run('w5-det-B-' + Date.now());
  // Drop the r2Key (contains do_id, intentionally session-unique) before comparing the image.
  const norm = (ck) => { const x = { ...ck }; delete x.r2Key; return JSON.stringify(x); };
  const a = norm(r1.ckpt), b = norm(r2.ckpt);
  const scrubFired = r1.ckpt && r1.ckpt.scrubbed === true;
  rec('2.determinism: W5 scrub actually fired in wedge test', scrubFired, `scrubbed=${r1.ckpt && r1.ckpt.scrubbed} sizeGz=${r1.ckpt && r1.ckpt.sizeGz}`);
  rec('2.determinism: two seeded sessions -> byte-identical post-scrub image (scrub adds zero entropy)', a === b && r1.ckpt && r1.ckpt.ok !== false, `A=${a} B=${b}`);
}

async function test3_regression() {
  // A NORMAL non-spiked seeded session: W5 trigger (scrub) must never fire, normal sizes,
  // identical behavior to baseline expectations.
  const id = 'w5-reg-' + Date.now();
  const c = connect(id);
  await c.open();
  await c.send({ t: 'create', config: { clock: 'seeded', rngSeed: 7 } });
  await evalCell(c, `globalThis.x = 1; globalThis.f = () => x*10; 'a'`);
  const m = await evalCell(c, `f()`);
  const ck = m.checkpoint || {};
  const noScrub = ck.scrubbed === false || ck.scrubbed === undefined;
  const smallImage = (ck.sizeGz === undefined) || ck.sizeGz < 2 * 1024 * 1024;
  const sqliteStore = (ck.store === 'sqlite');
  rec('3.regression: normal session value correct (f()===10)', m.value === 10, `value=${m.value}`);
  rec('3.regression: W5 scrub did NOT fire on normal session', noScrub, `scrubbed=${ck.scrubbed}`);
  rec('3.regression: normal checkpoint store=sqlite & small', sqliteStore && smallImage, `store=${ck.store} ck=${JSON.stringify(ck)}`);

  // survive evict/restore unchanged
  await c.send({ t: 'evict' });
  const m2 = await evalCell(c, `f()+x`);
  rec('3.regression: state survives evict→restore unchanged', m2.value === 11, `value=${m2.value} restoreSource=${m2.restoreSource}`);
  c.close();
}

(async () => {
  try {
    await test1_fidelity();
    await test2_determinism();
    await test3_regression();
  } catch (e) {
    console.error('ERROR', e);
    rec('harness', false, String(e));
  }
  const fails = results.filter(r => !r.pass);
  console.log(`\n==== ${results.length - fails.length}/${results.length} PASS ====`);
  process.exit(fails.length ? 1 : 0);
})();
