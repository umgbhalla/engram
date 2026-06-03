---
title: CLI REPL
description: The engram CLI — a Node-like REPL whose namespace lives in a hibernating Durable Object on the edge.
---

The `engram` CLI gives you a REPL that **feels** local — Node prompt, multi-line continuation,
history, colors — but every line evaluates on the live, hibernating `engram-kernel` Durable
Object over a WebSocket. Your `x` lives in Cloudflare, not in your shell. The namespace (vars,
closures, pending promises) is the kernel's WASM heap, which survives across sessions and across
DO evictions.

It lives in `packages/cli` and talks to the kernel through [`@engram/sdk`](/using/sdk/).

## Run it

```sh
# Bare command on a TTY launches the REPL (resumes a stable per-terminal session):
engram

# Explicit form, with an override session + endpoint:
engram repl --session my-notebook --endpoint wss://engram-kernel.umg-bhalla88.workers.dev
```

Options (all optional):

| Flag | Meaning |
|---|---|
| `--endpoint <wss>` | default `wss://engram-kernel…` (or `$ENGRAM_ENDPOINT`) |
| `--session <id>` | resume an explicit named session |
| `--config <file>` | JSON `EngramConfig` passed to `connect()` (e.g. `{"typescript":true}`) |
| `--exec '<cell>'` | run ONE cell non-interactively and exit |
| `--interactive` | force the REPL even when stdin is not a TTY |

## Durable, addressable sessions

- **Stable per-terminal id.** With no `--session`, the CLI derives a deterministic id
  `repl-<sha1(host:user:term/ppid)>`, so relaunching `engram` in the *same terminal* reattaches to
  the *same hibernated heap* — your `x` is still there.
- **Named sessions.** `--session my-notebook` pins an explicit id you can resume from any machine.
  State survives idle eviction and cold restore on the kernel side; the REPL just reconnects.
- Recently-used sessions are recorded in `~/.engram-sessions.json` for `engram sessions list`.

## Node-REPL features

- **Multi-line continuation.** A char-by-char lexical-completeness scanner tracks brackets,
  strings, template literals, comments, and trailing operators. A cell submits only when it is
  lexically complete — so pasting a function body or a multi-line object literal just works. The
  prompt switches from `engram>` to a column-aligned `...` while buffering.
- **TypeScript-tolerant.** The scanner only counts brackets and operators, so generics, type
  annotations, and typed signatures buffer and submit correctly. The CLI sends the source as-is —
  it never transpiles. See [TypeScript cells](/using/typescript/).
- **History.** Persisted to `~/.engram_repl_history` (up to 1000 entries), recalled with the
  arrow keys.
- **Node-like output.** Values render Node-style (numbers/booleans yellow, strings green, errors
  red with a dim stack); `console.*` prints above the value; each result carries a dim round-trip
  latency tag (` · 41ms`) and a braille spinner runs while a cell is in flight.

```
engram> const o = {
    ...   a: 1,
    ...   b: 2,
    ... }
{ a: 1, b: 2 } · 41ms
```

### Dot-commands

| Command | Effect |
|---|---|
| `.help` | list commands |
| `.exit` | close the session and exit |
| `.reset` | reset the **remote** session (drops the namespace; confirms y/N) |
| `.editor` | multi-line editor; Ctrl-D submits the buffer, Ctrl-C cancels |
| `.load <file>` | read a local file and eval it as one cell |
| `.save <file>` | write REPL history to a file |
| `.session` / `.gen` | print id / endpoint / generation / `inMemory` (warm vs cold) |

`.gen` and `.session` surface the kernel's `generation` and `inMemory` flags, so you can *watch*
the kernel sleep and wake — the generation bumps on restore.

## What "fully remote" means

Every accepted cell is one `session.eval(src)` to the Durable Object. There is no local JS engine:
`x = 42` mutates the kernel's QuickJS WASM heap. That heap is snapshotted to the DO's SQLite, so
the session **hibernates when idle and resumes with full live state** — no replay, side effects
don't re-fire — and survives **DO eviction / cold restore**. Reconnect with the same id and your
namespace is still there.

## Build

```sh
bun run --filter @engram/cli build   # tsc --noEmit && esbuild → bin/engram.mjs
```
