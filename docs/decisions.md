# Architecture Decision Records

## ADR-0001 — Drop Dynamic Worker Loader for the kernel substrate (V0)

**Status:** Accepted (V0). Revisited by ADR-0003.

**Context.** Project began exploring Dynamic Worker Loader (`env.LOADER`) for a durable resumable REPL. DW Loader spins up ephemeral, per-request V8 isolates, best-effort warm, keyed only by id, with **no persistence guarantee** and no module type for `.wasm`.

**Decision.** V0 does **not** use Dynamic Worker Loader. The kernel substrate is a **Durable Object** (single persistent identity + SQLite + hibernation) with the QuickJS engine bundled as a **CompiledWasm** module. DO replaced the loader.

**Why.** A kernel needs the opposite of what DW Loader offers: one persistent single-identity actor that owns state and survives eviction. The engine is a *fixed* image → bundle it, don't load it dynamically. EXP-4b confirmed pure-Rust nested eval isn't viable; path (b) = Rust DO shell + JS glue.

**Consequence.** V0 bindings: `KERNEL_DO` (DO+SQLite), `SNAPSHOTS` (R2 overflow), CompiledWasm `quickjs.wasm`. No `LOADER`.

---

## ADR-0002 — Live-heap snapshot, not logical-state reconstruction

**Status:** Accepted.

**Context.** Two ways to make a REPL durable: (A) reconstruct an equivalent namespace from durable *data* (the model facet-native `ctx.storage` and journaling use); (B) snapshot the raw interpreter **heap** and blit it back.

**Decision.** Use (B): dump QuickJS WASM **linear memory + mutable globals** at quiescent cell boundaries; restore into a fresh instance. No source replay, no re-fired side effects.

**Why.** Model (A) loses live object identity, closures, and pending promises — not a real kernel. (B) is only possible because WASM linear memory is a plain ArrayBuffer (V8 isolate heap is not snapshottable). Proven EXP-1/5a; byte-deterministic with seeded clock/RNG (EXP-8).

**Consequence.** Snapshots are byte-coupled to the engine build → engine-hash guard + per-cell journal fallback (EXP-9). This is orthogonal to facets: even inside a facet, we still heap-snapshot into the facet's SQLite.

---

## ADR-0003 — Adopt Durable Object Facets for V1 multi-tenant (Worker Loader re-enters here)

**Status:** Proposed (V0.1 / V1 direction).

**Context.** V0 = one DO per session (one identity/namespace each). Going multi-tenant + dynamically-configurable needs: per-session isolation, supervisor-owned auth/metering/billing/kill-switch, and per-tenant/versioned kernel code. DO **Facets** provide exactly this: a supervisor DO loads a DO **class from a Dynamic Worker** (`LOADER.getDurableObjectClass`) and runs it as a child facet with its **own isolated SQLite**.

**Decision.** V1 packages the kernel as a **facet under a supervisor DO**. This is where **Worker Loader deliberately re-enters** (reversing ADR-0001 *only* for the multi-tenant/dynamic-config case): the per-tenant kernel class is loaded via `env.LOADER`, hot-swappable via `abort`+restart, isolated per session.

**Why.** Facets fuse "dynamically-loaded code" + "persistent isolated storage" + "supervisor control" — the precise shape of a multi-tenant, dynamically-configured, stateful REPL. The live-heap snapshot (ADR-0002) still applies *inside* each facet's SQLite.

**Consequences / open questions.**
- Facets require `new_sqlite_classes` supervisor + `worker_loaders` binding (Workers Paid, beta).
- Undocumented: per-facet alarms/WebSockets, nesting, per-facet limits, exact eviction semantics → must validate empirically before depending on them.
- Facet-native `ctx.storage` is model (A); we keep model (B) heap-snapshot on top. Two storage uses coexist in one facet DB: our snapshot chunks + any logical state.
- Cost/perf of many facets per supervisor + heap snapshots each — unmeasured.

**Sequencing.** V0.1 first proves the kernel is *usable/useful* as a flat DO (current V0 hardened + a real product surface). Only if that lands do we layer facets for multi-tenancy. Don't add facet complexity before the single-tenant kernel earns it.

---

## ADR-0004 — Generic VM→client host-callback bridge (not an RLM/agent API)

**Status:** Accepted (live, `engram-kernel`). Implements the `host.<name>()` reentrancy path.

**Context.** A durable cell sometimes needs a value the kernel can't compute inside `wasm32-wasip1` — e.g. an LLM call, a DB lookup, anything the *connected client* owns. The earlier design baked specific verbs into the kernel (`host.subLM` / `host.ctx.*` / `host.final` / `host.kv`), which couples the kernel to one use case (RLM) and bloats its trust surface.

**Decision.** The kernel exposes **one built-in host effect — `host.fetch`** (DO-side, allowlisted). **Every other `host.<name>(...args)` is a generic bridge**: the engine parks the VM eval, the glue emits a `{t:hostcall,id,name,args}` frame to the connected client over the same WebSocket, and resumes the parked VM when the client replies `{t:hostcall-result,id,...}`. The kernel has **no knowledge** of `subLM`, "final", convergence, etc.

**Why.** One generic mechanism covers all client-mediated effects and keeps the kernel a dumb, sandboxed pump. RLM/agent loops become *application code* on top (see ADR-0007).

**Critical constraint — mutex-safe demux.** The `eval` critical section holds `self.mutex` for the whole eval. The client's `{t:hostcall-result}` arrives as a *new* `websocket_message`; that handler **must not re-acquire the mutex** (the suspended eval holds it → re-entrant deadlock, the BUG-1 class). So the pending-resolver registry lives in the glue module (one DO isolate == one module instance) and `lib.rs` resolves it from `websocket_message` **without touching the mutex**. A per-eval sender closure is installed on the glue (`setHostSender`); when there is no live client socket (HTTP `/frame` / facet path) the sender is null and non-fetch host calls reject cleanly.

**Consequence.** Determinism + crash-replay preserved: the E6 oplog still records the host *result*, so engine-migration replay feeds the recorded value back **without re-calling the client**. Verified live (`tests/kernel-rust/hostcall-local.mjs`, 12/12): single + sequential calls, client-throw → catchable rejection + mutex released, unbound fn → clean reject, oplog replay does not re-call. Cloud **HTTP** transport cannot do host callbacks (no held socket) — WS only.

---

## ADR-0005 — REPL completion value for top-level-await cells

**Status:** Accepted (live).

**Context.** The engine runs a cell three ways (`install_cell`): expression form (`return (src)`, supports await), **async-body form** (`new AsyncFn(src)` when the cell contains `await`), and global-`eval` form (no await). A *function body* has **no completion value**, so an await-using multi-statement cell ending in a trailing expression (e.g. a loop then `({m,i})`) silently returned `undefined`. No-await cells were fine because they use indirect `eval`, which *does* yield the last-expression value. Symptom: an agent/await loop "ran but converged on nothing."

**Decision.** Host-side, after the persistence transform, a scoped `wrapAsyncCompletion` (in `repl-transform.ts`) rewrites an await-cell's trailing expression (after a depth-0 `}`/`;`) into `; return ( … );`, so the async-body wrapper yields it. It **bails to the input on any ambiguity** (no depth-0 await, no boundary, keyword-led tail, unbalanced source) → zero regression for no-await / single-expr / trailing-semicolon cells.

**Why.** Fixing it in the host transform (which already tokenizes at depth 0) avoids touching the precompiled engine for a parsing concern, and the bail-safe design means it can only *add* a completion value, never corrupt a cell.

**Consequence.** `let m=...; while(...){ m = await host.subLM(m); } ({m,i})` now returns its value. Verified `tests/kernel-rust/completion-local.mjs` (11/11): loops, if, for, template, declarations persist, trailing-semicolon stays `undefined`.

---

## ADR-0006 — Node-parity shims + runtime npm via a CDN bundler (`use()`)

**Status:** Accepted (live). Closes the easy half of the Node-gap matrix.

**Context.** The VM is bare QuickJS — no `require`/modules/`fs`/`process`/`Buffer`/timers/`fetch`. Many libraries probe for these. A true async `import('pkg')` is **architecturally blocked**: QuickJS module resolution is *synchronous*, but the only host IO (`host.fetch`) is *asynchronous* (parked VM, resumed by Rust). You cannot synchronously fetch inside the module loader without a heavy, fragile dependency walker.

**Decision.** Add pure-in-VM, snapshot-persisted shims to the engine `BOOTSTRAP` (zero entropy, no new host capability): `global`, a `process` shim (`env`/`argv`/`platform`/`nextTick`), a `fetch()` Response-like wrapper over the allowlisted `host.fetch`, `console.dir/group/table/assert`, REPL `_` last-value, a `Buffer` subset over `Uint8Array`, `require()` over built-in shims (`crypto` via the **seeded** `getRandomValues`, `events`/`util`/`path`/`os`/`assert`/`buffer`) plus the `use()` cache, and **immediate timers** (`setTimeout`/`setImmediate` fire on the microtask queue, **delay ignored**; `setInterval` is a safe no-op). For npm: `await use(name)` fetches a **pre-bundled CDN build** (jsDelivr/esm.sh — *that* is the bundler), evals it in a CJS frame (`module`/`exports`/`require`/`Buffer`/`process`), and caches the result in `globalThis.__mods`.

**Why.** Immediate timers are determinism- and hibernation-safe (a timer never spans a snapshot — it completes within the cell's microtask drain), which retired the earlier over-cautious "no timers" stance. `use()` + a real `require` frame covers the large class of self-contained CJS/UMD bundles with no engine changes, and because the loaded source lives in the heap it **survives hibernation with no re-fetch** — something Node's runtime `require` cannot freeze into a portable image.

**Consequence.** Verified live: `use('lodash')`/`use('dayjs')`/`use('ramda')`/`bcryptjs` (which `require('crypto')` + `setTimeout`), `_` last-value, `process`, immediate `setTimeout`, all surviving evict→cold-restore. **Limits (honest):** `use()` is async (not sync `require`); needs the CDN host on the fetch allowlist; works for self-contained bundles only — **ESM-only** packages and **multi-file relative-`require`** packages still fail. Full `import('x')` needs the QuickJS async module loader wired in Rust (deferred — the one item that would close the ESM gap).

---

## ADR-0011 — `fs`: in-heap VFS by default, swappable to a host-backed provider (R2)

**Status:** Accepted (live; VFS + R2 provider deployed, S3 deferred).

**Context.** The VM had no filesystem. A genuine *synchronous* Node `fs` (`readFileSync`) is impossible over a host-backed store because host IO is async (parked VM) — the same sync/async wall as the module loader (ADR-0006). But code wants `fs`, and some use cases want a *shared/persistent* workspace beyond the heap.

**Decision.** Ship a Node-like `fs` (in `BOOTSTRAP`, exposed as `require('fs')`/`'node:fs'`/`'fs/promises'` + global `fs`) with a **provider switch** read from `config.fs`:
- **`{provider:"vfs"}` (default)** — backed by an **in-heap object** (`globalThis.__vfs`). Full **synchronous** API (`readFileSync`/`writeFileSync`/`mkdirSync`/`readdirSync`/`statSync`/…) + a `promises` mirror. Sync is possible *only* because the data lives in the heap; it is **durable** (snapshot-persisted, survives hibernate — verified) and **deterministic**. It is the VM's own scratch disk: **not shared** with the host, bounded by the heap size-admission cap.
- **`{provider:"r2", binding?, prefix?}`** — **host-backed** R2. R2 is a DO binding (`env`), not a glue global, so it is serviced **DO-side in `lib.rs`** (`r2_fs_op`) via an async closure the kernel installs per eval; the engine's `host.__fs` effect routes there. **Async-only**: `fs.promises.*` work; **sync methods throw** a typed `ERR_FS_ASYNC_ONLY`. Binary crosses the engine↔glue JSON boundary as base64 (glue decodes to `Uint8Array` for the Rust handler; no Rust base64 dep). Keyed `<prefix><path>` (default `fs/<do_id>/`) in the configured bucket binding (default `SNAPSHOTS`, both configurable on-demand).
- **`{provider:"s3", …}`** — deferred (needs SigV4 signing + carrying credentials in config).

**Why.** VFS gives real *synchronous* Node `fs` for the common scratch-file case, free and durable, with no host round-trip. R2 gives a *shared, beyond-heap, cross-session* store for code that needs it — at the cost of async-only. The provider switch lets a caller pick per session.

**Consequence.** Verified live: VFS sync round-trip + survives hibernate; R2 `promises` write/read/readdir/stat, `ERR_FS_ASYNC_ONLY` on sync, `ENOENT` propagation, and a file **written to R2 survived a real evict + cold read** (host-backed, not heap-coupled — so it also survives engine-hash changes, unlike VFS). The client-provided `host.fs.*` pattern (e.g. ThinkDO + `@cloudflare/shell`) remains valid and orthogonal — that's a *different* host module over the WS bridge; this ADR is the kernel-native, binding-backed path.

---

## ADR-0007 — RLM/agent loops are an SDK example, not a kernel feature

**Status:** Accepted.

**Context.** "RLM" (recursive-LM / agent loop) drove early demos, and host verbs (`host.subLM`/`host.final`) were once kernel-native. That couples a general durable REPL to one application and re-introduces an opinionated surface the kernel shouldn't own.

**Decision.** The kernel ships **only** the generic bridge (ADR-0004). The agent loop — the LM call, the iteration, the stop/convergence condition, "final" — is **application code**: the *client* registers `host.subLM` (SDK `host:` option / CLI / UI `setHost`) and the *cell* contains the loop. The canonical illustration lives at **`examples/agent-loop.mjs`** (repo root), not in the kernel, SDK core, or the UI default.

**Why.** Keeps the kernel a generic, sandboxed, durable REPL; lets RLM evolve independently; avoids implying native support that isn't (and shouldn't be) there. The UI was reverted to bind **no** host functions by default — only the generic `setHost` + demux remain.

**Consequence.** `host.subLM` in any demo is just a client-provided host fn (mechanically identical to `host.echo`). Naming that evokes RLM is illustrative, not a kernel contract.

---

## ADR-0008 — Hibernation is platform-driven: eager snapshot, passive eviction, lazy wake

**Status:** Accepted (describes the live mechanism).

**Context.** "How does it self-hibernate?" — there is **no kernel-side hibernate timer**. Hibernation is the Cloudflare Durable Object **idle-eviction + WebSocket Hibernation** behaviour; the kernel is designed so that eviction is *safe* and waking is *cheap*.

**Decision.** Three separated concerns:
1. **Persist eagerly (active, per cell).** Every `eval` ends with a checkpoint: dump live WASM linear memory → gzip → DO **SQLite** (chunked rows; R2 only if >2MB gz). The durable image is always current; the live WASM instance (`self.glue`) is disposable, held only in the DO JS heap.
2. **Hibernate passively (platform).** On WS connect: `state.accept_web_socket(server)` marks the socket **hibernatable**, and `set_websocket_auto_response("ping","pong")` lets the **edge answer keep-alive pings without waking the DO**. When idle, Cloudflare evicts the isolate — the live WASM instance is gone, the socket is parked, SQLite survives.
3. **Wake lazily (on next touch).** The next message instantiates a **fresh DO** (`generation++`, `glue = None`); `ensure_glue()` reads config + manifest from SQLite (or R2), blits the snapshot into a new WASM instance, `reattach()`, and continues — **no source replay, no re-fired effects** (ADR-0002).

**Why.** The kernel cannot (and a *facet* may not) set alarms; making eviction safe by construction beats trying to control it. Auto-response ping/pong is the key to staying hibernated cheaply under a heartbeat. Per-cell snapshot means eviction can happen at any quiescent boundary with zero data loss.

**Consequence.** A real hibernation is observable: `generation` bumps and `inMemory:false` on the next op (`hibernateThenResume()` / the UI pill). The `Hibernate` button / `{t:evict}` is a **manual** force-evict (`self.glue.take()`) for demos/tests, not the normal path. In `engram-cloud`, idle/TTL/keep-warm scheduling lives on the **supervisor** (which *can* set alarms), not the per-session facet. Deep-eviction wake is platform-bound (~1.5s worst real, dominated by WS-connect + isolate spin-up), state always survives (docs/results/deep-hibernation.md).

---

## ADR-0009 — Two deployables: `engram-kernel` (engine) vs `engram-cloud` (multi-tenant SaaS)

**Status:** Accepted (both live).

**Context.** The single-tenant kernel and the multi-tenant SaaS have different trust models, bindings, and lifecycles. Folding auth/metering/routing into the kernel would bloat its trust surface and bindings.

**Decision.** Ship **two workers**:
- **`engram-kernel`** — the engine. One `KernelDO` class, one DO per session id, **unauthed** raw WebSocket. Direct, open, dev-friendly.
- **`engram-cloud`** — the SaaS wrapper. A `SupervisorDO` (64-shard) that **embeds the kernel** (`bake-rust.ts` bakes the kernel build into `modules.rust.gen.js`) and loads it **per session as a facet** (own SQLite, failure-isolated) via the Worker Loader `{wasm}` module type. Adds per-tenant API keys (`x-api-key`), Analytics-Engine metering + `/usage`, routing, and supervisor-owned alarms (ADR-0003, ADR-0008).

**Why.** Separation lets the kernel evolve and deploy independently; the cloud just re-bakes the latest kernel. Cloud needs `worker_loaders` + facets bindings the kernel doesn't. Different auth/tenancy boundaries stay isolated.

**Consequence.** SDK auto-detects transport: `apiKey` + `http(s)://` → cloud HTTP; otherwise → kernel WS. The cloud **HTTP** path cannot do `host.<name>` callbacks (no held socket; ADR-0004) — those need the WS path. The UI talks raw WS to `engram-kernel` and needs **no API key**.

---

## ADR-0010 — Fast local test infra: build-once + no-rebuild dev config

**Status:** Accepted.

**Context.** `wrangler dev` re-runs the full Rust release build (~90s: cargo + wasm-bindgen + worker-build) on **every start**, which raced the E2E harness's ready-wait — so the on-real-workerd bridge/completion tests effectively never ran (they timed out before the server came up).

**Decision.** Add `apps/kernel/wrangler.dev.jsonc` — a copy of the prod config with `build.command` = `"true"` (no-op) and `name` = `engram-kernel-dev`. The kernel E2E harnesses (`hostcall-local.mjs`, `completion-local.mjs`) **build once** up-front (skippable with `ENGRAM_SKIP_BUILD=1`) then launch `wrangler dev -c wrangler.dev.jsonc`, so the server is ready in **~5s** instead of timing out.

**Why.** A test that can't finish provides no signal. Decoupling the build from `wrangler dev` makes the real-workerd suite actually runnable and fast to iterate.

**Consequence.** Production deploys still use the real `wrangler.jsonc` build. Deploys reuse fresh artifacts via `wrangler deploy --name engram-kernel -c wrangler.dev.jsonc` (with `.env` creds) — the root `deploy:kernel` script is currently broken (pins wrangler 3.x + wrong cwd → `tsconfig.json not found`); deploy from `apps/kernel` with `wrangler@^4`.


---

## ADR-0012 — Binary-safe `host.fetch` + isomorphic-git as a first-class stdlib (git clone over engram-native `fs`)

**Status:** Accepted (live on `engram-kernel-ouru`; binary fetch + `git.clone` of a public repo over the default VFS proven).

**Context.** A REPL cell could not `git.clone` a public repo. Root cause (proven by a prior spike): the VM's `fetch()` returned the body as a UTF-8 **string** with a 1 MB cap — glue `_doFetch` did `await r.text()`, and the engine fetch shim exposed only a string `body`. Git transfers **binary** packfiles, so the body was lossy-corrupted (favicon 6518 B → 7666 B with 574 U+FFFD) and truncated; isomorphic-git could not parse it. The CDN dep-tree / ESM / relative-`require` path for loading isomorphic-git at runtime is too fragile (the spike).

**Decision.**
1. **Binary-safe `host.fetch` (the structural unblocker).** The host fetch effect carries **raw bytes both ways as base64** (the same engine↔glue boundary pattern as the R2 fs op, ADR-0011):
   - Glue `_doFetch` reads `await r.arrayBuffer()` (not `.text()`), returns the body as `bodyB64` (+ a capped utf8 `body` for back-compat, + `byteLength`/`truncated`). A **binary request body** is accepted as `init.bodyB64` (base64) and decoded to bytes before `fetch` (git-upload-pack POSTs a binary packfile). Cap raised **1 MB → 32 MB** (`FETCH_MAX_BODY_BYTES`, env-overridable).
   - The engine fetch shim (`BOOTSTRAP`) returns a Response-like with `.arrayBuffer()`/`.bytes()` (base64-decode `bodyB64` → exact bytes), `.text()`/`.json()` (utf8 view), `status`/`statusText`/`headers`. A binary request body (`Uint8Array`/`ArrayBuffer`) is base64-encoded into `init.bodyB64` before the host call. The legacy string `body` path still works.
2. **isomorphic-git as a first-class stdlib module.** `isomorphic-git` (v1.27.1) is esbuilt to a single self-contained CJS IIFE (all deps inlined) and registered into the in-VM `__mods` so `require('isomorphic-git')` resolves from the stdlib bundle — **no CDN, no ESM dep-tree, no relative-require**. A small git smart-HTTP client (`isomorphic-git-http`, also aliased `isomorphic-git/http`) implements isomorphic-git's `http.request` contract over the binary fetch (request/response bodies as async-iterables of `Uint8Array`). Both ship **opt-in** in `stdlib-meta` (loaded only when named in `config.modules`, since the bundle is ~210 KB).
3. **`Buffer`/`Uint8Array` + `fs` parity required by binary libs** (all in `BOOTSTRAP`):
   - `Buffer.from(bytes).toString(enc)` must decode (encoding-aware `Uint8Array.prototype.toString`), not Array-join byte numbers (broke the smart-HTTP header parse). `Buffer` is legacy-callable + has `allocUnsafeSlow` so `safe-buffer`'s feature-detect passes (else it falls back to `Buffer(size)` legacy calls returning `undefined`).
   - `Uint8Array.prototype` gains the Buffer numeric read/write methods isomorphic-git's packfile/idx parser uses (`readUInt32BE`/`writeUInt32BE`/`readInt32BE`/`writeInt32BE`/`readUInt16BE`/`readUInt8`/…) + `write(str,off,len,enc)`/`copy`/`equals`.
   - VFS adds `lstat`/`rmdir`/`readlink`/`symlink` (sync + promises) so isomorphic-git's `FileSystem` can bind every required method at construction.
   - **`fs.readFile(path, {})` returns bytes, not a lossy utf8 string.** Node semantics: a string encoding (or `{encoding:'utf8'}`) → string; no encoding (`undefined`/`'buffer'`/`{}` with no `.encoding`) → bytes. isomorphic-git reads the binary `.idx` with `readFile(path, {})`; the old `decode` treated `{}` as utf8 and corrupted the packfile-index magic, so checkout returned `undefined`. This was the final clone blocker.

**Why.** Binary-safe fetch is the one structural fix that unblocks every binary transfer (git, tarballs, wasm, images) — bytes in, exact bytes out. Bundling isomorphic-git + its http client as stdlib avoids the fragile runtime CDN path and gives `require('isomorphic-git')` deterministically from the in-VM heap.

**Consequence.** Proven live on `engram-kernel-ouru` (prod `engram-kernel` untouched): a cell fetching `github.com/favicon.ico` via `.arrayBuffer()` gets **exactly 6518 bytes** (no U+FFFD); a binary request body round-trips byte-exact; and `git.clone({fs, http, dir:'/repo', url:'https://github.com/octocat/Hello-World.git', singleBranch:true, depth:1})` over the **default in-heap VFS** writes `/repo/{.git, README}` and `fs.readFileSync('/repo/README','utf8') === 'Hello World!\n'`. Existing suites stay green: bridge E2E 12/12, completion 11/11, VFS round-trip. The encoding-aware `Uint8Array.prototype.toString` only changes behavior when an explicit encoding arg is passed (no-arg/JSON/value-preview unchanged; determinism intact). A known benign `valueOf` log surfaces during clone (caught internally by isomorphic-git; does not affect the result).
