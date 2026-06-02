// W5 WEDGE TEST against engram-bench-w5.
// 1) Establish state. 2) wedgeTest: spike heap past old ~18MB raw dump ceiling, FREE it,
//    then CHECKPOINT — baseline returns SizeAdmissionError (permanent wedge); W5 must succeed.
// 3) Force genuine evict + cold-restore, confirm state survives.
import WebSocket from "ws";

const BASE = process.argv[2] || "wss://engram-bench-w5.umg-bhalla88.workers.dev";
const SPIKE_MB = Number(process.argv[3] || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function connect(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);
  const pending = []; let onMsg = null;
  ws.on("message", (d) => { const m = JSON.parse(d.toString());
    if (onMsg) { const cb = onMsg; onMsg = null; cb(m); } else pending.push(m); });
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (obj) => new Promise((res, rej) => {
    if (pending.length) return res(pending.shift());
    onMsg = res;
    ws.on("error", rej);
    ws.on("close", (code) => rej(new Error("WS CLOSED code=" + code)));
    ws.send(JSON.stringify(obj));
  });
  return { ws, ready, send, close: () => ws.close() };
}

(async () => {
  const id = `wedge-${Date.now()}`;
  log(`W5 WEDGE TEST -> ${BASE}  session=${id}  spikeMb=${SPIKE_MB}`);
  const c = connect(id);
  await c.ready;

  // 1) state
  const s1 = await c.send({ t: "eval", src: "globalThis.x=42; globalThis.inc=()=>++x; globalThis.tag='alive'; x" });
  log("setup eval x=", s1.value, "checkpoint.store=", s1.checkpoint?.store, "sizeGz=", s1.checkpoint?.sizeGz);

  // 2) THE WEDGE: spike + free + checkpoint
  log(`\n=== wedgeTest: spike ${SPIKE_MB}MB, free, then checkpoint ===`);
  let wedge;
  try {
    wedge = await c.send({ t: "wedgeTest", spikeMb: SPIKE_MB });
  } catch (e) {
    log(">>> FAIL: socket died during wedgeTest:", e.message);
    process.exit(1);
  }
  const ck = wedge.checkpoint || {};
  log("memSpiked:", JSON.stringify(wedge.memSpiked));
  log("memFreed :", JSON.stringify(wedge.memFreed));
  log("checkpoint:", JSON.stringify(ck));
  log(`>>> wedgeCleared=${wedge.wedgeCleared}  store=${ck.store}  sizeGz=${ck.sizeGz}  ` +
      `sizeRaw=${ck.sizeRaw}  usedHeap=${ck.usedHeap}  bufferBytes=${ck.bufferBytes}  scrubbed=${ck.scrubbed}`);

  // verify still usable + checkpoint actually committed
  const after = await c.send({ t: "eval", src: "inc()" });
  log("post-wedge eval inc() =", after.value, "(expect 43)");

  // 3) genuine evict + cold restore
  log("\n=== force evict (drop in-memory) + cold restore ===");
  log("evict:", JSON.stringify(await c.send({ t: "evict" })));
  const g = await c.send({ t: "gen" });
  log("gen after evict:", JSON.stringify(g));
  // close and idle to provoke real reconstruction too
  c.close();
  await sleep(1500);
  const c2 = connect(id);
  await c2.ready;
  const rx = await c2.send({ t: "eval", src: "x" });
  const rtag = await c2.send({ t: "eval", src: "tag" });
  const rinc = await c2.send({ t: "eval", src: "inc()" });
  log("after cold restore: x=", rx.value, "tag=", rtag.value, "inc()=", rinc.value,
      "restoreSource=", rx.restoreSource, "gen=", rx.generation);
  c2.close();

  const stateOk = Number(rx.value) === 43 && rtag.value === "alive" && Number(rinc.value) === 44;
  const restored = rx.restoreSource && rx.restoreSource !== "warm";
  const PASS = wedge.wedgeCleared === true && stateOk && restored;
  log("\n===== W5 WEDGE VERDICT =====");
  log(JSON.stringify({
    PASS,
    wedgeCleared: wedge.wedgeCleared,
    checkpointStore: ck.store,
    storedSizeGz: ck.sizeGz,
    storedSizeRaw: ck.sizeRaw,
    usedHeap: ck.usedHeap,
    bufferBytes: ck.bufferBytes,
    scrubbed: ck.scrubbed,
    coldRestoreSource: rx.restoreSource,
    coldState: { x: rx.value, tag: rtag.value, inc: rinc.value },
    stateSurvived: stateOk,
  }, null, 2));
  process.exit(PASS ? 0 : 2);
})().catch((e) => { console.error("CLIENT ERROR:", e); process.exit(1); });
