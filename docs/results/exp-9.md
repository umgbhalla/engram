# EXP-9 results — crash-robustness + upgrade guard (real Cloudflare, JS DO)

**Date:** 2026-06-01 · **Branch:** `exp/9-crash-upgrade` · **Verdict: PASS ✅ (both hypotheses)**

Two robustness properties verified on production Cloudflare, on top of the proven
EXP-5a thesis (QuickJS namespace survives DO eviction via an R2 linear-memory snapshot):

1. **Crash-robustness via per-cell move-forward checkpoints** — an abrupt eviction
   with NO clean `onSleep`/final snapshot still restores from the **last per-cell
   checkpoint**; state recovers at the last *committed* cell, and an uncommitted
   in-flight cell is correctly lost (not silently half-applied).
2. **Upgrade guard via interpreter content-hash** — each checkpoint is tagged with
   the SHA-256 of the interpreter wasm module; a restore against a deliberately
   different (v2) engine hash is **rejected with a typed `EngineHashMismatchError`
   before any memory is blitted** (no crash, no corruption). A restore with the real
   hash still succeeds.

**Deployed worker:** `https://montydyn-exp9.umg-bhalla88.workers.dev`
**R2 bucket:** `montydyn-snapshots` (keys namespaced `exp9/<doId>/cell-<n>.qjs.gz`)
**DO binding:** `KERNEL_DO` (class `KernelDO`) · **Worker startup:** 15 ms · Upload 3207 KiB / gzip 1092 KiB.
**Engine content-hash:** `52d4a276b33757cf918207d05ac1ce02985cbf5415fdb735e67e93bcf826eb24`
(SHA-256 of `quickjs.wasm`; matches the local `shasum -a 256` — engine identity is
stable host→client→snapshot metadata).

## Design

- **Per-cell checkpoint.** `{t:'cell', cell:n, src}` evals a cell, then snapshots
  memory+globals → gzip → R2 `put` with R2 custom metadata `{engineHash, cell}`, and
  records a `checkpoints(cell, key, engine_hash, ...)` row in DO SQLite. Only AFTER
  the R2 put succeeds is `committedCell` advanced (SQLite `meta`). This is the
  move-forward commit: the recovery anchor is always the newest fully-durable cell.
- **Unclean crash.** `{t:'crash'}` drops `this.kernel` with NO final snapshot —
  models an abrupt eviction/hibernation where the host had no chance to do a clean
  shutdown snapshot. (We also have `{t:'cellNoCheckpoint'}` to run an in-flight,
  uncommitted cell first, so we can prove recovery does NOT pick it up.)
- **Cold restore** lazily restores from `#lastCommittedCkpt()` on the first eval
  after a crash — `checkpoint-restore` source, reporting `restoredFromCell`.
- **Upgrade guard.** Restore compares the checkpoint's stored `engine_hash` against
  the current engine hash (SHA-256 of the wasm bytes, imported as a `Data` module
  alongside the `CompiledWasm` module and hashed via `crypto.subtle.digest`). On
  mismatch it throws `EngineHashMismatchError` (`code: ENGINE_HASH_MISMATCH`,
  `expected`/`actual`) **before** the R2 get / deserialize / blit. The test injects a
  fake v2 hash via `expectHashOverride` to simulate a different engine build.

## Hypothesis 1 — crash-robustness ✅

Session `crash-…`, `generation` stays 1 (no DO reconstruct needed; the crash is the
in-memory kernel drop, which is the harder-to-fake but more deterministic case):

| Step | What | Result |
|---|---|---|
| cell 0 | `acc=0; step=()=>++acc` → checkpoint | committed cell 0, gz 99,785 B |
| cell 1 | `step();step(); acc` → checkpoint | value **2**, committed cell 1, gz 99,763 B |
| cell 2 | `step();step();step(); acc` **NOT checkpointed** | in-memory value 5, committedCell still **1** |
| crash | drop kernel, no clean snapshot | `droppedInMemoryKernel:true`, committedCell 1 |
| recover `acc` | first eval cold-restores | **2** (last committed), `source:checkpoint-restore`, `restoredFromCell:1` |
| recover `step()` | closure survived restore | **3** |

`acc===2` (NOT 5) proves recovery lands on the **last committed cell**, correctly
discarding the uncommitted in-flight cell — no silent partial application. The
post-restore `step()===3` proves the live closure namespace came back intact.
**Checkpoint restore latency: 1266 ms** (first cold R2 get + gunzip + restore in this
isolate; a warm-bucket restore in the guard test was **430 ms**, in line with EXP-5a's
~0.5 s). Snapshot size identical to EXP-5a: **1,245,212 B raw / ~99.8 KiB gzip**.

## Hypothesis 2 — upgrade guard ✅

Session `guard-…`: commit a checkpoint tagged with the real engine hash, then attempt
a forced cold restore pretending to be a v2 engine (fake hash `00…00`):

| Check | Expected | Got |
|---|---|---|
| restore against mismatched hash | rejected, typed error | `rejected:true`, `errorName:EngineHashMismatchError`, `errorCode:ENGINE_HASH_MISMATCH` |
| `expected` (snapshot's engine) | real hash | `52d4a276…eb24` |
| `actual` (pretended engine) | fake | `0000…0000` |
| memory blitted? | NO (clean reject) | `kernelStillNull:true` (kernel left untouched) |
| restore with REAL hash afterwards | succeeds, no corruption | `y===99`, `source:checkpoint-restore`, latency 430 ms |

The guard rejects cleanly **before** fetching/deserializing/blitting any bytes — so a
mismatched engine never gets a chance to misinterpret an incompatible heap. The guard
is also not over-broad: the same path with the correct hash restores normally.

## Platform errors hit

**None.** No Error 1101/1102/10021/10195. Clean deploy under wrangler 4.95.0
(`new_sqlite_classes` migration), 15 ms startup despite the bundled 1.6 MB wasm
(imported as CompiledWasm, instantiated lazily) plus a second 1.6 MB `Data` copy of
the same bytes for hashing.

## Gotchas / findings

- **CompiledWasm gives a `WebAssembly.Module`, not bytes** — you cannot hash the
  imported module directly. Solution: import the SAME `quickjs.wasm` a second time as
  a **`Data` module** (`quickjs.wasm.bin`, an `ArrayBuffer`) purely for `crypto.subtle.digest`.
  Costs a duplicate copy in the bundle (~1.6 MB) but keeps the proven CompiledWasm
  instantiate path untouched. A production build would instead bake the hash in at
  build time as a constant string and skip the second copy.
- **Commit ordering is the whole correctness argument.** `committedCell` advances
  ONLY after the R2 `put` resolves. A crash between eval and put leaves
  `committedCell` at the previous cell, so recovery is exactly-the-last-durable-cell —
  the uncheckpointed cell is dropped, never half-applied.
- **The hash guard is cheap insurance against the silent-corruption failure mode.**
  Without it, blitting a v1 heap into a v2 engine (different static data layout /
  function tables) would likely *not* throw — it would resume into a subtly corrupt
  namespace. Tagging + comparing the engine hash converts that into a loud, typed,
  pre-blit rejection, which a host can handle (e.g. refuse resume, fall back to a
  cold start, or run a migration). This is the upgrade-safety primitive for the bet.
- **Per-cell checkpoint cost** at this ~1.2 MB namespace is dominated by the R2 `put`
  (~0.7–1.8 s first put, cold), not the dump (sub-ms) — so checkpoint-after-every-cell
  is viable here but the R2 round-trip is the budget item to watch as namespaces grow
  (EXP-7's latency-distribution job).
- `generation` stayed 1 in the crash test because we used the deterministic in-memory
  drop rather than a real idle eviction (EXP-5a already proved the real-eviction +
  generation-bump path). EXP-9 isolates the *checkpoint/commit* and *guard* logic.

## Leftover resources (intentionally kept)

- Worker `montydyn-exp9` (URL above) — left deployed.
- R2 bucket `montydyn-snapshots` — now also holds `exp9/<doId>/cell-*.qjs.gz` keys.
- Pre-existing workers/buckets (curl-worker, durelo, thinkx-api, durelo-content,
  nova-archive, sdev-skills, montydyn-exp5a) were **not touched**.

## Files

- `experiments/exp-9/wrangler.jsonc`
- `experiments/exp-9/src/worker.mjs` (Worker + `KernelDO`: per-cell checkpoint + guard)
- `experiments/exp-9/src/quickjs.wasm` (CompiledWasm) + `quickjs.wasm.bin` (Data, for hashing)
- `experiments/exp-9/test-client.mjs` (crash + guard driver)
- `experiments/exp-9/package.json`

## Verdict

**PASS.** Per-cell move-forward checkpoints make the kernel crash-robust without a
clean shutdown (recovery at last committed cell, in-flight work correctly dropped),
and the interpreter content-hash guard turns an engine-upgrade mismatch into a clean
typed rejection instead of silent heap corruption. Both robustness primitives the
durable kernel needs for safe production operation hold on real Cloudflare.
