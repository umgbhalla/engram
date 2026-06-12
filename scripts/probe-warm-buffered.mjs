#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { connect } from "../packages/sdk/dist/index.mjs";

const args = parseArgs(process.argv.slice(2));
const endpoint = String(args.endpoint || process.env.ENGRAM_KERNEL_WS || "wss://engram-kernel.umg-bhalla88.workers.dev");
const session = String(args.session || "warm-buffered-" + Date.now().toString(36));
const evals = positiveInt(args.evals, 5);
const warmFlushIdleMs = positiveInt(args.warmFlushIdleMs, 15 * 60 * 1000);
const keepAliveMs = positiveInt(args.keepAliveMs, 15 * 60 * 1000);
const out = args.out ? String(args.out) : "";

const kernelKey = process.env.ENGRAM_KERNEL_KEY || process.env.ENGRAM_API_KEY || "";
if (!kernelKey) {
  console.error("ENGRAM_KERNEL_KEY or ENGRAM_API_KEY must be loaded for the authenticated kernel");
  process.exit(2);
}

const run = {
  schemaVersion: 1,
  runId: "warm-buffered-" + Date.now().toString(36),
  startedAt: new Date().toISOString(),
  endpoint,
  session,
  config: { evals, warmFlushIdleMs, keepAliveMs },
  samples: [],
  ok: false,
};

try {
  const s = await connect({
    url: endpoint,
    session,
    kernelKey,
    WebSocket,
    keepAliveAfterActivityMs: keepAliveMs,
    timeoutMs: 60000,
    throwOnError: false,
    config: {
      durability: "warmBuffered",
      warmFlushIdleMs,
      clock: "real",
    },
  });

  await s.reset();
  const values = [];
  for (let i = 0; i < evals; i++) {
    const t0 = performance.now();
    const result = await s.eval("globalThis.__wb = (globalThis.__wb || 0) + 1; __wb");
    const ms = round(performance.now() - t0);
    values.push(result.value);
    run.samples.push({
      i,
      ms,
      ok: result.ok,
      value: result.value,
      durability: result.durability,
      checkpoint: result.checkpoint,
    });
  }

  const dirtyStatus = await s.status();
  const flush = await s.flush();
  const cleanStatus = await s.status();
  await s.evict();
  const restored = await s.eval("__wb", { durability: "eagerDurable" });
  const finalFlush = await s.flush();
  s.close();

  run.values = values;
  run.dirtyStatus = dirtyStatus;
  run.flush = flush;
  run.cleanStatus = cleanStatus;
  run.restored = {
    ok: restored.ok,
    value: restored.value,
    restoreSource: restored.restoreSource,
    checkpoint: restored.checkpoint,
  };
  run.finalFlush = finalFlush;
  run.latency = dist(run.samples.map((s) => s.ms));
  run.ok =
    values.length === evals &&
    values.every((v, i) => v === i + 1) &&
    dirtyStatus.dirty === true &&
    flush.ok === true &&
    flush.flushed === true &&
    cleanStatus.dirty === false &&
    restored.value === evals;
} catch (error) {
  run.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
} finally {
  run.finishedAt = new Date().toISOString();
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(run, null, 2));
  }
  console.log(JSON.stringify({
    ok: run.ok,
    session,
    latency: run.latency,
    values: run.values,
    dirty: run.dirtyStatus && { committedCell: run.dirtyStatus.committedCell, liveCell: run.dirtyStatus.liveCell, dirty: run.dirtyStatus.dirty },
    flush: run.flush && { ok: run.flush.ok, flushed: run.flush.flushed, committedCell: run.flush.committedCell, liveCell: run.flush.liveCell },
    restored: run.restored && { ok: run.restored.ok, value: run.restored.value, restoreSource: run.restored.restoreSource },
    error: run.error,
  }, null, 2));
  if (!run.ok) process.exitCode = 1;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return out;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function dist(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

