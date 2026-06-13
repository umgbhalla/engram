#!/usr/bin/env node

import { readFileSync } from "node:fs";
import WebSocket from "ws";

const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(new URL("../config/deployed-endpoints.json", import.meta.url), "utf8"));
const endpoint = String(args.endpoint || process.env.ENGRAM_KERNEL_WS || manifest.public.kernel.defaultWs);
const session = String(args.session || "queue-backpressure-" + Date.now().toString(36));
const count = positiveInt(args.count, 32);
const timeoutMs = positiveInt(args.timeoutMs, 60_000);
const kernelKey = process.env.ENGRAM_KERNEL_KEY || process.env.ENGRAM_API_KEY || "";

if (!kernelKey) {
  console.error("ENGRAM_KERNEL_KEY or ENGRAM_API_KEY must be loaded");
  process.exit(2);
}

const headers = {
  Authorization: "Bearer " + kernelKey,
  "Cloudflare-Workers-Version-Key": session,
};
if (args.versionId) {
  headers["Cloudflare-Workers-Version-Overrides"] = `engram-kernel="${args.versionId}"`;
}

const ws = await openWs(endpoint.replace(/\/+$/, "") + "/ws?id=" + encodeURIComponent(session), headers);
try {
  await rpc(ws, { t: "eval", reqId: session + ":setup", src: "globalThis.__bp = []; 'ready'" }, timeoutMs);
  const replies = await flood(ws, count, timeoutMs);
  const status = await rpc(ws, { t: "gen" }, timeoutMs);
  const accepted = replies.filter((r) => r.ok !== false).length;
  const rejected = replies.filter((r) => r.error?.name === "QueueFullError").length;
  const otherErrors = replies.filter((r) => r.ok === false && r.error?.name !== "QueueFullError");
  const maxQueueDepth = Number(status.maxQueueDepth || 16);
  const ok = rejected > 0 && accepted <= maxQueueDepth && otherErrors.length === 0 && Number(status.queueDepth || 0) <= maxQueueDepth;

  console.log(JSON.stringify({
    ok,
    endpoint,
    session,
    count,
    accepted,
    rejected,
    otherErrors: otherErrors.slice(0, 3),
    status: {
      versionId: status.versionId,
      activeEval: status.activeEval,
      queueDepth: status.queueDepth,
      maxQueueDepth: status.maxQueueDepth,
    },
  }, null, 2));

  if (!ok) process.exitCode = 1;
} finally {
  try { ws.close(); } catch {}
}

function flood(ws, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    const replies = [];
    const timer = setTimeout(() => reject(new Error("flood timed out after " + replies.length + "/" + n + " replies")), timeoutMs);
    const onMessage = (data) => {
      const msg = parseMessage(data);
      if (msg?.t !== "eval") return;
      replies.push(msg);
      if (replies.length === n) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(replies);
      }
    };
    ws.on("message", onMessage);
    for (let i = 0; i < n; i++) {
      const hold = i === 0 ? "let __s = 0; for (let j = 0; j < 4000000; j++) __s += j;" : "";
      ws.send(JSON.stringify({
        t: "eval",
        reqId: session + ":flood:" + i,
        src: hold + "globalThis.__bp.push(" + i + "); __bp.length",
      }));
    }
  });
}

function rpc(ws, frame, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("rpc timed out: " + frame.t));
    }, timeoutMs);
    const onMessage = (data) => {
      const msg = parseMessage(data);
      if (msg?.t !== frame.t) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify(frame));
  });
}

function openWs(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), 20_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseMessage(data) {
  return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = raw.slice(2, eq < 0 ? undefined : eq).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = eq < 0 ? true : raw.slice(eq + 1);
  }
  return out;
}
