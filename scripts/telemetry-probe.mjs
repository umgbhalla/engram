#!/usr/bin/env node

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const manifest = JSON.parse(
  readFileSync(new URL("../config/deployed-endpoints.json", import.meta.url), "utf8"),
);

const args = parseArgs(process.argv.slice(2));
const endpoint = String(args.endpoint || process.env.ENGRAM_KERNEL_WS || manifest.public.kernel.defaultWs);
const cloud = String(args.cloud || process.env.ENGRAM_CLOUD_URL || manifest.public.cloud.http);
const ui = String(args.ui || process.env.ENGRAM_UI_URL || manifest.public.ui.http);
const docs = String(args.docs || process.env.ENGRAM_DOCS_URL || manifest.public.docs.http);
const samples = Math.max(1, Number(args.samples || 10));
const timeoutMs = Math.max(1000, Number(args.timeoutMs || 20000));
const out = args.out ? String(args.out) : "";

if (!globalThis.WebSocket) {
  console.error("global WebSocket is unavailable in this Node runtime; use Node 22+.");
  process.exit(2);
}

const startedAt = new Date().toISOString();
const runId = "telemetry-" + Date.now().toString(36);
const result = {
  runId,
  startedAt,
  endpoints: { kernelWs: endpoint, cloud, ui, docs },
  samples,
  note: "External probe only: no kernel/cloud code changes, no in-request telemetry writes, no added user-path latency.",
  http: {},
  ws: [],
  summary: {},
  improvementRegions: [],
};

for (const target of [
  ["kernelHealth", manifest.public.kernel.workersDevHttp.replace(/\/+$/, "") + manifest.public.kernel.healthPath],
  ["cloudHealth", cloud.replace(/\/+$/, "") + manifest.public.cloud.healthPath],
  ["uiHtml", ui],
  ["docsHtml", docs],
]) {
  const [name, url] = target;
  result.http[name] = await timeHttp(url);
}

for (let i = 0; i < samples; i++) {
  result.ws.push(await probeSession(runId + "-" + i));
}

result.summary = summarize(result);
result.improvementRegions = improvementRegions(result);

printReport(result);
if (out) {
  mkdirSync(new URL("../scratch/telemetry/", import.meta.url), { recursive: true });
  const path = out.startsWith("/") ? out : new URL("../" + out, import.meta.url);
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  console.log("\nWrote " + path);
}

if (result.ws.some((s) => s.ok === false)) process.exitCode = 1;

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    parsed[key] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return parsed;
}

async function timeHttp(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      ms: round(performance.now() - t0),
      bytes: body.length,
      bodyHint: body.slice(0, 80),
    };
  } catch (error) {
    return {
      ok: false,
      ms: round(performance.now() - t0),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeSession(session) {
  const sample = { session, ok: false };
  let socket;
  try {
    const opened = await openSocket(session);
    socket = opened.socket;
    sample.openMs = opened.openMs;

    const create = await rpc(socket, { t: "create", config: { clock: "seeded", rngSeed: 1000, capture: true } });
    sample.createMs = create.ms;
    sample.create = compactReply(create.reply);

    const warm = await rpc(socket, { t: "eval", src: "globalThis.__probe=(globalThis.__probe||0)+1; __probe" });
    sample.warmEvalMs = warm.ms;
    sample.warm = compactReply(warm.reply);

    const evict = await rpc(socket, { t: "evict" });
    sample.evictMs = evict.ms;
    sample.evict = compactReply(evict.reply);

    const cold = await rpc(socket, { t: "eval", src: "__probe" });
    sample.coldEvalMs = cold.ms;
    sample.cold = compactReply(cold.reply);
    sample.restoreTimings = cold.reply?.restoreTimings || null;
    sample.restoreSource = cold.reply?.restoreSource || "";
    sample.checkpoint = compactCheckpoint(cold.reply?.checkpoint);
    sample.ok = warm.reply?.ok !== false && cold.reply?.ok !== false && cold.reply?.value === 1;
  } catch (error) {
    sample.error = error instanceof Error ? error.message : String(error);
  } finally {
    try { socket?.close(); } catch {}
  }
  return sample;
}

function openSocket(session) {
  return new Promise((resolve, reject) => {
    const wsUrl = endpoint.replace(/\/+$/, "") + "/ws?id=" + encodeURIComponent(session);
  const _k = process.env.ENGRAM_KERNEL_KEY; const wsUrlAuthed = _k ? wsUrl + "&apiKey=" + encodeURIComponent(_k) : wsUrl;
    const t0 = performance.now();
    const ws = new WebSocket(wsUrlAuthed);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("websocket open timeout"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({ socket: ws, openMs: round(performance.now() - t0) });
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket open failed"));
    }, { once: true });
  });
}

function rpc(ws, frame) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("rpc timeout for " + frame.t));
    }, timeoutMs);
    const onMessage = (event) => {
      cleanup();
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      let reply;
      try { reply = JSON.parse(data); } catch { reply = { ok: false, error: "bad json", raw: data.slice(0, 120) }; }
      resolve({ ms: round(performance.now() - t0), reply });
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before reply"));
    };
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    }
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose, { once: true });
    ws.send(JSON.stringify(frame));
  });
}

function summarize(data) {
  const ok = data.ws.filter((s) => s.ok);
  const failed = data.ws.length - ok.length;
  return {
    ok: failed === 0 && Object.values(data.http).every((h) => h.ok),
    failedSamples: failed,
    openMs: dist(ok.map((s) => s.openMs)),
    createMs: dist(ok.map((s) => s.createMs)),
    warmEvalMs: dist(ok.map((s) => s.warmEvalMs)),
    evictMs: dist(ok.map((s) => s.evictMs)),
    coldEvalMs: dist(ok.map((s) => s.coldEvalMs)),
    serverRestoreMs: dist(ok.map((s) => s.restoreTimings?.totalServerMs).filter(Number.isFinite)),
    readMs: dist(ok.map((s) => s.restoreTimings?.readMs).filter(Number.isFinite)),
    checkpointSizeGz: dist(ok.map((s) => s.checkpoint?.sizeGz).filter(Number.isFinite)),
    checkpointSizeRaw: dist(ok.map((s) => s.checkpoint?.sizeRaw).filter(Number.isFinite)),
    restoreSources: counts(ok.map((s) => s.restoreSource || "unknown")),
  };
}

function improvementRegions(data) {
  const regions = [];
  const s = data.summary;
  const coldP95 = s.coldEvalMs?.p95 ?? 0;
  const warmP95 = s.warmEvalMs?.p95 ?? 0;
  const serverP95 = s.serverRestoreMs?.p95 ?? 0;
  const readP95 = s.readMs?.p95 ?? 0;
  const openP95 = s.openMs?.p95 ?? 0;

  if (data.summary.failedSamples) {
    regions.push("Reliability: " + data.summary.failedSamples + "/" + data.samples + " WebSocket samples failed; inspect route/DNS/socket open path first.");
  }
  if (coldP95 > warmP95 * 3 && serverP95 < coldP95 * 0.5) {
    regions.push("Cold wake path: p95 cold eval " + coldP95 + "ms vs server restore " + serverP95 + "ms, so most tail is platform/network/socket rather than heap restore.");
  }
  if (readP95 > 250) {
    regions.push("Snapshot read path: p95 readMs " + readP95 + "ms; prioritize keeping images in SQLite or reducing R2 reads before CPU work.");
  }
  if (openP95 > 750) {
    regions.push("Connection setup: p95 open " + openP95 + "ms; UI/SDK should keep sockets warm for interactive sessions before optimizing eval internals.");
  }
  if ((s.checkpointSizeGz?.p95 ?? 0) > 1_500_000) {
    regions.push("Snapshot size: p95 gzip " + (s.checkpointSizeGz.p95 / 1_000_000).toFixed(2) + "MB; focus on heap growth/module payloads and R2-overflow risk.");
  }
  if (!regions.length) {
    regions.push("No dominant bottleneck in this small sample; increase --samples or run under targeted payloads before changing runtime code.");
  }
  return regions;
}

function compactReply(reply) {
  if (!reply || typeof reply !== "object") return reply;
  return {
    ok: reply.ok !== false,
    t: reply.t,
    value: reply.value,
    restoreSource: reply.restoreSource,
    inMemoryBefore: reply.inMemoryBefore,
    error: reply.error?.name || reply.error || null,
  };
}

function compactCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object") return null;
  return {
    ok: checkpoint.ok !== false,
    store: checkpoint.store,
    mode: checkpoint.mode,
    sizeGz: checkpoint.sizeGz,
    sizeRaw: checkpoint.sizeRaw,
    usedHeap: checkpoint.usedHeap,
  };
}

function dist(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  return {
    n: xs.length,
    min: round(xs[0]),
    p50: round(pick(xs, 0.5)),
    p90: round(pick(xs, 0.9)),
    p95: round(pick(xs, 0.95)),
    max: round(xs[xs.length - 1]),
  };
}

function pick(xs, q) {
  return xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * q))];
}

function counts(values) {
  return values.reduce((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function printReport(data) {
  console.log("Engram telemetry probe " + data.runId);
  console.log("kernel " + data.endpoints.kernelWs);
  console.log("samples " + data.samples);
  console.log("\nHTTP");
  for (const [name, h] of Object.entries(data.http)) {
    console.log("  " + name + ": " + (h.ok ? "PASS" : "FAIL") + " " + (h.status || "") + " " + h.ms + "ms");
  }
  console.log("\nWebSocket distributions");
  for (const [name, value] of Object.entries(data.summary)) {
    if (name === "ok" || name === "failedSamples" || name === "restoreSources") continue;
    console.log("  " + name + ": " + (value ? JSON.stringify(value) : "n/a"));
  }
  console.log("  restoreSources: " + JSON.stringify(data.summary.restoreSources));
  console.log("\nImprovement regions");
  for (const region of data.improvementRegions) console.log("  - " + region);
}
