# montydyn Durable QuickJS Kernel — Operating Envelope

> Synthesis of EXP-1, 5a, 6, 7, 8, 9, 4b. All passed on real Cloudflare (EXP-1/8 local). 2026-06-01.

## 1. Verdict

**The bet holds. Confidence: HIGH.** Every feasibility risk probed passed on production
workerd. The durable QuickJS kernel — eval-driven, snapshot to R2, restore-and-advance,
crash/upgrade-safe — is buildable today. No hard platform blocker remains. Constraints
are *quantitative* (image-size ceilings) + one *architectural* fork (Rust-shell + JS-glue,
not pure Rust). Both characterized with hard numbers.

## 2. Operating envelope

| Dimension | Value | Source |
|---|---|---|
| MAX live namespace (no snapshot) | **>193 MB** (didn't die) — no 128 MB cap | EXP-6 |
| MAX snapshot-able live memory (current dump path) | ~57 MB last-OK; hard wall ~60–61 MB | EXP-6 |
| **Production snapshot guard** | refuse grow/snapshot above **~45–50 MB** live | EXP-6 |
| MAX raw snapshot for fast (<1s p50) resume | ~21 MB raw / ~14 MB gz, 8/8 stable | EXP-7 |
| **Conservative safe raw image** | **≤ ~20 MB raw** | EXP-7 |
| DO crash ceiling (back-to-back restore) | Error 1102 at ~27–32 MB raw | EXP-7 |
| Real-kernel gz ratio | ~12× → 20 MB raw ≈ 1.7 MB gz | EXP-4b/7 |

**Restore latency (raw / gz → p50 / p95):**

| Raw | Gzip | p50 | p95 |
|---|---|---|---|
| 1.25 MB | 0.10 MB | 231 ms | 493 ms |
| ~7 MB | 2.8 MB | 275 ms | 600 ms |
| ~11 MB | 6.2 MB | 299 ms | 1082 ms |
| ~14 MB | 8.8 MB | 415 ms | 911 ms |
| ~21 MB | 13.9 MB | 385 ms | 1075 ms |
| ~27 MB | — | DO crash (1102 / WS 1006) | — |

Latency = **100% R2 network, ~0% compute** (gunzip+deserialize+instantiate+blit+globals all sub-ms even at 30 MB). p95>1s tails = R2 cold-first-fetch variance, not a size wall; warm ~250–400 ms. **Latency tracks gz size; crash ceiling tracks raw size.**

**Determinism (EXP-8)** — byte-identical restore-and-advance requires externalizing ALL of: controlled monotonic clock (`clock_time_get`), seeded PRNG (`Math.random`), seeded `crypto.getRandomValues`/`random_get`, pinned `timezoneOffset`. Host RNG/clock state lives OUTSIDE linear memory; persist/replay the host-side counter with each snapshot. Host callbacks not in snapshot → `registerHostCallback` after restore. One un-externalized source (clock alone) breaks byte-identity.

**Crash/upgrade safety (EXP-9, on CF)** — per-cell move-forward checkpoints recover to last *committed* cell (commit ordering load-bearing: `committedCell` advances only after R2 put resolves). Engine content-hash guard rejects v2-engine restore with typed `ENGINE_HASH_MISMATCH` BEFORE any blit (no corruption). Without guard, v1-heap-into-v2-engine resumes into silent corruption.

**Failure signature:** isolate OOM + Error 1102 are **UNCATCHABLE** — no JS exception, no log. Surface as WS close `code=1006, wasClean:false`, fetch `outcome=responseStreamDisconnected`. **Guard by SIZE, not try/catch.**

## 3. Rust-host verdict (EXP-4b)

**All-Rust NOT viable for the full kernel → use Rust-shell + JS-glue. Risk #3 retired.**
- Snapshot *mechanics* clean in pure Rust: Rust reaches nested QuickJS memory+globals via `js-sys` WebAssembly API, snapshot/restores them (`__stack_pointer` restored OK).
- *Eval driver* is the blocker: driving QuickJS needs the full C-ABI + WASI shim `quickjs-wasi` provides in JS. workerd has no native wasm host → "pure Rust" only means Rust driving the JS WebAssembly API.
- **Adopt path (b): Rust DurableObject shell + JS glue for eval+dump.** Verified cold wake: Rust DO gen 1→2 (genuine eviction), `x===42`, `inc()===43`, `restoreSource=r2-restore`, ~912 ms.
- Notes: DO trait methods take `&self` → `RefCell<Option<GlueKernel>>` interior mutability, never hold `borrow()` across `.await`. CompiledWasm bundled by **wrangler** (wrapper `entry.mjs`), not worker-build esbuild. `quickjs-wasi` in **devDependencies only** (worker-build 0.8.3 mis-parses it in deps).

## 4. Risks — de-risked vs open

**De-risked:** nested-memory snapshot from Rust DO ✓ · cold restore <1s to ~14 MB gz ✓ · deterministic restore ✓ · crash recovery + version guard ✓ · no 128 MB namespace cap ✓ · clean deploy wrangler 4.95 ✓

**Open:**
- **Snapshot transient ~3× spike** caps usable image at ~57 MB live / ~20 MB raw. Root: `serializeSnapshot()` makes a redundant 2nd full copy (live + snap copy + serialized). **Lever:** stream `snap.memory` ArrayBuffer → gzip → R2, skip the copy. Not implemented.
- **Streaming-gunzip into WASM memory** to raise restore ceiling >30 MB raw. Follow-up.
- **Engine-hash bundle cost:** EXP-9 imported wasm twice (CompiledWasm can't be hashed). Bake hash in at build time.
- OOM uncatchable → **size-admission control mandatory**, enforced in-kernel.

## 5. Next step → v0

Build v0 on **path (b)** (Rust DO shell + JS glue) with three things first:
1. **Streaming snapshot dump** — `snap.memory` ArrayBuffer → gzip → R2, kill the double-copy. Highest leverage; gates both ceilings.
2. **Hard size-admission guard** — refuse grow/snapshot >~45–50 MB live, refuse restore of raw >~20 MB (OOM uncatchable). In-kernel, not a probe.
3. **Bake-in determinism + version guard** — seeded clock/RNG/crypto host imports + build-time engine-hash, host entropy counter persisted per snapshot.

**Target v0 envelope:** ≤20 MB raw / ~1.7 MB gz images, sub-second p50 cold wake, byte-deterministic, crash- & upgrade-safe.

## Deployed (CF, left for follow-up)
Workers: `montydyn-exp5a`, `montydyn-exp6`, `montydyn-exp7`, `montydyn-exp9`, `montydyn-exp4b`. R2: `montydyn-snapshots` (keys namespaced per exp). Pre-existing resources untouched.
