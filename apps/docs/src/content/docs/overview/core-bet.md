---
title: The core bet
description: Why a durable, hibernating live-heap REPL is even possible.
---

V8 isolates **cannot** hibernate a live kernel — there is no heap-snapshot API. A Cloudflare
Worker's JS heap dies on eviction; the only way back is replaying source, which re-fires every side
effect.

**Rust → WASM dissolves that.** A WASM interpreter holds all its state in **linear memory — a plain
`ArrayBuffer` you can read, persist, and restore.** So:

- **Hibernate** = dump `memory.buffer` (+ mutable globals like `__stack_pointer`) to durable storage.
- **Resume** = new WASM instance, blit the bytes back, continue execution mid-namespace.

No journaling, no source replay. We literally persist the heap. That single property is the whole
product.

:::tip[The whole bet, in one line]
**V8 isolate heap: not snapshottable. WASM linear memory: is.**
:::

## Why heap-snapshot, not state-reconstruction

There are two ways to make a REPL durable:

1. **Reconstruct** an equivalent namespace from durable *data* (the model journaling and
   facet-native `ctx.storage` use).
2. **Snapshot the raw interpreter heap** and blit it back.

Engram uses (2). Model (1) loses live object identity, closures, and pending promises — it is not a
real kernel. Model (2) is only possible because WASM linear memory is a plain `ArrayBuffer`. This
was proven byte-deterministic across real Cloudflare evictions. See
[ADR-0002](/architecture/adrs/#adr-0002--live-heap-snapshot-not-logical-state-reconstruction).

## The architecture, in one picture

![Engram architecture — client → Rust DurableObject → rquickjs engine.wasm → DO SQLite / R2 via the W5+W4+E6 delta stack, hibernate and resume](/diagrams/architecture.svg)

## Platform facts (do not re-derive)

- **V8 isolate heap: not snapshottable. WASM linear memory: is.** ← the whole bet.
- Durable Object: single-threaded per id; SQLite survives everything; alarms; WebSocket
  Hibernation (in-memory state lost on hibernate → must live in storage).
- **Facets cannot set alarms** → idle / TTL scheduling lives on the supervisor DO.
- Worker Loader / Dynamic Workers / facets require Workers **Paid**; wrangler **≥ 4.86.0**.
- workerd forbids runtime WASM compile of raw bytes → deliver via CompiledWasm import or the
  `{wasm}` Worker-Loader module type.
