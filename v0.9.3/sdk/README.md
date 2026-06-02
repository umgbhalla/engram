# @engram/sdk

Configurable **codemode / RLM infrastructure** over the durable, hibernating Engram
QuickJS-WASM kernel on Cloudflare. Embeds Engram as a code-execution backend for Code Mode
and Recursive Language Models (RLM).

## Why Engram

- `eval` = a durable REPL cell; `execute(code, fns)` = the Cloudflare **Code Mode** contract.
- The `host.<name>()` boundary = Code Mode's `fns` / rlms' marshaled sub-calls.
- A genuinely **huge context lives HOST-SIDE** behind `host.ctx.*` handle tools — it never enters
  the 18 MB QuickJS snapshot envelope; only the slices the model pulls cross into the VM.
- **Durable hibernation between cells/turns** is the differentiator no other RLM backend has:
  the context handle + namespace survive evict/cold-restore at ~0 idle cost.
- **v0.9.1:** the host-side context store is **chunked across DO SQLite rows** (~64 KB each + a
  manifest count), so a **multi-MB context now survives cold restore** (v0.9 lost contexts
  > ~1 MB to `SQLITE_TOOBIG`). The recorded RLM `final` is also persisted, so `trajectory()`
  shows the answer after a reconnect. Single-slice cap raised 256 KB → **1 MB**.
- **v0.9.2:** two additions.
  - **Lambda-RLM typed combinators** — `session.lambdaRLM(query, {ctx, split, reduce, maxDepth,
    costBudget})` runs the lambda-*calculus* RLM (typed `SPLIT`/`MAP`/`REDUCE` + a bounded
    recursion driver) instead of free-form RLM code. Recursion is bounded by `maxDepth` and total
    leaf-oracle (`host.subLM`) calls are hard-capped at `costBudget`, so it **provably terminates**
    and an over-decomposing query is bounded, not blown up. The combinators also live in-VM as
    `globalThis.lambda.{SPLIT,MAP,REDUCE,lambdaRLM}` (default stdlib module `lambda`).
  - **Agent code-mode adapter** — `createAgent({endpoint, id, config, tools})` gives an AI agent a
    **durable per-agent session**: `agent.turn(code) -> {result, logs, toolCalls}`; registered tools
    are the agent's `host.<name>` surface (mapped to `host_call`); multi-turn state lives in the
    snapshot and **hibernates between turns** (`agent.hibernate()`), restoring on the next turn.

## Install

```
npm i @engram/sdk ws
```

## Quick start

```js
import { connect, EngramExecutor } from "@engram/sdk";
import WebSocket from "ws"; // Node; browsers use the native WebSocket

const s = await connect({
  endpoint: "wss://engram-kernel.<acct>.workers.dev",
  id: "my-session",
  config: { clock: "seeded", modules: true, fetch: ["api.example.com"] },
  WebSocket,
});

// 1. REPL / rlms executor
await s.eval("globalThis.x = 41; x + 1");        // -> { ok, value, valuePreview, logs, error? }

// 2. Code Mode drop-in
const ex = new EngramExecutor({ endpoint, id, config, WebSocket });
const { result, logs } = await ex.execute(
  "(() => { const n = host.adder(40, 2); return { n }; })()",
  { adder: (a, b) => a + b },                    // fns injected as host.<name>
);

// 3. Context-as-variable — stored HOST-SIDE, read via host.ctx.* in the sandbox
await s.setContext("context", bigBlob);          // chunked into DO SQLite (survives hibernation)
//   In-sandbox: host.ctx.{ len(), slice(a,b), grep(re,opts), chunk(size), get(i,size), names() }

// 4. The leaf-oracle / sub-LM boundary — the CLIENT supplies the model backend
s.onSubLM(async ({ prompt, opts }) => myModel.complete(prompt, opts));

// 5. Depth-1 RLM loop, end-to-end
const r = await s.rlm("summarize the doc", { contextName: "context" });
//   -> { answer, kind: "FINAL"|"FINAL_VAR"|"EXHAUSTED", steps, subLMCalls, history }

// 6. Lifecycle / durability
await s.hibernate();                              // force-evict; ~0 idle cost
await s.resume();                                 // wake-with-state, no replay
const { cells, final } = await s.trajectory();    // recorded cells + sub-calls + final answer
```

## In-sandbox host tools (the `host.<name>()` boundary)

| Tool | Purpose |
|---|---|
| `host.ctx.len([name])` | length of the host-side context (chars) |
| `host.ctx.slice(a,b,[name])` | substring (capped at 1 MB / call) |
| `host.ctx.grep(re,[opts],[name])` | `[{i, match, line}]`; opts `{flags, max}` |
| `host.ctx.chunk(size,[name])` | `[{i,start,end,len}]` chunk **descriptors** (not bytes) |
| `host.ctx.get(i,size,[name])` | the i-th `size`-char chunk's text |
| `host.ctx.names()` | stored context names |
| `host.subLM(prompt,opts)` | async sub-LM call → the client's model backend |
| `host.final(value)` / `host.finalVar(name)` | record the RLM answer |
| `host.kv.*`, `host.fetch`, `host.echo/add/now` | v0.8 host tools (unchanged) |

## Sub-LM orchestration (honest)

`rlm()` is **SDK-orchestrated**: the kernel is remote, so it never calls back to your machine.
The SDK installs a cooperative `host.subLM` shim that **queues** prompts; the SDK drains the queue
through your `onSubLM` model backend client-side, feeds the completions back into the VM, and
re-runs the cell until `host.final` fires. Deterministic prompt order is required (the RLM
scaffold computes prompts from the context handle + prior answers, which is deterministic).

For a **co-located** embedding (SDK and kernel in the same trust boundary, with a publicly
reachable `config.subLMEndpoint`), `host.subLM` also works as a direct async `fetch` to that
endpoint — the SDK stands up a local bridge automatically when you call `execute`/`rlm` with a
reachable endpoint.

## Adapters

- `EngramExecutor` — Cloudflare Code Mode executor: `execute(code, fns) -> {result, error?, logs}`.
  Usable with `createCodeTool({ executor: new EngramExecutor(...) })`.
- `EngramEnv` — rlms-style environment adapter: `run(code)`, `setContextVar(name, value)`,
  `installDeps(modules)`.

## Caveats

- JS, not Python — not drop-in for the existing rlms / RLM-Qwen3-8B Python corpus.
- Hibernation is **between cells/turns**, not mid-flight during a sub-LM call.
- An async-IIFE whose completion value is an object previews as `{}` (a kernel unwrap limitation);
  prefer a synchronous return or `host.final` for rich results.
- Single oversized boundary copies are capped (`host.ctx.slice` 1 MB) to avoid a recoverable
  WS-1006 from one huge native allocation. The host-side store itself is unbounded by this cap.
