# Engram examples

Runnable examples built on top of the public surface (`@engram/sdk`, the kernel WS protocol).
These are **applications**, not kernel features — the kernel itself is a generic durable REPL
with a single host effect (`host.fetch`) plus a **generic VM→client host-callback bridge**.

| Example | What it shows |
|---|---|
| `agent-loop.mjs` | An RLM-style agent loop driven from a durable cell. The client registers `host.subLM` (a stand-in LLM); the cell runs a plain convergence loop calling it until a fixpoint. **No RLM logic lives in the kernel** — loop, stop condition, and state are all in the example. Swap `subLM` for a real model `fetch()` to make it a real agent. |

Run:

```bash
node examples/agent-loop.mjs
# or against your own kernel:
ENGRAM_ENDPOINT=wss://engram-kernel.<acct>.workers.dev node examples/agent-loop.mjs
```
