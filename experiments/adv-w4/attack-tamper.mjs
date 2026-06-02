// SUITE 3 byte-tamper red-team — requires the `tamper` test hook (scratch only).
import WebSocket from "ws";
const BASE = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
function connect(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);
  const pending = []; let onMsg = null; let closed = null;
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (onMsg){const cb=onMsg;onMsg=null;cb(m);} else pending.push(m); });
  ws.on("close", (code, reason) => { closed = {code, reason: reason?.toString()}; if (onMsg){const cb=onMsg;onMsg=null;cb({__closed:closed});} });
  ws.on("error", () => {});
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (obj, to=20000) => new Promise((res) => {
    if (closed) return res({__closed:closed});
    if (pending.length) return res(pending.shift());
    onMsg = res; ws.send(JSON.stringify(obj));
    setTimeout(()=>{ if(onMsg){onMsg=null; res({__timeout:true});} }, to);
  });
  return { ws, ready, send, get closed(){return closed;}, close: () => ws.close() };
}
const results = [];
function rec(name, survived, detail){ results.push({name,survived,detail}); log(`[${survived?"SURVIVED":"BREACH"}] ${name} :: ${detail}`); }

// Build a delta chain: forceFull base on cell0, then deltas on subsequent cells.
async function buildChain(c, cells){
  let last;
  for (let i=0;i<cells;i++){ last = await c.send({ t:"eval", src:`globalThis.v=(globalThis.v||0)+1; globalThis.tag='S'; v` }); if(last.__closed) return last; }
  return last;
}

// Generic: build chain, tamper, evict, attempt restore. Survive = typed error/clean-reset + socket alive,
// and NOT a silent wrong-state restore. Breach = WS close (DO kill) / timeout / silent wrong value.
async function run(mode, cells, expectVal){
  const id = `adv-tmp-${mode}-${Date.now()}`;
  const c = connect(id); await c.ready;
  const b = await buildChain(c, cells);
  if (b.__closed) return rec(mode, false, `DO killed while building: ${b.__closed.code}`);
  const before = await c.send({ t:"eval", src:"globalThis.v" });
  const ck = before.checkpoint||{};
  log(`  ${mode}: built v=${before.value} mode=${ck.mode} deltaSeq=${ck.deltaSeq} nChunks=${ck.nChunks}`);
  const tres = await c.send({ t:"tamper", mode });
  log(`  tamper: ${JSON.stringify(tres.detail||tres)}`);
  await c.send({ t:"evict" });
  const g = await c.send({ t:"gen" });
  if (g.__closed) return rec(mode, false, `DO killed on gen post-tamper ${g.__closed.code}`);
  const ex = await c.send({ t:"eval", src:"typeof globalThis.v===\"number\"?globalThis.v:\"GONE\"" }, 25000);
  if (ex.__closed) return rec(mode, false, `BREACH: DO killed (WS ${ex.__closed.code}) on restore from tampered snapshot`);
  if (ex.__timeout) return rec(mode, false, `BREACH: hang on restore from tampered snapshot`);
  // Recovery probe: can the session continue at all after the failed restore?
  const recov = await c.send({ t:"eval", src:"40+2" });
  const recovered = !recov.__closed && !recov.__timeout && recov.value===42;
  const detail = `restoreSource=${ex.restoreSource} ok=${ex.ok} value=${JSON.stringify(ex.value)} err=${ex.error?.name||ex.error||""} recover=${recovered}`;
  // SILENT-CORRUPT check: a tampered base/delta that produced a *successful* restore with a value that is
  // neither the correct value nor a clean reset/typed-error is a silent corruption (still "survived" if no
  // crash, but flagged). For flip modes a faithful detect = error/reset; a returned wrong number = SILENT.
  let silent = false;
  if ((mode==="flipChunk"||mode==="flipDelta") && ex.ok!==false && typeof ex.value==="number" && ex.value!==expectVal) silent = true;
  if (silent) return rec(mode, true, `SILENT-CORRUPT (no crash but restored WRONG state): ${detail}`);
  rec(mode, !ex.__closed && !ex.__timeout, detail);
  c.close();
}

(async () => {
  log(`TAMPER -> ${BASE}`);
  // full base only (cell0): truncChunk / dropBase / flipChunk
  await run("truncChunk", 1);
  await sleep(400);
  await run("dropBase", 1);
  await sleep(400);
  await run("flipChunk", 1, 1);
  await sleep(400);
  // delta chain (>=3 cells => base + deltas): truncDelta / flipDelta
  await run("truncDelta", 4, 4);
  await sleep(400);
  await run("flipDelta", 4, 4);
  log("\n===RESULTS===");
  log(JSON.stringify(results,null,2));
  process.exit(0);
})();
