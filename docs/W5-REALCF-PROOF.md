# W5 — Real-CF Proof: did W5 close the spike-then-free dump wedge?

**Date:** 2026-06-02
**Headline verdict:** **YES — W5 closes the years-open spike-then-free wedge on real Cloudflare.**
Cutover-ready into `apps/kernel` **pending only owner OK + a live version-anchor rollback**.
No code residuals; one operational residual (un-shrinkable monotonic raw buffer) is *fundamental
to workerd*, documented, and fails-safe (typed error, socket alive) — not a W5 bug.

---

## 1. The wedge (what was broken)

The live kernel's size-admission guard measured the **monotonic WASM linear buffer**
(`memory.buffer.byteLength`). WASM linear memory only grows; dlmalloc does no downward
compaction. So any session that spiked allocation past the dump ceiling (~18 MB raw) and then
freed it could **never checkpoint again** — `SizeAdmissionError` forever, even with a tiny live
heap. The session was permanently un-hibernatable.

**The corrected W5 plan acknowledges raw-buffer reclaim is IMPOSSIBLE on workerd.** W5 does NOT
try to shrink the buffer. It un-wedges the *dump ceiling* by (a) moving the genuine OOM fence to
the **live used heap**, and (b) **scrubbing freed pages to zero** so the un-shrinkable raw buffer
gzips down to near-nothing for storage.

## 2. Wedge-test result (real CF, throwaway `engram-bench-w5`)

Forced via the `{t:'wedgeTest', spikeMb}` op: spike N MB of held `Uint8Array`s → null + GC →
normal `checkpoint()`.

| Spike | raw buffer (monotonic) | used heap after free+GC | checkpoint | stored gz | result |
|---|---|---|---|---|---|
| 30 MB | 33,095,680 B (~33 MB, past old 18 MB ceiling) | 92,137 B | **succeeds** | 250,541 B (~245 KB) | `wedgeCleared=true`, store=sqlite, nChunks=4, scrubbed=true |
| 42 MB | 45,678,592 B (~45.6 MB) | small | **succeeds** | 263,314 B (~257 KB) | `wedgeCleared=true`, scrubbed=true, socket alive |

Admission decision **PASSED on used-heap** (92 KB << `MAX_USED_BYTES` 50 MB), NOT on the 33 MB
monotonic buffer. The baseline kernel returns `SizeAdmissionError` + permanent wedge at this exact
point. **Wedge closed.** Genuine evict (`droppedInMemory=true`) + reconnect → `sqlite-restore`,
`inMemory=false`, state intact (`x=43`, `tag='alive'`, `inc()→44`), no replay.

Fences now reject as **typed errors with the socket alive** (no WS-1006): buffer >
`SAFE_SERIALIZE_BUFFER_BYTES` (45 MB) or used heap > `MAX_USED_BYTES` (50 MB).

## 3. Fidelity / Determinism / Regression (11/11 PASS)

- **FIDELITY = PASS:** after evict → cold `sqlite-restore`, closure counter `inc()===12`,
  `Map [[a,1],[b,2]]`, `Set [7,8,9]`, and a **pending promise + its resolver** all survived and
  the promise resolved post-restore to `RESOLVED-AFTER-RESTORE`. (Note: DO `generation` is an
  instance counter that *evict does not bump*; cold-restore proven by `inMemory:false` +
  `restoreSource=sqlite-restore`.)
- **DETERMINISM = PASS:** two identical seeded (`rngSeed:123`) sessions both fired the scrub
  (`scrubbed:true`) and produced **byte-identical** post-scrub manifests:
  `sizeRaw=24,707,325 · sizeGz=242,839 · usedHeap=92,820 · nChunks=4 · bufferBytes=24,707,072`
  on BOTH. Scrub/admission add **zero entropy** (`_scrubArena` saves/restores the interrupt budget
  exactly as before).
- **REGRESSION = PASS:** normal non-spiked seeded session behaves identically to baseline —
  scrub never fires (`scrubbed:false`), `store=sqlite`, normal small image (`sizeGz=219,912`),
  value correct (`f()===10`), state survives evict→restore (`f()+x===11`).

## 4. Exact change-set vs live (`apps/kernel`)

### `src/glue.js`
1. **Constants** (lines 14–35): `MAX_USED_BYTES`/`MAX_RESTORE_USED_BYTES` = 50 MB (live-heap OOM
   fence); new `SAFE_SERIALIZE_BUFFER_BYTES` = 45 MB (line 31); `MAX_RESTORE_RAW_BYTES` 18→**45 MB**
   (line 21); `SCRUB_MAX_BUFFER_BYTES` 16→**44 MB** (line 23); new `COMPACT_TRIGGER_BYTES` = 12 MB
   (line 34) + `COMPACT_USED_RATIO` = 0.4 (line 35). `MAX_DUMP_BUFFER_BYTES` stays 18 MB as a soft
   reference only.
2. **`dump()` hard pre-reject** (line 1551): gates on `SAFE_SERIALIZE_BUFFER_BYTES` (45 MB), NOT
   the old 18 MB. A spiked-then-freed buffer (18–45 MB, tiny used) now **falls through** to the
   used-heap fence (line 1568, `MAX_USED_BYTES`) and the scrub instead of wedging.
3. **`dump()` scrub trigger** (lines 1582–1586): fires on EITHER absolute slack (legacy) OR the
   cell-boundary bloat ratio `bufBytes>12MB && used/buffer<0.4` (plan 3(c)).
4. **`restore()` ceiling** (line 1145): `MAX_RESTORE_RAW_BYTES` 18→45 MB in lockstep with dump
   (a scrubbed freed-spike image gunzips back to its full zeroed extent); real fence stays the
   recorded used heap (line 1139).
5. New `memInfo()` test helper (GC + `{bufferBytes, usedHeap}`).

### `src/lib.rs`
1. New extern binding `mem_info() -> String`.
2. New `{t:'wedgeTest', spikeMb?}` arm + `wedge_test_critical()` (forces spike→free→checkpoint,
   returns `{memSpiked, memFreed, checkpoint, wedgeCleared, generation}`, emits `wedgeTest` AE
   datapoint, runs under the eval mutex). **Test-only hook — strip or feature-gate before merge.**
3. `r2_key_for` prefix `v093/`→`benchw5/` (bench-only; **revert to `v093/` on cutover**).

**NOT touched:** QuickJS engine, frame/message protocol, determinism path, checkpoint
commit-ordering, crash atomicity.

## 5. Cutover-readiness verdict

**READY TO MERGE into `apps/kernel`, pending only:**
- **Owner OK.**
- **Live version-anchor rollback** recorded for `engram-kernel` before deploy (capture current
  Version ID; `wrangler rollback` is the escape hatch).
- **Two bench-only reverts** before the real deploy: (a) revert `r2_key_for` prefix `benchw5/`→
  `v093/`; (b) strip or feature-gate the `wedgeTest` op + `mem_info` binding (test hooks, not product).

**Residuals (none blocking):**
- The monotonic raw buffer does **not** shrink in place — fundamental to workerd/WASM, NOT a W5
  bug. W5's design accepts this and scrubs the freed pages so the *stored* image collapses. Above
  45 MB buffer / 50 MB used it **fails safe** (typed error, socket alive, reset recovers) — no
  OOM/WS-1006.
- `wedgeTest`/`mem_info` are test surface, removed on cutover (above).

**Bottom line:** corrected W5 is a strict, zero-regression improvement that closes the
spike-then-free wedge on real CF with full fidelity and byte-identical determinism. Merge-ready
behind owner sign-off + the version anchor.

---

### Teardown confirmation
- `engram-bench-w5` **DELETED** (name confirmed `engram-bench-w5` before delete; never a live worker).
- R2 `engram-snapshots` prefix `benchw5/`: **0 objects** (W5 verify stored to SQLite hot-path, no
  R2 overflow needed — nothing to prune).
- Final worker list: **`engram-cloud`, `engram-kernel`, `engram-ui` only** (live trio intact).
- No git commit/push performed.
