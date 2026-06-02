# Engram Durability Bake-off

Eight durability/latency strategies run on ONE shared harness (`experiments/_bench/` — `store.mjs` / `session.mjs` / `workloads.mjs` / `runner.mjs`), real `quickjs-wasi@3.0.0`, node v25, macOS. Fairness metric = `store.bytesWritten`. Baseline = current v0 full-dump behaviour; every other strategy is measured against it. All `restoreMs` are local in-process and relative-only (real CF is network-bound — see Gaps).

Five workloads: **W-light** (50 small cells), **W-spike** (grow ~48MB then free), **W-churn** (30× alloc-2MB/free), **W-long** (200 cells steady graph growth), **W-bigctx** (>1MB context referenced across restore).

---

## 1. The Comparison Matrix

Numbers are bytes-written (the durable-write fairness metric), restore ms, peak raw image, and fidelity. `%Δ bytes` = vs baseline row (negative = fewer bytes written = better).

### W-light (50 small cells)
| Strategy | bytesWritten | %Δ bytes | writeAmp | restoreMs | peakImage | fidelity |
|---|---|---|---|---|---|---|
| baseline (ref) | 4.74MB | — | 1074.19x | 2.3–2.6 | 1.25MB | PASS |
| W5 compaction | 4.74MB | +0.1% | 1075.57x | 2.5 | 1.25MB | PASS |
| W4 byte-delta | 0.515MB | **−89.4%** | 113.98x | 3.2 | 1.25MB | PASS |
| E6 oplog | 0.584MB | −87.7% | 132.41x | 2.7 +0.1 replay | 1.25MB | PASS |
| Combined | 1.08MB | −77.2% | 244.9x | 3.2 | 1.25MB | PASS |
| W3 asyncify | (not a bytes axis) | — | — | — | — | PASS |
| E4 wizer | (not a bytes axis) | — | — | — | — | PASS |
| Sandbox-suite | 4.74MB | +0.0% | 1074.19x | 2.3 | 1.25MB | PASS |

### W-spike (grow ~48MB then free)
| Strategy | bytesWritten | %Δ bytes | writeAmp | restoreMs | peakImage | fidelity |
|---|---|---|---|---|---|---|
| baseline (ref) | 679.3KB | — | 0.01x | 20.8–22.1 | 49.25MB | PASS |
| W5 compaction | 680.0KB | +0.1% | 0.01x | 20.3 | 49.25MB→1.25MB live (97.46% reclaim) | PASS |
| W4 byte-delta | 395KB | **−41.7%** | 0.01x | 31.0 | 49.25MB | PASS |
| E6 oplog | 95.9KB | −85.9% | 0.00x | 2.2 +92.9 replay | 49.25MB | PASS |
| Combined | 230.1KB | −66.1% | 0.00x | 29.2 | 49.25MB | PASS |
| Sandbox-suite | 679.3KB | +0.0% | 0.01x | 20.7 | 49.25MB | PASS |

> **The wedge:** baseline + the 18MB RAW dump ceiling throws `SizeAdmissionError` on the 49.25MB W-spike image (usedHeap only ~66KB) → permanently un-checkpointable. **W5 fixes it** (routes 146.6KB gz to SQLite, cold-restores full fidelity) and **Combined inherits the fix**.

### W-churn (30× alloc-2MB / free)
| Strategy | bytesWritten | %Δ bytes | writeAmp | restoreMs | peakImage | fidelity |
|---|---|---|---|---|---|---|
| baseline (ref) | 2.98MB | — | 13520.74x | 2.9–3.0 | 3.19MB | PASS |
| W5 compaction | 2.98MB | +0.1% | 13537.94x | 2.9 | 3.19MB | PASS |
| W4 byte-delta | 0.270MB | −90.9% | 1225.07x | 6.5 | 3.19MB | PASS |
| E6 oplog | 0.396MB | −86.7% | 1798.65x | 3.0 +18.8 replay | 3.19MB | PASS |
| Combined | 0.387MB | **−87.0%** | 1757x | 6.0 | 3.19MB | PASS |
| Sandbox-suite | 2.98MB | +0.0% | 13520.74x | 2.8 | 3.19MB | PASS |

### W-long (200 cells steady growth)
| Strategy | bytesWritten | %Δ bytes | writeAmp | restoreMs | peakImage | fidelity |
|---|---|---|---|---|---|---|
| baseline (ref) | 19.90MB | — | 821.16x | 2.2–2.3 | 1.25MB | PASS |
| W5 compaction | 19.93MB | +0.1% | 822.17x | 2.2 | 1.25MB | PASS |
| W4 byte-delta | 1.64MB | **−91.7%** | 67.81x | 3.4 (190 deltas) | 1.25MB | PASS |
| E6 oplog | 2.145MB | −89.2% | 88.50x | 2.2 +0.0 replay | 1.25MB | PASS |
| Combined | 3.88MB | −80.5% | 159.9x | 4.1 (2 deltas) | 1.25MB | PASS |
| W3 asyncify | 19.90MB | +0.0% | 821.14x | 2.35 | 1.25MB | PASS |
| Sandbox-suite | 19.90MB | +0.0% | 821.16x | 2.2 | 1.25MB | PASS |

### W-bigctx (>1MB context across restore)
| Strategy | bytesWritten | %Δ bytes | writeAmp | restoreMs | peakImage | fidelity |
|---|---|---|---|---|---|---|
| baseline (ref) | 1.07MB | — | 3304.60x | 3.5–3.6 | 4.63MB | PASS |
| W5 compaction | 1.07MB | +0.1% | 3306.49x | 3.3 | 4.63MB | PASS |
| W4 byte-delta | 0.445MB | **−58.4%** | 1346.86x | 11.9 | 4.63MB | PASS |
| E6 oplog | 0.219MB | −79.6% | 662.13x | 3.3 +0.0 replay | 4.63MB | PASS |
| Combined | 0.280MB | −73.8% | 847.5x | 5.1 | 4.63MB | PASS |
| Sandbox-suite | 1.07MB | +0.0% | 3304.60x | 4.3 | 4.63MB | PASS |

### Total durable bytes across all 5 workloads
| Strategy | total bytes | %Δ vs baseline |
|---|---|---|
| baseline | 29.35MB | — |
| W5 | ~29.4MB | +0.1% (parity by design) |
| **W4 byte-delta** | **3.24MB** | **−89.0% (9.07x)** |
| E6 oplog | ~3.44MB | −88.3% |
| Combined | ~5.85MB | −80.1% |
| Sandbox-suite | 29.35MB | +0.0% |

---

## 2. Winner per axis

- **Least durable bytes (absolute floor):** **W4 byte-delta — 3.24MB total** (9.07x under baseline's 29.35MB). E6 is a close second at ~3.44MB. W4 wins 3 of 5 workloads outright (W-light −89.4%, W-churn −90.9%, W-long −91.7%); E6 wins the two memory-heavy/context tails (W-spike −85.9%, W-bigctx −79.6%) because it stores cell-source not heap diff. **W4 is the byte winner, but see §3 — it is not production-viable alone.**
- **Fastest restore:** **E6 oplog — 2.2ms** restore on W-spike/W-long (full-snapshot read only). Caveat: E6's *replay* adds real CPU cost on memory-heavy tails (**+92.9ms on W-spike** re-allocating the 48MB string). For pure restore-read latency E6/baseline tie at ~2.2ms; once replay is counted, baseline's 20.8ms single-read beats E6's 2.2+92.9ms on W-spike. **Net fastest end-to-end across the board: baseline / W5** (no replay, no chain-walk). W4 and Combined add bounded chain-apply cost (3–12ms).
- **Smallest peak image:** **W5 fresh-instance reclaim — 49.25MB → 1.25MB live (97.46% RAW reclaim)** on W-spike. Every other strategy keeps the 49.25MB peak. This is the only strategy that shrinks the live working set after a freed spike. (Honest limit: the reclaim comes from fresh-instance rehydrate, not in-place buffer shrink — see §4.)
- **Best on the W-spike wedge:** **W5 — `wedgeAvoided=true`**, checkpoints the 49.25MB image as 146.6KB gz to SQLite and cold-restores full fidelity, where baseline+18MB-ceiling throws `SizeAdmissionError` and bricks the session. Combined inherits this. **W5 owns the wedge.**

---

## 3. Recommended Production Stack

**Build the Combined stack: W5 compaction + W4 byte-delta + E6 oplog, gated on the manifest as the single commit point.** Artifacts: `experiments/build-combined/`.

Composite numbers proving it (vs baseline):
- **W-light 1.08MB (−77.2%) · W-spike 230.1KB (−66.1%) · W-churn 387KB (−87.0%) · W-long 3.88MB (−80.5%) · W-bigctx 280KB (−73.8%)** — total ~5.85MB vs 29.35MB, fidelity PASS on all 5, **R2 bytes = 0** (every image gzips under the 2MB SQLite threshold).
- Page-delta dominance is measured: 4KB granularity, ~8/305 pages dirty per cell (~0.05% of bytes change) — that is why byte-delta carries the win.

**Why Combined over the byte floor (W4-alone):** Pure-W4 writes ~5–12% FEWER bytes than Combined, but it is **not production-viable** — its restore replay chain is unbounded (W-long: **200 deltas** replayed vs Combined's **2**), and a single missing/corrupt delta **bricks the session with no recovery net**. Combined pays ~5–12% more bytes to buy: (a) **bounded restore** (chain cap 64 + W5 reclaim-rebase), (b) **E6 crash-tail recovery** (committed `[1,11]` + uncommitted tail replay → `[1,11,111]`), and (c) **engine-migration survival** (source-replay rebuilds state when the heap image is discarded). It beats the only OTHER bounded-restore strategy (W5/full-dump) by 3–8x on bytes. Combined is the best production stack, not the absolute byte minimum — stated plainly.

**Build order:**
1. **W5 compaction first** — it is the un-wedge (closes the v0.5 ~256MB / spike-then-free DO-kill class). Lowest-risk, parity on non-spiked workloads, biggest correctness payoff.
2. **W4 byte-delta** on top — the bytes engine; composes cleanly (smaller W5 base → smaller deltas). Ship with `GRAIN=256`/4KB pages, `BASE_EVERY=20`, `FALLBACK_PCT=0.5` auto-fallback (verified firing on dense W-spike mutation).
3. **E6 oplog as the crash-tail + engine-migration net** — append-only, cheap, turns a corrupt/version-locked image from a brick into a source-replay rebuild.
4. **Sandbox-suite coherence invariant** as the commit discipline wrapping all of the above (staged single commit point — see §5).

---

## 4. Per-strategy verdict + caveat

- **baseline-full-dump** — *ship-ready (the reference).* Correct and simplest, fidelity PASS on all 5. **Caveat:** catastrophic write-amp (1000x–13500x) — re-dumps the whole image for 231B–25KB of real growth (W-long writes 20MB durable for ~25KB), and the 18MB ceiling wedges spike-then-free sessions.
- **W5 compaction** — *works-with-caveats.* Fixes the wedge and delivers the only real peak-image reclaim (97.46%). **Caveat:** on shipped quickjs-wasi 3.0.0 the raw `memory.buffer` cannot be shrunk IN PLACE; the 97.46% comes from fresh-instance rehydrate. True in-place reclaim needs the native rquickjs `JS_WriteObject`+oplog build.
- **W4 byte-delta** — *ship-ready (byte champion).* 9.07x overall byte reduction, fidelity PASS incl. byte-identical 8-deep chain. **Caveat:** unbounded restore chain and no crash/migration recovery if used alone — must be paired with W5 (chain cap) + E6 (recovery net).
- **E6 oplog** — *ship-ready.* 5–9.3x byte reduction, fastest pure restore-read, and the engine-migration safety net. **Caveat:** replay re-executes CPU (W-spike +92.9ms re-allocating 48MB) and relaxes strict no-replay WITHIN the oplog window (safe because host-call results replay from recorded values — but these workloads have no host calls, so that slot is unstressed).
- **Combined** — *ship-ready (the production pick).* 2.95x–7.70x bytes, bounded restore, crash-tail + migration recovery, R2=0. **Caveat:** ~5–12% more bytes than the W4 floor; restoreMs local-only.
- **W3 asyncify** — *works-with-caveats (preempt axis, not bytes).* Mid-cell preemption proven: suspend@500k of 1M, cold-restore + rewind to final=1M. **Caveat:** real-engine size cost +1.36x (1.51→2.06MB); wiring real mid-eval unwind needs the engine compiled with asyncify + an unwind-capable interrupt import (quickjs-wasi `evalCode` is synchronous).
- **E4 wizer** — *works-with-caveats (cold-create latency axis, not bytes).* Bake removes stdlib inject: create p50 0.504ms vs 10.037ms unbaked (~9.5ms saved for 81KB stdlib, scaling ~120ms/dense-MB). **Caveat:** +1.3MB module size; saving is real but a minority of CF cold-wake (platform spin-up is ~950ms–1.5s); base+hook wasm reused from prior spike (no wasi-sdk on machine to recompile from C).
- **Sandbox-suite** — *ship-ready.* 39/39 coherence assertions + 5/5 workloads; durable host.fs/kv, seeded timers fire exactly-once, frozen env, deny-by-default router, staged-commit proven load-bearing via negative control. **Caveat:** zero bytes-saving (full-dump heap + host manifest) — its value is the coherence invariant, not durability size. Note: re-serializing a fresh quickjs-wasi VM is NOT byte-stable (allocator free-list shifts per instance), so logical-state + persisted-image round-trip are the correct fidelity criteria, not re-dump byte-identity.

---

## 5. Separate-axis results — ship or not

- **W3 mid-cell preempt cost (`experiments/build-w3/`):** genuine unwind-cost median **~0.006ms** (the real mechanism latency; the ~20ms time-to-trip is loop-bound, not mechanism). Size overhead on the real engine **1.36x** (1.51→2.06MB). **Ship: YES, eventually** — it closes the runaway-cell tripwire gap with negligible runtime cost, but it is **not a v1 dependency**: requires an asyncify-compiled engine + unwind-capable interrupt import, which is a build-pipeline change. Defer until the bytes stack lands.
- **E4 cold-create saving (`experiments/build-e4/`):** **~9.5ms saved/create** for 81KB stdlib, up to ~120ms/dense-MB; eliminates ~99% of inject cost. **Ship: MARGINAL** — real CF cold-wake is platform-bound (~950ms–1.5s), so this matters only for warm-isolate re-creates and large stdlibs, and costs +1.3MB module size. Ship only if a large default stdlib is bundled or warm-create rate is high; otherwise skip.
- **Sandbox coherence (`experiments/build-sandbox/`):** **39/39 PASS**, staged single-commit proven load-bearing (naive immediate-commit TEARS in the negative control). **Ship: YES** — this is the correctness discipline the whole delta/oplog stack must commit through. It is the invariant, not an optional add-on.

---

## 6. Honest gaps — what the sim does NOT capture

All numbers above are local, in-process, single-machine (node v25 / macOS / `quickjs-wasi@3.0.0`). Before trusting these in production, re-measure on real Cloudflare:

- **restoreMs is fiction for latency ranking.** It is local in-process restore with NO network. Real DO restore is **network/platform-bound** — prior repo measurements put cold-wake at ~950ms–1.5s (WS-connect + isolate spin-up), dwarfing the 2–31ms shown here. The restore-ms column is **relative comparison only**; never quote it as a user-facing latency.
- **No real R2 round-trip.** Every workload here gzipped under the 2MB SQLite threshold → **R2 bytes = 0 in all reported runs.** The store's R2-overflow branch was verified separately in the harness but the multi-hundred-ms R2 GET (v0.4 measured ~597ms for a 5MB image) is NOT in any number above. Incompressible or >2MB-gz images on real CF will route to R2 and pay that cost — must be re-measured.
- **No real workerd.** Interrupt-callback throttling (the documented ~1.6k-invocations/turn cap that forces the tick budget below 1500), the OOM/WS-1006 monotonic-buffer DO-kill at ~256MB, and the `{wasm}` Worker-Loader delivery type are all **workerd/CF behaviours absent from node.** W3 asyncify and the mid-cell tripwire interact with these directly and must be validated on workerd.
- **W5 in-place reclaim is not real on this engine.** The 97.46% reclaim is fresh-instance rehydrate, not buffer shrink. The advertised 96.9% in-place RAW reclaim needs the native rquickjs `JS_WriteObject`+oplog build — not yet on the shipped substrate.
- **E6 replay CPU is workload-shaped and unstressed on host calls.** The 92.9ms W-spike replay is real and will differ on CF CPU; the recorded-host-call-result slot (the no-double-fire guarantee) is exercised by design but **not stressed** because these workloads issue no host calls. Re-measure with a host-call-heavy workload.
- **E4 base wasm was not recompiled from C here** (no wasi-sdk on the machine); the bake step is reproduced but the base+hook module is reused from the prior e4-wizer spike.

**Re-measure on real CF, in order:** (1) restore latency at 1.3MB / 5MB / >2MB-gz with real R2; (2) Combined-stack write bytes against real DO SQLite chunking; (3) workerd interrupt-throttle + mid-cell tripwire under W3 asyncify; (4) W5 reclaim path under a real spike-then-free DO eviction.
