---
title: Decision records
description: The architecture decision records that shaped Engram — dropping Worker Loader, heap-snapshot over replay, and facets for multi-tenancy.
---

Three ADRs anchor the design. They are the load-bearing choices: where state lives, how it is
made durable, and how the kernel goes multi-tenant.

## ADR-0001 — Drop Dynamic Worker Loader for the kernel substrate

**Status:** Accepted (V0). Revisited by ADR-0003.

**Context.** The project began exploring Dynamic Worker Loader (`env.LOADER`) for a durable,
resumable REPL. DW Loader spins up ephemeral, per-request V8 isolates — best-effort warm, keyed
only by id, with **no persistence guarantee** and no module type for `.wasm`.

**Decision.** V0 does **not** use Dynamic Worker Loader. The kernel substrate is a **Durable
Object** (single persistent identity + SQLite + hibernation) with the QuickJS engine bundled as a
**CompiledWasm** module.

**Why.** A kernel needs the opposite of what DW Loader offers: one persistent single-identity
actor that owns state and survives eviction. The engine is a *fixed* image, so bundle it rather
than load it dynamically. EXP-4b confirmed pure-Rust nested eval isn't viable; path **(b)** — a
Rust DO shell plus JS glue — is the answer.

**Consequence.** V0 bindings: `KERNEL_DO` (DO + SQLite), `SNAPSHOTS` (R2 overflow), and a
CompiledWasm `quickjs.wasm`. No `LOADER`.

## ADR-0002 — Live-heap snapshot, not logical-state reconstruction

**Status:** Accepted.

**Context.** Two ways to make a REPL durable: **(A)** reconstruct an equivalent namespace from
durable *data* (the model facet-native `ctx.storage` and journaling use); **(B)** snapshot the raw
interpreter **heap** and blit it back.

**Decision.** Use **(B)**: dump QuickJS WASM **linear memory + mutable globals** at quiescent cell
boundaries; restore into a fresh instance. No source replay, no re-fired side effects.

**Why.** Model (A) loses live object identity, closures, and pending promises — not a real kernel.
(B) is only possible because WASM linear memory is a plain `ArrayBuffer` (the V8 isolate heap is
**not** snapshottable). Proven in EXP-1 / EXP-5a; byte-deterministic with a seeded clock and RNG
(EXP-8).

**Consequence.** Snapshots are byte-coupled to the engine build, so an engine-hash guard plus a
per-cell journal fallback protect against version drift (EXP-9). This is orthogonal to facets:
even inside a facet, we still heap-snapshot into the facet's SQLite.

## ADR-0003 — Adopt Durable Object Facets for V1 multi-tenant

**Status:** Proposed (V1 direction) — spike proven live.

**Context.** V0 is one DO per session. Going multi-tenant and dynamically configurable needs
per-session isolation, supervisor-owned auth / metering / billing / kill-switch, and
per-tenant, versioned kernel code. DO **Facets** provide exactly this: a supervisor DO loads a DO
**class from a Dynamic Worker** (`LOADER.getDurableObjectClass`) and runs it as a child facet with
its **own isolated SQLite**.

**Decision.** V1 packages the kernel as a **facet under a supervisor DO**. This is where Worker
Loader deliberately re-enters — reversing ADR-0001 *only* for the multi-tenant / dynamic-config
case: the per-tenant kernel class is loaded via `env.LOADER`, hot-swappable via `abort` + restart,
isolated per session.

**Why.** Facets fuse dynamically-loaded code, persistent isolated storage, and supervisor control
— the precise shape of a multi-tenant, dynamically-configured, stateful REPL. The live-heap
snapshot (ADR-0002) still applies *inside* each facet's SQLite.

**Consequences / open questions.**

- Facets require a `new_sqlite_classes` supervisor and a `worker_loaders` binding (Workers Paid,
  beta).
- **Facets cannot set alarms** — idle / TTL scheduling must live on the supervisor DO. (Kernel
  durability is per-cell synchronous snapshot, which doesn't need alarms.)
- Raw-bytes runtime `WebAssembly.compile` is blocked in a facet, but an undocumented
  `{ wasm: ArrayBuffer }` Worker-Loader module type delivers a pre-compiled Module — a delivery
  tweak, not a rewrite.
- Facet-native `ctx.storage` is model (A); we keep the model (B) heap-snapshot on top. Both
  coexist in one facet DB.

**Sequencing.** Prove the kernel is *useful* as a flat DO first; only then layer facets for
multi-tenancy. Don't add facet complexity before the single-tenant kernel earns it.
