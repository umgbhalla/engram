# Rust→WASM Snapshot Durable Kernel on Cloudflare — Feasibility Study & Architecture

> Produced by feasibility research workflow `wkfcx55zi` (8 parallel research threads + 4 adversarial claim checks). 2026-06-01.

## 1. Verdict

**Feasible today for a JavaScript kernel; confidence HIGH for the JS path, LOW–MEDIUM
for the pure-Rust-nested-WASM ideal, BLOCKED for Pyodide-class Python.**

Core thesis — "hibernate = dump WASM linear memory; resume = new instance + write
bytes back" — is sound, proven by two precedents:
- Cloudflare's own **Python Workers** (linear-memory snapshot to cut cold start 10s→1s).
- **`vercel-labs/quickjs-wasi`** (full QuickJS VM incl. pending promises round-tripped via `memory.buffer` + `__stack_pointer`).

Platform primitives all GA + first-party: Rust DOs (`worker` 0.8.3), SQLite storage,
alarms, WebSocket Hibernation.

**Honest caveats:**
1. Snapshot ≠ `memory.buffer` alone — MUST also capture mutable globals (esp. `__stack_pointer`) and, for some engines, side tables.
2. 128 MB per-isolate cap (JS heap + ALL linear memory) + ~2× transient copy during dump/restore → usable namespace **well under ~50–60 MB**.
3. Restore latency for multi-MB snapshots is **UNMEASURED** — biggest unknown in the "fast resume" claim.
4. Snapshots are byte-coupled to the exact engine build → any interpreter upgrade invalidates all sessions → need content-hash guard + per-cell source journal as upgrade-only replay fallback.

**Lead with QuickJS-wasm, snapshot only at quiescent cell boundaries, host I/O as
named integer-handle callbacks. Buildable now.**

## 2. Architecture

- **WASM kernel** — QuickJS-ng → WASM (v0). Single linear memory = entire interpreter + REPL namespace. Bundled at deploy as `CompiledWasm` (cannot `WebAssembly.compile` arbitrary bytes at runtime on Workers; only *snapshot bytes* are dynamic).
- **Host Durable Object** — Rust `worker` 0.8.3 `#[durable_object]`. Owns identity, lifecycle, live WASM instance, SQLite metadata, R2 handle, alarms, hibernatable WebSocket. One DO == one kernel session.
- **Snapshot/restore** — at cell boundary: read `memory.buffer` + mutable globals → gzip/zstd → R2 blob + SQLite metadata row. Wake: fetch blob → new `WebAssembly.Memory` → `.set()` → restore globals → re-register host callbacks.
- **Host I/O boundary** — single imported `host_call(name, …)` dispatch. print/clock/RNG/crypto by name (re-registered after restore) or seeded deterministic imports. No live host pointers in guest; host refs = integer handles → table stays static.
- **Idle policy** — WebSocket Hibernation (`accept_web_socket`); DO evicts ~10s idle. `set_websocket_auto_response()` answers pings without waking. Configurable alarm → proactive snapshot→R2 → go cold.
- **Dynamic Worker Loader** — NOT required, arguably wrong here (paid beta, no `{wasm}` module type). Reserve for later per-tenant arbitrary interpreter code.
- **Rivet portability** — RivetKit CF driver = thin wrapper over SQLite-backed DO. Raw DO now loses nothing; adopt RivetKit later free. Snapshot via `c.kv` chunked ≤2 MB on CF backend.

```
                 client (browser / CLI)
                        │  WebSocket (hibernatable, server-role)
                        ▼
   ┌─────────────────────────────────────────────────────────┐
   │  Durable Object  (Rust / workers-rs 0.8.3)               │
   │  identity • alarms • SQLite • R2 binding • WS-hibernation│
   │   ┌──────────────────────────────────────────────┐      │
   │   │  Host glue (Rust + minimal JS shim)           │      │
   │   │   host_call(name, args)  ◄── named callbacks  │      │
   │   │   clock/rand/crypto  ◄── seeded host imports  │      │
   │   └──────────────────────────────────────────────┘      │
   │                       │ instantiate / eval-cell           │
   │                       ▼                                   │
   │   ┌──────────────────────────────────────────────┐      │
   │   │  QuickJS-wasm instance                        │      │
   │   │   linear memory  = full REPL namespace        │      │
   │   │   mutable globals = __stack_pointer, heap ptr │      │
   │   │   table = STATIC (recreated on re-instantiate)│      │
   │   └──────────────────────────────────────────────┘      │
   └───────┬───────────────────────────────────┬─────────────┘
           │ snapshot @ cell boundary          │ restore @ wake
           ▼                                   ▲
   ┌───────────────────┐               ┌───────────────────┐
   │  R2 bucket        │               │  SQLite (DO)      │
   │  snapshot blob    │◄──key+hash────│  metadata, cell   │
   │  (gzip, >2MB)     │               │  journal, counters│
   └───────────────────┘               └───────────────────┘
   (idle path: alarm → snapshot → deleteAll/evict → cold)
```

## 3. Snapshot mechanism

**State to capture at a quiescent boundary:**
1. **Linear memory** — `new Uint8Array(memory.buffer)`. Holds QuickJS heap, atom table, global object, GC state, pending-promise job queue. Re-acquire `memory.buffer` AFTER any `memory.grow` (grow detaches old ArrayBuffer).
2. **Mutable globals** — min `__stack_pointer`; enumerate ALL exported mutable globals. **Memory-only dumps corrupt on next allocation** (hard, testable). Guest build must export getters/setters (wasm-persist pattern) since workerd may not expose host-side `WebAssembly.Global` reads.
3. **Tables** — with integer-handle host indirection, table is STATIC, reconstructed by re-instantiating same module, not serialized. Do NOT design with funcref/externref churn (no Wasm-spec identity, won't survive byte copy; Wizer refuses). This is why single-memory engines (QuickJS/RustPython) are right and **Pyodide is not** (extra side tables captured inside workerd internals, unreachable → DIY Pyodide snapshot blocked).

**Quiescence invariant (keystone):** snapshot ONLY between cells — host has control, no live WASM call stack, job queue drained. Sidesteps capturing a live instruction pointer/call stack (wasmtime #3017). Long sync loops not pre-emptible → enforce wall-clock budget, reject/kill.

**Incremental:** WASM has no built-in dirty-page tracking. v0 = full snapshot per cell (KB–low-MB, compresses >10× due to zero regions). App-level page diffing only if write latency bites — defer.

**Size:** snapshot = high-water-mark (memory.grow monotonic; reclaim only via compact-on-restore). gzip/zstd. quickjs-wasi baseline ≈256 KB.

**Storage:** SQLite per-value cap **2 MB**, statement ≤100 KB → multi-MB needs chunking + reassembly. **Use R2 for blob** (unbounded, no egress fee, single put/get); SQLite holds only `{r2_key, module_content_hash, size, cell_seq}`. KV-DO (128 KiB value) too small — never for snapshots.

**Determinism:** byte-identical restore ONLY if all non-determinism externalized — Date.now/Math.random/crypto/clock/entropy = host imports you control (seeded PRNG, monotonic clock). Stock engine restores live-but-divergent.

**Host-handle reconnection:** native closures/pointers don't serialize. Route every host fn through `host_call(name,…)`; after restore `registerHostCallback(name, fn)`. Only non-serializable piece + silent-failure mode — test explicitly.

**Upgrade safety:** tag snapshot with interpreter module content-hash; reject mismatched restores. Engine rebuild changes heap layout → invalidates 100% of sessions → fallback = replay from per-cell source journal in SQLite. So "no journaling" = "no journaling in steady state; journal exists solely for engine-upgrade migration."

## 4. Tech choices

| Layer | Choice | Notes |
|---|---|---|
| DO host | `worker` 0.8.3 + `worker-macros` `#[durable_object]` | GA. `new/fetch/alarm`, `state.storage().sql()`, `accept_web_socket()`, `set_alarm()`. |
| Toolchain | `wasm32-unknown-unknown` + `wasm-bindgen` + `worker-build` | No Tokio/threads/real timers. |
| Build | `wasm-opt -Oz`, `opt-level="z"`, `lto=true`, `strip` | Under 10 MiB paid bundle + ~400ms–1s startup CPU (error 10021). |
| JS kernel v0 | **QuickJS-ng → WASM** (quickjs-wasi approach, or `rquickjs`) | ~1.4 MB, single memory, integer-handle host refs, built-in snapshot/serializeSnapshot/restore. Shim ~6 WASI imports yourself. |
| JS kernel alt | Boa (`boa_engine`, pure Rust, native wasm32, no WASI) | HIGHER RISK: no snapshot API, NaN-boxing + own GC, byte-copy pointer-stability UNTESTED. Validate separately, not co-equal v0. |
| Python (later) | **RustPython** → wasm32 (freeze-stdlib) | Cleanest single-memory snapshot. ~30 MB unoptimized, immature (CPython gaps). Pyodide blocked on CF. |
| Snapshot store | R2 blob + DO SQLite metadata/journal | gzip/zstd. |
| Portability | Raw DO now; RivetKit `@rivetkit/cloudflare-workers` later | `c.kv` ArrayBuffer chunked ≤2 MB. |

## 5. Blockers & risks (ranked)

1. **128 MB isolate cap + ~2× transient copy (HIGH, hard ceiling).** Usable namespace well under ~50–60 MB; OOM (Error 1102) likely below 64 MB. Mitigate: cap high-water-mark <~32 MB; compact-on-restore; chunk-stream bytes; gzip.
2. **Restore latency multi-MB UNMEASURED (HIGH unknown).** R2 cold get (cross-region RTT) + instantiate + `.set()` + re-register vs DO startup budget. Mitigate: measure p50/p95 at 1/8/16/32/64 MB; lazy restore; compress.
3. **Nested-guest `memory.buffer` access from Rust-on-workerd host (MEDIUM-HIGH, biggest unvalidated risk).** Reaching nested WASM memory from a workers-rs WASM host unproven. Mitigate: dump from thin JS glue (where quickjs-wasi already does it), OR compile interpreter as same-module Rust lib (doubles memory). "All-Rust" likely degrades to "Rust DO shell + JS glue doing the dump" — acceptable, not the clean thesis.
4. **Globals/side-table omission → silent corruption (MEDIUM, mitigable).** Always capture globals; single-memory engines; negative-test.
5. **Determinism not free (MEDIUM).** Host-control + seed clock/RNG/crypto.
6. **Engine-upgrade invalidates all snapshots (MEDIUM).** Content-hash guard + per-cell journal replay.
7. **Mid-cell snapshot impossible (MEDIUM, by design).** Cell wall-clock budget; snapshot at quiescent boundaries only.
8. **`onSleep`/hibernate not guaranteed on crash (LOW-MED).** Snapshot after EACH cell (move-forward checkpoint); onSleep = best-effort flush.
9. **Bundle size/startup CPU (LOW for QuickJS, real for Boa/RustPython).** `wasm-opt -Oz`; measure.

## 7. Open questions (need empirical answers)

1. Nested-WASM memory access from Rust-on-workerd, or must dump happen at JS-glue / same-module lib? → EXP-5.
2. Real usable namespace budget under 128 MB + 2× spike (go/no-go number) → EXP-6.
3. Multi-MB restore latency p50/p95; does R2 cold-fetch RTT alone blow sub-second? → EXP-7.
4. Does workerd expose host-side `WebAssembly.Global`/`Table` reads, or need guest getters/setters? → EXP-2.
5. Does quickjs-wasi's WASI-shimmed snapshot round-trip inside workerd (not just Node)? → EXP-5.
6. Streaming restore: chunk R2 bytes directly into linear memory to avoid peak? → EXP-7 variant.
7. Isolate-sharing: co-located same-class DOs evict each other in one 128 MB isolate?
8. RustPython live-snapshot MB; all mutable globals enumerable without recompile?
9. Rivet Engine `c.kv`/`c.db` blob size limits (undocumented).
10. asyncio/pending-coroutine snapshot drainable at cell boundary?

See `experiments.md` for the phased plan.
