# WASM Internals Expeditions — Round 2 (Wider Findings)

> Updates `docs/WASM-EXPEDITIONS.md` with 7 wider tracks (W1–W7) that re-stress the prior verdict and
> resurrect dead paths. Same constraint: **Cloudflare-only** (workerd / Durable Objects / wasm32,
> CompiledWasm or `{wasm}` Worker-Loader delivery). Every number below was built and measured locally;
> artifacts/commands/URLs cited per claim. The prior verdict ("do NOT rewrite the brain into Rust/Go;
> adopt E6 oplog-hybrid + E4 wizer-bake; thesis re-proven from 3 engines") is **amended, not discarded** —
> the *don't-rewrite-for-parity* logic holds, but several "dead" paths flipped to **viable** and two new
> pain-killers landed.

---

## 1. WHAT CHANGED — the flips

Three previously-shelved/rejected conclusions **flipped to viable**. One stays partially open. Two stay
dead but are now formally autopsied. The exotic-substrate cast found **nothing better on CF**.

### FLIP 1 (the big one) — W1: a `wasm32-wasip1` module DOES run on Cloudflare → the Rust-brain path is no longer dead.

The prior round shelved E1 (Rust-QuickJS / rquickjs) partly on the latent fear that wasip1 might not be
runnable on CF. **That fear was wrong, and it was wrong about Engram's own shipping kernel.** The deployed
`apps/kernel/src/quickjs.wasm` **is already a wasip1-style module running on CF**: it imports
`wasi_snapshot_preview1.{clock_time_get,fd_close,fd_fdstat_get,fd_seek,fd_write,random_get}` (verified
`wasm-tools print`), is delivered via the `CompiledWasm` wrangler rule (`apps/kernel/wrangler.jsonc`,
`entry.mjs: import quickjsModule from './src/quickjs.wasm'`), and its WASI imports are satisfied by the
quickjs-wasi package's pure-JS `dist/wasi-shim.js` (6 functions). **A Rust-built wasip1 QuickJS is the same
module type with the same import namespace; it deploys the identical way — no rewrite of the delivery path,
no runtime `WebAssembly.compile`.** E1 needs 9 WASI fns (adds `environ_get`/`environ_sizes_get`/`proc_exit`);
the 3 extra are trivial no-op/zero stubs.

Local proof (W1, `/tmp/shimtest.mjs`): instantiated the E1 rquickjs `snapshotter.wasm` under a hand-rolled
9-function JS WASI shim (deliberately **not** `node:wasi` — the workerd-compatible pattern), round-tripped a
live heap: `setup→inc 101,102`, dumped full linear memory, blit into a fresh instance under the same shim,
`reattach()=1`, `poke_inc()=103` (closure private state survived), `read_x()=42` (global survived).
725 KB, validates clean (`wasm-tools validate --features=all`), bulk-memory + reference-types only (both
workerd-supported), exports its own `memory`. Corroborated by Cloudflare's own WASI-on-Workers blog and
`@cloudflare/workers-wasi` (`wasi.wasiImport` instantiation; same wasmtime binary runs unchanged on workerd).

**Consequence:** E1 moves from **SHELVE** to **VIABLE-but-no-parity-gain-yet**. The deployability blocker is
gone. What is *not* yet proven: a full kernel-parity rquickjs (stdlib/extensions/host-call boundary) vs the
shipped C-QuickJS on snapshot fidelity + image size. The door is open; the reason to walk through it is still
absent (see §4).

### FLIP 2 — W2: Boa is snapshottable by pure memory blit → the repo's Boa rejection is wrong.

`CLAUDE.md` records "Boa = higher-risk alt (no snapshot API)"; the feasibility verdict treats QuickJS as the
only viable snapshot engine. **Both are now disproven.** Built `boa_engine 0.20` to wasm32-wasip1 (7.1 MB raw,
5.2 MB after `wasm-opt -Oz`), ran a real cross-instance snapshot in wasmtime 27: created `var x` + closure
`inc()` + array in instance A, copied **only** `memory.buffer` (2.13 MB) into a fresh instance B, and the
closure continued from live state (x 41→42, array survived) — full fidelity, zero source replay. Boa's
snapshot triple matches QuickJS exactly: one mutable `__stack_pointer` global (at-rest, not even exported, so
memory-only suffices), exported `memory`, and a **fixed 2385/2385 funcref table with zero `table.grow`/`table.set`**
(the exact thing Wizer refuses — see §5). The "own GC" objection is a non-issue: `boa_gc` is **non-moving
mark-sweep** (no relocate/forward/compact in `collect()`); `GcBox` nodes are `Box::into_raw` `NonNull` pointers
*inside* the same linear memory, so absolute intra-memory pointers survive a byte-identical blit (identical to
QuickJS dlmalloc pointers); GC state is `thread_local` in the data segment, captured by the blit. WASI surface
= 8 fns, shimmable exactly as the kernel already does. **Consequence:** Boa is a proven **pure-Rust** QuickJS
alternative (eliminates the C/quickjs-wasi dependency), ~2× bigger and unproven at kernel parity. Artifacts:
`experiments/w2-boa-snapshot/`.

### FLIP 3 — W5: fresh-instance compaction defeats the monotonic high-water-mark → BUG-2/4 is solvable.

The single most-repeated "infeasible" in `CLAUDE.md` — v0.2's "true compaction infeasible w/o value-serialization
that loses promise/closure fidelity" and "raw `memory.buffer` does NOT shrink in place (WASM monotonic; dlmalloc
no downward compaction)", plus v0.5's unrecoverable ~256 MB DO-kill and the P0-open BUG-2/4 — **is flipped.**
Prototype with the shipped quickjs-wasi 3.0.0: a session spiked to a **48.88 MB** buffer (over the 18 MB v0.7
dump ceiling = permanently wedged) with only **0.17 MB live used heap** is compacted by serializing live state
out, instantiating a **brand-new small instance from the same CompiledWasm Module**, and rehydrating —
buffer **48.88→1.50 MB (96.9 % reclaimed)**, gz 6.75→0.14 MB, back under the ceiling, 1000 records byte-identical.
The bloat is purely the monotonic buffer (`memoryUsedSize` stayed ~68 KB across spike+free); a fresh instance
sidesteps it. The fidelity objection is **bounded and solved** by combining serialization (data: plain/Map/Set/
TypedArray/RegExp/Error/BigInt/Date losslessly) with the **EXP-6 oplog already in the codebase** (closures +
pending promises via source/host-result replay). Genuinely-lost-without-engine-walk: generator resume point,
unregistered `Symbol()` identity, `WeakRef` liveness — narrow, documented. Two instances coexist legally in one
isolate during handoff (`coexist.mjs`, `separateMemory:true`); transient peak ≈ the already-present bloated
buffer (fresh ≈1.5 MB adds no new OOM headroom). Artifacts: `experiments/w5-compaction/`.

### PARTIAL — W3: Asyncify gives true mid-cell pause/resume → reopens (does not flip an ADR) the mid-cell gap.

v0.1 BUG-3 / v0.8 "mid-cell used-heap tripwire" record that the kernel can only react at interrupt boundaries
and a tight loop can still WS-1006 the DO; E3/chiwawa "could not adopt" mid-stack capture. **Binaryen Asyncify
is the adoptable path chiwawa lacked.** Proven end-to-end (`experiments/w3-asyncify/drive2.mjs`): unwound a live
loop mid-execution at counter=500000 (**not** an interrupt boundary), snapshotted the entire linear memory (the
asyncify stack-save struct lives *in* linear memory → captured for free), instantiated a fresh module, blit back,
`asyncify_start_rewind` + re-enter → continued to 1000000. On the **real repo quickjs.wasm**: `--asyncify -O`
= 2.16 MB (1.36×, ~0.02 s build), validates, retains all 5 asyncify control exports, still exports its own
`memory` (existing dump/blit/pre-size path unchanged). **`--ignore-indirect` (0.86×) is correctness-UNSAFE** for
an interpreter that dispatches via `call_indirect`; the safe variant is the full 1.36× instrumentation, plus a
permanent ~25–50 % hot-path tax and single-suspension-at-a-time. Verdict: **promising, opt-in** (gate behind a
"preemptible session" config, not the default kernel).

### NO CHANGE — W6 (autopsy) and W7 (exotic substrates) confirm rejections.

W6 quantified that **JS_WriteObject is not a snapshot mechanism** (9 PASS / 7 FAIL: silently or loudly drops
closures, pending+resolved promises, bound fns, class-instance methods, accessors, symbol-keyed props,
`globalThis` itself) — making ADR-0002 (raw-memory-dump) *more* decisive, not less. W7 found **no CF-native
substrate offers a better live-state primitive**: CF Containers/Sandboxes are filesystem-snapshot only (live
memory snapshot "future, not shipped"); Rivet's CF driver stores **serialized logical state** (exactly the
ADR-0002-rejected path, now industry-corroborated); only off-CF Firecracker (E2B/Fly) truly beats Engram's
primitive, by abandoning CF for a heavyweight VM.

---

## 2. Updated landscape table

| Option | live-snapshot | CF-viable | size (wasm / heap) | verdict | revives? |
|---|---|---|---|---|---|
| **quickjs-wasi (incumbent)** | yes — 21/21, memory image alone | yes (shipping today) | 1.45 MB / smallest | **KEEP** | — |
| **E1 Rust-QuickJS (rquickjs, wasip1)** | yes (W1 live blit) | **yes** (CompiledWasm + 9-fn JS shim; same as kernel) | 725 KB / ~QuickJS | **VIABLE, no parity gain yet** | **YES (W1)** |
| **Boa (wasm32-wasip1)** | yes (W2 memory-only blit, non-moving GC) | yes (CompiledWasm / `{wasm}`) | 5.2 MB / ~2× | **VIABLE alt, unproven at parity** | **YES (W2)** |
| **Asyncify-instrumented QuickJS** | yes + **mid-cell arbitrary-point** (W3) | yes (CompiledWasm) | 2.16 MB (1.36×) / same | **PROMISING, opt-in** | partial (mid-cell) |
| **Fresh-instance compaction (W5)** | yes (compact-then-snapshot) | yes (shared Module, no runtime compile) | reclaims 96.9 % buffer | **REVIVE as escape hatch** | **YES (W5)** |
| Nova | no — compacting/moving GC shifts items + rewrites indexes | no confirmed wasm32 build | — | DEAD (snapshot-fragile) | no |
| Porffor | no — AOT compiler, no interpreter heap | n/a | — | DEAD (wrong model) | no |
| Hermes | no — heap-snapshot is profiling-only | C++ | — | DEAD | no |
| Kiesel (Zig) | unproven | wasm not a focus | — | DEAD-ish | no |
| Go/goja (E2) | yes | yes but 11–12 MB, 112 MB heap | 11–12 MB / runaway | **KILL** (size) | no |
| JS_WriteObject value-serialize | **no** — 7/16 kinds lost (closures/promises/methods) | n/a (fails product, not platform) | — | DEAD | no |
| rquickjs `wasm32-unknown-unknown` | yes (builds w/ wasi-sdk) | no — 43 unsatisfied `env` libc imports | 675 KB | DEAD (use wasip1) | partial |
| Wizer-at-runtime | n/a (build-time only, embeds Wasmtime, forbids imported memories) | no at runtime | — | DEAD at runtime; alive as E4 bake | no |
| V8-isolate heap | **no** — no heap-snapshot API (original thesis wall) | — | — | DEAD (the wall) | no |
| Rivet/ActorCore | logical-state only (serde + virtual-FS) | yes as HOST, not as primitive | — | future HOST, not a primitive swap | no |
| CF Containers/Sandboxes | filesystem only; live-memory "future" | no (for live state) | — | DEAD for live state | no |
| Firecracker microVM (E2B/Fly) | **yes** (5–30 ms resume) | **not on CF** | 100s MB | better off-CF only | no (off-platform) |

---

## 3. NEW pain-killers for monotonic-memory + size — and how they stack with E6

The prior round's only durable-write win was **E6 oplog-hybrid** (80–96.5 % fewer durable bytes, logical, with
a crash-window-replay tradeoff). Two new tracks attack the *physical* axes E6 can't:

### W4 — fine-grain byte-delta snapshot (size).
Built against shipped quickjs-wasi 3.0.0 (`experiments/w4-pagedelta/`), 50-cell workload, byte-faithful cold
restore (acc=15852 MATCH, all rebase intervals). **Granularity is everything:** true byte-level churn between
consecutive cells is only **1.0 %** (751 KB of 75 MB), but the allocator/GC *scatters* it, so coarse **64 KB
pages amplify to ~24 %** → durable 5.6–5.8 MB gz, which **LOSES to E6 oplog (0.87 MB)**. Finer chunks collapse
it: 16 KB=2.05 MB, 4 KB=863 KB (≈ ties oplog), 1 KB=435 KB, **256 B=295 KB gz — beats oplog ~3×, full-dump ~30×.**
No portable WASM dirty-bit exists (`memory.discard` is a proposal, absent from workerd), but a JS-side byte-compare
vs a retained prev image is **cheap**: 0.9 ms @1.75 MB, 2.7 ms @20 MB — negligible vs R2/restore costs. DO holds
the previous full image to diff (fine for the ≤20 MB envelope). Verdict: **coarse page-delta DEAD; fine-grain
(≤1 KB) byte-delta is the strongest size-killer measured** and, unlike oplog, has **zero replay/re-fire risk**
(persists physical regions, never re-executes).

### W5 — fresh-instance compaction (high-water-mark).
Covered in §1 FLIP 3. The reclaim mechanism, not a write-volume mechanism: when `usedHeap` is low but
`memory.buffer` crosses the dump ceiling, discard the bloated instance and rehydrate a fresh one.

### How they stack with E6 (recommended layered durability):

```
rare full base  (E4-baked where possible)
   └─ per-cell  FINE-GRAIN BYTE-DELTA (W4, ≤1KB)   ← smallest physical writer, no re-fire
        └─ optional OPLOG TAIL (E6)                ← crash-replay audit / logical recovery
   ↘ on wedge:  FRESH-INSTANCE COMPACTION (W5)     ← reclaims 96.9% buffer, re-bases
```

- **W4 ⟂ E6 (orthogonal):** byte-delta is physical (shrinks every checkpoint to changed regions, no re-fire);
  oplog is logical (rarer full bases + crash replay). Byte-delta removes oplog's *only* weakness (re-fire) while
  oplog adds crash-window auditability. Use byte-delta as the primary durable writer, oplog as the tail.
- **W5 is the escape valve under both:** when a session wedges past the dump ceiling, compaction reclaims the
  buffer and produces a fresh small base that W4/E6 then track again. W5 *uses* the E6 oplog internally to
  restore closure/promise fidelity into the fresh instance.

---

## 4. THE UPDATED RECOMMENDATION — sequenced

**Still: keep the JS-glue + quickjs-wasi brain as the default. The don't-rewrite-for-parity logic survives —
W1/W2 prove Rust-QuickJS and Boa are *deployable and snapshottable*, but neither buys fidelity the incumbent
lacks.** What changed is that two real product holes (monotonic wedge, mid-cell pause) now have proven fixes,
and the size frontier moved. Build in this order:

1. **W5 fresh-instance compaction escape hatch (highest value — closes P0 BUG-2/4).** Trigger when
   `memoryUsedSize` is low but `memory.buffer` crosses the dump ceiling: serialize live data, instantiate a
   fresh instance from the same CompiledWasm Module, replay closures/promises via the existing EXP-6 oplog,
   rehydrate. Reclaims ~96.9 % of the buffer with no in-place shrink. Document the bounded fidelity loss
   (generators/Symbol-identity/WeakRef). Gate behind a threshold; validate on a real DO.

2. **W4 fine-grain byte-delta durability (largest size win, low risk).** Replace/augment the full-dump path
   with ≤1 KB byte-region deltas vs a DO-held prev image (rare full base + per-cell delta). 256 B–1 KB beats
   E6 oplog ~3× on durable bytes with zero re-fire risk; diff cost <3 ms. Keep an E6 oplog tail for crash
   replay. Verify byte-faithful cold restore on **real workerd/DO SQLite** at CHUNK ≤1 KB before defaulting.

3. **Adopt E6 oplog-hybrid (from round 1) as the crash-replay tail** under W4, not the primary writer.

4. **W3 Asyncify as an opt-in "preemptible session" mode.** Ship the 1.36× safe-instrumented quickjs.wasm as a
   *secondary* engine selected by config for latency-sensitive/long-cell sessions that need true mid-cell
   pause/resume. Do **not** make it the default (permanent size + hot-path tax). Use the safe full-instrumentation
   variant only (never `--ignore-indirect`).

5. **E4 Wizer-bake cold-create (from round 1).** Unchanged: bake the default stdlib subset; clear the esbuild-target
   parse incompat; measure the ~2× gz hit vs the cold-wake/R2 budget first.

6. **Park, with the door open: W1 Rust-rquickjs and W2 Boa.** Both are now *proven deployable + snapshottable*.
   Re-open **only** when a need appears that the C-QuickJS incumbent genuinely can't meet — e.g. dropping the C
   toolchain dependency (Boa = pure Rust), a needed engine feature, or tighter control. The pre-commit gate for
   either: build full kernel parity (stdlib/extensions/host-call boundary) and run head-to-head vs C-QuickJS-wasi
   on snapshot fidelity + image size. Until then it's a rewrite for parity.

7. **Treat Rivet as a future portability HOST only** (keep Engram's heap blob as the actor state object; do NOT
   adopt its serialized-logical-state primitive). DFINITY orthogonal-persistence page-map (4 KiB dirty-page
   tracking) is the one technique worth borrowing **if Engram ever self-hosts on wasmtime** — it's W4's idea at
   the OS-page-fault level, unavailable on workerd.

---

## 5. Revive-condition table for the still-dead paths

| Dead path | Why dead | Exact revive condition | Likelihood |
|---|---|---|---|
| **JS_WriteObject value-serialization** | Loses closures/promises/methods/accessors/symbols (W6: 7/16 kinds, 0 of the executable/continuation layer); `globalThis` unserializable | Impossible for a live REPL — QuickJS has no continuation serialization. Would require a new engine API that walks closure environments + promise reaction queues | **NONE** |
| **Go/goja (E2)** | 11–12 MB wasm (7–8×), 40k objects → 112 MB linear memory; both past CF ceilings | TinyGo GC + wasm size change fundamentally (structural, not tunable) | **NONE-foreseeable** |
| **rquickjs `wasm32-unknown-unknown`** | 43 unsatisfied `env` libc imports workerd won't provide | Static-link libc at the link step (wasi-sdk clang + sysroot already compiles the C, 675 KB) — OR just use the proven `wasm32-wasip1` path | **MEDIUM** (but wasip1 is strictly easier → effectively moot) |
| **Nova** | Compacting/moving GC shifts items down + rewrites indexes mid-collection → snapshot-fragile; no confirmed wasm32 build | Nova ships a non-moving GC mode AND a confirmed wasm32 build | **LOW** |
| **Wizer-at-runtime** | Build-time only; embeds Wasmtime; forbids imported memories; can't run on workerd | None at runtime — lives only as the E4 deploy-time bake | **NONE** (runtime) |
| **CF Containers/Sandboxes (live memory)** | Filesystem snapshot only; live process-memory snapshot "future, not shipped", absent from roadmap | CF ships microVM-style live memory snapshot (announced as future) | **LOW** (track) |
| **Rivet as a snapshot primitive** | CF driver stores serialized logical state + virtual-FS (ADR-0002-rejected fidelity) | Never as a primitive — viable only as a HOST holding Engram's own heap blob | **NONE** (as primitive) |
| **V8-isolate heap snapshot** | No heap-snapshot API — the original thesis wall | None — the entire reason WASM-linear-memory was chosen | **NONE** |
| Boa "moving-GC wall" (the *objection*, not Boa) | — | Already dead: W2/W6 prove `boa_gc` is non-moving; Boa itself is **revived** (table §2) | — |

---

**Bottom line for the owner:** the round-1 verdict holds at its core — **don't rewrite the brain for parity** —
but it was too pessimistic on three counts. (1) A Rust/Boa brain *is* deployable on CF (W1/W2 flip the
wasip1/Boa rejections) — still not worth building today, but the door is genuinely open, not theoretically.
(2) The monotonic-memory wedge (BUG-2/4, the deepest open P0) **is fixable** via W5 fresh-instance compaction —
build this first. (3) The size frontier moved: **W4 fine-grain byte-delta beats the round-1 E6 oplog ~3×** with
no re-fire risk, and the two stack cleanly. Asyncify (W3) is a real, adoptable mid-cell-pause capability worth
shipping as an opt-in mode. Everything else — Go/goja, JS_WriteObject, Nova/Porffor/Hermes, Rivet-as-primitive,
CF-Sandbox-live-memory, the V8 wall — stays dead, now with explicit revive conditions.
