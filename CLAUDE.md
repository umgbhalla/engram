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
  - JS first: **QuickJS-ng → WASM** (built-in snapshot API; quickjs-wasi precedent). Boa = higher-risk alt (no snapshot API).
  - Python later: **RustPython** (single-memory, snapshottable). Pyodide BLOCKED on CF (side-table capture unreachable).
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

- [x] Feasibility research done (workflow `wkfcx55zi`).
- [x] Feasibility study + architecture → `docs/feasibility.md` (verdict: JS feasible HIGH, Python-Pyodide blocked).
- [x] Phased experiment plan → `docs/experiments.md` (10 experiments).
- [ ] Drop CF creds in `.env` (USER).
- [x] EXP-1 (local QuickJS snapshot round-trip) — **PASS** (`docs/results/exp-1.md`).
      var + closure + pending promise survive memory+globals dump/restore into a
      fresh process; `x===43`. Snap 1.28 MB raw / 96 KB gzip, restore ~2 ms.
- [x] EXP-5a (THE THESIS TEST, real Cloudflare, JS DO) — **PASS** (`docs/results/exp-5a.md`).
      QuickJS namespace survived a **real DO eviction** (constructor generation
      1→2, in-memory kernel gone) restored from a gzip'd memory+globals snapshot in
      R2; `x===42`, closure `inc()===43`, no source replay. Restore ~0.57 s at
      ~1.2 MB raw / 97 KB gzip. quickjs-wasi runs in workerd via CompiledWasm
      import; no Error 1101/1102/10021/10195. Worker `montydyn-exp5a`, R2
      `montydyn-snapshots` left deployed. GO for the bet.
- [x] EXP-6/7/8/9/4b (workflow `wnf82p8o5`, parallel worktrees) — **ALL PASS**.
      Operating envelope → `docs/results/SUMMARY.md`. Key numbers:
      - Namespace not capped (>193 MB live), but **snapshot dump caps at ~57 MB live** (3× transient); safe raw image **≤20 MB**.
      - Cold restore **sub-second p50 to ~14 MB gz / ~21 MB raw**; latency is 100% R2 network. Crash (1102) at ~27–32 MB raw.
      - Determinism byte-identical with seeded clock/RNG/crypto externalized (EXP-8).
      - Per-cell checkpoint crash-recovery + engine-hash upgrade guard verified on CF (EXP-9).
      - **EXP-4b: Rust DO CAN snapshot nested wasm; eval needs JS → use Rust-shell + JS-glue (path b).** Risk #3 retired.
      - OOM/1102 UNCATCHABLE (WS 1006) → size-admission guard mandatory.

## Next (v0, path b: Rust DO shell + JS glue)
1. Streaming snapshot dump (`snap.memory` → gzip → R2, kill double-copy) — gates both ceilings.
2. Hard size-admission guard (refuse >~45–50 MB live / >~20 MB raw restore).
3. Bake-in seeded clock/RNG/crypto + build-time engine-hash guard; persist host entropy counter per snapshot.
Target v0: ≤20 MB raw / ~1.7 MB gz, sub-second p50 cold wake, byte-deterministic, crash+upgrade-safe.

## Repo conventions (multi-agent)

- **Source of truth**: this file. Update `## Status` and `docs/` as work lands.
- **Tasks**: tracked in the harness task list + mirrored in `docs/TODO.md`.
- **Branches**: one branch per experiment/feature (`exp/<n>-<slug>`, `feat/<slug>`).
  Never commit experiments directly to `main`. Open PRs.
- **Secrets**: Cloudflare creds live in `.env` (gitignored). Never commit. See
  `.env.example`. Account id + API token expected there.
- **Worktrees**: parallel agents use isolated git worktrees to avoid clobbering.
- **Docs land in `docs/`**: `feasibility.md`, `experiments.md`, `decisions.md` (ADRs).
- **`context/`**: external repos as shallow submodules for reference (read-only, not built).
  Index in `context/include.md`. Init: `git submodule update --init --depth 1`.

## Key facts (do not re-derive)

- Worker Loader: `load()` fresh isolate / `get(id,cb)` best-effort warm cache keyed
  by id only; no eviction guarantee/TTL; module types js/cjs/py/text/data/json (no
  native wasm type — instantiate WASM from a `data` ArrayBuffer module).
- DO: single-threaded per id; SQLite storage survives everything; alarms; WebSocket
  Hibernation (in-memory state lost on hibernate → must be in storage).
- Worker Loader + Dynamic Workers require Workers **Paid** plan (error 10195 otherwise);
  wrangler **≥ 4.86.0**.
- V8 isolate heap: NOT snapshottable. WASM linear memory: IS. ← the whole bet.
