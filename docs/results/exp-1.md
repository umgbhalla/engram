# EXP-1 results — QuickJS WASM snapshot/restore round-trip (local)

**Date:** 2026-06-01 · **Branch:** `exp/1-wasm-snapshot` · **Verdict: PASS ✅**

The decisive core bet holds: a QuickJS REPL namespace — a `var`, a **closure**,
and a **pending Promise** — survives a snapshot (linear memory + mutable globals)
written to disk and restored into a **fresh WASM instance in a separate Node
process**, with **no replay of the original source**. This validates
"hibernate = dump WASM linear memory; resume = new instance + write bytes back."

## Setup

- Engine: [`quickjs-wasi@3.0.0`](https://www.npmjs.com/package/quickjs-wasi)
  (vercel-labs), QuickJS-NG → WASM with built-in snapshot API.
- **Prebuilt `quickjs.wasm` (1.6 MB) pulled from npm — no wasi-sdk build.** The
  package bundles its own WASI shim (~6 imports), so no host polyfill was needed.
- Runtime: Node v25, local only.
- Cell 1 (evaluated only in the snapshot process):
  ```js
  globalThis.x = 41;
  globalThis.inc = () => { x++; return x; };
  var p = Promise.resolve().then(() => { x = x + 1; });
  ```
- Phase A: fresh VM → eval cell 1 → `snapshot()` + `serializeSnapshot()` → disk.
  The promise is **left pending** (jobs not drained before snapshot).
- Phase B: **separate `node` child process**, never sees cell-1 source →
  `deserializeSnapshot()` → `QuickJS.restore()` → `executePendingJobs()` →
  eval cell 2 `inc()`.

## Assertions (all PASS)

| Check | Expected | Got |
|---|---|---|
| `x` before snapshot | 41 (promise pending) | 41 |
| `x` immediately after restore, pre-drain | 41 | 41 |
| pending jobs drained | 1 | 1 |
| `x` after draining the surviving promise | 42 | 42 |
| `inc()` return (closure survived) | 43 | 43 |
| `x` final | 43 | 43 |

`x === 43` = 41 base **+1 from the pending promise that survived the snapshot and
fired post-restore** **+1 from the closure `inc()` defined pre-snapshot**. Both
the pending microtask job queue and the closure round-tripped through raw bytes.

## Numbers

| Metric | Value |
|---|---|
| Linear memory at snapshot | 1280 KiB (20 × 64 KiB pages) |
| Snapshot raw (serialized) | 1,310,748 bytes (1280.0 KiB) |
| Snapshot gzip | ~98,095 bytes (95.8 KiB) — **~13.4× compression** |
| Snapshot time (`snapshot()` + serialize) | ~0.21–0.26 ms |
| Restore time (`QuickJS.restore`, fresh instance) | ~2.1–2.9 ms |
| Mutable globals exported by this build | **1** (`__stack_pointer` only) |

Raw memory compresses ~13× thanks to large zero regions, matching the feasibility
note (quickjs-wasi baseline ≈256 KB; here 1.28 MB raw / 96 KB gzip). Snapshot and
restore are both sub-3 ms at this size — restore latency at multi-MB remains the
open question (EXP-7, needs CF/R2).

## Globals-necessity (mini EXP-2a)

`negative-control.mjs` restores the *same* snapshot into fresh instances three ways:

1. **memory-only** (blit memory, do NOT restore `__stack_pointer`): **did not
   corrupt here.** At a quiescent cell boundary QuickJS has unwound its WASM C
   call stack, so a fresh instance's default `__stack_pointer` (1048576 = stack
   top) *coincides* with the snapshot value (delta 0). Omitting it was silently
   harmless — a **dangerous false-positive**, not proof that globals are optional.
2. **memory + global** (correct path): correct (`x=42`, 5000-elem array, `inc()=43`).
3. **wrong `__stack_pointer`** (restore correctly, then point SP into the live
   heap): **HARD CRASH** — `RuntimeError: null function or function signature
   mismatch` on the next allocation/eval.

**Finding:** `__stack_pointer` is load-bearing. Test (3) proves the causal
mechanism — a wrong SP scribbles over live heap and crashes. The reason test (1)
*looked* fine is specific to snapshotting at a quiescent boundary where the C
stack is empty; you must not rely on that coincidence. **Capturing every exported
mutable global is mandatory** — any build with a non-default SP, a separate heap
pointer global, or additional mutable globals would corrupt under memory-only
restore. This build happens to export only `__stack_pointer`, which `snapshot()`
already captures, so the correct path is complete here.

## Gotchas / notes

- **`memory.grow` detaches the buffer.** `restore()` grows memory *first*, then
  re-acquires `new Uint8Array(memory.buffer)` before `.set()`. Reading
  `memory.buffer` once and caching it across a grow would read a detached buffer.
  The library handles this; any hand-rolled host code must too.
- **Quiescent-boundary snapshotting masks the globals requirement.** See above —
  do not let the memory-only false-positive lull you into skipping globals.
- **funcref/externref tables not serialized.** This module's
  `__indirect_function_table` is reconstructed by re-instantiating the same module
  (host functions re-registered by name via `registerHostCallback`), not byte-
  copied — consistent with the architecture's integer-handle host-ref design.
- **No source replay.** Phase B runs in a separate OS process via
  `child_process`; cell-1 source never reaches it. The closure + pending promise
  exist purely because their bytes were restored.
- **Engine-build coupling.** The snapshot is byte-coupled to this exact 1.6 MB
  `quickjs.wasm`. A different engine build would not restore (content-hash guard +
  source-journal fallback needed in production — out of scope for EXP-1).
- Ran cleanly, no flakiness across repeated runs.

## Files

- `experiments/exp-1/lib.mjs`
- `experiments/exp-1/snapshot-phase.mjs`
- `experiments/exp-1/restore-phase.mjs`
- `experiments/exp-1/harness.mjs`
- `experiments/exp-1/negative-control.mjs`
- `experiments/exp-1/README.md`
- `experiments/exp-1/package.json`

## Implications for the build

- JS-kernel snapshot/restore via linear-memory + globals is **proven locally**.
- Confirms the architecture's "capture all mutable globals" rule with a concrete
  crash, and the "table is static / host refs are integer handles" design.
- Next: EXP-2b (host-callback re-bind by name), then deploy gates (EXP-3) and the
  in-DO thesis test (EXP-5).
