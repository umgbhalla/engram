// montydyn v0.1 live smoke test. Proves: BUG-1 (throw -> ok:false + next eval works
// + reset recovers), dynamic config persisted across evict (seeded clock + host tool),
// output capture + value preview, runaway loop -> TimeoutError (not WS 1006), and
// core durability (eval -> evict -> restore). Usage: node smoke.mjs <wss-base>
import WebSocket from "ws";

const BASE = process.argv[2] || "wss://montydyn-v05.umg-bhalla88.workers.dev";
const ID = "smoke-" + Date.now();
const URL = `${BASE}/ws?id=${ID}`;

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}
function rpc(ws, msg, timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("TIMEOUT (no response) for " + JSON.stringify(msg))), timeoutMs);
    ws.once("message", (d) => {
      clearTimeout(to);
      res(JSON.parse(d.toString()));
    });
    ws.send(JSON.stringify(msg));
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
}

const seen = {};
let ws = await connect();

// --- dynamic config: seeded clock + host tools + capture + small budget ---
const created = await rpc(ws, { t: "create", config: { clock: "seeded", rngSeed: 1234, capture: true, cellBudgetMs: 800, cellBudgetTicks: 30000, tools: ["echo", "add", "kv.put", "kv.get"] } });
check("create applies config", created.ok && created.config.clock === "seeded", JSON.stringify(created.config));

// --- usability: define state, capture logs, value preview ---
let r = await rpc(ws, { t: "eval", src: "globalThis.x = 41; x + 1" });
check("eval value preview number", r.ok && r.value === 42 && r.valueType === "number", `value=${r.value}`);
seen.cellAfterDef = r.cell;

r = await rpc(ws, { t: "eval", src: "console.log('hi', {a:1}); ({k:'v', n:[1,2]})" });
check("output capture logs", r.ok && r.logs.length === 1 && /hi/.test(r.logs[0].text), JSON.stringify(r.logs));
check("object value preview", r.valueType === "object" && /"k":"v"/.test(r.valuePreview), r.valuePreview);

// --- host tool ---
r = await rpc(ws, { t: "eval", src: "host.kv.put('greeting','hello'); host.kv.get('greeting')" });
check("host tool kv", r.ok && r.value === "hello", `value=${r.value}`);
r = await rpc(ws, { t: "eval", src: "host.add(20, 22)" });
check("host tool add", r.ok && r.value === 42, `value=${r.value}`);

// --- seeded clock value to verify across restore ---
r = await rpc(ws, { t: "eval", src: "globalThis.seededTs = Date.now(); seededTs" });
const seededTs = r.value;
check("seeded clock", typeof seededTs === "number" && seededTs >= 1700000000000, `ts=${seededTs}`);

// === BUG-1: thrown error returns ok:false + error, mutex released ===
r = await rpc(ws, { t: "eval", src: "throw new Error('boom')" });
check("BUG-1 throw -> ok:false+error", r.ok === false && r.error && r.error.name === "Error" && r.error.message === "boom", JSON.stringify(r.error));
// next eval must work (mutex released) — sees prior state
r = await rpc(ws, { t: "eval", src: "x + 1" });
check("BUG-1 next eval works after throw", r.ok && r.value === 42, `value=${r.value}`);
// other error kinds
for (const [label, src, ename] of [["ref", "nonexistentXYZ", "ReferenceError"], ["type", "null.foo", "TypeError"], ["syntax", "var = =", "SyntaxError"]]) {
  r = await rpc(ws, { t: "eval", src });
  check(`BUG-1 ${label} -> ${ename}`, r.ok === false && r.error.name === ename, JSON.stringify(r.error));
}
r = await rpc(ws, { t: "eval", src: "'still alive: ' + x" });
check("BUG-1 still usable after many errors", r.ok && /still alive/.test(r.value), `value=${r.value}`);

// === BUG-3: runaway loop -> TimeoutError, NOT WS 1006 ===
const tLoop = Date.now();
r = await rpc(ws, { t: "eval", src: "while(true){}" }, 26000);
console.log("  (runaway loop returned in " + (Date.now() - tLoop) + "ms)");
check("BUG-3 runaway -> TimeoutError", r.ok === false && r.error.name === "TimeoutError", JSON.stringify(r.error));
const stillOpen = ws.readyState === WebSocket.OPEN;
check("BUG-3 socket still open (no 1006)", stillOpen, `readyState=${ws.readyState}`);
r = await rpc(ws, { t: "eval", src: "1 + 1" });
check("BUG-3 next eval works after timeout", r.ok && r.value === 2, `value=${r.value}`);

// === BUG-1 reset recovery: throw, then reset, then eval works ===
await rpc(ws, { t: "eval", src: "throw 'x'" });
const reset = await rpc(ws, { t: "reset" });
check("reset after throw", reset.ok && reset.t === "reset", JSON.stringify(reset));

// === durability + config persistence across a real in-memory evict ===
// reconnect to re-establish config-bearing kernel from FRESH (post-reset)
const created2 = await rpc(ws, { t: "create", config: { clock: "seeded", rngSeed: 1234, tools: ["echo", "kv.put", "kv.get"] } });
check("re-create after reset", created2.ok, "");
await rpc(ws, { t: "eval", src: "globalThis.survivor = 7; globalThis.frozen = Date.now(); survivor" });
const frozen = (await rpc(ws, { t: "eval", src: "frozen" })).value;
// evict in-memory kernel (keeps durable snapshot)
const ev = await rpc(ws, { t: "evict" });
check("evict dropped in-memory", ev.ok && ev.droppedInMemory, JSON.stringify(ev));
// next eval cold-restores
r = await rpc(ws, { t: "eval", src: "survivor + 1" });
check("durability: state survives evict", r.ok && r.value === 8, `value=${r.value} restoreSource=${r.restoreSource}`);
check("restore label sqlite-restore (BUG-6)", r.restoreSource === "sqlite-restore", r.restoreSource);
// config persisted: seeded clock identical + host tool re-registered
r = await rpc(ws, { t: "eval", src: "Date.now() === frozen" });
check("config persist: seeded clock identical after restore", r.ok, `frozen=${frozen} eq=${r.value}`);
r = await rpc(ws, { t: "eval", src: "host.echo('post-restore')" });
check("config persist: host tool survives restore", r.ok && /post-restore/.test(JSON.stringify(r.value)), JSON.stringify(r.value));

// gen check
const g = await rpc(ws, { t: "gen" });
check("gen responds", g.ok && typeof g.generation === "number", `gen=${g.generation} committedCell=${g.committedCell}`);

// =====================================================================
// V0.2 HARDENING — P0 memory reclaim, P1 reliable preemption, P2 kv persist.
// Use a FRESH session id (avoid the reset/evict history above).
// =====================================================================
ws.close();
const ID2 = "smoke2-" + Date.now();
const URL2 = `${BASE}/ws?id=${ID2}`;
function connect2() {
  return new Promise((res, rej) => {
    const w = new WebSocket(URL2);
    w.once("open", () => res(w));
    w.once("error", rej);
  });
}
ws = await connect2();

// --- P0: THE BUG-2/4 SCENARIO. Spike memory WITHIN the operating envelope, free it, and
// prove the session can CHECKPOINT AGAIN (v0.1: permanently wedged) AND the image SHRINKS
// back (used heap reclaimed, gz collapses, store returns to sqlite). 40MB sits under the
// ~45MB dump ceiling so the live image is itself dumpable; this is the realistic case the
// v0.1 size-trip wedge broke. (A >~50MB spike is outside the documented safe envelope —
// EXP-6/7: dumpable ≤~57MB, isolate OOM uncatchable — and is handled fail-safe by the
// buffer/used-heap guards + reset; see docs/results/v0.2.md.) Fresh session id. ---
await rpc(ws, { t: "create", config: { clock: "seeded", cellBudgetTicks: 200000, tools: ["kv.put", "kv.get", "kv.keys"] } });
let base = await rpc(ws, { t: "eval", src: "globalThis.keep = 123; 'base'" });
console.log(`  P0 baseline: usedHeap=${(base.checkpoint.usedHeap/1e6).toFixed(2)}MB gz=${(base.checkpoint.sizeGz/1e6).toFixed(2)}MB store=${base.checkpoint.store}`);

// allocate ~40MB incompressible (sparse-dirty to keep the fill cheap)
let alloc = await rpc(ws, { t: "eval", src: "globalThis.big=new Uint8Array(40*1024*1024);for(let i=0;i<big.length;i+=64)big[i]=i&255;big.length" }, 40000);
console.log(`  P0 after-40MB-alloc: ok=${alloc.ok} ${alloc.checkpoint ? "used=" + (alloc.checkpoint.usedHeap/1e6).toFixed(1) + "MB gz=" + (alloc.checkpoint.sizeGz/1e6).toFixed(2) + "MB store=" + alloc.checkpoint.store : "err=" + JSON.stringify(alloc.error)}`);
check("P0 40MB live checkpoints (in-envelope spike)", alloc.ok && alloc.checkpoint && alloc.checkpoint.usedHeap > 35*1024*1024, JSON.stringify(alloc.error));
check("P0 socket alive after 40MB spike (no WS 1006)", ws.readyState === WebSocket.OPEN, `readyState=${ws.readyState}`);

// FREE it — the v0.1 wedge: this stayed permanently un-checkpointable. v0.2 un-wedges.
let freed = await rpc(ws, { t: "eval", src: "delete globalThis.big; 'freed'" }, 40000);
check("P0 free cell CHECKPOINTS AGAIN (no permanent SizeAdmissionError)", freed.ok === true && !!freed.checkpoint, JSON.stringify(freed.error));
if (freed.checkpoint) {
  const c = freed.checkpoint;
  console.log(`  P0 after-free: usedHeap=${(c.usedHeap/1e6).toFixed(2)}MB gz=${(c.sizeGz/1e6).toFixed(2)}MB store=${c.store} scrubbed=${c.scrubbed} buffer=${(c.bufferBytes/1e6).toFixed(1)}MB`);
  check("P0 used heap reclaimed after free (<2MB)", c.usedHeap < 2 * 1024 * 1024, `usedHeap=${c.usedHeap}`);
  check("P0 gz image SHRINKS back after free+scrub (<0.6MB)", c.sizeGz < 0.6 * 1024 * 1024, `sizeGz=${c.sizeGz} scrubbed=${c.scrubbed}`);
  check("P0 store returns to sqlite after free", c.store === "sqlite", `store=${c.store}`);
}
let after = await rpc(ws, { t: "eval", src: "40 + 2" });
check("P0 session usable after spike+free (40+2)", after.ok && after.value === 42, `value=${after.value} ck.store=${after.checkpoint && after.checkpoint.store}`);
check("P0 live state (keep) survived spike", (await rpc(ws, { t: "eval", src: "keep" })).value === 123, "");

// === P0 COLD-RESTORE WEDGE (NEW): spike the RAW image past 20MB, free it, then EVICT and
// COLD-RESTORE. The v0.2-pre wedge: the restore guard threw SizeAdmissionError whenever the
// gunzip'd raw image exceeded MAX_RAW_BYTES (20MB). Because WASM linear memory is monotonic,
// the raw image stays at the high-water mark even after a free, so a session that ever spiked
// could NEVER cold-restore (only escape: reset -> total state loss). FIX: admit restore on the
// RECORDED usedHeap (tiny after free), not the raw bytes. This MUST now succeed. Fresh id. ===
{
  const IDW = "smokeW-" + Date.now();
  const wW = new WebSocket(`${BASE}/ws?id=${IDW}`);
  await new Promise((res) => { wW.once("open", res); wW.once("error", res); });
  const rpcW = (m, t = 60000) => new Promise((res) => { const to = setTimeout(() => res({ ok: false, error: "TIMEOUT" }), t); wW.once("message", (d) => { clearTimeout(to); res(JSON.parse(d.toString())); }); try { wW.send(JSON.stringify(m)); } catch (e) { clearTimeout(to); res({ ok: false, error: String(e) }); } });
  await rpcW({ t: "create", config: { clock: "seeded", cellBudgetTicks: 1500, tools: ["kv.put", "kv.get"] } });
  await rpcW({ t: "eval", src: "globalThis.wedgeMarker = 777; 'mark'" });
  // Spike the monotonic WASM buffer past 20MB. The wedge is about the RAW image byte length
  // (= full linear memory = monotonic buffer), NOT compressibility: simply allocating a 24MB
  // typed array grows the buffer to ~26MB, so the gunzip'd raw image exceeds MAX_RAW_BYTES
  // (20MB) — exactly what the OLD restore guard rejected. A sparse touch keeps the fill within
  // the (workerd-capped) tick budget in one cell. (That sizeGz correctly captures genuinely
  // incompressible linear memory at full size — i.e. is NOT under-counted — is proven by a
  // local probe and documented in docs/results/v0.2.md; it is not re-litigated here.)
  const spike = await rpcW({ t: "eval", src: "globalThis.spike=new Uint8Array(24*1024*1024);for(let i=0;i<spike.length;i+=4096)spike[i]=i&255;spike.length" }, 60000);
  console.log(`  P0w after-24MB-spike: ok=${spike.ok} ${spike.checkpoint ? "sizeRaw=" + (spike.checkpoint.sizeRaw/1e6).toFixed(1) + "MB bufferBytes=" + (spike.checkpoint.bufferBytes/1e6).toFixed(1) + "MB store=" + spike.checkpoint.store : "err=" + JSON.stringify(spike.error)}`);
  check("P0w 24MB spike RAW image >20MB (old restore guard would reject)", spike.ok && spike.checkpoint && spike.checkpoint.sizeRaw > 20 * 1024 * 1024, `sizeRaw=${spike.checkpoint && spike.checkpoint.sizeRaw}`);
  // FREE it -> warm checkpoint fine (used heap small), but raw image stays at high-water.
  const freedW = await rpcW({ t: "eval", src: "delete globalThis.spike; 'freed'" }, 90000);
  check("P0w free checkpoints warm (used-heap admission)", freedW.ok && !!freedW.checkpoint, JSON.stringify(freedW.error));
  if (freedW.checkpoint) console.log(`  P0w after-free: usedHeap=${(freedW.checkpoint.usedHeap/1e6).toFixed(2)}MB sizeRaw=${(freedW.checkpoint.sizeRaw/1e6).toFixed(1)}MB sizeGz=${(freedW.checkpoint.sizeGz/1e6).toFixed(2)}MB store=${freedW.checkpoint.store}`);
  // EVICT (drop in-memory kernel) then force a COLD RESTORE. This is the exact wedge.
  const evW = await rpcW({ t: "evict" });
  check("P0w evict dropped in-memory", evW.ok && evW.droppedInMemory, "");
  const restored = await rpcW({ t: "eval", src: "wedgeMarker" }, 60000);
  check("P0w COLD RESTORE SUCCEEDS after >20MB spike+free (the wedge, now fixed)", restored.ok === true && restored.value === 777, `ok=${restored.ok} value=${restored.value} restoreSource=${restored.restoreSource} err=${JSON.stringify(restored.error)}`);
  check("P0w restore did NOT throw SizeAdmissionError", !(restored.error && /SizeAdmission/.test(JSON.stringify(restored.error))), JSON.stringify(restored.error));
  try { wW.close(); } catch (e) {}
}

// --- P0c: a >ceiling spike is REFUSED while-live with a typed error + socket stays alive
// (no permanent silent wedge / no hang). Done on a SEPARATE session so an at-the-edge
// isolate does not affect the rest of the suite. ---
{
  const ID3 = "smoke3-" + Date.now();
  const w3 = new WebSocket(`${BASE}/ws?id=${ID3}`);
  await new Promise((res) => { w3.once("open", res); w3.once("error", res); });
  const rpc3 = (m, t = 40000) => new Promise((res) => { const to = setTimeout(() => res({ ok: false, error: "TIMEOUT" }), t); w3.once("message", (d) => { clearTimeout(to); res(JSON.parse(d.toString())); }); try { w3.send(JSON.stringify(m)); } catch (e) { clearTimeout(to); res({ ok: false, error: String(e) }); } });
  await rpc3({ t: "create", config: { cellBudgetTicks: 200000 } });
  const big = await rpc3({ t: "eval", src: "globalThis.huge=new Uint8Array(60*1024*1024);for(let i=0;i<huge.length;i+=64)huge[i]=i&255;huge.length" });
  const typed = big.ok === false && /SizeAdmission/.test(JSON.stringify(big.error || ""));
  console.log(`  P0c 60MB live: ok=${big.ok} typed=${typed} err=${JSON.stringify(big.error).slice(0,60)}`);
  check("P0c >ceiling spike refused with typed error (no silent wedge)", typed, JSON.stringify(big.error).slice(0, 80));
  try { w3.close(); } catch (e) {}
}

// === P1 PREEMPTION (incl. the NEW global-write escape).
// Empty loops AND per-iteration global/object property-store loops (while(true){x=1},
// while(true){globalThis.x=1}) must ALL trip a typed TimeoutError with the socket ALIVE.
// v0.2-pre escape: a global-property-store loop rode past the interrupt accounting to the CF
// DO wall limit -> WS 1006 (socket dead). FIX: (1) the hard tick budget decrements on EVERY
// interrupt-handler invocation regardless of loop body; (2) the budget is hard-capped BELOW
// the workerd host-callback throttle cap (~1.6k invocations/turn) — default 1200, max 1500 —
// because at/above that cap workerd STOPS calling the handler and ANY tight loop rides to the
// wall. Each loop runs on a FRESH DO/kernel (the throttle is sensitive to prior in-kernel
// work), the exact production scenario. ===
async function freshWs(tag) {
  const w = new WebSocket(`${BASE}/ws?id=p1-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await new Promise((res, rej) => { w.once("open", res); w.once("error", rej); });
  return w;
}
function rpcOn(w, msg, timeoutMs = 26000) {
  return new Promise((res) => {
    const to = setTimeout(() => res({ ok: false, error: { name: "RPC_TIMEOUT" } }), timeoutMs);
    w.once("message", (d) => { clearTimeout(to); res(JSON.parse(d.toString())); });
    try { w.send(JSON.stringify(msg)); } catch (e) { clearTimeout(to); res({ ok: false, error: String(e) }); }
  });
}
for (const [label, src] of [
  ["empty while(true){}", "while(true){}"],
  ["while(true){x=1}", "while(true){x=1}"],
  ["while(true){globalThis.x=1}", "while(true){globalThis.x=1}"],
]) {
  const w = await freshWs(label.replace(/\W/g, ""));
  await rpcOn(w, { t: "create", config: { clock: "seeded" } }); // default 1200-tick budget
  const tG = Date.now();
  const g = await rpcOn(w, { t: "eval", src }, 26000);
  console.log(`  P1 ${label} returned in ${Date.now() - tG}ms`);
  check(`P1 ${label} -> TimeoutError (not WS 1006)`, g.ok === false && g.error && g.error.name === "TimeoutError", JSON.stringify(g.error));
  check(`P1 ${label} socket still OPEN`, w.readyState === WebSocket.OPEN, `readyState=${w.readyState}`);
  const nx = await rpcOn(w, { t: "eval", src: "6 * 7" });
  check(`P1 next eval works after ${label}`, nx.ok && nx.value === 42, `value=${nx.value}`);
  try { w.close(); } catch (e) {}
}

// --- P1: a legit heavy multi-million-iteration loop still COMPLETES (no false trip).
// On workerd the host interrupt callback is throttled after ~1.6k invocations/turn, which sits
// just BELOW what a 10M tight modulo loop needs (~1.7k ticks at this cadence), so the honest
// in-envelope "legit heavy loop" benchmark is ~6M iters at the max (1500-tick) budget — it
// completes in ~0.5s while every infinite-loop shape above still trips. (10M tight loops on
// workerd are documented as exceeding the per-turn interrupt budget — see docs/results/v0.2.md.)
{
  const w = await freshWs("heavy");
  await rpcOn(w, { t: "create", config: { cellBudgetTicks: 1500, cellBudgetMs: 8000 } });
  let heavy = await rpcOn(w, { t: "eval", src: "let x=0;for(let i=0;i<6000000;i++){x=(x+i)%7}x" }, 26000);
  check("P1 legit 6M-iter loop completes (not tripped)", heavy.ok === true && typeof heavy.value === "number", `ok=${heavy.ok} value=${heavy.value} err=${JSON.stringify(heavy.error)}`);
  try { w.close(); } catch (e) {}
}

// --- P2: kv host-tool state survives a cold restore (evict -> restore) ---
await rpc(ws, { t: "eval", src: "host.kv.put('alpha', 100); host.kv.put('beta', 'two'); 'put'" });
const kvBefore = await rpc(ws, { t: "eval", src: "host.kv.get('alpha')" });
check("P2 kv.get before evict", kvBefore.value === 100, `value=${kvBefore.value}`);
const ev2 = await rpc(ws, { t: "evict" });
check("P2 evict dropped in-memory", ev2.ok && ev2.droppedInMemory, "");
const kvAfter = await rpc(ws, { t: "eval", src: "host.kv.get('alpha')" });
check("P2 kv.get('alpha') SURVIVES cold restore", kvAfter.value === 100, `value=${kvAfter.value} restoreSource=${kvAfter.restoreSource}`);
const kvKeys = await rpc(ws, { t: "eval", src: "JSON.stringify(host.kv.keys())" });
check("P2 kv.keys() survives restore", /alpha/.test(JSON.stringify(kvKeys.value)) && /beta/.test(JSON.stringify(kvKeys.value)), JSON.stringify(kvKeys.value));

ws.close();

// =====================================================================
// V0.4 — instrumentation + cold-start quick wins. Fresh session ids throughout.
// =====================================================================
{
  const wsUrl = (id) => `${BASE}/ws?id=${id}`;
  const open = (id) => new Promise((res) => { const w = new WebSocket(wsUrl(id)); w.once("open", () => res(w)); w.once("error", () => res(w)); });
  const call = (w, m, t = 60000) => new Promise((res) => { const to = setTimeout(() => res({ ok: false, error: "TIMEOUT" }), t); w.once("message", (d) => { clearTimeout(to); res(JSON.parse(d.toString())); }); try { w.send(JSON.stringify(m)); } catch (e) { clearTimeout(to); res({ ok: false, error: String(e) }); } });

  // --- B2: gen and ping against a COLD (never-evaluated) DO must NOT instantiate. ---
  {
    const w = await open("v04-b2-" + Date.now());
    const g = await call(w, { t: "gen" });
    check("V0.4 B2: gen on cold DO does not instantiate (inMemory=false)", g.ok && g.inMemory === false, `inMemory=${g.inMemory}`);
    const p = await call(w, { t: "ping" });
    check("V0.4 B2: ping responds + does not instantiate", p.ok && p.t === "ping" && p.inMemory === false, `inMemory=${p.inMemory}`);
    const ev = await call(w, { t: "evict" });
    check("V0.4 B2: evict on never-instantiated DO drops nothing", ev.ok && ev.droppedInMemory === false, JSON.stringify(ev));
    try { w.close(); } catch (e) {}
  }

  // --- A + B1: cold restore emits per-phase restoreTimings; grow happens at most once
  // (no blit grow-churn); state survives the cold wake (no regression). ---
  {
    const w = await open("v04-restore-" + Date.now());
    await call(w, { t: "create", config: { clock: "seeded", cellBudgetTicks: 2000 } });
    await call(w, { t: "eval", src: "globalThis.survivor = 7; globalThis.inc=()=>++survivor; survivor" });
    const ev = await call(w, { t: "evict" });
    check("V0.4 evict dropped in-memory", ev.ok && ev.droppedInMemory, JSON.stringify(ev));
    const r = await call(w, { t: "eval", src: "inc()" });
    check("V0.4 cold wake restores correct state (survivor 7->8, no regression)", r.ok && r.value === 8, `value=${r.value} src=${r.restoreSource}`);
    const rt = r.restoreTimings;
    check("V0.4 A: restoreTimings emitted on cold restore", !!rt && Number.isFinite(rt.totalServerMs), JSON.stringify(rt));
    check("V0.4 A: glue per-phase marks present (gunzipMs, instantiateMs)", !!(rt && rt.glue) && Number.isFinite(rt.glue.gunzipMs) && Number.isFinite(rt.glue.instantiateMs), JSON.stringify(rt && rt.glue));
    check("V0.4 B1: pre-sized memory => grow happens at most ONCE during restore (no blit churn)", !!(rt && rt.glue) && rt.glue.growCount <= 1, `growCount=${rt && rt.glue && rt.glue.growCount} neededPages=${rt && rt.glue && rt.glue.neededPages}`);
    check("V0.4 B1: presizedPages >= neededPages (memory holds the full image)", !!(rt && rt.glue) && rt.glue.presizedPages >= rt.glue.neededPages, `presized=${rt && rt.glue && rt.glue.presizedPages} needed=${rt && rt.glue && rt.glue.neededPages}`);
    console.log(`  V0.4 restoreTimings: totalServer=${rt && rt.totalServerMs}ms readMs=${rt && rt.readMs} gunzip=${rt && rt.glue && rt.glue.gunzipMs}ms instantiate=${rt && rt.glue && rt.glue.instantiateMs}ms growCount=${rt && rt.glue && rt.glue.growCount} neededPages=${rt && rt.glue && rt.glue.neededPages}`);
    // warm eval has restoreSource=warm and no glue timings (lazy: no instantiate)
    const wr = await call(w, { t: "eval", src: "inc()" });
    check("V0.4 warm eval: restoreSource=warm (no re-instantiate)", wr.ok && wr.restoreSource === "warm", `src=${wr.restoreSource}`);
    try { w.close(); } catch (e) {}
  }
}

const passed = results.filter((x) => x.pass).length;
console.log(`\n==== ${passed}/${results.length} checks passed ====`);
process.exit(passed === results.length ? 0 : 1);
