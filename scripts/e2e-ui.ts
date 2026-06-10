#!/usr/bin/env node

import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../config/deployed-endpoints.json", import.meta.url), "utf8"),
);
const publicEndpoints = manifest.public;

const UI_URL = process.env.UI_URL || publicEndpoints.ui.http;
const KERNEL_ENDPOINT = process.env.KERNEL_ENDPOINT || publicEndpoints.kernel.defaultWs;
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

function assetUrls(html) {
  return Array.from(html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g), (m) => m[1]);
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
    const timer = setTimeout(() => {
      if (waiter) {
        waiter = null;
        resolve({ __timeout: true });
      }
    }, timeoutMs);
    waiter = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
    ws.send(JSON.stringify(obj));
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
  assertPass("kernel large source handled without socket loss",
    blocked && !blocked.__closed && !blocked.__timeout,
    JSON.stringify({ ok: blocked?.ok, value: blocked?.value, error: blocked?.error }));
  const afterLarge = await c.send({ t: "eval", src: "1+1" });
  assertPass("kernel recovers after large source", afterLarge.ok !== false && afterLarge.value === 2, JSON.stringify(afterLarge));

  const wedge = await c.send({ t: "wedgeTest", spikeMb: 22 }, 60000);
  if (wedge?.checkpoint) {
    assertPass("kernel W5 spike/free checkpoint", wedge.checkpoint.scrubbed === true, JSON.stringify(wedge.checkpoint));

    await c.send({ t: "evict" });
    const wedgeRestore = await c.send({ t: "eval", src: "x" });
    assertPass("kernel post-wedge cold restore", wedgeRestore.ok !== false && wedgeRestore.value === 43 && /restore/.test(wedgeRestore.restoreSource || ""), JSON.stringify({ value: wedgeRestore.value, restoreSource: wedgeRestore.restoreSource }));
  } else {
    console.log("SKIP kernel W5 spike/free checkpoint :: wedgeTest hook unavailable on this endpoint");
  }

  c.close();
}

const uiBase = UI_URL.replace(/\/+$/, "");
const htmlUrl = uiBase + "/?endpoint=" + encodeURIComponent(KERNEL_ENDPOINT) + "&session=root-e2e-preview";
await checkFetch("ui spa fallback", uiBase + "/healthz", (r, body) =>
  (r.headers.get("content-type") || "").includes("text/html") &&
  body.includes("<title>Engram") &&
  body.includes("Run E2E")
);
const html = await checkFetch("ui html test surface", htmlUrl, (_r, body) =>
  body.includes("Run E2E") &&
  body.includes("/assets/") &&
  !body.includes("engram-bench-w4.umg-bhalla88.workers.dev")
);
const assets = assetUrls(html);
assertPass("ui assets are referenced", assets.length > 0, assets.join(", "));
const jsAsset = assets.find((u) => u.endsWith(".js"));
assertPass("ui js asset is referenced", !!jsAsset, assets.join(", "));
const js = await checkFetch("ui js asset test hooks", uiBase + jsAsset, (_r, body) =>
  body.includes("__ENGRAM_E2E__") &&
  body.includes("engram-kernel.umg-bhalla88.workers.dev")
);
assertPass("ui endpoint query is supported", /endpoint=/.test(htmlUrl) && js.includes("endpoint"), htmlUrl);
await kernelProtocolE2e();
console.log("\n==== FULL UI/KERNEL E2E PASS ====");
