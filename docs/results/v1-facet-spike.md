# V1 Facet Spike — montydyn kernel as a DO facet under a supervisor

**Branch:** `spike/v1-facets`. **Built under:** `v1-facet/`. **Deployed worker:** `montydyn-facet`
(`https://montydyn-facet.umg-bhalla88.workers.dev`), version `1addc0e5`. Workers PAID.
**Date:** 2026-06-01.

**Verdict: WORKS — decisively.** The full ADR-0003 chain is proven live, all five steps,
including the real QuickJS kernel running as a facet with heap-snapshot into the facet's OWN
isolated SQLite and cold-restore across a facet eviction. The one feared blocker (WASM into a
facet) is **resolved and NOT a blocker** — there is an undocumented `{wasm}` Worker-Loader
module type that delivers a pre-compiled `WebAssembly.Module` (CompiledWasm) into the facet.
Two real platform limitations were found (facets **cannot set alarms**; raw-bytes runtime
`WebAssembly.compile` is blocked) — neither blocks the kernel, but the alarm gap shapes the
V1 idle/TTL design.

---

## What works (proven live, in order)

| # | Claim | Result | Evidence (HTTP route) |
|---|-------|--------|------------------------|
| 1 | Supervisor DO + `worker_loaders` binding deploys | **PASS** | `wrangler deploy` → bindings show `env.LOADER (Worker Loader)` + `env.SUPERVISOR (SupervisorDO)` |
| 2 | A trivial DO class loaded via `LOADER.getDurableObjectClass` runs as a facet via `ctx.facets.get`; facet has its OWN `ctx.storage.sql` | **PASS** | `/step2/bump` → counter persists in facet's own db |
| 2 | Facet CANNOT read a secret the supervisor stored in its own db | **PASS** | `/step2/isolation` → `{facetSeesSupervisorSecret:null, supervisorSeesOwnSecret:"TOP-SECRET-42", isolated:true}` |
| 3 | Two facets under one supervisor have independent storage | **PASS** | `/step3/independent` → `{aSees:"A-value", bSees:"B-value", independent:true, aCounter:1, bCounter:2, countersIndependent:true}` |
| 4 | Instantiate QuickJS-grade WASM inside a facet | **PASS via `{wasm}`** | `/step4/wasm` (see WASM section) |
| 5 | QuickJS kernel facet: eval cells (stateful) | **PASS** | `/step5/eval` → `x=1`→`1`, again→`2` (`restoreSource:warm`) |
| 5 | Snapshot kernel heap into the FACET's own SQLite | **PASS** | `/step5/snapshot` → `{sizeRaw:1245212, sizeGz:99790}` stored in facet db |
| 5 | Cold-restore across a facet eviction (no replay) | **PASS** | clean run: set `z=99` → snapshot → `/step5/evict` (`ctx.facets.abort`) → read `z` → `{value:"99", restoreSource:"cold-restore"}` |
| 5 | Per-tenant kernel isolation | **PASS** | new tenant `k2`: `typeof x` → `"undefined"` (fresh heap) |

The kernel facet uses the **real v0.2 engine** (`quickjs.wasm`, 1.6 MB) driven by the real
**quickjs-wasi 3.0.0** dist (shipped as `{js}` modules), `QuickJS.create` / `evalCode` /
`snapshot` / `serializeSnapshot` / `deserializeSnapshot` / `restore` — the same snapshot
mechanism as ADR-0002, now landing in the facet's SQLite.

---

## THE WASM QUESTION (the key unknown) — RESOLVED

The brief's worry: Worker Loader's documented `modules` map has no CompiledWasm type, only
`{data: ArrayBuffer}`, so the facet would have to `WebAssembly.compile(bytes)` at runtime —
which workerd forbids. **Both halves tested empirically inside a facet** (`/step4/wasm`):

```
dataModule:    { data_isArrayBuffer:true, data_byteLength:41,
                 wasm_type:"[object WebAssembly.Module]", wasm_isModule:true }
compiledImport (instantiate the {wasm} import):  { ok:true, add_40_2:42 }   ← WORKS
compile     (WebAssembly.compile of raw bytes):  { ok:false,
   error:"CompileError: WebAssembly.compile(): Wasm code generation disallowed by embedder" }
instantiate (WebAssembly.instantiate of bytes):  { ok:false, ... disallowed by embedder }
syncModule  (new WebAssembly.Module(bytes)):     { ok:false, ... disallowed by embedder }
```

**Findings:**
1. **Runtime compilation of raw bytes is BLOCKED inside a facet** — `WebAssembly.compile`,
   `WebAssembly.instantiate(bytes,…)`, and `new WebAssembly.Module(bytes)` all throw
   *"Wasm code generation disallowed by embedder"*, exactly as in ordinary Workers. So the
   `{data: ArrayBuffer}` → runtime-compile path the brief feared **is** blocked. quickjs-wasi's
   `resolveModule()` fallback (`WebAssembly.compile(bytes)`) would fail here.
2. **But there is an UNDOCUMENTED `{wasm}` module type.** Passing a bare `ArrayBuffer` value
   in the loader `modules` map is rejected with a TypeError that **lists the valid types**:
   `'js', 'cjs', 'text', 'data', 'json', 'py', or 'wasm'`. Shipping the binary as
   `{wasm: ArrayBuffer}` makes the facet `import` arrive as a **pre-compiled
   `WebAssembly.Module`** (CompiledWasm). `WebAssembly.instantiate(module, imports)` on it
   **works** — the platform compiled it at load time, not at runtime.
3. Therefore the v0.2 kernel runs as a facet with a **tiny adaptation, not a rewrite**: replace
   the `entry.mjs` `import quickjs.wasm` (bundler CompiledWasm) with a `{wasm}` Worker-Loader
   module and feed the resulting `WebAssembly.Module` to `QuickJS.create({wasm: module})`.
   quickjs-wasi already accepts a `WebAssembly.Module` directly (its `resolveModule()` returns
   it as-is) — proven: `/step5/*` runs the real engine this way.

---

## Facet platform limits (undocumented → tested empirically, `/probe/features`)

```
ws:      { hasAcceptWebSocket:true, hasGetWebSockets:true, hasSetWebSocketAutoResponse:true }
nesting: { hasFacets:true }
alarm:   { setAlarm:false, threw:"Facets currently cannot set alarms." }
```

- **Alarms: NOT SUPPORTED in a facet.** `this.ctx.storage.setAlarm()` throws
  *"Facets currently cannot set alarms."* This is a hard, current platform limitation and the
  single most important constraint for V1 design (see Architecture).
- **WebSocket hibernation API: PRESENT on a facet** — `acceptWebSocket`, `getWebSockets`,
  `setWebSocketAutoResponse` all exist on the facet's `ctx`. (Surface verified; a full
  end-to-end hibernate/wake of a facet-held socket was not exercised in this spike.)
- **Nesting: `ctx.facets.get` exists on a facet** (a facet could in principle create its own
  facets). Depth/limits untested.
- Facet count: docs say "any number of facets (subject to storage limits)"; not stress-tested.
- Aborting a facet (`ctx.facets.abort`) preserves its SQLite — proven by step 5 (restore after
  abort succeeded from the facet's own db). `ctx.facets.delete` wipes it (not exercised).

---

## Recommended V1 architecture (supervisor + per-session kernel facet)

**Adopt facets for V1 multi-tenant packaging — the spike clears ADR-0003.** Shape:

- **Supervisor DO** (SQLite-backed, `new_sqlite_classes`, `worker_loaders` binding): owns
  auth / metering / billing / kill-switch / tenant→facet routing. Holds NO kernel heap. Stores
  its control state in its own (isolated) SQLite. A facet provably cannot read it.
- **Per-session kernel facet:** one named facet per session/tenant
  (`ctx.facets.get(sessionId, …)`), each with its own isolated SQLite. The ADR-0002 heap
  snapshot (gz'd QuickJS linear memory + globals, chunked) lands in **that facet's** SQLite —
  exactly as the flat v0.2 DO does today, just inside the facet. Cold-restore across eviction
  works (proven).
- **Per-tenant / versioned kernel code via Worker Loader:** load the kernel class with
  `env.LOADER.get(codeId, …)`, `codeId` keyed by engine/glue version (hot-swap via
  `ctx.facets.abort` + re-`get` with a new class — the documented code-update path). Ship
  `quickjs.wasm` as a **`{wasm}` module** and quickjs-wasi as `{js}` modules.
- **Sandboxing:** `globalOutbound: null` blocks all egress from the dynamically-loaded kernel
  (used throughout this spike); the supervisor can instead pass a gateway service binding to
  mediate/allow-list fetch (this is also the clean home for the still-open P3 fetch egress).

### Changes needed to the kernel to run as a facet
1. **WASM delivery:** replace `entry.mjs`'s bundler CompiledWasm import with a `{wasm}`
   Worker-Loader module; pass the `WebAssembly.Module` to `QuickJS.create({wasm})`. (~no logic
   change; the engine-hash guard still applies — hash the bytes before base64.)
2. **Language of the facet class:** the spike wrote the facet as a **JS `DurableObject`**
   (the facet/loader API is JS-native and the dynamic class is supplied as a JS string). The
   v0.2 kernel is a Rust DO shell + JS glue. For V1 either (a) port the thin Rust shell logic
   (mutex, checkpoint commit-ordering, manifest SQL) into the JS facet class — straightforward,
   it is ~700 lines of orchestration — or (b) keep glue.js largely as-is and wrap it in a JS DO
   class. Recommendation: **(a)** — a pure-JS facet class is simplest to ship as loader modules
   and removes the wasm-bindgen/worker-build step from the dynamic path.
3. **Idle/TTL without facet alarms (IMPORTANT):** facets cannot `setAlarm`. So a facet cannot
   self-schedule its own idle eviction / TTL sweep. **Put the alarm on the SUPERVISOR** (a
   normal DO — alarms work there) and have the supervisor drive lifecycle: TTL sweeps,
   archival, forced `abort` of idle facets. The kernel's durability does not depend on alarms
   (snapshot is per-cell synchronous), so this is a scheduling concern only, but it MUST live in
   the supervisor.
4. **Snapshot store:** keep SQLite-first (proven: 1.24 MB raw → 97 KB gz stored in the facet
   db). R2 overflow still available (the spike kept the `SNAPSHOTS` binding; namespace keys
   `v1facet/<tenant>/…` if used).

### Open items deferred (not blockers)
- End-to-end facet **WebSocket hibernate/wake** (API present; not exercised). The current
  v0.2 protocol is WS-based; V1 could keep WS on the supervisor and RPC to the facet, or accept
  the socket on the facet. Validate hibernation of a facet-held socket before depending on it.
- Facet **count / storage / eviction** semantics at scale (cost of many facets + a heap
  snapshot each) — unmeasured.
- The v0.2 **P1 tick-budget** and **P0 used-heap guards** carry over unchanged (they are inside
  glue.js, orthogonal to facets).

---

## How to reproduce

```sh
cd v1-facet
npm run bake                 # bakes facet sources + quickjs.wasm(+wasi dist) into src/modules.gen.js
set -a; . ../.env; set +a
npx wrangler@^4 deploy        # deploys montydyn-facet
B=https://montydyn-facet.<account>.workers.dev
curl -s "$B/step2/isolation?id=t1"     # facet/supervisor SQLite isolation
curl -s "$B/step3/independent?id=t1"   # two facets, independent storage
curl -s "$B/step4/wasm?id=t1"          # WASM-in-facet ({wasm} works, raw compile blocked)
curl -s "$B/step5/eval?id=k1"          # kernel facet eval (stateful)
curl -s "$B/step5/snapshot?id=k1"      # heap snapshot → facet's own SQLite
# cold-restore (deterministic recipe — the combined /step5/restore route hardcodes eval("x")):
curl -s "$B/step5/eval?id=k1&src=globalThis.z=99;z"   # → 99 (fresh)
curl -s "$B/step5/snapshot?id=k1"                     # heap → facet SQLite
curl -s "$B/step5/evict?id=k1"                        # ctx.facets.abort
curl -s "$B/step5/eval?id=k1&src=z"                   # → 99, restoreSource:"cold-restore"
curl -s "$B/probe/features?id=p2"      # alarms (NO) / websockets / nesting
```

## Layout (`v1-facet/`)
```
wrangler.jsonc            montydyn-facet: SupervisorDO (new_sqlite_classes) + worker_loaders + R2
src/supervisor.js         supervisor Worker + SupervisorDO; loads facets, drives all proof routes
src/facet-counter.js      trivial dynamic DO class (steps 2-3) + alarm/ws/nesting probes
src/facet-wasmprobe.js    WASM-in-facet probes ({wasm} vs {data} vs runtime compile)
src/facet-kernel.js       REAL QuickJS kernel as a facet (step 5): eval + snapshot→own SQLite + restore
src/tiny.wasm             41-byte hand-built add(i32,i32) module (wasm probe)
src/quickjs.wasm          v0.2 engine (copied), shipped to the kernel facet as a {wasm} module
scripts/bake-modules.mjs  bakes facet sources + wasm(base64) + quickjs-wasi dist into modules.gen.js
```
