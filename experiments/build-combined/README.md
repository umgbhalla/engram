# build-combined — the candidate production durability stack (W5 + W4 + E6)

Composes the three durability rungs from `docs/DURABILITY-ROADMAP.md` into one strategy
that runs on the shared `_bench` harness (imported, not re-implemented).

- **W5 compaction** — keep a small base; a periodic *rebase* (full compacted snapshot) is the
  compaction point. Rebase fires on chain-weight (`chainGz >= 3× baseGz`), chain-length cap (64),
  or used-heap **reclaim** (spike-then-free → re-snapshot a compacted base). Bounds restore cost.
- **W4 byte-delta** — per-cell durability writes ONLY the dirty 4KB pages vs the previous image,
  gzipped. Measured: ~0.05% of bytes change per cell, ~8/305 pages dirty. Zero re-fire (image is
  byte-identical on restore, so side effects never replay).
- **E6 oplog** — append-only crash tail + engine-migration net. Each cell appends one tiny oplog
  row (source + seeded-entropy cursor). NOT the main restore path. Two jobs: (1) recover a cell
  whose delta did not commit before a crash; (2) replay source into a NEW engine when the heap
  image is version-locked by an engine-hash bump, instead of bricking.

Commit point = the manifest, written last. Host state + oplog row flushed in the same checkpoint
(coherence invariant). A crash before the manifest write rolls back to the prior good checkpoint.

## Run

```
cd ../_bench && node runner.mjs ../build-combined/strategies/combined.mjs
```

## Results (node v25, macOS, all numbers from runner output)

| workload | combined bytes | baseline (full-dump) | reduction | writeAmp | restoreMs | peakImage | fidelity |
|----------|---------------|----------------------|-----------|----------|-----------|-----------|----------|
| W-light  | 1.08MB        | 4.74MB               | 4.39×     | 244.9×   | 3.2ms     | 1.25MB    | PASS     |
| W-spike  | 230.1KB       | 679.3KB              | 2.95×     | 0.00×    | 29.2ms    | 49.25MB   | PASS     |
| W-churn  | 396.4KB       | 2.98MB               | 7.70×     | 1757×    | 6.0ms     | 3.19MB    | PASS     |
| W-long   | 3.88MB        | 19.90MB              | 5.13×     | 159.9×   | 4.1ms     | 1.25MB    | PASS     |
| W-bigctx | 279.7KB       | 1.07MB               | 3.90×     | 847.5×   | 5.1ms     | 4.63MB    | PASS     |

All R2 bytes = 0 (every image gzips under the 2MB SQLite-overflow threshold).

## Fidelity (explicit, beyond the runner gate)

Closure counter (40→++→43), Map `[[a,1],[b,2],[c,3]]`, Set `[10,20,30,40]` all survive
evict→cold-restore with **byteIdentical reconstructed image = true**, genuine restore (gen 2,
fresh VM). A still-pending promise's resolver round-trips and is callable post-restore (the heap
carries the pending reaction; microtask draining is the session-driver's job, identical for all
strategies).

## E6 proven (not decorative)

- **Crash-tail:** committed cells 1–3 (`log=[1,11]`), cell 4 appends its oplog row then CRASHES
  before manifest commit → restore recovers `[1,11]` + replays the uncommitted tail → `[1,11,111]`.
- **Engine-migration:** heap image discarded (simulating an engine-hash bump that version-locks it)
  → replay 4 source rows into a fresh engine → `[1,11,111]`. State rebuilt without the heap image.

## Does it beat every single strategy?

vs the reference single-rung builds (`strategies/_single-w4.mjs`, `_single-w5.mjs`):

| workload | combined | single-w4 (delta-only) | single-w5 (full-each-cell) |
|----------|----------|------------------------|----------------------------|
| W-light  | 1.08MB   | 948.7KB                | 4.74MB                     |
| W-spike  | 230.1KB  | 229.3KB                | 679.3KB                    |
| W-churn  | 396.4KB  | 382.0KB                | 2.98MB                     |
| W-long   | 3.88MB   | 3.46MB                 | 19.90MB                    |
| W-bigctx | 279.7KB  | 278.9KB                | 1.07MB                     |

Honest finding: combined is **not** the byte-minimum — pure-W4 (delta-only, never rebases) writes
~5–12% fewer bytes. But pure-W4 is **not production-viable**: its restore replay chain is
**unbounded** (W-long: **200 deltas** replayed on restore vs combined's **2**), and a single
missing/corrupt delta row bricks the session with no recovery. Combined trades ~5–12% bytes for a
**bounded restore (chain cap 64), crash-tail recovery, and engine-migration survival** — the right
production tradeoff. It beats the only bounded-restore single strategy (W5/full-dump) by 3–8×.
