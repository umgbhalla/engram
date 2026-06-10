// RUNTIME-VERIFY engram-rust1b: E6 oplog + engine-migration replay; no-regression.
import WebSocket from "ws";
const BASE = "engram-rust1b.umg-bhalla88.workers.dev";
let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + "  got=" + JSON.stringify(got)); } };
function fresh(id) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${id}&apiKey=${process.env.ENGRAM_KERNEL_KEY||""}`);
    ws.on("error", rej); ws.once("open", () => res(ws));
  });
}
function rpc(ws, msg) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + JSON.stringify(msg).slice(0, 80))), 35000);
    ws.once("message", (d) => { clearTimeout(t); res(JSON.parse(d.toString())); });
    ws.send(JSON.stringify(msg));
  });
}

// ===== (1) E6: oplog row appends per cell + engine-migration replay rebuilds state =====
console.log("\n=== E6 oplog + engine-migration replay ===");
{
  const ws = await fresh("e6-" + Date.now());
  let r = await rpc(ws, { t: "create", config: { rngSeed: 5 } });
  ok("create ok", r.ok, r);

  // run cells; each checkpoint should advance cell# and deltaSeq (oplog tail row appended).
  const seqs = [];
  for (let i = 1; i <= 4; i++) {
    r = await rpc(ws, { t: "eval", src: `globalThis.acc = (globalThis.acc||0) + ${i}; await host.kv('set','c${i}', String(globalThis.acc)); globalThis.acc` });
    seqs.push({ cell: r.checkpoint && r.checkpoint.cell, deltaSeq: r.checkpoint && r.checkpoint.deltaSeq, val: r.value });
  }
  ok("4 cells evaluated, acc accumulates 1,3,6,10", JSON.stringify(seqs.map(s => s.val)) === "[1,3,6,10]", seqs);
  // oplog appends per cell: cell# strictly increases across the 4 evals (one oplog row per committed cell)
  const cells = seqs.map(s => s.cell);
  ok("oplog row appends per cell (cell# monotonic increasing)",
     cells.every((c, i) => typeof c === "number" && (i === 0 || c > cells[i - 1])), cells);

  // force engine mismatch -> next eval cold-restores via OPLOG-REPLAY into a fresh engine.
  r = await rpc(ws, { t: "_forceEngineMismatch" });
  ok("_forceEngineMismatch hook ok", r.ok, r);
  r = await rpc(ws, { t: "gen" });
  ok("in-memory glue dropped (inMemory=false)", r.inMemory === false, r);

  // eval after mismatch triggers replayJournal rebuild; state must be intact (not bricked).
  r = await rpc(ws, { t: "eval", src: "globalThis.acc" });
  ok("engine-migration: restoreSource = engine-migration-replay", r.restoreSource === "engine-migration-replay", { src: r.restoreSource });
  ok("engine-migration: state rebuilt from oplog (acc===10, not bricked)", r.value === 10, r);
  // closures / kv rebuilt too
  r = await rpc(ws, { t: "eval", src: "await host.kv('get','c4')" });
  ok("engine-migration: kv rebuilt from oplog (c4===10)", r.value === "10", r);
  // session keeps moving forward after replay
  r = await rpc(ws, { t: "eval", src: "globalThis.acc += 5; globalThis.acc" });
  ok("engine-migration: session moves forward post-replay (acc===15)", r.value === 15, r);
  ws.close();
}

// ===== (2) NO-REGRESSION =====
console.log("\n=== no-regression: functional eval/state/evict->cold-restore ===");
{
  const ws = await fresh("reg-" + Date.now());
  let r = await rpc(ws, { t: "create", config: { rngSeed: 7 } });
  ok("create ok", r.ok, r);
  r = await rpc(ws, { t: "eval", src: "1+2*3" });
  ok("arith=7", r.value === 7, r);
  await rpc(ws, { t: "eval", src: "globalThis.x=42;" });
  await rpc(ws, { t: "eval", src: "let _n=100; globalThis.inc=()=>{_n+=1;return _n;};" });
  r = await rpc(ws, { t: "eval", src: "globalThis.inc()" });
  ok("stateful closure inc=101", r.value === 101, r);
  await rpc(ws, { t: "eval", src: "await host.kv('set','k','v1')" });

  // evict -> genuine cold restore
  await rpc(ws, { t: "evict" });
  r = await rpc(ws, { t: "gen" });
  ok("evicted inMemory=false", r.inMemory === false, r);
  r = await rpc(ws, { t: "eval", src: "globalThis.x" });
  ok("cold-restore: x===42 survives", r.value === 42 && /restore/.test(String(r.restoreSource)), { v: r.value, src: r.restoreSource });
  r = await rpc(ws, { t: "eval", src: "globalThis.inc()" });
  ok("cold-restore: closure inc=102 (live state, no replay)", r.value === 102, r);
  r = await rpc(ws, { t: "eval", src: "await host.kv('get','k')" });
  ok("cold-restore: kv survives", r.value === "v1", r);
  ws.close();
}

console.log("\n=== W5 spike-then-free still checkpoints (used-heap admission) ===");
{
  const ws = await fresh("w5-" + Date.now());
  await rpc(ws, { t: "create", config: { rngSeed: 1, cellGrowCapPages: 600 } });
  let r = await rpc(ws, { t: "eval", src: "globalThis.big = new Array(70).fill(0).map(()=>new Uint8Array(300000)); 'spiked'" });
  ok("W5 spike >18MB raw admitted (not wedged)",
     r.ok === true && r.checkpoint && r.checkpoint.ok === true && r.checkpoint.sizeRaw > 18 * 1024 * 1024,
     { ok: r.ok, ck: r.checkpoint, err: r.error });
  r = await rpc(ws, { t: "eval", src: "globalThis.big = null; 'freed'" });
  ok("W5 spike-then-free scrubbed + checkpoints (gz collapses)",
     r.checkpoint && r.checkpoint.ok === true && r.checkpoint.scrubbed === true && r.checkpoint.sizeGz < 1024 * 1024,
     r.checkpoint);
  ws.close();
}

console.log("\n=== buffer-growth tripwire still fires (mid-cell) ===");
{
  const ws = await fresh("trip-" + Date.now());
  await rpc(ws, { t: "create", config: { rngSeed: 1 } }); // default per-cell grow cap (8MB)
  // a single cell that grows the buffer past the per-cell cap -> typed MemoryLimitError, socket alive.
  let r = await rpc(ws, { t: "eval", src: "globalThis.bomb = new Array(50).fill(0).map(()=>new Uint8Array(500000)); 'no-trip'" });
  ok("buffer-growth tripwire fires (typed MemoryLimitError)",
     r.ok === false && r.error && /Memory|Limit|memory/i.test(JSON.stringify(r.error)),
     { ok: r.ok, error: r.error });
  // socket alive: next eval works
  r = await rpc(ws, { t: "eval", src: "1+1" });
  ok("socket alive after tripwire (next eval works)", r.ok && r.value === 2, r);
  ws.close();
}

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
