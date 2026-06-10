---
title: Architecture
description: How the Engram kernel, Durable Object host, and snapshot store fit together.
---

Engram is built on path **(b)**: a **Rust Durable Object shell** driving the `rquickjs`
`engine.wasm` interpreter, with a thin WASI / DO plumbing layer. A pure-Rust kernel was proven
non-viable for the eval driver — workerd has no native WASM host, so the engine must be driven
through the JS WebAssembly API. The Rust shell owns the eval mutex, guards, determinism, and the
checkpoint commit-ordering; the WASM interpreter owns the live namespace.

![Single-tenant kernel topology: client (SDK/CLI/UI) over WS/HTTP into the engram-kernel Rust DurableObject (eval mutex, guards, determinism, checkpoint commit-order), driving the rquickjs VM, with the W5+W4+E6 snapshot pipeline writing to DO SQLite and R2 overflow](/diagrams/architecture.svg)

## The pieces

- **Kernel** = a script interpreter compiled Rust → WASM (QuickJS-ng via `rquickjs`). Built-in
  snapshot API; the live linear memory *is* the engram.
- **Host** = a Cloudflare **Durable Object** — identity + SQLite + alarms + WebSocket hibernation.
  Holds the snapshot; orchestrates lifecycle.
- **Snapshot store** = DO SQLite for small images (chunked 64 KB rows + manifest), R2
  (`engram-snapshots`) overflow only above ~2 MB gz.
- **I/O boundary** = all host imports (network / time / random) cross a single controlled boundary,
  where non-determinism and handle-reconnect are handled.
- **Observability** = Analytics Engine (`engram_kernel` dataset) per-op metering.

## Session lifecycle

A session moves through a small state machine: **Cold** (only DO identity + SQLite) → **Creating**
(instantiate `engine.wasm`, run bootstrap, persist config) → **Live** (idle ⇄ evaluating ⇄
checkpoint) → **Hibernating** (DO evicted, instance gone, snapshot durable) → **ColdRestore** (new
instance, Tier-0 natives re-instantiated, heap blitted back, **no replay**) → back to Live.

![Session state machine: cold → creating → live (eval/checkpoint) → hibernating → cold-restore (no replay)](/diagrams/session-states.svg)

## Multi-tenant

`engram-cloud` is a sharded supervisor model. A tenant request routes through the **SupervisorDO**
(64-shard, FNV-1a routing), which owns auth, alarms (facets can't set alarms, so idle / TTL /
keep-warm live here), `worker_loaders`, and the **WS-hibernation proxy** (the supervisor holds the
socket and RPCs each frame — facet-held sockets are broken on the platform). Each session is a
**KernelFacet**: a Rust Durable Object running its own `engine.wasm` with its **own isolated
SQLite**, failure-isolated. The kernel is delivered as a `{wasm}` Worker-Loader module.

![Multi-tenant: tenant client → SupervisorDO shard (auth, alarms, worker_loaders, WS-proxy, metering) → per-session KernelFacets, each a Rust DO with isolated SQLite and R2 overflow](/diagrams/multi-tenant.svg)

See the [decision records](/architecture/adrs/) for why the Durable Object substrate, the
heap-snapshot model, and DO facets were chosen.
