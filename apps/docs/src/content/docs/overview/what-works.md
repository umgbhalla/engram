---
title: What works today
description: The shipped capabilities of the Engram kernel and platform.
---

Engram is **product complete** as a durable, hibernating, multi-tenant codemode / RLM REPL
platform — kernel + auth/metering + lambda-RLM + agent mode + SDK + CLI + UI, scale-validated, known
holes closed.

## Core kernel

- **Stateful multi-cell REPL.** Heap persists across evals: closures, namespaces, arrays, `>1MB`
  host context all survive eviction and reload byte-for-byte (`restoreSource = sqlite-restore`).
- **Durable hibernation.** Proven across **real 20-minute full evictions, 7/7 cycles, zero state
  loss**. Deep cold-wake ~1.5s worst case — dominated by platform WS-connect / DO spin-up, **not**
  our restore (QuickJS init <300µs, gunzip + blit sub-ms).
- **Determinism.** Seeded clock (epoch + 1ms tick) and seeded RNG (mulberry32) externalized at the
  host boundary → byte-identical snapshots across restore. Entropy counters persisted.
- **Engine-migration journal.** On QuickJS engine-hash mismatch, replays per-cell sources instead of
  bricking (best-effort; faithful for pure cells, effectful cells flagged).

## Sandbox surface

- **stdlib + web extensions.** Pure-JS libs (lodash / dayjs / zod / ramda / uuid / …) esbuilt and
  evaled into the heap at create, snapshot-persisted. Tier-0 quickjs-wasi extensions live in the VM:
  `crypto.subtle` / `getRandomValues` / `randomUUID`, `TextEncoder` / `Decoder`, `URL` /
  `URLSearchParams`, `structuredClone`, `Headers`.
- **Network egress.** `host.fetch(url, init)` → DO-side `fetch()`, allowlist-enforced
  (`config.fetch`: `false` / `true` / `[hosts]`); eval is async so cells can `await`.
- **TypeScript cells.** Type syntax is erased host-side before eval; erasable TypeScript just works,
  non-erasable constructs (`enum`, `namespace`, parameter properties) are cleanly rejected. See
  [TypeScript cells](/using/typescript/).

## Hardening / isolation

- Native-C giant-alloc backstop turns OOM into a **catchable typed error before `memory.grow` can
  crash the DO**. Loop tick-budget preempts infinite loops, socket stays alive. Mid-cell heap
  tripwire. 18 MB snapshot-dump ceiling with clean typed rejection (no silent crash). See
  [Guards](/durability/guards/).

## Higher-level surfaces

- **Codemode / RLM.** Host-side context store (`host.ctx.*`, chunked, multi-MB), `host.subLM`,
  `host.final`, and bounded **lambda-RLM** combinators (SPLIT / MAP / REDUCE — terminating). Code
  Mode `execute()` drop-in. A depth-1 RLM loop resolved a 4.36 MB-context needle via host-side
  slicing.
- **Multi-tenant.** SupervisorDO with 64-shard / 128-facet-per-shard routing; per-session
  KernelFacet with its **own isolated SQLite**, cold-restore across `facets.abort`, failure
  isolation proven. WS-hibernation **proxy model** (supervisor holds the socket and RPCs each
  frame). Per-tenant API-key auth + Analytics Engine metering + `/usage`.
- **Surfaces.** Browser notebook UI, `@engram/sdk` (Node), `engram` CLI (REPL + RLM loop), agent
  code-mode adapter.

## Not done (owner-gated or out of scope)

- **npm publish** of `@engram/sdk` + CLI — built, needs owner OK.
- **Scale at 1000s** — verified to 150 concurrent; full 64×128 saturation under sustained load
  unproven.
- **Python kernel** — dropped per owner. RustPython was the candidate (single-memory,
  snapshottable); Pyodide is blocked on Cloudflare.
