# W5 — Fresh-Instance Compaction: Implementation Plan

> Un-wedges the deepest open P0 (BUG-2/4): **WASM linear memory is monotonic — it never shrinks.**
> A session that spikes to tens of MB then frees keeps a high-water-mark image forever, eventually
> failing the 18MB dump ceiling and becoming un-checkpointable (`SizeAdmissionError`) — permanently
> wedged. Proven solvable in `docs/WASM-EXPEDITIONS-2.md` (W5): discard the bloated instance, rehydrate
> live state into a **fresh small instance** → **48.88MB → 1.50MB reclaimed (96.9%)**.
>
> Status: PROVEN in prototype, NOT yet built into `apps/kernel`. Spec only. Build gated on owner OK +
> evict→cold-restore regression (per the session goal guardrails).

---

## 1. The problem, precisely

```
   cell N    spike to 48MB  ████████████████████████  buffer grows (memory.grow)
   cell N+1  free it        ░░░░░░░░░░░░░░░░░░░░░░░░░  used heap drops, BUFFER STAYS 48MB
                                       │
                            dump guard reads BUFFER (18MB ceiling) ⇒ SizeAdmissionError
                                       │
                            session can never checkpoint again ⇒ WEDGED
```

`memory.grow` is one-way; QuickJS `dlmalloc` does no downward compaction (proven, EXP/v0.2). The
existing used-heap admission guard lets a spiked-then-freed session *run*, but the **dump** still
operates on the monotonic `memory.buffer`, so the image stays at high-water-mark.

---

## 2. The fix — compaction escape hatch

A fresh WASM instance starts at the minimum memory size. So: when a session's buffer is bloated but
its *used* heap is small, **migrate the live state into a brand-new instance and discard the old one.**

```
   ┌ bloated instance (48MB buffer, 1.5MB used) ┐
   │  live roots: globals, closures, promises    │
   └───────────────────┬─────────────────────────┘
                       │  compact()
                       ▼
   ╭ capture live state ╮   how = the SAME proven snapshot, NOT a re-serialize:
   ╰─────────┬──────────╯   the heap IMAGE is correct; the problem is only its SIZE.
             ▼
   ┌ fresh instance (1.5MB) ┐  blit ONLY the live pages, drop the freed slack
   └────────────────────────┘
```

### The mechanism (decided): scrub-then-fresh-blit, not logical re-serialize

W5 proved the reclaim. The fidelity-safe mechanism is **NOT** `JS_WriteObject` (autopsy W6: loses
7/16 value kinds — closures, promises, host objects). It is the **existing heap-blit into a fresh
instance**, combined with the existing **arena scrub**:

1. `_scrubArena()` (already in glue) zeroes freed slack so the freed pages gzip to ~nothing.
2. On the **next cold restore**, the fresh instance is created at minimum size and the heap image is
   blitted back — **the restored instance does not inherit the old buffer's grown size unless the
   image itself demands it.** This is the key W5 insight: the bloat lives in the *running* instance's
   grown buffer, not in the restored image, *if* the dump captures only the live extent.

So the fix is two coordinated changes:

```
   ┌ A. dump captures live-extent, not full grown buffer ─────────────────────┐
   │   today: dump = entire memory.buffer (monotonic high-water-mark)          │
   │   fix:   dump = pages [0 .. last-live-page]; scrubbed slack gzips away,    │
   │          AND record the minimal initial memory size for restore           │
   └───────────────────────────────────────────────────────────────────────────┘
   ┌ B. restore instantiates at the MINIMAL size, grows only if needed ────────┐
   │   fresh instance starts small; blit live pages; the 48MB is never reborn   │
   └───────────────────────────────────────────────────────────────────────────┘
```

If the live extent itself is still > ceiling (genuinely large working set, not freed slack), the
session is legitimately too big — that is the documented envelope limit, not the wedge.

### Fidelity gap → covered by the oplog (E6)

If any pointer-into-buffer assumption breaks across a size-changed re-instantiation (it should not —
QuickJS pointers are offsets into linear memory, and W5 showed the blit survives), the **E6 oplog**
is the safety net: on a failed compaction round-trip, fall back to replaying the retained cell/host-call
oplog into a fresh instance. Compaction and oplog compose.

---

## 3. Trigger policy

```
   compact WHEN:  bufferBytes > COMPACT_TRIGGER (e.g. 12MB)
              AND usedHeap / bufferBytes < 0.4   (≥60% slack — freed spike)
              AND a cell boundary (never mid-cell)
   skip WHEN:  usedHeap itself near ceiling (legitimately big, can't help)
```

Cost: compaction = one extra instantiate + blit (~sub-ms per W5/E5 numbers) at a cell boundary.
Run it opportunistically before the dump when the slack ratio trips, so the *stored* image is small.

---

## 4. Integration points (apps/kernel, when built)

```
   glue.js   _scrubArena()          already exists — extend to compute live-extent page count
             dump()                 emit live-extent image + minimalInitialPages in manifest
             restore()              instantiate at minimalInitialPages, grow-on-demand
             new: _compactIfWedged() cell-boundary trigger check
   lib.rs    snap_manifest          add column: initial_pages (restore instantiation size)
             (no other Rust change — checkpoint/commit path unchanged)
```

Crash-atomicity unchanged: compaction happens *before* the checkpoint commit, so a crash mid-compaction
just leaves the previous good checkpoint.

---

## 5. Verify gate (mandatory before any deploy)

```
   1. unit: spike 48MB → free → compact → assert bufferBytes drops, usedHeap identical
   2. fidelity: closure + pending promise + Map/Set/typedarray survive a compaction round-trip
   3. THE wedge test: spike past 18MB ceiling → free → compact → checkpoint SUCCEEDS
      (today: SizeAdmissionError; after: clean checkpoint) — reproduce BUG-2/4 then prove fixed
   4. evict→cold-restore: compacted session cold-wakes, state intact, image small
   5. regression: non-spiked sessions unaffected (compaction never triggers); smoke green
   6. seeded determinism: compaction adds zero entropy → byte-identical snapshots preserved
```

---

## 6. Risk ledger

```
   ✓ low   pointer survival across re-instantiation — W5 already proved blit survives
   ⚠ med   live-extent computation: must not truncate a live page (off-by-one = corruption)
           → mitigation: compute extent from QuickJS getMemoryUsage high-address, pad + verify
   ⚠ med   workerd may not honor a smaller initial `memory` on a module that previously grew
           → must test on real workerd, not just node, before trusting the reclaim in prod
   ✓ low   determinism — pure memory op, no entropy
   net: highest-value P0 fix in the roadmap; med risk concentrated in the live-extent math,
        fully covered by the verify gate + the E6 oplog fallback.
```

---

## 7. Sequence (within the durability roadmap)

```
   W5 compaction (this)  ─▶  W4 byte-delta  ─▶  E6 oplog tail  ─▶  W3 asyncify opt-in  ─▶  E4 wizer-bake
   un-wedge the P0           ~3× less write    crash tail          mid-cell preempt        faster cold
```

W5 first: it closes a years-open correctness bug (a session *cannot recover* today). The rest are
efficiency. Build only on owner OK with the §5 gate green on real workerd.
