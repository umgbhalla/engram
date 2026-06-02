# W4 — Fine-Grain Byte-Delta Durability: Implementation Plan

> Cuts per-checkpoint durable writes by persisting only the **changed bytes** since the last full
> snapshot, not the whole heap image. Proven in `docs/WASM-EXPEDITIONS-2.md` (W4): a **256-byte grain**
> diff stores **295 KB gz** where a full dump stores ~1 MB+ — **~3× less than the E6 oplog**, with
> **zero re-fire** (it is pure memory bytes, not replayed side-effects). Coarse 64KB page-delta was a
> dead-end (QuickJS scatters small mutations across many pages → almost every page dirty).
>
> Status: PROVEN in prototype, NOT built. Spec only. Composes with W5 (compaction) + E6 (oplog).

---

## 1. The idea

```
   full dump every cell        ████████████████  ~1MB+ gz each, write-amp 39.5×
   byte-delta                  ██░░░░░░░░░░░░░░░  base snapshot + tiny per-cell delta
                                 │
                       delta = the changed 256B chunks vs the previous image, gzipped
```

Most cells touch a small fraction of the heap. Storing the whole image each time is the
write-amplification pain (proven 39.5× in E6). A byte-delta stores only what moved.

---

## 2. Mechanism — content-chunked delta

```
   keep: lastImage (the bytes as of the previous checkpoint)
   on checkpoint:
     ┌ split current memory.buffer into fixed 256B chunks ┐
     │ for each chunk i: if chunk != lastImage chunk i     │  → emit (i, bytes)
     └─────────────────────────────────────────────────────┘
     store: gzip(concat of changed chunks + their indices)
     update lastImage = current
   on restore:
     base full-snapshot + apply each delta in order → reconstructed image → blit
```

**Grain = 256 bytes** (W4-proven sweet spot): finer than a 64KB page (QuickJS mutations are small +
scattered), coarse enough that the index overhead stays small. Measured 256B = 295KB gz vs full ~1MB.

```
   GRAIN     stored (gz)   verdict
   64 KB     ~near-full    dead (every page dirty)
   1 KB      ~middling     ok
   256 B     295 KB        ★ best (W4)
```

---

## 3. How it stacks with W5 + E6 (the durability trio)

```
   ┌ W5 compaction ┐   shrinks the BASE image (kills monotonic bloat)        → smaller deltas too
   ┌ W4 byte-delta ┐   shrinks each CHECKPOINT (only changed bytes)          → the per-cell win
   ┌ E6 oplog      ┐   crash TAIL between checkpoints + engine-migration     → the recovery net
   ────────────────────────────────────────────────────────────────────────────────────────────
   full snapshot every N cells (compacted) + byte-delta per cell + tiny oplog for the uncommitted tail
```

W4 is the steady-state write reducer; W5 keeps the base small; E6 covers the gap since the last delta.
They are orthogonal — no conflict. Recommended cadence: full (compacted) snapshot every N cells,
byte-delta each cell in between, oplog for in-flight host calls.

**Key advantage over the E6 oplog alone:** byte-delta has **zero re-fire** — it restores exact bytes,
preserving the no-replay / no-re-fired-side-effects guarantee that the oplog window technically
relaxes. Prefer byte-delta as the primary per-cell mechanism; keep the oplog only for the
sub-checkpoint crash tail + engine migration.

---

## 4. Integration points (apps/kernel, when built)

```
   glue.js   dump()        add delta mode: diff vs retained lastImage, emit (changedChunks, indices)
             restore()     reconstruct = base + ordered deltas, then blit
             keep lastImage in the DO (host-side) across cells — it is NOT in the VM heap
   lib.rs    snap_chunks   already chunked; add a delta-row type {base_id, delta_seq, indices_blob}
             snap_manifest add: base_snapshot_id, delta_count
             checkpoint    write delta rows; periodic full (compacted) snapshot resets the base
```

Reconstruction is deterministic + content-exact → seeded determinism preserved (zero entropy added).

---

## 5. Verify gate

```
   1. round-trip: 50-cell session, byte-delta each cell, restore = byte-identical to full-dump baseline
   2. write reduction: measure total stored bytes vs full-dump baseline (target ≥3× less, per W4)
   3. base reset: every N cells a full (compacted) snapshot; restore from {base + deltas after it}
   4. crash mid-delta: partial delta write → restore falls back to last complete checkpoint (atomic)
   5. evict→cold-restore: delta-chain session cold-wakes, state intact
   6. determinism: byte-identical snapshots preserved (delta is exact bytes, no entropy)
   7. compose with W5: compacted base + deltas restores correctly
```

---

## 6. Risk ledger

```
   ⚠ med   index overhead if mutations become dense (large array fills) → delta approaches full size
           → mitigation: if delta > X% of full, store a full snapshot instead (auto-fallback)
   ⚠ med   lastImage retention cost: the DO must hold the previous image to diff against
           → it is host-side memory, dropped on evict; on cold wake the base is re-read from store
   ✓ low   correctness — content-exact reconstruction, deterministic
   ✓ low   determinism — exact bytes, zero entropy
   net: pure efficiency win, no correctness/fidelity cost; the only failure mode (dense mutation)
        auto-falls-back to a full snapshot. Build after W5 (so the base is already compact).
```

---

## 7. Sequence

```
   W5 compaction  ─▶  W4 byte-delta (this)  ─▶  E6 oplog tail  ─▶  W3 asyncify  ─▶  E4 wizer-bake
   small base         small per-cell delta       crash tail        mid-cell        cold-create
```

Build after W5 — a compacted base makes deltas smaller and the base-reset cadence cheaper. Owner OK +
§5 gate (esp. real-workerd write-reduction measurement) required before any deploy.
