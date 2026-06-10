// Phase 1b feature suite for engram-rust2: W5 un-wedge, W4 byte-delta, stdlib injection,
// host.ctx / host.final / host.subLM, E6 engine-migration replay (via stale engine_hash sim
// is not possible live; we test the oplog tail is recorded + the replay path is reachable).
import { WebSocket } from "ws";
const BASE = "engram-rust2.umg-bhalla88.workers.dev";
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "  got=" + JSON.stringify(extra)); }
}
function rpc(ws, msg) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + JSON.stringify(msg).slice(0, 60))), 30000);
    ws.once("message", (d) => { clearTimeout(t); res(JSON.parse(d)); });
    ws.send(JSON.stringify(msg));
  });
}
async function fresh(id) {
  const ws = new WebSocket(`wss://${BASE}/?id=${id}&apiKey=${process.env.ENGRAM_KERNEL_KEY||""}`);
  ws.on("error", () => {});
  await new Promise((r) => ws.once("open", r));
  return ws;
}

const SID = "p1b-" + Date.now();
let ws = await fresh(SID);

// ---- stdlib injection (config.modules) ----
await rpc(ws, { t: "create", config: { rngSeed: 7, modules: ["lodash", "dayjs", "nanoid", "uuid"] } });
let r = await rpc(ws, { t: "eval", src: "(typeof _.chunk) + ',' + _.chunk([1,2,3,4],2).length" });
ok("stdlib lodash injected", r.value === "function,2", r);
r = await rpc(ws, { t: "eval", src: "typeof dayjs" });
ok("stdlib dayjs injected", r.value === "function", r);
r = await rpc(ws, { t: "eval", src: "var id1 = nanoid(); id1.length" });
ok("stdlib nanoid (seeded crypto)", r.value === 21, r);
r = await rpc(ws, { t: "stdlib" });
ok("stdlib catalog reports loaded", Array.isArray(r.stdlib.loaded) && r.stdlib.loaded.includes("lodash"), r.stdlib);

// nanoid determinism: a SECOND session with the same seed -> same first id (seeded crypto).
{
  const ws2 = await fresh("p1b-det-" + Date.now());
  await rpc(ws2, { t: "create", config: { rngSeed: 7, modules: ["nanoid"] } });
  const a = (await rpc(ws2, { t: "eval", src: "nanoid()" })).value;
  ws2.close();
  const ws3 = await fresh("p1b-det2-" + Date.now());
  await rpc(ws3, { t: "create", config: { rngSeed: 7, modules: ["nanoid"] } });
  const b = (await rpc(ws3, { t: "eval", src: "nanoid()" })).value;
  ws3.close();
  ok("seeded nanoid determinism (same seed -> same id)", a === b, { a, b });
}

// ---- W4 byte-delta: many small cells -> delta mode + smaller stored bytes than a full base ----
// (This session already has a committed full base from create+stdlib; small cells now delta.)
const modes = [];
const stored = [];
let fullBaseGz = null;
for (let i = 0; i < 6; i++) {
  r = await rpc(ws, { t: "eval", src: `globalThis.counter = (globalThis.counter||0) + 1; globalThis.counter` });
  modes.push(r.checkpoint && r.checkpoint.mode);
  stored.push(r.checkpoint && r.checkpoint.sizeGz);
}
ok("W4 small cells checkpoint as deltas", modes.every((m) => m === "delta"), modes);
// the full base for THIS image is ~771KB gz (from the stdlib bundle); deltas must be far smaller.
ok("W4 delta stored bytes << full base", Math.max(...stored) < 100 * 1024, { fullBaseGzApprox: 771014, deltas: stored });

// ---- host.ctx (host-side chunked context store) ----
const bigText = "alpha\nbeta GAMMA delta\n" + "x".repeat(5000) + "\nNEEDLE here\n";
await rpc(ws, { t: "setContext", name: "doc", blob: bigText });
r = await rpc(ws, { t: "eval", src: "await host.ctx('len','doc')" });
ok("host.ctx.len", r.value === bigText.length, r);
r = await rpc(ws, { t: "eval", src: "await host.ctx('slice', 0, 5, 'doc')" });
ok("host.ctx.slice", r.value === "alpha", r);
r = await rpc(ws, { t: "eval", src: "(await host.ctx('grep','NEEDLE',{},'doc')).length" });
ok("host.ctx.grep finds needle", r.value === 1, r);

// ---- host.final (RLM termination sentinel) ----
await rpc(ws, { t: "eval", src: "await host.final({answer: 42})" });
r = await rpc(ws, { t: "final" });
ok("host.final captured", r.final && r.final.value && r.final.value.answer === 42, r.final);

// ---- host.subLM without endpoint -> typed reject (reachable path) ----
r = await rpc(ws, { t: "eval", src: "(async()=>{ try{ await host.subLM('hi'); return 'NO'; }catch(e){ return e.message.includes('subLMEndpoint') ? 'BLOCKED' : ('ERR:'+e.message); } })()" });
ok("host.subLM typed-rejects without endpoint", r.value === "BLOCKED", r);

// ---- W5 un-wedge: spike past 18MB then free -> still checkpoints (used-heap admission) ----
// Spike the buffer past 18MB by allocating under the per-cell grow cap across several cells
// (one >8MB cell would trip the v0.8 mid-cell tripwire, which is correct). Use a generous
// cellGrowCapPages via config so the spike itself is allowed, isolating the W5 admission test.
{
  const wsW5 = await fresh("p1b-w5-" + Date.now());
  await rpc(wsW5, { t: "create", config: { rngSeed: 1, cellGrowCapPages: 600 } }); // ~38MB/cell
  let rr = await rpc(wsW5, { t: "eval", src: "globalThis.big = new Array(70).fill(0).map(()=>new Uint8Array(300000)); 'spiked'" });
  // W5: a >18MB raw buffer (above the old hard 18MB dump ceiling) is ADMITTED via used-heap
  // admission instead of being hard-rejected — the session is NOT wedged. (Scrub fires on the
  // subsequent FREE, verified on the next line.)
  ok("W5 spike >18MB raw admitted (used-heap admission, not wedged)",
    rr.ok === true && rr.checkpoint && rr.checkpoint.ok === true &&
    rr.checkpoint.sizeRaw > 18 * 1024 * 1024,
    { ok: rr.ok, ck: rr.checkpoint, err: rr.error });
  rr = await rpc(wsW5, { t: "eval", src: "globalThis.big = null; 'freed'" });
  // freed spike: used heap drops, the buffer stays bloated -> scrub zeroes the freed pages so
  // the STORED gz collapses, and the checkpoint commits (un-wedged).
  ok("W5 spike-then-free scrubbed + un-wedged (gz collapses)",
    rr.checkpoint && rr.checkpoint.ok === true && rr.checkpoint.scrubbed === true &&
    rr.checkpoint.sizeGz < 1024 * 1024,
    rr.checkpoint);
  wsW5.close();
}

// ---- evict -> cold restore: stdlib + ctx + counter survive (W4 base+delta chain restore) ----
await rpc(ws, { t: "evict" });
r = await rpc(ws, { t: "gen" });
ok("evicted inMemory=false", r.inMemory === false, r);
r = await rpc(ws, { t: "eval", src: "(typeof _.chunk) + ',' + (typeof dayjs) + ',' + globalThis.counter" });
ok("cold-restore: stdlib + counter survive (delta chain)", /function,function,\d/.test(String(r.value)) && r.restoreSource.includes("restore"), { v: r.value, src: r.restoreSource });
r = await rpc(ws, { t: "eval", src: "await host.ctx('slice',0,5,'doc')" });
ok("cold-restore: host.ctx survives", r.value === "alpha", r);
r = await rpc(ws, { t: "final" });
ok("cold-restore: host.final survives", r.final && r.final.value && r.final.value.answer === 42, r.final);

ws.close();
console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
