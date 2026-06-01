# montydyn V1 Direction — P3 + V1 Facet Spike Convergence

Converged results from two parallel tracks: **P3** (real fetch egress + allowlist + error-as-value preview, built on v0.3) and the **V1 facet spike** (ADR-0003: supervisor DO + kernel-as-facet). Both verdicts below are from independent live verification, not self-report.

---

## 1. P3 Status — DONE & VERIFIED, MERGEABLE

All three P3 items are implemented, deployed, and independently verified live against `https://montydyn-v03.umg-bhalla88.workers.dev`. Branch `feat/p3`.

| Item | Status | Evidence |
|---|---|---|
| Real outbound fetch egress | DONE | `host.fetch(url, init)` does a real DO-side `fetch()` → `{status, ok, headers, body}`. Live: allowed host returned a real 200 with body (~200ms). |
| Fetch allowlist enforcement | DONE | `config.fetch`: `false` blocks all, `true` allows all, `[hosts]` restricts by hostname. Off-list / disabled → typed `FetchBlockedError`, socket alive, kernel usable next cell. |
| Error-as-value preview | DONE | Returned `Error` → `valueType:"error"`, structured `value:{name,message,stack}`, `valuePreview` with name+message+short stack. |

**Verification:** 5/5 verifier cases PASS, independently over WebSocket. P3 smoke 16/16 PASS; inherited V0.2 suite 52/52 PASS (zero regression). Determinism preserved across fetch (fetch adds 0 entropy calls; two fresh seeded kernels byte-identical). Regression cases confirmed: eval→evict→`sqlite-restore` survives, `while(true)` trips typed `TimeoutError` with socket alive (no WS-1006/DO kill), seeded determinism identical across restore.

**Implementation notes that matter for V1:**
- `eval` is now **ASYNC** (`EvalFlags.ASYNC` + a host-side fetch pump). quickjs-wasi host callbacks are synchronous, so fetch is bridged via `vm.newPromise()` deferred + a pump in `evalCode` that drains `__cellP` until `promiseState` settles. Reading the ASYNC eval handle pre-drain races and returns empty.
- Deadlock pitfall (fixed): pending-fetch entry must await only the fetch work (which calls `deferred.resolve`), **not** `deferred.settled` (that only fires after the next `executePendingJobs`, which the pump runs after the await).
- `lib.rs` `eval_code` binding is now `Promise<String>`; `eval_critical` awaits it with no `RefCell` borrow held across the await.
- Response body capped at 2MB text, ≤64 headers; binary bodies returned as text.
- `v0.3/src/quickjs.wasm` had to be force-added (global gitignore excludes `*.wasm`).

**Mergeable?** Yes. v0/v0.1/v0.2 and their workers are untouched; R2 keys namespaced `v03/`. No regression in the inherited suite. The only operational caveat is cosmetic and not in the kernel: public test endpoints (httpbin, api.github.com) intermittently rate-limit unauthenticated DO traffic, so an on-list fetch may surface a real non-200 — the kernel correctly passes through whatever upstream returns. CASE 1 already proves a clean 200+body.

---

## 2. Facet Spike Verdict — WORKS, the full ADR-0003 chain reached live

Branch `spike/v1-facets`, worker `https://montydyn-facet.umg-bhalla88.workers.dev`. All 5 steps proven and independently re-verified live (no rebuild). **The feared WASM blocker is resolved and is NOT a blocker.**

| Step | Result |
|---|---|
| 1. Supervisor DO + `worker_loaders` binding deploys | PASS (`new_sqlite_classes`, version verified) |
| 2. DO class loaded via `LOADER.getDurableObjectClass`, run as facet via `ctx.facets.get`; facet has OWN isolated SQLite | PASS — `facetSeesSupervisorSecret:null` while supervisor sees `TOP-SECRET-42` (`isolated:true`) |
| 3. Two facets under one supervisor, independent storage | PASS — `aSees:"A-value"`, `bSees:"B-value"`, distinct counters (verified on fresh supervisor id) |
| 4. WASM in a facet | PASS via `{wasm}` module type → `add(40,2)=42` |
| 5. REAL v0.2 quickjs kernel as a facet: stateful eval, heap-snapshot into facet's own SQLite, cold-restore across `ctx.facets.abort` | PASS — `z=99` survives eviction, `restoreSource:"cold-restore"`, no replay; snapshot 1.24MB raw / ~97KB gz |

**Kernel-as-facet feasibility, point by point:**

- **WASM-from-data: PARTIAL — blocked path identified, working path proven.**
  - **EXACT BLOCKER:** runtime compilation of raw bytes inside a facet is blocked: `WebAssembly.compile`, `WebAssembly.instantiate(bytes)`, and `new WebAssembly.Module(bytes)` all throw **`"Wasm code generation disallowed by embedder"`**. So the `{data:ArrayBuffer}` → runtime-compile path the brief worried about IS blocked.
  - **WORKING PATH:** an (undocumented, revealed by the loader's own TypeError listing `js/cjs/text/data/json/py/wasm`) `{wasm:ArrayBuffer}` Worker-Loader module type delivers a **pre-compiled `WebAssembly.Module` (CompiledWasm)** that instantiates fine. Verified: `dataModule.wasm_isModule:true`, `compiledImport.add_40_2:42`. The kernel needs only a **WASM-delivery tweak** (ship `quickjs.wasm` as `{wasm}`, hand the Module to QuickJS), **not a rewrite**.

- **Snapshot-in-facet-SQLite: FEASIBLE — proven.** Facet has its own `ctx.storage.sql`; heap snapshot written into the facet's SQLite and cold-restored across a genuine `ctx.facets.abort` eviction. Per-cell synchronous snapshot means kernel durability does not depend on alarms.

- **Facet hibernation: API-PRESENT ONLY — not exercised.** `acceptWebSocket` / `getWebSockets` / `setWebSocketAutoResponse` exist on facets and facet nesting (`ctx.facets.get` on a facet) is present, but end-to-end WS hibernate/wake of a facet-held socket was NOT tested. Treat as an open V1 risk, not a proven capability.

- **Second confirmed blocker — facets cannot set alarms.** `ctx.storage.setAlarm` inside a facet throws **`"Facets currently cannot set alarms."`** TTL/idle/eviction scheduling MUST live on the supervisor DO (a normal DO where alarms work). Kernel durability is unaffected (synchronous per-cell snapshot).

**Honest caveats from verification:**
1. Per-tenant kernel isolation in the spike is at the **supervisor-id level** (each `?id=` is a separate SupervisorDO); the kernel facet name is hardcoded `kerneltenant`, so two *differently-named* kernel facets coexisting under one supervisor was not demonstrated. The storage-isolation primitive V1 relies on IS proven (step 3 = two distinct facets under one supervisor).
2. `countersIndependent` is a brittle equality check (two values coincidentally equal once); confirmed clean on a fresh supervisor id — verify with distinct values, not the flag.
3. The spike's facet classes are pure-JS DurableObjects; the v0.2 kernel is a Rust DO shell + JS glue. V1 must port/wrap that orchestration (see §3).

---

## 3. Recommended V1 Architecture — Supervisor DO + per-session kernel facets

```
Worker entry
  └─ SupervisorDO (normal DurableObject, SQLite-backed)
       ├─ worker_loaders binding (LOADER)
       ├─ alarms: idle/TTL/eviction scheduling   ← MUST be here (facets can't set alarms)
       ├─ routing: WS connect / RPC → resolve session → ctx.facets.get(<sessionName>)
       ├─ supervisor SQLite: session registry, manifest index, tenant→facet map
       └─ per-session Kernel Facets (ctx.facets.get, isolated SQLite each)
            ├─ quickjs.wasm shipped as a {wasm} Worker-Loader module (CompiledWasm)
            ├─ glue.js orchestration ported into a JS DO class
            ├─ own ctx.storage.sql: heap snapshot + manifest (clock/RNG counters, gen)
            └─ per-cell synchronous snapshot → cold-restore across ctx.facets.abort
```

**Concrete component list:**
1. **SupervisorDO** — normal DO, `new_sqlite_classes`, binds `worker_loaders` (`LOADER`). Owns: alarms (idle/TTL/eviction), session→facet routing, WS accept + dispatch, R2 large-object offload, manifest index.
2. **Worker Loader module set** — `quickjs.wasm` delivered as `{wasm: ArrayBuffer}` (NOT `{data}`); glue JS as `js`. Remember the loader caches by `codeId` — bump `codeId` when kernel source changes or the old isolate is reused.
3. **KernelFacet (JS DO class)** — the ported v0.2 shell: mutex / single-flight per cell, checkpoint commit-ordering, manifest SQL, heap snapshot/restore, the P3 ASYNC eval + fetch pump, allowlist enforcement, error-as-value preview. Runs via `ctx.facets.get(sessionName)`, gets its own `ctx.storage.sql`.
4. **Snapshot/restore layer** — heap snapshot (1.24MB raw / ~97KB gz) into facet SQLite; large blobs may spill to R2 keyed by session/gen. Restore is cold (no replay), driven by manifest (gen + clock/RNG counters carried in snapshot, as proven in v0.2/P3).
5. **Egress layer (from P3)** — `host.fetch` with `config.fetch` allowlist; runs inside the facet, 0 entropy impact, determinism preserved.

**What must change in the kernel to run as a facet:**
- **WASM delivery:** stop runtime-compiling raw bytes (blocked in facets). Ship `quickjs.wasm` via the `{wasm}` module type and feed the resulting pre-compiled `WebAssembly.Module` to `QuickJS.create` / the instantiate path. This is the single decisive change. (`{data}` → runtime-compile is dead in facets.)
- **DO shell port:** move the ~700 lines of Rust DO-shell orchestration (mutex, checkpoint commit-ordering, manifest SQL) into a **JS facet DO class** — or wrap `glue.js` in a JS DO class. Facets in this model are JS DOs, not Rust.
- **Move all scheduling to the supervisor:** any `setAlarm` the kernel does today must be relocated to SupervisorDO (facet `setAlarm` throws). Kernel keeps per-cell synchronous snapshot for durability; supervisor's alarm drives idle eviction / TTL.
- **Async eval is already in place (P3):** keep `EvalFlags.ASYNC` + the fetch pump + `Promise<String>` eval binding; carry the deadlock fix (await fetch work, not `deferred.settled`).
- **Module map hygiene:** never pass a bare `ArrayBuffer` in the loader modules map — it's rejected; always a typed descriptor (`{wasm:...}`, `{data:...}`, or a bare string for `js`).

---

## 4. Risks / Unknowns still open for V1

1. **Facet WebSocket hibernation is unproven end-to-end.** API is present; hibernate/wake of a facet-held socket was never exercised. If WS hibernation on facets is incomplete, the per-session WS model needs a fallback (e.g. supervisor holds the socket and proxies to the facet). **High priority to de-risk.**
2. **Facet count / storage / eviction at scale.** Not measured: how many kernel facets one supervisor can hold, storage ceilings, `ctx.facets.delete` behavior (not exercised). Eviction cost and snapshot churn under many concurrent sessions unknown.
3. **`{wasm}` module type is undocumented.** It works today (revealed only by an internal TypeError list). Risk of being unstable/changed by the platform. No documented contract.
4. **Multiple differently-named kernel facets under one supervisor** not demonstrated (spike hardcoded `kerneltenant`). The storage primitive is proven, but the exact per-session naming/lifecycle path needs a real implementation.
5. **Cold-start / RPC timeout.** P3 already saw first WS connect+create+fetch exceed a tight RPC timeout on a brand-new version; supervisor + facet load adds isolate cold-start latency. Needs a warmup path or generous first-call budget.
6. **Snapshot size growth in facet SQLite.** 1.24MB raw per snapshot; with many sessions and frequent cells, facet SQLite growth + gz cost + R2 offload policy is unvalidated.
7. **Loader `codeId` caching foot-gun.** Changing dynamic facet source without bumping `codeId` silently reuses the old isolate — needs a disciplined codeId/version scheme in the build.

---

## 5. Next Steps (ordered)

1. **Merge P3** (`feat/p3`) — verified, no regression, mergeable today. Carries the ASYNC eval + fetch pump that V1 depends on.
2. **De-risk facet WS hibernation** — build a minimal facet that accepts a WS, hibernates, and wakes end-to-end. This is the single biggest unknown gating the per-session model. If broken, design the supervisor-proxies-WS fallback now.
3. **Port the kernel DO shell to a JS facet class** — move the Rust shell orchestration (mutex, checkpoint ordering, manifest SQL) + P3 egress/error-preview into a JS DO class loadable via Worker Loader.
4. **Switch WASM delivery to `{wasm}`** — ship `quickjs.wasm` as a CompiledWasm module and wire it into `QuickJS.create`. Validate full eval + snapshot + restore inside the JS kernel facet.
5. **Implement SupervisorDO routing + alarms** — session→facet map, WS accept/dispatch, idle/TTL/eviction alarms on the supervisor (since facets can't set alarms). Add a codeId/version scheme to avoid loader cache reuse.
6. **Prove multi-session isolation under one supervisor** — N differently-named kernel facets coexisting, independent heaps + storage, plus `ctx.facets.delete` lifecycle.
7. **Scale + cold-start validation** — facet count ceiling, snapshot/storage growth, R2 offload policy, and a warmup path for first-call RPC budget.

**Bottom line:** P3 is done and shippable. The V1 facet architecture is feasible — the only true blockers (raw-bytes WASM compilation, facet alarms) both have proven workarounds (`{wasm}` module type; alarms on the supervisor). The remaining gating unknown is facet WebSocket hibernation, which must be de-risked before committing to per-session kernel facets.
