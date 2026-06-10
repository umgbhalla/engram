#!/usr/bin/env node

import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../config/deployed-endpoints.json", import.meta.url), "utf8"),
);
const publicEndpoints = manifest.public;

const endpoints = {
  kernelWs: process.env.ENGRAM_KERNEL_WS || publicEndpoints.kernel.defaultWs,
  cloud: process.env.ENGRAM_CLOUD_URL || publicEndpoints.cloud.http,
  ui: process.env.ENGRAM_UI_URL || publicEndpoints.ui.http,
  docs: process.env.ENGRAM_DOCS_URL || publicEndpoints.docs.http,
};

let failures = 0;

function pass(name, detail) {
  console.log(`PASS ${name} :: ${detail}`);
}

function fail(name, detail) {
  failures++;
  console.log(`FAIL ${name} :: ${detail}`);
}

async function text(url, init) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init });
  return { res, body: await res.text() };
}

async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

function kernelRpc(frame, session = `live-smoke-${Date.now().toString(36)}`) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${endpoints.kernelWs.replace(/\/+$/, "")}/ws?id=${encodeURIComponent(session)}`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("kernel websocket timeout"));
    }, 20_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify(frame)), { once: true });
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      resolve(JSON.parse(data));
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("kernel websocket open failed"));
    }, { once: true });
  });
}

await check("kernel websocket eval", async () => {
  const reply = await kernelRpc({ t: "eval", src: "21 * 2" });
  if (reply?.ok !== false && reply?.value === 42) pass("kernel websocket eval", `value=${reply.value}`);
  else fail("kernel websocket eval", JSON.stringify(reply).slice(0, 240));
});

await check("cloud /health", async () => {
  const { res, body } = await text(`${endpoints.cloud}/health`);
  let json;
  try { json = JSON.parse(body); } catch {}
  if (res.ok && json?.ok === true && json?.kernel === "rust") {
    pass("cloud /health", `${res.status} kernel=${json.kernel} codeId=${json.codeId || "unknown"}`);
  } else {
    fail("cloud /health", `${res.status} ${body.slice(0, 200)}`);
  }
});

await check("cloud /usage auth gate", async () => {
  const { res, body } = await text(`${endpoints.cloud}/usage`);
  let json;
  try { json = JSON.parse(body); } catch {}
  if (res.status === 401 && json?.error === "unauthorized") pass("cloud /usage auth gate", "401 unauthorized");
  else fail("cloud /usage auth gate", `${res.status} ${body.slice(0, 200)}`);
});

await check("ui html", async () => {
  const { res, body } = await text(endpoints.ui);
  if (res.ok && body.includes("<title>Engram") && body.includes("Run E2E")) pass("ui html", `${res.status} shell`);
  else fail("ui html", `${res.status} ${body.slice(0, 200)}`);
});

await check("docs html", async () => {
  const { res, body } = await text(endpoints.docs);
  if (res.ok && body.includes("Engram")) pass("docs html", `${res.status} shell`);
  else fail("docs html", `${res.status} ${body.slice(0, 200)}`);
});

if (failures) {
  console.error(`\n${failures} live smoke check(s) failed`);
  process.exit(1);
}

console.log("\n==== LIVE SMOKE PASS ====");
