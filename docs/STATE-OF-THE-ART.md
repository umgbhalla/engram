# Engram — State of the Art (decision record)

> The single map of the post-product exploration arc (2026-06): what is **proven**, what to **build**,
> what is **fundamentally impossible**, what is **dead**. Collapses 20+ research/experiment docs into one
> greenlightable decision. Every claim was built + measured locally; the load-bearing ones re-measured on
> real Cloudflare (`docs/REALCF-VALIDATION.md`). Nothing here touched `apps/` or the live workers.

---

## 1. The verdict in one paragraph

The kernel brain stays JavaScript — **proven correct, not lazy.** The WASM-heap-snapshot thesis is
re-validated from **3 independent engines** (quickjs-wasi C, rquickjs Rust, goja Go — all snapshot-
survive). Rewriting the brain into Rust/Go buys **zero capability** (the current engine already snapshots
at full fidelity, 21/21) and Go is too fat. The real work was never a language migration; it is the
**durability stack (W5+W4+E6) + sandbox API surface**, now built, compared, real-CF-validated, and
hardened. The deepest open pain — reclaiming a bloated session's memory — is now **definitively settled
as a fundamental limit**, which makes W5-as-corrected the best achievable.

---

## 2. Proven (built + measured)

```
   CLAIM                                        PROOF                                   CONFIDENCE
   ─────                                        ─────                                   ──────────
   WASM-heap snapshot = full fidelity           21/21 kinds round-trip (E5)             HIGH
   Combined stack (W5+W4+E6) byte reduction     2.95–7.70× vs full-dump (bake-off)      HIGH (real-CF held)
   genuine durability across evict→cold-restore 5/5 workloads + 5-deep multi-evict      HIGH
   E6 exactly-once (sync AND async host calls)  17/17 + 8/8, neg-controls double-fire   HIGH
   pending-promise fidelity over delta-restore  15/15 (bare/chain/await/Promise.all)    HIGH
   sandbox coherence invariant (staged commit)  39/39, neg-control tears                HIGH
   host.fs (R2/SQLite) + quota + refcount GC    22/22 + 29/29, O(1) rm                  HIGH
   durable seeded timers exactly-once           survives eviction, fires once (13/14)   HIGH
   envelope/guards on real workerd              18MB admit < ~128MB OOM cliff, catchable HIGH (real-CF)
   used-heap / gz reclaim                        99.6–99.85%                             HIGH (real-CF)
```

---

## 3. Recommended build (into `apps/kernel`, gated on owner OK + the verify gate)

Plan: `docs/COMBINED-STACK-INTEGRATION.md`. Staged, each reversible, each behind its gate on **real
workerd** with a version-rollback anchor:

```
   1. W5 compaction (gz/used-heap reclaim)   un-wedges the dump-ceiling P0 — biggest correctness win
   2. W4 byte-delta                          the bytes engine (~9× alone; ~3–8× in the bounded stack)
   3. E6 oplog tail                          crash recovery + engine-migration escape
   4. sandbox coherence + host.fs/timers/env the staged-commit discipline + the API surface
   5. R2-tail policy (hot-tier / prefer-SQLite/gz9)   keep restore-critical images out of R2
```

Ship W5 first — it closes a years-open bug. Never batch. Pre-existing live snapshots migrate via journal-
replay on first wake (engine-hash shifts) — expected, announce it.

---

## 4. Fundamentally impossible (proven, not just unbuilt)

```
   full-fidelity RAW-buffer reclaim        (round-4 r3) mutually-exclusive constraints: fidelity needs
                                           absolute linear-mem offsets; shrinking needs memory.shrink
                                           (doesn't exist) or relocation (breaks every pointer).
                                           GC reclaims used-heap 99.85% / raw 0%; JS_WriteObject shrinks
                                           97.85% but loses closures+promises. → gz/used-heap is the ceiling.
   mid-cell snapshot without engine change (chiwawa interprets the guest; only Asyncify — opt-in, defer)
   V8-isolate heap snapshot                 the original wall; the whole reason for WASM-QuickJS
```

---

## 5. Dead / parked (with the killing evidence)

```
   Rust-brain (rquickjs)   builds + snapshots on wasm32-wasip1, deployable on CF via the JS WASI shim —
                           but ZERO parity gain, AND hits the SAME raw-reclaim wall. Truly no reason. DEAD.
   Boa-brain               snapshottable (non-moving GC), but ~2× size, unproven parity, same wall. PARKED.
   Go/goja                 snapshots too, but 11–12MB wasm + 112MB heaps blow the ceiling. DEAD.
   JS_WriteObject snapshot loses 7/16 value kinds (closures/promises/host objs). DEAD.
   Wizer at runtime        build-time only; usable for E4 cold-create bake, not live snapshot.
   non-CF substrates       none beat the heap-image primitive on CF (Rivet/Sandboxes logical-only;
                           only off-CF Firecracker/E2B is better — different product).
   watch: WasmFX/typed-continuations in workerd → would unlock mid-stack snapshot. Not here yet.
```

---

## 6. Remaining (honest)

```
   needs owner OK     build the §3 stack into apps/kernel + deploy (touches live infra)
   needs real-CF      R2-tail mitigation deltas (hot-tier/chunked-parallel) — sim calibrated, not confirmed
   build-pipeline     W3 Asyncify real mid-eval (needs asyncify-compiled engine) — opt-in, defer
   marginal           E4 wizer-bake real-CF cold-create saving (~9.5ms; platform wake dominates)
```

---

## 7. Doc index (the arc)

```
   research    REWRITE-OPTIONS · PRIOR-ART · WASM-EXPEDITIONS{,-2}
   specs       DURABILITY-ROADMAP · W5-COMPACTION-PLAN · W4-BYTEDELTA-PLAN · SANDBOX-API
   built       DURABILITY-BAKEOFF (8 strategies) · HARDENING-LOG (gaps + round-4)
   validated   REALCF-VALIDATION (real-CF vs sim)
   integrate   COMBINED-STACK-INTEGRATION (PR-shaped kernel plan)
   this        STATE-OF-THE-ART (the decision record)
```

**Bottom line for the owner:** everything provable in experiments is proven. The product's JS-heaviness is
the cost of being the only durable live-namespace REPL on this substrate. The next real step is greenlighting
the W5→W4→E6 kernel build behind its real-workerd gate. There is no hidden better architecture — the search
was exhaustive and the floor is mapped.
