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
