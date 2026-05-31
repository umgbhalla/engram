# EXP-1 — QuickJS WASM linear-memory snapshot/restore round-trip

Proves the core montydyn bet: a QuickJS REPL namespace — a `var`, a **closure**,
and a **pending Promise** — survives a snapshot (linear memory + mutable globals)
dumped to disk and restored into a **fresh WASM instance in a fresh process**,
with **no replay of the original source**.

## What it uses

[`quickjs-wasi`](https://www.npmjs.com/package/quickjs-wasi) (`vercel-labs`), the
QuickJS-NG VM compiled to WASM with a built-in snapshot API. We install the
**prebuilt `quickjs.wasm`** from npm (1.6 MB) — no wasi-sdk build required. The
package ships its own ~6-import WASI shim, so no host polyfill is needed.

- `snapshot()` captures `new Uint8Array(memory.buffer)` + `__stack_pointer` +
  runtime/context pointers.
- `serializeSnapshot()` / `deserializeSnapshot()` (header `"QJSS"`) for disk I/O.
- `QuickJS.restore()` grows memory, blits bytes, restores `__stack_pointer`.
- `executePendingJobs()` drains the surviving microtask queue.

## Run

```bash
cd experiments/exp-1
npm install
npm run harness    # core hypothesis (PASS/FAIL + sizes + timings)
npm run negative   # EXP-2a globals-necessity negative control
```

## Files

- `lib.mjs` — wasm loader, cell-1 source, paths.
- `snapshot-phase.mjs` — Phase A: fresh VM, eval cell 1, snapshot to `snapshot.bin`.
- `restore-phase.mjs` — Phase B (fresh process): restore, drain, eval `inc()`.
- `harness.mjs` — orchestrates A then B (B in a child process) + asserts.
- `negative-control.mjs` — memory-only restore + wrong-`__stack_pointer` corruption.

## Expected result

`x === 43` after restore (41 base, +1 from the drained pending promise, +1 from
the surviving `inc()` closure). See `docs/results/exp-1.md` for numbers.
