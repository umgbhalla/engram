# montydyn Post-V1.0 Roadmap

> Status as of 2026-06-01. V0.8 single-tenant kernel is deployed and verified. V1.0
> (multi-tenant: SupervisorDO + per-session kernel facets) is **building now in parallel**
> — this roadmap covers everything AFTER V1.0 lands. Design + sequencing only; no code,
> no deploys, no git in this document's scope.
>
> Source material: the DESIGN DIGEST (v1.1-parity, product, agent-codemode, hardening-ops),
> `docs/results/{v1-direction,SUMMARY,v0.8,deep-hibernation}.md`,
> `docs/research/{coldstart-and-v1,repl-env-surface}.md`, and `v0.8/src/glue.js`.

---

## 0. Where we are at the V1.0 line

V1.0 ships the multi-tenant skeleton: SupervisorDO (routing + shard + alarms + worker_loaders)
plus per-session kernel FACETS (own isolated SQLite, `{wasm}` delivery). What V1.0 does **not**
yet have is full v0.8 feature parity inside the facet — the spike's `facet-kernel.js` is a
stripped stub. Two platform blockers are resolved with proven workarounds (`{wasm}` module type
for WASM delivery; alarms-on-supervisor since facets cannot `setAlarm`). One gating unknown
remains open: **facet WebSocket hibernation is API-present but unexercised end-to-end**.

Everything below is sequenced so the immediate next phase (V1.1) closes the parity gap, and
the phases after it are gated on V1.1 being a true drop-in replacement for the deployed kernel.

---

## 1. Ordered Phases (after V1.0)

### Phase V1.1 — Facet feature parity + adaptive keep-warm  `[FIRST, blocking]`
**Why first:** until the facet kernel matches v0.8 byte-for-byte (stdlib, 5 Tier-0 extensions,
seeded determinism, all the guards), V1.0 is a routing shell that runs a degraded REPL. Every
downstream phase (product SDK, agent code-mode) assumes the facet behaves exactly like the
deployed kernel. This is the smallest, most mechanical, highest-certainty work (mostly a verbatim
port of glue.js logic into the JS facet class) and it unblocks everything else.
**Depends on:** V1.0 facet routing + `{wasm}` delivery + supervisor alarms (all landing now).
**Delivers:** STDLIB-1..4, EXT-1..4, WARM-1..5 from the digest.

### Phase 2A — Client SDK (`@montydyn/sdk`)  `[parallelizable, starts now]`
**Why here / why it can start early:** the SDK wraps the *stable, fully-observable* WS JSON
protocol that is ALREADY deployed on v0.8. It does not depend on V1.1 — it can be built and
tested today against the single-tenant kernel and will work unchanged against V1.0/V1.1 because
the protocol is identical. It is the lowest-risk revenue-enabling work and the foundation the UI
and agent-loop both sit on.
**Depends on:** nothing new (v0.8 protocol is frozen). Benefits from the tiny protocol addition
(echo a client `id`) which should be folded into the V1.0 supervisor if that window is still open.
**Delivers:** Product spec section A.

### Phase 2B — Notebook/REPL UI  `[after SDK core]`
**Why here:** thin SPA layered directly on the SDK Session. Pure client work, no kernel deps.
**Depends on:** SDK (2A) core methods + typed results.
**Delivers:** Product spec section B.

### Phase 2C — Supervisor auth + metering seam  `[after V1.0, alongside SDK]`
**Why here:** bolts onto the V1.0 SupervisorDO (hashed API keys in supervisor SQLite, tenant-scoped
session names riding the proven facet storage isolation, short-lived browser tokens, AE tenant
dimension + Stripe metered-usage push). Cannot touch the parallel V1.0 build until it lands, so it
is sequenced just after V1.0 / alongside the SDK rather than before.
**Depends on:** V1.0 SupervisorDO deployed; AE emit() seam (v0.8 lib.rs).
**Delivers:** Product spec sections C + D.

### Phase 3 — Agent code-mode adapter  `[after V1.1 + SDK + auth]`
**Why here:** this is the strategic differentiator (durable, stateful agent sandbox vs Cloudflare
Code Mode's ephemeral one), but it *requires* the facet to be a faithful kernel (V1.1), the host-tool
dispatcher to live on the supervisor with auth (2C), and ideally the SDK transport for the loop. It
is a thin contract/typing/registration layer on top of primitives that already exist in glue.js — so
once its dependencies are met it is ~5–7 days.
**Depends on:** V1.1 (durable facet kernel), 2C (supervisor-hosted dispatcher + auth + egress lockdown).
**Delivers:** agent-codemode spec steps 1–5.

### Phase 4 — Hardening / Ops  `[interleaved; (1a) and CI are near-term must-dos]`
**Why split:** the four hardening items have very different urgencies.
- **4a (native-arg pre-flight, NativeAllocLimitError)** — closes the last known WS-1006 (oversized
  structuredClone). No engine rebuild. Should land EARLY, ideally folded into V1.1's guard port.
- **4b (CI/CD + worktree workflow)** — montydyn has no CI today; this is a pre-V1-scale must-do that
  protects every subsequent deploy. Near-term.
- **4c (engine-upgrade migration journal + replay)** — needed before the FIRST engine-hash bump
  (e.g. when 1c malloc-limit lands). Medium-term, but must precede any engine change or it strands
  every live session.
- **4d (R2 stale-key prune)** — smallest; blocked on a USER-minted R2 S3 token. Do last.
**Depends on:** mostly orthogonal (guards live in glue.js); 4c gates any engine rebuild including 1c.

### Phase 5 — Scale / Breadth  `[after the product is real]`
**Why last:** only worth doing once there are paying tenants and a proven product. Two tracks:
- **Scale:** supervisor sharding (single-thread ~1k req/s, 30s CPU ceiling), facet-count ceilings
  per supervisor, snapshot/storage growth validation, R2 offload policy tuning, warm-session caps.
- **Breadth:** the Python-on-QuickJS-shim question (Node-ISH shim today; real Python = a separate
  runtime track) and richer stdlib/extension tiers. This is the big optional fork — see §3.
**Depends on:** everything above; real usage data (AE) to tune WARM EWMA*K and shard boundaries.

---

## 2. Ready-to-Fire Build-Workflow Briefs (near-term phases)

### Brief V1.1 — Facet parity + keep-warm
**What to build (3 slices, port from `v0.8/src/glue.js` into the JS KernelFacet class):**
- **SLICE A (stdlib):** extend supervisor bake script (`v1-facet/scripts/bake-modules.mjs`) to bake the
  esbuilt stdlib bundle as a Text-module string + `stdlib-meta` into `modules.gen.js`; ship via the
  Worker-Loader modules map as `{text}`/`{js}`. In the facet module top-level set
  `globalThis.__STDLIB_BUNDLE` / `__STDLIB_META` (no entry.mjs in facets — GOTCHA-4). Port verbatim:
  `stdlibBundle / resolveModules / stdlibDefaultModules / stdlibOptInModules / injectStdlib /
  enforceStdlibSourceCap (MAX_STDLIB_SOURCE_BYTES=500KB)` + `SizeAdmissionError`. Inject ONLY on the
  fresh-create branch, AFTER REBIND_SRC, NEVER on restore (heap blit already has the libs). mathjs stays
  opt-in-only.
- **SLICE B (extensions):** bake the 5 prebuilt quickjs-wasi `.so` (renamed `.wasm`, bytes unchanged)
  into `modules.gen.js` as base64; ship each as `{wasm: ArrayBuffer}` loader modules (the proven path —
  `{data}`+runtime-compile is BLOCKED in facets, GOTCHA-3). Assemble `globalThis.__QJS_EXT_MODULES`,
  port `EXTENSION_ORDER` + `buildExtensionDescriptors()`, pass the SAME descriptors in the SAME order to
  BOTH `QuickJS.create` and `QuickJS.restore`. Replace the spike's empty WASI stub with the real seeded
  `buildWasiFactory(entropy)`. Port the REBIND_SRC crypto block (native crypto + seeded getRandomValues
  shim routing through `__hostRandom`; subtle/randomUUID stay native) — runs BEFORE stdlib injection.
  Extend the ENGINE_HASH guard to also hash the 5 extension Module bytes (order-sensitive);
  `EngineHashMismatchError` on mismatch.
- **SLICE C (keep-warm):** on the SupervisorDO (alarms work there; facets cannot — GOTCHA-1), maintain a
  per-session warm registry in supervisor SQLite `{sessionId, lastActivityMs, evalCount,
  interArrivalEwmaMs, lastInterArrivalMs, warmUntilMs, isLatencySensitive, lastSnapshotSizeGz}`. One
  recurring alarm (~30–60s) sweeps and heartbeats (RPC ping or facet WS auto-response) only sessions that
  are latency-sensitive OR `evalCount>=2 AND interArrivalEwma < EVICTION_WINDOW AND recency < ~2x
  interArrivalEwma`. Explicitly skip one-shot, walked-away (recency > EWMA*K), naturally-slow-cadence, and
  small-image non-latency-sensitive sessions; shed sweeps under supervisor single-thread pressure.
- Carry over UNCHANGED: mid-cell used-heap tripwire (8MB/cell, 16MB abs), MAX_DUMP_BUFFER_BYTES 18MB,
  1200/2000 tick budget, P3 async eval + fetch pump + FetchBlockedError allowlist, kv-in-manifest.
- **Fold in 4a (NativeAllocLimitError) here** while the guards are being ported.
- Bump loader `codeId` on ANY change to glue/engine/extension/bundle bytes; tie codeId to a build hash
  (GOTCHA-2).
**Deploy target:** a new preview supervisor worker (e.g. `montydyn-v11-preview`) on a dedicated R2 key
namespace. DO NOT touch `montydyn-*` production / the parallel V1.0 build.
**Success gate:** facet kernel passes the v0.8 smoke suites (smoke-v08 24/24, smoke-v07-guards 13/13,
tripwire-gate, smoke-stdlib) AND a byte-identical determinism fixture across an evict+restore cycle; a
heavy stdlib selection (mathjs+others) clean-rejects via the 500KB source cap with the socket alive;
`{wasm}` extension Modules instantiate at facet boot (smoke check); a warmed latency-sensitive session
stays on the ~160–190ms warm path instead of the ~1.5–1.8s deep cold wake.

### Brief 2A — Client SDK
**What to build:** isomorphic TS `@montydyn/sdk`, dual ESM/CJS. `Montydyn({baseUrl, apiKey, fetch?})` →
`.session(id?, config?)`. Methods: `create / eval / reset / gen / stdlib / evict / ping / close`. Typed
config mirroring `normalizeConfig()` (clock/rngSeed/capture/cellBudget*/fetch/tools/modules/stdlib). Typed
result + discriminated error union (TimeoutError, MemoryLimitError, SizeAdmissionError, FetchBlockedError,
EngineHashMismatchError, plus the new NativeAllocLimitError once V1.1 lands). Transport abstraction: browser
native WebSocket + token-in-subprotocol; Node `ws` + Bearer header. Reconnect-safe (treat socket as
disposable — kernel is durable): exponential backoff + jitter (cap ~30s), client-assigned `id`/`reqId`
echoed by supervisor, dedupe eval replays via monotonic cell/generation. Surface
`session.on('reconnect'|'restore')` + `restoreSource`. CLI: `montydyn repl` with history, multi-line cells,
`.reset/.stdlib/.gen`, per-cell persistence indicator.
**Deploy target:** npm package (not a worker). Tested against deployed v0.8 first, then V1.x preview.
**Success gate:** round-trips every op against the live kernel; survives a forced WS 1006 mid-eval without
losing committed state and without duplicate eval; documents the bare-async-IIFE `{}` preview race; types
compile clean in both ESM and CJS consumers.

### Brief 2B — Notebook UI
**What to build:** framework-light SPA (CodeMirror editor + vanilla/Preact) on the SDK Session. Ordered
cells (source + output), render `valuePreview` / `logs[]` (level-colored) / `error`. Per-cell persistence
badge from the eval reply (restoreSource warm=green / rehydrated=amber, checkpoint.store sqlite|r2, sizeGz,
gen+cell). Session hibernated/awake from `gen().inMemory`. Affordances: run (shift-enter), run-all,
reset-session, typed-error display with socket alive (no full-page reload). Config panel 1:1 with the typed
config; modules picker sourced from `stdlib().available/.defaults/.optIn`. Token entered once, held in
memory/sessionStorage.
**Deploy target:** static asset on the worker or a separate Pages project.
**Success gate:** a full notebook session (multi-cell, reset, error recovery, hibernate→wake) works end to
end against a V1.x preview, with correct persistence indicators driven only by reply fields.

### Brief 2C — Supervisor auth + metering
**What to build:** hash API keys (SHA-256) in supervisor SQLite tenant/session registry; key format
`mdyn_<keyid>_<secret>`, verify by keyid lookup + constant-time compare; multiple active keys + revocation +
optional expiry. Per-key scopes (eval / session:create / session:reset / admin), optional per-key
fetch-allowlist override + resource ceilings. Short-lived scoped browser tokens (subprotocol; avoid
query-string token leakage). Auth runs BEFORE `ctx.facets.get(sessionName)`; scope session names to
`<tenant>/<session>` to ride facet storage isolation; reject unauth/over-quota at connect with a typed close
code. Metering: extend the AE emit() seam (v0.8 lib.rs ~:255 write_ae) with a `tenant` (+ `apiKeyId`)
dimension — tenant likely becomes the single index/partition key (note: changes existing dashboards; AE
index ≤96 bytes, blobs ≤5120 bytes). Bill on CPU-ms (sum totalServerMs), eval-count, stored-snapshot
GiB-hours (sizeGz gauge), and warm-seconds (supervisor owns wake/evict timestamps — facets can't alarm).
Per-tenant monthly quotas with soft-throttle (429-equivalent typed close); supervisor SQLite as the
fast-path counter, AE as source of truth; periodic supervisor-alarm aggregation → Stripe metered usage.
**Deploy target:** the V1.0 SupervisorDO (after it lands) — never the parallel build mid-flight.
**Success gate:** unauthorized/over-quota connects rejected with typed close; two tenants are
storage-isolated by name scoping; AE datapoints carry tenant and aggregate per-tenant; a Stripe test push
reconciles against AE within tolerance; document totalServerMs is wall-not-true-CPU (workerd freezes the
clock during sync execution) — do not market as exact CPU metering.

### Brief 3 — Agent code-mode adapter
**What to build:** define the tool catalog schema `[{name, description, paramsSchema, handlerId}]`; extend
`normalizeConfig`/`buildToolRegistry` (glue.js ~:721/755) to carry it (the existing `host.*` Proxy →
`__hostCall` boundary dispatches it with zero kernel changes). Write a type-generator emitting a
`declare const host {...}` TS block from the catalog, injected into the model's SYSTEM PROMPT (not the VM) —
this is the biggest quality lever. Write the agent-loop adapter exposing ONE tool `run_js(src)` → kernel
`evalCode` → re-serialize `{ok,value,valuePreview,logs,error}` into a model tool-result (logs[] = primary
observation channel, valuePreview = return value, error = recoverable retry). Bind one durable facet per
agent session via `ctx.facets.get(sessionId)` so heap/vars/closures persist across turns. Host the dispatcher
on the SUPERVISOR / a gateway service binding (fan out to MCP/Agents-SDK tools); set facet `globalOutbound:null`
so the tool catalog is the complete egress surface. Async tools follow the `__hostFetch` deferred-promise +
eval-pump pattern and must NOT touch ctx.entropy.
**Deploy target:** the V1.1 facet kernel + V1.0 supervisor (auth from 2C).
**Success gate:** multi-turn state persists across a facet abort (turn 1 `const results=[]`, turn 2 push,
turn 3 summarize); all four kernel guards surface as readable recoverable tool-errors (socket alive);
prompt instructs the model to log observations (avoids the bare-async-preview race); validates against
repl-env-surface.md §7 invariants (determinism, fetch-adds-0-entropy, loop/alloc preemption, kv survives
restore).

### Brief 4a — Native-arg pre-flight (fold into V1.1)
**What to build:** `NativeAllocLimitError` (subclass alongside MemoryLimitError) thrown at the
structuredClone / Headers / URL / TextEncoder.encode / crypto.subtle.digest / future host.fetch-body BOUNDARY
in glue.js BEFORE the C allocation, when `estimate > (MAX_DUMP_BUFFER_BYTES 18MB − currentBuffer.byteLength −
~2MB margin)`. Cheap bounded size estimate (cap structuredClone node walk; typed-array byteLength is known
up-front). Honest caveat: the workerd wall-clock budget (1b) is INERT for synchronous native code (frozen
clock) — do not treat it as coverage; the clean structural fix (1c JS_SetMemoryLimit/JS_SetMallocLimit) ships
with the next engine rebuild and needs 4c migration to land alongside it.
**Deploy target:** V1.1 facet kernel.
**Success gate:** v0.8 case 2b (structuredClone of a 100k-element array) clean-rejects with the socket alive
instead of WS-1006; estimator itself is bounded (not a DoS) and does not false-trip legitimate calls.

### Brief 4b — CI/CD + worktree workflow
**What to build:** GitHub Actions: (i) build via the wrangler `build.command` chain on PR; (ii)
`wrangler check startup` to assert startup_time_ms under the 1s budget; (iii) deploy a per-PR preview worker
(`montydyn-pr-<n>`) on a dedicated R2 namespace + run smoke-v08 / smoke-v07-guards / tripwire-gate / smoke-stdlib
+ a NEW determinism byte-vector fixture (seeded getRandomValues/Math.random/Date.now, byte-identical across
evict+restore); (iv) on merge, deploy the versioned prod worker; (v) preview-first ALWAYS — never auto-touch
live `montydyn-*` without an explicit gated job. Adopt one-worktree-per-agent git workflow (`git worktree add`
under a sibling dir, always `git -C <abs>`, branch+PR only, per-worktree R2 namespace + preview name, stale
`index.lock` reaper).
**Deploy target:** repo CI + preview workers only.
**Success gate:** a PR triggers build + startup-budget + preview smoke + determinism fixture; two parallel
agents on separate worktrees never collide on `.git/index.lock`; prod deploy only fires on merge behind the gate.

---

## 3. Decision Forks — Product vs Robustness vs Python-Breadth

Three places where finite build capacity must choose a direction.

**Fork A — Ship the product surface now, or harden the kernel first?**
- Product (SDK + UI + auth/metering) is unblocked TODAY against the stable protocol and is the only
  revenue-enabling work. Robustness (4a/4c/1c) closes real but RARE/recoverable gaps (the last WS-1006 is a
  single edge case that recovers on reconnect; engine migration only bites on an upgrade boundary).
- **Recommendation: do both in parallel, but lead with the SDK.** Fold the one cheap, no-rebuild robustness
  win (4a) into V1.1 so the kernel is clean, then build product. Defer the engine-rebuild robustness (1c +
  its mandatory 4c migration) until there is a concrete reason to bump the engine — don't pay the
  "invalidate all snapshots" cost speculatively.

**Fork B — Product polish (UI) vs the agent code-mode differentiator?**
- The UI is table-stakes demo surface; agent code-mode (durable stateful agent sandbox) is the genuinely
  differentiated story vs Cloudflare's ephemeral Code Mode and E2B's wall-clock sandboxes.
- **Recommendation: SDK → auth/metering → agent code-mode FIRST, UI as a fast-follow.** The agent path is the
  defensible wedge (durability + free hibernation + deterministic replay) and reuses primitives that already
  exist in glue.js. The UI is a thin SDK consumer that can ship right after and doubles as the agent demo.

**Fork C — Python breadth, or deepen the JS/Node-ISH surface?**
- The VM is a Node-ISH QuickJS shim today (no real fs/net/threads). Real Python is a SEPARATE runtime track
  (a Python-on-WASM engine with its own snapshot story), not an extension of the current kernel — large,
  speculative, and currently demand-unvalidated.
- **Recommendation: deepen JS/Node breadth, defer Python until demand is proven.** Near-term breadth = richer
  host-tool tiers (the agent dispatcher already makes this cheap) + opt-in stdlib/extension tiers within the
  500KB cap. Treat Python as a Phase 5+ exploratory spike gated on real customer pull, NOT a roadmap commitment.

**Net recommendation:** the spine is **V1.1 parity (+4a) → SDK → auth/metering → agent code-mode**, with the
UI and CI as fast-follows and engine-level robustness (1c+4c) scheduled to the first real engine bump.
Python stays a parked option.

---

## 4. Running Open Risks to Carry

- **Facet WebSocket hibernation unproven end-to-end** (v1-direction §4.1, highest gating unknown). The WARM-2
  WS-auto-response heartbeat AND the agent per-facet WS depend on it. Fallback if broken:
  supervisor-holds-WS-and-proxies (works fine for the request/response agent loop) or supervisor-driven RPC
  pings. De-risk with a minimal facet that accepts → hibernates → wakes a socket before committing.
- **`{wasm}` Worker-Loader module type is UNDOCUMENTED** (proven live, but no platform contract; coldstart
  research even documents it incorrectly). Guard with the engine-hash gate + an instantiate smoke check at
  facet boot. Treat as a platform-stability risk.
- **Loader `codeId` cache foot-gun** — a stale codeId silently reuses old facet code across glue/engine/ext/
  bundle changes. Tie codeId to a build hash; bump on any byte change.
- **Snapshot OOM cliff at ~24–30MB raw heap** sits BELOW the 18MB dump ceiling guard; a heavy injected stdlib +
  large in-VM allocation could still approach it. The 500KB source cap is the primary defense — verify after
  V1.1 that mathjs+others combined still clean-reject.
- **Oversized native-C single-alloc (structuredClone)** can outrun the bytecode tripwire and WS-1006 the facet
  socket (recovers on reconnect, committed state safe). 4a (NativeAllocLimitError) is the near-term fix; 1c
  (malloc-limit) is the structural fix on the next engine rebuild.
- **Supervisor is single-threaded** (~1k req/s, 30s CPU/invocation) — keep-warm sweeps serialize here. Shard
  tenants across many supervisors and cap warmed-session count per supervisor (Phase 5 scale work).
- **Engine upgrade strands every live snapshot** until the 4c migration journal + replay path exists. Any
  engine-hash bump (including 1c) MUST land with 4c, and replay re-fires effects — safe only for deterministic
  seeded sessions, opt-in (`migrationAllowed`) for fetch/effectful ones.
- **Async-cell value-preview race** — a bare top-level await / async-IIFE return previews as `{}`. SDK and the
  agent type-gen prompt must steer callers to `console.log` observations and assign-then-read in a follow-up
  cell.
- **totalServerMs is wall-time, not true CPU-time** (workerd freezes the clock during sync execution) — CPU-ms
  billing is an approximation; document it, do not market as exact metering.
- **AE index/blob caps** (≤1 index / 96 bytes, blobs ≤5120 bytes) — adding the tenant dimension must fit;
  tenant likely replaces/joins doId as the partition key, changing existing dashboards.
- **R2 stale-key accumulation** (not cost — cost is negligible, overflow-only/SQLite-first) is the real risk;
  the 4d prune job needs a USER-minted scoped R2 S3 token (external blocker) and must dry-run + cross-check a
  live manifest before deleting, never pruning the current version namespace.
- **Warm-predict heuristics are unvalidated** — aggressive warm horizon raises idle billing, conservative
  re-exposes the ~1.5s deep tail. Tune EWMA*K against observed AE cadence once there is real traffic.
