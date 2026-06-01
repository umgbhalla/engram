// montydyn v0.9.3 SMOKE — HARDENING: native-C giant-alloc backstop + engine-migration journal.
//
// (a) NATIVE-C GIANT-ALLOC BACKSTOP: a 258MB structuredClone / giant typed-array fill now
//     clean-rejects as a typed NativeAllocLimitError with the SOCKET ALIVE, and the next eval
//     works (vs the old uncatchable WS-1006 DO kill).
// (b) ENGINE-MIGRATION JOURNAL (ADR-0002): build a stateful namespace, hibernate, simulate an
//     engine-hash BUMP, then cold-eval -> the kernel REPLAYS the per-cell source journal into a
//     fresh engine and RECOVERS the namespace (vs the old hard EngineHashMismatchError reject).
// (c) NO REGRESSION vs v0.9.2 — stateful namespace + big host.ctx survive cold restore; gen/version.
//
// Usage: node smoke-v093.mjs [wss-base]

import WebSocket from "ws";
import { connect } from "./sdk/index.mjs";

const BASE = process.argv[2] || "wss://montydyn-v093.umg-bhalla88.workers.dev";
const results = [];
const log = (...a) => console.log(...a);
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond });
  log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

// raw WS helper for the test-only {t:engineBump} hook (not in the SDK).
function rawSend(endpoint, id, msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${endpoint}/?id=${encodeURIComponent(id)}`);
    const to = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error("timeout")); }, timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify(msg)));
    ws.on("message", (d) => { clearTimeout(to); let r; try { r = JSON.parse(d.toString()); } catch (_) { r = { raw: d.toString() }; } try { ws.close(); } catch (_) {} resolve(r); });
    ws.on("error", (e) => { clearTimeout(to); reject(e); });
  });
}

function bigContext(needle) {
  const line = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\n";
  const repeats = Math.ceil((1.2 * 1024 * 1024) / line.length);
  const parts = [];
  for (let i = 0; i < repeats; i++) {
    if (i === Math.floor(repeats / 2)) parts.push(`>>> SECRET ${needle} marker line <<<\n`);
    parts.push(line);
  }
  return parts.join("");
}

async function main() {
  // ====================================================================
  // (a) NATIVE-C GIANT-ALLOC BACKSTOP
  // ====================================================================
  log(`\n=== (a) NATIVE-C GIANT-ALLOC BACKSTOP ===`);
  const sid = "v093-alloc-" + Date.now();
  const s = await connect({ endpoint: BASE, id: sid, WebSocket, config: { clock: "seeded" } });

  // establish + a baseline eval
  const base = await s.eval(`globalThis.n = 1; n`);
  check("(a0) baseline eval works", base.ok && Number(base.value) === 1, `value=${base.value}`);

  // 258MB structuredClone -> NativeAllocLimitError, socket alive.
  const sc = await s.eval(`structuredClone({ a: "x".repeat(258 * 1024 * 1024) })`);
  check("(a1) 258MB structuredClone clean-rejects (NativeAllocLimitError)",
    sc.ok === false && sc.error && sc.error.name === "NativeAllocLimitError",
    JSON.stringify(sc.error || sc.value));

  // socket alive + next eval works
  const after1 = await s.eval(`globalThis.n + 41`);
  check("(a2) socket alive — next eval works after structuredClone bomb",
    after1.ok && Number(after1.value) === 42, `value=${after1.value}`);

  // giant typed-array fill -> NativeAllocLimitError
  const ta = await s.eval(`new Uint8Array(258 * 1024 * 1024).fill(7).length`);
  check("(a3) 258MB typed-array fill clean-rejects (NativeAllocLimitError)",
    ta.ok === false && ta.error && ta.error.name === "NativeAllocLimitError",
    JSON.stringify(ta.error || ta.value));

  const after2 = await s.eval(`100 + n`);
  check("(a4) socket alive — next eval works after typed-array bomb",
    after2.ok && Number(after2.value) === 101, `value=${after2.value}`);

  // DO not killed: gen still answers, generation unchanged (no WS-1006/reconstruct).
  const genA = await s.gen();
  check("(a5) DO survived — gen answers, still in-memory",
    genA.ok && genA.inMemory === true, JSON.stringify({ inMemory: genA.inMemory, gen: genA.generation }));
  s.close();

  // ====================================================================
  // (b) ENGINE-MIGRATION JOURNAL (ADR-0002)
  // ====================================================================
  log(`\n=== (b) ENGINE-MIGRATION JOURNAL ===`);
  const bid = "v093-journal-" + Date.now();
  let b = await connect({ endpoint: BASE, id: bid, WebSocket, config: { clock: "seeded" } });

  // Build a PURE stateful namespace across several cells (all journaled).
  await b.eval(`globalThis.acc = 0; acc`);
  await b.eval(`globalThis.acc = acc + 10; acc`);
  await b.eval(`globalThis.fib = (n) => n < 2 ? n : fib(n-1) + fib(n-2); fib(10)`);
  await b.eval(`globalThis.acc = acc + fib(10); acc`); // 10 + 55 = 65

  const preGen = await b.gen();
  check("(b0) journal recorded committed cells",
    preGen.journalLen >= 4 && preGen.version === "v0.9.3",
    JSON.stringify({ journalLen: preGen.journalLen, version: preGen.version }));

  // Hibernate (drop in-memory; durable snapshot + journal kept).
  await b.hibernate();
  // Simulate an ENGINE-HASH BUMP: rewrite the committed manifest's engine_hash to a bogus value.
  const bump = await rawSend(BASE, bid, { t: "engineBump" });
  check("(b1) engine-hash bump simulated", bump.ok === true && bump.hadManifest === true, JSON.stringify(bump));

  const gBumped = await b.gen();
  check("(b2) snapshot engine != current engine (mismatch armed)",
    gBumped.snapshotEngineHash && gBumped.snapshotEngineHash !== gBumped.engineHash,
    JSON.stringify({ snap: gBumped.snapshotEngineHash, cur: (gBumped.engineHash || "").slice(0, 12) }));

  // Cold eval -> must REPLAY the journal (not hard-reject) and recover the namespace.
  const rec = await b.eval(`acc`);
  check("(b3) journal REPLAY recovers namespace (vs old EngineHashMismatchError)",
    rec.ok === true && Number(rec.value) === 65, `acc=${rec.value} restoreSource=${rec.restoreSource}`);
  check("(b4) recovery used journal-replay path",
    rec.restoreSource === "journal-replay", `restoreSource=${rec.restoreSource}`);

  // The replayed pure function is reusable.
  const fibR = await b.eval(`fib(12)`);
  check("(b5) replayed closures intact (pure cell reproduced)",
    fibR.ok && Number(fibR.value) === 144, `fib(12)=${fibR.value}`);
  b.close();

  // (b6) EFFECTFUL no-replay caveat: a session whose journal has an effectful cell is flagged.
  const eid = "v093-journal-eff-" + Date.now();
  let e = await connect({ endpoint: BASE, id: eid, WebSocket, config: { clock: "seeded" } });
  await e.eval(`globalThis.r = Math.random(); globalThis.seen = 1; seen`); // effectful (Math.random)
  await e.eval(`globalThis.seen = seen + 1; seen`); // pure
  await e.hibernate();
  await rawSend(BASE, eid, { t: "engineBump" });
  const recE = await e.eval(`seen`);
  check("(b7) effectful-journal session still recovers (best-effort)",
    recE.ok && Number(recE.value) === 2 && recE.restoreSource === "journal-replay",
    `seen=${recE.value} src=${recE.restoreSource}`);
  e.close();

  // ====================================================================
  // (c) NO REGRESSION vs v0.9.2
  // ====================================================================
  log(`\n=== (c) NO REGRESSION ===`);
  const rid = "v093-regress-" + Date.now();
  let c = await connect({ endpoint: BASE, id: rid, WebSocket, config: { clock: "seeded", modules: true } });
  const rNeedle = "RG-" + Math.floor(Math.random() * 1e6);
  const rctx = bigContext(rNeedle);
  await c.setContext("doc", rctx);
  await c.eval(`globalThis.kk = (globalThis.kk||0)+1; kk`);
  await c.hibernate();
  const gg = await c.gen();
  check("(c1) regress session cold after evict", gg.inMemory === false, JSON.stringify({ inMemory: gg.inMemory }));
  const lenCold = await c.eval(`host.ctx.len('doc')`);
  check("(c2) >1MB ctx SURVIVES cold restore (heap-snapshot fast path intact)",
    Number(lenCold.value) === rctx.length, `got=${lenCold.value}`);
  check("(c3) cold restore used heap-snapshot (NOT journal — engine matches)",
    lenCold.restoreSource && lenCold.restoreSource.includes("restore") && lenCold.restoreSource !== "journal-replay",
    `src=${lenCold.restoreSource}`);
  const k2 = await c.eval(`++globalThis.kk`);
  check("(c4) stateful namespace intact across hibernation", Number(k2.value) === 2, `kk=${k2.value}`);
  // stdlib still injected + usable
  const lod = await c.eval(`typeof _ === 'function' || (typeof _ === 'object' && _ !== null) ? _.chunk([1,2,3,4],2).length : 'no-lodash'`);
  check("(c5) configured stdlib intact across cold restore", Number(lod.value) === 2, `chunks=${lod.value}`);
  c.close();

  const passed = results.filter((r) => r.pass).length;
  log(`\n==== ${passed}/${results.length} PASS ====`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("SMOKE ERROR", e); process.exit(2); });
