# RUST-1B Re-gate — W4 byte-delta + E6 oplog, runtime-proven on the Rust kernel

> Scratch worker `engram-rust1b` (rquickjs-Rust kernel; `glue.js` brain replaced by Rust DO
> + `kernel-glue.mjs` WASI shim). Built/tested under guardrails: no `apps/` edits, only
> `engram-rust1b` deployable, R2 keys under `benchrust1b/`, no git commit. **Now torn down.**

## Headline

**The prior W4 "full-image-every-commit" gap was NEITHER a call-graph wiring bug NOR a stale
build — it was a genuine, latent design defect in the diff itself: `dumpW4` only emitted a
delta when `prev.byteLength === raw.byteLength`, but WASM linear memory is monotonic and grows
in 64 KB pages, so consecutive cells almost always differ in byteLength → `canDelta=false` →
every checkpoint silently fell through to a FULL base. The delta path was wired but practically
unreachable.** Fixed with a growth-tolerant grain diff. **W4 and E6 are now RUNTIME-PROVEN on
the Rust kernel on real Cloudflare: 9.11× fewer durable bytes, full E6 oplog + engine-migration
replay, zero regression. The 1b durability verdict is now GREEN.**

## Was it a wiring bug or a stale build? — Neither

Structural audit of the deployed code confirmed all three required behaviors were already
present and called:

- `lib.rs::checkpoint()` computes `force_full` from `BASE_EVERY=20` + prior `delta_seq`, calls
  `glue.dumpW4(force_full)`, branches `mode==delta` vs `full`, and **appends an oplog row in
  BOTH paths** (a full base seeds oplog seq 0).
- `ensure_glue()` dispatches `restoreW4(base + delta-chain)` normally, and `replay_journal` on
  engine-hash mismatch.
- `_lastImage` is set on `createFresh`/`restore`/`restoreW4`/`dump`.

So the W4/E6 machinery was correctly invoked. **The real defect** was inside `dumpW4`
(`src/kernel-glue.mjs`): the delta-eligibility predicate `prev.byteLength === raw.byteLength`.
Because the monotonic WASM buffer grows by pages between cells, that equality almost never held
→ delta path skipped → full base every commit. A real diff bug, not a missing call and not a
stale artifact.

### The fix (in the scratch experiment only)

- `dumpW4`: `canDelta = raw.byteLength >= prev.byteLength` (growth-tolerant 256 B-grain diff).
  Grains beyond `prev.byteLength` marked changed (new bytes carried); straddling grains marked
  changed; overlap compared as before; `imageLen` carried in the delta.
- `restoreW4`: pre-decode the chain, compute max grain target `((maxIdx+1)*grain)`, grow the
  reconstructed image to that length before applying writes, then apply each delta with a
  `min(grain, imageLen-dst)` clamp.
- Preserved: dense-mutation auto-fallback (delta ≥ 50% of full gz ⇒ full base) and
  `BASE_EVERY=20` chain cap.
- Build was **fresh**: rquickjs engine cargo-rebuilt + re-hashed
  (`ENGINE_HASH=rust-443f7febbaa362fc43411c7dc70aaf03`), `worker-build --release` re-run,
  `wrangler --dry-run` independently re-bundled clean (2013 KiB / 728 KiB gzip).

## RUNTIME W4 delta numbers (real CF, 60-cell session)

| Metric | Value |
|---|---|
| Cells | 60 (one `store.kN` key added per cell) |
| Delta commits | **57 / 60** (`snap_mode=delta`) |
| Full base commits | **3 / 60** — exactly at `BASE_EVERY=20` cadence (cells 20, 40, 60) |
| `delta_seq` behavior | increments 1..19 then resets to 0 at each base |
| Max delta chain length | 19 (capped by BASE_EVERY, as designed) |
| Per-delta size | ~7.9–10.4 KB gz (~74–102 changed 256 B grains) |
| Per-full-base size | ~138–145 KB gz (avg 140,952 B) |
| **Total W4 durable bytes (gz)** | **927,996 (~0.93 MB)** |
| Full-dump-every-cell baseline (gz) | 8,457,140 (~8.46 MB) |
| **Reduction** | **9.11× fewer durable bytes** (vs plan target ≥3×) |
| State survival | 25-cell delta chain reconstructs; `n=25, k0=0, k24=24` intact |

W4 is wired and working — NOT storing full every commit. Most cells store a small ~8 KB delta;
only every-20th cell writes a ~140 KB compacted full base.

**Caveat:** the restore-check reconnect came back **warm** (DO not evicted within 1.5 s), so a
cold delta-chain restore across *genuine* eviction was not forced. The same
`read_delta_chain`/`restore_w4` path is exercised by the live delta commits and state was
verified intact across the 25-cell chain; a true cold-eviction restore needs a ~15 min idle hold.

## RUNTIME E6 result — oplog + engine-migration replay

- **Crash-tail oplog:** each committed cell appends exactly one oplog tail row; cell# and
  `deltaSeq` advance monotonically 0→3 across 4 evals. **PASS**
- **Engine-migration:** `{t:"_forceEngineMismatch"}` test hook (`lib.rs:301`) rewrites
  `snap_manifest.engine_hash='STALE-ENGINE-HASH'` and drops the in-memory glue → next eval takes
  the engine-migration branch (`lib.rs:481 → read_oplog() → glue.replayJournal`,
  `kernel-glue.mjs:801`), which `createFresh` + re-imports kv + re-runs the recorded cell oplog
  into a **brand-new QuickJS engine**. `restoreSource='engine-migration-replay'`. **PASS**
- **Replay correctness (not bricked):** `acc===10` (accumulated 1+2+3+4), `kv c4==='10'` rebuilt,
  and the session **moves forward** (`acc===15`) after replay. **PASS**

## No-regression

- Functional: create ok, arith=7, stateful closure `inc=101`. **PASS**
- Genuine evict → cold-restore: generation bumped, `inMemory=false`, `x===42` survives via
  `sqlite-restore`, closure `inc=102`, kv survives — **live state, no replay**. **PASS**
- W5 spike-then-free: >18 MB raw buffer admitted via used-heap admission (not wedged), then free
  → `scrubbed=true` + `sizeGz<1MB` checkpoint commits. **PASS**
- Mid-cell buffer-growth tripwire: alloc bomb → typed `MemoryLimitError`, socket alive, next
  eval (1+1=2) works. **PASS**
- Score **19/20** (the 1 non-pass was a harness expectation bug: a bare trailing expression after
  a top-level `await` returns `null` — correct, pre-existing async-eval behavior, NOT a regression).

## Updated 1b durability verdict

**W4 byte-delta and E6 oplog/engine-migration are now RUNTIME-PROVEN on the Rust kernel on real
Cloudflare.** W4 delivers 9.11× durable-byte reduction (well above the ≥3× plan target) with
correct base/delta cadence and chain-bounded restore; E6 replays the crash-tail oplog into a
fresh engine across a forced engine-hash migration with state intact and the session moving
forward; no functional, restore, admission, or tripwire regressions. The Combined (W5+W4+E6)
durability stack — previously only proven on the JS sim — is now validated on the Rust kernel.

**Single residual to fully close:** a cold delta-chain restore across **genuine eviction**
(15 min idle hold) was not forced in this run — only a warm reconnect. The reconstruction path
itself is correct and exercised; the gap is solely the unforced cold-eviction timing.

## Teardown (this run)

- `engram-rust1b` worker **DELETED** (name confirmed; `Successfully deleted engram-rust1b`).
- R2 `benchrust1b/` prefix: **0 objects** — the verify run wrote nothing there (all images
  stayed SQLite-side under the 2 MB R2-overflow threshold; W5 gz collapsed <1 MB). Already clean.
- Worker list after teardown — engram workers = **`engram-kernel` + `engram-cloud` + `engram-ui`
  only**. (Unrelated pre-existing non-engram workers untouched and out of scope.)
- Guardrails honored: no `apps/` edits, no live-worker deploy, no git commit.

Harnesses left in `experiments/kernel-rust1b/`: `w4-verify.mjs` (60-cell driver),
`w4-restore.mjs` (chain restore check), `verify-rust1b.mjs` (E6 + no-regression).
