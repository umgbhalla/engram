// EXP-4b test client. Drives the deployed RUST Durable Object over a hibernatable
// WebSocket. Proves BOTH paths:
//   path-a: pure-Rust nested-wasm memory+global snapshot/restore (also via HTTP)
//   path-b: Rust DO shell + JS glue (quickjs-wasi) real QuickJS namespace survives
//           eviction via an R2 snapshot.
//
// Usage: node test-client.mjs <wss-base> [sim|cold|both] [idleMs]

import WebSocket from "ws";

const BASE = process.argv[2] || "wss://montydyn-exp4b.umg-bhalla88.workers.dev";
const MODE = process.argv[3] || "both";
const IDLE_MS = Number(process.argv[4] || 70000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

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

async function setupAndSnapshot(sessionId) {
  log(`\n=== session "${sessionId}": setup + snapshot (path-b) ===`);
  const c = connect(sessionId);
  await c.ready;
  log("eval setup:", JSON.stringify(await c.send({ t: "eval", src: "globalThis.x=42; globalThis.inc=()=>++x; x" })));
  log("eval x (warm):", JSON.stringify(await c.send({ t: "eval", src: "x" })));
  const snap = await c.send({ t: "snapshot" });
  log("snapshot:", JSON.stringify(snap));
  const g = await c.send({ t: "gen" });
  log("gen (warm):", JSON.stringify(g));
  return { c, genAtSnapshot: g.generation, snap };
}

async function verify(c, label) {
  log(`\n--- verify after ${label} ---`);
  const g = await c.send({ t: "gen" });
  log("gen:", JSON.stringify(g));
  const ex = await c.send({ t: "eval", src: "x" });
  log('eval "x":', JSON.stringify(ex));
  const inc = await c.send({ t: "eval", src: "inc()" });
  log('eval "inc()":', JSON.stringify(inc));
  const pass = Number(ex.value) === 42 && Number(inc.value) === 43;
  log(`>>> ${pass ? "PASS" : "FAIL"} (${label}): x=${ex.value} inc()=${inc.value} restoreSource=${ex.restoreSource} gen=${g.generation}`);
  return { pass, x: ex.value, inc: inc.value, gen: g.generation, restoreSource: ex.restoreSource };
}

async function runPathA(c) {
  log("\n=== path-a (pure-Rust nested memory access) over WS ===");
  const r = await c.send({ t: "path-a" });
  log("path-a:", JSON.stringify(r));
  return r.result;
}

async function runSim() {
  const sessionId = `sim-${Date.now()}`;
  const { c, genAtSnapshot } = await setupAndSnapshot(sessionId);
  const pathA = await runPathA(c);
  log("\nevict:", JSON.stringify(await c.send({ t: "evict" })));
  log("gen after evict:", JSON.stringify(await c.send({ t: "gen" })));
  const res = await verify(c, "simulated drop");
  c.close();
  return { kind: "simulated", genAtSnapshot, pathA, ...res };
}

async function runCold() {
  const sessionId = `cold-${Date.now()}`;
  const { c, genAtSnapshot } = await setupAndSnapshot(sessionId);
  c.close();
  log(`\n=== idle ${IDLE_MS}ms to trigger hibernation/eviction (disconnected) ===`);
  await sleep(IDLE_MS);
  const c2 = connect(sessionId);
  await c2.ready;
  const res = await verify(c2, "real cold wake");
  const reconstructed = res.gen > genAtSnapshot;
  log(`cold-wake reconstruction: gen ${genAtSnapshot} -> ${res.gen} => ${reconstructed ? "RECONSTRUCTED (real eviction)" : "stayed warm"}`);
  c2.close();
  return { kind: "real", reconstructed, genAtSnapshot, ...res };
}

(async () => {
  log(`EXP-4b client -> ${BASE} mode=${MODE}`);
  const out = {};
  if (MODE === "sim" || MODE === "both") out.sim = await runSim();
  if (MODE === "cold" || MODE === "both") out.cold = await runCold();
  log("\n===== SUMMARY =====");
  log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => { console.error("CLIENT ERROR:", e); process.exit(1); });
