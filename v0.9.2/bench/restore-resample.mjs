// v0.4 — restore-RTT resampler. Build ONE snapshot per size, then evict+inc() many
// times on the SAME DO id. Each cycle: evict drops the in-memory kernel, the next eval
// takes the lazy cold-RESTORE path (read snapshot -> gunzip -> instantiate -> grow+blit
// -> re-register -> eval). Snapshot is built once and reused, so we cheaply sample the
// restore-from-snapshot cost across snapshot SIZES without paying the fill cost N times.
// Same-id => warm isolate, cold kernel => isolates restore cost from cold-isolate spin-up.
import WebSocket from "ws";
const BASE = "wss://montydyn-v05.umg-bhalla88.workers.dev";
const SIZE = process.argv[2] || "5mb";
const N = Number(process.argv[3] || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fillCells(size) {
  if (size === "base") return ["globalThis.x=42;globalThis.inc=()=>++x;x"];
  const mb = size === "15mb" ? 15 : 5;
  const NB = mb * 1024 * 1024, CHUNK = 1024 * 1024;
  const cells = [`globalThis.x=42;globalThis.inc=()=>++x;globalThis.big=new Uint8Array(${NB});globalThis.__s=0x9e3779b9>>>0;'alloc'`];
  for (let off = 0; off < NB; off += CHUNK) {
    const end = Math.min(off + CHUNK, NB);
    cells.push(`{let s=globalThis.__s>>>0;for(let i=${off};i<${end};i++){s=(Math.imul(s,1664525)+1013904223)>>>0;globalThis.big[i]=s>>>24;}globalThis.__s=s;}${off}`);
  }
  return cells;
}
function connect(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);
  const ready = new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const rpc = (m, t = 90000) => new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("to")), t);
    ws.once("message", (d) => { clearTimeout(to); res(JSON.parse(d.toString())); });
    ws.send(JSON.stringify(m));
  });
  return { ws, ready, rpc, close: () => { try { ws.close(); } catch {} } };
}
function pct(s, p) { return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))]; }
function dist(v) { const s = [...v].sort((a, b) => a - b); return { n: s.length, min: s[0], p50: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), p99: pct(s, 99), p999: pct(s, 99.9), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) }; }

(async () => {
  const id = `resample-${SIZE}-${Date.now()}`;
  const c = connect(id);
  await c.ready;
  await c.rpc({ t: "create", config: { clock: "seeded", cellBudgetTicks: 2000 } });
  let setup;
  for (const src of fillCells(SIZE)) { setup = await c.rpc({ t: "eval", src }); if (!setup.ok) { console.log("setup fail", JSON.stringify(setup.error)); process.exit(1); } }
  const rawMB = setup.checkpoint ? (setup.checkpoint.sizeRaw / 1e6).toFixed(2) : "?";
  const store = setup.checkpoint ? setup.checkpoint.store : "?";
  console.log(`[${SIZE}] snapshot built: raw~${rawMB}MB store=${store}; sampling ${N} evict+restore cycles`);
  const rtts = [], grows = [];
  let errs = 0;
  for (let i = 0; i < N; i++) {
    let ev, r, rtt;
    try {
      ev = await c.rpc({ t: "evict" });
      if (!ev.droppedInMemory) { errs++; process.stdout.write("E"); continue; }
      const t0 = Date.now();
      r = await c.rpc({ t: "eval", src: "inc()" }, 120000);
      rtt = Date.now() - t0;
    } catch (e) { errs++; process.stdout.write("T"); continue; }
    if (!r.ok) { errs++; process.stdout.write("x"); continue; }
    rtts.push(rtt);
    if (r.restoreTimings?.glue?.growCount !== undefined) grows.push(r.restoreTimings.glue.growCount);
    process.stdout.write(r.restoreSource === "warm" ? "w" : ".");
    await sleep(400);
  }
  c.close();
  console.log(`\n[${SIZE}] raw~${rawMB}MB store=${store} restore-RTT ms: ${JSON.stringify(dist(rtts))}`);
  if (grows.length) console.log(`[${SIZE}] B1 growCount during restore: max=${Math.max(...grows)} (expect <=1)`);
  console.log(`[${SIZE}] errs=${errs}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
