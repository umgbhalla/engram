# montydyn — Definitive REPL Environment-Surface Map

> What user code *actually* sees inside the montydyn VM, what is missing, what is
> shimmable, and what is fundamentally impossible — plus the one-line verdict on whether a
> "proper environment" is offerable.
>
> Verified against `v0.5/src/glue.js`, `v05/wrangler.jsonc`, the live WASM import section of
> `v05/node_modules/quickjs-wasi/quickjs.wasm`, `docs/results/v0.5-observability.md`, and the
> deep-test/fuzz findings. 2026-06-01.

---

## 0. TL;DR verdict

**A Node-ish POSIX-shim sandbox (WebContainers / `@cloudflare/shell` tier) IS buildable over
montydyn as an explicit host-boundary shim layer — but it can never be a *real* Node: no real
threads, no listening sockets, no `child_process`, no native addons, no true blocking syscalls.
"Proper environment" = honest as a Node-*ish* facade, overclaim as literal Node.**

---

## 1. The two-runtime model (where each API lives)

montydyn is **two separate runtimes**, and conflating them is the single biggest source of
confusion. `nodejs_compat` is **IRRELEVANT to the VM** — proven three ways below.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ HOST realm: workerd Worker (entry.mjs + glue.js + Rust DO lib.rs)         │
│   compatibility_flags:["nodejs_compat"], compat date 2025-05-01           │
│   (v05/wrangler.jsonc:6-7)                                                 │
│   HAS: node:buffer/crypto/path/stream/events/util/assert/net(client)/dns/ │
│        timers/url/zlib, partial node:process, fetch/Request/Response/      │
│        Headers, CompressionStream/DecompressionStream (glue.js gzip,       │
│        lines 95-105), structuredClone, crypto.subtle, TextEncoder, URL,    │
│        setTimeout, queueMicrotask, WebAssembly.Module via CompiledWasm.    │
│                                                                            │
│   ── injects into VM ONLY via (the "host-injection boundary") ──           │
│   (a) WASI factory: clock_time_get + random_get        (glue.js 239-253)   │
│   (b) vm.newFunction + vm.setProp: __hostNowMs/__hostRandom/__hostPerfNow/ │
│       __hostConsole/__hostFetch/__hostCall            (glue.js 352-365)    │
│   (c) REBIND_SRC eval preamble: console, Date, Math.random, performance,   │
│       the `host` proxy                                 (glue.js 257-327)   │
│                                                                            │
│   ┌───────────────────────────────────────────────────────────────────┐ │
│   │ VM realm: nested quickjs-wasi WebAssembly.instantiate              │ │
│   │   QuickJS.create({wasm, wasi, interruptHandler})  (glue.js 686-690)│ │
│   │   SEPARATE WASM module, own linear memory. node:* CANNOT cross.    │ │
│   │   This is where user REPL/cell code runs.                          │ │
│   │   engine: quickjs-ng via quickjs-wasi v3.0.0                       │ │
│   └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**`nodejs_compat` is host-only — proof:**
1. **Separate WASM instance.** `QuickJS.create({wasm, wasi})` (glue.js:686) instantiates a
   distinct `WebAssembly.Module` with its own linear memory. Host-realm Node polyfills have
   no path into that global object.
2. **The flag governs the host bundle.** `compatibility_flags:["nodejs_compat"]` in
   `wrangler.jsonc:7` polyfills `entry.mjs`/`glue.js`/the Rust DO — which themselves use
   `CompressionStream`/`fetch`/`URL` (glue.js:95-105, 146).
3. **Empirical.** Live probe + `fuzz.mjs` (per `docs/results/v0.5-observability.md`):
   `process`/`require`/`Buffer`/`Deno` all `undefined` in the VM, and
   `Function('return this')()` returns the VM global, not the host.

**The exact WASM import surface** (parsed live from `quickjs.wasm` — this is the hard
ceiling on the OS surface):
- `wasi_snapshot_preview1`: `clock_time_get, fd_close, fd_fdstat_get, fd_seek, fd_write,
  random_get`
- `env`: `host_call, host_get_timezone_offset, host_interrupt, host_module_load,
  host_module_normalize, host_promise_rejection`

There is **NO** `sock_*`, `path_open`, `fd_read`, `fd_readdir`, `poll_oneoff`,
`args_get`/`environ_get`, thread/fork/dlopen anywhere. `fd_write` only services fd 1/2
(routed to console). **No filesystem, no stdin, no sockets, no poll/select, no argv/env —
fundamentally absent at the import level.**

---

## 2. PRESENT in the VM today (the real baseline)

Full non-intrinsic global set (`Object.getOwnPropertyNames(globalThis)`): everything below +
pure ECMAScript intrinsics. **Nothing else.**

**ECMAScript intrinsics (quickjs-ng, modern):**
- `Object/Array/String/Number/Boolean/Symbol/BigInt/Error/AggregateError`,
  `Function` ctor + `eval` (direct + indirect — both stay in the VM global, NOT a host
  escape), `Proxy/Reflect`, `Map/Set/WeakMap/WeakSet`, `WeakRef`, `FinalizationRegistry`.
- `Promise` + `async/await` + **top-level await** (glue evals `EvalFlags.ASYNC`;
  `await Promise.resolve(7)+1 === 8` live).
- `ArrayBuffer`, all TypedArrays incl. `BigInt64Array` + `Float16Array`, `DataView`.
- `SharedArrayBuffer` constructible **but `Atomics` is ABSENT** — inert (see §8 trap).
- `JSON`, `Math`, `Date` (rebound, see below), `RegExp` (full modern: named groups,
  lookbehind, Unicode property escapes), `BigInt` arithmetic.
- ES2022-2025: `Object.hasOwn`, `.at`, `findLast`, Error `cause`, `String.replaceAll`,
  `Promise.any/withResolvers`, `Object.groupBy`, `Array.fromAsync`, `Iterator` helpers global,
  `DisposableStack`/`AsyncDisposableStack`/`SuppressedError`.
- `btoa`/`atob` (quickjs-ng builtins — **the only built-in encoding primitive**; base64
  works with no shim), `DOMException`, `queueMicrotask`, `InternalError`.

**Host-injected (all seeded/buffered for determinism):**
- `Date.now()` / `new Date()` → seeded host clock (`__hostNowMs`); epoch `1_700_000_000_000`
  + 1ms per call. Live: `Date.now() === 1700000000002`.
- `Math.random()` → seeded mulberry32 (`__hostRandom`).
- `performance` replaced with `{ now }` → seeded clock (`__hostPerfNow`).
- `console.{log,info,warn,error,debug}` → host-buffered per cell, returned as `logs[]`.
- `host` proxy: `host.<tool>(...)`, `host.kv.{put,get,keys}`, `host.add/echo/now`, and
  **`host.fetch(url, init)`** — REAL async outbound egress, allowlist-gated, returns
  `{status, ok, headers, body}`. Live GET returned 200/528 bytes; a blocked host rejects with
  a typed `FetchBlockedError`. **fetch adds 0 entropy** (never touches the seeded counters).

---

## 3. ABSENT / broken (the Node OS surface)

All `undefined` in the VM:

| Category | Missing |
|---|---|
| Node core | `process`, `require`, `module`, `exports`, `Buffer`, `global`, `__dirname`/`__filename`, `setImmediate`, `Deno` |
| Node modules | `fs`, `os`, `path`, `net`, `http(s)`, `dns`, `child_process`, `worker_threads`, `cluster`, `stream`, `events`, `util`, `zlib`, `crypto` — no `require`/no module loader wired |
| Timers | `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`/`setImmediate` — **NO timers**; only `queueMicrotask` |
| Crypto | `crypto` entirely undefined — no `crypto.subtle`, `getRandomValues`, or `randomUUID`. The REBIND_SRC `getRandomValues` hook is **dead code** (guarded on a `crypto` object that does not exist, glue.js:269) |
| Encoding | `TextEncoder`/`TextDecoder` (encoding.so not loaded) |
| Web platform | `fetch` (global), `Headers`/`Request`/`Response`/`Blob`/`File`/`FormData`, `URL`/`URLSearchParams` (url.so not loaded), `structuredClone`, `ReadableStream`/`CompressionStream`/`TextEncoderStream`, `EventTarget`/`Event`/`AbortController`/`MessageChannel`/`Worker`, `navigator`/`window`/`self`/`document`/`localStorage` |
| Concurrency | `Atomics` (absent even though SharedArrayBuffer exists), real threads |
| Other | `Intl` (no ICU in this build), `WebAssembly` (absent in VM; runtime codegen also embedder-blocked), qjs-CLI globals `std`/`os`/`print`/`scriptArgs` (this is wasi-embed, not the qjs CLI) |
| Modules | `import`/`export` → `SyntaxError` (script-mode eval); dynamic `import('fs')` / `import('data:...')` → `ReferenceError 'could not load module'` (no loader wired, though the ABI exists — see §4) |

---

## 4. SHIMMABLE — API → mechanism → effort

The universal recipe (proven in production): register a host callback
(`vm.newFunction`/`registerHostCallback`) or extend `REBIND_SRC`, and for async results
follow the `__hostFetch` pattern — a deferred VM promise drained by the eval pump
(`_drivePromise`, glue.js:901-936). State kept host-side must be serialized into the snapshot
manifest and re-hydrated on restore (the `ctx.kv` pattern, glue.js:602-620 / dump:1172-1174).

| API | How | Effort |
|---|---|---|
| **Native `.so` extensions**: `TextEncoder/Decoder`, `URL/URLSearchParams`, `crypto.subtle`+`getRandomValues`, `structuredClone`, `Headers` | **Drop-in.** quickjs-wasi ships prebuilt `.so` at `node_modules/quickjs-wasi/extensions/{encoding,url,crypto,structured-clone,headers}/`. The `extensions:[]` array on `QuickJS.create/restore` is **currently unused** in glue.js. They link via dylink shared memory and travel in the snapshot metadata (`SnapshotExtension`, extensions.d.ts:94-101). crypto's RNG routes through `random_get` which montydyn already seeds → determinism preserved. **Highest-fidelity, lowest-effort path.** | XS |
| `path` | Pure-JS, zero host calls (posix string algorithms) | XS |
| `events`/`EventEmitter`, `util`, `assert`, `querystring`, `string_decoder`, `punycode` | Pure-JS in-VM polyfills; `util.inspect` can reuse the existing `_preview`/`dump` | S |
| `URL`/`URLSearchParams` | Pure-JS WHATWG polyfill in REBIND_SRC (or the `.so`) | S |
| `TextEncoder`/`Decoder` | Pure-JS UTF-8 over Uint8Array (or the `.so`) | S |
| `Buffer` | Pure-JS Buffer-on-Uint8Array; snapshots naturally | M |
| `structuredClone` | Pure-JS recursive clone (typed arrays/Map/Set) | S |
| `crypto.getRandomValues`/`randomUUID` | Add a `globalThis.crypto = {...}` object in REBIND_SRC (the rebind code already exists but no-ops). Back by seeded `__hostRandom` → **deterministic** | S |
| `crypto.subtle` (digest/sign/verify) | New `__hostSubtle` host callback → host workerd `crypto.subtle`, async over the boundary. **CAVEAT: injects entropy → must be treated as an explicit logged effect or determinism/snapshot-replay breaks** | M |
| `global fetch` + `Headers`/`Request`/`Response` | Alias `globalThis.fetch` to the existing `host.fetch` proxy (real egress, allowlisted, 0 entropy); facade classes over it | S–M |
| `setTimeout`/`setInterval`/`clearTimeout` | `setTimeout(fn,0)` → `queueMicrotask` (trivial). Real delays → host timer table pumped by the eval loop like `__hostFetch`; durations modeled against the seeded clock. Bounded by the ~30s DO turn + ≤1200 interrupt-tick budget | M |
| **virtual `fs`** (`readFile/writeFile/readdir/stat/glob/batch`) | `host.fs.*` over **DO SQLite** (small files/metadata) + **R2** (large blobs). Keep the tree **HOST-side** so it is durable and does **NOT** bloat the VM snapshot (mirror `@cloudflare/shell` StateBackend / Pyodide MEMFS-root). Use **coarse** ops to minimize host_call RPC crossings | M–L |
| `process` | `process.env`→session config; `argv/platform/arch/version/pid`→faked constants; `cwd/chdir`→virtual-fs cursor; `nextTick`→`queueMicrotask`; `hrtime`→seeded perf; `exit`→typed terminate throw | M |
| `os` | `platform/arch/cpus/totalmem/hostname/EOL/tmpdir`→faked deterministic constants; `uptime`→seeded clock | S |
| `net`/`http(s)`/`dns` (CLIENT only) | `http.request`/`https.request` over `host.fetch`; `dns.lookup`→host resolver/stub. HTTP-client only — no raw TCP/UDP, no request streaming | M |
| `stream` (Readable/Writable/Transform) | Pure-JS polyfill (readable-stream is pure JS); back fs/net streams onto the host boundary | M |
| **ES modules** (`import`/`export`) | Wireable WITHOUT engine changes: set `opts.moduleLoader={load,normalize}` on `QuickJS.create` (the `host_module_load`/`host_module_normalize` imports + ABI already exist) and eval with `EvalFlags.TYPE_MODULE`. Snapshot fidelity of module-scope state needs validation | M |
| user WASM | NOT via in-VM `WebAssembly` (absent + embedder-blocked). A `host.wasm.*` tool could compile/run on the host (host has WebAssembly) and return results | M |

A general "inject a stdlib" extension point already exists: `installHostFns` + a `REBIND_SRC`
preamble can define an arbitrary POSIX/Node-ish layer before user code runs.

---

## 5. FUNDAMENTALLY IMPOSSIBLE

Not missing features — **absent primitives** at the WASM-import / platform level. No shim
makes these real.

- **Real OS threads / `worker_threads` / `cluster`** — single WASM linear memory, single
  workerd isolate turn, no thread-spawn primitive, `Atomics` absent. (Cooperative single-
  threaded faking only — not parallelism.)
- **Listening sockets / `net.Server` / `http.createServer().listen()` / dgram** — no `sock_*`
  imports, and workerd forbids inbound listen for a nested isolate. Only outbound HTTP via
  `host.fetch`. (WebContainers escape this only via a browser ServiceWorker — no analog here.)
- **`child_process` spawn/exec/fork** — no process model, no fork/exec syscall, none on the
  workerd host either.
- **Native addons (`.node` / N-API / node-gyp)** — no dlopen, no native module loader; pure
  JS-in-WASM.
- **Real local filesystem persistence** — no `path_open`/`fd_read`/`fd_readdir`; durability
  must route to DO SQLite/R2. (A virtual in-memory fs IS shimmable — §4.)
- **True blocking synchronous I/O** (`fs.readFileSync` over real disk, blocking sockets,
  `Atomics.wait`) — no `poll_oneoff`/`select`; the host boundary is async-only (Promise-based,
  drained by the eval pump). A frozen-clock synchronous turn cannot block on host I/O.
- **Raw TCP/UDP / TLS server / DNS-as-syscall** — only HTTP(S) egress via `host.fetch`.
- **In-VM `WebAssembly` instantiation** — global absent in VM, and runtime `WebAssembly.compile`
  is embedder-blocked platform-wide.
- **Transparently-real time/entropy that also snapshots** — the seeded counter IS the
  mechanism; real `Date.now()`/RNG/timers can only exist as explicit logged effects.
- **Unbounded long-running event loop** — every cell must return; bounded by the ~30s DO turn
  and the ≤1200 interrupt-tick budget (workerd throttles the host interrupt callback after
  ~1.6k invocations/turn).

---

## 6. VERDICT — can we offer a "proper environment"?

**Realistic tier: a Node-ish POSIX-shim sandbox** — the same tier as `@cloudflare/shell`
(virtual fs over SQLite+R2 with coarse typed ops) and Cloudflare Dynamic Workers
("JS/TS + WASM only, no Python/Rust/shell"). The pure-JS shims (`path`, `events`, `util`,
`querystring`, `url`, `assert`) + host-boundary shims (`fs`→SQLite/R2, `process.env`→config,
`net/http`→`host.fetch`, `crypto`→host WebCrypto, `os`→faked, timers→host pump) cover the vast
majority of real REPL/agent workloads. **This is squarely in montydyn's grain** — `host.fetch`,
`host.kv`, and the seeded clock/RNG already prove the recipe.

**What it can never be:** literal Node. The impossible set (real threads, listening sockets,
`child_process`, native addons, true blocking sync I/O) is the same wall every in-isolate Node
emulator hits. WebContainers only escape it by being a full WASM-compiled Node binary with a
SharedArrayBuffer+threads substrate and a ServiceWorker-virtualized TCP stack — a substrate
montydyn does not and cannot have on workerd.

**Fidelity caveats on the three flagship host shims** (why "proper" overclaims):
1. `net/http` over `host.fetch` is **HTTP-client only** — raw sockets break.
2. `crypto` is a **determinism trap** — real host WebCrypto injects entropy outside the seeded
   counters (breaks snapshot/replay); seeded PRNG yields predictable, non-cryptographic output.
   You cannot have both "proper" and "deterministic-snapshottable."
3. `timers` — only `setTimeout(fn,0)`-as-microtask is faithful; real delays are turn-bounded.

**Honest framing: a Node-*ish* facade is buildable and useful; "proper Node" is not.**

---

## 7. TEST PLAN — assert the supported surface + guard the shims

Add to the deep-test suite (extends `docs/results/v0.5-observability.md` §2c fuzz approach).

**A. Baseline-surface assertion (regression fence on the bare VM):**
1. Enumerate `Object.getOwnPropertyNames(globalThis)` in a fresh kernel; assert it equals the
   golden set from §2 (intrinsics + `host`/`console`/`performance`/`btoa`/`atob`/
   `queueMicrotask`/`DOMException`/`Iterator`/`DisposableStack` + the `__host*` fns). Fails if
   a quickjs-wasi bump or an accidental REBIND_SRC change widens/narrows the surface.
2. Assert ABSENT (§3): `typeof process/require/Buffer/crypto/TextEncoder/URL/fetch/setTimeout/
   Atomics/Intl/WebAssembly === 'undefined'`.
3. **No-escape**: `Function('return typeof globalThis.process')() === 'undefined'`;
   `Function('return this')()` is the VM global.

**B. Determinism invariants (the product thesis):**
4. Two fresh kernels, same config → identical `Date.now()`, `Math.random()` sequences,
   `performance.now()`. Assert `Date.now() === 1700000000002` on the 3rd call.
5. dump → restore → continue; assert `clockCalls`/`rngCalls` replay so the next RNG draw
   matches the no-restore baseline.
6. **fetch adds 0 entropy**: interleave `host.fetch` calls with RNG draws; assert the RNG
   sequence is identical with and without the fetches.

**C. Host-boundary / pump guards:**
7. `host.fetch` allowlist: allowed host → 200; blocked host → typed `FetchBlockedError` caught
   in-cell with socket alive. `fetch:false` blocks all.
8. Body cap (`FETCH_MAX_BODY_BYTES`) and header cap enforced; `truncated:true` surfaces.
9. `host.kv` survives dump→restore (kvJson round-trip); async cell `await`s drain (console
   capture inside an async IIFE proves microtasks pump even when the bare async return previews
   as `{}`).

**D. Preemption / safety (non-negotiable):**
10. Every infinite-loop shape — `while(true){}`, `{x=1}`, `{globalThis.x=1}`, `{o.a=1}` — trips
    a typed `TimeoutError` with the socket alive (no WS 1006). Assert 0 escapes across reps at
    the default 1200-tick budget.
11. Throw / SyntaxError / ReferenceError → `{ok:false,error}` and the kernel stays usable
    (mutex always released).
12. Size admission: spike heap then free → checkpoint admits on used heap; oversized buffer →
    typed `SizeAdmissionError`, prior snapshot intact.

**E. Shim guards (add per shim as it lands — these are the fences that keep a shim honest):**
13. **Extensions path**: if `extensions:[encoding,url,crypto,...]` is wired, assert each global
    appears AND survives dump→restore (extension metadata re-instantiates at fixed
    memory/table bases — assert restored output matches pre-snapshot).
14. **crypto determinism guard**: assert `crypto.getRandomValues` (seeded path) replays
    identically across restore; if `crypto.subtle` (host-backed) is added, assert it is flagged
    as an explicit effect / excluded from the determinism fence (test that it is NOT silently
    breaking replay).
15. **Timer fidelity**: `setTimeout(fn,0)` runs after sync code, before next cell; assert a
    real-delay timer respects ordering against the seeded clock and is bounded by the turn.
16. **virtual fs**: write→read→stat round-trips; tree persists across dump→restore via
    SQLite/R2 (NOT via VM heap — assert snapshot size does not grow with fs contents);
    `readFileSync`-style sync shims either return host-cached data or throw (never silently
    block).
17. **SharedArrayBuffer trap (§8)**: if a thread-detecting library is in scope, assert the shim
    DELETEs `SharedArrayBuffer` so libraries fall back to clean single-threaded paths rather
    than half-detecting threads and breaking.

---

## 8. Notable traps & sources

- **SharedArrayBuffer-without-Atomics**: the ctor exists so allocating a SAB won't throw, but
  `Atomics` is undefined — any library probing for real shared-memory threading half-detects
  support then breaks. A shim should **delete `SharedArrayBuffer`** to force clean
  single-threaded fallbacks (threads are impossible here anyway).
- **Async-cell value preview**: a bare async IIFE's top-level return previews as `{}` (the
  documented unwrap race in `evalCode`/`_drivePromise`), but `console.log` capture inside the
  async body works — async logic RUNS correctly; only the returned-value preview is lossy.
- **State outside WASM memory does NOT auto-snapshot** — host-side shim state (virtual fs,
  `process.env`, open handles) must be serialized into the manifest + re-hydrated, OR
  reconstructed deterministically on cold wake (`ctx.kv` is the reference pattern).

**Sources:** `v0.5/src/glue.js` (WASI factory 239-253; REBIND_SRC 257-327; host fns 352-482;
fetch pump 901-936; size guards 49-83), `v05/wrangler.jsonc:6-7`, live
`WebAssembly.Module.imports(quickjs.wasm)` (6 WASI + 6 env hooks),
`v05/node_modules/quickjs-wasi/extensions/{crypto,encoding,url,structured-clone,headers}/*.so`,
`node_modules/quickjs-wasi/dist/index.d.ts` (`extensions?` line 240, `moduleLoader?` line 200),
`extensions.d.ts:94-101` (snapshot re-instantiation), `docs/results/v0.5-observability.md`
(fuzz/no-escape, AE schema, ops).
