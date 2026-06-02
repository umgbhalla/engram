# Engram — Prior Art Synthesis

> Four research tracks (live WASM snapshot · durable edge JS runtimes · JS-in-WASM stacks · durable-execution/actors) collapsed into one verdict for the owner. Blunt, no fluff.

## 1. BOTTOM LINE

**Has anyone already built Engram — a live-heap-snapshot, durable, hibernating JS REPL on the edge?**

**No — not the whole thing. PARTIAL on the parts.**

The *snapshot primitive* Engram runs on is public prior art and not novel. The *durable-hibernation lifecycle on a constrained serverless edge host* is, as far as the public landscape shows, unoccupied.

Closest 2–3 analogues:

1. **vercel-labs/quickjs-wasi** — the exact mechanism (wholesale QuickJS linear-memory dump incl. pending promises/closures, restore into a fresh instance, continue). This *is* Engram's upstream substrate. It proves the trick; it does nothing about durability, hibernation, multi-tenancy, or idle-eviction-resume. <https://github.com/vercel-labs/quickjs-wasi>
2. **E2B Sandboxes** — the only system doing true live-evolved-state pause/resume (full RAM + FS), but at the Firecracker **microVM** layer: GiB-scale, ~4s pause / ~1s resume, requires a VM. Engram does the JS-interpreter-heap equivalent at sub-MB-to-tens-of-MB, sub-second, *inside a Durable Object* where no VM/CRIU can run. <https://e2b.dev/docs/sandbox/persistence>
3. **Golem Cloud** — the strongest *UX* peer (swap thousands of idle WASM workers out, resume "from where it left off") and the sharpest *foil*: it runs on WASM (heap IS dumpable — Engram's exact insight) and **still chose oplog replay over heap snapshot**. Proves resume-thousands does not require heap-snapshot; Engram's snapshot only buys the *no-replay / no-re-fire / arbitrary-closure-and-promise-fidelity* guarantees. <https://learn.golem.cloud/operate/persistence>

The single most important framing correction: **the WASM-heap-dump is table stakes, not the innovation.** Two same-platform foils make this undeniable — Cloudflare's own **Sandbox SDK** clears all interpreter contexts on idle sleep, and Cloudflare's own **Workflows** explicitly discards in-memory state and demands step-replay. Engram is the only thing on that substrate that keeps the live namespace.

## 2. LANDSCAPE TABLE

| Project | Category | Live-heap snapshot? | Maturity | How it relates to Engram | URL |
|---|---|---|---|---|---|
| vercel-labs/quickjs-wasi | Live WASM snapshot | **YES** (full live heap incl. promises/closures) | alpha | Engram's direct substrate. The trick, productionized = Engram. | <https://github.com/vercel-labs/quickjs-wasi> |
| chiwawa | Live WASM snapshot (research) | **YES**, deeper (PC + value/frame stacks, mid-instruction) | research | Solves the mid-call-stack gap Engram punts on, by owning the interpreter loop. | <https://github.com/oss-fun/chiwawa> |
| wasmbox | Live WASM snapshot | **YES** (linear-memory dump) | alpha | Independent confirmation of dump+determinism pattern. | <https://docs.rs/wasmbox> |
| Faasm / Faaslets | Stateful serverless WASM | PARTIAL/YES (Proto-Faaslet CoW + state migration) | research | Migration & CoW fast-spawn; not idle-hibernate-then-wake. | <https://github.com/faasm/faasm> |
| Wizer | Build-time pre-init | **NO** (build-time only) | production | The canonical "NOT live" baseline; usable for faster cold create. | <https://github.com/bytecodealliance/wizer> |
| Live-migration papers (JSA'25 / het-VM 2024) | Live WASM migration (research) | **YES**, incl. AOT/native-stack reconstruction | research | State of the art on the hard part Engram avoids; goal is mobility, not hibernation. | <https://www.sciencedirect.com/science/article/pii/S1383762125002048> |
| WasmFX / effect handlers | WASM proposal | NO (enabler) | research | Reifiable continuations would unlock mid-stack snapshot without forking the interpreter. | <https://arxiv.org/abs/2308.08347> |
| Wasmtime epochs + CoW pooling | WASM runtime | NO (build-time image + interrupt timer) | production | Epoch interrupt = Engram's tick-budget; CoW image = fast create. | <https://bytecodealliance.org/articles/wasmtime-10-performance> |
| CRIU / Modal / Firecracker snapshots | Process/VM checkpoint | YES (process/VM granularity) | production | Right idea, wrong granularity; unavailable inside CF DOs. | <https://modal.com/blog/mem-snapshots> |
| E2B Sandboxes | Durable edge sandbox | **YES** (full RAM+FS, microVM) | production | Only true live-state peer; whole-VM, GiB, seconds. | <https://e2b.dev/docs/sandbox/persistence> |
| Modal Memory Snapshots | Serverless checkpoint | PARTIAL/NO (one-time post-init) | production | Best public writeup of restore tradeoffs (RNG/net/CPU/FD). | <https://modal.com/blog/mem-snapshots> |
| AWS Lambda SnapStart (CRaC) | Cold-start snapshot | NO (publish-time only) | production | beforeCheckpoint/afterRestore hook pattern is borrowable. | <https://docs.aws.amazon.com/lambda/latest/dg/snapstart-runtime-hooks-java.html> |
| Cloudflare Sandbox SDK | Edge code interpreter | **NO** (clears contexts on sleep) | production | Same-vendor foil: loses live REPL state on idle. | <https://developers.cloudflare.com/sandbox/concepts/sandboxes/> |
| Cloudflare DO + WS Hibernation | Substrate | NO (discards in-mem JS) | production | The constraint Engram engineers around. | <https://developers.cloudflare.com/durable-objects/best-practices/websockets/> |
| Val Town | Edge JS | NO (logical stores only) | production | Mainstream "stateless + BYO storage" model. | <https://blog.val.town/blog/first-four-val-town-runtimes/> |
| Deno Deploy / Subhosting | Edge JS (V8) | NO (V8 = no heap snapshot) | production | Confirms the V8 wall driving Engram's QuickJS choice. | <https://deno.com/blog/subhosting-security-run-untrusted-code> |
| Fermyon Spin / spin-js-sdk | WASM serverless | NO (stateless, KV store) | production | WASM-native yet leaves linear-memory snapshot on the table. | <https://developer.fermyon.com/spin/kv-store> |
| Javy (Shopify/BA) | JS-in-WASM | NO (Wizer build-time, stateless run) | production | Flagship Rust+QuickJS-in-WASM; orthogonal goal. | <https://shopify.engineering/javascript-in-webassembly-for-shopify-functions> |
| StarlingMonkey (BA) | SpiderMonkey-in-WASM | NO (Wizer pre-init) | production | Why SpiderMonkey isn't snapshottable; validates QuickJS choice. | <https://github.com/bytecodealliance/StarlingMonkey> |
| second-state/quickjs-wasi | QuickJS-on-WasmEdge | NO | production | Proves the wasi-sdk build path; no snapshot API. | <https://github.com/second-state/quickjs-wasi> |
| rquickjs on wasm32 | Rust QuickJS bindings | NO | production | wasm32-unknown-unknown unbuildable (wontfix #93); wasm32-wasi OK but no snapshot. | <https://github.com/DelSkayn/rquickjs/issues/93> |
| Golem Cloud / Golem 1.5 | Durable WASM runtime | **NO** (oplog replay; logical-state snapshot for compaction) | production | Strongest UX peer + foil; chose replay over heap-dump on WASM. | <https://learn.golem.cloud/operate/persistence> |
| Lunatic | WASM actor runtime | NO (supervision/restart) | alpha | Erlang model: lose & re-derive, not snapshot. | <https://github.com/lunatic-solutions/lunatic> |
| Temporal | Durable execution | NO (deterministic replay) | production | The canonical replay contrast Engram positions against. | <https://temporal.io/product> |
| Restate | Durable execution | NO (journal replay) | production | Another replay datapoint. | <https://devstarsj.github.io/2026/04/03/durable-execution-temporal-restate-dbos-distributed-workflows-2026/> |
| DBOS | Durable execution | NO (Postgres step checkpoints) | production | Replay can be a boring SQL table; validates SQLite-first framing. | <https://www.dbos.dev/compare/compare-dbos-vs-temporal-dbos> |
| Cloudflare Workflows | Durable execution | **NO** (step replay, discards in-mem) | production | Same-substrate killer foil: CF's own product can't do what Engram does. | <https://developers.cloudflare.com/workflows/build/rules-of-workflows/> |
| Azure Durable Functions | Durable execution | NO (event-sourcing replay) | production | Same replay family + determinism tax. | <https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-overview> |
| Orleans / Dapr Actors | Virtual actors | NO (logical state rehydrate) | production | Hibernate-idle/resume UX via serialized state, not heap. | <https://qu3ry.net/articles/memory-resident-execution/orleans> |

## 3. BORROWABLE — what Engram should steal

- **chiwawa's value/frame-stack + PC serialization** (runtime-neutral, OSS). Read it to design a future mid-cell snapshot path that captures *inside* a running call — directly closes Engram's biggest fidelity gap (snapshot only at cell/interrupt boundaries). <https://github.com/oss-fun/chiwawa>
- **Wizer-baked initial module for the COLD create path** (Wizer / wasmtime CoW). Pre-init the QuickJS module **and stdlib injection** at build time so v0.6's ~80–90 ms/MB create-time eval cost is paid once at build, not per session. Composes cleanly under runtime snapshots — split the two concerns (matches the v0.4 finding that create-time injection is the cost). <https://github.com/bytecodealliance/wizer>
- **faasm Proto-Faaslet CoW restore + shared-memory state regions** — a model for fast multi-tenant spawn (V1 facets): share one read-only base image across many session facets. <https://github.com/faasm/faasm>
- **CRaC beforeCheckpoint/afterRestore hooks** — formalize Engram's I/O boundary into a guest-facing JS callback pair so user code can drain/flush and re-acquire non-deterministic resources around a snapshot. <https://docs.aws.amazon.com/lambda/latest/dg/snapstart-runtime-hooks-java.html>
- **Modal/CRaC automatic fallback-to-cold-boot** on restore failure / host incompat — on restore failure, cleanly re-init a fresh kernel instead of crashing the session (complements the existing build-time engine-hash guard). Also lift Modal's explicit restore-on-a-different-host treatment (connections unrestorable, IP may differ) into a documented `host.fetch`/handle reconnect contract. <https://modal.com/blog/mem-snapshots>
- **Golem 1.5 oplog-compaction-via-periodic-snapshot — the highest-value steal.** A *hybrid*: keep a short oplog of host calls (fetch/time/random) since the last heap snapshot; snapshot the full multi-MB image *less often* and replay the tiny recent oplog to catch up. Directly attacks Engram's two worst pains (monotonic-memory high-water-mark, dump-size ceiling, per-cell write amplification). Trades "never replay" purity for a tunable replay window — at minimum a design note, even if rejected on principle. <https://blog.vigoo.dev/posts/golem15-part6-user-defined-snapshotting/>
- **Golem engine-version-migration-via-replay — the escape hatch.** Engram's heap image is QuickJS-version-locked (the whole reason the engine-hash guard exists). Borrow Golem's "load new component version, replay oplog from the beginning": when the engine hash changes, fall back to replaying a retained host-call oplog (or re-evaluating a retained source-cell log) into the new engine instead of bricking the session. This is the structural answer to heap-snapshot's upgrade brittleness. <https://learn.golem.cloud/operate/persistence>
- **wasmtime epoch cadence cross-check** — confirms Engram's interrupt-tick loop-preemption is standard; cross-reference `async_yield_and_update` cadence against the workerd interrupt-throttle ceiling (the v0.2 finding that forced budget ≤1200). <https://bytecodealliance.org/articles/wasmtime-10-performance>
- **Verify the snapshot triple against quickjs-wasi source.** Confirm Engram captures linear memory + `__stack_pointer` global + runtime/context struct pointers — not just `memory.buffer` + globals. If the stack pointer handling differs, that is a latent restore-fidelity bug. <https://github.com/vercel-labs/quickjs-wasi>
- **Watch WasmFX / typed-continuations** — if it lands in workerd, mid-stack snapshot becomes possible without forking the interpreter. <https://arxiv.org/abs/2308.08347>

Move-logic-out-of-hand-written-JS candidates: the Wizer-bake (stdlib injection → build-time data segments) and the quickjs-wasi snapshot-triple alignment both reduce bespoke glue. The hybrid oplog is *more* logic, not less — accept that tradeoff knowingly.

## 4. WHERE ENGRAM IS NOVEL (and where it is NOT)

**Genuinely novel — the one defensible axis:** Engram is the only system that persists the **actual live heap** (WASM linear memory + globals + entropy) **automatically and transparently, with zero developer-authored serializers**, preserving full live-state fidelity — arbitrary closures and in-flight pending promises survive **real idle eviction** — and resumes with **no replay and no re-fired side-effects**, at the **in-process WASM layer** (sub-MB to tens-of-MB, sub-second, blitted into a fresh isolate **inside a Durable Object**). Nobody else combines all of: automatic + transparent + zero-serializer + live-fidelity + no-replay + in-DO + idle-hibernation.

The sharpest proofs of the gap:
- **Golem runs on WASM and still chose replay** over heap-snapshot.
- **Cloudflare's own Workflows and Sandbox SDK**, on Engram's identical substrate, throw away in-memory state.
- Even WASM-native **Fermyon Spin** stays stateless and persists to KV.

Beyond the snapshot, the *system* is the moat: SQLite-first chunked storage + R2 overflow, crash-atomic checkpoint commit, size-admission/used-heap/tick-budget guards engineered to the platform's exact OOM + interrupt-throttle ceilings, seeded-entropy determinism across restore, the I/O boundary, and DO-facet multi-tenancy with auth/metering.

**Where Engram is NOT special — say it plainly:**
- The live-heap snapshot **trick is not novel.** quickjs-wasi does it byte-for-byte; wasmbox/chiwawa/faasm/migration papers all do runtime linear-memory capture+resume. Stop framing the WASM-heap-dump as the innovation.
- **Hibernate-thousands / resume-where-left-off UX is table stakes** — Golem and virtual actors (Orleans/Dapr) deliver it via replay/rehydration. Engram is not differentiated at the UX layer.
- **Determinism via seeded clock/RNG/crypto is a rediscovered standard,** not an Engram quirk (wasmbox states it explicitly; Temporal/Modal/CRaC all handle it). Validates ADR/EXP-8 but is not a differentiator.
- **Mid-deep-synchronous-call snapshot is a known shared limitation** (C stack not in linear memory) — chiwawa already beats Engram here; WasmFX would erase the gap.

The honest counterweight the tracks make unavoidable: the no-replay/full-fidelity/zero-serializer niche **buys real downsides the replay world does not have** — engine/code-version-locked images, the monotonic-memory high-water-mark, and dump-size ceilings (Engram already feels all three: engine-hash guard, ~256 MB monotonic-buffer kill, 18 MB dump ceiling). Defensibility = owning the niche **AND** credibly answering those downsides (the borrowable replay-as-escape-hatch hybrid is the answer).

**Recommended thesis reframe:** "automatic, transparent **live linear-memory** snapshot — no user-authored serializers, preserves promise/closure fidelity, no replay — surviving idle eviction inside a Cloudflare Durable Object." NOT the bare word "snapshot" (overloaded — Golem/Orleans/Dapr all ship a "snapshot" feature meaning logical-state serialization).

## 5. FINDINGS THAT REVIVE A REJECTED REWRITE PATH

**None revive a full kernel rewrite. One claim needs nuance; one points at a future enabler.**

- **rquickjs — NOT revived, but the rejection rationale must be corrected.** The prior claim that rquickjs is simply "blocked on the CF WASM target" is imprecise. Reality (issue #93, wontfix): rquickjs is **unbuildable for `wasm32-unknown-unknown`** (compiles QuickJS C with `clang --target=wasm32-unknown-unknown`, which has no libc — `stdlib.h not found`). It **CAN build for `wasm32-wasi`** (libc via wasi-sdk). But this does **not** revive an all-Rust kernel, because (a) Cloudflare ships WASM as **CompiledWasm** modules, not a WASI host, and (b) rquickjs exposes **no live-heap snapshot API** regardless. So even if someone "ships rquickjs on the CF wasm target," it would not give the snapshot primitive — Engram's C/wasi-sdk quickjs-wasi build behind JS glue remains the pragmatically correct path. Reject reaffirmed, with sharper reasoning. <https://github.com/DelSkayn/rquickjs/issues/93>
- **WasmFX / effect handlers — a future enabler, not a current revival.** If typed continuations land in workerd, the mid-cell-stack snapshot limitation (currently shared with quickjs-wasi) becomes tractable without owning/forking the interpreter loop. Watch the proposal; do not act now. <https://arxiv.org/abs/2308.08347>
- **No SpiderMonkey reconsideration.** StarlingMonkey confirms SpiderMonkey's GC + JIT + conservative-stack scanning is exactly why it only does build-time Wizer. QuickJS-over-SpiderMonkey for snapshottability is reaffirmed. <https://github.com/bytecodealliance/StarlingMonkey>
