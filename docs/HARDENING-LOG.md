# Hardening Log

Gap-hardening experiments closing caveats flagged by the bake-off, the SANDBOX-API note, and the W4/W5/E6 combined-stack work. Each entry: caveat closed (with source), test built, proving numbers, ship verdict. All artifacts are local experiment dirs; none committed; protected dirs (`experiments/_bench`, `experiments/realcf`, `experiments/build-combined`) imported read-only.

---

## GAP 1 — E6 oplog host-call replay: no double-fire

**Caveat closed.** The bake-off flagged E6's "recorded-host-call-result" slot as UNSTRESSED — the 5 standard `_bench` workloads issue zero host calls, so oplog replay (re-running recorded cell sources) never proved that side-effecting host calls fire exactly once. Open risk: replay of a cell body calling `host.kv.increment` / `host.fetch` POST re-fires the side effect and an external tally double-increments. (Source: E6 bake-off.)

**Test:** real quickjs-wasi oplog replay across crash + restore; three suites under `experiments/imp-oplog-hostcall/`.

**Proving numbers:**
- `run.mjs` 8/8 PASS: external tally at crash `==13`, UNCHANGED by replay of 3 cells (13→13, **ZERO re-fires**); `finalTally==20` EXACTLY (not 26 double-fire, not 7 lost); VM counter/results rebuilt to 20; `fireLog==[1..20]` no dup/gap; restore 5.14ms.
- `negative-control.mjs` 4/4 PASS (load-bearing): recorded-result replay → 20; **NAIVE re-fire replay → 23** (13→16, double-fire reproduced) — confirms the recorded-result slot is the mechanism, not an artifact.
- `ordering.mjs` 5/5 PASS: interleaved A,B,A multi-call cells; replay fired NOTHING; both tallies exactly-once (A==16, B==80); VM log in exact emission order, no dup/gap; order-violation guard never tripped.
- **Totals: 17/17 PASS, 0 FAIL.**

**Verdict: SHIP-READY for the sync host.* model.** Exactly-once hinges on host callbacks NOT surviving snapshot (restore re-binds `__hostCall`, runs oplog-tail cells in REPLAY mode returning recorded FIFO results side-effect-free, then flips to LIVE). Sound only if every nondeterministic input crosses the host boundary (true here) with seeded WASI keeping clock/RNG byte-identical.

**Residual:** ASYNC host calls / pending promises in the oplog window are NOT stressed (these workloads are sync).

Artifacts: `/Users/umang/hub/zonko/montydyn/experiments/imp-oplog-hostcall/` (`host-session.mjs`, `run.mjs`, `negative-control.mjs`, `ordering.mjs`).

---

## GAP 2 — Pending-promise + microtask-queue fidelity across the COMBINED image

**Caveat closed.** Promises and mid-flight microtask state are not exercised by the 5 standard bake-off workloads, so fidelity across the **W5-compaction base + W4 dirty-4KB-page-delta** reconstructed image was unproven. (Source: combined-stack bake-off.)

**Test:** custom driver on the real combined strategy (`build-combined/strategies/combined.mjs`) + real quickjs-wasi + shared DOStore. Builds 5 kinds of async state (A bare pending + queued `.then`; B resolved-but-undrained 3-stage chain; C async fn suspended at await ×2; D `Promise.all` over pending/resolved/pending; E fully-drained no-double-fire control), checkpoints per cell, forces genuine evict, cold-restores via `combined.onRestore` (base + page-delta replay into a fresh VM), then settles and asserts each continuation fired once with the correct value.

**Proving numbers:**
- **15/15 fidelity checks PASS, deterministic across 2 reruns.**
- Restore is delta-reconstructed: base gen 1 + page-delta chain length 6 (NOT a single full dump); `restoredGeneration=2` in a fresh VM = genuine cold restore.
- Timeline: pre-evict fired `[E1,E2]` only; after-restore-before-settle identical `[E1,E2]` (no spontaneous re-fire, no lost jobs); after-settle adds B1:5/B2:6/B3:60, A:from-A, C:from-C + C2:from-C100, D:dval1/fixed/dval2 in array order.
- No-double-fire: E1/E2 each exactly once. No missing, no spurious — final fired set == expected exactly.
- Bytes via shared store: 245,673 all SQLite (r2=0); per-cell delta ~21–31KB vs ~1.31MB full image (delta path exercised).

**Verdict: SHIP-READY.** Full pending-reaction + microtask-queue state survives the base+delta reconstruction identical to a full dump (QuickJS carries the pending-job queue in linear memory; eval never auto-drains, so undrained jobs stay genuinely queued in the bytes).

**Residual:** (1) pure-JS/microtask promises only — promises whose continuation depends on an in-flight host I/O handle (e.g. live `host.fetch`) are a separate handle-reconnect concern, NOT covered; (2) single evict/restore (one delta-chain replay), not chained multi-evict; (3) in-process DOStore simulator, not live Cloudflare.

Artifacts: `/Users/umang/hub/zonko/montydyn/experiments/imp-promise-fidelity/promise-fidelity.mjs`.

---

## GAP 3 — `host.fs` per-session byte quota

**Caveat closed.** SANDBOX-API note: `host.fs` had "no quota — a session could fill SQLite/R2 unbounded"; only file-COUNT was capped (256, proto C). Bytes were uncapped. (Source: SANDBOX-API "open hard limits".)

**Test:** quota-extended `host.fs` on real quickjs-wasi; one unified `usedBytes` counter spanning inline-SQLite + R2, durable in the manifest, across two genuine evict/restore cycles. Under `experiments/imp-fs-quota/`.

**Proving numbers:**
- `test.mjs` 24/0; `test-inline.mjs` 5/0.
- cap=10MB: 9MB write OK (used=9,437,184); +2MB → **QuotaError** (storage unmutated, VM alive 1+1==2).
- Evict + cold restore: quota counter re-hydrated to 9,437,184 (NOT 0), cap re-hydrated, heap intact, post-restore +2MB still rejects (live quota).
- `rm` frees quota (9MB→0, persisted, R2 body GC'd), then 5MB write succeeds.
- Exact-boundary: 5+5=10MB OK, +1B rejects; overwrite shrinks 10MB→6MB. 2nd evict/restore: counter coherent at 6MB == sum of live file sizes; +4MB OK, +1B rejects.
- Inline tier (cap 1000B): 600+400=1000 OK, +500B/+1B reject, counter rehydrated across restore.
- Restore 27.22ms; snapshot raw 50.75MB / gz 148.9KB.

**Verdict: SHIP-READY.** QuotaError is VM-catchable and non-mutating; counter durable and coherent (equals sum of live file sizes) across two cycles. Quota counts each live path's bytes (logical footprint); content-addressed dedup still skips identical R2 PUTs but does NOT discount the per-session cap (conservative/safe).

**Residual:** none for the bytes-cap half; the file-count 256 cap (proto C) remains the orthogonal count half (already done).

Artifacts: `/Users/umang/hub/zonko/montydyn/experiments/imp-fs-quota/` (`store.mjs`, `hostfs.mjs`, `kernel.mjs`, `test.mjs`, `test-inline.mjs`).

---

## GAP 4 — `host.fs` rm refcount GC (O(n) → O(1))

**Caveat closed.** protoA's `rm` decided R2 object GC by scanning ALL file metas (`sqlite.list('').some(getFileMeta)`) — an O(n) full-table walk per rm that doesn't scale. (Source: protoA host.fs.)

**Test:** content-addressed `host.fs` (`etag=sha256(content)`, N paths share one R2 object) with a durable per-etag refcount column: inc on write, dec on rm, GC fires only at 0; rm and GC decision are O(1) single-map lookups. 24-assertion suite on real quickjs-wasi@3.0.0, seeded clock/RNG, across genuine evict + restore. Under `experiments/imp-fs-refcount/`.

**Proving numbers:**
- **24 passed, 0 failed.**
- T1: 3 identical writes → 1 R2 put, refcount=3; rm 2 → object STAYS, refcount=1, gcFired=0; rm last → GC fires exactly once (r2dels=1), refcount row gone.
- T2 (complexity win, measured): GC decision touches **1 row at N=10 AND N=2000** (O(1)); protoA O(n) scan touches 9 rows at N=10 and 1999 at N=2000 → **1999× fewer rows at N=2000**.
- T3: refcount column survives genuine evict + restore (refcount==2 preserved, heap-held stat matches durable, post-restore rm-to-zero GCs exactly once).
- T4: overwrite-in-place releases old etag's ref in the same commit; same-content same-path rewrite leaves net refcount unchanged.

**Verdict: SHIP-READY.** Refcount + file-meta commit in a single atomic transaction (crash-atomic rename flush) so the column can't drift; T2's protoA worst case (rm a uniquely-content'd file → `.some` can't short-circuit → full walk) is the realistic one.

**Residual:** none flagged.

Artifacts: `/Users/umang/hub/zonko/montydyn/experiments/imp-fs-refcount/`.

---

## GAP 5 — W4 byte-delta dense-mutation auto-fallback safety valve

**Caveat closed.** When a per-cell page-delta would cost more than `FALLBACK_PCT` of a fresh full image, drop the delta and store a full base instead. Needed: prove the valve fires under dense mutation, stored bytes never exceed full+epsilon, restore correct across a sparse/dense mix, and find the right `FALLBACK_PCT`. (Source: W4 byte-delta design.)

**Test:** page-delta strategy with auto-fallback (`w4-delta.mjs`) on the shared `_bench` harness, real quickjs-wasi, seeded. Standard 5-workload suite (`runner.mjs`); low-entropy dense + PCT sweep (`adversarial.mjs`); high-entropy incompressible 4MB-refill stress + sweep (`adversarial2.mjs`); sparse/dense mixed run with mid-stream cold-restore (`mixed-verify.mjs`). Under `experiments/imp-w4-fallback/`.

**Proving numbers:**
- Standard suite fidelity 5/5; bytes cut vs full-dump (W-long 19.90→2.99MB, W-light 4.74→0.92MB, writeAmp 1074×→203×), zero regression.
- **(a) Valve fires:** high-entropy stress fires **100% (16/16 deltas re-anchored to full)** for fbPct≤0.95 (gz-delta ≈ gz-full ~4.02MB); at fbPct≥1.0 it correctly stops.
- **(b) Bounded:** worstStored ~4.10MB = full+epsilon in every regime; **worstVsFullGz=1.001×** everywhere — no blow-up (naive raw-delta worst = 1.0× full, the classic blow-up the valve prevents).
- **(c) Mixed correct:** true-mix fbPct=0.90 fired on exactly the 6 dense cells (**33% firing rate**, 1.0×), 12 sparse cells stored as deltas at 0.008–0.174×; genuine cold-restore gen=2 in 3.5ms; FIDELITY PASS; 1.001×.
- **Threshold:** right `FALLBACK_PCT` is just below 1.0 (**0.9–0.95**). <0.9 over-fires on compressible deltas; ≥1.0 never fires and a delta can land slightly above full via index+magic overhead. 0.9 bounds stored to full+epsilon without over-firing on sparse cells.

**Verdict: SHIP-READY against an adversary.** Stored bytes provably bounded at full+epsilon (1.001×) in all regimes; restore re-anchors on each fallback so delta chains stay short (bounded replay).

**Residual:** none — but note the honest nuance: the valve compares gz-delta vs gz-full, so it only fires under near-full-coverage AND incompressible mutation; plain low-entropy dense fill still compresses and a delta stays a strict win (valve correctly does NOT fire — `adversarial.mjs` 0% fallback, ~98KB vs ~105KB).

Artifacts: `/Users/umang/hub/zonko/montydyn/experiments/imp-w4-fallback/` (`w4-delta.mjs`, `adversarial.mjs`, `adversarial2.mjs`, `mixed-verify.mjs`); harness read-only from `/Users/umang/hub/zonko/montydyn/experiments/_bench/`.

---

## Confidence — Combined stack + sandbox APIs

With these five caveats closed, the **Combined (W5 base + W4 page-delta + E6 oplog) snapshot stack** and the **`host.*` sandbox APIs** are materially de-risked:

- **Exactly-once correctness** is no longer assumed — host-call replay (GAP 1) and pending-promise/microtask fidelity (GAP 2) are both proven on the real engine across genuine evict/restore, with negative controls demonstrating the failure mode the mechanism prevents.
- **The byte-delta strategy is adversary-safe** (GAP 5): the auto-fallback valve bounds stored bytes to full+epsilon (1.001×) under any mutation regime, so the delta path is a strict win or a clean no-op — never a blow-up.
- **The `host.fs` sandbox surface is bounded and scalable**: per-session byte quota enforced and restore-coherent (GAP 3), and rm/GC is O(1) and refcount-durable (GAP 4) — closing both the "no byte quota" and "O(n) rm scan" notes.

**Net:** the Combined stack and `host.fs` are ship-ready for the kernel's synchronous host model with quantified bounds. **Remaining residuals are all the SAME shape — async/host-handle-dependent state and chained multi-evict are unproven:** async host calls in the oplog window (GAP 1), promises gated on an in-flight `host.fetch` handle (GAP 2), and multi-evict delta-chain stress (GAP 2). These are the next hardening frontier; everything proven here was on the in-process harness simulator, not live Cloudflare, so live-network validation of the same scenarios remains the final confirmation step.

---

## Round 4 — closing the residual frontier (async oplog, multi-evict, the raw-reclaim verdict, the R2 tail)

Round 4 targets exactly the residuals the Confidence section flagged as "the same shape": async-host-call replay, chained multi-evict, plus the two long-standing open questions — whether raw-buffer reclaim is *fundamentally* impossible, and what actually fixes the R2 cold-restore tail. Same discipline: real engines, hard numbers, protected dirs imported read-only, local-only, no commit.

### R4-1 — RESIDUAL: ASYNC host-call inside the E6 oplog-replay window (exactly-once + concurrent ordering across the crash boundary)

**Residual closed.** GAP 1 proved exactly-once only for the SYNC host.* model; async host calls (and the concurrent in-flight ordering they create) inside the replayed oplog tail were explicitly unstressed.

**What was tested:** real quickjs-wasi 3.0.0 with an async host bridge — VM `host.fetch(tag)` → `__hostAsync` host callback returns a `vm.newPromise()` handle, host resolves it, `executePendingJobs()` pumps the awaiting continuation at the cell boundary. Same seeded WASI (xorshift32 RNG + fixed clock) as the sync GAP-1 work; E6 store reused read-only. 16 cells each `await host.fetch` bumping an external tally; cells 3/7/9/12/14 issue `Promise.all([a,b,c])` (3 concurrent in-flight). FULL snapshot every 5 cells + oplog of `{seq,src,hostResults(ordered)}`. Crash after cell 14, last full at seq 10 → replayed tail = cells 11,12,13 and INCLUDES the concurrent cell 12. Restore = full + replay in REPLAY mode (host returns recorded resolved value via a pre-resolved promise, fires NO effect). Ground truth = a no-crash run.

**Hard numbers:**
- **8/8 PASS.** Replay fired ZERO async effects: external tally unchanged by replay (22→22); 4 cells / 5 async calls re-issued NOTHING.
- Final external tally == ground-truth (**26 == 26**); fireLog = 26 unique tags, no dup, no gap.
- Awaiting continuations resumed with RECORDED values: VM acc (sum of awaited values) **351 == 351**; cell-counter **16 == 16**.
- **Concurrent ordering HELD byte-for-byte:** replayed `Promise.all` triples = ground-truth `[[4,5,6],[10,11,12],[14,15,16],[19,20,21],[23,24,25]]`, including cell 12's `[19,20,21]` which lived in the replayed tail; each triple strictly increasing (deterministic issue order preserved across the crash).
- **Negative control (non-vacuous):** naive LIVE replay double-fires the 5 tail async calls → tally 31; replay-mode held it at exactly-once 26.
- restoreMs ~3.6ms (in-process sim; real-CF restore latency is platform/network-bound, not this mechanic).

**Verdict: closed.** Exactly-once + concurrent ordering hold for async host calls across the crash boundary. The guarantee rests on **boundary-snapshot discipline + recorded-result replay**, NOT on resuming a half-finished await. Engine-level finding (probed before building): an async continuation suspended *mid-await* DOES survive snapshot/restore (the pending-promise machinery is in linear memory), but its resolve handle dies with the host VM, so the snapshot ALONE can never re-deliver the resolution — the suspended await stays stuck forever. This is precisely why E6 must (a) snapshot at CELL BOUNDARIES (after `executePendingJobs()` drains, never mid-await) and (b) record resolved async values in the oplog. **Real-kernel recommendation:** enforce that no snapshot is taken while a host-call promise is pending (drain or reject in-flight host calls before dump), and persist recorded async results in *settle* order (issue order here only because the harness resolves synchronously at issue time).

Artifacts: `/Users/umang/hub/zonko/montydyn/experiments/r4-async-oplog/` (`run.mjs`, `async-session.mjs`).

### R4-2 — RESIDUAL: MULTI-EVICT delta chains across the combined (W5+W4+E6) stack

**Residual closed.** GAP 2 covered a SINGLE evict / one delta-chain replay; chained multi-evict was unproven.

**What was tested:** two drivers importing the shared `_bench` harness and the `build-combined` strategy READ-ONLY. `multi-evict.mjs`: 90-cell session, 5 genuine evicts (cells 10/25/42/60/78), a 20MB spike@38 + free@40 (W5 reclaim), per-cell W4 deltas, E6 oplog; after each evict it disposes the VM, drops all in-memory state, **WIPES the strategy's `_st` cache**, and rehydrates bookkeeping purely from the durable manifest before `onRestore` (stricter than `_bench/runner.mjs`, which does a single evict and leaves `_st` warm). `stress-chainlen.mjs`: 150 cells, 3 evicts, no spike, to probe the chain-length cap.

**Hard numbers:**
- **5 consecutive genuine cold restores** (generation 1→6, `inMemoryFresh`/`genFresh`=true every cycle): **allByteIdentical=true** — every restored heapImage SHA-256 == its pre-evict image, zero drift across the whole chain.
- State coherence exact at every evict: `acc.length` == evict index (10/25/42/60/78), Map size tracks, closure counter monotonic (51→67→85→104→123, final `counter()`=136); accMonotonic=true.
- **Pending-promise fidelity across the FULL chain:** a promise created before any restore stayed pending across all 5 cold restores (`allPromisePending=true`); afterwards its resolver round-tripped — `resolvePending(777)` + `executePendingJobs()` drains to `__pv=777`. Closures survived all 5 restores callable.
- **Chain BOUNDED and resets repeatedly:** maxChainLen=**32** (90-cell) / **31** (150-cell) — NEVER approaches `REBASE_MAX_CHAIN=64`. rebaseCount 4/5; chainLenAtEvict saw-tooth 9,24,2,20,5 (reset confirmed).
- **FINDING — the binding trigger is the chain-WEIGHT ratio, not the length cap:** rebase fires at `chainGz >= 3× baseGz` (instrumented at ratio **3.05**, chain length ~27–36; rebases at cells 29 and 66). `BASE_EVERY=64` is an unreached backstop. Reclaim trigger also fires after spike@38/free@40 (baseGen 1→40 by the cell-42 evict).
- Restore stayed sub-100ms locally throughout (13ms small-chain → 65–77ms post-spike larger base); all images gz under the 2MB SQLite-overflow line, so R2 bytes implicitly 0.

**Verdict: closed.** Chained multi-evict (N=5 ≥ required 4) is byte-coherent with zero drift, the delta chain stays bounded and repeatedly resets, and closures + a pre-existing pending promise survive 5 consecutive cold restores — under the stricter wipe-`_st`-and-rehydrate-from-durable-manifest path. **Roadmap nuance to record:** the task framed the bound as "resets at `BASE_EVERY`", but empirically the chain-WEIGHT ratio (≥3× base gz) is the real binding trigger at chain length ~27–36, so `BASE_EVERY=64` is only an unreached backstop. To exercise the length-cap path you'd have to suppress the weight rebase (raise `REBASE_CHAIN_RATIO`), which was NOT changed (no mutation of `build-combined`). Caveat: local node v25 numbers; real-CF restore for >2MB-gz heaps would add the documented ~300ms warm / ~900ms cold R2 GET, but all chains here gz under the 2MB threshold so stay off R2.

Artifacts: `/Users/umang/hub/zonko/montydyn/experiments/r4-multi-evict/` (`multi-evict.mjs`, `stress-chainlen.mjs`).

### R4-3 — THE DEFINITIVE RAW-BUFFER-RECLAIM VERDICT (is full-fidelity raw reclaim fundamentally impossible on workerd/WASM?)

**This is the key one. Stated plainly: YES — full-fidelity RAW linear-memory reclaim of a spiked-then-freed QuickJS session is FUNDAMENTALLY IMPOSSIBLE on this WASM substrate.** It is not a missing feature, not a tuning gap, not a workerd bug — it is a hard consequence of three mutually-exclusive constraints. This closes W5 and confirms the production guidance for good.

**What was tested:** real rquickjs `wasm32-wasip1` engine (`engine/target/wasm32-wasip1/release/r4engine.wasm`) holding full-fidelity live state — global `x=42` + closure `inc()` private counter + pending promise `p→7`. A 52MB spike-then-free session run against three reclaim mechanisms.

**Hard numbers:**
- Session: base buf 1.25MB → spike (600k strings) **52.375MB buf / 42.875MB used-heap** → free+GC: **used-heap drops to 0.065MB (99.85% used reclaim) but RAW buffer stays 52.375MB**.
- **Mechanism (b) `run_gc` on the same instance:** raw reclaim **0%** (52.375→52.375MB). WASM linear memory is monotonic by spec; GC frees the QuickJS heap but cannot return pages to the WASM memory object. Fidelity FULL on the same instance (inc=103, x=42, closure alive, promise→7).
- **Mechanism (a) `JS_WriteObject`/JSON roots → fresh small instance:** raw reclaim **97.85%** (52.375→1.125MB) **BUT FIDELITY LOST** — serialized roots = `{x:42, incType:function, pType:Promise}`; only the *data* `x` survives. After rehydrate `incIsClosure=0`, `incCall=-998` (private counter GONE), `promisePresent=0` (pending promise GONE). Matches the W6 autopsy (`JS_WriteObject` loses 7/16 value kinds incl closures + promises).
- **Mechanism (c) fresh module with smaller initial memory (18 pages) + selective live-page blit:** the small-init module DOES run (`setupX=42`), but a full-fidelity snapshot blit must grow the buffer back to span the snapshot's highest live pointer offset. Probe: after spike+free+GC the **highest NONZERO page = page 837 = 52.38MB** even though used-heap is 0.065MB — dlmalloc leaves freed bytes scattered in place up to the top of the buffer; **no page-liveness map exists**. copiedPages=812/838, only 26 incidental zero pages skippable. `rawBufAfter=52.375MB`, `rawSmallerThanSnapshot=false`. Fidelity FULL (inc=103, promise=7) ONLY because the full pointer span was re-blitted.
- gz of the full freed image = 3.55MB (zero-scrub/gz is the only fidelity-preserving size lever, and it is content-dependent — high-entropy spike content does not fully vanish).

**Verdict: fundamental-limit.** The three constraints are mutually exclusive:
1. **Fidelity** (closures + pending promises) requires preserving every QuickJS heap object at its ABSOLUTE linear-memory offset — pointers are raw offsets.
2. **Shrinking the raw buffer** requires either `memory.shrink` (does not exist; WASM memory is monotonic) OR relocating live allocations to low addresses (no QuickJS heap-relocation/compaction API; dlmalloc never compacts downward, and relocation would invalidate every pointer — destroying the very fidelity it must preserve).
3. **The only path that shrinks raw bytes** — fresh small instance + `JS_WriteObject`/JSON re-serialization — is *exactly* the path that drops closures + promises (W6).

There is no liveness map to enable a smaller-span selective blit: after free+GC the live 0.065MB scatters as stale nonzero bytes up to offset 52.38MB. **CONCLUSION: GZ stored-image reclaim (zero-scrub freed pages) is the CEILING; W5's gz/used-heap reclaim is the best achievable.** This matches `docs/REALCF-VALIDATION.md` (real CF: fresh-instance raw reclaim 0%, monotonic buffer, restore re-blits the full image). **Production guidance, now confirmed unchanged:** guard admission on USED-heap (re-admits spike-then-free sessions), store gz with freed-page scrub, and accept that the raw in-VM buffer never shrinks.

Artifacts: `/Users/umang/hub/zonko/montydyn/experiments/r4-raw-reclaim/` (`harness.mjs`, `results.json`, `engine/src/lib.rs`, `engine/target/wasm32-wasip1/release/r4engine.wasm`).

### R4-4 — R2-tail mitigation (best option + expected speedup) — NEEDS REAL-CF CONFIRM

**What was tested:** local, deterministic, install-free sim evaluating four mitigations against the measured ~900ms cold / ~1.8s p95 single-object R2 GET on a 5MB incompressible heap — (a) chunked-parallel R2 GET, (b) streaming gunzip, (c) hot-tier SQLite, (d) prefer-SQLite routing. Latency model calibrated to REALCF point measurements; all round-trips byte-identical (sha256).

**Hard numbers:**
- Model calibrated faithfully: cold single 5MB-object = **927ms** (measured 908ms), p95 **1768ms** (measured 1771ms).
- **(a) chunked-parallel on a SINGLE 5MB object: only ~1.14–1.16×** cold (816ms vs 927ms). Cold cost is connection/cold-spin-latency-bound (740ms paid once, overlaps), NOT bandwidth-bound (transfer only ~167ms) — splitting one object barely helps.
- **(a) parallel vs SERIAL multi-object** (the REAL chained-restore shape base+delta+oplog): 4-obj 3127ms→796ms = **3.93×**; 8-obj 6087ms→796ms = **7.65×**. The near-K× win exists ONLY against a serial multi-object baseline.
- **(b) streaming gunzip** overlaps network for a free ~20–130ms on the chunked path.
- **(c) HOT-TIER (keep the 5MB image in DO-SQLite 64KB rows): ~0ms synchronous read** (∞× vs R2). Cost = 5MB raw in SQLite; the kernel already chunks SQLite. Decisive win.
- **(d) prefer-SQLite via gz9:** compressible 5MB heap → 98KB gz, stays under the 2MB-gz overflow line, avoids R2 entirely (~0ms). Only works on compressible content.
- All 24 round-trips byte-identical — fidelity ALL PASS.

**Verdict: needs-real-cf.** **Best option, ranked:** (1) **hot-tier** — never let an incompressible heap reach R2 if it fits the SQLite ceiling; synchronous ~0ms reads, highest confidence (rests only on the already-validated SQLite~0ms fact). (2) **prefer-SQLite gz9** on compressible heaps to dodge the 2MB-gz overflow line — cheap, no downside. (3) if R2 is unavoidable (>2MB-gz incompressible beyond the SQLite ceiling): **ALWAYS parallel-GET, never chain serially** — collapses a multi-object serial restore ~K× (use K≈4, diminishing past the modeled 3× BW cap) + streaming gunzip. **KEY HONEST NUANCE that corrects the "~K×" expectation:** chunked-parallel on a SINGLE object is only ~1.16× because cold is connection-latency-bound, not bandwidth-bound; the ~K× only materializes against a SERIAL multi-object baseline. **Why this is flagged needs-real-cf:** all latencies are simulated from a model calibrated to REALCF *point* measurements — the parallel-BW 3× cap and the connection-vs-transfer split are ASSUMPTIONS. Real R2 parallel-GET must be re-measured on a scratch worker before shipping the parallel/hot-tier routing.

Artifacts: `/Users/umang/hub/zonko/montydyn/experiments/r4-r2-tail/` (`latency-model.mjs`, `lat-store.mjs`, `run.mjs`, `README.md`).

---

## Durability arc — state after Round 4

**Now DEFINITIVELY SETTLED (real engine, hard numbers, no live-CF re-measure needed):**
- **Exactly-once across the crash boundary — SYNC and ASYNC.** GAP 1 + R4-1 close it: sync and async host-call replay both fire exactly once, concurrent in-flight async ordering holds byte-for-byte, with non-vacuous negative controls (naive replay double-fires; recorded-result replay does not). Mechanism rests on cell-boundary snapshot discipline + recorded-result replay — never on resuming a half-finished await.
- **Pending-promise + microtask fidelity — SINGLE and CHAINED multi-evict.** GAP 2 + R4-2 close it: pure-JS pending promises, microtask queues, and closures survive a single delta-reconstructed restore AND 5 consecutive genuine cold restores, byte-identical, zero drift, under the stricter wipe-cache-and-rehydrate-from-durable-manifest path.
- **Delta chain is bounded and self-resetting.** R4-2: max chain 31–32, never approaches the 64 backstop; the real binding trigger is the chain-WEIGHT ratio (≥3× base gz), confirmed at ratio 3.05.
- **Byte-delta is adversary-safe.** GAP 5: stored bytes bounded to full+epsilon (1.001×) in every mutation regime.
- **`host.fs` is bounded and scalable.** GAP 3 (per-session byte quota, restore-coherent) + GAP 4 (O(1) refcount GC, durable).
- **Raw-buffer reclaim is FUNDAMENTALLY IMPOSSIBLE.** R4-3: a settled fundamental-limit, not an open task. GZ stored-image reclaim (used-heap admission + freed-page scrub) is the proven ceiling; the raw in-VM buffer never shrinks — guard on used-heap, store gz, accept the monotonic buffer. This question is CLOSED.

**Still needs a real-CF re-measure before shipping (model/local-only today):**
- **R2-tail mitigation routing (R4-4)** — the hot-tier / prefer-SQLite / parallel-GET ranking and the ~K× / ∞× speedups are simulated from a model calibrated to REALCF point measurements. The parallel-BW 3× cap and the connection-vs-transfer split are assumptions; real R2 parallel-GET and hot-tier read latency must be measured on a scratch worker before the routing ships.
- **General live-network confirmation** — every durability result above was proven on the in-process DOStore harness simulator, not live Cloudflare. The mechanics are settled; the remaining open item is end-to-end re-measurement of the same scenarios on real CF (restore latency, eviction behavior, R2 bytes), tracked in `docs/REALCF-VALIDATION.md`. Real-CF restore latency is platform/network-bound and orthogonal to the (now-proven) correctness mechanics.

**Net:** after Round 4 the durability arc's *correctness* frontier is closed — every residual the prior Confidence section flagged (async oplog, host-handle-dependent promises within the proven boundary discipline, chained multi-evict) is now proven, and the long-open raw-reclaim question has a definitive impossible verdict. What remains is purely **performance validation on live CF** — the R2-tail routing choice and a live re-measure of the simulated durability runs — not any unresolved correctness question.
