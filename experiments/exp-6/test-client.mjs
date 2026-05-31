// EXP-6 memory ceiling probe driver.
//
// Steps up the live QuickJS linear memory in increments, and at each step
// attempts a full snapshot (buffered + streamed), recording success/failure and
// peak transient footprint. Stops on the first snapshot failure OR a worker
// error (Error 1102 / disconnect) — that boundary is the usable namespace
// budget.
//
// Usage:
//   node test-client.mjs <wss-base> [stepMB] [maxMB] [mode]
//   stepMB default 4, maxMB default 120, mode "buffered"|"streamed"|"both"

import WebSocket from "ws";

const BASE = process.argv[2] || "wss://montydyn-exp6.umg-bhalla88.workers.dev";
const STEP = Number(process.argv[3] || 4);
const MAX = Number(process.argv[4] || 120);
const MODE = process.argv[5] || "both";

function connect(sessionId) {
  const url = `${BASE}/ws?id=${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(url);
  let onMsg = null;
  const pending = [];
  let closedErr = null;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (onMsg) {
      const cb = onMsg;
      onMsg = null;
      cb(m);
    } else pending.push(m);
  });
  ws.on("close", (code, reason) => {
    closedErr = `socket closed code=${code} reason=${reason}`;
    if (onMsg) {
      const cb = onMsg;
      onMsg = null;
      cb({ ok: false, error: closedErr, __closed: true });
    }
  });
  const ready = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  function send(obj, timeoutMs = 120000) {
    return new Promise((res) => {
      if (pending.length) return res(pending.shift());
      if (closedErr) return res({ ok: false, error: closedErr, __closed: true });
      const timer = setTimeout(
        () => res({ ok: false, error: "timeout", __timeout: true }),
        timeoutMs,
      );
      onMsg = (m) => {
        clearTimeout(timer);
        res(m);
      };
      ws.send(JSON.stringify(obj));
    });
  }
  return { ws, ready, send, close: () => ws.close() };
}

const log = (...a) => console.log(...a);

async function run() {
  const sessionId = `probe-${Date.now()}`;
  log(`EXP-6 probe -> ${BASE} session=${sessionId} step=${STEP}MB max=${MAX}MB mode=${MODE}`);
  const c = connect(sessionId);
  await c.ready;

  await c.send({ t: "reset" });

  const curve = [];
  let firstFailureMB = null;
  let lastGoodLiveMB = 0;

  for (let target = STEP; target <= MAX; target += STEP) {
    const g = await c.send({ t: "grow", mb: STEP });
    if (g.__closed || g.__timeout) {
      log(`GROW to ~${target}MB: WORKER DIED -> ${g.error}`);
      curve.push({ targetMB: target, phase: "grow", died: true, error: g.error });
      firstFailureMB = firstFailureMB ?? lastGoodLiveMB;
      break;
    }
    if (!g.ok) {
      log(`GROW to ~${target}MB FAILED inside kernel: ${g.evalErr}`);
      curve.push({ targetMB: target, phase: "grow", growFailed: true, ...g });
      firstFailureMB = firstFailureMB ?? lastGoodLiveMB;
      break;
    }
    const liveMB = g.liveLinearMB;
    log(`GROW -> allocated=${g.allocatedLogicalMB}MB liveLinear=${liveMB}MB (${g.ms}ms)`);

    const modes = MODE === "both" ? ["buffered", "streamed"] : [MODE];
    let anyFail = false;
    const rec = { targetMB: target, allocatedLogicalMB: g.allocatedLogicalMB, liveLinearMB: liveMB, snaps: {} };
    for (const mode of modes) {
      const s = await c.send({ t: "snapcheck", mode });
      if (s.__closed || s.__timeout) {
        log(`  SNAP[${mode}] at live=${liveMB}MB: WORKER DIED -> ${s.error}`);
        rec.snaps[mode] = { ok: false, died: true, error: s.error };
        anyFail = true;
        firstFailureMB = firstFailureMB ?? liveMB;
        break;
      }
      if (!s.ok) {
        log(`  SNAP[${mode}] at live=${liveMB}MB: FAILED -> ${s.error}`);
        rec.snaps[mode] = { ok: false, error: s.error };
        anyFail = true;
        firstFailureMB = firstFailureMB ?? liveMB;
      } else {
        log(
          `  SNAP[${mode}] OK live=${s.liveLinearMB}MB serialized=${round(s.serializedBytes)}MB gz=${round(s.gzBytes)}MB ratio=${s.ratio} peakTransient=${s.peakTransientMB}MB (${s.ms}ms)`,
        );
        rec.snaps[mode] = {
          ok: true,
          liveLinearMB: s.liveLinearMB,
          serializedMB: round(s.serializedBytes),
          gzMB: round(s.gzBytes),
          peakTransientMB: s.peakTransientMB,
          ms: s.ms,
        };
      }
    }
    curve.push(rec);
    if (anyFail) break;
    lastGoodLiveMB = liveMB;
  }

  log("\n===== CURVE =====");
  log(JSON.stringify(curve, null, 2));
  log("\n===== SUMMARY =====");
  log(`last snapshot-OK live linear memory: ${lastGoodLiveMB} MB`);
  log(`first failure at approx live: ${firstFailureMB ?? "none within max"} MB`);
  c.close();
  return { sessionId, lastGoodLiveMB, firstFailureMB, curve };
}

function round(b) {
  return Math.round((b / 1048576) * 100) / 100;
}

run()
  .then((r) => {
    log("\n===== RESULT JSON =====");
    log(JSON.stringify({ summary: { lastGoodLiveMB: r.lastGoodLiveMB, firstFailureMB: r.firstFailureMB } }));
    process.exit(0);
  })
  .catch((e) => {
    console.error("CLIENT ERROR:", e);
    process.exit(1);
  });
