# Engram — Durable Hibernating Kernel

> Single source of truth for this repo. `AGENTS.md` is a symlink to this file.
>
> **Provenance:** formerly montydyn (renamed to Engram on the rebrand). The heap snapshot IS an
> engram — a memory trace. The on-disk folder stays named `montydyn`; only the brand/repo identity
> and the deployed worker names changed. Deployed: `engram-kernel` (v0.9.3), `engram-cloud` (v1.2),
> `engram-ui` (ui). Older `montydyn-v0X`/`montydyn-v1X` worker names below are historical provenance.

## Context trail — read this first in a new session

**One line:** a durable, hibernating, dynamically-configured **stateful JavaScript REPL** on
Cloudflare — the live QuickJS interpreter heap is snapshotted to a Durable Object's SQLite,
so a session sleeps when idle and wakes with full live state, no replay.

**How we got here (the journey + plans/expectations):**
1. Started exploring **Cloudflare Dynamic Worker Loader** (run code in fresh isolates at runtime).
2. Goal crystallized: not one-shot code, but a **Jupyter-kernel-like resumable REPL** — live
   namespace that survives idle eviction. Expectation: "lock interpreter state, resume, move forward."
3. Key realization: **V8 isolates can't snapshot a live heap; WASM linear memory CAN** (it's a
   plain ArrayBuffer). → compile the interpreter (QuickJS) to WASM, snapshot its memory.
4. Dropped Dynamic Worker Loader for a **Durable Object + bundled CompiledWasm** substrate
   (ADR-0001). Snapshot the heap, not logical state (ADR-0002).
5. Proved it across 7 experiments (EXP-1..9, 4b), built **V0** (Rust DO shell + JS glue, SQLite-first
   snapshot), stress-tested it, now hardening into **V0.1** (usable dynamically-configured env).
6. **Expectation for V1:** if V0.1 is genuinely useful, go multi-tenant via **DO Facets** —
   where Dynamic Worker Loader deliberately re-enters (per-tenant kernel code, isolated SQLite,
   supervisor control). See ADR-0003. End vision: a dynamically-configured JS env that stays a
   stateful REPL, portable later to Rivet ActorCore.

**Doc map** (`docs/`):
| File | What |
|---|---|
| `feasibility.md` | feasibility study + architecture (verdict, snapshot mechanism, tech, risks) |
| `experiments.md` | the 10-experiment phased plan |
| `decisions.md` | ADRs: 0001 drop DW Loader · 0002 heap-snapshot · 0003 facets-for-V1 |
| `v0.1-design.md` | V0.1 spec: dynamically-configured stateful JS env |
| `results/SUMMARY.md` | operating envelope (size/latency ceilings, all hard numbers) |
| `results/exp-{1,4b,5a,6,7,8,9}.md` | per-experiment results |
| `results/v0.md` | V0 build report |
| `results/v0-tests.md` | V0 stress/soak suite — 5/6 PASS + BUG-1 (eval-mutex deadlock) |
| `results/v0.1.md` | V0.1 build report (when done) |
| `TODO.md` | task board |

**Code map:** `v0.8/` = **current kernel** (`src/lib.rs` Rust DO, `src/glue.js` JS glue,
`entry.mjs` CompiledWasm wrapper, `wrangler.jsonc`, `stdlib-src/`, `scripts/`). Older kernels
`v0`→`v0.7` were **pruned from the tree** (lean working dir) — recover any from git history or the
`v0.N-milestone` tags. `v1-facet/` = V1 facet proof. `experiments/exp-*/` = 7 proven experiments.
`context/` = external repos (shallow submodules; `context/include.md` indexes them).

**Workflow history** (background multi-agent runs, for provenance):
`wkfcx55zi` feasibility research · `wnf82p8o5` EXP-6/7/8/9/4b · `ws0na8tg4` V0 build ·
`wb2xbvb46` V0 stress · `wzv44v81d` V0.1 build.

**Deployed CF resources (current):** `montydyn-v091` (codemode kernel: REPL/SDK/CLI/RLM, chunked big-context) + `montydyn-v11` (**multi-tenant** parity: facets + stdlib/extensions/mediated-fetch/adaptive-keep-warm). All older/spike/experiment workers swept. R2 `montydyn-snapshots` (stale keys remain; needs R2 S3 token to prune). AE `montydyn_kernel`. Workers Paid. Repo: private `github.com/umgbhalla/montydyn`. Tree: `v0.8/`(legacy) `v0.9/`(codemode) `v1/`(multi-tenant) `v1-facet/`(spike) `experiments/` — older kernels in git history + tags.

**Milestones shipped:** V0→V0.8 (single-tenant kernel: durable hibernating REPL, SQLite-first heap snapshot, determinism, guards, stdlib, web extensions, mid-cell tripwire, AE observability). **v0.9** = codemode infra (host.ctx host-side context store + host.subLM + host.final; `@montydyn/sdk` + Code Mode `execute()` drop-in; `montydyn` CLI repl + depth-1 RLM loop — 4.36MB-context needle via host-side slicing; durable session hibernate/resume). **V1.0** = multi-tenant via DO Facets (SupervisorDO 64-shard + WS-hibernation PROXY model [facet-held sockets broken → supervisor holds+RPCs per frame] + per-session KernelFacet own SQLite, cold-restore, failure-isolation proven).

**Shipped after V1.0:** **v0.9.1** big-context fix (chunked store, multi-MB survives cold-restore) · **V1.1** multi-tenant facet at v0.8 parity + adaptive keep-warm · **v1.2** per-tenant API-key auth + AE metering + `/usage` (billable SaaS seam) · **v0.9.2** bounded **lambda-RLM** combinators (SPLIT/MAP/REDUCE, terminates) + durable **agent code-mode** adapter · **notebook UI** (`montydyn-ui`: durable browser REPL + RLM demo) · **v0.9.3** native-C giant-alloc backstop (no WS-1006) + engine-migration journal + scale-validated (0% err @150 concurrent, bad-facet isolation).

**PRODUCT COMPLETE (arc end):** Engram is a durable, hibernating, **multi-tenant codemode/RLM REPL platform** — kernel + auth/metering + lambda-RLM + agent mode + SDK + CLI + UI, scale-validated, all known holes closed. Deployed (post-rebrand): `engram-kernel` (codemode kernel, from v0.9.3/) · `engram-cloud` (multi-tenant SaaS, from v1.2/) · `engram-ui` (notebook, from ui/). **Remaining to GA (NOT auto-done):** npm-publish `@engram/sdk` (needs owner OK) · scale-at-1000s · docs site · R2 stale-key prune (needs R2 S3 token). **Python kernel: DROPPED per owner.**

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
- [x] **V0 BUILT + MERGED** (workflow `ws0na8tg4`) — `v0/`, deployed `montydyn-v0`. → `docs/results/v0.md`.
      Path (b): Rust DO shell (`v0/src/lib.rs`) + JS glue (`v0/src/glue.js`) + `entry.mjs` CompiledWasm wrapper.
      - **SQLite-first** snapshot (chunked ~64KB rows + manifest); **R2 overflow only >2 MB gz**. Demoted R2 off the hot path.
      - REPL + resumable + **no-replay** all MET; real eviction gen 1→2, `sqlite-restore`, effects fire once.
      - **Fast: p50 ~200 ms, p95 <530 ms, no >1 s tail** (vs EXP-7 R2 p95 >1 s). v0 images <1 MB gz.
      - Seeded clock/RNG determinism + build-time engine-hash guard + size-admission guard (clean reject, no crash).
      - **Atomicity fix** (`77ada26`): checkpoint replace crash-atomic via workerd write-coalescing (raw BEGIN/COMMIT forbidden on DO SQLite); R2 path swap-then-delete; runtime chunk-count guard. Crash-edge + R2-overflow crash-restore PASS on cold DO.
      - Skipped per scope: TTL/archival/eviction-cost, Python, multi-tenant.

- [x] **V0.1 BUILT + MERGED** (workflow `wzv44v81d`) — `v0.1/`, deployed `montydyn-v01`. → `docs/results/v0.1.md`.
      Dynamically-configured stateful JS env. Strict improvement over V0, zero regression.
      - **BUG-1 (blocker) FIXED + verified** (errors 17/17, smoke 24/24): `evalCode` returns JSON,
        drains QuickJS exception → `{ok:false,error:{name,message,stack}}`, mutex always released; reset recovers.
      - **Features (live):** `{t:create,config}` (clock/rngSeed/capture/cellBudget/fetch/tools) **persisted across cold wake**;
        host tools via `host.<name>` → `__hostCall`; per-cell `console.*` capture; structured value preview; reconnect-safe SDK (`v0.1/sdk`).
      - **BUG-5/6 FIXED** (seeded `performance.now`; correct `r2-restore` vs `sqlite-restore` label).
      - ⚠️ **BUG-2/4 STILL OPEN (P0):** `runGC()` frees JS objects but **WASM linear memory is monotonic** → snapshot size
        stays at high-water-mark; a size-trip session still can't checkpoint. Real fix = guard on *used* heap + compact-on-restore.
      - ⚠️ **BUG-3 PARTIAL (P1):** tick-budget preempts value-touching loops (typed TimeoutError) but a truly empty `while(true){}` can still WS-1006 the DO.
      - **P2:** host-tool state (kv data) not persisted across restore. **P3:** fetch allowlist inert; error-preview drops message.

- [x] **V0.2 BUILT + MERGED** (workflows `wmu0xafd9` + `whtbjgamd`) — `v0.2/`, deployed `montydyn-v02` (v `03ccf6bb`). → `docs/results/v0.2.md`.
      Hardening on top of v0.1. **Both V1-safety gates DECISIVELY GREEN, lead-verified live** before merge. v0/ + v0.1/ + their workers untouched. R2 keys namespaced `v02/`.
      - **Final P1 budget = default 1200 / cap 2000** (18-rep bisection; safety-first). Lead-verified: `while(true){x=1}` **8/8 trips, socket alive**; all loop shapes trip; no DO kill. Earlier 2500 leaked ~1/4 property-store loops to WS-1006 — rejected. Tradeoff: a tight loop above ~5–6M iters safely false-trips (typed TimeoutError, recoverable) → chunk heavy bursts across cells or raise `cellBudgetTicks`.
      - **P0 cold-restore wedge fixed + lead-verified:** 26.3MB spike → free → genuine evict → cold restore `keep=777` via `sqlite-restore`.
      - **GATE-FIX PASS:** closed two live gate failures — (P0) **cold-restore wedge**: the RESTORE guard now admits on the
        snapshot's recorded `usedHeap` (new `used_heap` manifest column), NOT raw image bytes, so a spike>20MB-then-free session
        cold-restores (safe-to-instantiate raw ceiling 45MB still fails too-big images safe). sizeGz "under-capture" was a gate
        LCG-precision artifact, not a code bug (dump captures full linear memory; gzip correct — verified). (P1) **global-write loop**
        `while(true){x=1}` now trips a typed TimeoutError, socket alive: root cause = **workerd throttles the host interrupt callback
        after ~1.6k invocations/turn**, so the tick budget is hard-capped below it (default 1200 / max 1500). 10M tight loop on workerd
        documented as exceeding the per-turn interrupt budget; certified heavy benchmark ~6M iters (or chunk across cells).
      - **P0 BUG-2/4 FIXED (un-wedge) + image shrink, with documented hard limit:** size-admission guard now on QuickJS
        **used heap** (`getMemoryUsage().memoryUsedSize`), not the monotonic `memory.buffer` → an in-envelope spike-then-free
        **checkpoints again** (no permanent SizeAdmissionError; store r2→sqlite). **Arena SCRUB** (alloc zero-buffers across freed
        slack, free+GC) zeroes freed pages so gz/stored image shrinks (local 30MB free: gz 0.84→0.18MB). **Raw `memory.buffer`
        does NOT shrink in place** (WASM monotonic; dlmalloc no downward compaction — verified; true compaction infeasible w/o
        value-serialization that loses promise/closure fidelity). >~45MB buffer dump **fails safe** (typed error, socket alive, reset recovers) — no OOM/1006.
      - **P1 BUG-3 FIXED:** interrupt-tick budget is the hard primary (decrements every invocation); EVERY infinite-loop shape
        (empty / `x=1` / `globalThis.x=1` / `o.a=1`) trips a typed TimeoutError ~0.2–0.5s, socket alive, next eval works.
        Root cause of the earlier escape = workerd throttles the host interrupt callback after a bounded, load-sensitive
        invocations/turn; the property-store shapes hit it sooner, so the budget MUST sit below that floor (≤1200). Default 30000→**1200**.
      - **P2 DONE:** host-tool kv state serialized in snapshot manifest (`kv_json`), re-hydrated on restore → `kv.get`/`keys` survive cold wake.
      - **No regression:** BUG-1, config+tools across evict, seeded clock/RNG, state survival all green.

- [x] **P3 (v0.3) BUILT + MERGED** (workflow `w8z0wmn49`) — `v0.3/`, deployed `montydyn-v03`. Verified 16/16 + 52/52, zero regression.
      - **Real fetch egress:** `host.fetch(url,init)` → DO-side `fetch()` → `{status,ok,headers,body}`. Eval is now **ASYNC** (fetch pump; eval binding `Promise<String>`) so cells can `await host.fetch`.
      - **Allowlist enforced:** `config.fetch` false=block all / true=all / `[hosts]`=hostnames; else typed `FetchBlockedError` (rejected VM promise, socket alive). Fetch adds 0 entropy → determinism preserved.
      - **Error-as-value preview** now includes name+message+short stack (`valueType:"error"`).
- [x] **V1 FACET SPIKE — WORKS** (workflow `w8z0wmn49`) — `v1-facet/`, deployed `montydyn-facet`. → `docs/results/v1-facet-spike.md`, `docs/results/v1-direction.md`. **All 5 ADR-0003 steps proven LIVE:**
      - Supervisor DO (+`worker_loaders`) loads a DO class via `LOADER.getDurableObjectClass`, runs it as a facet (`ctx.facets.get`) with its **own isolated SQLite** (facet can't read supervisor's secret); two facets independent.
      - **Real quickjs kernel runs as a facet**, evals stateful cells, snapshots heap into the **facet's own SQLite**, **cold-restores across `ctx.facets.abort`** (z=99 survived, no replay).
      - **WASM-in-facet resolved:** raw-bytes runtime `WebAssembly.compile` is BLOCKED ("Wasm code generation disallowed by embedder"), BUT an **undocumented `{wasm:ArrayBuffer}` Worker-Loader module type** delivers a pre-compiled Module that instantiates → kernel needs only a delivery tweak, NOT a rewrite.
      - **Hard constraint:** **facets CANNOT set alarms** ("Facets currently cannot set alarms") → idle/TTL scheduling MUST live on the supervisor DO. Kernel durability is per-cell sync snapshot, doesn't need alarms.

- [x] **v0.4 COLD-START BUILT + MERGED** (workflows `w5irh0y0q` build + `w4fs2wmv7` research) — `v0.4/`, deployed `montydyn-v04`. → `docs/results/v0.4-coldstart.md`, `docs/research/coldstart-and-v1.md`. 62/62 smoke, zero regression.
      - **Real numbers (measured, honest):** base cold p50 **180ms** vs warm 163ms (~17ms cold delta) → p50 is **~all network/DO-wake**. Tail p99 **640ms** vs warm 180ms = **platform cold-isolate spin-up + first WASM instantiate, AROUND our code** (our restore phases read 0ms — sub-await). 5MB image: **R2 GET readMs ~597ms** = the one in-kernel-owned multi-hundred-ms cost.
      - **Conclusion:** cold start is **network/platform-bound** at v0 sizes — NOT fixable in-kernel; QuickJS init <300µs, read/gunzip/blit sub-ms. Only owned lever = **keep big images off R2 / stream R2 reads** (matters only >2MB gz).
      - **Wins:** pre-size = verified single-grow invariant (no latency change; module exports own memory so can't inject); lazy-instantiate = gen/ping pay no instantiate (~49ms saved on non-eval); **wasm-opt -Oz** quickjs.wasm −8.8% (1.59→1.45MB), byte-identical correctness.
      - **Long-tail harness now in infra:** `v0.4/bench/` (open-loop cold-wake distribution by size) + per-restore `restoreTimings` telemetry. Re-runnable.
      - **Measurement caveat:** workerd freezes clock in-turn → sub-turn phases inferred by differencing, not faked.

- [x] **v0.5 OBSERVABILITY + DEEP TEST** (workflow `woowhi0bs`) — `v0.5/`, deployed `montydyn-v05`. → `docs/results/v0.5-observability.md`. Merged.
      - **Cloudflare Analytics Engine live:** `env.AE.writeDataPoint` per op (index=doId; 7 blobs op/restoreSource/store/errorName/configClock/valueType/label; 12 doubles totalServerMs/readMs/sizeRaw/sizeGz/usedHeap/cell/generation/gunzipMs/instantiateMs/growCount/nChunks/ok) → dataset `montydyn_kernel`, queryable via AE SQL API. Structured Workers Logs. (worker crate has no AE binding → called via js_sys Reflect on Env; ingestion lag ~30–90s; use `quantileWeighted`.)
      - **Deep tests:** durability **11/11** (no holes under fault injection); scale **0 errors / 0 DO-kills @ 200 racers + 80 sessions**, mutex exact 0..199; adversarial fuzz **no sandbox escape**; idle-soak 4/4 + 120-cell integrity. Cold-start **confirmed platform-bound server-side** (restore phases read 0ms even at real 72s wakes).
      - ⚠️ **Top finding (P1, outside envelope):** reproducible **~256MB monotonic-buffer DO-kill** — a session grown past the safe envelope can't recover (WASM memory monotonic). Guards catch the documented ≤57MB envelope; this is the extreme-scale edge. Also: interrupt-throttle escape edge at high prior-load.
      - Minor: `host.fetch` returns `{}` instead of a typed reject on block (P3).

- [x] **DEEP-HIBERNATION TEST** (workflow `wohz9b923`) — `docs/results/deep-hibernation.md`. **7/7 cycles survived, ZERO loss** across real full eviction (base 3×12min, 5MB 2×12min, base 2×20min; socket CLOSED + idle held).
      - Genuine reconstruction every time (`inMemory:false`, generation bumped), `sqlite-restore`, state/closures/arrays intact. AE corroborated server-side (restore+eval gen/cell match).
      - **Deep cold-wake bounded, NO catastrophic placement penalty:** base 1.3MB ~130ms (even faster than shallow!); 5MB ~1.5–1.8s; base 20min ~1.3–1.5s. Dominant cost = **cold WS connect / DO spin-up ~950ms–1s** (platform), NOT our restore. ~1.5s worst real user wake.
      - **Durability verdict: rock-solid at 20-min full eviction.** Confirms deep tail is platform-bound (WS connect + spin-up), and sizes the adaptive-keep-warm policy below.

- [x] **v0.6 CONFIGURABLE STDLIB** (workflow `wf73e0anq`) — `v0.6/`, deployed `montydyn-v06`. → `docs/results/v0.6-stdlib.md`. **GO, viable-with-limits.**
      - 13/14 pure-JS libs (lodash/dayjs/zod/ramda/uuid/nanoid/date-fns/immer/decimal/js-yaml/papaparse/marked/rxjs) esbuilt → wrangler **Text module** → evaled into the QuickJS heap at `create` → **snapshot-persisted** (survive hibernation, no re-inject). `config.modules` selects subset. **mathjs opt-in only** (29× source→heap amplification). Added a **seeded `crypto` shim** (nanoid/uuid need it; was dead code before).
      - **Breaking point = snapshot OOM cliff at ~24–30 MB raw incompressible heap — BELOW the 45 MB dump guard → silent WS 1006.** Worker 10 MB cap NOT binding (760 KB gz). Inject cost ~80–90 ms/MB once at create. **Safe injected source ≤~500 KB** (≤7 MB raw, all-SQLite, create ≤520 ms, cold-wake ≤360 ms).
      - **3 guards to ship before test-all:** (1) config cap injected source ≤~500 KB; (2) mathjs opt-in; (3) **lower `MAX_DUMP_BUFFER_BYTES` ~45 → ~18–20 MB** so heavy bundles clean-reject instead of crossing the silent OOM.
- [x] **ENV-SURFACE RESEARCH** (workflow `wrdw5d8kf`) — → `docs/research/repl-env-surface.md`. **Two-runtime model:** `nodejs_compat` = HOST only; VM = bare QuickJS (no fs/os/net/process/Buffer/threads/child_process — **missing primitives**, 6 WASI fns ceiling). **Verdict:** Node-*ish* POSIX-shim sandbox buildable (host-backed virtual fs→SQLite/R2, net→host.fetch, crypto→host), never real Node. **Tier-0 cheap win:** 5 unused quickjs-wasi extensions (`crypto/encoding/url/structured-clone/headers`) wireable via `extensions`+`moduleLoader` → instant `crypto.subtle/TextEncoder/URL/structuredClone/Headers` in the VM.

## Next (V1 — facets feasible, ordered)
- [x] **v0.8 = mid-cell tripwire + Tier-0 extensions — DONE** (branch `feat/v0.8`, deployed `montydyn-v08`, → `docs/results/v0.8.md`). Smoke 24/24, zero regression. **(A) Mid-cell used-heap tripwire:** the interrupt handler now reads the WASM linear-buffer byteLength on every invocation while a cell runs and throws a typed `MemoryLimitError` on per-cell growth >8MB (or absolute >16MB), BELOW the 18MB dump ceiling → in-cell array/object/string alloc bombs are caught MID-CELL (socket alive, next eval works), closing the v0.7 Medium gap. Limitation: native-builtin bombs (`.fill` on huge typed arrays) yield no bytecode interrupts and can outrun it (QuickJS OOM stays catchable). **(B) Tier-0 extensions:** the 5 quickjs-wasi `.so` (crypto/encoding/url/structured-clone/headers) wired at create AND restore (same descriptors+order; restore re-instantiates the natives at fixed bases before the heap blit) → `crypto.subtle`/`getRandomValues`/`randomUUID`, `TextEncoder/Decoder`, `URL`/`URLSearchParams`, `structuredClone`, `Headers` live in the VM and survive evict/cold-restore. **Determinism preserved:** crypto getRandomValues/randomUUID route through the already-seeded WASI `random_get`, so seeded sessions stay byte-identical across restore; subtle is pure-of-input. `.so` shipped as CompiledWasm renamed `.wasm` (wrangler loader maps by extension; workerd forbids runtime compile).
- [x] **v0.7 = guards + test-all — DONE, GO** (workflow `wjtvb8fep`, deployed `montydyn-v07`, → `docs/results/v0.7-guards.md`). 3 guards live (source cap 500KB · mathjs opt-in · `MAX_DUMP_BUFFER_BYTES` 45→18MB). **Silent ~24–30MB OOM hole CLOSED** — 24.4MB buffer now clean-rejects (typed `SizeAdmissionError`, socket alive). Test-all PASS: 13/13 smoke, stdlib matrix, zero regression, adversarial no escape/no kill. Open (Medium): in-cell raw-alloc bombs lose the in-flight reply but recover cleanly on reconnect → **mid-cell used-heap tripwire** is next hardening.
- **Next:** (1) **mid-cell used-heap tripwire** (close the Medium in-cell alloc-bomb gap). (2) **Tier-0 extensions wire-up** (5 quickjs-wasi `.so` → crypto.subtle/TextEncoder/URL/structuredClone/Headers in VM, cheap env-fidelity jump). (3) **V1 facets** (de-risk facet WS hibernation → JS-facet port → sharded supervisor). Workers live: `montydyn-v07` (kernel), `montydyn-v05` (baseline), `montydyn-facet` (V1 proof).
- **Cold-start: solved/accepted, now empirically sized.** p50 network-bound; deep-eviction worst real wake ~1.5s (platform WS-connect/spin-up), state always survives. Owned lever = R2-read path for >2MB images. **Adaptive keep-warm** (future, supervisor-side): most sessions eat the ~1.5s wake fine → keep-warm only for latency-sensitive hot sessions (heartbeat WS to dodge eviction); predict cadence, decide *when NOT to warm*. Build after V1 supervisor.
1. **De-risk facet WebSocket hibernation** (API present, unproven) — the top gating unknown for V1.
2. **Port the Rust DO shell → a JS facet DO class** (mutex, checkpoint commit-ordering, manifest SQL) wrapping `glue.js`; keep P3 async eval.
3. **Switch WASM delivery to `{wasm}`** Worker-Loader module type (from CompiledWasm import).
4. **Build SupervisorDO** — owns routing + alarms + `worker_loaders`; per-session kernel facets, per-tenant isolation.
5. **Scale/cold-start validation** — facet count, eviction, `facets.delete`, RPC budget.
- Deferred: beyond-envelope memory reclaim; streaming gunzip (>30 MB); Python kernel (RustPython); Rivet ActorCore.
- Open V1 risks: facet WS hibernation, `{wasm}` type undocumented, multi-named-facet scale, loader codeId cache foot-gun.

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
