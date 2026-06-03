---
title: Guards
description: Defense in depth — how Engram contains runaway cells without crashing the Durable Object.
---

Isolate OOM and Error 1102 are **uncatchable** on workerd — there is no JS exception to catch, just
a WS close `code=1006`. So Engram guards by **size and ticks, not `try/catch`**. Every guard
produces a *typed* error and keeps the socket alive; the next eval works.

| Guard | Limit | Failure mode |
|---|---|---|
| Loop tick-budget | 1200 default / 2000 cap | typed `TimeoutError`, socket alive |
| Mid-cell heap tripwire | +8 MB growth / 16 MB absolute | typed `MemoryLimitError` mid-cell |
| Native malloc-limit (dlmalloc) | 16 MB live heap | typed `NativeAllocLimitError` (no WS-1006) |
| Snapshot-dump ceiling | 18 MB raw | typed `SizeAdmissionError`, clean reject |
| Engine-hash | build-time `quickjs.wasm` SHA-256 | journal replay on mismatch |

## How they layer

- **Loop tick-budget.** The interrupt handler decrements a budget on every bytecode invocation, so
  *every* infinite-loop shape (empty `while(true){}`, `x=1`, `globalThis.x=1`, `o.a=1`) trips a
  typed `TimeoutError` in ~0.2–0.5 s. The budget sits below workerd's host-interrupt throttle floor
  so the callback can't be starved.
- **Mid-cell heap tripwire.** While a cell runs, the interrupt handler also reads the WASM
  linear-buffer byteLength and throws on per-cell growth over 8 MB (or absolute over 16 MB), below
  the dump ceiling — catching in-cell alloc bombs *mid-cell*.
- **Native malloc-limit.** A dlmalloc malloc-limit backstop turns a giant single allocation into a
  catchable typed error *before* `memory.grow` can crash the DO — closing the old WS-1006 hole.
- **Snapshot-dump ceiling.** The size-admission guard refuses to snapshot an image whose raw buffer
  exceeds 18 MB, with a clean typed rejection instead of a silent OOM crash.

## The honest limit

WASM linear memory is **monotonic** — `runGC()` frees JS objects but the `memory.buffer` does not
shrink in place (dlmalloc has no downward compaction). An **arena scrub** zeroes freed pages so the
gzipped / stored image shrinks dramatically, and the admission guard works on *used* heap so a
spike-then-free session can still checkpoint. But a session grown far past the safe envelope (the
extreme ~256 MB edge) can't reclaim raw buffer — that case is documented and guarded against, not
silently absorbed.
