// EXP-9 test client. Two hypotheses against the deployed DO:
//
//  (1) CRASH-ROBUSTNESS: checkpoint after each cell; run an UNCHECKPOINTED cell;
//      {t:'crash'} abrupt eviction (no clean snapshot); reconnect; verify state
//      recovers at the LAST COMMITTED cell (uncheckpointed cell is correctly lost).
//
//  (2) UPGRADE GUARD: force a cold restore while pretending the running engine is a
//      different (v2) build; verify a typed EngineHashMismatchError rejection with
//      NO corruption (kernel left null, no memory blitted). Then verify a restore
//      with the REAL hash still succeeds.
//
// Usage: node test-client.mjs <wss-base-url>

import WebSocket from "ws";

const BASE = process.argv[2] || "wss://montydyn-exp9.umg-bhalla88.workers.dev";

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
    } else pending.push(msg);
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
const log = (...a) => console.log(...a);

async function runCrash() {
  const sessionId = `crash-${Date.now()}`;
  log(`\n===== HYPOTHESIS 1: CRASH-ROBUSTNESS (session ${sessionId}) =====`);
  const c = connect(sessionId);
  await c.ready;

  // Cell 0: define state. Cell 1: advance it. Each is checkpointed move-forward.
  const c0 = await c.send({ t: "cell", cell: 0, src: "globalThis.acc=0; globalThis.step=()=>++acc; acc" });
  log("cell0 (checkpointed):", JSON.stringify(c0.checkpoint), "value=", c0.value);
  const c1 = await c.send({ t: "cell", cell: 1, src: "step(); step(); acc" }); // acc=2
  log("cell1 (checkpointed):", JSON.stringify(c1.checkpoint), "value=", c1.value);

  // Cell 2: run but DO NOT checkpoint. This work is "in flight", not yet committed.
  const c2 = await c.send({ t: "cellNoCheckpoint", src: "step(); step(); step(); acc" }); // acc=5 in-memory only
  log("cell2 (NOT checkpointed): value=", c2.value, "committedCell=", c2.committedCell);

  // ABRUPT crash: drop in-memory kernel with no clean snapshot.
  const crash = await c.send({ t: "crash" });
  log("crash:", JSON.stringify(crash));

  // Recover: first eval cold-restores from last committed checkpoint (cell 1, acc=2).
  const r = await c.send({ t: "eval", src: "acc" });
  log("recover eval acc:", JSON.stringify(r));
  const r2 = await c.send({ t: "eval", src: "step()" }); // acc=3 (closure survived)
  log("recover eval step():", JSON.stringify(r2));

  c.close();

  const pass =
    Number(r.value) === 2 && // recovered at last COMMITTED cell (cell1), not the lost cell2 (acc=5)
    r.restoredColdThisCall === true &&
    r.restoreSource === "checkpoint-restore" &&
    r.restoredFromCell === 1 &&
    Number(r2.value) === 3; // closure intact post-restore
  log(
    `RESULT[crash]: acc=${r.value} (want 2, last committed), restoredFromCell=${r.restoredFromCell} (want 1), ` +
      `source=${r.restoreSource}, latencyMs=${r.restoreLatencyMs}, step()=${r2.value} (want 3)`,
  );
  log(`>>> ${pass ? "PASS" : "FAIL"} (crash-robustness)`);
  return { pass, recoveredAcc: r.value, restoredFromCell: r.restoredFromCell, latencyMs: r.restoreLatencyMs, stepAfter: r2.value };
}

async function runGuard() {
  const sessionId = `guard-${Date.now()}`;
  log(`\n===== HYPOTHESIS 2: UPGRADE GUARD (session ${sessionId}) =====`);
  const c = connect(sessionId);
  await c.ready;

  // Establish a committed checkpoint tagged with the REAL engine hash.
  const c0 = await c.send({ t: "cell", cell: 0, src: "globalThis.y=99; y" });
  const realHash = c0.checkpoint.engineHash;
  log("cell0 committed, real engineHash=", realHash);

  // Attempt restore pretending we are a DIFFERENT (v2) engine build.
  const fake = "00".repeat(32); // 64-hex, deliberately != real hash
  const rej = await c.send({ t: "restoreWithHash", expectEngineHash: fake });
  log("restoreWithHash (mismatch):", JSON.stringify(rej));

  // Sanity: a restore with the REAL hash still works (guard is not over-broad).
  const ok = await c.send({ t: "eval", src: "y", expectEngineHash: realHash });
  log("eval with real hash:", JSON.stringify(ok));

  c.close();

  const pass =
    rej.rejected === true &&
    rej.errorName === "EngineHashMismatchError" &&
    rej.errorCode === "ENGINE_HASH_MISMATCH" &&
    rej.kernelStillNull === true && // no memory blitted => no corruption
    rej.actual === fake &&
    rej.expected === realHash &&
    Number(ok.value) === 99 &&
    ok.restoreSource === "checkpoint-restore";
  log(
    `RESULT[guard]: rejected=${rej.rejected}, errorName=${rej.errorName}, code=${rej.errorCode}, ` +
      `kernelStillNull=${rej.kernelStillNull}, real-hash-restore y=${ok.value} (want 99)`,
  );
  log(`>>> ${pass ? "PASS" : "FAIL"} (upgrade-guard)`);
  return { pass, rejected: rej.rejected, errorName: rej.errorName, realHashRestore: ok.value };
}

(async () => {
  log(`EXP-9 client -> ${BASE}`);
  const crash = await runCrash();
  const guard = await runGuard();
  const overall = crash.pass && guard.pass;
  log("\n===== SUMMARY =====");
  log(JSON.stringify({ crash, guard, overall: overall ? "PASS" : "FAIL" }, null, 2));
  process.exit(overall ? 0 : 1);
})().catch((e) => {
  console.error("CLIENT ERROR:", e);
  process.exit(1);
});
