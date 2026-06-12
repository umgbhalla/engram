# engram CLI

Launch a **configurable durable REPL** and run an **end-to-end depth-1 RLM loop** against the
Engram codemode kernel.

```
npm i -g @engram/cli            # or: node cli/engram.mjs <cmd>
```

Endpoint defaults to `$ENGRAM_ENDPOINT` or `wss://engram-kernel.<acct>.workers.dev`
(override with `--endpoint`).

## Commands

### `engram repl`

Interactive durable REPL. Resumes the hibernated namespace if `--session <id>` exists, else
creates it.

```
engram repl [--session <id>] [--config <file>] [--tools <file>] [--context-file <path>]
              [--endpoint <wss>] [--exec '<one cell>'] [--interactive]
              [--keepalive-ms <ms>]
```

- `--config <file>` — JSON session config (`clock`, `rngSeed`, `cellBudgetTicks`,
  `fetch` allowlist, `modules` stdlib preset).
- `--tools <file>` — an ESM module exporting `{ name: handler }` host tools (registered client-side).
- `--context-file <path>` — load a big blob **host-side** as a `host.ctx.*` peek/grep handle
  (NOT into the VM heap).
- `--exec '<src>'` — run one cell and exit (smoke-friendly).
- `--keepalive-ms <ms>` — after each user cell, keep the kernel warm for this idle window before
  allowing hibernation. Defaults to `900000` (15 minutes); `ENGRAM_REPL_KEEPALIVE_MS=0` disables it.
  With the default warm window, the CLI uses `durability: "warmBuffered"`: evals return from the
  live heap and the checkpoint flushes on idle/close/explicit flush. Set `durability:
  "eagerDurable"` in `--config` for checkpoint-before-reply semantics.
- Pipe mode: with no TTY, each stdin line is evaluated as a cell. Interactive otherwise
  (`.reset`, `.exit`).

```
# one-shot
engram repl --session demo --exec 'globalThis.x = 41; x + 1'      # => 42
# context handle + piped cells
printf 'host.ctx.len("context")\nhost.ctx.grep("TODO",{max:5}).length\n' \
  | engram repl --session ctx --context-file ./big.txt
```

Rich MIME outputs are saved locally by the terminal client. By default files go to
`./engram-artifacts`; set `ENGRAM_MIME_DIR=/path/to/dir` to choose another directory.
Set `ENGRAM_INLINE_IMAGES=1` in iTerm2 to also emit iTerm inline-image escape sequences.

Real image download example:

```sh
engram repl --session image-demo --exec '
const res = await fetch("https://placehold.co/120x60/png?text=Engram");
if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
const mime = (res.headers.get("content-type") || "image/png").split(";")[0];
const bytes = new Uint8Array(await res.arrayBuffer());
if (bytes.length === 0) throw new Error("downloaded image was empty");
displayImage(Buffer.from(bytes).toString("base64"), mime, { alt: "downloaded image" });
`downloaded ${bytes.length} bytes as ${mime}`;
'
```

The CLI prints a line like:

```text
[image/png] saved 1100 bytes -> ./engram-artifacts/image-demo-cell0-out0.png
```

### `engram rlm <query> --context <file>`

End-to-end canonical depth-1 RLM loop: binds the context as a host-side handle, drives the root
model (which writes JS cells that grep/chunk the context + fan `host.subLM` over chunks), runs the
cells, fulfills sub-LM calls through a **pluggable, client-side model backend**, and returns on
`host.final`.

```
engram rlm <query> --context <file> [--model <stub|cmd:...>] [--depth 1] [--session <id>]
```

- `--model stub` (default) — deterministic fake LM, no API key (summarizes each chunk + reduces).
- `--model cmd:<command>` — shells out per sub-LM call; the prompt is piped on stdin, stdout is the
  completion. e.g. `--model 'cmd:llm -m gpt-4o-mini'`.
- Wire a real provider by importing `@engram/sdk` and passing your own `onSubLM` handler.

```
engram rlm "what is the answer" --context ./doc.txt --model stub
```

### `engram sessions [list|inspect <id>|rm <id>]`

Durable session lifecycle. `list` shows sessions this CLI has touched (recorded in
`~/.engram-sessions.json`); `inspect` prints live `gen` state; `rm` resets the durable snapshot
and forgets the session.

### `engram trace <id>`

Dump the session's generation / committed-cell state and the last recorded RLM final answer.

## Notes

- The model backend lives **client-side** (the SDK orchestrates sub-LM calls across cells against
  the remote kernel — the kernel never calls back to your machine).
- Each session is a **durable** Engram DO: Ctrl-C / idle resumes the namespace (and the context
  handle) between cells with full live state, no replay.
