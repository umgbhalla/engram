# Rust Kernel — Convergence Plan (DECISION: B)

> **Decided:** Engram's kernel converges to **rquickjs-Rust** (owner choice B, 2026-06). The 2000-line
> hand-written `glue.js` is replaced by Rust: eval + snapshot + guards + host-boundary + determinism all
> Rust (borrow-checked), with only a ~30-50 line in-VM JS bootstrap remaining. Proven feasible:
> `experiments/rustkernel/` already runs eval+snapshot+2 guards+determinism in pure Rust on wasm32-wasip1
> (`docs/RUST-MAXIMAL.md`); E1+W1 proved it builds + snapshots + deploys on CF.
>
> No more exploratory research — the search space is mapped (`docs/STATE-OF-THE-ART.md`). Every step below
> is convergent build work. Live `engram-kernel` (the JS kernel) stays the fallback through cutover.

---

## Target architecture

```
   ┌ engram-kernel (Rust) ───────────────────────────────────────────────┐
   │  Rust DurableObject (workers-rs)                                      │
   │    WS/HTTP frame router (parity: create/eval/ping/gen/reset/evict/…)  │
   │    eval         rquickjs ctx.eval (Rust)                              │
   │    snapshot     raw memory.buffer blit → DO SQLite chunks / R2        │
   │    guards       interrupt budget + memory limit + BUFFER-GROWTH       │
   │                 TRIPWIRE (Rust closures — the adversarial gap fix)    │
   │    host fns     fetch/kv/ctx bound as RUST closures (no __hostCall JS)│
   │    determinism  seeded clock+RNG injected from Rust                   │
   │    durability   W5 compaction + W4 byte-delta + E6 oplog (Rust)       │
   │  in-VM JS floor ~30-50 lines: the `host` Proxy + Date trap only       │
   └──────────────────────────────────────────────────────────────────────┘
   engram-cloud bakes the Rust kernel · engram-ui unchanged (same WS protocol)
```

---

## What carries over (don't re-derive)

```
   from the JS kernel (port the LOGIC, rewrite in Rust):
     guards          18MB dump ceiling · 50MB used · 16MB native · 1200/2000 tick · 8/16MB mid-cell
     + NEW           buffer-growth tripwire (set_memory_limit MISSES fast-array growth — adversarial #2)
     determinism     epoch 1.7e12 + 1ms tick · mulberry32/seeded WASI random_get · entropy counters
     snapshot        raw memory.buffer + globals; SQLite-first <2MB gz / R2 overflow; crash-atomic commit
     durability      W5 (used-heap admission + scrub, NOT raw reclaim — proven impossible) · W4 256B delta
                      · E6 oplog (crash tail + engine-migration) — all real-CF-proven in experiments/
     fixes           preview formatter (util.inspect-style) · W4 ceiling regression (keep absolute cap)
   irreducible JS (~30-50 lines): in-VM `host` Proxy dispatcher + Date constructor trap
```

---

## Staged sequence

```
   PHASE 0 — solidify the JS kernel (proven fixes; OWNER-OK to deploy live)
     merge into live engram-kernel, each behind evict→cold-restore gate + version anchor:
       W5 un-wedge (proven) · preview fix (building) · W4 delta (after fixing the ceiling regression)
     → prod solid TODAY; JS kernel becomes a strong fallback during the Rust build.
     STATUS: gated on explicit owner OK to touch production.

   PHASE 1 — build the Rust kernel  ◀ STARTING NOW (experiments, autonomous)
     1a. extend experiments/rustkernel → a full deployable Rust DO worker:
         WS frame router + eval + stateful sessions + DO-SQLite snapshot/restore + seeded determinism
         + all guards (incl buffer-growth tripwire) + host.fetch/kv + Tier-0 (static-link the .so) + the
         tiny in-VM JS bootstrap. Target: v0.9.3 feature PARITY.
     1b. port the durability stack into Rust: W5 compaction + W4 byte-delta + E6 oplog.

   PHASE 2 — prove parity (the gate; scratch worker engram-rust, never live)
     run the FULL suite vs the JS kernel: functional 24/24 · adversarial (all suites, incl the
     buffer-growth bomb) · durability (wedge/byte/multi-evict) · real-CF latency+bytes. Must MATCH or BEAT
     the JS kernel on every axis.

   PHASE 3 — cutover
     swap engram-kernel → Rust build when Phase-2 green. Keep the JS build as instant version-rollback.
     engram-cloud re-bakes against the Rust kernel. engram-ui untouched (WS protocol identical).
```

---

## The gate (Rust kernel cannot replace JS until ALL green)

```
   functional     24/24 (the live-infra-test suite) on the Rust kernel
   adversarial    every suite survives — ESPECIALLY the fast-array buffer-growth bomb that
                  beat rquickjs set_memory_limit (must be caught by the new tripwire, socket alive)
   durability     wedge un-stuck · byte-delta reduction · multi-evict coherent · determinism byte-identical
   real-CF        cold-restore latency + stored bytes ≤ the JS kernel; R2 hot-tier policy
   parity         every v0.9.3 frame type + host fn + Tier-0 ext behaves identically
   rollback       JS kernel version anchor retained; one-command revert
```

---

## Risks (honest)

```
   ⚠ rquickjs maturity   less battle-tested than quickjs-wasi; pin the version, test hard
   ⚠ Tier-0 extensions   static-linking the 5 C .so into the rquickjs wasm (vs the JS descriptor plumbing)
   ⚠ snapshot parity     the Rust raw-blit must capture the SAME bytes the JS path does (E5 triple)
   ⚠ effort              a real rewrite; staged + gated to de-risk, JS fallback throughout
   ✓ feasibility         already proven (rustkernel slice + E1 + W1) — not speculative
```

**Convergence rule:** no new "what if" research. Build the Rust kernel, gate it, cut over. JS kernel is the
safety net until the Rust kernel beats it on every axis.
