# W4 — Fine-Grain Byte-Delta Durability: Real-Cloudflare Proof

> Branch/worktree: `experiments/kernel-w4/` (a copy of `kernel-w5`, retargeted to
> `engram-bench-w4`). Built on the W5-compacted kernel base. **Bench-only**: never
> deployed to a live worker, no `apps/` edits, no git commit. Deployed and torn down
> under guardrails (worker `engram-bench-w4`; R2 prefix `benchw4/` on shared
> `engram-snapshots`).

## Headline

W4's 256-byte-grain byte-delta checkpointing, proven LIVE on real Cloudflare DO
SQLite over a 200-cell session, cut total durable bytes **14.65× vs the full-dump
baseline** (3.080 MB vs 45.124 MB) for the favorable small-mutation workload — well
above the published 2.95–7.7× bake-off band — while keeping the delta chain
**strictly bounded** (max chain length 19, resets at `BASE_EVERY=20`) and restoring
**byte-correct** from a base+delta chain in sub-second time.

## What W4 is (the change-set vs `kernel-w5`)

W4 keeps a base image + an ordered per-cell byte-delta chain. The previous raw image
is retained host-side in the glue instance (`this._lastImage`, dropped on evict,
re-derived on cold wake). Each checkpoint diffs the current image against the prior at
256-byte grain; if the delta payload+indices gz is < 50% of a full image it stores a
`delta` (changed-grain payload gz + gz Uint32 grain-index list), else a full
W5-compacted base (which resets the chain). `BASE_EVERY=20` caps the chain.

| File | Change vs `kernel-w5` |
|---|---|
| `wrangler.jsonc` | name `engram-bench-w5` → `engram-bench-w4` |
| `src/lib.rs` | R2 prefix `benchw5/` → `benchw4/`; schema `snap_manifest` +`base_seq`/`delta_seq`/`snap_mode`, new `delta_chunks(seq PK, payload, indices, grain)`; `dumpW4`/`restoreW4` externs; `checkpoint()` rewritten base/delta (force-full when no prior manifest OR `delta_seq+1>=20`; delta path appends ONE `delta_chunks` row + bumps `delta_seq` + replaces ctx/manifest in one crash-atomic turn; full path = W5 behaviour + `DELETE delta_chunks` chain reset); `read_delta_chain()` with `CorruptDeltaError` count guard; restore reads base + chain → `restoreW4` |
| `src/glue.js` | constants `DELTA_GRAIN_BYTES=256`/`DELTA_FALLBACK_PCT=0.5`/`BASE_EVERY_CELLS=20`; `this._lastImage`; extracted `_serializeForDump()` (shared W5 GC + used-heap admission + safe-serialize ceiling + freed-arena SCRUB); new `dumpW4(forceFull)` (diff-or-fallback) and `restoreW4(baseGz, deltaList, …)` (gunzip base, apply ordered deltas, then the same W5 deserialize/restore/blit path; engine-hash + used-heap + raw-ceiling admission preserved); W5 `dump()`/`restore()` retained |
| test hook | `{t:'w4Bench', cells:N}` (+ `baseline:true` path forcing full every cell through the same SQLite store, for apples-to-apples) |

Note: an unused `restore` extern (superseded by `restoreW4`) remains bound — harmless
dead binding, compiles clean.

## Real bytes-saved vs baseline (measured on real CF DO SQLite)

Identical 200-cell workload (steady object growth: one new key/cell on
`globalThis.__m`), driven LIVE against deployed `engram-bench-w4`:

| Strategy | Total durable bytes | Bases | Deltas |
|---|---|---|---|
| **W4 byte-delta** | **3,079,627 B (3.080 MB)** | 10 | 190 |
| Full-dump baseline (force_full/cell) | 45,124,285 B (45.124 MB) | 200 | 0 |

**Reduction = 14.65×** — above the 2.95–7.7× bake-off band (this single workload is
W4's strength: tiny per-cell mutation = tiny deltas). Reproduced twice, identical
totals.

## Bounded-chain proof

`maxChainLen = 19`, resets at the `BASE_EVERY=20` cadence; 10 full bases observed
across 200 cells. The chain is never unbounded — a corruption count-mismatch is caught
by `CorruptDeltaError`, and length-change / dense-mutation auto-falls-back to a full
base.

## Fidelity (genuine evict → cold restore through a base+delta chain)

All 9 verification checks PASS (harness `experiments/kernel-w4/verify-w4.mjs`):

- Cold restore via base+delta chain: PASS (`inMemory:false`, `restoreSource=sqlite-restore`, last ck `mode=delta deltaSeq=5`)
- Closure counter survives chain: `inc()===17`
- `Map` survives base+5 deltas; `Set` survives base+5 deltas
- Pending promise + resolver survive AND resolve post-restore (`RESOLVED-AFTER-RESTORE`)
- Chain genuinely built, not collapsed to full (`deltaSeq=5 mode=delta`)
- Earlier 25-cell run: cold eval reconstructs `25===25`, latency 646 ms (network/DO-wake-bound)

## W5-regression check

W4 did **not** regress the W5 un-wedge:
- Spike 22 MB then free still checkpoints cleanly: `scrubbed=true, store=sqlite, sizeGz=241903`, no `SizeAdmissionError`, freed usedHeap 23,164,358 → 91,902.
- Session survives evict → cold-restore after wedge (`value=before-spike`).

## Determinism

Two independent seeded sessions (`rngSeed=555`) running an identical
`Math.random()`-heavy program produced **byte-identical** stored images: identical
`sizeGz=6142`, `nChanged=54`, `usedHeap=93797`, `deltaSeq=3`, `rngCalls=204`. The delta
path adds **zero entropy**.

## Cutover-readiness — is W5+W4 ready to merge into live, pending owner OK?

**Conditionally YES — pending owner OK, with two caveats.**

- The core mechanism is proven on real CF: large byte reduction, bounded chain,
  byte-correct restore across genuine eviction, no W5 regression, determinism intact.
- **Caveats before a live merge:**
  1. **Delta path on the R2-overflow branch is unexercised here** — every bench
     checkpoint stayed in DO SQLite (gz < 2 MB R2-overflow threshold), so no
     `benchw4/` R2 objects were written. The base/delta R2 swap-then-delete +
     `read_delta_chain` over R2 needs a >2 MB-gz live validation before cutover.
  2. **Single favorable workload.** 14.65× is the best case (small per-cell
     mutation). A mixed/large-mutation workload lands in the 2.95–7.7× band; dense
     mutation correctly auto-falls-back to full. Production gain will be workload-
     dependent — still net positive and chain-bounded.
  3. Cosmetic: drop the dead `restore` extern before merge.

**Recommendation:** merge W5+W4 into the live kernel pending owner approval, after a
single >2 MB-gz R2-overflow delta-chain restore run on a bench worker.

## Teardown (this turn)

- Worker `engram-bench-w4` DELETED via CF API (confirmed name; `success:true`). Worker
  list now `engram-cloud + engram-kernel + engram-ui` (live trio intact; unrelated
  `curl-worker`/`durelo`/`thinkx-api` out of scope, untouched).
- `benchw4/` R2 keys: **none were written** — per the verify runs all checkpoints
  stored in DO SQLite (gz under the 2 MB R2-overflow threshold); the only R2 write path
  is keyed `benchw4/{do_id}/…` and was never reached. The worker's DO SQLite is gone
  with the worker. No R2 S3 token available to enumerate (known repo limitation), but
  there is nothing to prune.
- No live workers touched, no `apps/` edits, no git commit/push.

## Artifacts

- Build/code: `/Users/umang/hub/zonko/montydyn/experiments/kernel-w4/`
- Byte-reduction result: `/Users/umang/hub/zonko/montydyn/experiments/kernel-w4/bench/realcf-w4-result.txt`
- Fidelity/regression/determinism harness: `/Users/umang/hub/zonko/montydyn/experiments/kernel-w4/verify-w4.mjs`
