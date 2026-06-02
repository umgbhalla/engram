# WASM Internals Expeditions — Final Verdict

> Synthesis of 6 build-and-measure expeditions (E1–E6) probing whether Engram's kernel "brain"
> should move from hand-written JS glue toward Rust- or Go-to-wasm internals.
> Constraint throughout: **Cloudflare-only** (workerd / Durable Objects / wasm32, CompiledWasm delivery).
> All numbers below were actually built and measured locally; artifacts cited per row.

## 1. THE VERDICT — blunt

**PARTIAL — adopt the cold-create and durability optimizations now; do NOT rewrite the kernel brain into Rust/Go internals.**

The thesis "move the brain from JS glue into Rust(or Go)-to-wasm" is **technically proven possible (E1, E2) but not worth doing**, for three measured reasons:

1. **There is nothing to fix.** E5 proved the *current* JS-glue + quickjs-wasi engine already snapshots at **full fidelity** — closures, pending promises, Map/Set/typed-arrays/Date/regex/bigint/symbol/class-instances all round-trip byte-exact, and the "snapshot triple" is in fact a **single element: the linear-memory image** (rt/ctx pointers are redundant, `__stack_pointer` is always at base 1048576 between cells). A Rust/Go rewrite would buy zero fidelity.
2. **Rust-QuickJS only builds on `wasm32-wasip1`, NOT `wasm32-unknown-unknown`** (E1) — and our deployed engine is already a wasip1-style module delivered as CompiledWasm, so a Rust port would land at the *same* substrate it's at today, after a full rewrite, for no capability gain.
3. **Go/goja is disqualified on cost, not correctness** (E2): the snapshot mechanism works, but the wasm is **11–12 MB (~7–8× the current 1.4–1.7 MB)** and a trivial 40k-object session balloons to **112 MB linear memory** — far past Engram's ~20 MB safe / 45 MB hard dump ceiling. Dead on arrival for CF bundle + dump limits.

The real wins are **complementary, not a rewrite**: bake the cold-create path (E4) and compact durable writes (E6). Both are borrowable into the existing kernel with no brain surgery.

## 2. Per-expedition one-line result (the deciding number)

- **E1 Rust-QuickJS (rquickjs):** Live-heap round-trip **PASS** (closure 102→103, global x=42, pending promise→7 all survived a 1.28 MB dump+blit) — **but builds ONLY on wasm32-wasip1; wasm32-unknown-unknown fails (`stdio.h not found`, rquickjs #93).** Decider: no new capability vs today's engine.
- **E2 Go/goja (TinyGo):** Round-trip **PASS** incl. GC-safe post-restore — **but wasm = 11–12 MB and 40k objects → 112 MB linear memory**, both past CF ceilings. Decider: **KILL** on size.
- **E3 chiwawa mid-stack:** True mid-instruction checkpoint **PASS** (587 B captured the operand stack+PC of a loop at instr 50000, fresh process resumed to exact 199990000) — **but ~4.15× per-instruction overhead (621 ms → 2580 ms) and it snapshots the *wasm* guest, not JS frames.** Decider: **DEAD-END** for our mid-JS-cell gap.
- **E4 Wizer-bake cold-create:** Baked QuickJS+81 KB stdlib heap instantiates live (`_.sum`/`dayjs` callable, no re-eval) — **saves 10.73 ms/create (143 ms/MB inject moved to deploy-time), cost ~2× shipped gz (0.58→1.11 MB).** Decider: **PURSUE.**
- **E5 Snapshot-triple fidelity:** **21/21 PASS** on the current engine; **minimal correct triple = the linear-memory image alone** (only 1 mutable global `__stack_pointer`, always base; rt/ctx redundant at fixed offsets 1161128/1161132). Decider: current engine is already right.
- **E6 Oplog-hybrid durability:** Full snapshot every N cells + recorded-result oplog → **80–96.5% fewer durable bytes, write-amp 39.5× → 1.4–7.9×, restore <15 ms, byte-identical state, side effects fire 0/3 on replay.** Decider: **ADOPT.**

## 3. What is now PROVEN (built + measured) vs still THEORETICAL

**Proven (built + measured locally):**
- Current quickjs-wasi engine snapshots at full fidelity; the snapshot is effectively just `memory.buffer` (E5: 21/21; globals disassembled; rt/ctx ablation +0..+4096 all silent-ok).
- Rust-driven QuickJS *can* snapshot a live heap on wasm32-wasip1 (E1) — and *cannot compile at all* on wasm32-unknown-unknown.
- Go/goja *can* snapshot (E2) but at 7–8× wasm size and runaway linear-memory growth.
- Wizer can pre-bake a booted QuickJS+stdlib heap into the wasm, instantiating live from a precompiled Module (the workerd CompiledWasm contract), saving the full inject cost (E4: 10.73 ms / 81 KB, 143 ms/MB).
- The oplog-hybrid cuts write volume 80–96.5% with byte-identical restore and zero side-effect re-firing because Engram already mediates all I/O (E6).
- chiwawa's mid-instruction capture works but at 4.15× and only at wasm-frame (not JS-statement) granularity (E3).
- Two latent **extra-heap** hazards confirmed (E5): un-re-registered host callbacks **silently return undefined** (no throw), and host entropy/clock is **not** frozen by the snapshot.

**Still theoretical / NOT yet run on real workerd:**
- All six ran in Node/wasmtime as stand-ins — **none executed inside a real Cloudflare DO under WS hibernation.** The mechanism is identical to the DO path, but on-platform timing/limits are unconfirmed.
- E4 big bundles (468 KB lodash+dayjs+zod+ramda) **failed to bake** on a source-parse incompat (esbuild browser-target token under bare quickjs-ng) — needs esbuild-target tuning before baking real stdlib subsets.
- E1/E2 pending-promise parity: E1 proved it; **E2 (goja) never tested promises** (synchronous harness) — parity unproven.
- E4 ~2× gz size impact on cold-wake/R2-read budget at our real stdlib sizes is unmeasured on-platform.

## 4. RECOMMENDED DIRECTION — sequenced, low-risk

**Keep the JS-glue + quickjs-wasi brain. Borrow, don't rewrite.** Sequence:

1. **Fold E5 fidelity fixes into the product now (cheapest, highest safety ROI).**
   - Stop storing/relying on rt/ctx as authoritative — the memory image is the source of truth; keep writing rt/ctx only as a cheap belt-and-suspenders, or drop to shrink the manifest.
   - **Assert, don't silently pass:** after restore, verify host callbacks are re-registered and *throw* if a `host.*` call resolves to undefined (closes the silent-wrong-answer hazard E5/F1).
   - Confirm seeded clock/RNG externalization is mandatory and enforced (E5/F4) — already done, add a regression test.

2. **Adopt E6 oplog-hybrid durability (high value, isolated change).** Full snapshot every N cells + gzipped recorded-result oplog between; restore = last full + replay tail. Start conservative (N=5–10: 80–90% byte reduction, restore <6 ms). Record host-call results in the oplog (proven to suppress side-effect re-firing 0/3). Document the single tradeoff: a crash mid-window re-runs cell CPU (never re-fires effects). Gate behind a config flag; validate on a real DO before defaulting on.

3. **Pursue E4 Wizer-bake for the stdlib cold-create path (medium value, deploy-time only).** Bake the default stdlib subset into the shipped wasm so cold-create skips inject (saves ~70–140 ms for a 500 KB–1 MB bundle). **Blockers to clear first:** (a) fix the esbuild-target parse incompat so real bundles bake; (b) measure the ~2× gz size hit against the cold-wake/R2-read budget — if it pushes images past 2 MB gz it can cost more on wake than it saves on create. Ship only the bundle subset that nets positive on-platform.

4. **SHELVE E1 Rust-QuickJS.** Re-open ONLY if a future need appears that JS glue genuinely cannot meet (e.g. tighter mid-cell control or a non-QuickJS engine). It builds on wasip1, so the door is open — but today it's a rewrite for parity, not progress.

5. **KILL E2 Go/goja.** Size and memory-growth are structural, not tunable. Do not revisit unless TinyGo's GC and wasm size change fundamentally.

6. **TREAT E3 chiwawa as future research only.** It does not address our actual gap (mid-JS-statement resumption); nesting QuickJS under it still lands at a wasm-frame boundary at 4.15× cost. Park it.

## 5. Anything that flips a previously-rejected conclusion

- **Mostly confirms, does not flip.** The headline prior bet — "WASM linear memory IS snapshottable; the JS-glue path is the right substrate" — is now independently re-proven from three angles (E1 Rust, E2 Go, E5 current engine), strengthening rather than overturning it.
- **One refinement, not a reversal:** the long-standing "snapshot triple = memory + stack-pointer + rt/ctx" framing is now shown to be **over-specified** — the correct minimal snapshot is the **memory image alone** (E5). This is a tightening of an existing assumption, safe to act on.
- **No previously-rejected path is resurrected.** Go/goja, chiwawa-nesting, and a full Rust rewrite were all (implicitly) low-priority; the measurements confirm keeping them shelved/killed. The Rust port is now *known to build on wasip1* (mild positive vs the rquickjs-#93 fear) but that does not change the build/no-build decision.

---

**Bottom line for the owner:** the brain is already correct and complete; don't rewrite it. Spend the effort on E5 assertions (safety), E6 oplog (write cost), and E4 wizer-bake (cold-create) — all bolt-ons to the existing kernel. Validate each on a real DO before defaulting on.
