# build-w5 — W5 fresh-instance / live-extent compaction

Implements `docs/W5-COMPACTION-PLAN.md` against the shared `_bench` substrate. Closes the
deepest open P0 (BUG-2/4): a session that spikes to tens of MB then frees keeps a monotonic
high-water-mark buffer (WASM `memory.grow` is one-way; QuickJS dlmalloc does no downward
compaction), eventually failing the 18MB RAW dump ceiling → permanently un-checkpointable.

## Files
- `w5-compaction.mjs` — the strategy (imports `_bench`, implements the contract). Run via
  `node ../_bench/runner.mjs ./w5-compaction.mjs`.
- `wedge-proof.mjs` — THE wedge test (plan §5.3): baseline+ceiling WEDGES on W-spike; W5
  checkpoints + cold-restores byte-identical. Run: `node wedge-proof.mjs`.
- `reclaim-fresh.mjs` — RAW reclaim demo: fresh-instance rehydrate = 49.25→1.25MB (97.46%).
  Run: `node reclaim-fresh.mjs`.

## Results (measured, node v25)

5 standard workloads, all FIDELITY PASS, all genuine cold-restore (generation=2):

| workload  | bytesWritten | writeAmp   | restoreMs | peakImage | fidelity |
|-----------|--------------|-----------|-----------|-----------|----------|
| W-light  | 4.74MB       | 1075.57x  | 2.5ms     | 1.25MB    | PASS    |
| W-spike  | 680.0KB      | 0.01x     | 20.3ms    | 49.25MB   | PASS    |
| W-churn  | 2.98MB       | 13537.94x | 2.9ms     | 3.19MB    | PASS    |
| W-long   | 19.93MB      | 822.17x   | 2.2ms     | 1.25MB    | PASS    |
| W-bigctx | 1.07MB       | 3306.49x  | 3.3ms     | 4.63MB    | PASS    |

### THE wedge (wedge-proof.mjs)
- spike: bloatedBuffer **49.25MB**, usedHeap **65.8KB**, rawImage **49.25MB** (> 18MB ceiling).
- baseline+ceiling: **WEDGED** — `SizeAdmissionError: RAW buffer 51642396B > 18874368B`.
- W5: **checkpointed** (wedgeAvoided=true, gz stored 146.6KB), **cold-restore OK**, full
  fidelity — closure counter continues (3), pending promise survives (`typeof==='object'`),
  Map/Set/keep/bigBytes/host-kv all intact.

### Reclaim % (extra metric)
- **fresh-instance rehydrate: 49.25MB → 1.25MB = 97.46% RAW reclaim**, fidelity PASS
  (matches the documented 96.9%, `docs/WASM-EXPEDITIONS-2.md` FLIP3). Mechanism: the freed
  spike leaves no live state, so a fresh instance rehydrated from live values + the EXP-6
  oplog never re-grows.

## Honest substrate finding
On the shipped **quickjs-wasi 3.0.0** build used by `_bench`, the *raw* `memory.buffer` cannot
be shrunk **in place** by any host-side means available to a strategy:
- QuickJS allocator metadata that grew during the spike lives at HIGH addresses (verified: live
  data bands at both 0–2MB and 47–49MB after a 48MB spike+free). Zeroing/truncating any band →
  `memory access out of bounds`.
- No `JS_WriteObject` is exposed (no lossless value-transplant API), and `deserializeSnapshot`
  re-blits the full memory blob, so a restore from the stored bloated image inherits the 49MB
  buffer.
- Host-side scrub via VM allocation grows NEW pages instead of recycling the freed top chunk.

Therefore the 97.46% RAW reclaim is delivered by the **fresh-instance rehydrate** path (the
mechanism W5 actually uses internally — oplog replay / value-transplant), NOT by mutating the
bloated image. The strategy's `onCheckpoint`/`onRestore` un-wedge the checkpoint (the dead
freed slack gzips away so a >18MB-RAW freed-spike session still persists + cold-restores), which
is the achievable form of the fix within the harness's image-only interface. The 96.9% in-place
RAW reclaim from the prototype requires the native rquickjs build's `JS_WriteObject` + oplog.
