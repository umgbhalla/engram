// EXP-5a test client. Drives the deployed DO over a hibernatable WebSocket to
// prove a QuickJS REPL namespace survives DO eviction via an R2 snapshot.
//
// Usage:
//   node test-client.mjs <wss-base-url> [mode]
//   mode = "sim"  (default) deterministic proof: explicit {t:'evict'} drop
//   mode = "cold" real cold-wake proof: idle gap to trigger hibernation eviction
//   mode = "both" run sim first, then cold (on a fresh session id)
//
// Each test opens a NEW WebSocket where eviction is being proven, because a
// reconnect after the idle gap is what surfaces the reconstructed DO.

import WebSocket from "ws";

const BASE =
  process.argv[2] || "wss://montydyn-exp5a.umg-bhalla88.workers.dev";
const MODE = process.argv[3] || "sim";
const IDLE_MS = Number(process.argv[4] || 70000);

function connect(sessionId) {
  const url = `${BASE}/ws?id=${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(url);
  const pending = [];
  let onMsg = null;
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (onMsg) {
      const cb = onMsg;
      onMsg = null;
      cb(msg);
    } else {
      pending.push(msg);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  function send(obj) {
    return new Promise((res) => {
      if (pending.length) return res(pending.shift());
      onMsg = res;
      ws.send(JSON.stringify(obj));
    });
  }
  return { ws, ready, send, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function setupAndSnapshot(sessionId) {
  log(`\n=== session "${sessionId}": setup + snapshot ===`);
  const c = connect(sessionId);
  await c.ready;

  const r1 = await c.send({
    t: "eval",
    src: "globalThis.x=42; globalThis.inc=()=>++x; x",
  });
  log("eval setup:", JSON.stringify(r1));

  const r2 = await c.send({ t: "eval", src: "x" });
  log("eval x (warm):", JSON.stringify(r2));

  const r3 = await c.send({ t: "snapshot" });
  log("snapshot:", JSON.stringify(r3));

  const r4 = await c.send({ t: "gen" });
  log("gen (warm, kernel present expected):", JSON.stringify(r4));

  return { c, genAtSnapshot: r4.generation, snap: r3 };
}

async function verifyRestore(c, label, expectColdReconstruct) {
  log(`\n--- verify after ${label} ---`);
  const g = await c.send({ t: "gen" });
  log("gen:", JSON.stringify(g));

  const ex = await c.send({ t: "eval", src: "x" });
  log('eval "x":', JSON.stringify(ex));

  const inc = await c.send({ t: "eval", src: "inc()" });
  log('eval "inc()":', JSON.stringify(inc));

  const pass =
    Number(ex.value) === 42 &&
    Number(inc.value) === 43 &&
    ex.restoredColdThisCall === true; // first eval did the cold restore

  log(
    `RESULT[${label}]: x=${ex.value} (want 42), inc()=${inc.value} (want 43), ` +
      `restoredColdThisCall=${ex.restoredColdThisCall}, ` +
      `restoreSource=${ex.restoreSource}, restoreLatencyMs=${ex.restoreLatencyMs}, ` +
      `kernelPresentBeforeEval=${ex.inMemoryKernelPresentBefore}, gen=${g.generation}`,
  );
  log(`>>> ${pass ? "PASS" : "FAIL"} (${label})`);
  return { pass, x: ex.value, inc: inc.value, gen: g.generation, restore: ex };
}

async function runSim() {
  const sessionId = `sim-${Date.now()}`;
  const { c, genAtSnapshot } = await setupAndSnapshot(sessionId);

  // Deterministic eviction: drop the in-memory kernel. DO is NOT reconstructed
  // (generation stays the same) but the live kernel is gone, forcing R2 restore.
  const ev = await c.send({ t: "evict" });
  log("\nevict:", JSON.stringify(ev));

  const gAfter = await c.send({ t: "gen" });
  log("gen after evict (kernel should be absent):", JSON.stringify(gAfter));
  if (gAfter.inMemoryKernelPresent !== false)
    log("WARN: expected in-memory kernel absent after evict");

  const res = await verifyRestore(c, "simulated drop", false);
  c.close();
  return { kind: "simulated", genAtSnapshot, ...res };
}

async function runCold() {
  const sessionId = `cold-${Date.now()}`;
  const { c, genAtSnapshot } = await setupAndSnapshot(sessionId);
  c.close(); // disconnect so the DO can go idle -> hibernate -> evict

  log(
    `\n=== idle gap ${IDLE_MS}ms to trigger hibernation/eviction (disconnected) ===`,
  );
  await sleep(IDLE_MS);

  // Reconnect on the SAME session id. If the DO was evicted, the constructor
  // re-runs (generation bumps) and the in-memory kernel is gone.
  const c2 = connect(sessionId);
  await c2.ready;

  const res = await verifyRestore(c2, "real cold wake", true);
  const reconstructed = res.gen > genAtSnapshot;
  log(
    `cold-wake DO reconstruction: genAtSnapshot=${genAtSnapshot} -> genNow=${res.gen} ` +
      `=> ${reconstructed ? "RECONSTRUCTED (real eviction)" : "NOT reconstructed (DO stayed warm)"}`,
  );
  c2.close();
  return { kind: "real", reconstructed, genAtSnapshot, ...res };
}

(async () => {
  log(`EXP-5a client -> ${BASE} mode=${MODE}`);
  const out = {};
  if (MODE === "sim" || MODE === "both") out.sim = await runSim();
  if (MODE === "cold" || MODE === "both") out.cold = await runCold();
  log("\n===== SUMMARY =====");
  log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error("CLIENT ERROR:", e);
  process.exit(1);
});
