# R2-tail mitigation — REAL-CF results (engram-bench)

> Real Cloudflare measurement of the three round-4 R2-tail mitigations against the live baseline.
> Replaces the local-sim numbers in `DURABILITY-ROADMAP.md` §"R2-tail mitigation". **Sim was wrong
> on 2 of 3.** Throwaway worker `engram-bench` (deleted post-run); R2 writes only under `bench/`
> (all cleaned). Live `engram-kernel`/`engram-cloud`/`engram-ui` untouched.

## Headline

**HOT-TIER confirmed as the decisive — and only — real win.** It removes the entire R2 cold GET
tail (5MB: p50 ~1.1s / p95 ~3.9s) by reading the gz image from DO-SQLite 64KB rows **in-turn with
zero network GET (readMs = 0, sub-await)**, trading it for in-memory gunzip CPU only
(~66ms @5MB, ~2s @20MB). The other two sim "wins" **fail on real CF**:
chunked-parallel R2 GET is a **net regression** and **hits the workerd subrequest/connection cap**;
gz-9 buys <1% and never flips the storage tier.

## Baseline (prior REALCF-VALIDATION, re-confirmed)

R2 GET 5MB cold **p50 ~908ms / p95 ~1771ms**; same-bytes apples-to-apples re-run here gave R2 GET
n=15 **p50 1115ms / p95 3920ms** (min 617ms — even the warm in-loop best case is hundreds of ms).
SQLite restore readMs ~0ms in-turn. R2 GET is ~100% of restore cost and dominates.

## Real-vs-sim, per mitigation

| Mitigation | Sim (round-4) | Real CF (this bench) | Verdict |
|---|---|---|---|
| **HOT-TIER** (gz image in DO-SQLite 64KB rows) | "∞× vs R2", ~0ms sync | **readMs 0ms** (no GET); total restore ≤66ms @5MB, ~1981ms @20MB (pure gunzip). 5MB holding = 80 rows, byte-exact (0% data overhead), ~1.56% DB page overhead (~82KB). Fidelity OK every rep. | ✅ **SHIP.** Sim confirmed and then some — eliminates the 0.9–3.9s R2 GET tail outright. |
| **chunked-parallel** multi-object GET | 3.9× (k=4) / 7.65× (k=8) | **0.44–0.98× — REGRESSION.** 5MB k=8: 1123 vs 1098ms (0.98×); 20MB k=8: 1464 vs 637ms (0.44×, worse); k≥16 **FAILS** "Response closed due to connection limit". Cold R2 GET is connection/dispatch-overhead bound, not bandwidth-bound. | ❌ **DO NOT SHIP.** Sim refuted; net negative + hits subrequest cap. |
| **prefer-SQLite via gz-9** (zlib L9 vs platform ~L6) | flips compressible images under the 2MB SQLite line | **0.67–0.80% smaller at every size** (5MB 867304→860362B; 20MB 3.16MB→3.14MB). `nowFitsSqlite=false` at ALL sizes — never moves an R2-tier (≥2MB-gz) image under the threshold. gzip already near the entropy floor for QuickJS heaps. | ❌ **Not worth shipping.** <1% gain, never changes routing tier for incompressible heaps. (Compressible 5MB heaps already gz to <2MB and route SQLite naturally at any level.) |

## What to ship

1. **Hot-tier routing policy:** for latency-sensitive sessions, keep the gz image in DO-SQLite 64KB
   rows even above the current 2MB-gz R2-overflow line, **when gz is still a few MB** (SQLite-practical;
   per-DB 10GB soft cap, a ≤18MB-raw image gz's well under that). Restore is then in-turn ~0ms read +
   gunzip CPU. Cost crossover: gunzip is ~2s at 20MB-raw/3.16MB-gz, so for very large incompressible
   heaps the gunzip cost approaches the R2 tail it replaces — hot-tier wins clearest for gz ≲ a few MB.
2. **Drop chunked-parallel and gz-9** as R2-tail levers. Chunked-parallel only ever mattered for a
   multi-object base+delta+oplog restore shape (not the current single-image path), and even there
   real concurrent GET does not bandwidth-parallelize.

## Methodology / honesty

workerd freezes the clock within a turn, so hot-tier in-turn phases legitimately read 0ms (sub-await,
no network) — consistent with prior REALCF/v0.4 findings, not an artifact. Repeated in-process n=10
loops triggered intermittent workerd 1101 (warm-isolate memory from repeated 7.4MB-heap WASM
instantiate + held 5MB buffers), not a logic bug; final R2 distribution collected as spaced n=1 calls.
40MB incompressible entropy builds often exceeded workerd CPU time → 20MB is the reliable large-image
test point. Bench code: `experiments/realcf/src/worker.mjs` (`_hotTier`/`_bakeoffRestore`,
`_chunkedParallel`, `_preferGz9` + routes).
