# TODO / Task board

Mirror of harness task list. Multi-agent: claim a task, branch `exp/<n>-<slug>`, PR.

## Phase 0 — Setup
- [x] Repo scaffold, CLAUDE.md/AGENTS.md, .gitignore, .env.example
- [ ] Drop CF creds into `.env` (USER action)
- [ ] Initial commit + branch strategy

## Phase 1 — Feasibility (research workflow `wkfcx55zi` running)
- [ ] Land feasibility study → `docs/feasibility.md`
- [ ] Land phased experiment plan → `docs/experiments.md`
- [ ] Record key decisions → `docs/decisions.md` (ADRs)

## Phase 2 — JS kernel experiments (after creds)
- [ ] EXP-1: snapshot/restore a WASM linear memory locally (no CF) — prove the core bet
- [ ] EXP-2: Boa (or QuickJS-wasm) eval cells against a persisted context, local
- [ ] EXP-3: run WASM kernel inside a Durable Object, snapshot→SQLite/R2
- [ ] EXP-4: DO WebSocket hibernation + resume kernel from snapshot; measure cold-wake
- [ ] EXP-5: configurable idle policy (warm vs sleep), latency/cost numbers

## Phase 3 — Python kernel
- [ ] Port pattern to RustPython / Pyodide

## Backlog / open
- [ ] Dynamic Worker Loader role for per-tenant kernel loading
- [ ] Rivet ActorCore portability spike
