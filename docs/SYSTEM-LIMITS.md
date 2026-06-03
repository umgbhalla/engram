# SYSTEM-LIMITS — Operating Envelope of the Engram Kernel

> **Headline:** The Engram kernel is safe and recoverable across its whole documented envelope —
> infinite loops, in-cell alloc bombs, native-builtin bombs, and spike-then-free memory all trip
> **typed errors with the socket alive**. There is exactly **one** in-place-unrecoverable wedge
> (deep C-stack recursion → needs `reset`/reconnect) and exactly **one** silent danger edge
> (**incompressible raw heap ~28 MB 1006-kills the DO *below* the 50 MB used-heap guard**) — accumulate
> heap in **≤4 MB-per-cell** steps and stay under ~24 MB incompressible to live safely inside the box.

Measured live against the RLM-stripped Rust kernel (`apps/kernel-rust`) via a scratch `engram-limits`
worker (since torn down), read-only WS probes on fresh sessions. Source-of-truth constants:
`apps/kernel-rust/src/kernel-glue.mjs` (lines ~135–149, 400–401) and
`apps/kernel-rust/engine/src/lib.rs` (interrupt handler ~500–520, grow cap, post-cell check ~685–712).

## Operating envelope

| Axis | Hard number / behavior |
|---|---|
| **Per-cell single alloc** | ≤4 MB OK; **≥8 MB → typed `MemoryLimitError`** (per-cell `grow_cap` = 128 pages = 8 MB *delta since eval-begin*, NOT absolute). Build a big heap by accumulating ≤4 MB/cell across cells. |
| **Total used-heap admission guard** | `MAX_USED_BYTES = 50 MB` (src) on QuickJS `memoryUsedSize`. **BUT** the real raw-buffer OOM cliff is **lower**: incompressible heap (`.fill(i)` distinct-per-chunk) **1006-kills the DO at ~28 MB raw**, below the 50 MB guard. The guard protects *compressible / used-heap*, not raw incompressible growth — this is the one silent edge. |
| **Compressible vs incompressible** | Compressible (`.fill(sameByte)`) reaches **40 MB+** and checkpoints+restores fine (gz crushes it). Incompressible practical ceiling **~24 MB**. |
| **Mid-cell tripwire** | Looping push-bomb → `MemoryLimitError` **mid-cell**, socket alive, recovers. Single huge native alloc caught by **post-cell** grow check (>8 MB delta). |
| **Checkpoint / dump ceiling** | Compressible session checkpoints+restores via `sqlite-restore` at 40 MB+ retained. Incompressible safe ~24 MB. `SAFE_SERIALIZE_BUFFER_BYTES = 45 MB`, `MAX_RESTORE_RAW_BYTES = 45 MB` (src absolutes). |
| **Monotonic-buffer wedge (W5 spike→free)** | **Un-wedges** (`sqlite-restore`) up to **24 MB spike**; **fails at 28 MB** (restore `SizeAdmission` rejects); raw grow itself 1006-kills at ~28–32 MB. → **W5 boundary = 24 MB spike OK / 28 MB fails.** |
| **Tick budget** (`cellBudgetTicks`, default **1200** interrupt-handler invocations) | Bounded for-loop completes to ~10,000 iters (49 995 000), **trips `TimeoutError` at ~50,000 iters**. Configurable: `cellBudgetTicks=100000` completes ~1M iters, trips ~5M. Interrupt fires ~every 8–10 bytecode ops. |
| **Loop shapes** | **ALL** infinite-loop shapes (empty / counter / `globalThis.x=1` / `o.a=1`) trip a typed `TimeoutError` cleanly, **socket alive**, next eval works. |
| **Cold restore latency** (via evict; lower bound, no platform WS-reconnect) | 0 MB ~194 ms · 1 MB ~232 ms · 4 MB ~297 ms · 8 MB ~319 ms — all `sqlite-restore`. **R2 overflow** (gz >2 MB, ~6 MB incompressible random) → `r2-restore` ~905 ms (R2 GET dominates). `SQLITE_HOT_MAX = 2 MB` gz threshold for sqlite-vs-R2. |
| **W4 delta chain** | `BASE_EVERY_CELLS = 20` full-base cadence · `DELTA_GRAIN_BYTES = 256` · `DELTA_FALLBACK_PCT = 0.5` (delta ≥50% of full → downgrade to full base). 25 mutating cells → evict → restore over delta-chain ~222 ms, value correct. Chain length bounded by the 20-cell base cadence. |
| **Concurrency** | 1 session: 10 concurrent evals serialize through the mutex cleanly (c=1..10, distinct=10, zero lost increments). 50 parallel sessions: **49/50 OK in 2.9 s** (1 connect race). |
| **host.fetch body** | Clamps at **~97 KB (~95 KiB)**: 50 KB body intact (47 425), 200 KB/500 KB/2 MB requests all clamp to ~97 KB. Headers/status pass through (200). Allowlist enforced (`config.fetch` = `true` / `false` / `[hosts]`). Fetch adds 0 entropy → determinism preserved. |
| **Unrecoverable in-place** | **Deep recursion → `GlueError` "Maximum call stack size exceeded"; in-place recovery FAILS** — recovers ONLY via `reset` (eval=2 after reset) or reconnect. This is the single in-place wedge (matches the C-stack `unreachable` trap). **Native-builtin bombs** (`Uint8Array(200MB).fill`, `s+=s` doubling) → `InternalError`, **DO recovers in-place** (QuickJS `memory_limit` catches before raw grow). |

## Key gotchas (do not re-derive)

1. **Per-cell 8 MB grow cap** means a *single* big alloc always trips — accumulate in ≤4 MB cells.
2. **The dangerous edge is incompressible raw buffer ~28 MB**, which 1006-kills *below* the 50 MB
   guard (silent OOM cliff). The guard protects compressible/used-heap, not raw incompressible growth.
3. **Deep C-stack recursion is the one in-place-unrecoverable wedge** — needs `reset`.
4. `host.fetch` results: when a cell contains `await`, its trailing-expression completion value is
   `null` (async-eval pump behavior) — **read fetch results via a global**, not the cell return value.
