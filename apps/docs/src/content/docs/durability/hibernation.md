---
title: Hibernation & determinism
description: How sessions survive real evictions byte-for-byte, and why restore is deterministic.
---

## Durable hibernation

A session **hibernates when idle** and **resumes with full live state** — variables, closures,
pending promises — with no replay and no re-fired side effects. This was proven across **real
20-minute full evictions, 7/7 cycles, zero state loss**.

Each cycle was a genuine reconstruction: `inMemory:false`, generation bumped, `sqlite-restore`,
state / closures / arrays intact, corroborated server-side by Analytics Engine.

### Cold-wake is platform-bound, not our restore

| Scenario | Cold wake |
|---|---|
| Base session (~1.3 MB) | ~130 ms |
| 5 MB image | ~1.5–1.8 s |
| 20-min deep eviction (base) | ~1.5 s |

The dominant cost is **cold WS connect / DO spin-up (~950 ms–1 s)** — a platform cost, **not** our
restore. QuickJS init is <300µs; gunzip + blit are sub-ms even at 30 MB. The worst real user wake is
~1.5s, and state always survives.

The only in-kernel-owned lever is the R2 read path for images above ~2 MB gz; everything else is
network / platform.

## Determinism

Byte-identical restore-and-advance requires externalizing **all** non-determinism at the host
boundary:

- controlled monotonic clock (`clock_time_get` — epoch + 1 ms tick),
- seeded PRNG (`Math.random` → mulberry32),
- seeded `crypto.getRandomValues` / `random_get`,
- pinned `timezoneOffset`.

Host RNG / clock state lives **outside** linear memory; the host-side entropy counter is persisted
and replayed with each snapshot. One un-externalized source (the clock alone) is enough to break
byte-identity. Host callbacks are not in the snapshot → they are re-registered after restore.
`host.fetch` adds zero entropy.

## Crash & upgrade safety

- **Per-cell move-forward checkpoints** recover to the last *committed* cell. Commit ordering is
  load-bearing: `committedCell` advances only after the durable write resolves.
- An **engine content-hash guard** rejects a stale-engine restore with a typed
  `ENGINE_HASH_MISMATCH` **before** any blit (no corruption), falling back to the per-cell journal
  replay.
