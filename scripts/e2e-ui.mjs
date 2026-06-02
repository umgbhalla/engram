#!/usr/bin/env node

const UI_URL = process.env.UI_URL || "https://engram-ui.umg-bhalla88.workers.dev";
const KERNEL_ENDPOINT = process.env.KERNEL_ENDPOINT || "wss://engram-bench-w4.umg-bhalla88.workers.dev";
const WS = globalThis.WebSocket;

if (!WS) {
  console.error("global WebSocket is unavailable in this Node runtime; use Node 22+.");
  process.exit(2);
}

async function checkFetch(name, url, predicate) {
  const r = await fetch(url);
  const body = await r.text();
  const ok = r.ok && predicate(r, body);
  console.log((ok ? "PASS" : "FAIL") + " " + name + " :: " + r.status + " " + url);
  if (!ok) throw new Error(name + " failed");
  return body;
}

function connect(id) {
  const base = KERNEL_ENDPOINT.replace(/\/+$/, "");
  const ws = new WS(base + "/ws?id=" + encodeURIComponent(id));
  const pending = [];
  let waiter = null;
  let closed = null;
  ws.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    const msg = JSON.parse(data);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(msg);
    } else {
      pending.push(msg);
    }
  });
  ws.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ __closed: closed });
    }
  });
  const open = () => new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true });
  });
  const send = (obj, timeoutMs = 120000) => new Promise((resolve) => {
    if (closed) return resolve({ __closed: closed });
    if (pending.length) return resolve(pending.shift());
    waiter = resolve;
    ws.send(JSON.stringify(obj));
    setTimeout(() => {
      if (waiter) {
        waiter = null;
        resolve({ __timeout: true });
      }
    }, timeoutMs);
  });
  return { open, send, close: () => ws.close() };
}

function assertPass(name, condition, detail) {
  console.log((condition ? "PASS" : "FAIL") + " " + name + " :: " + detail);
  if (!condition) throw new Error(name + " failed: " + detail);
}

async function kernelProtocolE2e() {
  const id = "root-ui-e2e-" + Date.now().toString(36);
  const c = connect(id);
  await c.open();
  await c.send({ t: "create", config: { clock: "seeded", rngSeed: 777, modules: true, fetch: true, cellBudgetTicks: 200000 } });

  const setup = await c.send({ t: "eval", src: "globalThis.x=42; globalThis.inc=()=>++x; x" });
  assertPass("kernel eval writes durable state", setup.ok !== false && setup.value === 42, JSON.stringify({ value: setup.value, error: setup.error }));

  await c.send({ t: "evict" });
  const cold = await c.send({ t: "gen" });
  assertPass("kernel hibernate drops in-memory heap", cold.ok !== false && cold.inMemory === false, JSON.stringify(cold));

  const restored = await c.send({ t: "eval", src: "x" });
  assertPass("kernel cold restore keeps state", restored.ok !== false && restored.value === 42 && /restore/.test(restored.restoreSource || ""), JSON.stringify({ value: restored.value, restoreSource: restored.restoreSource }));

  const closure = await c.send({ t: "eval", src: "inc()" });
  assertPass("kernel closure survives restore", closure.ok !== false && closure.value === 43, JSON.stringify({ value: closure.value }));

  const blocked = await c.send({ t: "eval", src: "'x';" + " ".repeat(3 * 1024 * 1024) });
  assertPass("kernel oversized source guard", blocked.ok === false && blocked.error?.name === "ProtocolSizeError", JSON.stringify(blocked.error));

  const wedge = await c.send({ t: "wedgeTest", spikeMb: 22 }, 60000);
  assertPass("kernel W5 spike/free checkpoint", !!(wedge?.checkpoint && wedge.checkpoint.scrubbed === true), JSON.stringify(wedge?.checkpoint));

  await c.send({ t: "evict" });
  const wedgeRestore = await c.send({ t: "eval", src: "x" });
  assertPass("kernel post-wedge cold restore", wedgeRestore.ok !== false && wedgeRestore.value === 43 && /restore/.test(wedgeRestore.restoreSource || ""), JSON.stringify({ value: wedgeRestore.value, restoreSource: wedgeRestore.restoreSource }));

  c.close();
}

const uiBase = UI_URL.replace(/\/+$/, "");
const htmlUrl = uiBase + "/?endpoint=" + encodeURIComponent(KERNEL_ENDPOINT) + "&session=root-e2e-preview";
await checkFetch("ui healthz", uiBase + "/healthz", (_r, body) => {
  try {
    const j = JSON.parse(body);
    return j.ok === true && j.app === "engram-ui";
  } catch {
    return false;
  }
});
const html = await checkFetch("ui html test surface", htmlUrl, (_r, body) =>
  body.includes("Run E2E") &&
  body.includes("__ENGRAM_E2E__") &&
  body.includes("engram-bench-w4.umg-bhalla88.workers.dev")
);
assertPass("ui endpoint query is supported", /endpoint=/.test(htmlUrl) && html.includes("queryEndpoint"), htmlUrl);
await kernelProtocolE2e();
console.log("\n==== FULL UI/KERNEL E2E PASS ====");
