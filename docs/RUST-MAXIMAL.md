# RUST-MAXIMAL — moving Engram's kernel to Rust, decided on TRUST (not ROI)

> The decision axis here is **owner distrust of the hand-written JS glue**, treated as a
> first-class requirement. This document does NOT argue from ROI or feature parity — the prior
> rejection (`docs/REWRITE-OPTIONS.md`) already did the parity math and said "no parity gain, don't
> rewrite." That conclusion is **refined/retracted at the end (§5)** because the axis changed.
>
> Backed by four investigation tracks: glue.js dissection (T1), a built rquickjs kernel slice
> (T2, `experiments/rustkernel/`), an irreducible-JS-floor probe (T3, `experiments/js-floor/`),
> and a reframed-decision analysis (T4).

---

## 1. DIRECT ANSWER — how much of the hand-written JS can become Rust?

**Almost all of it. The kernel-side hand-written JS floor is effectively zero.**

`apps/kernel/src/glue.js` is **1604 lines / 65,509 bytes** (`wc -l`/`-c` — the "2016-line" figure in
the original brief is stale/pre-refactor). Three independent tracks converge:

| Track | Method | Rust-movable | Irreducible kernel JS |
|---|---|---|---|
| **T1** glue.js dissection (classification) | static, against rquickjs API + E1 proof | **~96–98%** of bytes (≈1550–1574 / 1604 lines; ≈63–64 KB / 65.5 KB) | ~30–50 lines (the in-VM `host` Proxy + `Date` Proxy trap) |
| **T2** built rquickjs kernel slice | **built + ran** (`experiments/rustkernel/`, PASS=true) | **~90–95%** of logic, proven Rust-side | only WASI shim + raw `memory.buffer` blit (substrate, not logic) |
| **T3** irreducible-JS-floor probe | **built + ran** (`experiments/js-floor/`, ALL_OK=true) | **~100%** of kernel glue | **~0 lines** of hand-written kernel JS |

**The headline:** the snapshot/restore machinery — the part the owner most distrusts — is **already
host-side** today. `quickjs-wasi`'s `serializeSnapshot`/`deserializeSnapshot`/`restore` JS wrappers
are replaceable by a **raw `memory.buffer` blit**, which is exactly what E1
(`experiments/e1-rust-quickjs/snapshotter/src/lib.rs`) already did host-side: a closure (102→103),
a global (`x=42`), and a pending promise (→7) survived a dump/restore into a fresh instance.

**Why the floor collapses to near-zero (T3 is the load-bearing finding):** the seeded clock/RNG/crypto
overrides and the host boundary do **not** need to run as an `eval`-ed JS string inside the sandbox.
T3 built a real rquickjs binary and proved against a live VM, with **zero eval-ed kernel JS**:

- A Rust closure bound as a JS global is callable from JS.
- `Date.now` and `Math.random` were **overridden by reflection from Rust** — get `globalThis.Date` /
  `globalThis.Math` as `Object`s, `.set('now'/'random', rustFn)` — verified seeded+monotonic
  (`Date.now → 1700000000000` then `…001`) and deterministic+re-seedable (`Math.random` reproduced
  `0.10615200875326991` byte-for-byte after re-seed).
- `host.kv.get` was built **entirely from Rust** (`Object::new` + `Function::new`, no proxy JS
  string) and returned `'value-for:alpha'` from JS.
- Entropy counters live in Rust (`Rc<Cell>`), **outside** the wasm JS heap.
- The async `host.fetch`/`subLM` deferred-promise pattern (`glue.js` `vm.newPromise()`, ~L496-508)
  maps 1:1 to rquickjs `ctx.promise() → (Promise, resolve, reject)`
  (`experiments/_src/rquickjs/core/src/context/ctx.rs:382`).

So the entire `REBIND_SRC` block (`apps/kernel/src/glue.js:332-419`, ~110 lines / 3867 bytes) — the
only span of hand-written JS that runs as guest code today — **collapses to Rust setup calls.** T1's
more conservative count leaves a ~30–50 line floor (the recursive `host` Proxy at L386-418 and the
`Date` constructor Proxy trap at L337-344) **if** you choose to keep Proxy-based dispatch; T3 shows
even those are reproducible from Rust if you bind per-function instead of via a Proxy. **The honest
range for the irreducible hand-written *kernel* JS floor is 0 to ~50 lines.**

**What stays JS regardless (this is platform glue, NOT the distrusted kernel logic):**
- The CompiledWasm import + the ~9-function JS WASI preview1 shim that instantiates the engine and
  owns its imports (`random_get`, `clock_time_get`, `fd_write`, `proc_exit`, …). workerd forbids
  runtime `WebAssembly.compile`, so the module must arrive pre-compiled and be instantiated by JS.
- The raw `memory.buffer` read→bytes (dump) / bytes→blit (restore) + `memory.grow` — the snapshot
  *substrate*.
- The **gzip/gunzip pipeline** (`glue.js:158-167` uses `CompressionStream`; no equivalent in
  workers-rs, only `FixedLengthStream`).
- User-submitted code and any user-selected stdlib text bundles — JS by definition.

**One PARTIAL (T1):** `ctx.grep` (`glue.js:688-717`). JS `RegExp`-flag fidelity differs from the Rust
`regex` crate, so moving it is a behavior change, not a clean lift.

---

## 2. What a full rquickjs Rust kernel looks like (architecture)

The kernel is **already two separate wasm artifacts in different ABI worlds** — this is the fact the
prior rejection missed:

1. **DO shell** — `apps/kernel/src/lib.rs`, workers-rs (`worker`/`worker-macros` 0.8,
   `Cargo.toml:9-16`) → `wasm32-unknown-unknown`. Identity, SQLite, alarms, WS, mutex,
   checkpoint commit-ordering.
2. **Engine** — `quickjs.wasm`, a *separate* wasip1-style module imported as a **CompiledWasm asset**
   by `entry.mjs`, driven by the 1604-line `glue.js` via the npm `quickjs-wasi` wrapper.

**These do NOT statically co-link.** `entry.mjs`/`glue.js` instantiate `quickjs.wasm` under a JS WASI
shim. A full rquickjs kernel slots into the **same shape**:

```
  Cloudflare DO (workers-rs, wasm32-unknown-unknown)   ← unchanged ABI
        │  CompiledWasm import + ~9-fn JS WASI shim + gzip pipeline   ← stays JS (~100-200 lines)
        ▼
  ONE Rust cdylib (wasm32-wasip1):  rquickjs drives QuickJS
        ├─ eval_cell()                  ctx.eval, JSON stringify Rust-side
        ├─ snapshot / restore           copy memory.buffer → bytes; blit into fresh instance + reattach()
        ├─ guards                       set_interrupt_handler (instr budget) + set_memory_limit
        ├─ determinism                  Rust LCG clock + RNG, injected as host Fns, reflected onto Date.now/Math.random
        ├─ host boundary                __hostCall/fetch/subLM/console via Function::new + ctx.promise()
        ├─ used-heap introspection      memory_usage / memory_used_size
        ├─ config normalize, kv/ctx hydrate, value preview, error format   ← all Rust
        └─ Tier-0 extensions            statically linked into the wasm (no descriptor plumbing)
```

Every runtime-control primitive `glue.js` relies on exists in the rquickjs Rust API, verified in
`experiments/_src/rquickjs/core/src/runtime/base.rs`: `set_interrupt_handler` (L89,
`Box<dyn FnMut()->bool>`), `set_memory_limit` (L123), `set_max_stack_size` (L132),
`set_gc_threshold` (L139), `run_gc` (L158), `memory_usage` (L165); confirmed at the raw FFI layer in
`raw.rs` (L246/282/287/390).

**T2 proves the slice works end-to-end.** `experiments/rustkernel/` is a wasm32-wasip1 crate (rquickjs
0.12, **748 KB** release wasm) doing eval / heap-snapshot+restore / guards / seeded determinism in
Rust with **zero hand-written JS glue** (`harness.mjs` only provides the WASI shim + literal blit).
`PASS=true` on all assertions:
- Snapshot = copy `memory.buffer` (1.34 MB) → bytes; restore = blit into a fresh instance +
  `reattach()`. Closure private `_n` 102→103, global `x=42`, **pending promise resolved to 7 after
  restore**, and the Rust-side deterministic clock continued across the blit (A ended 1001, B read
  1002). Dump ~0.14 ms, blit ~0.12 ms.
- Interrupt instruction-budget tripped a `while(true)` (`tripped=true`) and recovered (next eval=2).
- `set_memory_limit` (64 MB) caught a 5M-object alloc bomb as a **catchable** Exception, recovered.
- Two fresh same-seed instances produced byte-identical `Math.random`+`Date.now` sequences.

One rquickjs quirk found (T2): overriding `Date.now`/`Math.random` via `ctx.eval` inside `create()`
did not persist to later evals; the identical override applied lazily on the first `eval_cell` did —
a context-warmup ordering quirk, **one-line workaround, not a blocker**.

---

## 3. GAINS vs COSTS — honest both ways

### GAINS (the actual requirement: trust / maintainability)
- **One language.** The DO shell is already Rust; the engine driver joins it. No more
  Rust↔JS↔wasm three-body problem for the distrusted logic.
- **The ~1604-line hand-written glue.js — the artifact under suspicion — is eliminated** (down to a
  ~100–200 line platform shim that is *mechanically* WASI/gzip plumbing, not bespoke kernel logic).
- **Typed Result API + borrow checker over the dump/restore byte-handling** — the snapshot machinery
  (the most-distrusted part) gets compile-time discipline instead of raw handle juggling and manual
  `DataView` offset arithmetic.
- **Native `cargo test`** for guards/determinism/snapshot, instead of JS-in-wasm harnesses.
- **Tier-0 C extensions statically linked** into the rquickjs wasm — the descriptor/order plumbing
  (re-instantiate at fixed bases before blit) **disappears entirely**.

### COSTS (honest)
- **Full rewrite of eval / host / guard / snapshot orchestration** — several KLOC of Rust. There is no
  partial-credit path for the engine swap (see §4).
- **rquickjs is far less CF-/wasip1-/snapshot-proven than the shipped `quickjs-wasi` 3.0.0.** This is
  the real risk. The incumbent has been hardened across V0→v0.9.3 + V1.0 + deep-hibernation +
  scale tests. A Rust engine resets a chunk of that battle-tested confidence to "proven in
  experiments, not in production."
- **The gzip dump pipeline cannot move** (no `CompressionStream` in workers-rs) — it stays in the JS
  shim. Net: you don't get a literally pure-Rust kernel; you get a Rust kernel + a thin JS
  WASI/gzip/CompiledWasm shim.
- **CF wasip1 delivery is real but slightly off the beaten path** — works via CompiledWasm + JS WASI
  shim (proven, see below), but it's not the documented happy path.

### LOST
- The **maturity / CF-proven-ness of `quickjs-wasi`** — the single biggest thing you give up. This is a
  trade of *trust-in-our-own-code* for *loss-of-trust-in-a-battle-tested-dependency*. Name it honestly.

### Platform viability is NOT a cost — it's settled
The prior rejection (`docs/REWRITE-OPTIONS.md`, TRACK1-REJECT) claimed rquickjs is
"unbuildable… the two ABIs cannot co-link." **This rests on an ABI conflation the repo's own
experiments disprove:**
- The `wasm32-unknown-unknown` build failure (`'stdio.h' file not found`, rquickjs #93) is **real and
  reproduced** — but **irrelevant**, because the engine is a *separate CompiledWasm module*, not
  statically co-linked into the workers-rs DO. They never co-link in the incumbent either.
- `cargo build --target wasm32-wasip1` **succeeds in ~6 s, ~725 KB** (E1; reproduced).
- A wasip1 rquickjs module **runs live on Cloudflare** under a 9-fn JS WASI shim and blits a live heap
  into a fresh instance (W1 / `docs/WASM-EXPEDITIONS-2.md:18-32,109` — "FLIP 1: wasip1 DOES run on CF
  via CompiledWasm + JS shim"; E1 moved SHELVE→VIABLE). The repo's own recommendation there was
  **"Park with the door open"** (L195) — viable, gated only on need.

**The door REWRITE-OPTIONS nailed shut is in fact open.** Trust is the need that opens it.

---

## 4. RECOMMENDATION

### Is the Rust-maximal rewrite worth doing *for trust*?
**Conditionally yes — but do NOT start it now, and do NOT big-bang it blind.**

The engineering is de-risked: T2/T3 prove eval, snapshot/restore, both guards, seeded determinism,
host boundary, and async promises all work from Rust, on the CF-viable wasip1 target. The
*requirement* (owner distrust) is legitimate and not satisfiable by anything short of replacing the
glue. So if trust in the kernel is a standing requirement, the rewrite is justified.

The cost that should give pause is **not feasibility — it's regression risk against a battle-tested
incumbent.** You are trading distrust-of-our-JS for the loss of `quickjs-wasi` maturity. That trade
is only net-positive if the new Rust engine earns back the hardening (V0→v0.9.3 envelope numbers,
deep-hibernation 7/7, scale 0-err@200) the incumbent already has.

### Incremental vs big-bang
**The engine swap is fundamentally big-bang** — you cannot incrementally move `eval` into Rust while
keeping `quickjs-wasi`, because the engine *binary itself* changes. There is no half-state where half
the cells run on Rust-rquickjs and half on quickjs-wasi over the same heap.

**But two things CAN pre-migrate incrementally, independently, with zero engine change:**
1. **Guard constants + thresholds** (`MAX_DUMP_BUFFER_BYTES`, cell budget, mid-cell tripwire limits)
   → move into `lib.rs` (the DO shell) now.
2. **Fetch-allowlist policy** → `lib.rs` now.

Do those first as low-risk Rust-confidence builders that also shrink `glue.js` ahead of the swap.

### Recommended sequence
1. **NOW:** finish in-flight **W5/W4 durability work** on the incumbent. Do **not** fork the engine
   mid-durability-hardening — you'd be hardening a thing you're about to throw away, and splitting
   scarce test attention across two engines.
2. **In parallel, low-risk:** pre-migrate guard constants + fetch-allowlist into `lib.rs`. Keep
   `experiments/rustkernel/` and `experiments/js-floor/` alive as the reference kernel.
3. **THEN, as a dedicated milestone (not interleaved):** big-bang the engine — promote
   `experiments/rustkernel/` to a real kernel crate, wire the CompiledWasm + WASI + gzip shim, and
   **re-run the full incumbent test gauntlet** (V0.7 guards, v0.8 tripwire, deep-hibernation, scale,
   determinism byte-identity) against it. The Rust engine ships only when it **matches the incumbent's
   proven envelope**, not when it merely passes a smoke test.
4. Keep the incumbent deployed and switchable until the Rust kernel clears the gauntlet.

**Sequencing rule: durability work owns the engine until it's done. The rewrite is the next
milestone, not a concurrent track.**

---

## 5. RETRACT / REFINE the prior "no parity gain, don't rewrite" conclusion

**REFINED, with one explicit RETRACTION.**

- **RETRACT** the technical premise: `docs/REWRITE-OPTIONS.md`'s claim that the rquickjs Rust kernel
  is **"unbuildable / the two ABIs cannot co-link"** is **wrong**, and the repo's own experiments
  disprove it. The `wasm32-unknown-unknown` `stdio.h` failure is real but irrelevant — the engine is a
  decoupled CompiledWasm module that builds clean on `wasm32-wasip1` and runs on CF (E1, W1,
  `WASM-EXPEDITIONS-2.md`). T2 then **built and ran** the full slice. The door is open.

- **REFINE, not retract,** the conclusion itself: "no parity gain, don't rewrite" was **correct on its
  own axis (ROI/parity)** — a Rust engine buys ~nothing in features or performance over the
  hardened `quickjs-wasi` kernel, and at the time carried unmeasured platform risk. That reasoning
  stands *for the ROI question*.

- **The axis changed.** The owner's requirement is **trust/maintainability of the hand-written kernel
  JS**, not ROI. On the trust axis the prior conclusion **does not apply**: the rewrite's payoff is
  precisely "eliminate the distrusted ~1604-line glue.js and replace it with typed, one-language,
  cargo-tested Rust," which the parity analysis explicitly did not value. T1/T2/T3 show ~96–100% of
  kernel glue is movable and the irreducible hand-written kernel-JS floor is **0–50 lines**.

**Net:** the prior "don't rewrite" was right to reject a *parity* rewrite and wrong about
*buildability*. For a **trust** rewrite it is superseded — the work is viable, de-risked at the
prototype level, and justified by the stated requirement; it should be **scheduled as the milestone
after W5/W4 durability**, executed big-bang for the engine with incremental pre-migration of
guard/allowlist constants, and shipped only after it re-clears the incumbent's full test envelope.

---

### Evidence index (paths / refs)
- `apps/kernel/src/glue.js` — 1604 lines / 65,509 bytes; `REBIND_SRC` L332-419 (3867 B);
  host Proxy L386-418; Date trap L337-344; `newPromise` ~L496-508; gzip L158-167;
  `grep` L688-717.
- `apps/kernel/src/lib.rs`, `Cargo.toml:9-16` — workers-rs DO shell, wasm32-unknown-unknown.
- `apps/kernel/entry.mjs` — quickjs.wasm as separate CompiledWasm + JS shim (not co-linked).
- `experiments/rustkernel/{src/lib.rs,Cargo.toml,harness.mjs}` + built
  `target/wasm32-wasip1/release/rustkernel.wasm` (748 KB) — T2, PASS=true.
- `experiments/js-floor/src/main.rs` — T3, ALL_OK=true; js-floor.wasm 779 KB.
- `experiments/e1-rust-quickjs/snapshotter/src/lib.rs` + `harness.mjs` — E1 raw-blit snapshot proof.
- `experiments/_src/rquickjs/core/src/runtime/base.rs` L89/123/132/139/158/165; `raw.rs`
  L246/282/287/390; `core/src/context/ctx.rs:382` (`promise()`).
- `docs/REWRITE-OPTIONS.md` — prior rejection (TRACK1-REJECT) being refined/retracted here.
- `docs/WASM-EXPEDITIONS-2.md` L18-32, L109, L195 — wasip1-on-CF FLIP + "park with door open".
- rquickjs 0.12.0 (Cargo.lock); rquickjs issue #93 (wasm32-unknown-unknown `stdio.h`).
