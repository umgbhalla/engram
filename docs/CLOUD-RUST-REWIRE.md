# engram-cloud on the Rust kernel — FEASIBLE, proven live (no kernel rewrite)

**Headline:** The multi-tenant cloud supervisor can run the **Rust** kernel — the same live
`engram-kernel` Rust DO — as a per-session DO **facet**, with **no rewrite of the kernel into a
JS-shim + engine.wasm**. A scratch worker `engram-cloud-rust` proved the full path live:
per-tenant API-key auth, per-session Rust kernel facets with isolated SQLite, stateful multi-cell
eval, **genuine cold-restore across `ctx.facets.abort` (sqlite-restore, no replay)**, cross-tenant
+ cross-session isolation, stdlib injection, seeded determinism, all 5 Tier-0 extensions, and full
API-key lifecycle (mint → use → revoke → reject). The scratch worker has since been **deleted**;
this doc records the architecture, the prototype result, and the exact change-set + remaining
blockers to make it the production cloud.

## Why this was the open question

The JS cloud (`apps/cloud`, live `engram-cloud`) runs the **JS** kernel as a facet. The Rust
kernel (`engram-kernel`) is the more advanced, anchored line. Could the multi-tenant facet model
host the **Rust** kernel without rewriting it? Two facet-platform constraints made this non-obvious:

1. **Raw-bytes `WebAssembly.compile` is blocked inside a facet** ("Wasm code generation disallowed
   by embedder"). The Rust kernel ships **two** wasm modules (the wasm-bindgen DO + the rquickjs
   engine).
2. **Facet-held client WebSockets don't work** (v1-facet proof), and the Rust DO's protocol is
   WS-frame-only — it exposes no `evalCell`/`handleMessage` RPC.

## The architecture (the convergence)

The Rust kernel is a Rust DO compiled to `wasm32-unknown-unknown` via wasm-bindgen / worker-build
(`build/index.js` JS glue + `build/index_bg.wasm`) **plus** the rquickjs `engine.wasm`
(`wasm32-wasip1`). The decisive facts:

- The facet loader requires the DO **class as a JS module** — `build/index.js` **is** plain JS and
  exports `KernelDO`. ✅
- `index.js` instantiates **both** wasm via `new WebAssembly.Instance(Module, imports)` from a
  **precompiled `WebAssembly.Module`**, never from raw bytes. Instantiating a precompiled Module is
  **NOT** blocked in a facet (only raw-bytes `compile` is). ✅

So **both** wasm ship as `{wasm}` Worker-Loader modules — the same delivery insight from the
v1-facet spike, now applied to **two** modules:

- `index_bg.wasm` (the `import Dt from "./index_bg.wasm"` inside `index.js`).
- `engine.wasm` (read via the lazy `globalThis.__ENGINE_MODULE` getter).

A tiny generated `facet-rust.js` mainModule sets the 4 globals `index.js` reads
(`__ENGINE_MODULE`, `__ENGINE_HASH`, `__STDLIB_BUNDLE`, `__STDLIB_META`) from `{wasm}`/`{text}`/`{js}`
loader modules and re-exports `KernelDO`.

**Frame proxy (the WS workaround):** because facet-held client sockets don't work, the supervisor
holds the client WS and **RPCs each `{t:…}` frame** to the facet stub. This required **one small,
allowed kernel change** (see change-set).

```
client WS ──▶ SupervisorDO (engram-cloud-rust)
                 │  per-tenant API-key auth (SQLite, sha256 keys)
                 │  route → per-session facet kr:<tenant>:<session>
                 ▼
            LOADER.getDurableObjectClass(codeId)  ── modules: {wasm} index_bg.wasm,
                 │                                              {wasm} engine.wasm,
                 │                                              {text} stdlib, {js} facet-rust.js
                 ▼
            ctx.facets.get(name)  →  Rust KernelDO facet (own isolated SQLite)
                 │  supervisor RPCs POST /frame  {t:create|eval|gen|ping|reset|evict, …}
                 ▼
            Rust DO handle() dispatch → rquickjs eval → heap snapshot into facet SQLite
```

## What was built (in `experiments/cloud-rust` — `apps/cloud` untouched)

- Copied `apps/cloud` → `experiments/cloud-rust` (worker `engram-cloud-rust`).
- `scripts/bake-rust.mjs` — bakes the Rust kernel payload into `src/modules.rust.gen.js`
  (reads `apps/kernel-rust/build/{index.js,index_bg.wasm}` + `src/engine.wasm` + `engine-hash.js`).
  Sizes: `index.js`=48232B, `index_bg.wasm`=391324B, `engine.wasm`=732901B, stdlib=834887B.
- `src/supervisor-rust.js` — per-tenant API-key auth + per-session Rust kernel facet + isolated
  SQLite + codeId-versioned loader; `/frame` proxy; admin mint/revoke seams.
- `wrangler.jsonc` rewritten (name `engram-cloud-rust`, compat `2025-05-01`, mainModule
  `supervisor-rust.js`; bindings: `SUPERVISOR` DO, `SNAPSHOTS` R2 engram-snapshots, `AE`
  engram_kernel, `LOADER` worker_loaders).
- Deployed with **wrangler@4.97.0** (Worker Loader needs ≥4.86; the cloud's pinned 3.107.2 is too
  old — see gotcha).

### One small kernel change (allowed — `apps/kernel-rust` is live kernel source)

Added a **`POST /frame`** seam to the Rust DO `fetch()` in
`apps/kernel-rust/src/lib.rs` (~line 169): it parses a JSON `{t:…}` body, runs the **same**
`handle()` dispatch as the WS path, and returns the reply JSON. Rebuilt
(`worker-build --release`) — compiles clean. This is what lets the supervisor proxy frames via
`stub.fetch(POST /frame)`. (This seam is additive and harmless to the live WS path; it ships in the
kernel either way.)

## Prototype result (all LIVE before teardown)

`engram-cloud-rust` was deployed at `https://engram-cloud-rust.umg-bhalla88.workers.dev`
(`/health` ⇒ `kernel:rust`, `codeId:rustkernel-fec2447322ffc48d`,
`engineHash:rust-e307f9e70b190575209f942f992ef2f4`). Upload 2391.19 KiB / gzip 861.89 KiB
(under the 10MB cap), startup ~12ms, all 4 bindings resolved.

Verified end-to-end:
- **Auth:** missing/bogus key ⇒ 401; admin-minted per-tenant key (sha256-hashed in supervisor
  SQLite) ⇒ 200; resolves to tenant.
- **Facet create LIVE:** `POST /create` ⇒ `{ok:true, restoreSource:fresh, generation:1}` — both
  wasm instantiated inside the facet via `{wasm}`.
- **Stateful eval:** `x=41` → `x+1=42`; `counter=100` → `+5` → `105` across cells; closure `mk()`
  increments 3→4 across evals. Snapshot landed in the facet's **own** SQLite.
- **Cold-restore across `ctx.facets.abort`:** evict → re-eval ⇒ `restoreSource:sqlite-restore`,
  state intact (`x=41` / `counter=105` + closure state), generation bumped, **no replay** (blit
  into a fresh Rust DO + engine instance).
- **Isolation:** `globex:s1` and `acme:s2` both `typeof x == undefined` (fresh heaps) while
  `acme:s1` still holds `x=41`; sessions registry shows distinct facets `kr:<tenant>:<session>`.
  Cross-tenant + cross-session both isolated.
- **Stdlib + determinism:** `modules:[lodash]` ⇒ `typeof _ == object`; seeded `Math.random`
  (`rngSeed=42`) deterministic (`0.5682303266439076`).
- **Tier-0 in the Rust facet:** `crypto.randomUUID()` (len 36), `TextEncoder`, `URL.searchParams`,
  `structuredClone` all work.
- **Key lifecycle:** mint tenantA/B/C → use → `DELETE /admin/keys?tenantId=tenantC` ⇒ `revoked=1`
  → tenantC eval ⇒ 401 while tenantA still works (revoke scoped).

**Verdict: full Rust kernel parity, running as a multi-tenant facet.**

## Change-set to make it the production cloud

1. **Land the kernel `/frame` seam** in `apps/kernel-rust/src/lib.rs` (already prototyped; ships
   in `engram-kernel` regardless — additive to the WS path).
2. **Productionize the supervisor** (`experiments/cloud-rust/src/supervisor-rust.js` → port back
   into the `apps/cloud` line, or fork a `apps/cloud-rust`): adopt the `{wasm}`×2 + `{text}` + `{js}`
   loader module set and the `/frame` proxy.
3. **Re-attach the trimmed JS-supervisor features** (these were removed only for prototype
   legibility; the live `apps/cloud/src/supervisor.js` already has them — porting is mechanical):
   keep-warm, AE metering, `/usage`, mediated per-tenant `HttpGateway` egress.
4. **Pin wrangler ≥ 4.x** for the cloud-rust worker (see gotcha).
5. **Build chain:** wire `scripts/bake-rust.mjs` into the deploy driver; codeId-version the loader
   on engine-hash change.

## Blockers / not-done (honest)

- **No alarms in facets** (known platform limit) — idle/TTL **keep-warm must live on the
  supervisor DO**, not the facet. Kernel durability is per-cell sync snapshot and needs no alarms,
  so this is a scheduling-placement task, not a redesign.
- **Egress not wired in the prototype:** `globalOutbound:null` blocks all facet egress here; the
  JS cloud's per-tenant `HttpGateway` mediated-fetch is the seam to route `host.fetch` — untested
  under the Rust facet (the Rust DO does `fetch()` DO-side; the gateway would front it).
- **WS hibernation of a facet-held socket not exercised** — use the **proxy model** (supervisor
  holds the WS, RPCs `/frame`), identical to the JS cloud's proven approach.
- **Scale not stress-tested:** facet count, R2-overflow snapshot path (>2MB gz, never produced in
  the prototype), `facets.delete`, loader codeId cache behavior.
- **Metering/AE/keep-warm** intentionally trimmed from the prototype (full versions live in
  `apps/cloud/src/supervisor.js`).

None of these block the **core feasibility claim** — the Rust kernel provably runs multi-tenant as
a facet with durable per-session SQLite and genuine cold-restore.

## Gotcha (resolved, must carry forward)

An interim deploy via the repo-default **wrangler 3.107** silently **dropped the
`worker_loaders` binding** ("Unexpected fields: worker_loaders" warning) → `ctx.facets.get`
became undefined and every frame 500'd. Redeploying with **wrangler@4.97.0** restored `env.LOADER`
and all checks passed. **Lesson:** a cloud-rust worker MUST deploy with **wrangler ≥ 4.x**
(`worker_loaders` is unsupported in 3.x).
