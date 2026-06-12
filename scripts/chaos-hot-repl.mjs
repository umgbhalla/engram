#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { connect } from "../packages/sdk/dist/index.mjs";

const args = parseArgs(process.argv.slice(2));
const endpoint = String(args.endpoint || process.env.ENGRAM_KERNEL_WS || "wss://engram-kernel.umg-bhalla88.workers.dev");
const session = String(args.session || "chaos-hot-" + Date.now().toString(36));
const iterations = positiveInt(args.iterations, 80);
const seed = positiveInt(args.seed, 0xC0FFEE);
const keepAliveMs = positiveInt(args.keepAliveMs, 15_000);
const warmFlushIdleMs = positiveInt(args.warmFlushIdleMs, 5_000);
const maxDelayMs = positiveInt(args.maxDelayMs, 2_500);
const longDelayMs = positiveInt(args.longDelayMs, Math.min(12_000, Math.max(2_000, keepAliveMs - 3_000)));
const burstMin = positiveInt(args.burstMin, 4);
const burstMax = Math.max(burstMin, positiveInt(args.burstMax, 8));
const churnKb = positiveInt(args.churnKb, 128);
const out = args.out ? String(args.out) : "";

const kernelKey = process.env.ENGRAM_KERNEL_KEY || process.env.ENGRAM_API_KEY || "";
if (!kernelKey) {
  console.error("ENGRAM_KERNEL_KEY or ENGRAM_API_KEY must be loaded for the authenticated kernel");
  process.exit(2);
}

const rng = lcg(seed);
const run = {
  schemaVersion: 1,
  runId: "chaos-hot-" + Date.now().toString(36),
  startedAt: new Date().toISOString(),
  endpoint,
  session,
  config: { iterations, seed, keepAliveMs, warmFlushIdleMs, maxDelayMs, longDelayMs, burstMin, burstMax, churnKb },
  events: [],
  failures: [],
  latencies: [],
  ok: false,
};

let s;
let expected = 0;

try {
  s = await openSession();
  await s.reset();

  await step("init", async () => {
    const r = await s.eval("globalThis.n = 0; n");
    assertEq(r.value, 0, "init value");
  });

  await step("long-delay-warm-window", async () => {
    await sleep(longDelayMs);
    const r = await s.eval("++n");
    expected = 1;
    assertEq(r.value, expected, "value after long warm delay");
  });

  for (let i = 0; i < iterations; i++) {
    const roll = rng();
    if (roll < 0.30) {
      await step("inc", async () => {
        const r = await timedEval("globalThis.n = (globalThis.n || 0) + 1; n");
        expected++;
        assertEq(r.result.value, expected, "inc value");
      });
    } else if (roll < 0.42) {
      await step("read", async () => {
        const r = await timedEval("globalThis.n");
        assertEq(r.result.value, expected, "read value");
      });
    } else if (roll < 0.52) {
      const ms = Math.floor(rng() * maxDelayMs);
      await step("delay", async () => {
        await sleep(ms);
        return { ms };
      });
    } else if (roll < 0.60) {
      await step("long-delay-preserve", async () => {
        await sleep(longDelayMs);
        const r = await timedEval("globalThis.n");
        assertEq(r.result.value, expected, "state after repeated long warm delay");
        return { delayMs: longDelayMs, value: r.result.value };
      });
    } else if (roll < 0.70) {
      await step("flush-evict-restore", async () => {
        const flush = await s.flush();
        if (flush.ok !== true) throw new Error("flush failed: " + JSON.stringify(flush));
        await s.evict();
        const r = await s.eval("globalThis.n", { durability: "eagerDurable" });
        assertEq(r.value, expected, "restore after flush");
        return { flush, restored: { value: r.value, restoreSource: r.restoreSource } };
      });
    } else if (roll < 0.80) {
      await step("timeout-guard", async () => {
        const r = await s.eval("while (true) { globalThis.__chaosSpin = 1 }", {
          throwOnError: false,
          timeoutMs: 120_000,
          durability: "eagerDurable",
        });
        const name = r.error?.name;
        if (name !== "TimeoutError") throw new Error("expected TimeoutError, got " + JSON.stringify(r.error || r));
        const check = await s.eval("globalThis.n");
        assertEq(check.value, expected, "state after timeout");
        return { errorName: name };
      });
    } else if (roll < 0.87) {
      await step("reconnect-after-flush", async () => {
        const flush = await s.flush();
        if (flush.ok !== true) throw new Error("flush before reconnect failed");
        s.close();
        s = await openSession();
        const r = await s.eval("globalThis.n", { durability: "eagerDurable" });
        assertEq(r.value, expected, "state after reconnect");
        return { restored: r.value };
      });
    } else if (roll < 0.94) {
      await step("burst-queue", async () => {
        const width = burstMin + Math.floor(rng() * (burstMax - burstMin + 1));
        const start = expected;
        const results = await Promise.all(Array.from({ length: width }, (_, j) =>
          timedEval("globalThis.n = (globalThis.n || 0) + 1; n").then((r) => ({ j, ...r }))
        ));
        expected += width;
        const values = results.map((r) => r.result?.value).sort((a, b) => a - b);
        const want = Array.from({ length: width }, (_, j) => start + j + 1);
        if (JSON.stringify(values) !== JSON.stringify(want)) {
          throw new Error("burst values mismatch got=" + JSON.stringify(values) + " want=" + JSON.stringify(want));
        }
        return { width, values };
      });
    } else {
      await step("heap-churn", async () => {
        const kb = 1 + Math.floor(rng() * churnKb);
        const bytes = kb * 1024;
        const wrote = await timedEval("globalThis.__chaosBlob = 'x'.repeat(" + bytes + "); __chaosBlob.length");
        assertEq(wrote.result.value, bytes, "heap churn write length");
        const deleted = await timedEval("delete globalThis.__chaosBlob; globalThis.n");
        assertEq(deleted.result.value, expected, "state after heap churn delete");
        return { kb, bytes };
      });
    }
  }

  await step("final-flush-restore", async () => {
    const flush = await s.flush();
    if (flush.ok !== true) throw new Error("final flush failed");
    await s.evict();
    const r = await s.eval("globalThis.n", { durability: "eagerDurable" });
    assertEq(r.value, expected, "final restored value");
    return { expected, restored: r.value };
  });

  run.ok = run.failures.length === 0;
} catch (error) {
  run.fatal = compactError(error);
  run.ok = false;
} finally {
  run.finishedAt = new Date().toISOString();
  run.latency = dist(run.latencies);
  try { s?.close(); } catch {}
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(run, null, 2));
  }
  console.log(JSON.stringify({
    ok: run.ok,
    session,
    events: run.events.length,
    failures: run.failures.length,
    fatal: run.fatal,
    latency: run.latency,
    eventCounts: counts(run.events.map((event) => event.kind)),
    lastEvents: run.events.slice(-8),
  }, null, 2));
  if (!run.ok) process.exitCode = 1;
}

async function openSession() {
  return connect({
    url: endpoint,
    session,
    kernelKey,
    WebSocket,
    throwOnError: false,
    timeoutMs: 120_000,
    keepAliveAfterActivityMs: keepAliveMs,
    config: {
      durability: "warmBuffered",
      warmFlushIdleMs,
      clock: "real",
      capture: false,
    },
  });
}

async function timedEval(src, opts = {}) {
  const t0 = performance.now();
  const result = await s.eval(src, opts);
  const ms = round(performance.now() - t0);
  run.latencies.push(ms);
  return { ms, result };
}

async function step(kind, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    run.events.push({ kind, ok: true, ms: round(performance.now() - t0), expected, detail });
  } catch (error) {
    const failure = { kind, ms: round(performance.now() - t0), expected, error: compactError(error) };
    run.failures.push(failure);
    run.events.push({ ...failure, ok: false });
    throw error;
  }
}

function assertEq(actual, expectedValue, label) {
  if (actual !== expectedValue) {
    throw new Error(label + ": got " + JSON.stringify(actual) + " expected " + JSON.stringify(expectedValue));
  }
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

function lcg(seedValue) {
  let state = seedValue >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

function counts(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] || 0) + 1;
  return out;
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function dist(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
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
