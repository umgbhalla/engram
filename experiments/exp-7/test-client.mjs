// EXP-7 test client: restore latency distribution vs snapshot size.
//
// For each target size, on a fresh session id:
//   1. alloc the namespace to ~targetMb
//   2. snapshot -> R2 (records raw/gz size)
//   3. N iterations of {t:'restore'} (drops in-memory kernel, restores from R2,
//      times each stage) + M iterations of {t:'r2rtt'} to isolate the R2-get RTT.
// Then prints a p50/p95 table per size and the threshold where total > 1000ms.
//
// Usage: node test-client.mjs <wss-base> [sizesCSV] [iters] [rttIters]

import WebSocket from "ws";

const BASE = process.argv[2] || "wss://montydyn-exp7.umg-bhalla88.workers.dev";
const SIZES = (process.argv[3] || "1,8,16,32,64").split(",").map(Number);
const ITERS = Number(process.argv[4] || 10);
const RTT_ITERS = Number(process.argv[5] || 8);

function connect(sessionId) {
  const url = `${BASE}/ws?id=${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });
  const pending = [];
  let onMsg = null;
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (onMsg) { const cb = onMsg; onMsg = null; cb(msg); }
    else pending.push(msg);
  });
  let closed = null;
  ws.on("close", (code) => { closed = code; if (onMsg) { const cb = onMsg; onMsg = null; cb({ ok: false, error: `ws closed ${code}`, wsClosed: code }); } });
  const ready = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  function send(obj) {
    return new Promise((res) => {
      if (closed) return res({ ok: false, error: `ws already closed ${closed}`, wsClosed: closed });
      if (pending.length) return res(pending.shift());
      onMsg = res;
      try { ws.send(JSON.stringify(obj)); } catch (e) { res({ ok: false, error: String(e) }); }
    });
  }
  return { ws, ready, send, close: () => ws.close() };
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
};
const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);

async function runSize(mb) {
  const sessionId = `lat-${mb}mb-${Date.now()}`;
  console.log(`\n=== size ~${mb} MB (session ${sessionId}) ===`);
  const c = connect(sessionId);
  await c.ready;

  console.log(`  alloc ${mb} MB...`);
  const a = await c.send({ t: "alloc", mb });
  if (!a.ok) { console.log("  ALLOC FAIL:", JSON.stringify(a)); c.close(); return { mb, fail: a }; }
  console.log(`  alloc payloadLen=${a.payloadLen}`);

  const snap = await c.send({ t: "snapshot", mb });
  if (!snap.ok) { console.log("  SNAPSHOT FAIL:", JSON.stringify(snap)); c.close(); return { mb, fail: snap }; }
  console.log(`  snapshot raw=${snap.sizeRaw} gz=${snap.sizeGz} ratio=${snap.ratio} dumpMs=${snap.dumpMs} gzipMs=${snap.gzipMs} putMs=${snap.putMs}`);

  const totals = [], r2 = [], gunzipA = [], deser = [], inst = [], jobs = [];
  let lastCheck = null, crash = null;
  for (let i = 0; i < ITERS; i++) {
    const r = await c.send({ t: "restore" });
    if (!r.ok) { console.log(`  RESTORE iter ${i} FAIL:`, JSON.stringify(r)); crash = { iter: i, ...r }; break; }
    totals.push(r.totalMs); r2.push(r.r2GetMs); gunzipA.push(r.gunzipMs);
    deser.push(r.deserMs); inst.push(r.instMs); jobs.push(r.jobsMs);
    lastCheck = { x: r.x, inc: r.inc, payloadLen: r.payloadLen };
    await new Promise((res) => setTimeout(res, 250)); // let the previous WASM instance GC
  }

  const r2rtt = [];
  for (let i = 0; i < RTT_ITERS; i++) {
    const r = await c.send({ t: "r2rtt" });
    if (r.ok) r2rtt.push(r.r2GetMs);
  }
  c.close();

  const stats = {
    mb, sizeRaw: snap.sizeRaw, sizeGz: snap.sizeGz, ratio: snap.ratio,
    n: totals.length, lastCheck, crash,
    total: { p50: pct(totals, 50), p95: pct(totals, 95), mean: mean(totals), min: Math.min(...totals), max: Math.max(...totals) },
    r2GetInline: { p50: pct(r2, 50), p95: pct(r2, 95), mean: mean(r2) },
    r2rttIsolated: { p50: pct(r2rtt, 50), p95: pct(r2rtt, 95), mean: mean(r2rtt) },
    gunzip: { p50: pct(gunzipA, 50), mean: mean(gunzipA) },
    deser: { p50: pct(deser, 50), mean: mean(deser) },
    inst: { p50: pct(inst, 50), mean: mean(inst) },
    jobs: { p50: pct(jobs, 50), mean: mean(jobs) },
  };
  console.log("  STATS:", JSON.stringify(stats));
  return stats;
}

(async () => {
  console.log(`EXP-7 client -> ${BASE} sizes=${SIZES} iters=${ITERS} rttIters=${RTT_ITERS}`);
  const results = [];
  for (const mb of SIZES) {
    try {
      results.push(await runSize(mb));
    } catch (e) {
      console.log(`  size ${mb} ERROR:`, String(e));
      results.push({ mb, error: String(e) });
    }
  }
  console.log("\n===== SUMMARY (p50/p95 total restore ms) =====");
  console.log("mb\trawMB\tgzMB\tp50\tp95\tmean\tr2p50\tinstP50\tunder1s");
  for (const r of results) {
    if (!r.total) { console.log(`${r.mb}\tFAIL`); continue; }
    console.log(
      `${r.mb}\t${(r.sizeRaw / 1048576).toFixed(2)}\t${(r.sizeGz / 1048576).toFixed(2)}\t` +
      `${r.total.p50}\t${r.total.p95}\t${r.total.mean}\t${r.r2rttIsolated.p50}\t${r.inst.p50}\t${r.total.p95 < 1000}`,
    );
  }
  console.log("\nFULL JSON:");
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
})().catch((e) => { console.error("CLIENT ERROR:", e); process.exit(1); });
