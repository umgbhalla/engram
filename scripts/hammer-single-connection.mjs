#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { connect } from "../packages/sdk/dist/index.mjs";

const manifest = JSON.parse(readFileSync(new URL("../config/deployed-endpoints.json", import.meta.url), "utf8"));
const args = parseArgs(process.argv.slice(2));

const endpoint = String(args.endpoint || process.env.ENGRAM_KERNEL_WS || manifest.public.kernel.defaultWs);
const session = String(args.session || "hammer-single-" + Date.now().toString(36));
const queue = positiveInt(args.queue, 64);
const warmSamples = positiveInt(args.warmSamples, 40);
const timeoutSamples = positiveInt(args.timeoutSamples, 16);
const keepAliveMs = positiveInt(args.keepAliveMs, 10_000);
const gapMs = positiveInt(args.gapMs, 6_000);
const timeoutP95MaxMs = positiveInt(args.timeoutP95MaxMs, 10_000);
const queueP95MaxMs = positiveInt(args.queueP95MaxMs, 0);
const requestTimeoutMs = positiveInt(args.requestTimeoutMs, 60_000);
const out = args.out ? String(args.out) : "";
const markdown = args.markdown ? String(args.markdown) : "";

const kernelKey = process.env.ENGRAM_KERNEL_KEY || process.env.ENGRAM_API_KEY || "";
if (!kernelKey) {
  console.error("ENGRAM_KERNEL_KEY or ENGRAM_API_KEY must be loaded for the authenticated kernel");
  process.exit(2);
}

const run = {
  schemaVersion: 1,
  runId: "hammer-single-" + Date.now().toString(36),
  startedAt: new Date().toISOString(),
  endpoint,
  session,
  config: { queue, warmSamples, timeoutSamples, keepAliveMs, gapMs, timeoutP95MaxMs, queueP95MaxMs, requestTimeoutMs },
  queue: null,
  warm: null,
  timeouts: null,
  multiTurn: null,
  summary: null,
};

try {
  run.queue = await phase("queue", queueHammer);
  run.warm = await phase("warm", warmLatencyProbe);
  run.timeouts = await phase("timeouts", timeoutProbe);
  run.multiTurn = await phase("multiTurn", multiTurnKeepAliveProbe);
  run.summary = summarize();
  run.finishedAt = new Date().toISOString();
  printSummary();
  writeArtifacts();
  if (!run.summary.ok) process.exitCode = 1;
} catch (error) {
  run.finishedAt = new Date().toISOString();
  run.summary = { ok: false, fatal: error instanceof Error ? error.stack || error.message : String(error) };
  printSummary();
  writeArtifacts();
  process.exitCode = 1;
}

async function phase(name, fn) {
  const t0 = performance.now();
  console.log("[hammer] start " + name);
  const result = await fn();
  console.log("[hammer] done " + name + " ok=" + result.ok + " ms=" + round(performance.now() - t0));
  return result;
}

async function queueHammer() {
  let closes = 0;
  let reconnects = 0;
  const s = await connectSession(session + "-queue", {
    onClose: () => { closes++; },
    onReconnect: () => { reconnects++; },
  });
  try {
    await s.eval("globalThis.__q = []; 'ready'");
    const started = performance.now();
    let done = 0;
    const promises = Array.from({ length: queue }, (_, i) =>
      timedEval(s, queueCell(i)).then((sample) => {
        done++;
        if (done === queue || done % Math.max(1, Math.floor(queue / 4)) === 0) {
          console.log("[hammer] queue progress " + done + "/" + queue + " lastMs=" + sample.ms);
        }
        return sample;
      }),
    );
    const samples = await Promise.all(promises);
    const elapsedMs = round(performance.now() - started);
    const final = await s.eval("__q.join(',')");
    const expected = Array.from({ length: queue }, (_, i) => String(i)).join(",");
    const observed = typeof final.value === "string" ? final.value.split(",").filter(Boolean) : [];
    const distinct = new Set(observed);
    const errors = samples.filter((sample) => sample.error || sample.result?.ok === false);
    const stats = dist(samples.map((sample) => sample.ms));
    return {
      ok: errors.length === 0 && final.value === expected && distinct.size === queue,
      elapsedMs,
      closes,
      reconnects,
      expectedCount: queue,
      observedCount: observed.length,
      distinctCount: distinct.size,
      finalValue: final.value,
      stats,
      threshold: { queueP95MaxMs: queueP95MaxMs || null },
      errors: errors.slice(0, 5),
      samples: samples.map(compactEvalSample),
    };
  } finally {
    s.close();
  }
}

function queueCell(i) {
  return [
    "globalThis.__q ||= [];",
    "__q.push(" + JSON.stringify(String(i)) + ");",
    "({ pushed: " + i + ", len: __q.length, tail: __q.slice(-3) })",
  ].join(" ");
}

async function warmLatencyProbe() {
  const s = await connectSession(session + "-warm");
  try {
    await s.eval("globalThis.__warm = 0; 'ready'");
    const samples = [];
    for (let i = 0; i < warmSamples; i++) {
      const sample = await timedEval(s, "__warm += 1; __warm");
      samples.push(sample);
      if ((i + 1) % Math.max(1, Math.floor(warmSamples / 4)) === 0 || i + 1 === warmSamples) {
        console.log("[hammer] warm progress " + (i + 1) + "/" + warmSamples + " lastMs=" + sample.ms);
      }
    }
    const stats = dist(samples.map((sample) => sample.ms));
    const last = samples.at(-1)?.result?.value;
    return {
      ok: samples.every((sample) => !sample.error && sample.result?.ok !== false) && last === warmSamples,
      expectedFinal: warmSamples,
      finalValue: last,
      stats,
      samples: samples.map(compactEvalSample),
    };
  } finally {
    s.close();
  }
}

async function timeoutProbe() {
  const s = await connectSession(session + "-timeouts", {
    config: { clock: "real", capture: false, cellBudgetTicks: 1200 },
  });
  try {
    await s.eval("'ready'");
    const samples = [];
    for (let i = 0; i < timeoutSamples; i++) {
      samples.push(await timedEval(s, "while (true) { globalThis.__timeoutSpin = 1 }", { throwOnError: false, timeoutMs: requestTimeoutMs }));
      console.log("[hammer] timeout progress " + (i + 1) + "/" + timeoutSamples + " lastMs=" + samples.at(-1).ms);
    }
    const stats = dist(samples.map((sample) => sample.ms));
    const names = samples.map((sample) => sample.result?.error?.name || sample.error?.name || "");
    return {
      ok: names.every((name) => name === "TimeoutError") && stats.p95 <= timeoutP95MaxMs,
      expectedError: "TimeoutError",
      errorNames: counts(names),
      stats,
      threshold: { timeoutP95MaxMs },
      samples: samples.map(compactEvalSample),
    };
  } finally {
    s.close();
  }
}

async function multiTurnKeepAliveProbe() {
  let closes = 0;
  let reconnects = 0;
  const s = await connectSession(session + "-multiturn", {
    onClose: () => { closes++; },
    onReconnect: () => { reconnects++; },
    config: { durability: "warmBuffered", warmFlushIdleMs: keepAliveMs },
  });
  try {
    const r1 = await s.eval("globalThis.__events = ['a']; __events.join(',')");
    await sleep(gapMs);
    const beforeSecond = { closes, reconnects };
    const r2 = await s.eval("__events.push('b'); __events.join(',')");
    await sleep(gapMs);
    const beforeThird = { closes, reconnects };
    const r3 = await s.eval("__events.push('c'); __events.join(',')");
    return {
      ok: r1.value === "a" && r2.value === "a,b" && r3.value === "a,b,c" &&
        beforeSecond.closes === 0 && beforeSecond.reconnects === 0 &&
        beforeThird.closes === 0 && beforeThird.reconnects === 0,
      values: [r1.value, r2.value, r3.value],
      gapMs,
      keepAliveMs,
      beforeSecond,
      beforeThird,
      finalCounters: { closes, reconnects },
    };
  } finally {
    s.close();
  }
}

async function connectSession(id, opts = {}) {
  return connect({
    url: endpoint,
    session: id,
    kernelKey,
    WebSocket,
    throwOnError: false,
    timeoutMs: requestTimeoutMs,
    keepAliveAfterActivityMs: keepAliveMs,
    config: { clock: "real", capture: false, ...(opts.config || {}) },
    onClose: opts.onClose,
    onReconnect: opts.onReconnect,
  });
}

async function timedEval(sessionHandle, src, opts = {}) {
  const t0 = performance.now();
  try {
    const result = await sessionHandle.eval(src, opts);
    return { ms: round(performance.now() - t0), result };
  } catch (error) {
    return { ms: round(performance.now() - t0), error: compactError(error) };
  }
}

function summarize() {
  const checks = {
    queue: Boolean(run.queue?.ok),
    warm: Boolean(run.warm?.ok),
    timeouts: Boolean(run.timeouts?.ok),
    multiTurn: Boolean(run.multiTurn?.ok),
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

function printSummary() {
  console.log("\n==== ENGRAM SINGLE-CONNECTION HAMMER ====");
  console.log(JSON.stringify({
    ok: run.summary?.ok,
    session,
    queue: run.queue && {
      ok: run.queue.ok,
      observedCount: run.queue.observedCount,
      distinctCount: run.queue.distinctCount,
      p50: run.queue.stats.p50,
      p95: run.queue.stats.p95,
      closes: run.queue.closes,
      reconnects: run.queue.reconnects,
    },
    warm: run.warm && { ok: run.warm.ok, p50: run.warm.stats.p50, p95: run.warm.stats.p95 },
    timeouts: run.timeouts && { ok: run.timeouts.ok, p50: run.timeouts.stats.p50, p95: run.timeouts.stats.p95, errorNames: run.timeouts.errorNames },
    multiTurn: run.multiTurn && run.multiTurn,
  }, null, 2));
}

function writeArtifacts() {
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(run, null, 2));
  }
  if (markdown) {
    mkdirSync(path.dirname(markdown), { recursive: true });
    writeFileSync(markdown, renderMarkdown());
  }
}

function renderMarkdown() {
  return [
    "# Engram Single-Connection Hammer",
    "",
    "- runId: " + run.runId,
    "- endpoint: " + endpoint,
    "- session prefix: " + session,
    "- ok: " + String(run.summary?.ok),
    "",
    "## Queue",
    "",
    "- ok: " + String(run.queue?.ok),
    "- queued evals: " + queue,
    "- observed/distinct: " + run.queue?.observedCount + "/" + run.queue?.distinctCount,
    "- p50/p95/p99: " + run.queue?.stats.p50 + "/" + run.queue?.stats.p95 + "/" + run.queue?.stats.p99 + " ms",
    "- closes/reconnects: " + run.queue?.closes + "/" + run.queue?.reconnects,
    "",
    "## Warm Eval",
    "",
    "- ok: " + String(run.warm?.ok),
    "- samples: " + warmSamples,
    "- p50/p95/p99: " + run.warm?.stats.p50 + "/" + run.warm?.stats.p95 + "/" + run.warm?.stats.p99 + " ms",
    "",
    "## Timeout",
    "",
    "- ok: " + String(run.timeouts?.ok),
    "- samples: " + timeoutSamples,
    "- expected error: TimeoutError",
    "- p50/p95/p99: " + run.timeouts?.stats.p50 + "/" + run.timeouts?.stats.p95 + "/" + run.timeouts?.stats.p99 + " ms",
    "- names: " + JSON.stringify(run.timeouts?.errorNames),
    "",
    "## Multi-Turn Keepalive",
    "",
    "- ok: " + String(run.multiTurn?.ok),
    "- values: " + JSON.stringify(run.multiTurn?.values),
    "- before second: " + JSON.stringify(run.multiTurn?.beforeSecond),
    "- before third: " + JSON.stringify(run.multiTurn?.beforeThird),
    "",
  ].join("\n");
}

function compactEvalSample(sample) {
  return {
    ms: sample.ms,
    ok: sample.result?.ok,
    value: sample.result?.value,
    valueType: sample.result?.valueType,
    error: sample.error || sample.result?.error || undefined,
    cell: sample.result?.cell,
    restoreSource: sample.result?.restoreSource,
    checkpoint: sample.result?.checkpoint
      ? { store: sample.result.checkpoint.store, sizeGz: sample.result.checkpoint.sizeGz, usedHeap: sample.result.checkpoint.usedHeap }
      : undefined,
  };
}

function compactError(error) {
  if (!error) return null;
  return { name: error.name || "Error", message: error.message || String(error) };
}

function dist(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted.length ? round(sorted[0]) : null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? round(sorted[sorted.length - 1]) : null,
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return round(sorted[idx]);
}

function counts(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] || 0) + 1;
  return out;
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return out;
}
