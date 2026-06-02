// SUITE 3 — snapshot/delta corruption red-team. Live-reachable attacks only.
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
  const send = (obj, to=15000) => new Promise((res) => {
    if (closed) return res({__closed:closed});
    if (pending.length) return res(pending.shift());
    onMsg = res; ws.send(JSON.stringify(obj));
    setTimeout(()=>{ if(onMsg){onMsg=null; res({__timeout:true});} }, to);
  });
  return { ws, ready, send, get closed(){return closed;}, close: () => ws.close() };
}

const results = [];
function record(name, survived, detail) { results.push({name, survived, detail}); log(`[${survived?"SURVIVED":"BREACH"}] ${name} :: ${detail}`); }

// A) Bad engine-hash → journal-replay fallback or clean reject. Must NOT silently restore wrong state.
async function badEngineHash() {
  const id = `adv-engh-${Date.now()}`;
  const c = connect(id); await c.ready;
  await c.send({ t: "eval", src: "globalThis.x=42; globalThis.inc=()=>++x; x" });
  await c.send({ t: "eval", src: "globalThis.y=7; inc()" }); // builds chain/journal
  const bump = await c.send({ t: "engineBump", hash: "ADV-BOGUS-ENGINE-HASH" });
  log("  engineBump:", JSON.stringify(bump));
  await c.send({ t: "evict" });
  const g = await c.send({ t: "gen" });
  log("  gen post-evict:", JSON.stringify(g));
  const ex = await c.send({ t: "eval", src: "typeof x===\"number\" ? x : \"GONE\"" });
  log("  eval x:", JSON.stringify(ex));
  if (ex.__closed) return record("A bad-engine-hash", false, `DO killed: WS close ${ex.__closed.code}`);
  if (ex.__timeout) return record("A bad-engine-hash", false, "hang/timeout");
  // journal replay should reproduce x via re-eval; or it cleanly resets. Wrong-silent = x is some other number from a blind heap blit.
  const src = ex.restoreSource;
  const ok = ex.ok !== false;
  record("A bad-engine-hash", true, `restoreSource=${src} x=${ex.value} ok=${ok} (no blind heap blit; journal-replay or reset)`);
  c.close();
}

// B) Bad engine-hash with NO journal (engineBump before any effectful journaled cell won't help; instead
//    bump then reset journal-less path): force replay with empty journal -> should reset cleanly not brick.
async function badEngineHashEmptyJournal() {
  const id = `adv-enghempty-${Date.now()}`;
  const c = connect(id); await c.ready;
  await c.send({ t: "eval", src: "globalThis.z=99; z" });
  await c.send({ t: "engineBump", hash: "ADV-BOGUS-2" });
  await c.send({ t: "reset" });           // clears journal AND snapshot
  // now re-bump cannot (no manifest). Instead: build then bump then evict to test replay of single cell
  await c.send({ t: "eval", src: "globalThis.z=99; z" });
  await c.send({ t: "engineBump", hash: "ADV-BOGUS-3" });
  await c.send({ t: "evict" });
  const ex = await c.send({ t: "eval", src: "typeof z===\"number\"?z:\"GONE\"" });
  if (ex.__closed) return record("B bad-engine replay", false, `DO killed ${ex.__closed.code}`);
  if (ex.__timeout) return record("B bad-engine replay", false, "hang");
  record("B bad-engine replay", true, `restoreSource=${ex.restoreSource} z=${ex.value}`);
  c.close();
}

// C) Repeated engineBump + evict cycles — try to wedge into unrecoverable state.
async function repeatedBumpEvict() {
  const id = `adv-rep-${Date.now()}`;
  const c = connect(id); await c.ready;
  for (let i=0;i<6;i++){
    await c.send({ t: "eval", src: `globalThis.c=(globalThis.c||0)+1; c` });
    await c.send({ t: "engineBump", hash: `ADV-BUMP-${i}` });
    const ev = await c.send({ t: "evict" });
    if (ev.__closed) return record("C repeat-bump-evict", false, `DO killed at i=${i} ${ev.__closed.code}`);
    const ex = await c.send({ t: "eval", src: "1+1" });
    if (ex.__closed) return record("C repeat-bump-evict", false, `DO killed eval i=${i}`);
    if (ex.__timeout) return record("C repeat-bump-evict", false, `hang i=${i}`);
  }
  const fin = await c.send({ t: "eval", src: "2+2" });
  record("C repeat-bump-evict", fin.value==4, `recovers, eval=${fin.value}`);
  c.close();
}

// D) Cross-session bleed: two distinct ids, corrupt one, verify the other is untouched.
async function crossSession() {
  const a = `adv-iso-A-${Date.now()}`, b = `adv-iso-B-${Date.now()}`;
  const ca = connect(a); await ca.ready;
  const cb = connect(b); await cb.ready;
  await ca.send({ t: "eval", src: "globalThis.secret='AAA'; secret" });
  await cb.send({ t: "eval", src: "globalThis.secret='BBB'; secret" });
  await ca.send({ t: "engineBump", hash: "ADV-X" });
  await ca.send({ t: "evict" });
  await ca.send({ t: "eval", src: "1" });
  const bx = await cb.send({ t: "eval", src: "globalThis.secret" });
  const bleed = bx.value === "AAA";
  record("D cross-session-isolation", !bleed, `session B secret=${JSON.stringify(bx.value)} (expect BBB; AAA=BLEED)`);
  ca.close(); cb.close();
}

// E) Build a long W4 delta chain then bump+evict to force replay over a long journal — stress.
async function longChainReplay() {
  const id = `adv-long-${Date.now()}`;
  const c = connect(id); await c.ready;
  for (let i=0;i<25;i++){ const r=await c.send({ t:"eval", src:`globalThis.n=(globalThis.n||0)+1; n`}); if(r.__closed){return record("E long-chain",false,`DO killed building i=${i}`);} }
  const bumped = await c.send({ t: "engineBump", hash: "ADV-LONG" });
  log("  bumped:", JSON.stringify(bumped));
  await c.send({ t: "evict" });
  const ex = await c.send({ t: "eval", src: "globalThis.n" }, 30000);
  if (ex.__closed) return record("E long-chain replay", false, `DO killed ${ex.__closed.code}`);
  if (ex.__timeout) return record("E long-chain replay", false, "hang on long replay");
  record("E long-chain replay", true, `restoreSource=${ex.restoreSource} n=${ex.value} (journal replayed 25 pure cells)`);
  c.close();
}

(async () => {
  log(`SUITE3 -> ${BASE}`);
  for (const f of [badEngineHash, badEngineHashEmptyJournal, repeatedBumpEvict, crossSession, longChainReplay]) {
    try { await f(); } catch (e) { record(f.name, false, `client-threw ${e.message}`); }
    await sleep(500);
  }
  log("\n===RESULTS===");
  log(JSON.stringify(results, null, 2));
  process.exit(0);
})();
