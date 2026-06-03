---
title: Snapshot / restore
description: The eval → snapshot → evict → cold-wake round-trip.
---

The whole product is one round-trip: evaluate a cell, snapshot the heap at a quiescent boundary,
get evicted, and cold-wake byte-identical with no replay.

![Snapshot/restore round-trip between the Client, Rust DurableObject, rquickjs engine.wasm, the W5+W4+E6 delta stack, DO SQLite, and R2 engram-snapshots](/diagrams/snapshot-restore.svg)

## Snapshot

1. After a cell evals, the Rust Durable Object reads `memory.buffer`, mutable globals, and entropy
   counters from the `rquickjs` `engine.wasm` instance.
2. The guard admits on **used heap** (`getMemoryUsage().memoryUsedSize`), not the monotonic buffer
   size — so a spike-then-free session can still checkpoint.
3. The image is gzipped → SQLite (chunked 64 KB rows + manifest) when `<2MB gz`, else R2 overflow.
   Checkpoint replace is crash-atomic via workerd write-coalescing (raw `BEGIN/COMMIT` is forbidden
   on DO SQLite).

## Restore

On wake: a new WASM instance is created, Tier-0 natives are re-instantiated at fixed bases, the heap
bytes are blitted back, and globals are restored. Execution continues mid-namespace.

The restore guard admits on the snapshot's recorded `used_heap` (a manifest column), not the raw
image bytes — so a session that spiked above the dump ceiling then freed can still cold-restore.

## Determinism boundary

All non-determinism (time, RNG, crypto entropy) crosses a **single host boundary** and is seeded +
counted. Same seed + same cells ⇒ byte-identical snapshot, verified across real eviction.
`host.fetch` adds zero entropy to the snapshot.

This is byte-coupled to the engine build, so a build-time `quickjs.wasm` SHA-256 engine-hash guards
restore: on mismatch it falls back to a per-cell journal replay rather than blitting a stale image
into a new engine (which would silently corrupt). See
[ADR-0002](/architecture/adrs/#adr-0002--live-heap-snapshot-not-logical-state-reconstruction).

## The crash signature that drives the design

Isolate OOM and Error 1102 are **uncatchable** — no JS exception, no log. They surface as a WS close
`code=1006`. So Engram guards by **size, not `try/catch`**: a hard size-admission ceiling refuses to
grow / snapshot above the safe envelope. See [Guards](/durability/guards/).
