# Engram CLI REPL

> Headline: **yes — the CLI now feels like a Node.js REPL while being fully remote.** Every
> line you type evaluates on the **live, hibernating `engram-kernel` Durable Object** over a
> WebSocket; the namespace (vars, closures, pending promises) is the kernel's WASM heap, which
> survives across sessions and across DO evictions. You get multi-line continuation, history,
> colors, dot-commands, latency hints and a slow-cell spinner — but `x` lives in Cloudflare, not
> in your shell.

The REPL lives in `packages/cli/src/repl.ts` (the interactive client) and is wired into the
`engram` launcher in `packages/cli/src/engram.ts`. It talks to the kernel through `@engram/sdk`
(`connect()` → `session.eval/reset/status/close`).

## How to run

```sh
# Bare command on a TTY launches the REPL (resumes a stable per-terminal session):
engram

# Explicit form, with an override session + endpoint:
engram repl --session my-notebook --endpoint wss://engram-kernel.umg-bhalla88.workers.dev

# Options (all optional):
#   --endpoint <wss>   default wss://engram-kernel.umg-bhalla88.workers.dev (or $ENGRAM_ENDPOINT)
#   --session <id>     resume an explicit named session (override the per-tty default)
#   --config <file>    JSON EngramConfig passed to connect() (e.g. {"typescript":true})
#   --exec '<cell>'    run ONE cell non-interactively and exit (smoke/scripting)
#   --interactive      force the interactive REPL even when stdin is not a TTY
```

Bare `engram` (or `engram` with only flags) on a TTY routes straight into `cmdRepl`, so the
common case is just typing `engram`. The `sessions` and `trace` subcommands are unchanged.

### Sessions are durable and addressable

- **Stable per-terminal id.** With no `--session`, the CLI derives a deterministic id
  `repl-<sha1(host:user:term/ppid)>` (`stableTtyId()`), so relaunching `engram` in the *same
  terminal* reattaches to the *same hibernated heap* — your `x` is still there.
- **Named sessions.** `--session my-notebook` pins an explicit id you can resume from anywhere
  (any machine, any terminal). State survives idle eviction and cold restore on the kernel side;
  the REPL just reconnects.
- Recently-used sessions are recorded in `~/.engram-sessions.json` for `engram sessions list`.

### Pipe mode (non-TTY)

Piping into `engram repl` (no TTY, no `--interactive`) treats stdin as a script: lines are
**buffered until lexically complete**, then each whole cell is sent as one `eval`. So a
multi-line object literal piped in submits as a single cell, not line-by-line. `--exec` is the
one-cell variant.

## The Node-REPL features

### Multi-line continuation (`... ` prompt)

The REPL does **not** parse JS/TS. It uses a single char-by-char **lexical completeness scanner**
(`scanBalance` / exported `isComplete`) that tracks `() {} []` depth, single/double-quoted strings
(with escapes), template literals + nested `${ }`, line/block comments, and regex-vs-division
disambiguation (by the previous significant char). A cell is **complete** when every bracket
closes, no string/template/comment is open, **and** the trimmed tail does not dangle on a
trailing operator (`=>`, binary/logical/assignment `&& || ?? + - * / % = ...`, comma, dot/`?.`,
or an open ternary `? :`). `++`/`--` are treated as postfix (complete).

Until a cell is complete the prompt switches from `engram> ` to a column-aligned `    ... ` and
keeps buffering, so pasting or typing a function body, a multi-line object, or a template literal
just works:

```
engram> const o = {
    ...   a: 1,
    ...   b: 2,
    ... }
{ a: 1, b: 2 } · 41ms
```

### TypeScript cells

Because the scanner only counts brackets/operators, it **tolerates TypeScript**: generics
(`<T>`), type annotations (`: Type`), and signatures like `function id<T>(v: T): T { ... }` buffer
and submit correctly. The CLI sends the source **as-is** (it never transpiles) and passes your
`--config` (including `typescript`) through to the kernel. The banner reflects TS intent.

> Caveat: TS *stripping* is a kernel-side concern. If the currently deployed `engram-kernel` is a
> bare QuickJS VM that doesn't strip types, TS-annotated cells return a `SyntaxError` from the
> remote VM. The CLI is correct per spec; whether `const q: number = 7` evaluates depends on the
> live kernel having TS stripping enabled.

### History

Persisted to `~/.engram_repl_history` (oldest-first on disk, up to 1000 entries). Loaded on
start, recalled with up/down-arrow (re-evaluable), and saved on clean exit. `.save <file>` dumps
the current history.

### Colorized, Node-like output (no `=> ` noise)

Colors emit only when `stdout.isTTY && !NO_COLOR`. Values render in Node style:

- numbers/booleans/bigint → yellow; strings → green and JSON-quoted; `null`/`undefined` → dim.
- errors → red `name: message` with a dim stack below.
- objects/arrays/functions → the kernel's structured `valuePreview` verbatim.
- `console.*` output prints **above** the value, dim `level: ` prefixed (Node-style ordering).

### Latency hints + slow-cell spinner

Each result carries a dim, right-of-value round-trip tag (` · 41ms`) so you can feel the
remote-ness without it being noisy; multi-line values get the tag on its own dim trailing line.
While an `eval` is in flight a dim braille spinner runs and is cleared on result — feedback that
the cell is executing on the remote kernel.

### Dot-commands

| Command | Effect |
|---|---|
| `.help` | list commands |
| `.exit` | close the session and exit |
| `.clear` | clear the screen |
| `.reset` | reset the **remote** session (drops the namespace; confirms y/N) |
| `.editor` | multi-line editor; Ctrl-D submits the whole buffer, Ctrl-C cancels |
| `.load <file>` | read a local file and eval it as one cell on the kernel |
| `.save <file>` | write REPL history to a file |
| `.session` | print id / endpoint / generation / inMemory |
| `.gen` | print generation + inMemory (warm vs cold) |

Tab completes dot-command names. `.gen`/`.session` surface the kernel's `generation` and
`inMemory` flags so you can *see* the kernel sleep and wake (generation bumps on restore).

### Key handling (Node parity)

- **Ctrl-C**: cancels an in-progress multi-line/editor buffer; on an empty prompt the first press
  warns and a second press (or Ctrl-D, or `.exit`) exits.
- **Ctrl-D**: at top level exits cleanly (`bye.`); in `.editor` mode it submits the accumulated
  buffer. (Editor-submit is implemented by capturing the buffer in readline's `close` handler and
  rebuilding a fresh interface that carries history forward, so the session keeps going — a
  `wantExit` flag distinguishes a real exit from an editor submit.)

## Remote durable state — what "fully remote" means here

Every accepted cell is one `session.eval(src)` to the `engram-kernel` Durable Object. There is no
local JS engine: `x = 42` mutates the kernel's QuickJS WASM heap. That heap is snapshotted to the
DO's SQLite, so:

- the session **hibernates when idle** and **resumes with full live state** (vars, closures,
  pending promises) — no replay, side effects don't re-fire.
- it survives **DO eviction / cold restore**: reconnect (same stable tty id, or an explicit
  `--session`) and your namespace is still there; `.gen` shows the bumped generation / `cold`.
- the same named session can be resumed from a different terminal or machine.

So the REPL *feels* local — Node prompt, continuation, colors, history, instant-ish round-trips —
but it is a thin, reconnect-safe client over a durable, hibernating remote kernel.

## Build

```sh
bun run --filter @engram/cli build   # tsc --noEmit && esbuild → bin/engram.mjs
```

Both steps are clean: `tsc --noEmit` reports 0 errors; esbuild emits `bin/engram.mjs` (~20.7kb)
with exit 0. No dependencies were added (root and `packages/cli` `package.json` are unchanged).
