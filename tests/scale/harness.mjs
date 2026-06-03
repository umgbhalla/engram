#!/usr/bin/env node
// Open-loop scale harness for engram-scale-cloud (multi-tenant supervisor).
//
// Protocol is HTTP frames (the production client-facing surface; the WS-proxy model is
// internal to the supervisor). Each "session" = a unique ?session=<id> keyed by an x-api-key
// -> tenant. Per session lifecycle:
//   create -> N stateful evals (assert per-session state persists + isolation) -> evict ->
//   cold-restore eval (assert state survived genuine facet abort) -> done.
//
// Open-loop: SESSIONS are launched with a bounded arrival rate (CONCURRENCY in flight at most),
// NOT a closed loop that waits for each to finish. Records per-op latency, errors by class,
// per-session isolation.
//
// Usage:
//   BASE=https://engram-scale-cloud.umg-bhalla88.workers.dev \
//   KEY=md_... SESSIONS=50 CONCURRENCY=25 OPS=4 EVICT_FRAC=0.5 \
//   node tests/scale/harness.mjs
//
// Env:
//   BASE        supervisor base URL (required)
//   KEY         tenant api key (required)        KEY2 optional second tenant key (cross-tenant isolation)
//   SESSIONS    total sessions to run (default 50)
//   CONCURRENCY max sessions in flight (default 25)
//   OPS         stateful evals per session before evict (default 4)
//   EVICT_FRAC  fraction of sessions that evict+cold-restore (default 0.5)
//   PREFIX      session id prefix (default scale)

const BASE = process.env.BASE;
const KEY = process.env.KEY;
const KEY2 = process.env.KEY2 || "";
const SESSIONS = parseInt(process.env.SESSIONS || "50", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "25", 10);
const OPS = parseInt(process.env.OPS || "4", 10);
const EVICT_FRAC = parseFloat(process.env.EVICT_FRAC || "0.5");
const PREFIX = process.env.PREFIX || `scale${Date.now() % 100000}`;

if (!BASE || !KEY) { console.error("BASE and KEY required"); process.exit(2); }

// ---- metrics ----
const lat = {};                 // op -> [ms...]
const errClass = {};            // class -> count
const samples = [];             // per-op records
function rec(op, ms, ok, cls) {
  (lat[op] ||= []).push(ms);
  if (!ok) errClass[cls || "unknown"] = (errClass[cls || "unknown"] || 0) + 1;
  samples.push({ op, ms, ok, cls });
}
function classify(status, body, netErr) {
  if (netErr) return netErr.name === "AbortError" ? "rpc-timeout" : "connect-fail";
  if (status === 401 || status === 403) return "auth-fail";
  if (status >= 500) {
    const s = JSON.stringify(body || "");
    if (/1006|disconnect|abort|internal/i.test(s)) return "ws-1006/do-kill";
    return "server-5xx";
  }
  if (body && body.error && body.error.name) return "eval-error";
  return "other";
}
async function call(method, path, key, bodyObj) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  let status = 0, body = null, netErr = null;
  try {
    const init = { method, headers: { "x-api-key": key }, signal: ctrl.signal };
    if (bodyObj !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(bodyObj); }
    const r = await fetch(BASE + path, init);
    status = r.status;
    const txt = await r.text();
    try { body = JSON.parse(txt); } catch { body = txt; }
  } catch (e) { netErr = e; }
  finally { clearTimeout(to); }
  const ms = performance.now() - t0;
  return { ms, status, body, netErr };
}

let isolationFails = 0;
let restoreFails = 0;
let restoreChecked = 0;
const doneState = { ok: 0, fail: 0 };

async function runSession(i) {
  const key = (KEY2 && i % 2 === 1) ? KEY2 : KEY;
  const tenantTag = (KEY2 && i % 2 === 1) ? "B" : "A";
  const sid = `${PREFIX}-${tenantTag}-${i}`;
  // Per-session secret value: must only ever be visible to THIS session.
  const secret = (i * 1000003 + 7) % 1000000;
  let failed = false;
  const op = (name, p, body, key2) => call(p.startsWith("/create") ? "POST" : (p.startsWith("/eval") ? "GET" : (p.startsWith("/evict") ? "GET" : "GET")), p, key2 || key, body)
    .then(r => { rec(name, r.ms, r.status === 200 && !(r.body && r.body.error && name !== "eval"), classify(r.status, r.body, r.netErr)); return r; });

  // create
  let r = await op("create", `/create?session=${sid}`, { rngSeed: i });
  if (r.status !== 200) { failed = true; }

  // seed per-session secret as a true global
  r = await call("GET", `/eval?session=${sid}&src=${encodeURIComponent(`globalThis.secret=${secret};globalThis.n=0;globalThis.secret`)}`, key);
  rec("eval", r.ms, r.status === 200 && r.body && r.body.value === secret, classify(r.status, r.body, r.netErr));
  if (!(r.body && r.body.value === secret)) failed = true;

  // N stateful evals: increment n, assert it climbs (state persists across evals)
  for (let k = 1; k <= OPS; k++) {
    r = await call("GET", `/eval?session=${sid}&src=${encodeURIComponent("globalThis.n=globalThis.n+1;globalThis.n")}`, key);
    const ok = r.status === 200 && r.body && r.body.value === k;
    rec("eval", r.ms, ok, classify(r.status, r.body, r.netErr));
    if (!ok) failed = true;
  }

  // isolation check: this session's secret must equal what we set (no cross-talk)
  r = await call("GET", `/eval?session=${sid}&src=${encodeURIComponent("globalThis.secret")}`, key);
  rec("eval", r.ms, r.status === 200, classify(r.status, r.body, r.netErr));
  if (!(r.body && r.body.value === secret)) { isolationFails++; failed = true; }

  // evict + cold-restore for a fraction
  if ((i % 100) < EVICT_FRAC * 100) {
    r = await op("evict", `/evict?session=${sid}`);
    restoreChecked++;
    r = await call("GET", `/eval?session=${sid}&src=${encodeURIComponent("globalThis.secret")}`, key);
    const restored = r.status === 200 && r.body && r.body.value === secret && r.body.restoreSource === "sqlite-restore";
    rec("restore-eval", r.ms, restored, classify(r.status, r.body, r.netErr));
    if (!restored) { restoreFails++; failed = true; }
  }

  if (failed) doneState.fail++; else doneState.ok++;
}

// ---- optional cross-tenant isolation probe (KEY2 must NOT read KEY's session) ----
async function crossTenantProbe() {
  if (!KEY2) return null;
  const sid = `${PREFIX}-xt`;
  await call("POST", `/create?session=${sid}`, KEY, {});
  await call("GET", `/eval?session=${sid}&src=${encodeURIComponent("globalThis.xtsecret=12345")}`, KEY);
  // KEY2 hits the SAME session id but different tenant -> facet name is keyed by tenant, so it
  // must get a FRESH facet (xtsecret undefined), proving tenant isolation.
  const r = await call("GET", `/eval?session=${sid}&src=${encodeURIComponent("globalThis.xtsecret")}`, KEY2);
  const isolated = r.status === 200 && (r.body && (r.body.value === null || r.body.value === undefined || (r.body.error)));
  return { isolated, leaked: r.body && r.body.value === 12345 };
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))];
}

async function main() {
  const t0 = performance.now();
  console.error(`[harness] BASE=${BASE} SESSIONS=${SESSIONS} CONCURRENCY=${CONCURRENCY} OPS=${OPS} EVICT_FRAC=${EVICT_FRAC} KEY2=${KEY2 ? "yes" : "no"}`);
  // open-loop: keep CONCURRENCY in flight
  let next = 0;
  async function worker() {
    while (next < SESSIONS) { const i = next++; await runSession(i); }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, SESSIONS) }, worker);
  await Promise.all(workers);
  const xt = await crossTenantProbe();
  const wallMs = performance.now() - t0;

  const totalOps = samples.length;
  const totalErr = samples.filter(s => !s.ok).length;
  const report = {
    config: { BASE, SESSIONS, CONCURRENCY, OPS, EVICT_FRAC, KEY2: !!KEY2 },
    wallSeconds: +(wallMs / 1000).toFixed(2),
    sessions: { ok: doneState.ok, fail: doneState.fail },
    totalOps, totalErr, errorRate: +(totalErr / totalOps).toFixed(5),
    errorsByClass: errClass,
    isolation: { perSessionFails: isolationFails, crossTenant: xt },
    coldRestore: { checked: restoreChecked, fails: restoreFails },
    latencyMs: Object.fromEntries(Object.entries(lat).map(([op, a]) => [op, {
      n: a.length, p50: +pct(a, 50).toFixed(1), p95: +pct(a, 95).toFixed(1), p99: +pct(a, 99).toFixed(1), max: +Math.max(...a).toFixed(1),
    }])),
    throughputOpsPerSec: +(totalOps / (wallMs / 1000)).toFixed(1),
  };
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error("FATAL", e); process.exit(1); });
