// engram REPL — a Node.js-REPL-feel interactive client over the REMOTE durable kernel.
//
// Every accepted line (or multi-line cell) is sent as ONE `eval` to the live
// engram-kernel Durable Object via @engram/sdk. The REPL provides multi-line
// continuation, persistent history, node-like colorized output, latency telemetry,
// a slow-cell spinner, dot-commands, and node-like key handling.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { connect, type EngramSession, type EngramConfig, type EvalResult } from "@engram/sdk";

const HISTORY_FILE = path.join(os.homedir(), ".engram_repl_history");
const HISTORY_CAP = 1000;

// ---------------------------------------------------------------------------
// ANSI helpers (only emit when stdout is a TTY)
// ---------------------------------------------------------------------------

type Colorizer = (s: string) => string;

function makeColors(enabled: boolean): {
  yellow: Colorizer;
  green: Colorizer;
  red: Colorizer;
  cyan: Colorizer;
  dim: Colorizer;
  bold: Colorizer;
} {
  const wrap = (open: string, close: string): Colorizer =>
    enabled ? (s: string) => `\x1b[${open}m${s}\x1b[${close}m` : (s: string) => s;
  return {
    yellow: wrap("33", "39"),
    green: wrap("32", "39"),
    red: wrap("31", "39"),
    cyan: wrap("36", "39"),
    dim: wrap("2", "22"),
    bold: wrap("1", "22"),
  };
}

// ---------------------------------------------------------------------------
// Completeness scanner — lexical balance + dangling-operator detection.
// Tolerates TypeScript (type annotations, generics) because it is NOT a parser:
// it only tracks bracket/string/template depth and trailing-operator state.
// ---------------------------------------------------------------------------

interface Balance {
  /** true when brackets/strings are balanced and no trailing operator dangles. */
  complete: boolean;
  /** unterminated string/template/block-comment → always continue. */
  openLiteral: boolean;
}

/**
 * Scan a buffer for lexical balance. We walk char by char tracking:
 *  - () {} [] depth
 *  - single/double quoted strings (with escapes)
 *  - template literals + nested ${ } (a stack of brace-depths)
 *  - line (//) and block comments
 *  - regex literals (disambiguated from division by the previous significant token)
 * Then a tail scan flags a dangling binary/arrow/comma/dot/ternary operator or open backtick.
 */
function scanBalance(src: string): Balance {
  let round = 0;
  let curly = 0;
  let square = 0;
  let inS = false; // single quote
  let inD = false; // double quote
  let inLine = false; // // comment
  let inBlock = false; // /* */ comment
  // template-literal stack: each entry is the curly-depth captured when we entered
  // a `${` inside a template; an empty/undefined top of a separate templateDepth
  // counter tracks how many template literals are currently open.
  let templates = 0;
  // when inside a template's text (not inside ${...}); we toggle this with ${ and }
  const templateInExpr: boolean[] = []; // true = currently inside ${...} of that template
  let prevSig = ""; // previous significant (non-space, non-comment) char, for regex detection
  let inRegex = false;
  let inCharClass = false; // inside [...] within a regex

  const isRegexAllowed = (): boolean => {
    // A `/` starts a regex if the previous significant char suggests an expression
    // position rather than a value (after which `/` is division).
    if (prevSig === "") return true;
    if (/[A-Za-z0-9_$)\]}]/.test(prevSig)) return false; // value/closer → division
    return true;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const n = src[i + 1];

    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inS) {
      if (c === "\\") i++;
      else if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === "\\") i++;
      else if (c === '"') inD = false;
      continue;
    }
    if (inRegex) {
      if (c === "\\") {
        i++;
      } else if (inCharClass) {
        if (c === "]") inCharClass = false;
      } else if (c === "[") {
        inCharClass = true;
      } else if (c === "/") {
        inRegex = false;
        // skip flags
        while (i + 1 < src.length && /[a-z]/i.test(src[i + 1] as string)) i++;
        prevSig = "/";
      }
      continue;
    }

    // Inside a template literal's TEXT portion (not inside ${...}).
    const inTemplateText = templates > 0 && templateInExpr[templates - 1] === false;
    if (inTemplateText) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "`") {
        templates--;
        templateInExpr.pop();
        prevSig = "`";
        continue;
      }
      if (c === "$" && n === "{") {
        templateInExpr[templates - 1] = true;
        curly++; // the ${ opens a curly we must match
        i++;
        prevSig = "{";
        continue;
      }
      continue; // ordinary template text
    }

    // Normal code (or inside a template's ${...} expression).
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (c === "'") {
      inS = true;
      continue;
    }
    if (c === '"') {
      inD = true;
      continue;
    }
    if (c === "`") {
      templates++;
      templateInExpr.push(false);
      continue;
    }
    if (c === "/" && isRegexAllowed()) {
      inRegex = true;
      inCharClass = false;
      continue;
    }

    if (c === "(") round++;
    else if (c === ")") round--;
    else if (c === "[") square++;
    else if (c === "]") square--;
    else if (c === "{") curly++;
    else if (c === "}") {
      // A `}` may close a ${...} of the innermost template currently in-expr.
      if (templates > 0 && templateInExpr[templates - 1] === true && curly > 0) {
        // We can't perfectly know if this brace matches the ${ vs a nested object.
        // Heuristic: only treat it as closing the template-expr when curly would
        // drop to the depth captured at the ${ — but we didn't store that. Since
        // we incremented curly at ${, decrementing here and flipping back to text
        // is correct as long as expressions are balanced, which for a COMPLETE
        // cell they are. For incomplete cells we err toward "continue", which is
        // the safe behavior.
        curly--;
        templateInExpr[templates - 1] = false;
      } else {
        curly--;
      }
    }

    if (!/\s/.test(c)) prevSig = c;
  }

  const openLiteral = inS || inD || inBlock || templates > 0 || inRegex;
  const balanced = round <= 0 && curly <= 0 && square <= 0 && !openLiteral && !inLine;

  if (!balanced) return { complete: false, openLiteral };

  // Dangling-operator detection on the trimmed buffer (ignoring trailing comments).
  const code = stripTrailingComment(src).trimEnd();
  if (code === "") return { complete: true, openLiteral: false };
  if (endsWithDanglingOperator(code)) return { complete: false, openLiteral: false };
  return { complete: true, openLiteral: false };
}

function stripTrailingComment(src: string): string {
  // Remove a trailing line comment on the LAST line only (best-effort; the full
  // scan already validated we're not inside a string/template here).
  const nl = src.lastIndexOf("\n");
  const lastLine = src.slice(nl + 1);
  const idx = lastLine.indexOf("//");
  if (idx >= 0) {
    // crude: ensure the // isn't inside a string on the last line
    const before = lastLine.slice(0, idx);
    const sq = (before.match(/'/g) || []).length;
    const dq = (before.match(/"/g) || []).length;
    if (sq % 2 === 0 && dq % 2 === 0) {
      return src.slice(0, nl + 1) + before;
    }
  }
  return src;
}

function endsWithDanglingOperator(code: string): boolean {
  // Trailing binary/assignment/arrow/comma/dot/ternary operators imply more to come.
  // Note: `++` / `--` are NOT dangling (postfix), and `}` / `)` end statements.
  if (/=>$/.test(code)) return true;
  if (/(\?\.|\.|,|;?\s*\?|:)$/.test(code) && !/;$/.test(code)) {
    if (/[,.]$/.test(code)) return true;
    if (/\?$/.test(code) || /:$/.test(code) || /\?\.$/.test(code)) return true;
  }
  // binary / logical / assignment operators (avoid matching ++ -- and =>)
  if (/(\+\+|--)$/.test(code)) return false;
  if (
    /(&&|\|\||\?\?|[-+*/%&|^<>=]=?|=)$/.test(code) &&
    !/=>$/.test(code)
  ) {
    return true;
  }
  // open backtick handled by openLiteral; trailing `(` `{` `[` handled by balance.
  return false;
}

/** True if a single line is a complete cell on its own (used for one-shot/pipe). */
export function isComplete(src: string): boolean {
  return scanBalance(src).complete;
}

// ---------------------------------------------------------------------------
// History persistence
// ---------------------------------------------------------------------------

function loadHistory(): string[] {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean);
    // readline expects newest first.
    return lines.slice(-HISTORY_CAP).reverse();
  } catch {
    return [];
  }
}

function appendHistory(entry: string): void {
  const clean = entry.replace(/\n/g, " ").trim();
  if (!clean) return;
  try {
    fs.appendFileSync(HISTORY_FILE, clean + "\n");
  } catch {
    /* best-effort */
  }
}

function saveHistory(history: string[]): void {
  // history is newest-first (readline order); persist oldest-first.
  const out = history.slice(0, HISTORY_CAP).reverse().join("\n");
  fs.writeFileSync(HISTORY_FILE, out + (out ? "\n" : ""));
}

// ---------------------------------------------------------------------------
// Output formatting (node-REPL feel)
// ---------------------------------------------------------------------------

function formatResult(
  r: EvalResult,
  c: ReturnType<typeof makeColors>,
): string | undefined {
  if (!r.ok) {
    const name = r.error?.name || "Error";
    const msg = r.error?.message || "";
    let out = c.red(`${name}: ${msg}`);
    if (r.error?.stack) {
      const stack = r.error.stack.split("\n").slice(1).join("\n");
      if (stack.trim()) out += "\n" + c.dim(stack);
    }
    return out;
  }
  const vt = r.valueType;
  if (vt === "undefined") return c.dim("undefined");
  if (vt === "null") return c.dim("null");
  if (vt === "number" || vt === "bigint") return c.yellow(String(r.valuePreview ?? r.value));
  if (vt === "boolean") return c.yellow(String(r.valuePreview ?? r.value));
  if (vt === "string") {
    const s = typeof r.value === "string" ? r.value : String(r.valuePreview ?? "");
    return c.green(JSON.stringify(s));
  }
  if (vt === "error") {
    return c.red(String(r.valuePreview ?? r.value));
  }
  // object / array / function / symbol → use the kernel preview verbatim.
  const preview = r.valuePreview ?? (r.value !== undefined ? JSON.stringify(r.value) : undefined);
  if (preview === undefined) return c.dim("undefined");
  return String(preview);
}

// ---------------------------------------------------------------------------
// Spinner (slow-cell feedback, TTY only)
// ---------------------------------------------------------------------------

class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private i = 0;
  constructor(
    private out: NodeJS.WriteStream,
    private dim: Colorizer,
    private enabled: boolean,
  ) {}
  start(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      const f = this.frames[this.i++ % this.frames.length];
      this.out.write("\r" + this.dim(`${f} …`));
    }, 90);
    if (this.timer.unref) this.timer.unref();
  }
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) this.out.write("\r\x1b[K");
  }
}

// ---------------------------------------------------------------------------
// The interactive REPL
// ---------------------------------------------------------------------------

const DOT_COMMANDS = [
  ".help",
  ".caps",
  ".exit",
  ".clear",
  ".reset",
  ".editor",
  ".load",
  ".save",
  ".session",
  ".gen",
];

export interface ReplDeps {
  session: EngramSession;
  endpoint: string;
  sessionId: string;
  config: EngramConfig;
  WebSocketImpl: unknown;
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  const { session, endpoint, sessionId } = deps;
  const stdout = process.stdout;
  const useColor = !!stdout.isTTY && !process.env.NO_COLOR;
  const c = makeColors(useColor);

  let status: { generation?: number; inMemory?: boolean };
  try {
    status = await session.status();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(c.red("cannot reach the kernel") + c.dim(` — ${msg}`));
    console.error(c.dim(`  endpoint ${endpoint}`));
    session.close();
    return;
  }

  // Banner — one tight block. host short, session + generation/state on one line.
  const host = endpoint.replace(/^wss?:\/\//, "").replace(/\/.*$/, "");
  console.log(c.bold("Engram") + c.dim(` · durable kernel · ${host}`));
  console.log(
    c.dim(`session ${sessionId} · gen ${status.generation ?? "?"} · ${status.inMemory ? "warm" : "cold"} · .help`),
  );

  let history = loadHistory();

  // The interface is rebuildable: a Ctrl-D in editor mode (which readline treats
  // as EOF/close) tears down and recreates a fresh interface so the session keeps
  // going. `wantExit` distinguishes a real exit from an editor-submit close.
  let rl!: readline.Interface;
  let wantExit = false;
  let editorSubmitPending: string | null = null;

  let buffer = "";
  let editorMode = false;
  let sigintOnEmpty = false;

  const makeRl = (): readline.Interface =>
    readline.createInterface({
      input: process.stdin,
      output: stdout,
      prompt: c.cyan("engram> "),
      history: history.slice(),
      historySize: HISTORY_CAP,
      completer: (line: string): [string[], string] => {
        if (line.startsWith(".")) {
          const hits = DOT_COMMANDS.filter((d) => d.startsWith(line));
          return [hits.length ? hits : DOT_COMMANDS, line];
        }
        return [[], line];
      },
    });
  rl = makeRl();

  // Continuation prompt is right-aligned to the primary prompt's width so a
  // multi-line cell reads straight down the same column (node-style).
  //   "engram> " is 8 cols → continuation pads "..." to the same 8 cols so the
  //   first typed char of every line lands in the same column.
  const PRIMARY = c.cyan("engram> ");
  const CONTINUE = c.dim("    ... ");

  const setPrompt = (): void => {
    rl.setPrompt(buffer || editorMode ? CONTINUE : PRIMARY);
  };

  const freshPrompt = (): void => {
    buffer = "";
    editorMode = false;
    setPrompt();
    rl.prompt();
  };

  // Emit a value (or undefined for no-value cells) followed by an unobtrusive
  // dim latency tag. For a single visible line we suffix the tag inline so it
  // never steals a row or collides with the next prompt; multi-line values get
  // the tag on its own trailing dim line.
  const printValueAndLatency = (formatted: string | undefined, ms: number): void => {
    const tag = c.dim(` · ${ms}ms`);
    if (formatted === undefined) {
      console.log(c.dim(`${ms}ms`));
      return;
    }
    if (formatted.includes("\n")) {
      console.log(formatted);
      console.log(c.dim(`· ${ms}ms`));
    } else {
      console.log(formatted + tag);
    }
  };

  const evalCell = async (src: string): Promise<void> => {
    appendHistory(src);
    const spinner = new Spinner(stdout, c.dim, useColor);
    spinner.start();
    const t0 = Date.now();
    let r: EvalResult;
    try {
      r = await session.eval(src, { throwOnError: false });
    } catch (e) {
      spinner.stop();
      const msg = e instanceof Error ? e.message : String(e);
      console.log(c.red(`transport error: ${msg}`));
      return;
    }
    const ms = Date.now() - t0;
    spinner.stop();
    // console lines first (dim-prefixed), node-style above the value.
    for (const l of r.console || []) {
      const prefix = c.dim(`${l.level}: `);
      console.log(prefix + l.text);
    }
    const formatted = formatResult(r, c);
    printValueAndLatency(formatted, ms);
  };

  // ---- dot-command handling ----
  const handleDot = async (line: string): Promise<boolean> => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case ".help":
        if (arg === "caps" || arg === "env" || arg === "modules") {
          // Surface the in-VM capability manifest. Prefer the formatted help() string; fall back to
          // a JSON dump of __nodeCompat so it still works against an older kernel.
          const probe =
            "(typeof help==='function') ? help() : JSON.stringify(globalThis.__nodeCompat ? " +
            "{builtins:__nodeCompat.capabilities.available, excluded:__nodeCompat.excluded, " +
            "modules:__nodeCompat.modules, network:__nodeCompat.network, esm:__nodeCompat.esm, " +
            "examples:__nodeCompat.examples} : 'no manifest', null, 2)";
          const r = await session.eval(probe, { throwOnError: false }).catch(() => null);
          if (r && r.ok) {
            const s = typeof r.value === "string" ? r.value : (r.valuePreview ?? "");
            console.log(String(s));
          } else {
            console.log(c.red("could not read capabilities from the kernel"));
          }
          return true;
        }
        console.log(
          [
            c.dim(".help") + "            show this help",
            c.dim(".help caps") + "       VM capabilities: builtins, stdlib modules, network, esm, examples",
            c.dim(".caps") + "            alias for .help caps",
            c.dim(".exit") + "            close session and exit",
            c.dim(".clear") + "           clear the screen",
            c.dim(".reset") + "           reset the REMOTE session (drops namespace)",
            c.dim(".editor") + "          multi-line editor (Ctrl-D submit, Ctrl-C cancel)",
            c.dim(".load <file>") + "     eval a local file as one cell",
            c.dim(".save <file>") + "     write REPL history to a file",
            c.dim(".session") + "         print session id / endpoint / generation / inMemory",
            c.dim(".gen") + "             print generation + inMemory",
          ].join("\n"),
        );
        return true;
      case ".caps":
        return handleDot(".help caps");
      case ".exit":
        wantExit = true;
        rl.close();
        return true;
      case ".clear":
        if (useColor) stdout.write("\x1b[2J\x1b[H");
        return true;
      case ".reset": {
        const answer = await ask(rl, c.dim("reset the remote session? (y/N) "));
        if (/^y(es)?$/i.test(answer.trim())) {
          await session.reset().catch((e) => console.log(c.red(`reset failed: ${e}`)));
          console.log(c.dim("session reset."));
        } else {
          console.log(c.dim("cancelled."));
        }
        return true;
      }
      case ".editor":
        editorMode = true;
        buffer = "";
        console.log(c.dim("// entering editor mode (Ctrl-D to submit, Ctrl-C to cancel)"));
        return true;
      case ".load": {
        if (!arg) {
          console.log(c.red(".load needs a file path"));
          return true;
        }
        try {
          const code = fs.readFileSync(arg, "utf8");
          await evalCell(code);
        } catch (e) {
          console.log(c.red(`.load failed: ${e instanceof Error ? e.message : String(e)}`));
        }
        return true;
      }
      case ".save": {
        if (!arg) {
          console.log(c.red(".save needs a file path"));
          return true;
        }
        try {
          fs.writeFileSync(arg, ((rl as unknown as { history: string[] }).history || []).slice().reverse().join("\n") + "\n");
          console.log(c.dim(`history saved to ${arg}`));
        } catch (e) {
          console.log(c.red(`.save failed: ${e instanceof Error ? e.message : String(e)}`));
        }
        return true;
      }
      case ".session": {
        const s = await session.status().catch(() => ({}) as { generation?: number; inMemory?: boolean });
        console.log(
          c.dim(
            `id=${sessionId}  endpoint=${endpoint}  generation=${s.generation ?? "?"}  inMemory=${s.inMemory ?? "?"}`,
          ),
        );
        return true;
      }
      case ".gen": {
        const s = await session.status().catch(() => ({}) as { generation?: number; inMemory?: boolean });
        console.log(c.dim(`generation=${s.generation ?? "?"}  inMemory=${s.inMemory ?? "?"}`));
        return true;
      }
      default:
        console.log(c.red(`unknown command: ${cmd}  (try .help)`));
        return true;
    }
  };

  const snapshotHistory = (): void => {
    try {
      history = ((rl as unknown as { history: string[] }).history || []).slice();
    } catch {
      /* ignore */
    }
  };

  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  const wire = (): void => {
    rl.on("line", (line: string) => {
      // Defer async work; pause input so we don't interleave prompts.
      void (async () => {
        sigintOnEmpty = false;

        // editor mode: accumulate until Ctrl-D (close) — every line is buffered.
        if (editorMode) {
          buffer += line + "\n";
          setPrompt();
          rl.prompt();
          return;
        }

        // Dot-commands only apply at the start of a cell (empty buffer).
        if (buffer === "" && line.trim().startsWith(".")) {
          rl.pause();
          await handleDot(line);
          rl.resume();
          if (!wantExit) freshPrompt();
          return;
        }

        const candidate = buffer ? buffer + "\n" + line : line;
        if (candidate.trim() === "") {
          rl.prompt();
          return;
        }

        if (scanBalance(candidate).complete) {
          rl.pause();
          await evalCell(candidate);
          rl.resume();
          freshPrompt();
        } else {
          buffer = candidate;
          setPrompt();
          rl.prompt();
        }
      })();
    });

    rl.on("SIGINT", () => {
      if (editorMode) {
        editorMode = false;
        buffer = "";
        console.log(c.dim("\n// editor cancelled"));
        freshPrompt();
        return;
      }
      if (buffer) {
        buffer = "";
        stdout.write("\n");
        freshPrompt();
        return;
      }
      if (sigintOnEmpty) {
        wantExit = true;
        rl.close();
        return;
      }
      sigintOnEmpty = true;
      stdout.write("\n" + c.dim("(To exit, press Ctrl+C again or Ctrl+D or type .exit)") + "\n");
      rl.prompt();
    });

    rl.on("close", () => {
      snapshotHistory();
      // A Ctrl-D in editor mode shows up as readline EOF/close. Treat it as an
      // editor submit: capture the buffer, rebuild the interface, keep going.
      if (editorMode && !wantExit) {
        editorSubmitPending = buffer;
        editorMode = false;
        buffer = "";
        rl = makeRl();
        wire();
        const src = editorSubmitPending;
        editorSubmitPending = null;
        stdout.write("\n");
        if (src && src.trim()) {
          rl.pause();
          void evalCell(src).then(() => {
            rl.resume();
            freshPrompt();
          });
        } else {
          freshPrompt();
        }
        return;
      }
      // Real exit (Ctrl-D at top level, .exit, or double Ctrl-C).
      gracefulExit();
    });
  };

  // Single graceful-exit path, idempotent (rl 'close', .exit, and the process
  // SIGINT backstop all funnel here). Prints the resume command so the durable
  // session can be picked up later — its live namespace survives on the kernel.
  // Backstop: in some pty/pane setups readline does not deliver its 'SIGINT'
  // event reliably (e.g. while paused mid-eval), so a process-level handler
  // guarantees double-Ctrl-C always exits. First press latches + hints; second
  // consecutive press exits. Any submitted line clears the latch (in the 'line'
  // handler via sigintOnEmpty=false).
  const sigintHandler = (): void => {
    if (editorMode || buffer) return; // rl's own handler covers cancel/clear
    if (sigintOnEmpty) {
      wantExit = true;
      gracefulExit();
      return;
    }
    sigintOnEmpty = true;
    stdout.write("\n" + c.dim("(To exit, press Ctrl+C again or Ctrl+D or type .exit)") + "\n");
    rl.prompt();
  };
  process.on("SIGINT", sigintHandler);

  let exited = false;
  const gracefulExit = (): void => {
    if (exited) return;
    exited = true;
    try {
      saveHistory(history.slice());
    } catch {
      /* ignore */
    }
    const DEFAULT_ENDPOINT = "wss://engram.umgbhalla.xyz";
    const epFlag = endpoint === DEFAULT_ENDPOINT ? "" : ` --endpoint ${endpoint}`;
    console.log(c.dim("\nbye. session is durable — resume with:"));
    console.log(c.cyan(`  engram repl --session ${sessionId}${epFlag}`));
    process.removeListener("SIGINT", sigintHandler);
    session.close();
    resolveDone();
    process.exit(0);
  };

  wire();
  setPrompt();
  rl.prompt();
  await done;
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

// ---------------------------------------------------------------------------
// Connect helper shared with the launcher.
// ---------------------------------------------------------------------------

export async function openSession(opts: {
  endpoint: string;
  sessionId: string;
  config: EngramConfig;
  WebSocketImpl: unknown;
}): Promise<EngramSession> {
  return connect({
    url: opts.endpoint,
    session: opts.sessionId,
    config: opts.config,
    throwOnError: false,
    WebSocket: opts.WebSocketImpl,
  });
}
