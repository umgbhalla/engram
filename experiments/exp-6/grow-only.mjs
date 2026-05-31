// Grow-only probe: how large can the LIVE QuickJS namespace get WITHOUT taking a
// snapshot? Isolates the live-memory ceiling from the snapshot-transient ceiling.
import WebSocket from "ws";
const BASE = process.argv[2] || "wss://montydyn-exp6.umg-bhalla88.workers.dev";
const STEP = Number(process.argv[3] || 4);
const MAX = Number(process.argv[4] || 200);
function connect(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);
  let onMsg = null; const pending = []; let closed = null;
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (onMsg){const c=onMsg;onMsg=null;c(m);} else pending.push(m); });
  ws.on("close", (code) => { closed = `closed ${code}`; if (onMsg){const c=onMsg;onMsg=null;c({__closed:true,error:closed});} });
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (o) => new Promise((res) => { if (pending.length) return res(pending.shift()); if (closed) return res({__closed:true,error:closed}); onMsg=res; ws.send(JSON.stringify(o)); });
  return { ready, send, close: () => ws.close() };
}
(async () => {
  const c = connect(`grow-${Date.now()}`); await c.ready; await c.send({ t: "reset" });
  let lastLive = 0;
  for (let target = STEP; target <= MAX; target += STEP) {
    const g = await c.send({ t: "grow", mb: STEP });
    if (g.__closed) { console.log(`GROW to ~${target}MB: WORKER DIED (${g.error}); last good live=${lastLive}MB`); break; }
    if (!g.ok) { console.log(`GROW to ~${target}MB kernel-failed: ${g.evalErr}; last good live=${lastLive}MB`); break; }
    lastLive = g.liveLinearMB;
    console.log(`GROW alloc=${g.allocatedLogicalMB}MB liveLinear=${g.liveLinearMB}MB keepChunks=${g.keepChunks} (${g.ms}ms)`);
  }
  console.log(`grow-only max live linear = ${lastLive} MB`);
  c.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
