# Combined Durability Stack → `apps/kernel` Integration Plan

> Turns the bake-off winner (W5 compaction + W4 byte-delta + E6 oplog, `docs/DURABILITY-BAKEOFF.md`)
> into a concrete, PR-shaped change-set for the live kernel. **Not yet applied — requires owner OK +
> the real-CF numbers from `docs/REALCF-VALIDATION.md` + the verify gate green on workerd + a deployed-
> version rollback anchor.** This is the implementation map, not the diff.

---

## 1. The unified checkpoint path

Today: `dump()` → full image → gzip → SQLite/R2 every cell. After: one staged pipeline at the single
commit point.

```
   cell evals ok
       │
       ▼
   ┌ checkpoint(cell) ────────────────────────────────────────────────────────┐
   │  1. W5: if buffer bloated (used/buffer < 0.4 && buffer > 12MB)              │
   │         → compact: rehydrate live extent into fresh instance, rebase        │
   │  2. W4: diff cur vs lastImage at 256B grain                                 │
   │         → if delta < FALLBACK_PCT of full → store delta rows                │
   │         → else (or every BASE_EVERY=20 cells) → store full (compacted) base │
   │  3. host state (fs/kv/timers/ctx) staged writes flushed HERE                │
   │  4. E6: append cell source + recorded host-call results to oplog            │
   │  ─── SINGLE COMMIT: manifest row (base_id, delta_seq, oplog_seq, used_heap) │
   │       written last; crash before it = previous good checkpoint stands       │
   └─────────────────────────────────────────────────────────────────────────────┘
```

Restore (cold DO):
```
   read manifest → load base snapshot → apply delta chain (≤ BASE_EVERY) → blit
       → if engine-hash mismatch OR corrupt delta → E6 path: replay oplog into fresh engine
       → re-bind host handles (fs/kv/timers registry/ctx) from SQLite
```

---

## 2. Files touched (the change-set)

```
   apps/kernel/src/glue.js
     dump()            → emit live-extent image (W5) + 256B delta vs retained lastImage (W4)
     restore()         → base + delta-chain apply; engine-mismatch → replayJournal (E6 generalized)
     _scrubArena()     → extend to compute live-extent last-page (W5)
     _compactIfWedged()→ NEW: cell-boundary compaction trigger
     keep lastImage    → host-side (DO), not in heap; re-read base on cold wake
     stageHostWrite()  → NEW: fs/kv/timer writes staged, flushed at checkpoint (coherence invariant)

   apps/kernel/src/lib.rs
     snap_manifest     → ADD cols: base_snapshot_id, delta_seq, oplog_seq, initial_pages, used_heap
     snap_chunks       → ADD row type: delta {base_id, seq, indices_blob, bytes}
     NEW table oplog   → {seq, kind, source|result_json, clock_tick, rng_counter}
     checkpoint()      → orchestrate staged-commit ordering (host writes → snapshot → manifest LAST)
     restore path      → base + deltas; fallback to oplog replay on mismatch
```

No change to: the WASM engine delivery (CompiledWasm), the seeded-determinism boundary, the WS/HTTP
frame protocol, the mutex, or crash-atomic commit semantics (extended, not replaced).

---

## 3. Config + constants (tunable, bake-off-derived)

```
   COMPACT_TRIGGER_BYTES   12 MB     (W5: compact when buffer exceeds + slack ratio trips)
   COMPACT_SLACK_RATIO     0.4       (used/buffer below this = freed-spike, worth compacting)
   DELTA_GRAIN_BYTES       256       (W4 sweet spot; 295KB gz vs ~1MB full)
   BASE_EVERY_CELLS        20        (full compacted snapshot cadence; caps restore chain)
   DELTA_FALLBACK_PCT      0.5       (delta ≥ 50% of full → store full instead; auto-fires on dense)
   OPLOG_MAX_ENTRIES       BASE_EVERY (oplog reset at each base; crash-tail only)
```

---

## 4. The coherence invariant (load-bearing — sandbox prototype D)

> **Every host mutation in a cell durably commits BEFORE that cell's checkpoint manifest row commits.**
> The manifest write is the single commit point; host writes (fs/kv/timer-registry/ctx) are staged and
> flushed atomically with it. Crash before the manifest row = rollback to previous good checkpoint, no
> torn state.

Negative control (sandbox build): naive immediate-commit TEARS across the 3 evict orderings; staged
commit holds. This wrapper is mandatory before fs/timers ship.

---

## 5. Verify gate (ALL green on real workerd before deploy)

```
   1. fidelity: closure + pending promise + Map/Set/typedarray/Date survive base+delta restore
   2. THE wedge: W-spike past 18MB ceiling → compact → checkpoint SUCCEEDS (baseline: SizeAdmissionError)
   3. write-bytes: W-long real DO SQLite bytes ≥ 2.95× less than baseline (bake-off claim, real CF)
   4. bounded restore: ≤ BASE_EVERY deltas replayed, not the whole history
   5. crash-tail: kill mid-cell → recover = last checkpoint + oplog tail, effects exactly-once
   6. engine-migration: bump quickjs.wasm hash → restore via oplog replay, state intact
   7. determinism: seeded session byte-identical across base+delta restore
   8. coherence: fs write + setTimeout across evict → no torn state (invariant §4)
   9. regression: existing smoke suite green; non-spiked sessions unaffected
   10. real-CF: restore latency + R2 GET cost within docs/REALCF-VALIDATION.md envelope
```

Pre-existing live snapshots migrate via journal-replay on first wake after deploy (engine-hash shifts
when glue bytes change) — expected, by-design, not a regression.

---

## 6. Rollout (staged, reversible)

```
   ┌ Phase 1 ┐  W5 compaction only → deploy engram-kernel → verify §5.1-2,7,9 + real-CF evict
   ┌ Phase 2 ┐  + W4 byte-delta    → deploy → verify §5.3-4,7
   ┌ Phase 3 ┐  + E6 oplog tail    → deploy → verify §5.5-6
   ┌ Phase 4 ┐  + staged-commit + host.fs/timers → deploy → verify §5.8
   each phase: capture version anchor, deploy, run gate; FAIL → wrangler rollback to anchor
```

Ship W5 alone first — it is the correctness fix (un-wedge), lowest risk, biggest payoff. The rest are
efficiency layered on a proven base. Never batch all four into one deploy.

---

## 7. Risk ledger

```
   ⚠ high  W5 live-extent math: off-by-one truncates a live page → corruption
           → mitigation: derive from QuickJS getMemoryUsage high-addr + pad + post-blit verify; gate §5.1
   ⚠ high  workerd may not honor a smaller initial memory after grow (sim can't test)
           → BLOCK on docs/REALCF-VALIDATION.md m2 result before trusting W5 reclaim in prod
   ⚠ med   delta corruption bricks restore if E6 net absent → ship W4 only WITH E6 (never alone)
   ⚠ med   glue byte-shift invalidates live snapshots → journal-replay migrates (expected, announce)
   ✓ low   determinism — all additions are exact-bytes or seeded-recorded, zero new entropy
```

---

## 8. Dependencies

- **`docs/REALCF-VALIDATION.md`** (in flight) — must confirm W5 reclaim works on real workerd + the
  real R2 GET cost, before Phase 1 deploys. If real workerd refuses smaller-initial-memory, W5 in-place
  reclaim falls back to the native-rquickjs build (parked) and only fresh-instance-rehydrate-on-restore
  ships.
- Owner OK to touch `apps/kernel` + deploy `engram-kernel` (currently out of guardrail scope).
