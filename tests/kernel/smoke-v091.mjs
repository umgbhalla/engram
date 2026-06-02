// engram v0.9.1 SMOKE — the HIGH context-store-chunking fix.
//
// Proves: setContext a ~5MB blob (with a needle) -> host.ctx.len/grep find it warm
// -> EVICT (drop in-memory) -> cold restore -> the 5MB context SURVIVES intact
// (len correct, grep still finds the needle). The v0.9 bug LOST it (SQLITE_TOOBIG on a
// single ctx_json value). Also: a depth-1 RLM-style loop answers a >1MB-context needle
// ACROSS a hibernation, and the trajectory `final` survives reconnect (trace fix).
//
// Usage: node smoke-v091.mjs <wss-base> [sessionId]

import WebSocket from "ws";

const BASE = process.argv[2] || "wss://montydyn-v091.umg-bhalla88.workers.dev";
const SID = process.argv[3] || "v091-smoke-" + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function connect(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);
  const pending = [];
  let onMsg = null;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (onMsg) { const cb = onMsg; onMsg = null; cb(m); } else pending.push(m);
  });
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (obj) => new Promise((res) => {
    if (pending.length) return res(pending.shift());
    onMsg = res; ws.send(JSON.stringify(obj));
  });
  return { ws, ready, send, close: () => ws.close() };
}

// Build a ~5MB context with a known needle buried near the middle.
function bigContext(needle) {
  const line = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\n"; // ~70B
  const repeats = Math.ceil((5 * 1024 * 1024) / line.length);
  const parts = [];
  for (let i = 0; i < repeats; i++) {
    if (i === Math.floor(repeats / 2)) parts.push(`>>> SECRET ${needle} marker line <<<\n`);
    parts.push(line);
  }
  return parts.join("");
}

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond });
  log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

async function main() {
  const needle = "ZX42-" + Math.floor(Math.random() * 1e6);
  const ctx = bigContext(needle);
  log(`session=${SID}  context=${ctx.length} chars (~${(ctx.length / 1048576).toFixed(2)}MB)  needle=${needle}`);

  let c = connect(SID);
  await c.ready;

  // create with subLM disabled (we run the loop client-side via grep, no model needed)
  await c.send({ t: "eval", src: "1", config: { clock: "seeded" } });

  // 1) setContext the 5MB blob.
  const sc = await c.send({ t: "setContext", name: "doc", blob: ctx });
  log("setContext:", JSON.stringify({ ok: sc.ok, len: sc.len, store: sc.checkpoint && sc.checkpoint.store }));
  check("setContext stores full 5MB len", sc.ok && sc.len === ctx.length, `len=${sc.len}`);

  // 2) warm: host.ctx.len + grep find the needle.
  const lenWarm = await c.send({ t: "eval", src: `host.ctx.len('doc')` });
  check("warm ctx.len correct", Number(lenWarm.value) === ctx.length, `got=${lenWarm.value}`);
  const grepWarm = await c.send({ t: "eval", src: `JSON.stringify(host.ctx.grep(${JSON.stringify(needle)}, {}, 'doc'))` });
  const gw = JSON.parse(grepWarm.value || "[]");
  check("warm ctx.grep finds needle", gw.length >= 1 && gw[0].line.includes(needle));

  // 3) record an RLM final (literal) so we can test trace-after-reconnect.
  await c.send({ t: "eval", src: `host.final("answer-found-at:" + host.ctx.grep(${JSON.stringify(needle)}, {}, 'doc')[0].i)` });
  const finalWarm = await c.send({ t: "final" });
  check("warm final recorded", finalWarm.final && finalWarm.final.kind === "FINAL", JSON.stringify(finalWarm.final));

  // 4) EVICT (drop in-memory kernel; durable snapshot stays). Forces cold restore.
  const ev = await c.send({ t: "evict" });
  log("evict:", JSON.stringify(ev));
  const g = await c.send({ t: "gen" });
  check("cold after evict (inMemory false)", g.inMemory === false, JSON.stringify(g));

  // 5) reconnect on a fresh socket -> cold restore on first op.
  c.close();
  await sleep(500);
  c = connect(SID);
  await c.ready;

  const lenCold = await c.send({ t: "eval", src: `host.ctx.len('doc')` });
  check("COLD ctx.len SURVIVES (5MB context not lost)", Number(lenCold.value) === ctx.length, `got=${lenCold.value} want=${ctx.length}`);
  const grepCold = await c.send({ t: "eval", src: `JSON.stringify(host.ctx.grep(${JSON.stringify(needle)}, {}, 'doc'))` });
  const gc = JSON.parse(grepCold.value || "[]");
  check("COLD ctx.grep STILL finds needle (bug fixed)", gc.length >= 1 && gc[0].line.includes(needle), `matches=${gc.length}`);

  // 6) trace/final survives reconnect (persisted to SQLite).
  const finalCold = await c.send({ t: "final" });
  check("COLD final survives reconnect (trace fix)", finalCold.final && finalCold.final.kind === "FINAL" && String(finalCold.final.value).startsWith("answer-found-at:"), JSON.stringify(finalCold.final));

  // 7) raised slice cap: a 1MB slice crosses the boundary intact.
  const sl = await c.send({ t: "eval", src: `host.ctx.slice(0, 1048576, 'doc').length` });
  check("raised slice cap (1MB single boundary copy)", Number(sl.value) === 1048576, `got=${sl.value}`);

  // 8) no regression: plain stateful REPL still works across the same session.
  await c.send({ t: "eval", src: `globalThis.k = (globalThis.k||0)+1; k` });
  const k2 = await c.send({ t: "eval", src: `++globalThis.k` });
  check("no regression: stateful namespace intact", Number(k2.value) >= 2);

  c.close();
  const passed = results.filter((r) => r.pass).length;
  log(`\n==== ${passed}/${results.length} PASS ====`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("SMOKE ERROR", e); process.exit(2); });
