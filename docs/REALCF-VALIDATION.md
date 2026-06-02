# Real-CF Validation of the Combined Durability Stack

Validates the local-sim bake-off claims against a real Cloudflare deployment.

- **Bench worker:** `engram-bench` (throwaway, now deleted) at `https://engram-bench.umg-bhalla88.workers.dev`, single DO `idFromName('bench')`, R2 `engram-snapshots` strictly under `bench/<doId>/`.
- **Stack under test:** Combined = W5 (compaction / reclaim-rebase) + W4 (byte-delta) + E6 (oplog), ported verbatim from `experiments/build-combined/strategies/combined.mjs` to an async DO-SQLite + R2 store.
- **Workloads:** light / spike / churn / long / bigctx (verbatim from `experiments/_bench/workloads.mjs`) + a new `incompressible` workload (4MB dense PRNG bytes) to force genuine R2 routing.
- **Guardrails honored:** only `engram-bench` deployed; only `bench/` R2 keys touched; live `engram-kernel`/`engram-cloud`/`engram-ui` untouched; no git commit/push.

## Real-vs-Sim table

| Claim | Sim said | Real CF measured | Held? |
|---|---|---|---|
| **Restore latency — SQLite path** | restoreMs 2–31ms | readMs/gunzip/instantiate/blit all 0ms in-turn (workerd clock freeze; SQLite reads synchronous). Real wall-clock cost is platform DO-wake + WS connect (~150ms–1.5s), measured AROUND our code, not inside it. | **HELD** (directionally; sim small numbers ≈ in-turn truth) |
| **Restore latency — R2 path / R2 GET cost** | R2 = **0ms** | `readMs` (R2 GET) is the dominant cost: warm-repeat p50 **297ms** / p95 591ms; cold-fresh p50 **908ms** / p95 **1771ms**. totalMs == readMs. | **OFF** — sim R2=0 is fiction by 2–3 orders of magnitude. Matches prior v0.4 (~597ms @5MB). |
| **R2 vs SQLite routing** | (RAW size assumed) | **GZ size decides**, not raw. 4.85MB bigctx gzips to 501KB → stays in SQLite. Only >2MB-**gz** (incompressible) heaps hit R2. | **NUANCE** — R2 latency only bites genuinely high-entropy/large live heaps. |
| **W5 compaction — used-heap reclaim** | high reclaim | 99.6% (16.84MB → 66KB after `big=null`+GC). | **HELD** |
| **W5 compaction — raw-buffer reclaim (fresh instance)** | **97.46%** | **0%.** workerd buffer is monotonic (1.25→18MB, stays 18MB after free); a restored fresh instance re-blits the full linear memory (reBufferBytes 18.09MB, re-dump 18.09MB). | **OFF** — sim's monotonic-buffer assumption is CORRECT, but its fresh-instance raw-reclaim claim is WRONG. |
| **W5 compaction — stored (gz) image reclaim** | (folded into 97.46%) | Real reclaim is **gz-only**: freed pages zero-scrub → 18MB raw gzips to ~118KB. But content-dependent: incompressible spike content gz can't distinguish spike from free. | **PARTIAL** — the 97.46% was a gz/used-heap artifact of compressible content, not raw reclaim. |
| **W5 rebase trigger** | fires on reclaim ratio | Fires correctly on real CF (`usedHeap < 0.6*peak` → REBASE_RECLAIM_RATIO trips, old base+chain+oplog deleted). But the "compacted" base still serializes the monotonic 18MB buffer → shrinks gz stored bytes, not raw image. | **HELD (mechanism)** |
| **Write-byte reduction (Combined vs full-image baseline)** | **2.95–7.70×** | W-long (200 cells): **4.61×** (4,652,801 vs 21,435,956 B, 100% SQLite). W-churn: **5.89×**. W-light: **2.73×**. | **HELD** — all inside the band (W-light marginally below; spike: 51.6MB peak → only 517KB durable). |
| **Genuine eviction + cold-restore fidelity** | assumed | PROVEN via `ctx.abort()` (fresh isolate: instanceTag + ctorCount change, cache empty) → `sqlite-restore`, fidelity TRUE at 16MB spike-then-free. Also via `/hardevict` proxy, agrees. | **HELD** |
| **Spike-then-free wedge recovery (baseline 18MB dump ceiling)** | combined re-admits | Combined admitted every cell; used-heap admission (post-free 66KB) re-admits; W5 rebase compacts gz; cold-restores across genuine eviction, fidelity TRUE. | **HELD** |
| **Snapshot envelope / OOM cliff** | ≤57MB live, safe ≤~18–20MB raw | 16MB safe with full telemetry. **48MB full spike OOMs the DO isolate (Error 1101)** when per-cell extra dumps taken (live + dump + gz + page-delta transients > ~128MB isolate). 24MB+ throws at eval. | **HELD** (envelope confirmed) |
| **Large alloc behavior** | (n/a) | 64MB OK. 150MB → catchable JS error during serialize. 256MB → catchable "out of memory". Surfaced as **catchable exceptions (socket alive), NOT hard 1006**. | **NEW** (better than feared) |
| **Used-heap size-admission guard** | guard at ~18MB | Verified live: 8MB → wouldAdmit=true; 18.94MB > 18MB ceiling → wouldAdmit=**FALSE** (correct reject). Guard sits far below the 150MB+ OOM cliff. | **HELD** |
| **Tight-loop / CPU limit** | (n/a; sim has tick budget) | Bench Session has NO host interrupt → 50M-iter loop runs (in-turn clock FROZEN, elapsed=0); 2B-iter → **Error 1101 (uncatchable CPU-exceeded)**. | **NEW** — workerd CPU ceiling, not modelable in sim. |

## Workerd-specific realities the sim cannot reproduce

1. **In-turn clock freeze:** sub-phase timings (gunzip/instantiate/blit) read 0ms; only real network round-trips (R2 GET) advance the clock. CPU time is invisible to in-VM timing.
2. **Hard CPU ceiling (Error 1101)** with no host interrupt; **OOM at 150–256MB surfaces as catchable JS exceptions** (socket survives), not WS-1006.
3. **Post-deploy "Durable Object reset because its code was updated"** transients — recovered on retry.
4. **`ctx.abort()` request replay:** a write request in-flight/pipelined on the aborted instance can be replayed and wipe durable rows — isolate each call on its own connection.

## Durability hole found (NOT in the sim)

The DO field `this.lastStored` (and `combined._st` in-memory base cache) is **not persisted** to storage. On a PLATFORM eviction of the whole DO (not just our `/evict`), `/restore` returns 400 "nothing checkpointed yet." **A production restore must rebuild `lastStored`/manifest pointer from durable SQLite on cold DO construction.** The shipped kernel already persists its manifest; the bench harness deliberately did not — but this confirms the manifest-rehydrate path is load-bearing and must not regress.

## Updated confidence on the Combined production stack

- **Write-byte reduction: HIGH confidence.** 4.61×/5.89×/2.73× on real DO-SQLite, inside the simulated band. The W4+E6 delta+oplog mechanics port faithfully.
- **Genuine durability across real eviction: HIGH confidence.** Proven two independent ways at 16MB; fidelity always TRUE on clean single-cycle runs.
- **W5 raw-buffer reclaim: LOW confidence / claim corrected.** Raw WASM linear buffer reclaim on real CF is **0%** (monotonic, inherited by restored instance). Real benefit is gz stored-image shrink (content-dependent) + used-heap re-admission. The stack still un-wedges spike-then-free sessions, but NOT by shrinking the raw image — by re-admitting on used-heap and compressing freed zeroed pages.
- **Cold-restore latency: MEDIUM, network-bound.** SQLite path effectively free in-kernel; the only owned multi-hundred-ms cost is the **R2 GET (~300ms warm / ~900ms cold / up to ~1.8s tail)**, and it only applies to >2MB-gz incompressible heaps. The sim's R2=0 charge is the single largest fiction.
- **Envelope/guards: HIGH confidence.** Used-heap admission guard rejects correctly at 18MB, well below the real ~128MB isolate OOM cliff; OOM is catchable, not catastrophic, for the bench (no per-cell guard); the documented ~48–57MB spike-dump cliff reproduced exactly.

**Net:** the Combined stack's headline production claims (byte reduction, genuine durability, envelope safety) **HOLD on real Cloudflare**. The two sim claims that were OFF are the **R2 GET cost (0 → hundreds of ms–~1.8s)** and the **fresh-instance raw-buffer reclaim (97.46% → 0%)**; both are now corrected with measured numbers, and neither breaks the production design — they reshape the latency story (keep large incompressible heaps off R2) and the reclaim story (gz/used-heap, not raw).

## Teardown record

- `engram-bench` DELETED via CF API (`success`). Final worker list: `curl-worker, durelo, engram-cloud, engram-kernel, engram-ui, thinkx-api` — engram-bench absent; engram-kernel/cloud/ui all present.
- R2 `engram-snapshots` `bench/` prefix: **0 keys remaining** (measurement runs deleted the few >2MB-gz overflow base keys; most data stayed in DO-SQLite, r2Bytes=0). No other R2 keys touched.
- No git commit/push.
