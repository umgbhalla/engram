# montydyn CLI

Launch a **configurable durable REPL** and run an **end-to-end depth-1 RLM loop** against the
montydyn codemode kernel.

```
npm i -g @montydyn/cli            # or: node cli/montydyn.mjs <cmd>
```

Endpoint defaults to `$MONTYDYN_ENDPOINT` or `wss://montydyn-v09.<acct>.workers.dev`
(override with `--endpoint`).

## Commands

### `montydyn repl`

Interactive durable REPL. Resumes the hibernated namespace if `--session <id>` exists, else
creates it.

```
montydyn repl [--session <id>] [--config <file>] [--tools <file>] [--context-file <path>]
              [--endpoint <wss>] [--exec '<one cell>'] [--interactive]
```

- `--config <file>` — JSON session config (`clock`, `rngSeed`, `cellBudgetTicks`,
  `fetch` allowlist, `modules` stdlib preset).
- `--tools <file>` — an ESM module exporting `{ name: handler }` host tools (registered client-side).
- `--context-file <path>` — load a big blob **host-side** as a `host.ctx.*` peek/grep handle
  (NOT into the VM heap).
- `--exec '<src>'` — run one cell and exit (smoke-friendly).
- Pipe mode: with no TTY, each stdin line is evaluated as a cell. Interactive otherwise
  (`.reset`, `.exit`).

```
# one-shot
montydyn repl --session demo --exec 'globalThis.x = 41; x + 1'      # => 42
# context handle + piped cells
printf 'host.ctx.len("context")\nhost.ctx.grep("TODO",{max:5}).length\n' \
  | montydyn repl --session ctx --context-file ./big.txt
```

### `montydyn rlm <query> --context <file>`

End-to-end canonical depth-1 RLM loop: binds the context as a host-side handle, drives the root
model (which writes JS cells that grep/chunk the context + fan `host.subLM` over chunks), runs the
cells, fulfills sub-LM calls through a **pluggable, client-side model backend**, and returns on
`host.final`.

```
montydyn rlm <query> --context <file> [--model <stub|cmd:...>] [--depth 1] [--session <id>]
```

- `--model stub` (default) — deterministic fake LM, no API key (summarizes each chunk + reduces).
- `--model cmd:<command>` — shells out per sub-LM call; the prompt is piped on stdin, stdout is the
  completion. e.g. `--model 'cmd:llm -m gpt-4o-mini'`.
- Wire a real provider by importing `@montydyn/sdk` and passing your own `onSubLM` handler.

```
montydyn rlm "what is the answer" --context ./doc.txt --model stub
```

### `montydyn sessions [list|inspect <id>|rm <id>]`

Durable session lifecycle. `list` shows sessions this CLI has touched (recorded in
`~/.montydyn-sessions.json`); `inspect` prints live `gen` state; `rm` resets the durable snapshot
and forgets the session.

### `montydyn trace <id>`

Dump the session's generation / committed-cell state and the last recorded RLM final answer.

## Notes

- The model backend lives **client-side** (the SDK orchestrates sub-LM calls across cells against
  the remote kernel — the kernel never calls back to your machine).
- Each session is a **durable** montydyn DO: Ctrl-C / idle resumes the namespace (and the context
  handle) between cells with full live state, no replay.
