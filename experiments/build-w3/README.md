# build-w3 — ASYNCIFY (mid-cell preemption axis)

Orthogonal to the durability-bytes strategies: asyncify enables **preempting a running
cell mid-execution**, unwinding the native call stack INTO linear memory, snapshotting the
whole heap, and on a fresh (cold) instance **rewinding to the exact suspend point** to
continue — so an unbounded/long cell survives eviction without losing in-flight work.

## Mechanism
`wasm-opt --asyncify -O` instruments the module with `asyncify_start/stop_unwind`,
`asyncify_start/stop_rewind`, `asyncify_get_state`. The unwound fiber stack is written into
a struct in linear memory (`[stackPtr, stackEnd]` + reserved stack), so a plain
`memory.buffer` snapshot captures the suspended computation. Representative module
(`wasm/loop.wat`): a tight compute loop calling an imported `host.tick()` every iteration —
exactly the kernel's per-bytecode interrupt-handler tripwire (where runaway cells preempt).

## Files
- `asyncify-engine.mjs` — `AsyncifyLoop`: instantiate, `runAndPreempt(at)`, `restoreAndResume(snapshot)`, `runToEnd()`.
- `run.mjs` — produces the report: size delta + synthetic long-cell + W-long (harness).
- `fidelity.mjs` — explicit closure + pending-promise + Map/Set round-trip across evict→cold-restore on the real quickjs-wasi Session.
- `wasm/` — `loop.wat`→`loop.wasm`→`loop.async*.wasm`; `quickjs.async*.wasm` (asyncified real quickjs-wasi engine).

## Run
```
node run.mjs        # full report (JSON)
node fidelity.mjs   # closure+promise+Map/Set fidelity (exit 0 = PASS)
```

## Results (measured, node v25, macOS, wasm-opt 130)
- **Size delta:** quickjs-wasi 1.51MB → asyncify -O 2.06MB = **1.360x** (target ~1.36x — HIT).
- **Synthetic long cell (10M-iter, preempt@500k):** suspended mid-execution at 500000,
  full-memory snapshot 64KB, **cold-restored into a fresh instance, rewound, ran to
  completion (final=1000000)**. unwindCost(median) **~0.006ms** (true preempt-mechanism
  latency), restore ~10ms. midCell=PASS, resume=PASS.
- **W-long (harness):** fidelity=PASS, genuine cold restore (gen=2, coldFresh=true).
- **Fidelity:** closure 43→44 across cold restore, Map/Set intact, pending promise survived
  and resolved to "resolved:99" post-restore.
