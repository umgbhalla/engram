# Engram — Research Index (condensed)

> The `experiments/` code (proof harnesses, intermediate builds, prototypes) was deleted once the
> conclusions were reached and the system shipped. This file is the condensed record: every experiment,
> its one-line result, and the `docs/` write-up with the full detail. Recover any deleted code from git
> history (it was all committed before this condense).

The arc: **JS-glue kernel → exhaustive R&D → chose Rust → built rquickjs kernel → cut over → all-Rust
platform.** Live: `engram-kernel` (Rust) · `engram-cloud` (Rust facets) · `engram-ui`.

---

## Can the JS brain move to Rust/WASM? (research)

| exp | result | doc |
|---|---|---|
| REWRITE-OPTIONS | 4 paths; only "absorb policy into Rust" passed the gate (low ROI at the time) | `docs/REWRITE-OPTIONS.md` |
| PRIOR-ART | nobody built the whole thing; quickjs-wasi = the snapshot primitive, E2B/Golem = partial peers | `docs/PRIOR-ART.md` |
| e1-rust-quickjs | **rquickjs builds + snapshots a live heap on wasm32-wasip1** (closure 102→103, promise survive) | `docs/WASM-EXPEDITIONS.md` |
| e2-go-goja | goja via TinyGo also snapshots — but 11-12MB wasm + 112MB heaps → too fat, killed | `docs/WASM-EXPEDITIONS.md` |
| w2-boa-snapshot | Boa IS snapshottable by mem-blit (non-moving GC) — ~2× size, parked | `docs/WASM-EXPEDITIONS-2.md` |
| js-floor / rustkernel | Rust kernel slice: eval+snapshot+guards+determinism all in Rust, ~30-50 line JS floor | `docs/RUST-MAXIMAL.md` |
| W1 (cf-wasip1) | a wasip1 module runs on CF via the JS WASI shim → Rust-brain deployable | `docs/WASM-EXPEDITIONS-2.md` |

**Verdict:** ~96-98% of the JS glue is Rust-movable. The Rust kernel was built, gated, and cut over.

---

## Durability stack (built + measured)

| exp | result | doc |
|---|---|---|
| build-baseline | full-dump-every-cell: write-amp 821×–13520× | `docs/DURABILITY-BAKEOFF.md` |
| build-w5 / w5-compaction / kernel-w5 | un-wedge the monotonic-memory P0; gz/used-heap reclaim (raw reclaim impossible — proven) | `docs/W5-COMPACTION-PLAN.md` |
| build-w4 / w4-pagedelta / kernel-w4 | 256B byte-delta: 9-18× fewer bytes; coarse page-delta dead | `docs/W4-BYTEDELTA-PLAN.md` |
| build-e6 / e6-oplog | oplog crash-tail + engine-migration replay | `docs/DURABILITY-ROADMAP.md` |
| build-combined | W5+W4+E6 = production pick: 2.95–7.7× fewer bytes, bounded restore | `docs/DURABILITY-BAKEOFF.md` |
| build-w3 / w3-asyncify | Asyncify mid-cell preempt (1.36× size) — opt-in | `docs/DURABILITY-ROADMAP.md` |
| build-e4 / e4-wizer | wizer-bake cold-create (~9.5ms saved) — marginal | `docs/WASM-EXPEDITIONS.md` |
| e5-fidelity | current engine 21/21 fidelity; snapshot "triple" = the memory image alone | `docs/WASM-EXPEDITIONS.md` |
| r4-raw-reclaim | **full-fidelity raw-buffer reclaim is FUNDAMENTALLY IMPOSSIBLE** (gz/used-heap is the ceiling) | `docs/HARDENING-LOG.md` |
| r4-async-oplog / imp-oplog-hostcall | host-call replay fires effects exactly-once (sync + async) | `docs/HARDENING-LOG.md` |
| r4-multi-evict | state byte-coherent across 5 consecutive cold restores | `docs/HARDENING-LOG.md` |
| imp-promise-fidelity | pending promises survive delta-reconstructed restore | `docs/HARDENING-LOG.md` |
| imp-fs-quota / imp-fs-refcount / w4-fallback | fs quota, O(1) refcount GC, dense-mutation fallback | `docs/HARDENING-LOG.md` |
| r4-r2-tail / realcf | real-CF: R2 GET ~900ms cold; hot-tier (SQLite) wins; chunked-parallel + gz9 dead | `docs/REALCF-VALIDATION.md`, `docs/R2TAIL-REALCF.md` |

---

## Sandbox APIs (prototyped, coherent)

| exp | result | doc |
|---|---|---|
| protoA-host-fs | R2-backed virtual fs, content-addressed, write-commits-before-checkpoint (22/22) | `docs/SANDBOX-API.md` |
| protoB-timers | durable seeded-virtual-time timers, exactly-once across eviction (13/14) | `docs/SANDBOX-API.md` |
| protoC-env-deny-audit | frozen env + deny-by-default, no sandbox escape (17/17) | `docs/SANDBOX-API.md` |
| d-coherence | the staged-commit coherence invariant (commit host writes before checkpoint) | `docs/SANDBOX-API.md` |

---

## Kernel builds + cutover (the convergence)

| exp | result | doc |
|---|---|---|
| kernel-rust → kernel-rust1b → kernel-rust2 → kernel-rustf | the Rust kernel, 1a parity → 1b durability → Tier-0 + AE, gate-proven | `docs/RUST-KERNEL-P1A.md`, `RUST-1B-REGATE.md`, `RUST-FINAL-GATE.md` |
| adv-cur / adv-w4 | adversarial red-team across versions: zero breaches (found the W4 ceiling regression + Rust guard gap) | `docs/ADVERSARIAL.md` |
| sdk-v2 | the dev-friendly `@engram/sdk` v2 (now `packages/sdk`, strict TS) | `docs/CONVERGENCE-WAVE.md` |
| cloud-rust | Rust kernel as a multi-tenant facet (now `apps/cloud`) | `docs/CLOUD-RUST-REWIRE.md`, `PLATFORM-ON-RUST.md` |

---

## Older provenance (pre-Rust, in git history + `docs/results/`)

EXP-1/4b/5a/6/7/8/9 (the original feasibility proofs) → `docs/results/exp-*.md`. V0→v0.9.3 JS-kernel
milestones + the v1-facet spike → `docs/results/*.md`. The system reached "product complete" as a JS
codemode/RLM platform, then converged to the Rust durable-REPL core (RLM stripped).

**Full decision trail:** `docs/STATE-OF-THE-ART.md` · `RUST-KERNEL-PLAN.md` · `PLATFORM-ON-RUST.md`.
