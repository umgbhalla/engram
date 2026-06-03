#!/usr/bin/env node
// engram — configurable durable REPL CLI for the Engram kernel.
//
//   engram repl     [--endpoint <wss>] [--session <id>] [--config <file>] [--exec '<cell>'] [--interactive]
//   engram sessions [list|inspect <id>|rm <id>] [--endpoint <wss>]
//   engram trace    <id> [--endpoint <wss>]
//
// Aligned to the @engram/sdk v2 connect export. The v2 kernel/SDK surface is a clean
// eval/reset/status REPL; the legacy host-tool / host-side context / depth-1 RLM commands
// were removed from both the kernel wire protocol and the SDK, so they are no longer offered.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import WebSocket from "ws";
import { connect, type EngramSession, type EngramConfig, type EvalResult } from "@engram/sdk";

const DEFAULT_ENDPOINT =
  process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.umg-bhalla88.workers.dev";
const STORE = path.join(os.homedir(), ".engram-sessions.json");

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

interface SessionMeta {
  endpoint?: string;
  kind?: string;
  lastSeen?: number;
}
interface Store {
  sessions: Record<string, SessionMeta>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      const v: string | boolean =
        next !== undefined && !next.startsWith("--") ? (argv[++i] as string) : true;
      out[k] = v;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function loadStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")) as Store;
  } catch {
    return { sessions: {} };
  }
}
function saveStore(s: Store): void {
  try {
    fs.writeFileSync(STORE, JSON.stringify(s, null, 2));
  } catch {
    /* best-effort */
  }
}
function recordSession(id: string, meta: SessionMeta): void {
  const s = loadStore();
  s.sessions[id] = { ...(s.sessions[id] || {}), ...meta, lastSeen: Date.now() };
  saveStore(s);
}

function readConfig(file: string | boolean | string[] | undefined): EngramConfig {
  const f = str(file);
  if (!f) return {};
  return JSON.parse(fs.readFileSync(f, "utf8")) as EngramConfig;
}

function str(v: string | boolean | string[] | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function printEval(r: EvalResult): void {
  for (const l of r.console || []) console.log(`  [${l.level}] ${l.text}`);
  if (!r.ok) {
    console.log(`  ERROR ${r.error?.name}: ${r.error?.message}`);
  } else {
    console.log(`  => ${r.valuePreview !== undefined ? r.valuePreview : JSON.stringify(r.value)}`);
  }
}

async function cmdRepl(args: Args): Promise<void> {
  const endpoint = str(args.endpoint) || DEFAULT_ENDPOINT;
  const id = str(args.session) || `repl-${Date.now()}`;
  const config = readConfig(args.config);
  const session = await connect({ url: endpoint, session: id, config, throwOnError: false, WebSocket });
  recordSession(id, { endpoint, kind: "repl" });

  const gen = await session.status();
  console.log(
    `engram repl  session=${id}  endpoint=${endpoint}  generation=${gen.generation}  inMemory=${gen.inMemory}`,
  );

  // non-interactive: --exec runs one cell and exits (smoke-friendly).
  if (args.exec) {
    printEval(await session.eval(String(args.exec)));
    session.close();
    return;
  }
  if (!process.stdin.isTTY && !args.interactive) {
    // pipe mode: each stdin line is a cell.
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (line.trim()) printEval(await session.eval(line));
    }
    session.close();
    return;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "engram> ",
  });
  rl.prompt();
  rl.on("line", async (line: string) => {
    const src = line.trim();
    if (src === ".exit") {
      rl.close();
      return;
    }
    if (src === ".reset") {
      await session.reset();
      console.log("reset.");
      rl.prompt();
      return;
    }
    if (src) printEval(await session.eval(src));
    rl.prompt();
  });
  rl.on("close", () => {
    session.close();
    process.exit(0);
  });
}

async function cmdSessions(args: Args): Promise<void> {
  const sub = args._[0] || "list";
  const store = loadStore();
  if (sub === "list") {
    const ids = Object.keys(store.sessions);
    if (!ids.length) {
      console.log("(no sessions recorded by this CLI)");
      return;
    }
    for (const id of ids) {
      const m = store.sessions[id] || {};
      console.log(
        `${id}\t${m.kind}\t${new Date(m.lastSeen || 0).toISOString()}\t${m.endpoint}`,
      );
    }
    return;
  }
  if (sub === "inspect") {
    const id = args._[1];
    if (!id) throw new Error("usage: engram sessions inspect <id>");
    const endpoint = str(args.endpoint) || store.sessions[id]?.endpoint || DEFAULT_ENDPOINT;
    const s: EngramSession = await connect({ url: endpoint, session: id, WebSocket });
    console.log(JSON.stringify(await s.status(), null, 2));
    s.close();
    return;
  }
  if (sub === "rm") {
    const id = args._[1];
    if (!id) throw new Error("usage: engram sessions rm <id>");
    const endpoint = str(args.endpoint) || store.sessions[id]?.endpoint || DEFAULT_ENDPOINT;
    const s: EngramSession = await connect({ url: endpoint, session: id, WebSocket });
    await s.reset();
    s.close();
    delete store.sessions[id];
    saveStore(store);
    console.log(`reset + removed ${id}`);
    return;
  }
  throw new Error(`unknown sessions subcommand: ${sub}`);
}

async function cmdTrace(args: Args): Promise<void> {
  const id = args._[0] || str(args.session) || "";
  const store = loadStore();
  const endpoint = str(args.endpoint) || store.sessions[id]?.endpoint || DEFAULT_ENDPOINT;
  const s: EngramSession = await connect({ url: endpoint, session: id, WebSocket });
  const gen = await s.status();
  console.log(
    JSON.stringify(
      { id, generation: gen.generation, committedCell: gen.committedCell, inMemory: gen.inMemory },
      null,
      2,
    ),
  );
  s.close();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  try {
    if (cmd === "repl") await cmdRepl(args);
    else if (cmd === "sessions") await cmdSessions(args);
    else if (cmd === "trace") await cmdTrace(args);
    else {
      console.log("engram <repl|sessions|trace>  (see cli/README.md)");
      process.exit(cmd ? 1 : 0);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("ERROR:", msg);
    process.exit(1);
  }
}

void main();
