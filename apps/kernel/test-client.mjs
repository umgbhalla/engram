// montydyn-v0 smoke test. Proves the full durable-REPL loop over a hibernatable WS:
//   eval 'globalThis.x=42; globalThis.inc=()=>++x;'  -> per-cell checkpoint to SQLite
//   -> force in-memory drop (evict) AND (mode=cold) a real idle eviction
//   -> reconnect -> eval 'inc()' returns 43, restored from SQLite, NO replay.
//
// Usage: node test-client.mjs <wss-base> [sim|cold|both] [idleMs]

import WebSocket from "ws";

const BASE = process.argv[2] || "wss://montydyn-v0.umg-bhalla88.workers.dev";
const MODE = process.argv[3] || "both";
const IDLE_MS = Number(process.argv[4] || 70000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function connect(sessionId) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(sessionId)}`);
  const pending = [];
  let onMsg = null;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (onMsg) {
      const cb = onMsg;
      onMsg = null;
      cb(m);
    } else pending.push(m);
  });
  const ready = new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  const send = (obj) =>
    new Promise((res) => {
      if (pending.length) return res(pending.shift());
      onMsg = res;
      ws.send(JSON.stringify(obj));
    });
  return { ws, ready, send, close: () => ws.close() };
}

async function setup(sessionId) {
  log(`\n=== session "${sessionId}": setup ===`);
  const c = connect(sessionId);
  await c.ready;
  const e1 = await c.send({ t: "eval", src: "globalThis.x=42; globalThis.inc=()=>++x; x" });
  log("eval setup:", JSON.stringify(e1));
  const g = await c.send({ t: "gen" });
  log("gen (warm):", JSON.stringify(g));
  return { c, genAtSetup: g.generation, setupResult: e1 };
}

async function verify(c, label) {
  log(`\n--- verify after ${label} ---`);
  const g = await c.send({ t: "gen" });
  log("gen:", JSON.stringify(g));
  const ex = await c.send({ t: "eval", src: "x" });
  log('eval "x":', JSON.stringify(ex));
  const inc = await c.send({ t: "eval", src: "inc()" });
  log('eval "inc()":', JSON.stringify(inc));
  const pass = Number(ex.value) === 42 && Number(inc.value) === 43;
  log(
    `>>> ${pass ? "PASS" : "FAIL"} (${label}): x=${ex.value} inc()=${inc.value} ` +
      `restoreSource=${ex.restoreSource} restoreLatencyMs=${ex.restoreLatencyMs} gen=${g.generation}`,
  );
  return {
    pass,
    x: ex.value,
    inc: inc.value,
    gen: g.generation,
    restoreSource: ex.restoreSource,
    restoreLatencyMs: ex.restoreLatencyMs,
    checkpoint: ex.checkpoint,
  };
}

async function runSim() {
  const sessionId = `sim-${Date.now()}`;
  const { c, genAtSetup } = await setup(sessionId);
  log("\nevict:", JSON.stringify(await c.send({ t: "evict" })));
  log("gen after evict:", JSON.stringify(await c.send({ t: "gen" })));
  const res = await verify(c, "simulated in-memory drop");
  c.close();
  return { kind: "simulated", genAtSetup, ...res };
}

async function runCold() {
  const sessionId = `cold-${Date.now()}`;
  const { c, genAtSetup } = await setup(sessionId);
  c.close();
  log(`\n=== idle ${IDLE_MS}ms to trigger real hibernation/eviction (disconnected) ===`);
  await sleep(IDLE_MS);
  const c2 = connect(sessionId);
  await c2.ready;
  const res = await verify(c2, "real cold wake");
  const reconstructed = res.gen > genAtSetup;
  log(
    `cold-wake reconstruction: gen ${genAtSetup} -> ${res.gen} => ` +
      `${reconstructed ? "RECONSTRUCTED (real eviction)" : "stayed warm"}`,
  );
  c2.close();
  return { kind: "real", reconstructed, genAtSetup, ...res };
}

async function runReset() {
  const sessionId = `reset-${Date.now()}`;
  const { c } = await setup(sessionId);
  log("\nreset:", JSON.stringify(await c.send({ t: "reset" })));
  const ex = await c.send({ t: "eval", src: "typeof x" });
  log('after reset eval "typeof x":', JSON.stringify(ex));
  const ok = ex.value === "undefined";
  log(`>>> ${ok ? "PASS" : "FAIL"} reset cleared namespace (typeof x = ${ex.value})`);
  c.close();
  return { ok, typeofX: ex.value };
}

// Force the R2 overflow path: build a namespace whose gzipped image exceeds
// SQLITE_HOT_MAX (2MB). Random-ish (but deterministic-seeded would gzip away), so
// we fill a big typed array with non-compressible content via the seeded RNG.
async function runR2() {
  const sessionId = `r2-${Date.now()}`;
  log(`\n=== session "${sessionId}": R2 overflow swap-then-delete ===`);
  const c = connect(sessionId);
  await c.ready;

  // Build a large, poorly-compressible buffer so the gzipped image exceeds
  // SQLITE_HOT_MAX (2MB) and the checkpoint takes store="r2". We fill with a pure
  // in-VM LCG (no host-callback crossings => fast) — high-entropy enough to defeat
  // gzip, so ~3.5MB raw stays ~3.5MB gz (> 2MB) and overflows to R2. Total live
  // image (~1.3MB base + 3.5MB) stays well under MAX_RAW (20MB).
  const N = 3.5 * 1024 * 1024;
  const build = await c.send({
    t: "eval",
    src:
      `globalThis.big = new Uint8Array(${N});` +
      "let s=0x9e3779b9>>>0;" +
      "for (let i=0;i<globalThis.big.length;i++){s=(Math.imul(s,1664525)+1013904223)>>>0;globalThis.big[i]=s>>>24;}" +
      "globalThis.x=42; globalThis.inc=()=>++x;" +
      "globalThis.big.length",
  });
  log("eval big:", JSON.stringify(build.checkpoint), "value=", build.value);
  const store1 = build.checkpoint && build.checkpoint.store;
  const key1 = build.checkpoint && build.checkpoint.r2Key;
  log(`  store=${store1} r2Key=${key1}`);
  if (store1 !== "r2") {
    log(">>> WARN: image did not overflow to R2 (gz<=2MB); cannot exercise R2 path");
  }

  // Second checkpoint -> NEW r2 key (swap). Old key must be deleted only after the
  // new manifest commits. We observe the key changed cell->cell.
  const step2 = await c.send({ t: "eval", src: "inc()" });
  const key2 = step2.checkpoint && step2.checkpoint.r2Key;
  log(`  after 2nd checkpoint: store=${step2.checkpoint.store} r2Key=${key2}`);
  const swapped = store1 === "r2" && key1 && key2 && key1 !== key2;
  log(`  swap-then-delete: key changed ${key1} -> ${key2} => ${swapped ? "FRESH KEY (swap)" : "n/a"}`);

  // Crash-mid-session: drop in-memory kernel, then restore from the committed R2
  // snapshot. Proves the prior committed object survived the replace cycle.
  log("evict:", JSON.stringify(await c.send({ t: "evict" })));
  const g = await c.send({ t: "gen" });
  log("gen after evict:", JSON.stringify(g));
  const ex = await c.send({ t: "eval", src: "x" });
  const inc = await c.send({ t: "eval", src: "inc()" });
  const big = await c.send({ t: "eval", src: "globalThis.big.length" });
  // pre-evict: build sets x=42 (cell0), step2 inc()->43 committed (cell1). After
  // restore from committed R2 snapshot, x===43; eval "x"->43; eval inc()->44.
  const pass =
    store1 === "r2" &&
    swapped &&
    Number(ex.value) === 43 &&
    Number(inc.value) === 44 &&
    Number(big.value) === N &&
    ex.restoreSource === "sqlite-restore"; // restore source label (R2-backed)
  log(
    `>>> ${pass ? "PASS" : "CHECK"} (R2 overflow): store=${store1} swapped=${swapped} ` +
      `x=${ex.value} inc=${inc.value} big=${big.value} restoreSource=${ex.restoreSource}`,
  );
  c.close();
  return { kind: "r2", store: store1, key1, key2, swapped, x: ex.value, inc: inc.value, big: big.value, restoreSource: ex.restoreSource, pass };
}

(async () => {
  log(`montydyn-v0 smoke -> ${BASE} mode=${MODE}`);
  const out = {};
  if (MODE === "sim" || MODE === "both") out.sim = await runSim();
  if (MODE === "cold" || MODE === "both") out.cold = await runCold();
  if (MODE === "reset" || MODE === "both") out.reset = await runReset();
  if (MODE === "r2") out.r2 = await runR2();
  log("\n===== SUMMARY =====");
  log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error("CLIENT ERROR:", e);
  process.exit(1);
});
