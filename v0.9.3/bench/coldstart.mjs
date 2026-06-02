// engram v0.4 — LONG-TAIL cold-start bench harness (the infra experiment).
//
// WHAT IT MEASURES
//   The client-observed COLD-WAKE round-trip: from sending the first stateful op against
//   a DO with no in-memory kernel, to receiving the reply. This is dominated by WS RTT +
//   DO wake + the restore path (read snapshot -> gunzip -> instantiate -> grow+blit ->
//   re-register -> eval). We build a DISTRIBUTION (p50/p90/p95/p99/p99.9) so the TAIL —
//   the thing v0.4 targets (cold-isolate spin-up + first WASM instantiate, EXP-5a saw a
//   ~700ms first instantiate) — is visible, not just the median.
//
// HOW IT FORCES A GENUINE COLD WAKE
//   Two modes:
//     --mode=evict (default, fast, high-N): each iteration uses a BRAND-NEW DO id (so the
//       isolate/object is genuinely fresh on first touch) AND additionally `evict`s the
//       in-memory kernel before the measured op, so the measured eval takes the lazy
//       cold-RESTORE path with certainty. New id => fresh DO => true cold instantiate.
//     --mode=idle: setup a session, disconnect, sleep --idleMs (default 70s) to let the DO
//       hibernate/evict for real, then reconnect and measure the first op. Closest to a
//       production cold wake but slow; use a small --n.
//
//   WARM baseline (--warm): measure the SAME op WITHOUT evicting (kernel already in memory)
//   so the cold delta = cold - warm isolates the restore/instantiate cost from WS RTT.
//
// SNAPSHOT SIZES
//   --size=base|5mb|15mb. We grow the namespace to a target raw image with a per-VM LCG
//   fill (high-entropy => defeats gzip => the gz/raw image genuinely reaches the target, so
//   the R2-overflow + larger-instantiate tail is exercised). base ~1.2MB raw; 5mb ~5MB;
//   15mb ~15MB (under the ~20MB safe ceiling, SUMMARY.md).
//
// The harness records, per cold iteration, the client RTT AND the server-stamped
// restoreTimings (readMs, glue.gunzipMs, glue.instantiateMs, growCount, neededPages,
// totalServerMs) so the client tail can be attributed to network vs server restore.
//
// USAGE
//   node bench/coldstart.mjs <wss-base> [--n=50] [--mode=evict|idle] [--size=base|5mb|15mb]
//                            [--warm] [--idleMs=70000] [--conc=4] [--json=out.json]
//   Default base: wss://montydyn-v05.<acct>.workers.dev

import WebSocket from "ws";

const BASE = (process.argv[2] && !process.argv[2].startsWith("--"))
  ? process.argv[2]
  : "wss://montydyn-v05.umg-bhalla88.workers.dev";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  }),
);
const N = Number(args.n || 50);
const MODE = args.mode || "evict";
const SIZE = args.size || "base";
const WARM = !!args.warm;
const IDLE_MS = Number(args.idleMs || 70000);
const CONC = Math.max(1, Number(args.conc || 4));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build the namespace to a target raw snapshot via a SERIES of cells. The LCG fill is
// incompressible (=> the gz/raw image genuinely reaches the target). It MUST be chunked
// across cells because a single multi-MB fill loop exceeds the workerd interrupt-throttle
// tick budget (~1200-2000); each cell re-arms the budget. Returns an array of sources; the
// last cell's value is the marker we verify after the cold wake.
function fillCells(size) {
  if (size === "base") return ["globalThis.x = 42; globalThis.inc=()=>++x; x"];
  const mb = size === "15mb" ? 15 : 5;
  const N = mb * 1024 * 1024;
  // ~1MB filled per cell: ~1M LCG iterations, comfortably under the 2000-tick budget, and
  // far fewer cells (=> far fewer intermediate full-image gzip checkpoints) than a tiny
  // chunk. NOTE each cell still triggers an automatic per-cell checkpoint, so a big fill is
  // inherently slow server-side (gzipping incompressible MBs); keep --n modest for 5mb/15mb.
  const CHUNK = 1024 * 1024;
  const cells = [
    `globalThis.x = 42; globalThis.inc=()=>++x; globalThis.big = new Uint8Array(${N}); globalThis.__s=0x9e3779b9>>>0; 'alloc'`,
  ];
  for (let off = 0; off < N; off += CHUNK) {
    const end = Math.min(off + CHUNK, N);
    cells.push(
      `{let s=globalThis.__s>>>0;for(let i=${off};i<${end};i++){s=(Math.imul(s,1664525)+1013904223)>>>0;globalThis.big[i]=s>>>24;}globalThis.__s=s;}${off}`,
    );
  }
  cells.push("globalThis.big.length");
  return cells;
}

function connect(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);
  const ready = new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const rpc = (msg, timeoutMs = 60000) =>
    new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("rpc timeout " + JSON.stringify(msg).slice(0, 40))), timeoutMs);
      ws.once("message", (d) => {
        clearTimeout(to);
        res(JSON.parse(d.toString()));
      });
      ws.send(JSON.stringify(msg));
    });
  return { ws, ready, rpc, close: () => { try { ws.close(); } catch (_) {} } };
}

// One cold-wake measurement. Returns { rtt, ok, restoreSource, server } or { error }.
async function oneColdEvict(i) {
  const id = `bench-${SIZE}-${MODE}-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
  const c = connect(id);
  try {
    await c.ready;
    // Larger budget for the big fills.
    await c.rpc({ t: "create", config: { clock: "seeded", cellBudgetTicks: 2000 } });
    let setup;
    for (const src of fillCells(SIZE)) {
      setup = await c.rpc({ t: "eval", src }, 90000);
      if (!setup.ok) return { error: "setup:" + JSON.stringify(setup.error) };
    }
    const rawMB = setup.checkpoint ? (setup.checkpoint.sizeRaw / 1e6).toFixed(2) : "?";
    const store = setup.checkpoint ? setup.checkpoint.store : "?";

    if (!WARM) {
      const ev = await c.rpc({ t: "evict" });
      if (!ev.droppedInMemory) return { error: "evict-not-dropped" };
    }
    // MEASURED op: first stateful eval against an evicted (cold) or warm kernel.
    const t0 = Date.now();
    const r = await c.rpc({ t: "eval", src: "inc()" }, 90000);
    const rtt = Date.now() - t0;
    if (!r.ok) return { error: "measured:" + JSON.stringify(r.error) };
    return {
      rtt,
      ok: true,
      restoreSource: r.restoreSource,
      server: r.restoreTimings || null,
      rawMB,
      store,
    };
  } catch (e) {
    return { error: String(e && e.message || e) };
  } finally {
    c.close();
  }
}

// Idle-eviction mode: setup, disconnect, sleep, reconnect, measure first op.
async function oneColdIdle(i) {
  const id = `benchidle-${SIZE}-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
  let c = connect(id);
  try {
    await c.ready;
    await c.rpc({ t: "create", config: { clock: "seeded", cellBudgetTicks: 2000 } });
    let setup;
    for (const src of fillCells(SIZE)) {
      setup = await c.rpc({ t: "eval", src }, 90000);
      if (!setup.ok) return { error: "setup:" + JSON.stringify(setup.error) };
    }
    const rawMB = setup.checkpoint ? (setup.checkpoint.sizeRaw / 1e6).toFixed(2) : "?";
    const store = setup.checkpoint ? setup.checkpoint.store : "?";
    const genBefore = (await c.rpc({ t: "gen" })).generation;
    c.close();
    await sleep(IDLE_MS);
    c = connect(id);
    await c.ready;
    const t0 = Date.now();
    const r = await c.rpc({ t: "eval", src: "inc()" }, 90000);
    const rtt = Date.now() - t0;
    const genAfter = (await c.rpc({ t: "gen" })).generation;
    if (!r.ok) return { error: "measured:" + JSON.stringify(r.error) };
    return {
      rtt,
      ok: true,
      restoreSource: r.restoreSource,
      server: r.restoreTimings || null,
      reconstructed: genAfter > genBefore,
      rawMB,
      store,
    };
  } catch (e) {
    return { error: String(e && e.message || e) };
  } finally {
    c.close();
  }
}

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function dist(label, vals) {
  const s = [...vals].sort((a, b) => a - b);
  return {
    label,
    n: s.length,
    min: s[0],
    p50: pct(s, 50),
    p90: pct(s, 90),
    p95: pct(s, 95),
    p99: pct(s, 99),
    p999: pct(s, 99.9),
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

// Run with a small concurrency pool (CONC) to keep load realistic but finish in bounded time.
async function runPool(n, conc, fn) {
  const results = new Array(n);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= n) break;
      results[i] = await fn(i);
      process.stdout.write(results[i].error ? "x" : ".");
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  process.stdout.write("\n");
  return results;
}

(async () => {
  console.log(`montydyn-v0.4 cold-start bench -> ${BASE}`);
  console.log(`  mode=${MODE} size=${SIZE} n=${N} warm=${WARM} conc=${CONC}${MODE === "idle" ? ` idleMs=${IDLE_MS}` : ""}`);
  const fn = MODE === "idle" ? oneColdIdle : oneColdEvict;
  const raw = await runPool(N, MODE === "idle" ? 1 : CONC, fn);
  const ok = raw.filter((r) => r && r.ok);
  const errs = raw.filter((r) => !r || r.error);

  const rtts = ok.map((r) => r.rtt);
  const d = dist(`client-rtt(${MODE}/${SIZE}/${WARM ? "warm" : "cold"})`, rtts);

  // server-side restore timings (cold only)
  const serverTotals = ok.map((r) => r.server && r.server.totalServerMs).filter((x) => Number.isFinite(x));
  const gunzipMs = ok.map((r) => r.server && r.server.glue && r.server.glue.gunzipMs).filter((x) => Number.isFinite(x));
  const instMs = ok.map((r) => r.server && r.server.glue && r.server.glue.instantiateMs).filter((x) => Number.isFinite(x));
  const growCounts = ok.map((r) => r.server && r.server.glue && r.server.glue.growCount).filter((x) => Number.isFinite(x));
  const neededPages = ok.map((r) => r.server && r.server.glue && r.server.glue.neededPages).filter((x) => Number.isFinite(x));

  console.log(`\n==== RESULTS (${ok.length} ok / ${errs.length} err) ====`);
  console.log(`raw image: ~${ok[0] ? ok[0].rawMB : "?"}MB  store=${ok[0] ? ok[0].store : "?"}  restoreSource=${ok[0] ? ok[0].restoreSource : "?"}`);
  console.log(`CLIENT RTT ms: ${JSON.stringify(d, null, 0)}`);
  if (serverTotals.length) console.log(`SERVER totalServerMs: ${JSON.stringify(dist("server-total", serverTotals), null, 0)}`);
  if (gunzipMs.length) console.log(`  glue.gunzipMs: ${JSON.stringify(dist("gunzip", gunzipMs), null, 0)}`);
  if (instMs.length) console.log(`  glue.instantiateMs (instantiate+grow+blit): ${JSON.stringify(dist("instantiate", instMs), null, 0)}`);
  if (growCounts.length) {
    const maxGrow = Math.max(...growCounts);
    console.log(`  B1 growCount during restore: max=${maxGrow} (expect <=1 => no blit grow-churn)  neededPages~${neededPages[0]}`);
  }
  if (errs.length) console.log(`errors (first 3): ${errs.slice(0, 3).map((e) => e.error).join(" | ")}`);

  if (args.json) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(args.json, JSON.stringify({ base: BASE, mode: MODE, size: SIZE, warm: WARM, n: N, dist: d, serverTotals, raw }, null, 2));
    console.log(`wrote ${args.json}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error("BENCH ERROR:", e);
  process.exit(1);
});
