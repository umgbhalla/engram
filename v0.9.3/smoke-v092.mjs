// montydyn v0.9.2 SMOKE — LAMBDA-RLM typed combinators + AGENT code-mode adapter.
//
// (a) lambdaRLM answers a query over a >1MB context using SPLIT/MAP/REDUCE with a STUB leaf
//     oracle, and TERMINATES within the cost budget — a deliberately over-decomposing query is
//     BOUNDED (leafCalls <= costBudget, exhausted=true), not blown up.
// (b) AGENT adapter: an 'agent' runs 2 turns; turn-2 SEES turn-1's state across a SIMULATED
//     HIBERNATION (evict between turns); tool calls route through host_call (recorded in toolCalls).
// (c) NO REGRESSION vs v0.9.1 — host.ctx.* big-context survive cold restore; stateful namespace OK.
//
// The leaf oracle and agent tools run CLIENT-SIDE (this process is the model backend / tool host);
// the kernel reaches them via the SDK's local HTTP bridge (host.subLM/host_call -> POST).
//
// Usage: node smoke-v092.mjs [wss-base]

import WebSocket from "ws";
import { connect, createAgent } from "./sdk/index.mjs";

const BASE = process.argv[2] || "wss://montydyn-v092.umg-bhalla88.workers.dev";
const results = [];
const log = (...a) => console.log(...a);
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond });
  log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

function bigContext(needle) {
  const line = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod\n"; // ~70B
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
  // (a) LAMBDA-RLM over a >1MB context, bounded + terminating.
  // ====================================================================
  const needle = "ZX42-" + Math.floor(Math.random() * 1e6);
  const ctx = bigContext(needle);
  log(`\n=== (a) LAMBDA-RLM ===  context=${(ctx.length / 1048576).toFixed(2)}MB  needle=${needle}`);

  const sid = "v092-lambda-" + Date.now();
  const s = await connect({ endpoint: BASE, id: sid, WebSocket, config: { clock: "seeded", modules: true } });

  // stub leaf oracle: counts calls, reports whether its chunk text contained the needle.
  let oracleCalls = 0;
  s.onSubLM(async ({ prompt }) => {
    oracleCalls++;
    return prompt.includes(needle) ? `FOUND:${needle}` : "no-match";
  });

  await s.setContext("context", ctx);
  const lenR = await s.eval(`host.ctx.len('context')`);
  check("(a0) >1MB context stored host-side", Number(lenR.value) === ctx.length, `len=${lenR.value}`);

  // NORMAL run: single-level chunking, generous budget — terminates, finds the needle.
  const r1 = await s.lambdaRLM("does the SECRET marker appear?", {
    ctx: "context", tau: 200000, split: 200000, maxDepth: 1, costBudget: 50, reduce: false, leafChars: 250000,
  });
  log("  normal:", JSON.stringify({ leafCalls: r1.leafCalls, exhausted: r1.exhausted, oracleCalls }));
  check("(a1) lambdaRLM terminates over >1MB ctx", r1.leafCalls > 1 && !r1.exhausted);
  check("(a2) leaf oracle saw the needle (SPLIT/MAP/REDUCE worked)", String(r1.answer).includes("FOUND:" + needle), `answer~${String(r1.answer).slice(0, 60)}`);

  s.close();

  // OVER-DECOMPOSE (fresh session): tiny tau forces thousands of UNIQUE parts (distinct per-chunk
  // tokens so the cooperative leaf cache can't collapse them), but costBudget caps leaf calls hard.
  const BUDGET = 12;
  const s2 = await connect({ endpoint: BASE, id: "v092-overdecomp-" + Date.now(), WebSocket, config: { clock: "seeded", modules: true } });
  let oracle2 = 0;
  s2.onSubLM(async () => { oracle2++; return "leaf" + oracle2; });
  let uniq = "";
  for (let i = 0; uniq.length < 1.2 * 1024 * 1024; i++) uniq += `CHUNK#${i} ` + "z".repeat(990) + "\n";
  await s2.setContext("uniq", uniq);
  const r2 = await s2.lambdaRLM("count occurrences", {
    ctx: "uniq", tau: 1000, split: 1000, maxDepth: 6, costBudget: BUDGET, reduce: "synthesize", leafChars: 2000, maxPumps: 4000,
  });
  log("  over-decompose:", JSON.stringify({ leafCalls: r2.leafCalls, exhausted: r2.exhausted, oracle: oracle2, budget: r2.budget }));
  check(`(a3) over-decomposing query BOUNDED to costBudget=${BUDGET}`, r2.leafCalls <= BUDGET && oracle2 <= BUDGET, `leafCalls=${r2.leafCalls} oracle=${oracle2}`);
  check("(a4) budget exhaustion flagged (not blown up)", r2.exhausted === true, `leafCalls=${r2.leafCalls}`);

  s2.close();

  // ====================================================================
  // (b) AGENT code-mode adapter: durable 2-turn, state across hibernation, tools via host_call.
  // ====================================================================
  log(`\n=== (b) AGENT adapter ===`);
  const aid = "v092-agent-" + Date.now();
  let searchHits = 0;
  const agent = await createAgent({
    endpoint: BASE, id: aid, WebSocket, config: { clock: "seeded", modules: true },
    tools: {
      search: async (q) => { searchHits++; return [`hit-for-${q}-1`, `hit-for-${q}-2`]; },
      add: async (a, b) => Number(a) + Number(b),
    },
  });

  // Turn 1: call a tool (host.search) and stash the result in a durable global.
  const t1 = await agent.turn(`
    (async () => {
      const hits = await host.search("widgets");
      globalThis.memory = { hits, count: hits.length, turn1: true };
      return globalThis.memory.count;
    })()
  `);
  log("  turn1:", JSON.stringify({ result: t1.result, toolCalls: t1.toolCalls.map((c) => c.tool), ok: t1.ok }));
  check("(b1) turn-1 ran agent code + returned result", t1.ok && Number(t1.result) === 2, `result=${t1.result}`);
  check("(b2) tool call routed through host_call (recorded)", t1.toolCalls.length === 1 && t1.toolCalls[0].tool === "search", JSON.stringify(t1.toolCalls.map((c) => c.tool)));

  // Simulate hibernation BETWEEN turns: evict the in-memory kernel (durable snapshot kept).
  await agent.hibernate();
  const gen = await agent.session.gen();
  check("(b3) agent hibernated (in-memory dropped)", gen.inMemory === false, JSON.stringify(gen));

  // Turn 2: cold-restore on first op; turn-2 must SEE turn-1's durable state.
  const t2 = await agent.turn(`
    (async () => {
      const prior = globalThis.memory;        // set in turn 1, must survive hibernation
      const sum = await host.add(prior.count, 40);
      return { sawTurn1: prior.turn1 === true, priorCount: prior.count, sum };
    })()
  `);
  log("  turn2:", JSON.stringify({ result: t2.result, toolCalls: t2.toolCalls.map((c) => c.tool), ok: t2.ok }));
  check("(b4) turn-2 SEES turn-1 state across hibernation", t2.ok && t2.result && t2.result.sawTurn1 === true && t2.result.priorCount === 2, JSON.stringify(t2.result));
  check("(b5) turn-2 tool call routed through host_call", t2.toolCalls.length === 1 && t2.toolCalls[0].tool === "add" && t2.result.sum === 42, JSON.stringify(t2.toolCalls.map((c) => c.tool)));

  agent.close();

  // ====================================================================
  // (c) NO REGRESSION vs v0.9.1: big-ctx survives cold restore + stateful namespace.
  // ====================================================================
  log(`\n=== (c) NO REGRESSION (v0.9.1 parity) ===`);
  const rid = "v092-regress-" + Date.now();
  let c = await connect({ endpoint: BASE, id: rid, WebSocket, config: { clock: "seeded", modules: true } });
  const rNeedle = "RG-" + Math.floor(Math.random() * 1e6);
  const rctx = bigContext(rNeedle);
  await c.setContext("doc", rctx);
  await c.eval(`globalThis.kk = (globalThis.kk||0)+1; kk`);
  await c.hibernate();
  const g2 = await c.session ? null : null; // c is a session here
  // reconnect-free cold check: gen says cold, then read ctx + namespace.
  const gg = await c.gen();
  check("(c1) regress session cold after evict", gg.inMemory === false, JSON.stringify(gg));
  const lenCold = await c.eval(`host.ctx.len('doc')`);
  check("(c2) >1MB ctx SURVIVES cold restore (v0.9.1 fix intact)", Number(lenCold.value) === rctx.length, `got=${lenCold.value}`);
  const grepCold = await c.eval(`JSON.stringify(host.ctx.grep(${JSON.stringify(rNeedle)}, {}, 'doc'))`);
  const gc = JSON.parse(grepCold.value || "[]");
  check("(c3) ctx.grep still finds needle cold", gc.length >= 1 && gc[0].line.includes(rNeedle));
  const k2 = await c.eval(`++globalThis.kk`);
  check("(c4) stateful namespace intact across hibernation", Number(k2.value) === 2, `kk=${k2.value}`);
  c.close();

  const passed = results.filter((r) => r.pass).length;
  log(`\n==== ${passed}/${results.length} PASS ====`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("SMOKE ERROR", e); process.exit(2); });
