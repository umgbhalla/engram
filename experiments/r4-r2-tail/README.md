# R4 — R2-tail mitigation sim (LOCAL, design+sim)

Mitigates the single biggest owned cold-restore cost from `docs/REALCF-VALIDATION.md`:
the R2 GET for >2MB-**gz** heaps (~300ms warm / ~900ms cold / ~1.8s p95).

- `latency-model.mjs` — R2 GET latency, calibrated to the measured points
  (cold 5MB single-object = 907ms ≈ measured 908ms; p95 = 1768ms ≈ measured 1771ms).
  Decomposition: `T_get = T_conn + bytes/BW`; cold `T_conn=740ms`, warm `120ms`, `BW=30MB/s`.
  Parallel: `T_conn` overlaps (paid once), bandwidth gets a capped ×3 multi-stream gain.
- `lat-store.mjs` — SQLite (≈0ms synchronous) + latency-charged R2, with single /
  K-way-split / hot-tier / prefer-SQLite write paths. Fidelity = byte-identical raw round-trip.
- `run.mjs` — bake-off on a seeded 5MB incompressible image. `node run.mjs`.

## Findings (cold regime, 5MB incompressible, baseline single-R2 = 927ms)

| Mitigation | Cold latency | vs single-R2 | Note |
|---|---|---|---|
| (a) chunked-parallel K=4..16 | 816ms | 1.14x | win bounded by cold T_conn (paid once) |
| (b) + streaming gunzip | 796ms | 1.16x | gunzip overlaps network |
| (c) hot-tier in DO-SQLite | ~0ms | ∞ | 5MB raw stored in SQLite rows |
| (d) prefer-SQLite via gz | ~0ms | ∞ | only if heap is compressible (<2MB-gz) |
| **parallel vs SERIAL 4-obj** | 796 vs 3127ms | **3.93x** | the real chained-restore shape |
| **parallel vs SERIAL 8-obj** | 796 vs 6087ms | **7.65x** | near-Kx |

## The key nuance (honest)

Chunked-parallel buys **~Kx only when the baseline is SERIAL multi-object**
(base + delta-chain + oplog GET one-by-one). For a **single** 5MB object the win is
only ~1.16x, because the cold cost is **connection/cold-spin latency-bound (740ms paid
once), not bandwidth-bound** (transfer is only ~167ms). Splitting one object does not
remove a serial wait that wasn't there.

## Recommendation

1. **Never let an incompressible heap reach R2 if it fits the hot-tier.** Keep big
   images in DO-SQLite 64KB rows (synchronous ≈0ms reads). This is the decisive win
   (∞x) and the kernel already chunks SQLite. Accept the SQLite size cost; only spill
   to R2 above the SQLite practical ceiling.
2. **Prefer-SQLite via gz level 9** on compressible heaps pushes the gz size under the
   2MB-gz overflow line, avoiding R2 entirely (compressible 5MB → 98KB gz). Cheap, no
   downside on compressible content.
3. **If R2 is unavoidable** (genuine >2MB-gz incompressible, beyond SQLite ceiling):
   ALWAYS **parallel-GET** and never chain serially — collapses a multi-object serial
   restore by ~Kx. Use K≈4 (diminishing returns past the ×3 BW cap). Add **streaming
   gunzip** for a free ~20-130ms.

## Caveat — needs real-CF re-measure before shipping

All latencies are **simulated** from the model calibrated to REALCF point measurements.
The model's parallel-BW gain (×3 cap) and the conn-vs-transfer split are **assumptions**;
real R2 parallel-GET behavior (per-object cold-spin overlap, shared-pipe saturation)
must be re-measured on a scratch worker (`engram-bench`-style) before adopting the
parallel/hot-tier routing in the kernel. The hot-tier (c) and prefer-SQLite (d) wins
rest only on the already-validated "SQLite reads ≈0ms" fact and are highest-confidence.
