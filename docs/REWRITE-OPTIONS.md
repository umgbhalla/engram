# Rust/WASM Consolidation — Decision Document

> Owner decision doc. Question on the table: move Engram toward more Rust/WASM and
> less hand-written JS, **conservatively**, without breaking the product.
> Verdict up front: **only one path survives the gate, and it is small.** Take it
> in tiny reversible steps, or do nothing. Three of the four researched approaches
> are dead on arrival.

---

## 1. The GATE (non-negotiable)

**The heap-snapshot thesis.** Engram is durable because the live QuickJS interpreter
heap lives in **WASM linear memory — a plain `ArrayBuffer`**. We hibernate by dumping
`memory.buffer` + the `__stack_pointer` global + the seeded entropy counters, gzip it,
store it (SQLite-first / R2 overflow), and on cold wake we **blit those bytes back into
a fresh WASM instance and continue** — no replay, no re-firing side effects, live
closures and pending promises intact. That round-trip is the whole product
(`apps/kernel/src/glue.js:1514-1568` dump, `:1146-1180` restore).

**The gate rule:** *any approach that cannot dump an arbitrary mid-session live heap
and resume it byte-for-byte in a separately-instantiated module is dead on arrival.*
Nothing else about a refactor matters if it breaks this.

| Approach | Snapshot thesis | Status |
|---|---|---|
| TRACK 1 — Rust-driven QuickJS (rquickjs) | Preserved in principle, but **unbuildable** on workers-rs | **DEAD (build)** |
| TRACK 1 alt — `JS_WriteObject`/`JS_ReadObject` as snapshot | **BROKEN** — cannot capture closures / pending promises / symbol keys | **DEAD (gate)** |
| TRACK 2 — Boa (eval entirely in Rust) | **BROKEN** — heap is not a relocatable arena; raw pointers + vtables + host trait objects | **DEAD (gate)** |
| TRACK 3 — Wizer (build-time pre-init) | **N/A / BROKEN if misapplied** — build-time only, cannot snapshot a live evolving instance, cannot run in workerd | **DEAD (wrong tool)** |
| TRACK 4 — Incremental absorb (pure policy → Rust) | **PRESERVED trivially** — does not touch engine, memory, WASI imports, or dump/restore | **SURVIVES (but small)** |

Only **TRACK 4** passes the gate. Everything else either cannot be built or destroys
durability.

---

## 2. Comparison

| Approach | What moves to Rust | `glue.js` fate | Snapshot-safe | JS% drop | Feasibility | Effort | Verdict |
|---|---|---|---|---|---|---|---|
| **T1 rquickjs** | Nothing — blocked at the linker | Stays ~as-is (~1604 lines) | Yes in principle | ~0% | **Blocked** (target ABI conflict) | XL | **REJECT** |
| **T1 `JS_WriteObject`** | Snapshot serialization | n/a | **No** — loses closures/promises/symbols | n/a | Blocked by gate | XL | **REJECT** |
| **T2 Boa** | Whole eval path (eliminates glue.js) | Eliminated — *along with durability* | **No** — non-relocatable GC heap | n/a (net loss) | **Blocked** by gate | XL | **REJECT** |
| **T3 Wizer** | Nothing usable at runtime | Unchanged (0 lines removed) | No — wrong direction (init-once-freeze) | 0% | **Blocked** in workerd | S | **REJECT** |
| **T4 Incremental absorb** | Pure host-side policy: guard constants/decision, `normalizeConfig`, fetch-allowlist policy (eval/effectful/journal/checkpoint/gzip-seq **already in Rust**) | Stays load-bearing; ~1604 → ~1250–1380 (15–22%) | **Yes, by construction** | **~15–25%** | **High** | M | **NOT NOW** (optional, low ROI) |

---

## 3. RECOMMENDED PHASED PATH

**Headline: there is no transformative rewrite available. The honest move is a small,
opt-in, reversible absorb of *pure policy* into `lib.rs` — and only if a concrete pain
(drift, duplicated constants) justifies it.** Each phase is independently revertible and
must pass the same regression bar.

**Regression bar for every phase (mandatory):**
1. Build: `wasm32-unknown-unknown` cdylib builds clean; worker deploys.
2. Smoke: existing kernel smoke suite green (no behavioral diff).
3. **Evict-to-cold-restore:** spike a session, force genuine DO eviction
   (`inMemory:false`, generation bump), cold-restore via `sqlite-restore`, assert
   live state + closure + pending-promise survival and **byte-identical determinism**
   under a seeded clock/RNG (EXP-8 invariant). This is the gate, re-run every phase.

### Phase 0 — Decide it's worth doing (cheapest, reversible: do nothing)
- **Change:** none. Confirm whether the duplicated/movable policy is actually causing
  pain. Per Track 4, the high-value orchestration (engine-migration journal
  `lib.rs:1238`, effectful detection `lib.rs:1525`, checkpoint atomicity `lib.rs:1025`,
  gzip/dump sequencing in `ensure_glue`/`checkpoint`) is **already in Rust**. The
  remaining candidates are small.
- **Why low-risk:** literally no code change.
- **Verify:** n/a. If no pain, **stop here** — this is the recommended default.

### Phase 1 — `normalizeConfig` → Rust (only if pursuing)
- **Change:** move config normalization (`glue.js:765`) into `lib.rs`. It is pure
  JSON-in/JSON-out and Rust already receives `config_json`. glue.js consumes the
  normalized config.
- **Why low-risk:** no QuickJS handle, no `memory.buffer`, no WASI touch. Smallest
  pure-data move; trivially revertible (one function).
- **Verify:** build + smoke + evict-to-cold-restore, plus assert config (clock/rngSeed/
  modules) survives cold wake unchanged.

### Phase 2 — Fetch-allowlist *policy* → Rust (host-side already)
- **Change:** move the hostname-compare allowlist decision (`enforceFetchAllow`,
  `glue.js:223`) to Rust. The actual `fetch()` and VM-promise resolution **stay JS**
  (DO-side fetch is already Rust-adjacent; eval is async per P3).
- **Why low-risk:** pure string/policy comparison, adds zero entropy → determinism
  untouched. Reversible.
- **Verify:** build + smoke + evict-to-cold-restore + fetch allow/block matrix
  (`FetchBlockedError` still a typed VM reject, socket alive).

### Phase 3 (CONDITIONAL / likely skip) — Guard thresholds → Rust
- **Change:** hold `MAX_DUMP/USED/RESTORE` byte constants + the reject *decision* in
  Rust, judging the numeric `bufferBytes`/`usedHeap` glue already returns.
- **Why this is the risky one — recommend NOT doing it:** it **splits the size decision
  across two files** (glue *reads* the bytes, Rust *judges*) → drift risk. The current
  design co-locates read+judge in `dump()`, which is **safer**. Only do this if a
  measured drift/duplication bug forces it.
- **Verify (if attempted):** build + smoke + evict-to-cold-restore + the full
  size-admission matrix: in-envelope spike-then-free still checkpoints; >~45MB buffer
  still **fails safe** (typed `SizeAdmissionError`, socket alive); 18MB dump ceiling
  clean-rejects (no silent WS-1006). Any regression here = revert immediately.

**Net outcome if all phases land:** `glue.js` ~1604 → ~1250–1380 lines (15–22% drop).
Everything engine-coupled stays JS forever (see §4). This is a tidy-up, not a rewrite.

---

## 4. REJECTED — and why (blunt)

### TRACK 1 — Rust-driven QuickJS via rquickjs — **REJECT**
- **Unbuildable.** workers-rs mandates `wasm32-unknown-unknown`
  (`context/workers-rs/README.md:642-643`); rquickjs-sys only builds for
  `wasm32-wasip1` via WASI SDK 24.0 with **no `wasm32-unknown-unknown` branch**
  (rquickjs-sys build.rs; DelSkayn/rquickjs#93 fails "stdlib.h file not found" on the
  bare target). The two ABIs cannot co-link. This is fundamental, not a config tweak.
- **Even if it built, ~0% win.** Rust would still reach QuickJS across the
  wasm-bindgen/js-sys boundary — exactly the Reflect dance `lib.rs` already does for AE.
  The snapshot primitive is already ~15 isolated lines
  (`context/quickjs-wasi/src/index.ts:1919-1934`); there's nothing to consolidate.

### TRACK 1 alt — `JS_WriteObject`/`JS_ReadObject` as the snapshot — **REJECT (gate violation)**
- It is a **bytecode/object-graph serializer**, not a live-VM capture
  (`context/quickjs-ng/quickjs.h:1214-1235`). Cannot serialize standalone
  functions/live closures (quickjs-ng#977 — only when embedded in a module), **silently
  drops symbol keys** (quickjs-ng#481), and has **no concept of the pending-promise job
  queue**. That is precisely the live-namespace/no-replay fidelity the product sells.
  Hard reject.

### TRACK 2 — Boa (eval entirely in Rust) — **REJECT (gate violation)**
- Boa's managed heap is **not a relocatable single arena**. Every JS object is an
  individual `Box::into_raw` global-allocator allocation
  (`context/boa/core/gc/src/lib.rs:131-142`), tracked by a `thread_local! BOA_GC`
  linked list of **absolute raw pointers** (`lib.rs:44-81`); a `Gc<T>` literally *is* a
  `NonNull<GcBox<T>>` heap address (`gc/src/pointers/gc.rs:155-156`). Closures are
  `Gc<dyn TraceableClosure>` trait objects and natives are raw `fn` pointers
  (`native_function/mod.rs:41,137`); `Context` holds host `Rc<dyn …>` trait objects
  (`context/mod.rs:95-135`).
- Byte-copying linear memory into a fresh instance would point all of that at garbage —
  Rust startup rebuilds the thread-local allocator state, it is **not blitted**. Boa
  ships **no `Context`/`Realm` serialize** (the `serde` feature covers only the AST).
  Adopting Boa deletes glue.js *and durability*. Net loss.

### TRACK 3 — Wizer — **REJECT (wrong tool, can't run here)**
- Wizer is a **build-time, wasmtime-based binary rewriter**: instantiate, run an init
  fn, record globals + non-zero memory, **emit a new module** with data segments
  (`context/wizer/README.md:170-178`). It is bonded to native wasmtime (a JIT;
  `Cargo.toml:48`), which **workerd forbids at runtime** (raw-bytes `WebAssembly.compile`
  is blocked — v1-facet spike). Its init-fn may not call imports
  (`README.md:116-123`) → no live host I/O.
- It captures a **once-frozen build-time image**, the *opposite* of dumping an arbitrary
  evolving live heap and blitting it back (`glue.js:1146-1180`). Removes **0 lines** of
  glue.js. The one thing it could legitimately do — faster cold-start of `quickjs.wasm`
  — is near-worthless: cold start is **network/platform-bound**, QuickJS init is <300µs
  (`docs/results/v0.4-coldstart.md`).

### TRACK 4 — kept, but de-scoped to "NOT NOW"
- It passes the gate and is feasible, but the ROI is low: the safe-to-move pieces are
  small and partly already in Rust; the bulk of glue.js is **irreducibly
  engine-coupled** and cannot move without an engine rewrite (which §1 already rejected).
  Do it only if duplication/drift becomes a concrete maintenance pain.

---

## What must stay JS forever (the immovable core)

These are coupled to the live `WebAssembly.Memory` / WASI callback / QuickJS handles and
**cannot** move to Rust without reimplementing quickjs-wasi (= a rewrite, rejected):

- quickjs-wasi import + `create`/`restore`/`snapshot`/`serializeSnapshot`
  (`context/quickjs-wasi/src/index.ts:627,704,1919`).
- The WASI imports factory `buildWasiFactory` (`glue.js:316`) — `wasi` is a
  `(memory)=>imports` JS callback writing seeded entropy into a `DataView` over the live
  buffer (`context/quickjs-wasi/src/wasi-shim.ts:52`). **This is the determinism
  linchpin (EXP-8); do not touch it.**
- The interrupt handler closure reading `buffer.byteLength` re-entrantly
  (`glue.js:958-993`), host-fn marshalling (`glue.js:445-660`), value-preview
  `kernel.dump(h)` (`glue.js:1445`), and `_scrubArena`/`_bufferBytes`/`_usedHeapBytes`.
- gzip: no native `CompressionStream`/`DecompressionStream` in workers-rs (only
  `FixedLengthStream`) → the dump byte-pipeline stays JS.

---

## Bottom line

> **No buildable, gate-safe rewrite exists.** rquickjs won't link, Boa can't snapshot,
> Wizer can't run here. The only honest move is a **small, opt-in, reversible** absorb
> of pure policy (config normalize + fetch-allowlist) into Rust for a ~15–25% glue.js
> trim — and even that is **optional**. Recommended default: **Phase 0 (do nothing)**
> unless duplicated policy is actively biting. Whatever you do, re-run the
> evict-to-cold-restore + seeded-determinism regression on every phase.
