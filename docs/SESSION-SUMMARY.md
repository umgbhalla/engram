# Engram — Compute-Edge Substrate Session Summary

> One long session that turned engram from a durable REPL into a **capability-brokered compute substrate** — the muscle ladder, a unified `/workspace` filesystem, a real Linux sandbox, a content-addressed worker registry, and the groundwork for VM-initiated forking. Plus an incident + recovery worth recording.

Deployed live: `engram-kernel` (wss://engram.umgbhalla.xyz) · `engram-sandbox` (new). Committed to `main` (`c3a2e85`).

---

## What shipped (live + verified)

### The muscle ladder
A durable QuickJS **brain** that brokers an escalating ladder of **muscle**, every rung over one R2 data plane, each capability injected fail-closed:

| Tier | What | Status |
|---|---|---|
| **0** in-heap stdlib | lodash/zod/etc, snapshot-persisted | live |
| **1** hash-worker registry | `registerWorker(src)→sha256`, `invokeWorker(hash,input)` in a fresh Worker-Loader isolate with a prefix-scoped `env.VFS` | **live** |
| **2** sandbox container | `@cloudflare/sandbox` real Linux (`s.sandbox.exec/git`), R2-prefix `/workspace` mount | **live** |
| **3** Workflows | durable orchestration | designed, not built |

### Unified filesystem — `/workspace`
- **One root everywhere.** A cell's `fs.writeFile('/workspace/x')`, a hash-worker's `env.VFS`, and the container's `/workspace/x` are the **same R2 object** (`fs/<doId>/x`).
- **CWD semantics** — relative paths resolve against a session CWD (default `/workspace`, settable via `chdir`, clamped under root). Bare-absolute `/x` is root-relative. Backward-compatible (no data migration).
- **`@engram/fs`** — extraction-ready package (26/26 tests): the canonical resolver, prefix isolation, manifest authority, txn/direct coherence, CAS dedup, `fsVersion`-on-every-write, manifest export.
- Bidirectional brain↔container↔R2 verified (container writes land back where the cell reads).

### Capabilities + fixes
- **net/tls** raw sockets (cloudflare:sockets) — strictly-sequential shim
- **VFS host↔R2 file I/O** (`s.readFile/writeFile/ls/stat`, off-heap, multi-MB)
- **TypeScript via sucrase** — generics, enums, decorators (replaced the hand-rolled stripper)
- **sha512/384** (createHash + hmac + subtle), **nanoid ESM**, **clock:real** (real inter-cell elapsed), builtin-error hint
- **stack-guard** — 8MB wasm stack + 256KB JS guard → deep recursion is a **catchable RangeError with clean recovery** (no `unreachable` instance-corruption)

### Advanced integration (verified live)
RLM-pattern map→reduce over a VFS corpus · durability (Map + pending-promise survive hibernate) · 4MB file off-heap · concurrent session isolation · sandbox brain↔container roundtrip.

---

## RLM context
Engram is RLM infrastructure (researched the field — `docs/research/RLM-EXEC-ENVIRONMENTS.md`):
- Canonical RLMs (Zhang/MIT) run a **persistent REPL** + **fresh sliced sub-environments** (they do **not** fork state). Their exec envs (in-process `exec`, IPython subprocess, Docker, Daytona/microVM) are **all ephemeral** — `dill`-on-volume is the durability ceiling; `persistent=True` raises in every isolated backend.
- Engram's edge: **one mechanism (WASM linear memory) = isolation + state + checkpoint**, so a recursion tree **hibernates and resumes with no replay** — which none of them have. The canonical RLM primitive maps to `host.spawn + eval(slice)`; `host.fork` (planned) would be genuinely novel (nobody forks).

---

## The incident (and recovery)
A cautionary tale, all recovered:
1. **Workflow watchdog vs long deploys** — `cargo build`/`alchemy deploy` exceed the 180s no-progress watchdog, so deploy-in-workflow stalls (one ran 5.6 hrs then failed). **Fix: kernel deploys are done in-thread, not via workflow agents.**
2. **A `git reset` to `b52d066`** (by an earlier operation) silently wiped uncommitted engine source (sha512 etc) — survived only in the deployed binary. A later engine rebuild regressed sha512; **re-applied from the verified impl**.
3. **16MB wasm stack briefly bricked the kernel** (blew the snapshot dump-ceiling/memory layout) — service down minutes, **rolled back to 8MB**.

**Lesson encoded:** commit early (the whole tree was uncommitted and a stray reset already cost work once); deploy in-thread; 8MB is the max safe wasm stack on this substrate.

---

## Current state
- **`main` is the source of truth**, pushed (`c3a2e85`), matches the deployed kernel (`engine-hash rust-9a1d8583`).
- Stale 0-ahead branches deleted; `ouru-sublm-bridge` (parked, divergent) kept.
- New: `packages/engram-fs`, `apps/sandbox`, 7 research docs.

## Open items
- **`host.spawn` / `host.fork`** — VM-initiated sibling/fork (the RLM recursion primitive). Designed + staged; not built.
- **#4 sync-over-async VFS** (`writeFileSync` under R2 → in-heap LRU + `ERR_FS_COLD`) — deferred.
- **net/tls keepalive read-block** (host-side) — deferred.
- **host.ws inbound** works cross-cell only (workerd read-batching) — documented.
- **Deep-recursion depth** is bounded (~clean catch; deeper needs a bigger wasm stack, but that breaks the dump ceiling).
- **Workflows / R2-event-Queue wake-loop** — next-tier prototypes.
