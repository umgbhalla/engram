# montydyn — Cold-Start & V1 Multi-Tenant Research Brief

> Status of evidence: montydyn's own numbers (~180ms p50 cold wake, ~700ms first WASM instantiate) are **unvalidated, single-source, and clock-frozen-prone**. The component breakdown below is *inferred from documented platform mechanics*, not traced. Adversarial review flagged the headline "WASM instantiate is THE p99 driver" as **overstated** — residency/eviction is the stronger competing hypothesis. Treat Section 1 as a *ranked hypothesis*, validate via Section 3 before spending engineering effort.

---

## 1. Cold-start reality — decomposed

Wake latency decomposes (roughly, serialized) as:

```
client→colo RTT  +  [if WS dropped] WS re-establish RTT  +  [if evicted] DO host activation/placement
                  +  V8 isolate provisioning  +  Worker bundle cold-load  +  constructor re-run
                  +  WASM instantiate (compile→link→Instance)  +  lazy Liftoff first-call compile
                  +  snapshot read/gunzip/blit (already sub-ms — NOT the bottleneck)
```

### Network/platform-bound (mostly NOT fixable in-kernel)
- **client→colo RTT** — fixed by physics + colo selection. Not fixable.
- **Cross-region placement RTT (50–150ms+)** — set ONCE at first `get()` that calls a method; DOs **never relocate** (relocation is roadmap, not shipped). *Partly* in your control: deliberate location hint at create-time (architectural choice, not immutable). [DO data-location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- **DO host activation (inactive→active full eviction)** — the expensive p99/p99.9 path: re-place object on possibly-cold host + cold Worker/WASM load. Avoidable by keeping DO resident (see levers).
- **V8 isolate spin-up** — Cloudflare: dynamically-loaded isolates start in "a few ms"; isolates warmed during TLS handshake. Small in median, real in the cold tail. Not directly controllable.

### Compute-bound (fixable in-kernel / in-design)
- **WASM instantiate** — QuickJS engine init is **<300µs** ([QuickJS docs](https://bellard.org/quickjs/)), so the ~700ms is **NOT** engine init. AOT compile happens at **deploy** (Wrangler `CompiledWasm` rule), not per-request — `new WebAssembly.Module(bytes)` at runtime throws *"Wasm code generation disallowed by embedder"* ([Prisma 7 issue](https://github.com/prisma/prisma/issues), confirmed). The cold cost is **cold-isolate deserialize/link + lazy Liftoff per-function baseline compile on first execution**, NOT your-module AOT compile.
- **Constructor re-run** — re-runs on EVERY hibernated/inactive→active transition; in-memory state discarded. Anything rebuilt here is on the critical path. Make it cheap + lazy. [DO lifecycle](https://developers.cloudflare.com/durable-objects/)
- **Module size** — Cloudflare confirms larger Workers start slower. quickjs-wasi ≈1.4MB; quickjs-emscripten sync ≈500KB, asyncify ≈1MB (2× size, ~40% speed). Below 128KB V8 skips code-cache. Shrinkable.

### Ranked levers (expected effect — directional, unbenchmarked)

| # | Lever | Attacks | Expected effect | Caveat |
|---|-------|---------|-----------------|--------|
| 1 | **Warmup-into-snapshot** — take heap snapshot AFTER WASM instantiate so wake restores an already-instantiated VM | WASM instantiate + Liftoff | Removes instantiate from wake path entirely → p99 collapses toward p50 | Must regenerate snapshot on any WASM/QuickJS build change (version-lock to build hash) |
| 2 | **Keep DO resident via hibernatable WS** + `setWebSocketAutoResponse()` heartbeats | inactive/full-eviction (the p99/p99.9 driver) | Eliminates cold-host + cold-WASM tail for active sessions; idle hibernation unbilled | Constructor STILL re-runs on wake; pairs with #1 |
| 3 | **Module-global compiled `WebAssembly.Module`** (top-level, outside DO class) | per-isolate recompile | Warm-isolate recreations skip compile → instantiate-only | NOT guaranteed to survive eviction; helps warm population, *misses the cold tail by construction* ([how-workers-works](https://developers.cloudflare.com/workers/reference/how-workers-works/)) |
| 4 | **Deliberate location hint at create** (control-plane creates kernel DO near user) | cross-region RTT | Removes 50–150ms+ accidental hops from p50 & geo tail | Best-effort; wrong hint locked in (no relocation) |
| 5 | **WS Hibernation API** (socket survives at edge) + pipeline WS upgrade with first eval | WS re-establish RTT (largest p50 chunk) | Tens of ms off p50; one fewer round-trip | Auto-response only matches static req/resp |
| 6 | **Shrink module** (`-Oz -flto`, drop ASYNCIFY, `wasm-opt -Oz`, `--closure 1`, `FILESYSTEM=0`) | cold-isolate compile | Tens-to-hundreds ms off p99 proportional to size cut | Only the WASM-size-bound portion; can't touch isolate spin-up |
| 7 | **Pre-touch hot snapshot-restore functions** during init | Liftoff first-call spikes | Pulls lazy compile off first-keystroke path | Small relative to isolate spin-up |

**SMART PLACEMENT IS A FALSE LEAD** — only affects `fetch` handlers, **NOT RPC / named entrypoints**, and can break DO-over-RPC calls. Does not relocate DOs. ([community bug](https://community.cloudflare.com/t/smart-placement-breaks-durable-object-rpc/654797), [placement docs](https://developers.cloudflare.com/workers/configuration/placement/))

---

## 2. Concrete techniques to try (ordered value/effort) + validation vs v0.4 long-tail harness

1. **Warmup-into-snapshot (highest value).** Move WASM instantiate + any bootstrap eval *before* the snapshot point so the persisted heap is already-instantiated.
   *Validate:* A/B p99 of `restore-from-post-instantiate-snapshot` vs current `instantiate-then-restore`, measured **externally** (client/edge timestamps). Success = tail collapses toward p50.

2. **Hold a live hibernatable WS + auto-response heartbeats.** Keep active sessions out of the inactive/full-eviction path.
   *Validate:* Two HdrHistograms — resident-session p99 vs forced-full-evict-recreate p99. Quantifies how much of the 700ms is residency vs WASM.

3. **Module-global `WebAssembly.Module` cache.** Top-level const, reuse across DO instances.
   *Validate:* warm-isolate **2nd+** instantiate latency vs cold **1st**. Confirms whether the Module actually survives within a warm isolate (Cloudflare gives no guarantee — empirical only).

4. **Location hint at create from control plane.**
   *Validate:* p50/p99 of sessions with deliberate near-user hint vs accidental first-request placement. Isolates the geographic component.

5. **WS Hibernation API + first-eval pipelining.**
   *Validate:* wake latency with socket-survival + pipelined first eval vs baseline. Quantifies the WS-RTT share of the 180ms p50.

6. **Shrink the QuickJS module** (`-Oz/-flto`, drop ASYNCIFY → ~halves size + ~2.5× speed, `QJS_DISABLE_PARSER=ON`/`QJS_BUILD_LIBC=OFF` only for fixed bootstrap code).
   *Validate:* `wrangler check startup` / `startup_time_ms` (authoritative; includes parse+GC+WASM compile) before/after. Plus external p99 delta. Isolates size-bound portion from isolate spin-up.

7. **Pre-touch hot functions during init.** Call snapshot-restore paths once at warm-up.
   *Validate:* per-message latency variance on first eval vs subsequent.

> **Measure with `wrangler check startup` / `startup_time_ms`, NOT a Chrome cpuprofile** — workerd freezes wall/perf clocks during sync exec, so internal and external numbers diverge. Deploy startup CPU budget was raised **400ms → 1s (Oct 2025)** — you can afford heavier top-level instantiate without error 10021.

---

## 3. Long-tail / p99 methodology — measure honestly

**Fix measurement first, or every decision is guided by lies.**

- **Coordinated omission (Gil Tene)** is the dominant trap for montydyn's exact closed-loop setup. A sync client can't send during a 700ms stall, so it omits the samples a real user hits. Documented cases: reported p99 optimistic by **10–40×** (47ms test → 1.8s prod = 38×). Current numbers likely understate the true tail.
- **Fix:** open-loop / arrival-rate generator (**wrk2**, **k6 ≥0.27 arrival-rate executor**) + **HdrHistogram with CO correction** (supply target inter-arrival interval). Expect p99.9 to jump to its true value — that's the real target.
- **Measure from OUTSIDE the isolate** (client end-to-end or edge ingress). In-isolate timers under-report because workerd freezes the clock during sync execution. Trust external timestamps for the tail; in-isolate timers only valid for sub-ms relative micro-bench.
- **Bimodal split:** maintain TWO histograms — **COLD** (constructor re-ran, tagged via a `was-rehydrated` flag set in constructor) vs **WARM** (resident). A single p99.9 hides the cold cost. Never average percentiles across shards/windows; never average component p99s into an end-to-end p99 (HdrHistogram merges losslessly).

**Tail-tolerance options that fit a per-session DO:**
- **Hedged / tied requests DO NOT APPLY** to the kernel — a per-session DO holds unique live heap with no replica to race. (They *do* apply to any stateless fan-out the supervisor performs.)
- **Good-enough/partial responses: EXCLUDE** — a REPL must return exact deterministic output.
- **The only lever is reducing the cold path itself** (Sections 1–2), not racing duplicates.
- **Reseed on wake:** refresh `Date.now` anchoring, reseed `Math.random`/crypto RNG, re-establish WS — heap-captured clock/RNG/identity is stale (Firecracker "Restoring Uniqueness" hazard; Modal "resumed on a different computer"). Run reseed in an async tick where clocks advance.

---

## 4. V1 DO-Facet scaling

### Documented (trust the [Facets docs](https://developers.cloudflare.com/durable-objects/), beta, Workers Paid only)
- `ctx.facets` has **three** methods: `get(name, cb) → Fetcher`; `abort(name, reason)` (evict, **keeps** SQLite); `delete(name)` (aborts + **permanently deletes** the facet's SQLite). `delete` exists (search snippets that said otherwise are wrong).
- A facet = a dynamically-loaded `DurableObject` class running as a **child** of the supervisor, with **separate SQLite** but stored as ONE overall DO. Facet code cannot read supervisor DB.
- `getStartupOptions` callback returns `{ class (required), id? }`; called **only** when facet not-yet-started or hibernated. Hibernated facet transparently re-loads code on next `get()` — the wake/restore hook.
- Use Worker Loader **`get(stableId, cb)` NOT `load()`** so the runtime reuses the isolate "if not yet evicted." `globalOutbound` controls egress (`null` = cut off; a `ctx.exports` loopback lets supervisor inject auth / attribute tenant).
- Cost: Dynamic Workers $0.002 per **unique** Worker loaded per **day** (**waived in beta**) + normal CPU/invocation. Share ONE kernel code id across tenants → flat cost.

### Documented BY OMISSION / must spike empirically (NOT inferable from docs)
- **`{wasm}`/CompiledWasm Worker-Loader module type does NOT exist.** Documented value types: ES module, `{cjs}`, `{py}`, `{text}`, `{data: ArrayBuffer}`, `{json}`. **Ship QuickJS as `{data: ArrayBuffer}` + call `WebAssembly.instantiate()` inside the loaded JS.** The project's "{wasm} delivery" assumption is **unsupported** — verify before designing cross-facet Module sharing around it.
- **Facet alarms:** docs are *silent*, not explicitly prohibitive. The whole supervisor-owned keep-warm design rests on this inference. **Confirm in beta.** Supervisor is a normal DO and CAN `ctx.storage.setAlarm` (at-least-once).
- **Max facets per supervisor:** "any number" — no numeric cap. Real ceiling is **storage: 10GB shared per DO**. Thousands of sessions = a few MB/session budget — unproven "acceptable" without snapshot-size distribution.
- **Facet hibernation/eviction thresholds:** undocumented. Do they match ~10s hibernate / 70–140s evict? Unknown.
- **Whether a compiled Module can be shared across facets in one isolate** — inference, not documented. Determines if per-facet cost is instantiate-only vs instantiate+compile.

### The hard ceiling: single-threaded supervisor
A supervisor DO is **one event loop**: soft **~1,000 req/s**, **30s CPU/invocation**. Facets give isolated storage+code, **NOT a second thread**. Any keep-warm sweep over thousands of facets, billing/ACL checks, or WS handoff that touches supervisor logic **serializes here**. "Thousands under ONE supervisor" is **NOT production-viable** as stated (adversarial verdict: false, medium confidence).

### Recommended V1 guardrails
1. **Shard tenants across many supervisors** — tens-to-low-hundreds of facets each, NOT thousands under one. Relieves both the 10GB envelope and the single-thread bottleneck.
2. **Facet serves its own WS** (facet as WS server); use `serializeAttachment` for session id. Keeps supervisor off the hot path; per-facet hibernation applies.
3. **Supervisor owns ALL scheduling** (single alarm; on fire `get()` + RPC the target facets). Treat facets as alarm-less.
4. **Billing/ACL/rate-limit in supervisor SQLite** (facet can't read it). `abort` = evict-keep, `delete` = de-provision + reclaim storage.
5. **One stable Worker-Loader code id** for the kernel → isolate reuse + flat $0.002/day cost.
6. **`globalOutbound` → supervisor loopback** for per-tenant egress auth/attribution.
7. **Budget by storage bytes, not facet count.**

---

## 5. Cross-platform benchmarks — targets + transferable ideas

| System | Restore (ideal) | End-to-end | Note |
|--------|-----------------|------------|------|
| Firecracker snapshot | p50 ~3–4ms / p99 ~9–12ms | — | Headline percentiles from a single aggregator, methodology undisclosed — **directional only** |
| AWS Lambda SnapStart | 3.2 / 8.7ms | — | |
| Fly.io | 4.1 / 12ms | — | |
| Full cold boot | ~110ms / ~340ms | — | The thing snapshots avoid |
| e2b (Firecracker) | 5–30ms advertised | ~150ms–1s | Gap = orchestration+network, NOT blit |
| Modal memory snapshots | — | 2.5–10× faster (torch 5s→1.05s p50) | CRIU/gVisor process-tree checkpoint |
| Rivet actors | "~negligible"/~20ms keyless | excludes WS RTT | Keeps **runner hot** — amortizes instantiate into long-lived host |
| CF Sandbox SDK (container) | — | 1–3s | The model to AVOID; separate VM, non-co-located placement |

**The universal lesson:** memory restore is single-digit ms everywhere (montydyn's blit is already sub-ms) — the residual tail is **runtime instantiate on a cold isolate**, same fight for everyone.

**Transferable ideas (concept transfers, absolute numbers do NOT — montydyn has no guest kernel/FD/process-tree):**
- **Warmup-into-snapshot** (Modal `@enter(snap=True)`; Javy/Shopify Wizer; quickjs-wasi whole-linear-memory snapshot ≈256KB baseline) → snapshot a *post-instantiate* VM. **Highest leverage.**
- **Warm pool of pre-instantiated runtimes** (e2b templates, Vercel Sandbox auto-snapshot-on-stop GA Jan 2026, CF pre-scheduled instances). montydyn analogue: module-global compiled Module + supervisor-held warm pool of template snapshots.
- **Hot runner** (Rivet) → cache compiled Module at isolate scope so cold DOs clone an already-compiled module.
- **Durable/ephemeral split** (Rivet `ctx.state` vs `ctx.vars`) → snapshot only the QuickJS heap; rebuild host bindings on wake.
- **Working-set pre-fault** (Modal FUSE preload, Firecracker) → ONLY if heap grows past sub-ms blit regime. Currently premature.
- **Keep-warm heartbeats** (CF Sandbox 30s keepAlive) → for active sessions; trades idle billing for latency.

---

## 6. Net recommendation

**Highest-value SHORT-TAIL lever:** **Warmup-into-snapshot** — persist the QuickJS heap *after* WASM instantiate so a cold wake restores an already-instantiated VM and never pays the ~700ms on the wake path. This makes the "is it WASM instantiate or isolate spin-up?" debate **moot**, because instantiate leaves the wake path entirely. Pair with a **live hibernatable WebSocket + auto-response heartbeats** to keep active sessions out of the expensive inactive/full-eviction path (removes WS-reconnect RTT from p50 too). Module-global Module caching is a *secondary* warm-population optimization, not a cold-tail fix.

**LONG-TAIL V1 path:** Supervisor-as-control-plane + per-session kernel facets with isolated SQLite, **sharded across many supervisors** (tens-to-low-hundreds of facets each) to dodge the single-threaded ~1k-req/s supervisor ceiling. Supervisor owns alarms, warm-pool top-up, and snapshot regeneration (facets can't set alarms). Deliver the kernel WASM as **`{data: ArrayBuffer}` + runtime `instantiate`** under ONE stable loader code id. Facets serve their own WS for per-facet hibernation.

### Verify with RUNNING experiments (not more research)
1. True external (edge/client) decomposition of the 700ms: isolate spin-up vs bundle load vs instantiate vs Liftoff first-call. **#1 untested item.**
2. Open-loop + CO-corrected, bimodal (cold/warm) p99/p99.9 baseline. Run *before* any optimization.
3. Does warmup-into-snapshot collapse the tail for QuickJS-WASM specifically? (net-new spike)
4. Does a resident hibernatable-WS DO actually skip the eviction path and remove the 700ms?
5. Does a module-global Module survive eviction within a warm isolate? (no CF guarantee)
6. How much does module-shrinking remove vs the irreducible isolate-spin-up floor?

### Settled by research (don't re-spike)
- Snapshot read/gunzip/blit is sub-ms — NOT the bottleneck; stop optimizing it.
- QuickJS engine init <300µs — not your p50 problem.
- Runtime `WebAssembly.compile` is blocked on workerd; AOT compile is at deploy.
- Smart Placement does not apply to DO/RPC.
- Hedged/tied requests don't apply to a unique stateful kernel.
- `{wasm}` loader module type does not exist; use `{data}`.
