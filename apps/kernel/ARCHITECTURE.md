# engram-kernel — Rust kernel architecture

Current deployed worker: `engram-kernel` (https://engram-kernel.umg-bhalla88.workers.dev).
This app is the production single-tenant hibernating REPL kernel. It is built as a Rust Durable
Object shell driving the rquickjs WASM engine through a thin JS WASI / Cloudflare plumbing layer,
with snapshots stored in DO SQLite and R2 `engram-snapshots` overflow.

The notes below include the `engram-rust2` scratch-build provenance from the Rust cutover. Treat
that name and the `benchrust2/` prefix as historical, not current deployment identity.

Historical scratch live suites: functional **24/24**, parity5 **9/9**, **Phase-1b features 18/18**, guard-probe 16/17
(the 1 is the documented post-double-bomb >45MB wedged-buffer clean-reject — socket alive, not a kill),
E6 engine-migration replay **PASS**.

## Phase 1b — DEFERRED PIECES NOW LANDED

- **W5 compaction** (docs/W5-COMPACTION-PLAN.md): engine `scrub_arena(budget_mb)` export (GC + zero-fill
  freed slack). Glue `_serializeForDump`: ABSOLUTE safe-serialize cap (45MB, prevents the adversarial
  W4-ceiling regression) FIRST, then used-heap admission (50MB), then scrub-on-bloat (buffer>12MB AND
  used/buffer<0.4). Restore-side used-heap + raw-ceiling admission. A >18MB spike-then-free session
  checkpoints again (un-wedged); scrub collapses the stored gz. NOT a raw-buffer reclaim (impossible —
  WASM monotonic); reclaims the STORED gz size, the actual P0.
- **W4 256B byte-delta + base cadence + auto-fallback** (docs/W4-BYTEDELTA-PLAN.md): glue `dumpW4`/
  `restoreW4` (host-side retained `_lastImage`, 256B-grain diff, pack changed grains + Uint32 indices,
  gzip both). lib.rs `delta_chunks` table + base/delta checkpoint decision (BASE_EVERY=20, force-full on
  no-base/length-change/dense-mutation auto-fallback) + `read_delta_chain` + base+chain restore. Zero
  re-fire (exact bytes).
- **E6 oplog crash-tail + engine-migration replay**: lib.rs `oplog` table (per-cell {src, hostResults}
  appended; reset on full base). On a cold wake with an engine-hash MISMATCH, `replayJournal` replays the
  oplog into a FRESH instance (pure cells re-run; host effects fed back from the recorded oplog, no
  re-fire; kv+ctx re-imported from the manifest). Proven live via the `_forceEngineMismatch` test frame.
- **host.subLM / host.ctx (chunked) / host.final**: glue services subLM (POST to config.subLMEndpoint),
  the full host.ctx.* surface (names/len/slice/grep/chunk/get/set — host-side store, chunked into
  `ctx_chunks`, survives cold restore), and final/finalVar RLM sentinels. `{t:setContext}` host-push +
  `{t:final}` report frames. ctx + final + subLMCalls travel in the snapshot meta.
- **stdlib injection**: the esbuilt `{name:iife}` bundle ships as a wrangler **Text** module
  (`src/stdlib.bundle.txt`, 818KB) + `stdlib-meta.js`. `_injectStdlib(config.modules)` evals the selected
  IIFEs into the VM at create (self-install globalThis.<name>); they snapshot-persist (survive evict,
  no re-inject). Source cap 500KB (V0.7 guard), mathjs opt-in only. Seeded `crypto` shim added to the
  engine BOOTSTRAP (nanoid/uuid need getRandomValues; routes through seeded `__rand` → determinism holds).
- **Two engine fixes shipped as genuine improvements:** (1) on a mid-cell guard TRIP the job queue is
  DRAINED with guards disarmed before finalize, so leftover async-driver continuations don't persist
  into the snapshot and loop on cold restore (closed the bomb-then-restore hang). (2) Multi-statement
  cells that use `await` now compile as an async-function body (top-level await works), not just the
  single-expression form — codemode cells (`await host.fetch(...); x = ...`) now run.

- **Deferred (noted):** Tier-0 C extensions static-link (crypto.subtle/TextEncoder/URL/structuredClone/
  Headers) — static-linking the 5 quickjs-wasi `.so` into the rquickjs wasm is non-trivial vs the JS
  descriptor plumbing; the seeded `crypto` shim covers nanoid/uuid's needs for now. AE observability emit.

---

## (Phase 1a, retained below)

## Architecture chosen: Rust-DO shell + rquickjs-engine wasm (CompiledWasm) + thin JS WASI shim

Two wasm modules, mirroring exactly how the JS kernel ships quickjs.wasm:

```
entry.mjs  --import engine.wasm (CompiledWasm) + engine-hash.js--> globalThis.__ENGINE_MODULE
   |
src/lib.rs  = Rust DurableObject (workers-rs, wasm32-unknown-unknown)
   |   protocol/SQL/snapshot-store/mutex/checkpoint  (ALL Rust)
   |   binds via #[wasm_bindgen(module="/src/kernel-glue.mjs")]
   v
src/kernel-glue.mjs = THIN JS WASI shim — NO business logic. Only:
   - WASI preview1 imports (seeded random_get, frozen clock, fd_write->console)
   - instantiate the engine + memory.buffer BLIT (snapshot substrate) + gzip
   - host.fetch IMPLEMENTATION (DO-side fetch + allowlist) — the only effect the
     wasip1 engine can't do itself
   v
engine/src/lib.rs = rquickjs ENGINE (wasm32-wasip1) — ALL kernel logic in Rust:
   eval (async, host-call park/resume) · value-preview · 3 guards · determinism ·
   host.kv (in-engine, persisted) · entropy counters · kv export/import
```

**Why this and not pure workers-rs:** rquickjs compiles to `wasm32-wasip1`; workers-rs DOs
compile to `wasm32-unknown-unknown`. They cannot be one module. W1 proved a wasip1 module runs
on CF via CompiledWasm + a JS WASI shim — so the engine ships exactly like quickjs.wasm does in
the JS kernel, and the snapshot substrate (the literal `memory.buffer` blit) is identical. The
2000-line glue.js is replaced: its logic now lives in the Rust engine wasm; the JS that remains
(`kernel-glue.mjs`) is pure plumbing.

## What compiles / bundles

- engine wasm: 740 KB (`cargo build --release --target wasm32-wasip1`).
- worker bundle: 1.16 MB / 480 KB gzip — `wrangler deploy --dry-run` confirms it bundles, under
  the 10 MB worker cap.

## Parity coverage (v0.9.3 target)

| Requirement | Status |
|---|---|
| WS+HTTP frames: create/eval/ping/gen/reset/evict/health | DONE |
| eval-result {ok,value,valueType,valuePreview,logs,error} + checkpoint frame | DONE |
| stateful multi-cell (heap persists across evals) | DONE |
| snapshot raw memory.buffer + counters/kv → DO-SQLite chunks (64KB), R2 overflow >2MB gz | DONE |
| genuine evict → cold-restore (blit into fresh instance) | DONE (24/24 incl. closure private + pending promise) |
| seeded determinism (Rust clock+RNG), entropy counters in manifest | DONE |
| guard: interrupt instruction budget (TimeoutError) | DONE |
| guard: memory limit | DONE (rquickjs set_memory_limit 64MB) |
| guard: BUFFER-GROWTH TRIPWIRE (the adversarial fast-array bomb fix) | DONE — interrupt-check + post-cell check; both `push(new Array(100000))` and single `new Uint8Array(40MB)` caught as recoverable MemoryLimitError, socket alive |
| host.fetch (DO-side, allowlist) | DONE (block+allow live) |
| host.kv (small, persisted across restore) | DONE |
| value-preview util.inspect-style (Map/Set/Date/RegExp/Symbol/Promise/Error, NOT JSON {}) | DONE — the FAFO bug fixed from the start |
| crash-atomic checkpoint (DO write-coalescing; R2 swap-then-delete) | DONE |

## Key engineering notes / one real blocker handled

- **Interrupt-counter patch (REQUIRED for the tripwire to work).** QuickJS only calls the host
  interrupt handler every `JS_INTERRUPT_COUNTER_INIT` (default **10000**) poll sites. At that
  cadence a fast native-alloc bomb (`push(new Array(100000).fill(7))`) grows the linear buffer by
  hundreds of MB *between* handler calls → the buffer-growth tripwire never fires and the DO
  hangs/OOMs. Lowered to **64** in `experiments/_src/rquickjs/sys/quickjs/quickjs.c`
  (one-line, commented) so the tripwire + memory limit catch fast growth within ~17 MB. This is
  the documented "set_memory_limit misses fast array growth" gap (docs/ADVERSARIAL.md), now
  closed in Rust. ⚠ The patch is in the SHARED vendored rquickjs; only affects future rebuilds.
- **Budget is interrupt-INVOCATIONS, not opcodes.** Default `cellBudgetTicks` = 1200 (parity with
  the JS kernel's certified 1200/2000). Heavy legit cells (multi-M iteration) need a raised budget
  via `{t:create,config:{cellBudgetTicks:N}}` — the same documented tradeoff as the JS kernel.
- **worker-build 0.8.3 foot-gun:** a top-level `dependencies` key in package.json breaks the
  wasm-bindgen snippet parse ("invalid type: map, expected a string"). Keep test deps in
  `devDependencies` (documented in apps/kernel/package.json too).

## Deferred to Phase 1b (stubbed for ABI parity, marked TODO in code)

- Tier-0 C extensions static-link (crypto.subtle/TextEncoder/URL/structuredClone/Headers).
- W5 compaction / W4 byte-delta / E6 oplog durability stack.
- host.subLM / host.ctx / host.final (codemode/RLM) + engine-migration journal replay
  (`replayJournal` currently creates-fresh so the DO never wedges on a hash mismatch).
- AE observability emit (the JS kernel's per-op datapoints).
- stdlib injection (`stdlibInfo` returns an empty catalog).

## Repro

```
cd experiments/kernel-rust
node engine-harness.mjs            # engine ABI + snapshot/restore + guards (local WASI)
set -a && . ../../.env && set +a
wrangler deploy --dry-run          # confirm bundle
wrangler deploy                    # deploy engram-rust (scratch worker only)
node live-test.mjs                 # 24/24 live functional suite
```
