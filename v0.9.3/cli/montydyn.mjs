#!/usr/bin/env node
// montydyn — configurable durable REPL + depth-1 RLM loop CLI.
//
//   montydyn repl   [--endpoint <wss>] [--session <id>] [--config <file>] [--tools <file>] [--context-file <path>]
//   montydyn rlm <query> --context <file> [--model <stub|cmd:...>] [--depth 1] [--session <id>] [--endpoint <wss>]
//   montydyn sessions [list|inspect <id>|rm <id>] [--endpoint <wss>] [--store <file>]
//   montydyn trace <id> [--endpoint <wss>]
//
// The model backend for `rlm` is pluggable and lives CLIENT-SIDE (via the SDK's onSubLM bridge):
//   --model stub          deterministic fake LM (no API key) — default; summarizes each chunk.
//   --model cmd:<command> shells out per sub-LM call; the prompt is piped on stdin, stdout = completion.
// (Wire a real provider by importing the SDK and passing your own onSubLM handler.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execSync } from "node:child_process";
import WebSocket from "ws";
import { connect } from "../sdk/index.mjs";

const DEFAULT_ENDPOINT = process.env.MONTYDYN_ENDPOINT || "wss://montydyn-v09.umg-bhalla88.workers.dev";
const STORE = path.join(os.homedir(), ".montydyn-sessions.json");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; out[k] = v; }
    else out._.push(a);
  }
  return out;
}

function loadStore() { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (_) { return { sessions: {} }; } }
function saveStore(s) { try { fs.writeFileSync(STORE, JSON.stringify(s, null, 2)); } catch (_) {} }
function recordSession(id, meta) { const s = loadStore(); s.sessions[id] = { ...(s.sessions[id] || {}), ...meta, lastSeen: Date.now() }; saveStore(s); }

function readConfig(file) { if (!file || file === true) return {}; return JSON.parse(fs.readFileSync(file, "utf8")); }

// build a model backend (onSubLM handler) from --model
function makeSubLM(model) {
  if (!model || model === "stub" || model === true) {
    // deterministic fake LM: extract the chunk/reduce gist without any network/API key.
    return async ({ prompt }) => {
      const m = /Chunk (\d+):/.exec(prompt);
      if (m) {
        const body = prompt.split(/Chunk \d+:\n/)[1] || "";
        const firstLine = body.split("\n").find((l) => l.trim().length) || "";
        return `[chunk ${m[1]}] ${firstLine.slice(0, 120)}`;
      }
      // reduce step: count the partials, echo a synthesized answer.
      const partials = prompt.split("\n---\n").length;
      return `STUB-ANSWER over ${partials} partial(s): ` + (prompt.match(/Query: (.*)/)?.[1] || "");
    };
  }
  if (typeof model === "string" && model.startsWith("cmd:")) {
    const cmd = model.slice(4);
    return async ({ prompt }) => {
      try { return execSync(cmd, { input: prompt, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim(); }
      catch (e) { return `CMD-ERROR: ${String(e && e.message ? e.message : e)}`; }
    };
  }
  throw new Error(`unknown --model: ${model} (use stub or cmd:<command>)`);
}

async function cmdRepl(args) {
  const endpoint = args.endpoint || DEFAULT_ENDPOINT;
  const id = args.session || `repl-${Date.now()}`;
  const config = readConfig(args.config);
  const session = await connect({ endpoint, id, config, WebSocket });
  recordSession(id, { endpoint, kind: "repl" });
  if (args.tools) {
    const mod = await import(path.resolve(String(args.tools)));
    const tools = (mod.default || mod.tools || {});
    for (const [n, h] of Object.entries(tools)) session.registerTool(n, h);
    console.log(`registered host tools: ${Object.keys(tools).join(", ")}`);
  }
  if (args["context-file"]) {
    const blob = fs.readFileSync(String(args["context-file"]), "utf8");
    const r = await session.setContext("context", blob);
    console.log(`setContext: ${r.len} chars host-side (name=context, cell=${r.cell})`);
  }
  const gen = await session.gen();
  console.log(`montydyn repl  session=${id}  endpoint=${endpoint}  generation=${gen.generation}  inMemory=${gen.inMemory}`);
  // non-interactive: --exec runs one cell and exits (smoke-friendly). else interactive.
  if (args.exec) { const r = await session.eval(String(args.exec)); printEval(r); session.close(); return; }
  if (!process.stdin.isTTY && !args.interactive) {
    // pipe mode: each stdin line is a cell.
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) { if (line.trim()) printEval(await session.eval(line)); }
    session.close(); return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "montydyn> " });
  rl.prompt();
  rl.on("line", async (line) => {
    const src = line.trim();
    if (src === ".exit") { rl.close(); return; }
    if (src === ".reset") { await session.reset(); console.log("reset."); rl.prompt(); return; }
    if (src) printEval(await session.eval(src));
    rl.prompt();
  });
  rl.on("close", () => { session.close(); process.exit(0); });
}

function printEval(r) {
  for (const l of r.logs || []) console.log(`  [${l.level}] ${l.text}`);
  if (!r.ok) console.log(`  ERROR ${r.error?.name}: ${r.error?.message}`);
  else console.log(`  => ${r.valuePreview !== undefined ? r.valuePreview : JSON.stringify(r.value)}`);
}

async function cmdRlm(args) {
  const endpoint = args.endpoint || DEFAULT_ENDPOINT;
  const query = args._[0];
  if (!query) throw new Error("usage: montydyn rlm <query> --context <file>");
  if (!args.context) throw new Error("--context <file> is required");
  const id = args.session || `rlm-${Date.now()}`;
  const config = readConfig(args.config);
  const session = await connect({ endpoint, id, config: { clock: "seeded", ...config }, WebSocket });
  recordSession(id, { endpoint, kind: "rlm" });
  session.onSubLM(makeSubLM(args.model));
  const blob = fs.readFileSync(String(args.context), "utf8");
  const set = await session.setContext("context", blob);
  console.log(`context: ${set.len} chars host-side (handle 'context')`);
  console.log(`running depth-${args.depth || 1} RLM loop with model=${args.model || "stub"} ...`);
  const r = await session.rlm(query, { contextName: "context", maxSteps: 6 });
  console.log(`\n=== RLM ${r.kind} in ${r.steps} step(s), ${r.subLMCalls || 0} sub-LM call(s) ===`);
  console.log(typeof r.answer === "string" ? r.answer : JSON.stringify(r.answer, null, 2));
  session.close();
}

async function cmdSessions(args) {
  const sub = args._[0] || "list";
  const store = loadStore();
  if (sub === "list") {
    const ids = Object.keys(store.sessions);
    if (!ids.length) { console.log("(no sessions recorded by this CLI)"); return; }
    for (const id of ids) { const m = store.sessions[id]; console.log(`${id}\t${m.kind}\t${new Date(m.lastSeen).toISOString()}\t${m.endpoint}`); }
    return;
  }
  if (sub === "inspect") {
    const id = args._[1]; const endpoint = args.endpoint || (store.sessions[id]?.endpoint) || DEFAULT_ENDPOINT;
    const s = await connect({ endpoint, id, WebSocket });
    console.log(JSON.stringify(await s.gen(), null, 2)); s.close(); return;
  }
  if (sub === "rm") {
    const id = args._[1]; const endpoint = args.endpoint || (store.sessions[id]?.endpoint) || DEFAULT_ENDPOINT;
    const s = await connect({ endpoint, id, WebSocket }); await s.reset(); s.close();
    delete store.sessions[id]; saveStore(store); console.log(`reset + removed ${id}`); return;
  }
  throw new Error(`unknown sessions subcommand: ${sub}`);
}

async function cmdTrace(args) {
  const id = args._[0] || args.session;
  const store = loadStore();
  const endpoint = args.endpoint || (store.sessions[id]?.endpoint) || DEFAULT_ENDPOINT;
  const s = await connect({ endpoint, id, WebSocket });
  const gen = await s.gen();
  const t = await s.trajectory();
  console.log(JSON.stringify({ id, generation: gen.generation, committedCell: gen.committedCell, final: t.final }, null, 2));
  s.close();
}

(async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  try {
    if (cmd === "repl") await cmdRepl(args);
    else if (cmd === "rlm") await cmdRlm(args);
    else if (cmd === "sessions") await cmdSessions(args);
    else if (cmd === "trace") await cmdTrace(args);
    else { console.log("montydyn <repl|rlm|sessions|trace>  (see cli/README.md)"); process.exit(cmd ? 1 : 0); }
  } catch (e) { console.error("ERROR:", e && e.message ? e.message : e); process.exit(1); }
})();
