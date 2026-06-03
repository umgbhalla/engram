# Why Engram SDK

**A JavaScript REPL that sleeps when idle and wakes with its full live memory — variables,
closures, pending promises — exactly as you left them. No replay. No re-firing side effects.**

## The problem

You want a server-side code-execution sandbox that holds *live state* between calls: an agent's
working memory across turns, a notebook kernel across cells, an RLM's namespace across steps. The
moment you scale, you hit the wall:

- **V8 isolates can't hibernate a live heap** — there's no snapshot API. Idle = state lost.
- **Re-running ("replay") to rebuild state re-fires side effects** and gets slow and divergent.
- **Keeping every session warm forever is a memory bill** you don't want to pay.

So everyone serializes "logical state" by hand, loses closures and promises, and fights drift.

## The Engram bet

Compile the interpreter (QuickJS) to **WASM**, where all state lives in **linear memory — a plain
`ArrayBuffer` you can read, persist, and restore**. Host it on a Cloudflare **Durable Object**
(identity + SQLite + alarms + WebSocket hibernation).

- **Hibernate** = dump `memory.buffer` to the DO's SQLite (R2 for big images).
- **Resume** = new WASM instance, blit the bytes back, continue.

True live-state snapshot/restore. Not journaling. Not source replay. The heap *is* the engram.

## What you get

- **Durable, hibernating sessions.** Idle → ~0 cost. Cold wake → sub-second for in-envelope
  sessions, ~1.5s worst-case after a 20-min real eviction (platform-bound, state always survives).
- **A real REPL.** `eval` against a persisted namespace; globals/closures/promises carry over.
- **A hardened sandbox.** Infinite loops, alloc bombs (incl. the fast native-array growth that
  beat naive memory limits), blocked egress — all become **typed, recoverable errors**. The
  Durable Object is **never killed**; the socket stays alive; the next eval works.
- **Determinism on tap.** Seeded clock/RNG/crypto → byte-identical sessions across restore.
- **A clean host boundary.** Network, KV, and a genuinely-huge host-side context (`host.ctx.*`,
  kept *out* of the snapshot envelope) reached via `host.<name>()`.
- **Code Mode + RLM, batteries included.** `execute(code, fns)`, an SDK-orchestrated `rlm()`, a
  **provably-terminating** `lambdaRLM()`, and a durable **agent** adapter whose multi-turn memory
  hibernates between turns.
- **Multi-tenant when you need it.** Same SDK, point at `engram-cloud`: per-tenant API keys,
  metering, and per-session facet isolation.

## Who's done this whole thing? Nobody.

Pieces exist (WASM interpreters, DO storage, code sandboxes). The **durable hibernation of a live
interpreter heap between turns** — the thing that makes an agent's memory free and an RLM's
namespace persistent — is the part nobody shipped whole. That's the differentiator.

## 60 seconds to feel it

```ts
import { Engram } from "@engram/sdk";
const s = await Engram.connect({ url: "wss://engram-kernel…", session: "demo" });
await s.eval("globalThis.count = 0");
await s.eval("++count");          // 1
await s.hibernateThenResume();    // throw away the in-memory kernel, cold-restore from snapshot
await s.eval("++count");          // 2  — count SURVIVED a full eviction, no replay
```

That `2` is the whole pitch. Your state outlived the machine.

— honest caveats live in the README (object previews, 18MB envelope, hibernate-between-cells,
RLM/agent flows still landing on the v2 core). We don't hide them; we engineer around them.
