// REAL-CF W4 byte-delta verify against the deployed engram-bench-w4 worker.
// Drives a 200-cell W-long-style session (steady object growth) twice:
//   1) W4 byte-delta path (delta per cell, full base every BASE_EVERY=20)
//   2) full-dump baseline (force full image every cell) on the IDENTICAL workload
// Records TOTAL durable gz bytes for each, the combined reduction ratio, the max
// delta-chain length (must stay BOUNDED at BASE_EVERY-1), and the cold-restore latency
// from a base+delta chain.
import WebSocket from "ws";

const BASE = process.argv[2] || "wss://engram-bench-w4.umg-bhalla88.workers.dev";
const CELLS = Number(process.argv[3] || 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(sessionId) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(sessionId)}`);
  const pending = [];
  let onMsg = null;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (onMsg) { const cb = onMsg; onMsg = null; cb(m); } else pending.push(m);
  });
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (obj) => new Promise((res) => {
    if (pending.length) return res(pending.shift());
    onMsg = res; ws.send(JSON.stringify(obj));
  });
  return { ws, ready, send, close: () => ws.close() };
}

async function runBench(id, baseline) {
  const c = connect(id);
  await c.ready;
  await c.send({ t: "reset" });
  await c.send({ t: "create", config: { clock: "seeded", rngSeed: 1 } });
  const t0 = Date.now();
  const r = await c.send({ t: "w4Bench", cells: CELLS, baseline });
  r._wallMs = Date.now() - t0;
  c.close();
  return r;
}

(async () => {
  const uid = Date.now().toString(36);
  console.log(`=== W4 byte-delta path (${CELLS} cells) ===`);
  const w4 = await runBench(`w4-${uid}`, false);
  console.log(`  totalStoredGz=${w4.totalStoredGz}  bases=${w4.fullBases} deltas=${w4.deltas} maxChainLen=${w4.maxChainLen}  wall=${w4._wallMs}ms`);

  await sleep(500);
  console.log(`=== full-dump BASELINE (${CELLS} full images) ===`);
  const bl = await runBench(`bl-${uid}`, true);
  console.log(`  totalStoredGz=${bl.totalStoredGz}  bases=${bl.fullBases} deltas=${bl.deltas}  wall=${bl._wallMs}ms`);

  const ratio = bl.totalStoredGz / w4.totalStoredGz;
  console.log(`\n=== REDUCTION ===`);
  console.log(`  baseline total = ${bl.totalStoredGz} B (${(bl.totalStoredGz/1e6).toFixed(3)} MB)`);
  console.log(`  W4 total       = ${w4.totalStoredGz} B (${(w4.totalStoredGz/1e6).toFixed(3)} MB)`);
  console.log(`  combined reduction = ${ratio.toFixed(2)}x  (target band 2.95–7.7x)`);
  console.log(`  delta-chain BOUNDED: maxChainLen=${w4.maxChainLen} (expect < BASE_EVERY=20)`);

  // restore-from-chain latency: drive a fresh session past one base + a few deltas,
  // evict (drop in-memory kernel), then a cold eval restores base+delta chain.
  console.log(`\n=== restore from base+delta chain ===`);
  const rid = `rst-${uid}`;
  const c = connect(rid);
  await c.ready;
  await c.send({ t: "reset" });
  await c.send({ t: "create", config: { clock: "seeded", rngSeed: 2 } });
  // 25 cells => one full base at cell0, deltas 1..19, forced base at 20, deltas 21..24 (chain ~5)
  let lastCkpt = null;
  for (let i = 0; i < 25; i++) {
    const m = await c.send({ t: "eval", src: `globalThis.S=globalThis.S||{};globalThis.S['k${i}']=${i}*3;Object.keys(globalThis.S).length` });
    lastCkpt = m.checkpoint || m;
  }
  const gBefore = await c.send({ t: "gen" });
  const valBefore = await c.send({ t: "eval", src: "Object.keys(globalThis.S).length" });
  await c.send({ t: "evict" });
  const gEvict = await c.send({ t: "gen" });
  const tR = Date.now();
  const restored = await c.send({ t: "eval", src: "Object.keys(globalThis.S).length" });
  const restoreMs = Date.now() - tR;
  const gAfter = await c.send({ t: "gen" });
  console.log(`  chain mode=${lastCkpt?.mode} deltaSeq=${lastCkpt?.deltaSeq}`);
  console.log(`  inMemBefore=${gBefore.inMemory} inMemAfterEvict=${gEvict.inMemory} restoreSource=${restored.restoreSource}`);
  console.log(`  value before evict=${valBefore.value}  after cold restore=${restored.value}  (must match)`);
  console.log(`  cold restore latency (base+delta chain) = ${restoreMs}ms`);
  c.close();

  console.log(`\n=== SUMMARY JSON ===`);
  console.log(JSON.stringify({
    cells: CELLS,
    baselineTotalGz: bl.totalStoredGz,
    w4TotalGz: w4.totalStoredGz,
    reductionX: Number(ratio.toFixed(3)),
    w4Bases: w4.fullBases, w4Deltas: w4.deltas, maxChainLen: w4.maxChainLen,
    chainBounded: w4.maxChainLen < 20,
    restoreFromChain: { mode: lastCkpt?.mode, deltaSeq: lastCkpt?.deltaSeq, valueMatch: restored.value === valBefore.value, restoreSource: restored.restoreSource, restoreMs },
  }, null, 2));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
