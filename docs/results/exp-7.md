# EXP-7 results — RESTORE LATENCY DISTRIBUTION (Cloudflare DO + R2)

**Date:** 2026-06-01 · **Branch:** `exp/7-restore-latency` · **Verdict: PASS ✅ (with a hard memory ceiling, not a latency ceiling)**

**Hypothesis (from the plan):** "sub-second restore holds only up to ~8–16 MB."
**Finding:** sub-second **p50** restore holds *further* than predicted — comfortably
through **~21 MB raw snapshot (~14 MB gzip)**. But the real wall is **memory, not
latency**: the Durable Object **crashes (Error 1102, surfaced to the client as WS
close 1006)** around **~27–32 MB raw**, when restoring requires two multi-MB QuickJS
WASM linear memories to briefly coexist inside the ~128 MB DO isolate budget. So
"fast resume" is bounded by the DO memory envelope before latency ever becomes the
limiter.

## What was deployed

- Worker **`montydyn-exp7`** + JS `KernelDO` (copied from the proven EXP-5a template).
  URL: `https://montydyn-exp7.umg-bhalla88.workers.dev`
- Same `quickjs-wasi@3.0.0` CompiledWasm path as EXP-5a/EXP-1.
- Reuses R2 bucket **`montydyn-snapshots`**, keys namespaced as **`exp7/snap/<doId>.qjs.gz`**
  (no collision with EXP-5a's `snap/...` keys).
- New DO message types: `alloc` (grow the namespace with a high-entropy string so
  the image does not gzip to nothing), `snapshot`, `restore` (drop in-memory kernel →
  restore from R2, **timing each stage**), `r2rtt` (isolated R2-get RTT only), `eval`, `evict`.

## Method

For each target size, on a fresh session: `alloc` the namespace, `snapshot` it to R2,
then **8 `restore` iterations** (each drops the live kernel and rebuilds it from R2)
plus **8 `r2rtt`** probes. Each restore is decomposed into:
`r2GetMs` (R2 get + arrayBuffer) → `gunzipMs` → `deserMs` (deserializeSnapshot) →
`instMs` (QuickJS.restore = instantiate + memory `.set()` blit + globals) → `jobsMs`
(executePendingJobs). Every restore re-verified the namespace: `x===42`,
`inc()===43`, `__payload.length` intact.

> Note on sizes: the QuickJS base image is ~1.3 MB raw / ~0.1 MB gz. Growing the
> namespace with a high-entropy string inflates the **raw** size faster than the
> gz size (entropy → ratio ~1.5×). Latency tracks the **gz size** (what transits
> R2); the **raw** size drives the DO memory pressure. The table reports both.

## Results — p50/p95 restore latency vs size

| target | raw MB | gz MB | gz ratio | p50 ms | p95 ms | mean ms | R2-get p50 ms | gunzip/deser/inst | iters ok | <1s p50 |
|---|---|---|---|---|---|---|---|---|---|---|
| base   | 1.25  | 0.10  | 12.8× | **231** | 493  | 263 | 225 | 0/0/0 | 8/8 | ✅ |
| ~8MB   | 7.19  | 2.81  | 2.55× | **275** | 600  | 317 | 285 | 0/0/0 | 8/8 | ✅ |
| ~12MB  | 11.19 | 6.19  | 1.81× | **299** | 1082 | 380 | 271 | 0/0/0 | 8/8 | ✅ (p95 tail) |
| ~14MB  | 14.13 | 8.78  | 1.61× | **415** | 911  | 457 | 330 | 0/0/0 | 8/8 | ✅ |
| ~21MB  | 21.06 | 13.86 | 1.52× | **385** | 1075 | 469 | 352 | 0/0/0 | 8/8 | ✅ |
| ~27MB  | ~27   | ~18   | 1.5×  | — | — | — | — | — | **0/8 — DO crashed during `snapshot`** | ❌ |
| ~30MB  | 30.38 | 19.49 | 1.56× | 1114 | 1114 | 764 | n/a | 0/0/0 | **2/8 then WS 1006** | ❌ |
| ~30MB  | 31.78 | 21.10 | 1.44× | 697  | 697  | 697 | n/a | 0/0/0 | **1/8 then WS 1006** | ❌ |

(p50/p95 over the successful iterations; "iters ok" = restores completed before the
DO crashed.)

## Where "fast resume" (<1s) breaks

- **p50 latency** stays **sub-second through ~21 MB raw (~14 MB gz)** — better than
  the ~8–16 MB hypothesis. p50 grows only gently with gz size (231 → 415 ms across
  0.1 → 14 MB gz) because the per-byte work is tiny.
- **p95** crosses 1 s already at ~12 MB raw, but that is **R2-get tail variance**
  (cold object / first fetch), not a deterministic size wall — the p50 underneath is
  fine and warm fetches are ~250–350 ms.
- **The hard ceiling is memory, hit before latency matters:** at **~27–32 MB raw**
  the DO dies with **Error 1102 (exceeded memory)**, seen as **WebSocket close 1006**.
  At ~27 MB the *snapshot* step itself crashes (transient peak: payload string + chunk
  array + serialized copy + gzip stream all live). At ~30 MB a single restore can
  succeed but a **second back-to-back restore crashes** (two ~30 MB WASM linear
  memories coexist while the previous instance is still GC-pending, blowing the
  ~128 MB DO isolate budget).

**Operating envelope:** keep the **raw** QuickJS image **≤ ~20 MB** (≈ ≤14 MB gz) for
reliable sub-second cold resume with headroom under the DO memory limit. This matches
and slightly extends the EXP-6 memory-ceiling story: usable namespace is bounded by
the DO isolate, well under the 64 MB WASM theoretical max.

## The restore cost is ~100% R2 network, ~0% compute

The decomposed timings are the headline: **`gunzipMs`, `deserMs`, `instMs`, `jobsMs`
were all 0 ms (sub-ms, rounded)** at every size up to 30 MB raw. The **entire**
restore latency is the **R2 GET** of the gzip blob:

- Inline `r2GetMs` ≈ total `restoreMs` at every size.
- Isolated `r2rtt` (get + arrayBuffer, no decode) tracks it: 225 ms @ 0.1 MB gz →
  352 ms @ 14 MB gz.
- gunzip (DecompressionStream), deserialize, and the `memory.set()` blit + globals
  write are effectively free relative to the network fetch.

**Implication:** latency optimization = shrink the **gz blob** and the **R2 RTT**, not
the decode/instantiate. Better compression (the high-entropy ratio here is a
worst-case ~1.5×; real namespaces compress far better — base was 12.8×) directly cuts
restore time. A real kernel snapshot that gzips like the base image (~12×) would put a
20 MB raw image at <2 MB gz and restore in ~250–300 ms.

## Chunked / streaming restore variant — evaluated, not pursued

The plan suggested trying chunked/streaming restore "if it helps." **It does not help
latency here**, for two reasons:
1. The bottleneck is the single R2 GET, which `R2Object.body` already streams; the
   `arrayBuffer()` read is the network transfer itself. Splitting into N chunked GETs
   would add N× request RTT overhead, not remove it.
2. gunzip + `memory.set()` blit are ~0 ms, so there is no decode pipeline to overlap.

Chunking *would* help the **memory ceiling**, not latency: streaming-gunzip directly
into the WASM memory (instead of materializing gz buffer + full decompressed buffer +
deserialized copy simultaneously) would cut the transient peak that causes the ~27 MB
crash. That is a memory-budget fix (a follow-up to EXP-6), not a latency win, so it is
recorded as a recommendation rather than implemented here.

## Platform errors hit

- **Error 1102 (exceeded memory limit)** at ~27–32 MB raw — **the operative ceiling**.
  Surfaced to the client as WebSocket close **1006** (abnormal close; the DO isolate
  was torn down mid-message so no clean reply was sent). Reproducible: crashes on the
  `snapshot` at ~27 MB and on the 2nd/3rd back-to-back `restore` at ~30 MB.
- No 10021 (startup CPU), no 10195 (paid gate), no 1101.

## Gotchas / findings

- **Latency is network-bound, not compute-bound.** The whole "gunzip → instantiate →
  blit → globals" tail that one might expect to dominate is sub-millisecond even at
  30 MB. The cost is purely fetching the gz blob from R2.
- **Raw vs gz matters separately.** Latency follows gz size; the DO crash follows raw
  size (transient live memory). High-entropy payloads (my stress data) decouple them
  badly — real kernel heaps gzip ~12×, so the latency-relevant gz size will be much
  smaller than these raw numbers suggest.
- **The crash is a back-to-back-restore peak, not steady state.** One 30 MB restore can
  succeed; the danger is two large WASM memories coexisting. A real system holds ONE
  live kernel and restores rarely, so the practical safe ceiling is closer to the
  single-restore success (~30 MB raw once) — but ≤20 MB raw is the conservative number
  with multi-restore / GC-lag headroom.
- **p95 tails are R2 cold-fetch, not size.** First fetch of an object is slower
  (~1 s spikes); warm refetches settle to ~250–400 ms. For a kernel, the cold wake is
  exactly the first fetch, so budget p95, not p50, for SLOs: **p95 < 1.1 s up to ~14 MB
  gz**, dominated by R2 first-byte latency.

## Leftover resources (intentionally kept)

- Worker **`montydyn-exp7`** (URL above) — left deployed.
- R2 bucket **`montydyn-snapshots`** — now also holds `exp7/snap/*` keys.
- Pre-existing resources (curl-worker, durelo, thinkx-api, durelo-content,
  nova-archive, sdev-skills, montydyn-exp5a) **not touched**.

## Files

- `experiments/exp-7/wrangler.jsonc` (worker name `montydyn-exp7`)
- `experiments/exp-7/src/worker.mjs` (Worker + `KernelDO` with alloc/snapshot/restore/r2rtt + per-stage timing)
- `experiments/exp-7/src/quickjs.wasm` (CompiledWasm, copied from EXP-5a)
- `experiments/exp-7/test-client.mjs` (size sweep → p50/p95 table; crash-tolerant)

## Verdict

**PASS** — the latency distribution is characterized. Restore is **R2-network-bound
and sub-second p50 to ~21 MB raw (~14 MB gz)**, beating the ~8–16 MB hypothesis on
p50. The binding constraint is **DO memory (Error 1102) at ~27–32 MB raw**, which caps
"fast resume" before latency does. Recommended operating envelope: **keep raw image
≤ ~20 MB**; optimize cold-wake latency by improving snapshot compression and R2 RTT,
not the decode path. A streaming-gunzip-into-memory restore is the right follow-up to
push the memory ceiling (not the latency).
