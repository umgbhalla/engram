# Roadmap TODO — prioritized

> Prioritized roadmap for the substrate build: the next-4 prototypes, the unified-fs
> migration, and secondary directions. Status legend: **□ not started · ◐ in progress
> · ✅ done · 🔬 spike/validate**. Priority: **P0** (critical path) · **P1** (next) ·
> **P2** (opportunistic).

Cross-links: [`COMPUTE-EDGE-AND-SUBSTRATE.md`](./COMPUTE-EDGE-AND-SUBSTRATE.md) ·
[`UNIFIED-FS.md`](./UNIFIED-FS.md) · [`ACTION-ITEMS.md`](./ACTION-ITEMS.md) (the
detailed per-item breakdown this roadmap sequences).

---

## The next-4 prototypes (prioritized)

These are de-risking spikes — each answers a gating unknown before the real build.

| # | Prototype | Pri | Status | Depends on | Answers |
|---|---|---|---|---|---|
| **1** | **Workflows durable fan-out** (Tier3) | P1 | □ | supervisor holds alarms (facets can't); `engram.bind` shape | Can a cell kick a durable map over an fs prefix and collect pointers? First Tier3 muscle. (→ ACTION-ITEMS C4) |
| **2** | **R2-event-notifications + Queues async wake-the-brain loop** | P1 | □ | R2 event rules → Queue consumer → supervisor `fsReconcile`; idempotent reconcile (A3) | Can an *async external* writer (indexer, upload) wake a hibernating session and have its writes reconciled coherently? The substrate's event plane. |
| **3** | **Sandbox-behind-REPL end-to-end** (Tier2) | **P0** | 🔬 | `mountBucket(prefix)`; remount-on-wake; A1/A3/B2 | **Is s3fs `prefix` a real security boundary?** Does a kernel write mid-exec appear in the mount (cache staleness)? `mode:sync` vs `mode:mount` coherence. Gates all untrusted Tier2. (→ ACTION-ITEMS C1) |
| **4** | **Formalize `{wasm}` content-addressed registry as plugin system** (Tier1) | P1 | ◐ | in-flight hash-worker registry workflow; A1, A4 | `sha256=id=integrity=warm-cache-key`; `{wasm}` delivery; per-session invoke gating as the Tier1 plugin surface. (→ ACTION-ITEMS C2) |

**Prototype 3 is P0** because the s3fs prefix-isolation security question gates whether
Engram can ever run untrusted container tenants — the whole substrate-for-others thesis.

---

## Unified-FS migration (the data plane — P0 critical path)

The substrate cannot exist without one coherent fs. Sequenced from
[`ACTION-ITEMS.md`](./ACTION-ITEMS.md); full design in [`UNIFIED-FS.md`](./UNIFIED-FS.md).

| Phase | Work | Pri | Status | Gate |
|---|---|---|---|---|
| **0** | Manifest schema extension (A2: etag/origin + fsVersion + manifest-export ✅) + **verify worker fs wiring (A1: live, stale comment deleted) ✅** + shared `@engram/fs` isolation core into VfsGateway ✅ + `fsReconcile` (A3) | **P0** | ◑ | additive, zero behavior change; A1 was a doc/comment fix (wiring already live); sha256/etag-capture + `fsReconcile` extract still open |
| **1** | `provider:'unified'` = R2 + in-heap LRU cache, `ERR_FS_COLD`, `warm()` (B1) | **P0** | □ | stdlib `readFileSync` compat survey; evict→restore coherence |
| **2** | `live/`+`cas/` namespace, `.engram/manifest.json` export, `vfs-reconcile`, Sandbox wire (B2, C1) | **P0** | □ | D-harness O1/O2/O3 + path-traversal suite |
| **3** | Flip default to `unified`, re-back artifacts on `cas/`, update caveats (B5, B3) | P1 | □ | determinism pins (D2) decided; zero regression on `tests/kernel-rust` |
| **4** | Optional adapters: Cloudflare Artifacts versioner, artifact-fs-in-container; byte quota + GC (D1) | P2 | □ | Artifacts public beta opens |

**Invariant for every phase:** `fs_files.r2_key` indirection means no data ever moves;
`vfs-*` frames / `host.fs` / eval staged-commit keep working byte-for-byte. Branch per
phase (`feat/unified-fs-pN`).

---

## Secondary directions (opportunistic — P2)

| Direction | Pri | Status | Dependency | Notes |
|---|---|---|---|---|
| **AI Gateway binding** (`kind:'cf-binding'`) | P2 | □ | C3 (`engram.bind`) | LLM calls brokered through capability injection + AE metering; obvious RAG/agent-substrate enabler |
| **DO-SQL registry** | P2 | □ | C2 | expose the muscle/binding registry as a queryable DO-SQL surface (discovery, versioning, usage stats) — could later mirror Cloudflare Artifacts' DO-SQLite shape |
| **Service bindings as a muscle kind** | P2 | □ | C3 (`engram.bind` `kind:'service'`) | plug in off-Engram CF Workers/services as muscle behind the same invoke ABI; no code-registry needed |
| **WebGPU-container watch** | P2 | 🔬 watch | platform (CF container GPU availability) | track CF container GPU support → GPU muscle (Tier2 image gen, local model inference) once it lands; no action until platform ships |
| **Cloudflare Artifacts versioning adapter** | P2 | 🔬 watch | Artifacts public beta (~May 2026, may have slipped) | per-session `live/` → Artifacts repo commits at checkpoints → forkable/time-travelable session fs; plugs in via `engram.bind` |

---

## Suggested execution order (one line)

**A1 + A2 + A3 (Phase 0)** → **Prototype 3 (Sandbox security probe, P0)** in parallel
with **B1 (Phase 1)** → **B2 + C1 (Phase 2)** → **A4 + C2/C3 (`engram.bind` + registry)**
→ **Prototypes 1, 2, 4** as the first three bound muscles → **B5 flip default** →
hardening (D1/D2/D3) → secondary directions opportunistically.
