#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const manifest = JSON.parse(readFileSync(new URL("../config/deployed-endpoints.json", import.meta.url), "utf8"));
const args = parseArgs(process.argv.slice(2));

const endpoint = String(args.endpoint || process.env.ENGRAM_KERNEL_WS || manifest.public.kernel.defaultWs);
const session = String(args.session || "stress-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
const timeoutMs = positiveInt(args.timeoutMs, 45000);
const cells = positiveInt(args.cells, 100);
const hibernateEvery = positiveInt(args.hibernateEvery, 0);
const burstSockets = positiveInt(args.burstSockets, 8);
const burstCells = positiveInt(args.burstCells, 10);
const payloadKb = csvInts(args.payloadKb || "16,64,256");
const memoryMb = positiveInt(args.memoryMb, 0);
const memoryChunkMb = Math.min(4, positiveInt(args.memoryChunkMb, 1));
const progressEvery = positiveInt(args.progressEvery, 50);
const dangerIncompressible = Boolean(args.dangerIncompressible);
const out = args.out ? String(args.out) : "";
const markdown = args.markdown ? String(args.markdown) : "";
const skipSequence = Boolean(args.skipSequence);
const skipBurst = Boolean(args.skipBurst);
const skipPayload = Boolean(args.skipPayload);
const skipMemory = Boolean(args.skipMemory);

if (!globalThis.WebSocket) {
  console.error("global WebSocket is unavailable in this Node runtime; use Node 22+.");
  process.exit(2);
}

const run = {
  schemaVersion: 1,
  runId: "stress-single-" + Date.now().toString(36),
  startedAt: new Date().toISOString(),
  endpoint,
  session,
  config: {
    cells,
    hibernateEvery,
    burstSockets,
    burstCells,
    payloadKb,
    memoryMb,
    memoryChunkMb,
    progressEvery,
    dangerIncompressible,
    timeoutMs,
  },
  safety: {
    note: "Fresh session, no deploy/mutation outside this Durable Object session. Incompressible memory is disabled unless --dangerIncompressible is set.",
    knownDanger: "docs/SYSTEM-LIMITS.md records an incompressible raw heap cliff around 28 MB; keep dangerous runs below that and expect possible socket closure.",
  },
  sequence: null,
  burst: null,
  payload: null,
  memory: null,
  summary: null,
};

try {
  if (!skipSequence) run.sequence = await sequenceProbe();
  if (!skipBurst) run.burst = await burstProbe();
  if (!skipPayload) run.payload = await payloadProbe();
  if (!skipMemory && memoryMb > 0) run.memory = await memoryProbe();
  run.summary = summarizeRun(run);
  run.finishedAt = new Date().toISOString();
  printSummary(run);
  writeArtifacts(run);
  if (run.summary.ok === false) process.exitCode = 1;
} catch (error) {
  run.finishedAt = new Date().toISOString();
  run.summary = { ok: false, fatal: error instanceof Error ? error.message : String(error) };
  printSummary(run);
  writeArtifacts(run);
  process.exitCode = 1;
}

async function sequenceProbe() {
  const sid = session + "-seq";
  const c = await openClient(sid);
  const samples = [];
  try {
    const create = await c.rpc({ t: "create", config: { clock: "seeded", rngSeed: 11, capture: true } });
    for (let i = 1; i <= cells; i++) {
      const sample = await timedRpc(c, { t: "eval", src: "globalThis.__stressCount=(globalThis.__stressCount||0)+1; __stressCount" });
      samples.push(compactSample(i, sample));
      if (progressEvery > 0 && i % progressEvery === 0) {
        console.log("progress sequence " + i + "/" + cells + " lastMs=" + sample.ms + " ok=" + (sample.reply?.ok !== false && !sample.error));
        writePartial({ phase: "sequence", sid, i, cells, sample: compactSample(i, sample) });
      }
      if (hibernateEvery > 0 && i % hibernateEvery === 0 && i < cells) {
        const evict = await timedRpc(c, { t: "evict" });
        samples.push({ i, op: "evict", ms: evict.ms, reply: compactReply(evict.reply), error: evict.error || undefined });
        console.log("progress evict after sequence " + i + "/" + cells + " ms=" + evict.ms + " ok=" + (evict.reply?.ok !== false && !evict.error));
        writePartial({ phase: "sequence-evict", sid, i, cells, evict: compactTimed(evict) });
      }
    }
    const last = lastEval(samples);
    return {
      ok: create.reply?.ok !== false && last?.reply?.value === cells,
      sid,
      create: compactTimed(create),
      samples,
      stats: summarizeSamples(samples.filter((s) => s.op === "eval")),
      finalValue: last?.reply?.value,
      restoreSources: counts(samples.map((s) => s.reply?.restoreSource).filter(Boolean)),
      checkpoint: last?.reply?.checkpoint || null,
    };
  } finally {
    c.close();
  }
}

async function burstProbe() {
  const sid = session + "-burst";
  const first = await openClient(sid);
  await first.rpc({ t: "create", config: { clock: "seeded", rngSeed: 22, capture: false } });
  const clients = [first];
  for (let i = 1; i < burstSockets; i++) clients.push(await openClient(sid));
  const started = performance.now();
  const perSocket = await Promise.all(clients.map((client, socketIndex) => runBurstSocket(client, socketIndex)));
  const elapsedMs = round(performance.now() - started);
  const values = perSocket.flatMap((s) => s.samples.map((sample) => sample.reply?.value).filter(Number.isFinite));
  const errors = perSocket.flatMap((s) => s.samples.filter((sample) => sample.reply?.ok === false || sample.error));
  const expected = burstSockets * burstCells;
  for (const c of clients) c.close();
  return {
    ok: errors.length === 0 && values.length === expected && new Set(values).size === expected && Math.max(...values) === expected,
    sid,
    elapsedMs,
    sockets: burstSockets,
    cellsPerSocket: burstCells,
    expected,
    observed: values.length,
    distinct: new Set(values).size,
    maxValue: values.length ? Math.max(...values) : null,
    errors: errors.slice(0, 10),
    perSocket,
    stats: summarizeSamples(perSocket.flatMap((s) => s.samples)),
  };
}

async function runBurstSocket(client, socketIndex) {
  const samples = [];
  for (let i = 0; i < burstCells; i++) {
    const sample = await timedRpc(client, { t: "eval", src: "globalThis.__burst=(globalThis.__burst||0)+1; __burst" });
    samples.push({ socketIndex, localCell: i + 1, ...compactSample(i + 1, sample) });
    if (progressEvery > 0 && (i + 1) % progressEvery === 0) {
      console.log("progress burst socket=" + socketIndex + " " + (i + 1) + "/" + burstCells);
      writePartial({ phase: "burst", sid: client.sid, socketIndex, i: i + 1, cells: burstCells, sample: compactSample(i + 1, sample) });
    }
  }
  return { socketIndex, samples };
}

async function payloadProbe() {
  const sid = session + "-payload";
  const c = await openClient(sid);
  const samples = [];
  try {
    await c.rpc({ t: "create", config: { clock: "seeded", rngSeed: 33, capture: false } });
    for (const kb of payloadKb) {
      const bytes = kb * 1024;
      const sample = await timedRpc(c, { t: "eval", src: '"x".repeat(' + bytes + ")" }, Math.max(timeoutMs, 60000));
      samples.push({
        kb,
        bytes,
        ms: sample.ms,
        ok: sample.reply?.ok !== false,
        valueType: sample.reply?.valueType,
        returnedLength: typeof sample.reply?.value === "string" ? sample.reply.value.length : null,
        checkpoint: compactCheckpoint(sample.reply?.checkpoint),
        error: sample.error || compactError(sample.reply?.error),
      });
    }
    return { ok: samples.every((s) => s.ok && s.returnedLength === s.bytes), sid, samples, stats: dist(samples.map((s) => s.ms)) };
  } finally {
    c.close();
  }
}

async function memoryProbe() {
  const sid = session + "-memory";
  const c = await openClient(sid);
  const samples = [];
  const chunkBytes = memoryChunkMb * 1024 * 1024;
  const chunks = Math.ceil(memoryMb / memoryChunkMb);
  try {
    await c.rpc({ t: "create", config: { clock: "seeded", rngSeed: 44, capture: false, cellBudgetTicks: 2000 } });
    await c.rpc({ t: "eval", src: "globalThis.__chunks=[]; globalThis.__seed=0x9e3779b9>>>0; 'ready'" });
    for (let i = 0; i < chunks; i++) {
      const remainingMb = memoryMb - i * memoryChunkMb;
      const thisChunkBytes = Math.min(chunkBytes, remainingMb * 1024 * 1024);
      const src = dangerIncompressible ? incompressibleChunkSource(thisChunkBytes) : "{ const a = new Uint8Array(" + thisChunkBytes + "); a.fill(7); globalThis.__chunks.push(a); globalThis.__chunks.reduce((n,x)=>n+x.length,0); }";
      const sample = await timedRpc(c, { t: "eval", src }, Math.max(timeoutMs, 90000));
      samples.push({ chunk: i + 1, targetBytes: thisChunkBytes, dangerous: dangerIncompressible, ...compactSample(i + 1, sample) });
      console.log("progress memory chunk " + (i + 1) + "/" + chunks + " ms=" + sample.ms + " ok=" + (sample.reply?.ok !== false && !sample.error));
      writePartial({ phase: "memory", sid, chunk: i + 1, chunks, sample: compactSample(i + 1, sample) });
      if (sample.reply?.ok === false || sample.error) break;
    }
    const evict = await timedRpc(c, { t: "evict" });
    const restore = await timedRpc(c, { t: "eval", src: "globalThis.__chunks.reduce((n,x)=>n+x.length,0)" }, Math.max(timeoutMs, 90000));
    return {
      ok: samples.every((s) => s.reply?.ok !== false && !s.error) && restore.reply?.ok !== false,
      sid,
      requestedMb: memoryMb,
      chunkMb: memoryChunkMb,
      dangerous: dangerIncompressible,
      samples,
      evict: compactTimed(evict),
      restore: compactTimed(restore),
      restoreSource: restore.reply?.restoreSource || "",
      restoredBytes: restore.reply?.value ?? null,
      stats: summarizeSamples(samples),
    };
  } finally {
    c.close();
  }
}

function incompressibleChunkSource(bytes) {
  return "{ const a = new Uint8Array(" + bytes + "); let s = globalThis.__seed >>> 0; for (let i = 0; i < a.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s >>> 24; } globalThis.__seed = s; globalThis.__chunks.push(a); globalThis.__chunks.reduce((n,x)=>n+x.length,0); }";
}

async function openClient(sid) {
  const wsUrl = endpoint.replace(/\/+$/, "") + "/ws?id=" + encodeURIComponent(sid);
  const _k = process.env.ENGRAM_KERNEL_KEY; const wsUrlAuthed = _k ? wsUrl + "&apiKey=" + encodeURIComponent(_k) : wsUrl;
  const t0 = performance.now();
  const ws = new WebSocket(wsUrlAuthed);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("websocket open timeout"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket open failed"));
    }, { once: true });
  });
  return {
    sid,
    ws,
    openMs: round(performance.now() - t0),
    rpc(frame, perCallTimeoutMs = timeoutMs) {
      return timedRpc({ ws }, frame, perCallTimeoutMs);
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}

function timedRpc(client, frame, perCallTimeoutMs = timeoutMs) {
  const t0 = performance.now();
  return new Promise((resolve) => {
    const ws = client.ws;
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ms: round(performance.now() - t0), error: "rpc timeout for " + frame.t });
    }, perCallTimeoutMs);
    const onMessage = (event) => {
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      let reply;
      try { reply = JSON.parse(data); } catch { reply = { ok: false, error: { name: "BadJson", message: data.slice(0, 120) } }; }
      if (reply?.t === "hostcall") {
        ws.send(JSON.stringify({ t: "hostcall-result", id: reply.id, value: { ok: true, name: reply.name, args: reply.args ?? [] } }));
        return;
      }
      cleanup();
      resolve({ ms: round(performance.now() - t0), reply });
    };
    const onClose = () => {
      cleanup();
      resolve({ ms: round(performance.now() - t0), error: "socket closed before " + frame.t + " reply" });
    };
    const onError = () => {
      cleanup();
      resolve({ ms: round(performance.now() - t0), error: "socket error during " + frame.t });
    };
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    }
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose, { once: true });
    ws.addEventListener("error", onError, { once: true });
    try {
      ws.send(JSON.stringify(frame));
    } catch (error) {
      cleanup();
      resolve({
        ms: round(performance.now() - t0),
        error: "socket send failed during " + frame.t + ": " + (error instanceof Error ? error.message : String(error)),
      });
    }
  });
}

function compactSample(i, sample) {
  return { i, op: "eval", ms: sample.ms, error: sample.error || undefined, reply: compactReply(sample.reply) };
}

function compactTimed(sample) {
  return { ms: sample.ms, error: sample.error || undefined, reply: compactReply(sample.reply) };
}

function compactReply(reply) {
  if (!reply) return null;
  const value = typeof reply.value === "string" && reply.value.length > 120 ? reply.value.slice(0, 120) + "...(" + reply.value.length + ")" : reply.value;
  return {
    t: reply.t,
    ok: reply.ok,
    value,
    valueType: reply.valueType,
    cell: reply.cell,
    generation: reply.generation,
    inMemoryBefore: reply.inMemoryBefore,
    restoreSource: reply.restoreSource,
    restoreTimings: reply.restoreTimings || undefined,
    checkpoint: compactCheckpoint(reply.checkpoint),
    error: compactError(reply.error),
  };
}

function compactCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  return {
    ok: checkpoint.ok,
    store: checkpoint.store,
    mode: checkpoint.mode,
    sizeGz: checkpoint.sizeGz,
    sizeRaw: checkpoint.sizeRaw,
    usedHeap: checkpoint.usedHeap,
    scrubbed: checkpoint.scrubbed,
  };
}

function compactError(error) {
  if (!error) return undefined;
  if (typeof error === "string") return { name: "Error", message: error };
  return { name: error.name || "Error", message: error.message || String(error) };
}

function lastEval(samples) {
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].op === "eval") return samples[i];
  }
  return null;
}

function summarizeSamples(samples) {
  const evals = samples.filter((s) => s.op === "eval" && !s.error);
  return {
    total: samples.length,
    errors: samples.filter((s) => s.error || s.reply?.ok === false).length,
    ms: dist(evals.map((s) => s.ms)),
    checkpointSizeGz: dist(evals.map((s) => s.reply?.checkpoint?.sizeGz).filter(Number.isFinite)),
    checkpointSizeRaw: dist(evals.map((s) => s.reply?.checkpoint?.sizeRaw).filter(Number.isFinite)),
    usedHeap: dist(evals.map((s) => s.reply?.checkpoint?.usedHeap).filter(Number.isFinite)),
    restoreSources: counts(evals.map((s) => s.reply?.restoreSource).filter(Boolean)),
  };
}

function summarizeRun(data) {
  const parts = [data.sequence, data.burst, data.payload, data.memory].filter(Boolean);
  const failures = parts.filter((p) => p.ok === false);
  const headline = [];
  if (data.sequence) headline.push("sequence cells=" + data.sequence.finalValue + "/" + data.config.cells + " p95=" + data.sequence.stats.ms.p95 + "ms");
  if (data.burst) headline.push("burst observed=" + data.burst.observed + "/" + data.burst.expected + " distinct=" + data.burst.distinct + " p95=" + data.burst.stats.ms.p95 + "ms");
  if (data.payload) headline.push("payload max=" + Math.max(...data.payload.samples.map((s) => s.kb)) + "KiB ok=" + data.payload.ok);
  if (data.memory) headline.push("memory restored=" + data.memory.restoredBytes + " source=" + (data.memory.restoreSource || "unknown") + " ok=" + data.memory.ok);
  return { ok: failures.length === 0, checkedParts: parts.length, failedParts: failures.map((p) => p.sid || "unknown"), headline };
}

function writeArtifacts(data) {
  if (out) {
    const outUrl = fileUrl(out);
    mkdirSync(new URL("./", outUrl), { recursive: true });
    writeFileSync(outUrl, JSON.stringify(data, null, 2) + "\n");
    console.log("Wrote " + outUrl.pathname);
  }
  if (markdown) {
    const mdUrl = fileUrl(markdown);
    mkdirSync(new URL("./", mdUrl), { recursive: true });
    writeFileSync(mdUrl, renderMarkdown(data));
    console.log("Wrote " + mdUrl.pathname);
  }
}

function writePartial(partial) {
  if (!out) return;
  try {
    const partialUrl = fileUrl(out + ".partial");
    mkdirSync(new URL("./", partialUrl), { recursive: true });
    writeFileSync(partialUrl, JSON.stringify({
      runId: run.runId,
      endpoint: run.endpoint,
      session: run.session,
      at: new Date().toISOString(),
      partial,
    }, null, 2) + "\n");
  } catch {
    // Progress artifacts are best-effort; never fail the stress run because of local disk writes.
  }
}

function renderMarkdown(data) {
  const headline = (data.summary?.headline || []).map((line) => "- " + line).join("\n");
  return "# Engram Single-Instance Stress Run\n\n" +
    "- Run: " + data.runId + "\n" +
    "- Started: " + data.startedAt + "\n" +
    "- Endpoint: " + data.endpoint + "\n" +
    "- Session prefix: " + data.session + "\n" +
    "- Summary: " + (data.summary?.ok ? "PASS" : "FAIL") + "\n\n" +
    "## Headline\n\n" + headline + "\n\n" +
    "## Sequence\n\n" + (data.sequence ? fencedJson(data.sequence.stats) : "Skipped") + "\n\n" +
    "## Burst\n\n" + (data.burst ? fencedJson({ ok: data.burst.ok, expected: data.burst.expected, observed: data.burst.observed, distinct: data.burst.distinct, maxValue: data.burst.maxValue, stats: data.burst.stats }) : "Skipped") + "\n\n" +
    "## Payload\n\n" + (data.payload ? fencedJson(data.payload.samples) : "Skipped") + "\n\n" +
    "## Memory\n\n" + (data.memory ? fencedJson({ ok: data.memory.ok, requestedMb: data.memory.requestedMb, dangerous: data.memory.dangerous, restoreSource: data.memory.restoreSource, restoredBytes: data.memory.restoredBytes, stats: data.memory.stats }) : "Skipped") + "\n";
}

function fencedJson(value) {
  return "~~~json\n" + JSON.stringify(value, null, 2) + "\n~~~";
}

function printSummary(data) {
  console.log("\n==== ENGRAM SINGLE-INSTANCE STRESS ====");
  console.log("run=" + data.runId + " endpoint=" + data.endpoint + " session=" + data.session);
  for (const line of data.summary?.headline || []) console.log(line);
  if (data.summary?.fatal) console.log("fatal=" + data.summary.fatal);
  console.log(data.summary?.ok ? "PASS" : "FAIL");
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    if (eq >= 0) {
      parsed[raw.slice(0, eq)] = raw.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      parsed[raw] = next && !next.startsWith("--") ? argv[++i] : true;
    }
  }
  return parsed;
}

function positiveInt(value, fallback) {
  if (value === undefined || value === false || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function csvInts(value) {
  return String(value).split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v >= 0).map((v) => Math.floor(v));
}

function dist(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return { n: 0 };
  return {
    n: xs.length,
    min: round(xs[0]),
    p50: round(percentile(xs, 0.50)),
    p90: round(percentile(xs, 0.90)),
    p95: round(percentile(xs, 0.95)),
    p99: round(percentile(xs, 0.99)),
    max: round(xs[xs.length - 1]),
    avg: round(xs.reduce((a, b) => a + b, 0) / xs.length),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function counts(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] || 0) + 1;
  return out;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function fileUrl(path) {
  return path.startsWith("/") ? new URL("file://" + path) : new URL("../" + path, import.meta.url);
}
