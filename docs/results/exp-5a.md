# EXP-5a results — THE THESIS TEST on real Cloudflare (JS Durable Object)

**Date:** 2026-06-01 · **Branch:** `exp/5a-cf-thesis` · **Verdict: PASS ✅ (real cold wake)**

The decisive go/no-go bet for the whole project holds **on production Cloudflare**:
a live QuickJS REPL namespace — `globalThis.x` and a closure `inc` — **survived a
Durable Object being evicted from memory and re-constructed**, restored purely from
a gzip'd QuickJS linear-memory + globals snapshot stored in R2, with **no source
replay**. Both a **real idle-driven cold wake** and a **deterministic simulated
drop** were proven.

## What was deployed

- **Worker + JS Durable Object** (NOT Rust — per the EXP-5a design decision, to
  reuse the proven EXP-1 JS snapshot path and isolate the thesis from the separate
  Rust-host risk). One `KernelDO` class = one kernel session.
- **Snapshot engine:** `quickjs-wasi@3.0.0` (same prebuilt `quickjs.wasm` as EXP-1),
  bundled as a **CompiledWasm** module so it imports as a `WebAssembly.Module` and
  is passed straight to `QuickJS.create/restore`. This sidesteps workerd's ban on
  `WebAssembly.compile` of arbitrary bytes — the lib's `resolveModule()` takes a
  precompiled `WebAssembly.Module` and `instantiate()` uses the
  `WebAssembly.instantiate(module, imports)` form, both allowed on Workers.
- **Snapshot store:** R2 bucket `montydyn-snapshots`, key = `snap/<doId>.qjs.gz`.
  SQLite holds metadata rows (`snapshots` table) + the `generation` counter (`meta`).
- **WebSocket:** hibernatable via `state.acceptWebSocket(server)` +
  `setWebSocketAutoResponse(ping/pong)` so idle pings don't wake user code.

**Deployed worker URL:** `https://montydyn-exp5a.umg-bhalla88.workers.dev`
(WS path: `wss://montydyn-exp5a.umg-bhalla88.workers.dev/ws?id=<session>`)
**R2 bucket:** `montydyn-snapshots`  · **DO binding:** `KERNEL_DO` (class `KernelDO`)
**Worker startup time:** 13 ms (no Error 10021). Upload 1652.72 KiB / gzip 557.79 KiB.

## The kernel lifecycle under test

1. Constructor bumps + persists a `generation` counter in SQLite **on every DO
   (re)hydration** → hard evidence of re-instantiation after eviction.
2. The live QuickJS instance lives ONLY in `this.kernel` (in-memory) → eviction
   loses it.
3. `{t:'eval'}` lazily ensures a live kernel: if `this.kernel===null`, **restore
   from R2** (gunzip → `deserializeSnapshot` → `QuickJS.restore` → `executePendingJobs`);
   if no snapshot, fresh instance.
4. `{t:'snapshot'}` dumps memory+globals → gzip → R2 put + SQLite row.
5. `{t:'gen'}` reports generation + whether the in-memory kernel is present.
6. `{t:'evict'}` (debug) drops `this.kernel=null` to simulate eviction deterministically.

## Proof A — REAL cold wake (idle-driven eviction) ✅

Setup on session `cold-…`: `eval x=42; inc=()=>++x`, `snapshot` (at **generation 1**,
in-memory kernel present), then **disconnect the WebSocket and idle 70 s**.
Reconnect on the same session id:

| Check | Expected | Got |
|---|---|---|
| `generation` after idle gap | bumped (DO reconstructed) | **2** (was 1 at snapshot) |
| in-memory kernel present at reconnect | absent (evicted) | **false** |
| first `eval "x"` → `restoredColdThisCall` | true (cold restore from R2) | **true**, source `r2-restore` |
| `eval "x"` | 42 | **42** |
| `eval "inc()"` (closure survived) | 43 | **43** |
| restore latency (msg→R2 get→gunzip→instantiate→blit→ready) | — | **573 ms** |

`generation 1 → 2` + `inMemoryKernelPresent:false` proves the DO was **genuinely
evicted from memory and re-constructed** during the idle gap, yet the namespace came
back from the R2 snapshot. **This is the real thing, not a simulation.**

## Proof B — simulated in-memory drop (deterministic) ✅

Same setup, then `{t:'evict'}` to drop `this.kernel` without reconstructing the DO
(`generation` stays 1). First `eval "x"` reports `inMemoryKernelPresentBefore:false`,
`restoredColdThisCall:true`, source `r2-restore` → `x=42`, `inc()=43`. Restore
latency **505 ms**. Confirms the R2 restore path independent of forcing hibernation.

## Numbers (on Cloudflare)

| Metric | Value |
|---|---|
| Snapshot raw (serialized) | **1,245,212 bytes** (~1.19 MiB) |
| Snapshot gzip (stored in R2) | **99,739 bytes** (~97.4 KiB) — ~12.5× |
| `__stack_pointer` at snapshot | 1048576 (stack top, quiescent boundary) |
| Snapshot dump time (`snapshot()`+serialize+gzip) | ~0 ms (sub-ms, rounded) |
| R2 `put` time | ~1138 ms (first put; cold) |
| Fresh-kernel instantiate (first eval, no snapshot) | 708 ms |
| **Restore latency, real cold wake** (msg→R2 get→gunzip→restore→ready) | **573 ms** |
| **Restore latency, simulated drop** | **505 ms** |

Sizes match EXP-1 closely (EXP-1: 1.28 MB raw / 96 KB gzip locally; here 1.21 MB /
97 KB). gzip via `CompressionStream`/`DecompressionStream` (no node:zlib needed in
workerd). Restore at this ~1.2 MB size is ~0.5–0.6 s end-to-end including the R2
round-trip — comfortably sub-second, but this is small; multi-MB latency remains
EXP-7's job.

## Platform errors hit

**None of the feared ones.** No Error 1101/1102/10021/10195 observed.
- 10195 (paid-plan gate): not hit — account is on Workers Paid, SQLite DO migration
  (`new_sqlite_classes`) deployed cleanly under wrangler 4.95.0.
- 10021 (startup CPU): not hit — 13 ms startup despite the 1.6 MB wasm bundle (it is
  imported as CompiledWasm and instantiated lazily on first eval, not at module load).
- 1101/1102 (runtime exception / OOM): not hit at this namespace size.

## Gotchas / findings

- **CompiledWasm import is the unlock.** Passing the imported `WebAssembly.Module`
  directly to `QuickJS.create/restore` avoids `WebAssembly.compile`, which workerd
  blocks for arbitrary bytes. The only *dynamic* WASM bytes are the snapshot memory
  image, which is `.set()` into the module's own exported `Memory` — never compiled.
- **No "nested-WASM-from-Rust" problem here.** Because the host is JS, the snapshot
  is taken by the quickjs-wasi JS glue reading its own exported `memory.buffer` —
  exactly where EXP-1 already proved it works. This sidesteps feasibility risk #3
  (reaching nested WASM memory from a workers-rs Rust host), which is deferred to the
  separate Rust spike (EXP-4b). EXP-5a deliberately does NOT prove the all-Rust path.
- **quickjs-wasi's WASI shim runs in workerd unmodified** (open question #5 →
  answered YES): it only needs `Date`, `crypto.getRandomValues`, `console`, and
  guards `process.stdout` — all present on Workers.
- **Single mutable global** (`__stack_pointer`) — `QuickJS.snapshot()` already
  captures it; restore writes `__stack_pointer.value` then blits memory. Matches EXP-1.
- **R2 chunking not needed** at ~97 KB gzip — a single `put`/`get` is fine (well under
  R2 limits). Chunking only becomes relevant for the multi-MB regime (EXP-6/7).
- **`r2 bucket info` object_count read 0** right after the test — that metric is
  eventually-consistent on CF and lags; the authoritative proof is the live code path
  returning `restoreSource:r2-restore` successfully across a real DO reconstruction.
- **Lazy restore is correct.** Restoring only on the first `eval` (not in the
  constructor) keeps cold-reconstruct cost off the hot path until code actually runs,
  and keeps `gen` reporting honest (`inMemoryKernelPresent:false` until first eval).

## Leftover resources (intentionally kept for follow-ups)

- Worker `montydyn-exp5a` (URL above) — leave deployed for EXP-6/EXP-7.
- R2 bucket `montydyn-snapshots` — holds session snapshots.
- Pre-existing workers/buckets/KV (curl-worker, durelo, thinkx-api, durelo-content,
  nova-archive, sdev-skills) were **not touched**.

## Files

- `experiments/exp-5a/wrangler.jsonc`
- `experiments/exp-5a/src/worker.mjs` (Worker + `KernelDO`)
- `experiments/exp-5a/src/quickjs.wasm` (CompiledWasm, copied from quickjs-wasi)
- `experiments/exp-5a/test-client.mjs` (Node `ws` client: sim / cold / both modes)
- `experiments/exp-5a/package.json`

## Verdict for the build

**GO.** The core thesis — "hibernate = dump WASM linear memory + globals; resume =
fresh instance + write bytes back" — is now proven **end-to-end on real Cloudflare**,
surviving a genuine Durable Object eviction, not just a local round-trip. Restore is
sub-second at ~1.2 MB. Next: EXP-6 (memory ceiling), EXP-7 (multi-MB restore latency
distribution), and the separate Rust-host spike (EXP-4b) for the all-Rust variant.
