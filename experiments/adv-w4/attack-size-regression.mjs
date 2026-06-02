// Targeted regression for the W4 adversarial breach:
// - giant eval source is refused before VM eval
// - giant websocket frame is refused before JSON parse
// - W5 spike-then-free still checkpoints after the admission fix
import WebSocket from "ws";

const BASE = process.env.BASE || process.argv[2];
if (!BASE) {
  console.error("usage: BASE=wss://<worker> node attack-size-regression.mjs");
  process.exit(2);
}

function connect(id) {
  const url = BASE + "/ws?id=" + encodeURIComponent(id);
  const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
  const pending = [];
  let waiter = null;
  let closed = null;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(m);
    } else {
      pending.push(m);
    }
  });
  ws.on("close", (code, reason) => {
    closed = { code, reason: reason?.toString() || "" };
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ __closed: closed });
    }
  });
  ws.on("error", () => {});
  const open = () => new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  const sendRaw = (raw, timeoutMs = 30000) => new Promise((res) => {
    if (closed) return res({ __closed: closed });
    if (pending.length) return res(pending.shift());
    waiter = res;
    ws.send(raw);
    setTimeout(() => {
      if (waiter) {
        waiter = null;
        res({ __timeout: true });
      }
    }, timeoutMs);
  });
  const send = (obj, timeoutMs) => sendRaw(JSON.stringify(obj), timeoutMs);
  return { ws, open, send, sendRaw, get closed() { return closed; }, close: () => ws.close() };
}

const results = [];
function rec(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "PASS" : "FAIL") + " " + name + " :: " + detail);
}

function errorName(r) {
  return r?.error?.name || (typeof r?.error === "string" ? r.error : "");
}

async function oversizedEvalSource() {
  const c = connect("w4-size-src-" + Date.now());
  await c.open();
  const src = "'a'.repeat(1);" + " ".repeat(3 * 1024 * 1024);
  const r = await c.send({ t: "eval", src });
  const blocked = r.ok === false && errorName(r) === "ProtocolSizeError";
  rec("oversized eval source rejected before VM eval", blocked, JSON.stringify({
    ok: r.ok,
    error: errorName(r),
    closed: !!r.__closed,
    timeout: !!r.__timeout,
  }));
  const alive = await c.send({ t: "eval", src: "1+1" });
  rec("socket alive after source reject", alive.value === 2, JSON.stringify(alive));
  c.close();
}

async function oversizedFrame() {
  const c = connect("w4-size-frame-" + Date.now());
  await c.open();
  const raw = JSON.stringify({ t: "eval", src: "1+1", pad: "x".repeat(9 * 1024 * 1024) });
  const r = await c.sendRaw(raw);
  const blocked = r.ok === false && errorName(r) === "ProtocolSizeError";
  rec("oversized websocket frame rejected before JSON parse", blocked, JSON.stringify({
    ok: r.ok,
    error: errorName(r),
    closed: !!r.__closed,
    timeout: !!r.__timeout,
  }));
  const alive = await c.send({ t: "eval", src: "2+2" });
  rec("socket alive after frame reject", alive.value === 4, JSON.stringify(alive));
  c.close();
}

async function wedgeStillWorks() {
  const c = connect("w4-size-wedge-" + Date.now());
  await c.open();
  await c.send({ t: "create", config: { clock: "seeded", rngSeed: 123, cellBudgetTicks: 200000 } });
  await c.send({ t: "eval", src: "globalThis.keep='before-spike'; keep" });
  const w = await c.send({ t: "wedgeTest", spikeMb: 22 }, 45000);
  const checkpointed = w?.checkpoint && w.checkpoint.ok !== false && (w.checkpoint.sizeGz !== undefined || w.checkpoint.store);
  rec("W5 spike-then-free still checkpoints", !!checkpointed, JSON.stringify({
    checkpoint: w?.checkpoint,
    memSpiked: w?.memSpiked,
    memFreed: w?.memFreed,
  }));
  await c.send({ t: "evict" });
  const restored = await c.send({ t: "eval", src: "keep" }, 30000);
  rec("W5 wedge session cold-restores", restored.value === "before-spike", JSON.stringify(restored));
  c.close();
}

for (const fn of [oversizedEvalSource, oversizedFrame, wedgeStillWorks]) {
  try {
    await fn();
  } catch (e) {
    rec(fn.name, false, e?.stack || String(e));
  }
}

const fails = results.filter((r) => !r.pass);
console.log("\n==== " + (results.length - fails.length) + "/" + results.length + " PASS ====");
process.exit(fails.length ? 1 : 0);
