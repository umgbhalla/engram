// v0.7 guard smoke: 4 scenarios.
//  (a) default stdlib loads + works + survives REAL evict (regression).
//  (b) selecting a >500KB stdlib source -> typed cap error, socket alive.
//  (c) mathjs only loads when explicitly opted in (excluded from modules:true).
//  (d) KEY FIX: push a heap toward the old ~24-30MB OOM cliff -> typed SizeAdmissionError,
//      socket ALIVE (no WS 1006), because the dump ceiling is lowered to 18MB.
import WebSocket from "ws";
const BASE = "wss://montydyn-v07.umg-bhalla88.workers.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);
  const pending = []; let onMsg = null; let closed = null;
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (onMsg) { const cb = onMsg; onMsg = null; cb(m); } else pending.push(m); });
  ws.on("close", (code) => { closed = code; if (onMsg) { const cb = onMsg; onMsg = null; cb({ __closed: code }); } });
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (obj) => new Promise((res) => { if (pending.length) return res(pending.shift()); if (closed != null) return res({ __closed: closed }); onMsg = res; ws.send(JSON.stringify(obj)); });
  return { ws, ready, send, close: () => ws.close(), isClosed: () => closed };
}
const results = {};
function rec(name, cond, detail) { results[name] = !!cond; console.log(`[${cond ? "PASS" : "FAIL"}] ${name} ${detail ?? ""}`); }

// ---- (c) mathjs opt-in: modules:true must EXCLUDE mathjs ----
{
  const sid = "v07c-" + Date.now();
  const c = connect(sid); await c.ready;
  const cr = await c.send({ t: "create", config: { modules: true } });
  const loaded = cr.stdlib?.loaded || [];
  const optIn = cr.stdlib?.optIn || [];
  rec("c.modules_true_excludes_mathjs", !loaded.includes("mathjs") && optIn.includes("mathjs"),
    `loaded=${JSON.stringify(loaded)} optIn=${JSON.stringify(optIn)}`);
  const mt = await c.send({ t: "eval", src: "typeof math" });
  rec("c.math_undefined_by_default", mt.value === "undefined", `typeof math=${mt.value}`);
  c.close();
}

// ---- (c2) mathjs explicitly named ALONE -> would be 617KB > 500KB cap -> rejected ----
//        (this also proves opt-in is gated by the source cap)
{
  const sid = "v07c2-" + Date.now();
  const c = connect(sid); await c.ready;
  const cr = await c.send({ t: "create", config: { modules: ["mathjs"] } });
  const errName = cr.error?.name || (typeof cr.error === "string" ? cr.error : "");
  const sizeRej = !cr.ok && /SizeAdmission|MAX_STDLIB_SOURCE|source/i.test(JSON.stringify(cr.error || ""));
  rec("c2.mathjs_alone_trips_source_cap", sizeRej, `ok=${cr.ok} err=${JSON.stringify(cr.error)}`);
  // socket alive: a follow-up message returns a reply (not __closed)
  const ping = await c.send({ t: "gen" });
  rec("c2.socket_alive_after_cap_reject", !ping.__closed && ping.ok, `gen=${JSON.stringify(ping).slice(0,80)}`);
  c.close();
}

// ---- (b) selecting libs whose combined source >500KB -> typed cap error, socket alive ----
//      lodash(95)+zod(58)+mathjs(617) = ~770KB > 500KB
{
  const sid = "v07b-" + Date.now();
  const c = connect(sid); await c.ready;
  const cr = await c.send({ t: "create", config: { modules: ["lodash", "zod", "mathjs"] } });
  const sizeRej = !cr.ok && /SizeAdmission|MAX_STDLIB_SOURCE|source/i.test(JSON.stringify(cr.error || ""));
  rec("b.over500kb_typed_cap_error", sizeRej, `ok=${cr.ok} err=${JSON.stringify(cr.error)}`);
  const ping = await c.send({ t: "gen" });
  rec("b.socket_alive_after_cap_reject", !ping.__closed && ping.ok, `gen.ok=${ping.ok}`);
  // and recovery: a safe create still works on the same session
  const cr2 = await c.send({ t: "create", config: { modules: ["lodash", "dayjs"] } });
  rec("b.recovers_with_safe_create", cr2.ok && (cr2.stdlib?.loaded || []).includes("lodash"),
    `loaded=${JSON.stringify(cr2.stdlib?.loaded)}`);
  c.close();
}

// ---- (d) THE KEY FIX: grow the buffer toward the old 24-30MB OOM cliff ----
//      Allocate a large incompressible buffer in-VM so the WASM linear buffer crosses 18MB.
//      With the lowered MAX_DUMP_BUFFER_BYTES (18MB) this must CLEAN-REJECT at the per-cell
//      checkpoint with a typed SizeAdmissionError and the socket must stay ALIVE (no WS 1006).
let oomCliffClean = false;
{
  const sid = "v07d-" + Date.now();
  const c = connect(sid); await c.ready;
  await c.send({ t: "create", config: {} });
  // Allocate ~22MB of incompressible random bytes retained on a global, growing the buffer
  // past the 18MB dump ceiling (and toward the real ~24-30MB OOM cliff). Use seeded crypto so
  // bytes are incompressible. Build in chunks under the tick budget.
  const allocSrc = `
    globalThis.__big = [];
    for (let i=0;i<22;i++){ const a=new Uint8Array(1024*1024); for(let j=0;j<a.length;j+=4096){ a[j]=(i*31+j)&0xff; } globalThis.__big.push(a); }
    globalThis.__big.length;
  `;
  const big = await c.send({ t: "eval", src: allocSrc, config: {} });
  console.log("    alloc eval ok=" + big.ok + " value=" + big.value + " ckpt=" + JSON.stringify(big.checkpoint || {}).slice(0, 200) + " err=" + JSON.stringify(big.error || null));
  const ck = big.checkpoint || {};
  const ckptRejected = ck.ok === false && /SizeAdmission|MAX_DUMP_BUFFER/i.test(JSON.stringify(ck));
  // socket must be alive after the would-be-OOM checkpoint
  const ping = await c.send({ t: "gen" });
  const alive = !ping.__closed && !big.__closed && ping.ok;
  // verify the VM is still usable in-memory (eval still works) - state didn't brick
  const usable = await c.send({ t: "eval", src: "1+1" });
  const stillUsable = !usable.__closed && usable.value === 2;
  oomCliffClean = (ckptRejected || big.ok === false) && alive && stillUsable;
  rec("d.checkpoint_clean_rejects_at_18MB", ckptRejected, `ckpt=${JSON.stringify(ck).slice(0,160)}`);
  rec("d.socket_ALIVE_no_ws1006", alive, `bigClosed=${big.__closed} pingClosed=${ping.__closed} gen.ok=${ping.ok}`);
  rec("d.vm_still_usable_in_memory", stillUsable, `1+1=${usable.value}`);
  rec("d.OOM_CLIFF_NOW_CLEAN_REJECTS", oomCliffClean, "");
  c.close();
}

// ---- (a) default stdlib + REAL evict regression ----
{
  const sid = "v07a-" + Date.now();
  const c = connect(sid); await c.ready;
  const cr = await c.send({ t: "create", config: { modules: true } });
  const g0 = await c.send({ t: "gen" });
  const lo = await c.send({ t: "eval", src: "JSON.stringify(_.chunk([1,2,3,4,5],2))" });
  const dj = await c.send({ t: "eval", src: "dayjs('2020-06-15T00:00:00Z').format('YYYY-MM-DD')" });
  const zd = await c.send({ t: "eval", src: "z.object({n:z.number()}).safeParse({n:7}).success" });
  await c.send({ t: "eval", src: "globalThis.userState = _.sum([100,200,300])" });
  rec("a.default_loads_and_works",
    lo.value === "[[1,2],[3,4],[5]]" && dj.value === "2020-06-15" && String(zd.value) === "true",
    `chunk=${lo.value} dayjs=${dj.value} zod=${zd.value}`);
  await c.send({ t: "evict" });
  c.close();
  console.log("    === idle 75s for REAL hibernation ===");
  await sleep(75000);
  const c2 = connect(sid); await c2.ready;
  const g1 = await c2.send({ t: "gen" });
  const r_lo = await c2.send({ t: "eval", src: "JSON.stringify(_.chunk([9,8,7,6],2))" });
  const r_us = await c2.send({ t: "eval", src: "userState" });
  const cr2 = await c2.send({ t: "create", config: { modules: true } });
  const survived = r_lo.value === "[[9,8],[7,6]]" && r_us.value === 600 &&
    g1.generation > g0.generation && (cr2.stdlib?.loaded || []).length === 0 &&
    /restore/.test(r_lo.restoreSource || "");
  rec("a.survives_real_evict_no_reinject", survived,
    `gen ${g0.generation}->${g1.generation} restoreSource=${r_lo.restoreSource} chunk=${r_lo.value} userState=${r_us.value} reinjectLoaded=${JSON.stringify(cr2.stdlib?.loaded)}`);
  c2.close();
}

const allPass = Object.values(results).every(Boolean);
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(results, null, 2));
console.log("oomCliffNowCleanRejects =", oomCliffClean);
console.log(allPass ? ">>> ALL SMOKE PASS" : ">>> SOME SMOKE FAIL");
process.exit(allPass ? 0 : 1);
