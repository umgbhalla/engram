# montydyn — Durable Hibernating Kernel

> Single source of truth for this repo. `AGENTS.md` is a symlink to this file.

## Goal

Build a **durable, hibernating, stateful REPL kernel** with Jupyter/IPython-kernel
semantics: a live interpreter namespace that persists across evaluations, can
**sleep when idle and resume with full live state**, and moves forward like a real
kernel — **without replay and without re-firing side effects**.

## Core thesis (why this is possible)

V8 isolates cannot hibernate a live kernel: no heap-snapshot API. **Rust → WASM
dissolves that.** A WASM interpreter holds all its state in **linear memory — a
plain `ArrayBuffer` you can read, persist, and restore**. So:

- **Hibernate** = dump `memory.buffer` (+ globals + tables) to durable storage.
- **Resume** = new WASM instance, blit bytes back, continue execution.

True live-state snapshot/restore. No journaling, no source replay, because we
literally persist the heap.

## Architecture (target)

- **Kernel** = script interpreter compiled Rust → WASM.
  - JS first: [Boa](https://github.com/boa-dev/boa) (pure-Rust JS engine) or QuickJS-wasm.
  - Python later: RustPython / Pyodide.
- **Host** = Cloudflare **Durable Object** (identity + SQLite + alarms + WebSocket
  hibernation). Holds the snapshot; orchestrates lifecycle.
- **Snapshot store** = DO SQLite for small, R2 for large memory images.
- **I/O boundary** = all host imports (network/time/random) cross a controlled
  boundary → non-determinism + handle-reconnect handled there.
- **Idle policy** = configurable; fast resume + sleep/wake like Durable Objects.
- **Dynamic Worker Loader** = optional per-tenant kernel loading.
- **Portability** = path to [Rivet ActorCore](https://rivet.dev/actors/) (CF DO backend now, Rivet later).

## Build order

1. **JS kernel** (Rust JS engine in WASM) — prove snapshot/restore + hibernate/resume.
2. **Python kernel** — port the proven pattern.

## Status

- [x] Feasibility research launched (workflow `wkfcx55zi`).
- [ ] Feasibility study + architecture spec → `docs/feasibility.md`.
- [ ] Phased experiment plan → `docs/experiments.md`.
- [ ] Experiment 1 (cheapest, highest-signal) executed.

## Repo conventions (multi-agent)

- **Source of truth**: this file. Update `## Status` and `docs/` as work lands.
- **Tasks**: tracked in the harness task list + mirrored in `docs/TODO.md`.
- **Branches**: one branch per experiment/feature (`exp/<n>-<slug>`, `feat/<slug>`).
  Never commit experiments directly to `main`. Open PRs.
- **Secrets**: Cloudflare creds live in `.env` (gitignored). Never commit. See
  `.env.example`. Account id + API token expected there.
- **Worktrees**: parallel agents use isolated git worktrees to avoid clobbering.
- **Docs land in `docs/`**: `feasibility.md`, `experiments.md`, `decisions.md` (ADRs).

## Key facts (do not re-derive)

- Worker Loader: `load()` fresh isolate / `get(id,cb)` best-effort warm cache keyed
  by id only; no eviction guarantee/TTL; module types js/cjs/py/text/data/json (no
  native wasm type — instantiate WASM from a `data` ArrayBuffer module).
- DO: single-threaded per id; SQLite storage survives everything; alarms; WebSocket
  Hibernation (in-memory state lost on hibernate → must be in storage).
- Worker Loader + Dynamic Workers require Workers **Paid** plan (error 10195 otherwise);
  wrangler **≥ 4.86.0**.
- V8 isolate heap: NOT snapshottable. WASM linear memory: IS. ← the whole bet.
