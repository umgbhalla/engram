# `_bench` — shared snapshot-strategy benchmark harness

One substrate so every snapshot strategy is measured fairly. All strategy builds
**import these modules** and implement the one interface below. Do **not** fork the
store, the session driver, or the workloads — fairness depends on a single substrate.

```
_bench/
  store.mjs        DO-storage sim (SQLite chunks + R2 dir, kernel routing rule, byte counters)
  session.mjs      QuickJS session driver + the STRATEGY interface + seeded clock/RNG
  workloads.mjs    the 5 standard workloads (deterministic, with fidelity checks)
  runner.mjs       runs a strategy over all 5 workloads, forces evict+cold-restore, emits metrics
  strategies/
    full-dump.mjs  trivial pass-through baseline (the fairness reference)
```

Install (already done): `bun add quickjs-wasi@3.0.0` (local `node_modules`). Run with node ≥20.

## The strategy interface (implement this exactly)

A strategy is a plain object:

```js
export const myStrategy = {
  name: 'page-delta',

  // Persist a checkpoint. Count every durable byte THROUGH `store` so bytesWritten is fair.
  //   prevImage : Uint8Array|null  previous checkpoint's heapImage (null on first / after evict)
  //   curImage  : Uint8Array       current VM heapImage (full serialized snapshot, raw/uncompressed)
  //   hostState : object|null      opaque host-side state (e.g. kv tool data) to persist
  //   store     : DOStore          the shared store
  //   ctx       : { key, generation }  stable session key + monotonic checkpoint counter
  // Returns: { stored, bytes }
  //   stored : any   opaque token you will receive back in onRestore (e.g. {key, baseKey, deltaKeys})
  //   bytes  : number  bytes written THIS checkpoint (informational; runner trusts store.stats())
  onCheckpoint(prevImage, curImage, hostState, store, ctx) { /* ... */ return { stored, bytes }; },

  // Cold-restore. Receives the token from the LATEST onCheckpoint.
  //   stored : any     the token from the last onCheckpoint
  //   store  : DOStore the shared store
  //   ctx    : { key, generation }
  // Returns: { image, hostState }
  //   image     : Uint8Array  a heapImage BYTE-IDENTICAL to the curImage that was checkpointed
  //   hostState : object      round-tripped host state
  onRestore(stored, store, ctx) { /* ... */ return { image, hostState }; },
};
export default myStrategy;
```

### Contract rules

1. **Full fidelity required.** The `image` returned by `onRestore` must deserialize to a
   VM that produces the same `workload.check` value. The runner deep-compares to
   `workload.expected`. A strategy that loses closures/promises/state fails the gate.
2. **A `heapImage`** is `QuickJS.serializeSnapshot(vm.snapshot())` — a versioned binary
   buffer that already contains the FULL linear memory. Deltas/page-diffs operate on these
   bytes; you reconstruct a full image in `onRestore`.
3. **Count all writes through `store`.** Use `store.putSnapshot(key, raw)` (applies the
   kernel rule: gzip → <2MB SQLite chunks else R2 overflow) or the low-level
   `store.putRaw / store.getRaw` for already-compressed/delta blobs. Never write to disk
   directly — `store.bytesWritten` is the fairness metric.
4. **`ctx.key` is your namespace.** Derive all storage keys from it so strategies don't collide.
5. **`onCheckpoint` is called after EVERY cell** (per-cell durability, like the kernel).
   `onRestore` is called once, mid-workload, after a genuine evict.

## Store API (`store.mjs`)

- `new DOStore({ r2Dir })` — `r2Dir` is a filesystem dir backing simulated R2.
- `putSnapshot(key, rawBytes) -> { bytes, where, gzBytes }` — gzip + kernel routing
  (`<2MB gz` → SQLite 64KB chunks; `>=2MB gz` → R2). Inverse: `getSnapshot(key) -> rawBytes|null`.
- `putRaw(key, finalBytes, {forceR2}) -> { where, bytes }` / `getRaw(key)` — verbatim
  (no gzip), for delta rows / pre-compressed blobs. Routes by size unless `forceR2`.
- `deleteSnapshot(key)`, `stats()`, `resetCounters()`.
- Counters: `bytesWritten` (durable in), `bytesRead`, `sqliteBytes`, `r2Bytes`, put/get/deleteCount.
- Constants: `CHUNK_BYTES` (64KB), `R2_OVERFLOW_GZ_BYTES` (2MB). Helpers: `gz`, `gunzip`.

## Session API (`session.mjs`)

`new Session({ seed, clockMs, interruptBudget })`, then `await create()`. Methods:
`eval(src)` (sync global eval → host-dumped value), `dump() -> heapImage`,
`await restore(heapImage)` (builds a brand-new VM instance — genuine cold restore),
`dispose()`, `usedHeap()`, `bufferBytes()`, `.generation` (bumps on each restore).
Clock + RNG are seeded via WASI overrides (xorshift32 + fixed epoch) so snapshots are
byte-deterministic across strategies.

## Workloads (`workloads.mjs`)

`allWorkloads()` returns all 5. Each: `{ name, cells:string[], check, expected, evictAfter }`.

| workload   | shape | evictAfter |
|------------|-------|-----------|
| W-light   | 50 small cells: accumulator + closures + array | 25 |
| W-spike   | grow ~48MB strings then free | 4 (post-free) |
| W-churn   | 30× alloc ~2MB / free | 15 |
| W-long    | 200 cells, steady object-graph growth | 100 |
| W-bigctx  | load >1MB context string, reference across restore | 3 |

## Runner (`runner.mjs`)

```
node runner.mjs [./strategies/your-strategy.mjs]
```

Per workload it: fresh session → eval cells (checkpoint after each) → at `evictAfter`
disposes the VM + drops in-mem host state → `onRestore` → cold-restore into a NEW VM →
finishes cells → evals `check` vs `expected`.

Emitted metrics (per workload): `bytesWritten`, `writeAmp` (= bytesWritten / heapDelta in
used-heap bytes), `restoreMs`, `peakImage` (max raw heapImage seen), `fidelityPass`,
plus `restoredGeneration`/`inMemoryFresh` proving the restore was genuine.

Programmatic: `import { runAll, printTable } from './runner.mjs'` then
`printTable(await runAll(myStrategy))`.

## Baseline (full-dump) numbers

Reference run (`node runner.mjs`, node v25, macOS). Match this interface and beat these
on `bytesWritten` / `writeAmp` without losing fidelity:

| workload  | bytesWritten | writeAmp   | restoreMs | peakImage | fidelity |
|-----------|--------------|-----------|-----------|-----------|----------|
| W-light  | 4.74MB       | 1074.19x  | 2.4ms     | 1.25MB    | PASS    |
| W-spike  | 679.3KB      | 0.01x     | 21.6ms    | 49.25MB   | PASS    |
| W-churn  | 2.98MB       | 13520.74x | 2.9ms     | 3.19MB    | PASS    |
| W-long   | 19.90MB      | 821.16x   | 2.3ms     | 1.25MB    | PASS    |
| W-bigctx | 1.07MB       | 3304.60x  | 3.6ms     | 4.63MB    | PASS    |

Notes:
- restoreMs is local in-process (no network); on real CF it is network/platform-bound.
  Use it only for *relative* strategy comparison.
- W-spike's huge `peakImage` (49MB raw) gzips below 2MB (repetitive data) so it stays in
  SQLite; an incompressible spike would route to R2 — the store's R2 branch is verified.
- writeAmp is huge for full-dump because it re-writes the whole image every cell while the
  per-cell used-heap delta is tiny — that is exactly the inefficiency delta strategies target.
