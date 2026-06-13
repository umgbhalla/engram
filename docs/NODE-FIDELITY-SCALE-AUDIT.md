# Engram — Node-Fidelity & Scale Audit

> Workflow `engram-node-parity-scale-audit` (run wf_c06843d4-e14). 64 agents, 4.1M tokens, ~22min.
> 22 API areas · 388 features · 36 adversarial revisions · 19 scale dims.

Status distribution: 97 real · 70 stub-acceptable · 89 stub-unacceptable · 54 partial · 60 absent · 18 impossible.

---

The net/tls REVISE is confirmed: net/tls are in BOTH the excluded list AND the default stdlib preload — so require('net')/require('tls') resolve to working client shims by default (the __mods check precedes the excluded-list throw), exactly as the correction states. Queue backpressure confirmed. I have enough verification to write the canonical report.

The corrections are internally consistent and load-bearing constants all check out. Synthesizing the final audit now.

---

# ENGRAM — CANONICAL NODE-FIDELITY & SCALE AUDIT

*Auditor's note: all per-area `! REVISE` corrections are applied below. Every load-bearing constant was re-verified live against `apps/kernel/src/kernel-glue.ts`, `apps/kernel/src/lib.rs`, `apps/kernel/engine/src/lib.rs`, and `apps/kernel/src/stdlib-meta.ts` (net/tls dual-listed as both excluded AND default-preloaded → functional client shims by default, confirmed; queue-reject path confirmed; all scale constants confirmed exact).*

---

## 1. Executive Verdict

Engram **is** a durable, hibernating, single-tenant-per-DO **stateful JS REPL** whose QuickJS-WASM linear-memory heap is the durable resumption primitive, wearing a deterministic **Node-v20-*shaped* compat facade** that is genuinely good at the pure-compute, in-heap surface: TypedArray/Buffer, events, path/url/querystring, assert, EventEmitter, the WHATWG fetch *happy path*, lodash/zod/uuid, TS type-erasure, and content-addressed Worker-Loader compute. It **is NOT real Node and is NOT a security sandbox**: it has no OS process model, no listen socket, no real threads, no CSPRNG (crypto is a seeded LCG — *predictable by design*), no wall-clock timers (every `setTimeout`/`AbortSignal.timeout` delay is silently ignored), no real `vm` context isolation (`runInNewContext` runs in the same realm), and a Node-shaped `fs`/`net`/`tls`/`http` surface that is honest at the edges but riddled with silent-wrong-output traps (ucs2/base64url `Buffer.toString`, `printf`-style `console.log`, `mtime:0` everywhere, FormData→urlencoded-not-multipart, namespace-miscompile). The whole thing rides on **one mechanism** — a monotonic WASM linear-memory buffer — which makes hibernation/restore work but imposes a hard, non-negotiable ~24–28 MB *incompressible* heap ceiling above which the DO is **uncatchably killed (WS-1006)**. Treat engram as a Node-flavored deterministic compute kernel for trusted code, never as a drop-in Node runtime and never as a multi-tenant isolation boundary at the VM layer.

---

## 2. Parity Matrix

### (a) IMPOSSIBLE — hard platform/substrate constraint, cannot be built

| Feature | Driving constraint | Evidence |
|---|---|---|
| `child_process` (entire module) | No OS process model; no fork/exec in WASI/CF | engine/lib.rs:2225,2250,2322 |
| `cluster` (entire module) | No multi-process, no IPC; "Alternative: none" | engine/lib.rs:2225,2251 |
| `worker_threads` (entire module) | Single-threaded WASM; 2nd memory can't be co-snapshotted | engine/lib.rs:2225,2252 |
| `dgram` / UDP | cloudflare:sockets is TCP-only | engine/lib.rs:2225,2247 |
| `net.Server`/`createServer`/`listen` (inbound TCP) | DO has no listen()/accept(); throws EPERM | net.js:540-542; host-sockets.mjs:329 |
| `tls.Server`/`createServer` (inbound TLS) | Same — no inbound socket | tls.js:118-120 |
| `http.createServer`/`https.createServer` | DO is a request-handler, never a listener | engine/lib.rs:2081 |
| Unix-domain sockets (`connect({path})`) | No shared Unix namespace, no peer process | net.js:226-228 |
| `tls.exportKeyingMaterial()` | TLS terminates host-side; key material never reaches VM | tls.js:59 |
| `fs.watch`/`watchFile` | No inotify/kqueue; frozen in-turn clock; no event loop | engine/lib.rs:2516-2547 |
| `process.binding()` | No C++ V8 bindings layer | engine/lib.rs:856 |
| `vm.measureMemory` exact-isolation / true 2nd realm | rquickjs exposes one Context (note: *async_hooks family is NOT here — see (e)*) | engine/lib.rs:2143-2153 |

### (b) STUB — UNACCEPTABLE (silent-bite risks, ranked by blast radius — HIGHEST FIRST)

| # | Feature | Silent bite | Driving cause | Evidence |
|---|---|---|---|---|
| 1 | **`vm.runInNewContext` / `createContext` / `vm.Script`** | "Sandboxed" code runs in the **same realm** — full `globalThis` access, prototype pollution escapes. Any template engine / isolated-vm user gets **zero isolation, silently**. | Single QuickJS realm | engine/lib.rs:2147,2240 |
| 2 | **`crypto.getRandomValues` / `randomUUID` / `randomBytes`** | Backed by a 64-bit **LCG, not a CSPRNG**. Tokens/keys/nonces are **predictable**; identical seed → identical "random". API surface identical so it never fails — just insecure. | Determinism invariant | engine/lib.rs:184-188,363-376 |
| 3 | **`AbortSignal.timeout(ms)` / `setTimeout`/`setInterval` delay** | `ms` **silently ignored**; aborts/fires on next microtask. `fetch(url,{signal:AbortSignal.timeout(5000)})` aborts immediately; `setInterval(fn,1000)` fires all iterations in one turn. Every real-timeout pattern broken. | No wall-clock in WASM | engine/lib.rs:863,953,871-875 |
| 4 | **TS `namespace`/`module` declarations** | sucrase **erases the body** and emits surrounding code → `N.x` throws **runtime ReferenceError**. A *silent miscompile*, not the clean reject the stale docs claim. | No code-gen transform; stale guard | (empirical sucrase; kernel-glue.ts:1531 comment STALE) |
| 5 | **`printf`-style `console.log` (`%s`/`%d`/`%j`/`%o`)** | No format substitution: `console.log('x=%d',42)` → `'x=%d 42'`. `util.format` exists but is **not wired** into console. Widespread wrong output. | Wiring gap (not a constraint) | engine/lib.rs:724-731 vs 1554 |
| 6 | **`Buffer.toString('base64url'/'ucs2'/'utf16le')` + `start/end` slice** | Falls through to `TextDecoder` → **garbled output**, no error. JWT/URL-token/UTF16 round-trips corrupt silently. | toString switch gaps | engine/lib.rs:1357-1365 |
| 7 | **`buf.write('…','ucs2'/'utf16le')`** (was rated "real" → **downgraded to partial/unacceptable**) | ucs2/utf16le silently encode as UTF-8 → data corruption, no error. | TextEncoder fallback at line 1451 | engine/lib.rs:1442-1456 |
| 8 | **`Buffer instanceof Buffer` / `isBuffer` asymmetry** | `Buffer.from([]) instanceof Buffer === false` (factory, not Uint8Array subclass). Libraries with `x instanceof Buffer` fast-paths mis-classify. | No class-extends-Uint8Array | engine/lib.rs:1461,1510 |
| 9 | **`Buffer.from(base64)` strict (`atob`)** | Unpadded/whitespace base64 (JWTs, auth headers) **throws** where Node tolerates. | No strip-and-pad before atob | engine/lib.rs:1465 |
| 10 | **`FormData` as fetch body** | Encoded as **urlencoded, not multipart**; Blob/File → literal `'[blob]'`. File uploads send wrong data silently. | multipart not implemented | engine/lib.rs:970-973 |
| 11 | **`fetch` `redirect:'manual'`/`'error'`** | Stored but never forwarded; host always follows. Opaque-redirect / fail-on-redirect logic silently broken. | sendInit drops redirect | engine/lib.rs:1080 |
| 12 | **`Headers.getSetCookie()` absent + Set-Cookie comma-merge** | `getSetCookie()` throws; multiple Set-Cookie collapse to one comma-joined string. Cookie-jar code breaks. | spec addition not built | engine/lib.rs:516-538,528 |
| 13 | **`fs.readdir({withFileTypes:true})` under R2** | Returns plain strings, not Dirent → `isDirectory()` throws. isomorphic-git/glob mis-behave. | R2 list returns names only | engine/lib.rs:2446 |
| 14 | **`fs.renameSync` of a directory (VFS) + R2 rename non-atomic** | Only the dir key moves; **child files orphaned silently**. R2 rename = read+write+delete (doubles RAM, non-atomic). | Flat key store, no tree | engine/lib.rs:2393,2533 |
| 15 | **`stat().mtimeMs` / atime/ctime/birthtime** (REVISED — *worse than inventoried*) | In-VM `fs.stat` under R2 returns **mtimeMs:0 always** (the created_ms→mtime mapping is only in the SDK out-of-band `vfs-stat` frame, not the engine fs API). All build-tool/git mtime ordering breaks totally. | Determinism + no inode table | engine/lib.rs:2395; lib.rs:4479-4493 |
| 16 | **`existsSync` under R2** | Throws `ERR_FS_ASYNC_ONLY` synchronously instead of returning false → breaks every `if(!fs.existsSync(p))` guard. | No sync host IO | engine/lib.rs:2517 |
| 17 | **`symlinkSync`/`readlinkSync`** | symlink writes target as a plain file; readlink always `EINVAL`. pnpm/git symlink semantics silently wrong. | No inode/symlink table | engine/lib.rs:2396-2400 |
| 18 | **`process.env`** | Always `{}` — **no config path injects it**. `process.env.NODE_ENV`/dotenv always undefined (React dev/prod mis-detect). | Hook exists, never called | engine/lib.rs:769,779; kernel-glue.ts:1216-1253 |
| 19 | **`process.exit()` / `process.abort()` / `process.kill()`** | exit/abort throw a **catchable** error (outer try/catch swallows → code continues); kill() returns true for any pid (lies to liveness probes). | No process to kill | engine/lib.rs:827-834 |
| 20 | **`process.on('exit'/'uncaughtException'/'unhandledRejection'/'warning')`** | Listeners stored, **never fired**. Cleanup/safety-net handlers silently dead. | No lifecycle wiring | engine/lib.rs:835-848 |
| 21 | **`process.hrtime`/`uptime`/`memoryUsage`/`cpuUsage` + `performance.now`/`timeOrigin`** | hrtime ms-only (sub-ms always 0), epoch-based not uptime; memory/cpu return all-zeros; **`performance.timeOrigin` is `undefined` not 0** (dead-code branch) → `timeOrigin+now()` = **NaN**. | Seeded clock; no perf feature | engine/lib.rs:201,814-823 |
| 22 | **`TextDecoder` non-UTF-8 labels** | latin1/utf-16le/windows-1252 silently decode as UTF-8 → garbled. No `fatal` mode. | No ICU | engine/lib.rs:409-426 |
| 23 | **`util.isDeepStrictEqual` / `assert.deepStrictEqual`** | Symbol-keyed props skipped; **Set deep-equality uses `b.has(v)` reference identity** → `Set<{a:1}>` comparisons wrongly fail. Silent wrong pass/fail in test suites. | Object.keys-only | engine/lib.rs:1612-1643 |
| 24 | **`Writable.write()` always returns true / `unpipe()` no-op** | No backpressure — producers never pause, unbounded buffering until tick-budget/OOM. unpipe silently keeps flowing. | No highWaterMark | engine/lib.rs:1751,1741 |
| 25 | **`http.IncomingMessage` is EventEmitter, NOT Readable** (REVISED) | **No `.pipe`/`.read`**; single-shot `data` event from buffered body. Cannot pipe an http response anywhere; `opts.auth` dropped (401); `setTimeout`/`signal`/`abort` no-ops. | host.fetch is buffered round-trip | engine/lib.rs:2043-2075 |
| 26 | **`http`/zlib streaming (`createGzip`, chunked SSE)** | http buffers whole body; zlib has no Transform classes → `zlib.createGunzip is not a function`. tar.gz piping breaks. | Not built | engine/lib.rs:1974-1985,2067-2075 |
| 27 | **zlib compression `opts.level`/strategy** | Silently ignored — always fixed-Huffman. `level:9` does nothing. | Single-strategy DEFLATE | engine/lib.rs:1963 |
| 28 | **TLS cert/key/ca/`rejectUnauthorized`/SNI/ALPN** | All accepted, **all ignored**. `rejectUnauthorized:false` has no effect; mTLS client certs dropped; `getPeerCertificate()={}`, `authorized=true` always; `alpnProtocol=false` always (h2/gRPC mis-detect). | TLS terminates host-side | tls.js:15,51-60; host-sockets.mjs:147-153 |
| 29 | **socket `setTimeout`/read-block durability** | `setTimeout` never fires; an idle peer **parks the read forever** → cell never completes, mutex never released. Sockets die on hibernation → stale `ECONNRESET`. | No abort channel; sockets not snapshotted | net.js:7-13,521; host-sockets.mjs:267 |
| 30 | **`error.stack` (V8 format) + `Error.captureStackTrace`/`prepareStackTrace`** | QuickJS stack format diverges; the V8 API is **absent** → Sentry/source-map-support/callsites throw or mis-parse. | QuickJS ≠ V8 | engine/lib.rs:2253,3305 |
| 31 | **REPL top-level `async function` declaration** | Transform **bails** → indirect eval → binding vanishes next cell. Silent non-persistence. | Tokenizer conservative bail | repl-transform.ts:192 |
| 32 | **TS decorators** (REVISED mechanism) | sucrase passes `@deco` **verbatim**; QuickJS-ng has no decorators → **hard SyntaxError** (socket alive). SESSION-SUMMARY.md falsely advertises support. | No decorator transform | kernel-glue.ts:46 |
| 33 | **`stream/web`, `ReadableStream.tee/pipeThrough`, `WritableStream`/`TransformStream`** | `require('stream/web')` returns Node streams not WHATWG (undefined destructure); tee/pipeThrough throw. | WHATWG streams not shimmed | engine/lib.rs:263-313,2163 |
| 34 | **Async EventEmitter listener rejections** | Swallowed — no `unhandledRejection`, no captureRejections. Errors silently lost. | No engine rejection hook | engine/lib.rs:1534,835 |
| 35 | **Sandbox R2 VFS isolation** | Prefix is a **path view, not an ACL** — a container breakout reaches the WHOLE bucket. Isolation relies solely on one-DO-per-session. | s3fs credential-less mount | sandbox/index.ts:33-41 |
| 36 | **`SharedArrayBuffer`+`Atomics.wait`** | SAB constructible, `Atomics.wait` returns 'not-equal' (never blocks). Thread-detecting libs activate broken multi-thread paths. | No real threads | engine/lib.rs:223-239 |
| 37 | **`console.table`** | Just dumps `__preview`, not an ASCII table; `properties` filter ignored. | Implementation gap | engine/lib.rs:1332 |
| 38 | **`util.promisify.custom`** (REVISED → acceptable-leaning but bites) | Honors a **non-standard string** `__promisify_custom`, ignores the canonical `[util.promisify.custom]` Symbol → libraries' custom promisify silently bypassed. | Wrong key | engine/lib.rs:1594-1595 |

### (c) STUB — ACCEPTABLE (honest degradation, low bite)

`process.platform/arch/version/versions` (hardcoded linux/x64/v20.11.1) · `process.argv/pid/title/config/features` · `process.nextTick`/`setImmediate`/`clearTimeout`/`clearInterval` (microtask-correct) · `process.stdout/stderr.write` (→console) · `os.platform/arch/EOL/homedir/tmpdir/endianness` · `util.format`/`deprecate`/`debuglog`/`inherits`/`callbackify` · `TextEncoder` (UTF-8 only — Node is too) · `assert/strict` alias · `fs.statSync` subset (size+isFile/isDir) · `mkdir`/`copyFile`/`access`/`realpath`/`fs.constants` · `gzipSync`/`gunzipSync`/`deflate*Sync` (RFC-valid, opts ignored) · `brotli*` (clean NotSupportedError) · `console.dir`/`assert`/`group`/`groupEnd` · `vm.runInThisContext` · `Atomics` single-thread ops · `structuredClone` (no transfer; Error→`{}`; non-DOMException error name) · `AbortController` core · `Blob`/`File` · `socket.setNoDelay`/`setKeepAlive`/`ref`/`unref` (no-ops) · `net.isIP*` · TLS `getSession`/`getCiphers`/`checkServerIdentity`/`rootCertificates` · `process.umask`/`getuid`/`emitWarning` · `path.posix` · `url.pathToFileURL` · `timingSafeEqual` · `const enum` (REVISED → **acceptable**: lowers to runtime object, persists via `var`, only loses the cross-file inline optimization — zero behavioral diff in a REPL) · `worker source persistence across cold-restore` (REVISED → **acceptable**: registry_workers is standard durable DO SQLite, survives reset, only a missing test) · REPL `export` (REVISED → **acceptable**: matches Node's own REPL SyntaxError) · `console.count`/`time`/`trace`/`clear` (absent-but-clean-TypeError).

### (d) REAL (Node-faithful for realistic use)

`Buffer.from/alloc/concat/byteLength/compare/isEncoding` + full read/write numeric matrix + `copy`/`equals`/`indexOf`/`fill`/`toJSON` · all ES2020 TypedArrays/DataView/Float16Array · `EventEmitter` full surface (REVISED note: `.on()` is Node-correct; `.once()` *does* fire 'newListener' with the wrapped fn — minor divergence; default maxListeners=10 correct) · `path.*` POSIX full set · `querystring.*` · `url.parse/format/resolve`/`urlToHttpOptions` · `assert.*` (except deep*) · `util.promisify`/`callbackify`/`inherits`/`types` (partial set) · **WHATWG `fetch` happy path** (full Response, streaming body via fetchStream, SSRF-safe, AbortSignal wired — *one mechanism note: routes through `host.fetchStream`/`_doFetchStream`, not `_doFetch`*) · `queueMicrotask` (native rquickjs job queue) · `process.cwd`/`chdir` (REVISED **partial→REAL**: in-VM fs norm() resolves every path against `__cwd` before the host frame, so chdir is effective end-to-end + /workspace jail enforced) · TS type-erasure (annotations/interfaces/generics/`as`/`satisfies`/`declare`/`abstract`/enum/`import type`) · **TS parameter properties** (REVISED **absent→REAL**: sucrase correctly lowers `constructor(private x)`) · `globalThis`/`global` alias · REPL var/let/const/function/class persistence + reserved-host-global shadowing + `_` last-value · bare top-level assignment persistence (REVISED — the load-bearing primitive) · seeded clock/`Math.random` determinism + entropy-counter persistence across restore · VFS in-heap durability across hibernate · **Tier-1 Worker-Loader registry** (sha256 content-address, `globalOutbound:null` egress-block, per-session VFS gateway, codeId warm-cache isolation by doIdShort, cpuMs/wall caps, post-invoke reconcile) · sandbox `exec`/`expose` (REVISED rationale: expose IS in-cell-wired)/`mount`/`unmount` · `process.chdir` jail · stack-overflow guard catchability.

### (e) ABSENT — buildable (not a hard constraint), not built

| Feature | Why absent | Buildable because |
|---|---|---|
| **`async_hooks`/`AsyncLocalStorage`/`AsyncResource`/`createHook`** (REVISED **impossible→absent**) | Never built; off the radar | **The vendored rquickjs ships PromiseHook bindings (Init/Before/After/Resolve)** — the exact analogue Node builds these on. Non-trivial but buildable. Breaks OpenTelemetry/Sentry/cls-hooked at import today. |
| `crypto.subtle.sign/verify/generateKey/encrypt/decrypt` · `createSign`/`createCipheriv`/`createDiffieHellman`/`createECDH`/`KeyObject` | Determinism + no pure-JS asymmetric/AES lib shipped | Pure-JS bundle injectable (snapshot cost) |
| `createHash('sha512'/'sha384')` sync | Gated despite `__sha512` existing; `getHashes()` lies (lists them) | One-line ungate; impl present at engine/lib.rs:692 |
| `vm.compileFunction`/`SourceTextModule`/`SyntheticModule` | Not plumbed | QuickJS Module.declare exists (used by `use()`) |
| `util.parseArgs`/`styleText`/`MIMEType`/`getSystemErrorName` | Scope omission | Pure JS |
| `events.on` async-iterator / static `setMaxListeners`/`getEventListeners`/`addAbortListener`/captureRejections | Scope omission | Pure JS |
| `timers`/`timers/promises` modules · `clearImmediate` (empty no-op) | Not registered | Globals exist; wrap them |
| `os.cpus`/`totalmem`/`networkInterfaces`/`availableParallelism` (return 0/[]/throw) | No sysinfo | Could return plausible constants |
| `performance.mark`/`measure`/`getEntries` | Minimal perf object | Pure in-heap timeline |
| `stream.compose`/`addAbortSignal`/`toWeb`/`fromWeb` | Not built | Pure JS on existing pipeline |
| `url.domainToASCII`/`fileURLToPath` percent-decode | identity stubs | punycode lib / decode step |
| `URL` mutable setters / live `searchParams` sync | polyfill data-props only | defineProperty setters |
| ramda/date-fns/immer/decimal.js/js-yaml/papaparse/marked/rxjs | Dropped in Rust-kernel port | Re-add to bundle (≤500 KB cap) |
| sandbox `exec-stream`/`git` (non-checkout)/`mkdir`/`delete` | Container has them; not wired through WS-frame dispatch | Protocol/dispatch wiring |
| `process.send`/IPC, `globalThis.window`/`self` | Node-target by design | trivial |

---

## 3. Scale Table (sorted by blast radius; ⚠ = dangerous/uncatchable)

| Dimension | Unit | Soft limit | HARD limit | Failure mode | Basis |
|---|---|---|---|---|---|
| ⚠ **Incompressible heap / snapshot dump** | MB raw incompressible (=max(usedHeap, buf−31MB scratch)) | ~24 MB (guard) / doc-safe ≤20 MB | **~28 MB = true OOM cliff**; guards: 24 MB incompressible reject, 50 MB used-heap, 76 MB raw-buffer | **Below 24 MB guard → at ~28 MB: UNCATCHABLE WS-1006 DO kill, silent loss.** With guard: typed SizeAdmissionError, socket alive. Compressible heap safe to 40 MB+ (gz crushes it). | code-const + measured-doc |
| ⚠ **Used-heap admission** | MB QuickJS memoryUsedSize | ~20 MB (≤4 MB/cell steps) | 50 MB (MAX_USED_BYTES typed gate); effective ~24 MB incompressible | Typed reject at 24/50 MB. **~28 MB incompressible (native .fill bomb outrunning the tripwire) → WS-1006 below the guard.** | code-const |
| ⚠ **Monotonic-buffer extreme scale** | MB linear buffer | — | **~256 MB** | **Reproducible unrecoverable DO-kill** (WASM memory monotonic; no compaction). | measured-live (v0.5) |
| ⚠ **Per-cell tick/interrupt budget** | ticks/turn | 1200 (only value trapping ALL loop shapes) | **~1600 = workerd throttle floor**; v2 default 500000 | **A truly tight CPU loop (`for(;;)x+=i`) above the floor outruns the throttled callback → platform 30s CPU limit → WS-1006 uncatchable.** Bytecode-heavy loops: typed TimeoutError, socket alive. v2 ships 500000 (won't fence tight loops). | measured-doc |
| ⚠ **Recursion depth** | JS frames | ≤~1500 | **~2000** (set_max_stack_size 256 KiB) vs native 8 MiB | At guard: **catchable error but in-place recovery FAILS — session wedged, needs reset/reconnect** (the one documented in-place-unrecoverable wedge). Above guard (if raised): uncatchable RuntimeError:unreachable WS-1006. | code-const |
| ⚠ **Per-file fs READ** | MB raw body | ≤8 MB | ~32 MB scratch ceiling (~24 MB after base64) | **Body > scratch is SILENTLY TRUNCATED on read (no error, partial bytes).** Write: up to ~5 GiB R2 PUT, no cap. | code-const |
| ⚠ **Total fs bytes / file count** | MB/file + count | ≤8 MB/file, ≤~1000 files | 24 MB/frame ingress; count unbounded (DO ~128 MB RAM) | **Frame >24 MB silently dropped (`{type:'overflow'}`).** Big-file RMW assembles whole object in DO RAM → 1102/WS-1006. High file count → O(n) latency then RAM pressure. | code-const |
| **Snapshot stored size / SQLite↔R2 routing** | MB gz | ~6–8 MB gz (SQLite hot path) | 8 MB gz = R2 route (NOT reject); real wall = ~24–28 MB raw incompressible | 8 MB gz = silent store-switch (+600–900 ms R2 GET on cold restore), no error. | code-const |
| **Cold-restore latency** | ms by image | ≤7 MB raw (sqlite path): p50 180 ms / p99 640 ms | 76 MB raw = typed reject; 8 MB gz = R2 overflow (R2 GET 597–1045 ms → RTT 2.7–4.6 s) | Graceful latency, then typed SizeAdmissionError at 76 MB. | measured-live |
| **Deep-eviction cold-wake tail** | ms | ~1.3–1.8 s | ~16.6 s kernel-owned R2-read leg (4×4s+backoff→oplog-replay) | Latency only; **state always survived (7/7, zero loss)**. ~95% platform WS-connect+spin-up (~945–1036 ms). | measured-live |
| **Concurrent evals / racers per DO** | evals/DO | 16 in-flight (1+15 queued); fleet 80 sessions+200 racers = 0% err | **17th eval rejected** (depth≥16) | **Typed QueueFullError JSON, socket alive, retryAfter 250 ms — NOT a kill.** | code-const (commit 0eadc03) |
| **Mid-cell grow tripwire** | MB/cell | ~32 MB | 64 MB (1024 pages, v2 default) | Typed MemoryLimitError, socket alive (mid-cell + post-cell backstop). Native-builtin alloc bombs can outrun it → falls to outer fences. | code-const |
| **Injected stdlib source cap** | KB source | ~184 KB (shipped default) / doc ≤500 KB | 500 KB (512000 B) → SizeAdmissionError pre-injection | Typed reject, fail-closed. Proxy for the real ~24–30 MB raw OOM cliff via ~12–29× amplification. | code-const |
| **Fetch egress** | calls/cell | ≤~63 buffered | **64 host.fetch/cell** (maxHostCallsPerCell); body 2 MB (→32 MB env) | **64-call cap = SILENT: loop stops resuming, in-flight promise never resolves, partial result returned (socket alive).** Body over cap = silent truncation (`truncated:true`). Blocked host = typed rejected promise. **v2 default allowlist = ALLOW-ALL (SSRF/cost footgun).** | code-const |
| **WASM import ceiling** | imports | 9 used / ~22 shim-satisfiable | **9** (all wasi_snapshot_preview1) | Build/link-time wall — a 10th OS primitive → LinkError at instantiate (typed, socket alive). 0 headroom for real fs/sockets/threads. | measured-live |
| **Worker-loader warm cache** | distinct codeIds/isolates | ~150 sessions (val. 1500) | No engram cap; platform cache eviction (undocumented) | Eviction = latency only (cold re-instantiate, stateless). Engram rejects upstream: 512 KB source / 1 MB io / NotRegistered — all typed. | code-const |
| **Multi-tenant facets/supervisor** | facets/shard | ~150 sessions clean | **128/shard × 64 shards = 8192** (even FNV-1a only) | Typed reject at 128/shard before insert. **Noisy-neighbor: sessionId-only sharding lets one tenant fill a shard's 128-cap.** | code-const |
| **SQLite value/chunk limits** | B/value + chunks | 64 KB/chunk, 1.5 MB/oplog value | **~2 MB/bound value (SQLITE_TOOBIG)**; 8 MB gz=128 chunks→R2 | Oversized oplog → non-replayable marker (graceful). **Delta-payload BLOB bound unchunked → >2 MB throws SQLITE_TOOBIG mid-commit, torn-manifest risk** (bounded by 24/45 MB admission, not explicitly clamped). | code-const |

---

## 4. The Load-Bearing Constraints (everything derives from these 6)

1. **Monotonic WASM linear memory** — the *one* mechanism that makes hibernate/restore work is also the source of every dangerous cliff: heap never shrinks in place, so the ~24–28 MB incompressible ceiling and ~256 MB unrecoverable kill exist; drives all size-admission guards, the arena scrub, and the SQLite-vs-R2 routing.
2. **12-import WASM ceiling (9 actually imported)** — no OS surface can be added without re-linking the precompiled CompiledWasm engine; workerd forbids runtime `WebAssembly.compile`. This *is* why there are no real sockets/fs/threads — they're absent primitives, not unwired ones.
3. **Determinism invariant (ADR-0002)** — forbids real entropy and real clocks: crypto is a seeded LCG, every timer delay is ignored, `Date.now`/`performance.now` are +1ms-per-call counters. Required so the heap snapshot replays byte-identically.
4. **No listen socket on CF DO** — structurally kills all inbound networking (`net.Server`/`http.createServer`/`tls.Server`); the DO is only ever a request-handler. cloudflare:sockets is outbound-TCP-only (6-concurrent cap, no keepalive, no read timeout).
5. **Single-heap serial eval (one QuickJS realm, one mutex)** — gives the 16-deep eval queue, makes `vm.runInNewContext` un-isolatable (same realm), makes a parked socket read deadlock the session, and serializes all host I/O through one `__settleHost` slot.
6. **No real threads / no V8 internals** — no `worker_threads`/`cluster`/`Atomics.wait`/`SharedArrayBuffer` blocking; QuickJS stack format ≠ V8 (no `Error.captureStackTrace`); async_hooks family is *buildable* via the vendored PromiseHook but currently absent.

---

## 5. Top 5 Unacceptable Gaps to Fix + 3 Dangerous Scale Cliffs

### Fix these 5 first (each is a silent-bite, cheap-ish, high blast radius):

1. **Wire `util.format` into `console.log`** — closes the #1 most-common silent wrong-output (`%d`/`%j`/`%s` substitution). The function already exists at engine/lib.rs:1554; pure wiring, zero constraint. *(Also fixes `console.assert`.)*
2. **Add `base64url`/`ucs2`/`utf16le` + `start/end` to `Buffer.prototype.toString` and fix `buf.write` ucs2/utf16le** — closes silent data corruption for JWTs/URL-tokens/UTF16 round-trips. ~4 switch branches at engine/lib.rs:1357-1365 & 1451.
3. **Convert TS `namespace`/`module` from silent miscompile → clean reject** — sucrase currently erases the body and emits surrounding code → runtime ReferenceError. Detect the SyntaxKind pre-eval and throw a typed `TypeScriptError` (socket alive). Also delete the stale "decorators supported" claim in SESSION-SUMMARY.md:30.
4. **Inject `process.env` from `config.env`** — the hook exists (engine/lib.rs:769,779) but no glue path populates it; every NODE_ENV/dotenv-gated library is silently broken. ~2 lines in `_applyConfig` (kernel-glue.ts:1216).
5. **Flip the default fetch allowlist to block-all (or require explicit `config.fetch`) and tighten the silent-truncation paths** — v2 ships **ALLOW-ALL** (kernel-glue.ts:1246), an SSRF + cost footgun; pair with surfacing the 64-host-call cap and >2 MB body truncation as typed errors instead of silent partial results.

*(Honorable mention, security-critical: document loudly that `vm.runInNewContext` and `crypto.getRandomValues` provide NO isolation and NO cryptographic randomness — these are the two most dangerous "looks like it works" surfaces for anyone treating engram as a sandbox.)*

### 3 scale cliffs that are still UNCATCHABLE (WS-1006 / silent loss) — units explicit:

1. **The ~28 MB incompressible-heap OOM cliff** — a native-builtin alloc bomb (e.g. `.fill` on a huge TypedArray) emits no bytecode between interrupts, outruns the mid-cell tripwire, and pushes raw linear memory past ~28 MB *below* the 50 MB used-heap guard → the dump's ~2–3× transient OOMs the DO uncatchably. **Plus the separate ~256 MB monotonic-buffer kill** (single session, unrecoverable, WASM memory monotonic). *No in-kernel fix exists short of value-serialization that would lose promise/closure fidelity.*
2. **The tight-CPU-loop tick-budget escape (~1600 ticks/turn floor)** — `for(;;)x+=i` above the workerd interrupt-throttle floor rides past the budget to the platform 30s CPU limit → WS-1006. The v2 default budget (500000) does **not** fence it; only ~1200 ticks would, but that false-trips legit big-payload cells. Genuinely unsolvable at the budget layer.
3. **Per-file fs READ silent truncation at the ~32 MB scratch ceiling + >24 MB frame silent drop** — a file body larger than scratch comes back **partial with no error** (data loss masquerading as success), and an inbound frame >24 MB is dropped with only a `{type:'overflow'}` marker. Not a crash, but silent loss — arguably worse than a WS-1006 because the caller never learns. *(Recursion's ~2000-frame in-place wedge is a 4th, milder edge: catchable but the session is unrecoverable without reset/reconnect.)*

---

*Canonical map complete. Files of record: `apps/kernel/src/kernel-glue.ts`, `apps/kernel/src/lib.rs`, `apps/kernel/engine/src/lib.rs`, `apps/kernel/stdlib-src/shims/{net,tls}.js`, `apps/kernel/src/{repl-transform,stdlib-meta,host-sockets}.ts/.mjs`, `apps/sandbox/src/index.ts`, `apps/cloud/src/supervisor.ts`, `docs/SYSTEM-LIMITS.md`, `docs/results/{SUMMARY,v0.4-coldstart,v0.5-observability,deep-hibernation,v0.6-stdlib,v0.7-guards}.md`, `docs/ENV-SURFACE-POLICY.md`.*


---
## Appendix A — Full Scale Table

| Dimension | Unit | Soft limit | Hard limit | Failure mode @ limit | Basis |
|---|---|---|---|---|---|
| Snapshot dump ceiling — raw linear-memory image at SAFE_SERIALIZE / th | MB raw linear-memory image (incomp | 24 MB raw incompressible content — the in-kernel guard INCOM | ~28 MB raw incompressible heap = the genuine OOM cliff (WS-1 | Two-tier. At the 24 MB soft guard and the 76 MB absolute cap: typed Si | measured-doc |
| Snapshot stored size (compressed base image, gz/zstd) — SQLite-vs-R2 r | MB gz/zstd (compressed stored imag | ~6-8 MB gz. <8 MB gz stays in DO SQLite (64KB-chunked rows), | ~24 MB gz (incompressible) is the typed-reject wall; underly | At 8 MB gz SQLITE_HOT_MAX = NOT a failure, just a store switch from DO | code-constant |
| Used-heap admission (QuickJS memoryUsedSize / MAX_USED_BYTES) | MB QuickJS memoryUsedSize (memory_ | ~20 MB used heap, accumulated in ≤4 MB-per-cell steps (stay  | 50 MB (MAX_USED_BYTES, the typed SizeAdmissionError gate) —  | Two-tier. At 50 MB used heap: typed SizeAdmissionError, socket alive,  | code-constant |
| Incompressible-buffer ceiling (INCOMPRESSIBLE_BUFFER_CEILING + the 31M | MB of genuine incompressible conte | ~24 MB incompressible (INCOMPRESSIBLE_BUFFER_CEILING_BYTES = | ~28 MB incompressible raw — the uncatchable WS-1006 cliff. A | TWO regimes. (1) WITH the guard (current code): a typed, RECOVERABLE r | code-constant |
| Cold-restore latency — ms by image size (p50/p95/p99) | ms (cold-wake round-trip), keyed b | Stay on the SQLite hot path: snapshot gz <= 8MB (SQLITE_HOT_ | No typed reject on latency itself — it degrades, then the im | Graceful-then-typed. (1) Crossing 8MB-gz SQLITE_HOT_MAX = pure latency | measured-live |
| Deep-eviction cold-wake tail (full DO eviction, socket CLOSED >10min,  | ms (client-observed cold-wake roun | ~1,300-1,800 ms safe operating envelope for the felt deep co | ~16,600 ms worst-case kernel-owned ceiling on the R2-read le | Just latency / graceful degradation at the soft+practical limit — NOT  | measured-live |
| Concurrent sessions / racers per kernel isolate | count of concurrent evals per Kern | 16 in-flight/queued evals per KernelDO (DEFAULT_MAX_EVAL_QUE | 17 concurrent evals queued at one KernelDO (the 17th, i.e. d | At the per-DO queue cap: TYPED REJECT — `QueueFullError` JSON ({queueD | code-constant |
| Eval-queue backpressure depth (per-session in-flight VM-serialized fra | in-flight frames (create/eval/flus | 16 in-flight frames — the full admitted depth (1 executing u | 17 in-flight frames — the 17th concurrent frame is rejected. | Typed reject (clean, socket stays alive). The 17th frame returns `{ok: | code-constant |
| Per-cell interrupt/tick budget (the workerd interrupt-throttle floor) | interrupt ticks (interrupt-handler | 1200 ticks/turn — the only budget measured to trap EVERY inf | ~1600 ticks/turn (the workerd host-interrupt-callback thrott | Bimodal. (1) Bytecode-heavy / value-touching loop that keeps re-enteri | measured-doc |
| Mid-cell used-heap growth tripwire (per-cell linear-memory delta) | MB per-cell growth (and absolute b | ~32 MB per-cell growth in v2 (one fetch body up to SCRATCH_C | 64 MB per-cell growth (1024 WASM pages x 64KB) in the CURREN | Typed, recoverable reject: MemoryLimitError ("cell grew linear memory  | code-constant |
| Recursion depth — JS stack frames before catchable overflow | JS stack frames | ≤~1500 JS frames — stay comfortably below the ~2000-frame gu | ~2000 JS frames — the rquickjs C-stack budget set by rt.set_ | Two-stage. AT the 256 KiB guard (~2000 frames): a CATCHABLE error is t | code-constant |
| Per-file size in the unified /workspace fs (one path = one R2 object). | bytes / MB (raw file body) | ~24 MB raw per file (largest body that round-trips read+writ | Write/storage: ~5 GiB (Cloudflare R2 single-object max — the | Write: no typed reject, no per-file guard — either succeeds as a 5GiB  | code-constant |
| Total fs bytes / file count (R2-backed host.fs + fs_files manifest) | MB raw per file + total file count | Per-file write: keep ≤8 MB raw (well under 24 MB; vfs-write  | Per-file write: ~24 MB raw (WS_FRAME_MAX_BYTES = 24*1024*102 | Per-file >24 MB: SILENT LOSS — inbound frame dropped with typed {type: | code-constant |
| Injected stdlib source cap (MAX_STDLIB_SOURCE_BYTES) + source→heap amp | KB source (combined selected stdli | ~184 KB source = the actual shipped default set (lodash 9733 | 500 KB source (512000 B). At total > 512000 B, create() thro | Typed reject at the 500 KB cap: throws "SizeAdmissionError: selected s | code-constant |
| Fetch egress (host.fetch / host.fetchStream) | calls/cell + allowlist mode + entr | Keep <= ~63 buffered fetch calls/cell so the eval loop never | 64 buffered host.fetch calls/cell (maxHostCallsPerCell, defa | 64-calls/cell cap = SILENT: the eval while-loop stops resuming the eng | code-constant |
| WASM import ceiling — count of WASI/host imports the engine module dec | count of WASM imports (functions i | 9 used / 22 shim-satisfiable. The host shim in `makeWasi` de | 9 imports — ALL in `wasi_snapshot_preview1` (random_get, env | Not a runtime reject/crash — it is a BUILD/LINK-time wall. If the engi | measured-live |
| Worker-loader registry — codeId warm-cache entries + isolate count + d | codeId warm-cache entries (distinc | Dedup is exact and content-addressed: 1 warm isolate per dis | No engram-side hard count cap on distinct codeIds / warm iso | Two regimes. (1) Engram-side admission (source/input/output size, invo | code-constant |
| Multi-tenant facets per supervisor (facet count + shard count + RPC bu | facets-per-shard / shard count / s | ~150 concurrent sessions measured clean (0% error, 100% stat | 128 facets per supervisor shard (MAX_FACETS_PER_SUPERVISOR=1 | At the 128/shard hard limit: TYPED REJECT — _touch throws `supervisor  | code-constant |
| SQLite manifest / value limits (bytes per row/value + chunk count) | bytes per bound value + chunk coun | 64 KB per chunk row (CHUNK_BYTES, lib.rs:216) and 1,500,000  | ~2,000,000 bytes per single bound SQLite value (workerd DO S | MIXED. (1) Per-chunk 64KB rows + the 1.5MB oplog clamp can never throw | code-constant |

## Appendix B — Adversarial Revisions (36)

- **require() — builtin Node modules (non-prefixed)**: `partial`→`partial` — Status 'partial' is correct, but the finding's claim that 'net, tls ... each throws a NotSupportedError' is FALSE for net and tls under the default config — a hidden divergence. net.js and tls.js are 
- **buf.write(string[, offset[, length]][, encoding])**: `real`→`partial` — Verified lib.rs:1442-1456: utf8/hex/base64/latin1/binary/ascii correct, arg-position overloading handled. BUT ucs2/utf16le silently fall to TextEncoder().encode() (UTF-8, line 1451) — a ucs2 write COR
- **statSync / lstatSync / fs.promises.stat / fs.promises.lstat**: `stub-acceptable`→`stub-acceptable` — Status (stub-acceptable) is correct, but the EVIDENCE/REASON is WRONG about R2 mtime. The finding claims 'R2 mtimeMs maps to created_ms'. FALSE for the in-VM path: fs.promises.stat -> host.__fs({op:'s
- **mtimeMs / atime / ctime / birthtime in stat()**: `stub-unacceptable`→`stub-unacceptable` — Status correct (stub-unacceptable), but the finding UNDERSTATES the breakage: it claims R2 stat returns mtimeMs=created_ms. FALSE for the in-VM fs API. The r2_fs_op 'stat' arm (lib.rs:4479-4493) retur
- **fs.Stats constructor**: `(not listed)`→`stub-unacceptable` — MISSING FEATURE not in the inventory. fs.Stats is exposed as an EMPTY no-op constructor `function(){}` (lib.rs:2542). statSync/lstatSync return PLAIN OBJECT LITERALS, not Stats instances, so `stat ins
- **https.request / https.get (TLS client)**: `partial`→`partial` — Status partial is correct, but the MECHANISM citation is wrong: https.request does NOT route through stdlib-src/shims/tls.js. It is a thin wrapper over __http (lib.rs:2086-2096) that forces protocol h
- **WHATWG fetch() as alternative to http.request**: `real`→`real` — Status real is correct (full WHATWG Response, streaming, SSRF guards, AbortSignal wired). One mechanism-citation correction: globalThis.fetch routes through host.fetchStream/_doFetchStream (lib.rs:113
- **crypto.subtle.digest MD5 reachability (under-documented, not**: `absent`→`real` — MISSING NUANCE worth flagging (not a security hole, a capability the inventory undersells). Because subtle.digest dispatch is __hashes[name.toLowerCase()] (lib.rs:709-710) and __hashes['md5'] exists (
- **HTTP IncomingMessage / response body as Readable**: `partial`→`partial` — Status (partial) is right but the API description is materially wrong and the divergence is UNDERSTATED. IncomingMessage is NOT a stream.Readable subclass — lib.rs:2043-2044 set its prototype to Event
- **process.chdir()**: `partial`→`real` — The 'partial' rationale is WRONG. The finding claims chdir does not propagate to host-side fs and that fs.readFile must pass explicit/frame cwd. But the in-VM fs shim's norm() (lib.rs:2350) resolves E
- **process.kill()**: `impossible`→`stub-unacceptable` — Status mislabeled. The finding's own description ('always returns true / silently succeeds instead of throwing ESRCH/EPERM') is the textbook definition of a stub with biting divergence, not 'impossibl
- **process.abort()**: `NOT LISTED`→`stub-unacceptable` — MISSING from the inventory. process.abort() exists and throws ProcessExit(134) — a catchable throw, NOT a hard process abort with core dump as in Node. Same biting divergence as process.exit: outer tr
- **process.umask / getuid / getgid / geteuid / getegid / emitWa**: `NOT LISTED`→`stub-acceptable` — MISSING cluster of POSIX/identity stubs. umask()=0, getuid/getgid/geteuid/getegid=0 (root), emitWarning routes to console.warn, hasUncaughtExceptionCaptureCallback()=false, setMaxListeners/getMaxListe
- **instance.on / addListener**: `real`→`real` — Status stays real, but the divergence note is WRONG in two ways. (1) Line 1526 fires 'newListener' BEFORE pushing, returns this, appends to this._e[k] — correct. (2) The claim that 'newListener' is em
- **instance.getMaxListeners default when unset**: `absent (not listed)`→`real` — MISSING from inventory but worth noting as a correctness detail: getMaxListeners (1540) returns 10 when this._max is undefined, and the constructor sets this._max=10 (1523). Matches Node default. Not 
- **path.win32**: `stub-unacceptable`→`stub-unacceptable` — Status is CORRECT (win32 sub-object is aliased to posix at lib.rs:1694: 'posix.posix = posix; posix.win32 = posix;', so sep is '/' not '\\' and delimiter ':' not ';' — silently wrong). BUT the finding
- **url.pathToFileURL**: `stub-acceptable`→`stub-acceptable` — Finding says 'Returns new URL("file://" + path)'. Actual code (lib.rs:2022) adds a leading '/' when the path is relative: new globalThis.URL('file://' + (String(p)[0]==='/' ? '' : '/') + String(p)). S
- **util.promisify / util.promisify.custom**: `real`→`stub-acceptable` — The escape-hatch claim is WRONG. Node's canonical hatch is f[util.promisify.custom] where promisify.custom is the Symbol.for('nodejs.util.promisify.custom'). The shim instead checks a non-standard STR
- **structuredClone**: `stub-acceptable`→`stub-acceptable` — Status stays stub-acceptable, but two phrasing corrections. (1) The finding says it 'Throws DataCloneError' for functions — it actually throws a plain `new Error('DataCloneError: function not cloneabl
- **performance.now()**: `stub-unacceptable`→`stub-unacceptable` — Status (stub-unacceptable) is CORRECT — seeded +1ms/call counter, integer-only, epoch-based absolute in default mode, real-time only re-anchored per-cell in clock:real. The divergence is real. BUT the
- **performance.timeOrigin**: `stub-unacceptable`→`stub-unacceptable` — Status stays stub-unacceptable, but the finding's core factual claim is WRONG: timeOrigin is NOT 'hardcoded to 0'. The only timeOrigin=0 assignment (engine/src/lib.rs:201) lives inside `if (performanc
- **process.hrtime() / process.hrtime.bigint()**: `stub-unacceptable`→`stub-unacceptable` — Status (stub-unacceptable) and behavior are CORRECT — over seeded Date.now(); ns=(ms%1000)*1e6 so sub-ms is always 0; bigint = ms*1e6n; absolute value epoch-based not uptime-relative; deltas correct a
- **AsyncLocalStorage**: `impossible`→`absent` — REVISE impossible→absent. The 'impossible' rationale ('QuickJS has no PromiseHook/async-context callback exposed in rquickjs') is FALSE. The vendored rquickjs in this repo ships PromiseHook bindings (
- **AsyncResource**: `impossible`→`absent` — REVISE impossible→absent, same root reason as AsyncLocalStorage. The claim 'same V8 async-context infrastructure, not present, impossible on QuickJS' is wrong: rquickjs vendors PromiseHook, the engine
- **createHook / executionAsyncId / triggerAsyncId**: `impossible`→`absent` — REVISE impossible→absent. The rationale 'requires V8 PromiseHook API or equivalent engine introspection, which QuickJS does not expose' is factually wrong for THIS build: the vendored rquickjs exposes
- **`const enum` declarations**: `stub-unacceptable`→`stub-acceptable` — The verdict's CORE MECHANISM is wrong. sucrase does NOT leave const-enum refs as broken property accesses, and it does NOT fail cross-cell. Empirically sucrase lowers `const enum E {A=1}` to `var E; (
- **`namespace` / `module` declarations**: `absent`→`stub-unacceptable` — WRONG and DANGEROUS: the inventory claims namespace/module are 'rejected with TypeScriptError before eval, socket stays alive, cleanly fails rather than miscompiling.' Empirically FALSE. sucrase does 
- **Parameter properties (`constructor(private x: T)`)**: `absent`→`real` — WRONG: inventory claims parameter properties are 'rejected with TypeScriptError, clean fail' because sucrase does not transform them. Empirically FALSE — sucrase transforms:['typescript'] DOES lower p
- **TS decorators (legacy `@decorator` syntax)**: `stub-unacceptable`→`stub-unacceptable` — Verdict (stub-unacceptable) is RIGHT but the stated MECHANISM is wrong and should be corrected. The inventory claims decorators are 'silently mis-compiled / decorator syntax erased / class field effec
- **mathjs (v12.4.3)**: `stub-unacceptable`→`stub-unacceptable` — Status stub-unacceptable is correct (mathjs is in-bundle but practically unreachable), but one load-bearing claim in the evidence is WRONG and must be corrected. The finding states config.modules:true
- **isomorphic-git-http (1.27.1) — not separately listed in orig**: `absent (not in inventory)`→`partial` — MISSING FROM INVENTORY. There is a third opt-in stdlib module isomorphic-git-http (1401 bytes, the smart-HTTP client that backs isomorphic-git over host.fetch). It is opt-in and would normally be pull
- **REPL top-level export declaration persistence**: `stub-unacceptable`→`stub-acceptable` — The finding itself concedes Node does NOT support `export` at the REPL top level (it is a SyntaxError in Node too), so there is NO Node-parity gap — the behaviour (SyntaxError) MATCHES Node. stub-unac
- **Stack depth / recursion guard (RangeError on stack overflow)**: `real`→`stub-acceptable` — The mechanism is real and catchable (rt.set_max_stack_size(256*1024) at line 3034, paired with 8MiB native stack), BUT the finding understates the divergence inside a 'real' verdict: the thrown error 
- **globalThis writability / top-level bare assignment persisten**: `(not listed)`→`real` — MISSING FEATURE worth noting for completeness: bare unqualified top-level assignment `x = 1` (no declarator) persists via the same indirect global eval path-(3) as var (creates a global property in sl
- **sandbox.expose (s.sandbox.expose / host.sandbox.expose — exp**: `real`→`real` — Status 'real' is correct but the rationale is WRONG and must be corrected: the inventory claims expose is 'Not exposed through the in-cell host.sandbox route list in kernel-glue.ts:1894-1898 — only vi
- **Worker source persistence across session cold-restore**: `stub-unacceptable`→`stub-acceptable` — Over-severe. registry_workers is a standard DO SQLite table (CREATE TABLE IF NOT EXISTS), which is eviction/hibernation-durable BY DESIGN — exactly like all other kernel state (snap_manifest, fs_files

## Appendix C — Full Parity Inventory (388 features)


### Module system: require / import / CJS-vs-ESM / node: builtins resolution / use() stdlib loader

- **require() — builtin Node modules (non-prefixed)** `[partial]` — api: `require('fs'), require('path'), require('crypto'), etc.`  
  Resolves the curated set: assert, buffer, crypto, dns, events, fs, http, https, os, path, perf_hooks, querystring, stream, string_decoder, url, util, vm, zlib. All entries return shimmed objects, not real Node modules; individual shim fidelity varies (see separate entries). Missing: net, tls, child_process, cluster, worker_threads, dgram, v8, inspector, repl — each throws a NotSupportedError with a machine-readable reason.  
  *mechanism:* pure-JS shim — globalThis.__builtins map initialized in BOOTSTRAP (engine/src/lib.rs); require() at lib.rs:2303 checks __builtins first, then __mods, then __stdmods  
  *constraint:* No real Node runtime in the WASM isolate; 6-WASI-fn ceiling means no OS primitives (no sockets, no process spawning, no threads)  
  *evidence:* apps/kernel/engine/src/lib.rs:2098-2157 (__builtins init), apps/kernel/engine/src/lib.rs:2303-2334 (require() body), apps/kernel/engine/src/lib.rs:2225 (excluded list)
- **require('node:…') — node: protocol prefix** `[real]` — api: `require('node:fs'), require('node:crypto'), etc.`  
  All __builtins entries are aliased under the node: prefix by iterating Object.keys(B) and writing B['node:'+k] = B[k]. Stripping happens both at alias-registration time and inside require() itself (raw.replace(/^node:/, '')). Subpath aliases also work: node:stream/promises, node:util/types, node:assert/strict, node:path/posix.  
  *mechanism:* pure-JS shim — alias loop at lib.rs:2160-2166; require() strip at lib.rs:2305  
  *constraint:* No constraint; purely additive alias. Implemented to match Node v12+ idiom.  
  *evidence:* apps/kernel/engine/src/lib.rs:2158-2167 (alias loop), apps/kernel/engine/src/lib.rs:2305 (require node: strip)
- **require() — relative/absolute file paths** `[absent]` — api: `require('./lib'), require('../shared'), require('/abs/path')`  
  require() does NOT read from the VFS or any filesystem. The comment at lib.rs:2302 says 'bare relative paths fall through to the cache by basename' — meaning require('./foo') strips to 'foo' and only resolves if 'foo' is already cached from a prior use() call. There is no file-load path. Code that does require('./local-module') will always throw MODULE_NOT_FOUND unless the module name coincidentally matches a cached entry.  
  *mechanism:* absent — lib.rs:2315 does `n.split('/').pop()` as a basename fallback against __mods cache only; no VFS read  
  *constraint:* No synchronous host I/O; the VM has no synchronous read path to VFS (which is backed by the in-heap __vfs object but not wired into require())  
  *evidence:* apps/kernel/engine/src/lib.rs:2302 (comment admitting relative path limitation), apps/kernel/engine/src/lib.rs:2315 (basename-only fallback)
- **require() — require.resolve / require.cache / require.main / require.extensions** `[absent]` — api: `require.resolve(id), require.cache, require.main, require.extensions`  
  require() is a plain function with no attached properties. None of require.resolve, require.cache, require.main, require.extensions are defined. Code that sniffs require.resolve to detect Node will see undefined; code that mutates require.cache will silently do nothing. This is a common pattern in bundler/loader code.  
  *mechanism:* absent — require is defined as a plain globalThis.require function with no property assignments beyond the function itself  
  *constraint:* Not a WASM/CF constraint, just not built. The __mods cache is internal and not exposed.  
  *evidence:* apps/kernel/engine/src/lib.rs:2303-2334 (require() — no properties attached)
- **module.createRequire / module.builtinModules / Module._resolveFilename** `[stub-acceptable]` — api: `require('module').createRequire(), require('module').builtinModules`  
  createRequire() returns globalThis.require (ignores the from-path argument entirely — always returns the global resolver, not a path-rooted one). builtinModules returns the enumerable __builtins keys. Module constructor is a no-op function. _resolveFilename returns its input unchanged. Good enough for code that only needs createRequire() to get a working require handle; breaks any code that passes a __dirname to createRequire() and expects path-relative resolution.  
  *mechanism:* pure-JS shim at lib.rs:2156 in __builtins.module  
  *constraint:* No real module graph; no file-path resolution (no VFS-backed require)  
  *evidence:* apps/kernel/engine/src/lib.rs:2155-2156 (module shim)
- **Top-level import/export statements in REPL cells** `[stub-unacceptable]` — api: `import x from 'y'; export const z = …`  
  Cells are evaluated via indirect global eval (mode 'global') or wrapped async-fn body — both are script contexts, not module contexts. A top-level `import x from 'y'` or `export const z` will SyntaxError. The __nodeCompat.note explicitly states 'import/export at the top level of a CELL is not parsed — use() instead'. Users copying standard ESM module code verbatim into a cell get a SyntaxError with no helpful fallback. This is a systematic silent-bite: the error is NOT helpful (it's a raw QuickJS SyntaxError), and the workaround (use() + destructure) is non-obvious.  
  *mechanism:* absent by design — cells are script-eval; no static-import hook is configured in rquickjs (no set_module_loader call in build_runtime())  
  *constraint:* rquickjs Module::declare+eval path exists but requires the source be declared as a named module ahead of time — not applicable to ad-hoc cell imports that reference arbitrary specifiers the engine cannot resolve synchronously  
  *evidence:* apps/kernel/engine/src/lib.rs:2210 (note: import not parsed in cells), apps/kernel/engine/src/lib.rs:3016-3062 (build_runtime — no module loader registered), apps/kernel/engine/src/lib.rs:3500-3528 (cell eval paths: expr/asyncbody/global — all script eval)
- **Dynamic import() in cells** `[absent]` — api: `await import('some-module')`  
  No module loader is registered in rquickjs (no rt.set_module_loader call). A dynamic import() expression will throw because the runtime has no resolver to satisfy the specifier. There is no fallback to __mods or __builtins. Code using dynamic import() for code-splitting or lazy loading simply fails.  
  *mechanism:* absent — rquickjs requires a registered module loader to resolve dynamic import() specifiers; none is configured (lib.rs:3016-3062)  
  *constraint:* 12-WASM-import ceiling + no synchronous host I/O make a general-purpose async module loader infeasible without a host-park/resume round-trip; not built  
  *evidence:* apps/kernel/engine/src/lib.rs:3016-3062 (build_runtime — no set_module_loader), apps/kernel/engine/src/lib.rs:2948-2998 (__esmEval only usable from JS via use(), not from import() expressions)
- **use() — async npm package loader (the ESM/CJS facade)** `[partial]` — api: `No direct Node equivalent; replaces both import() and runtime require() of npm packages`  
  Works for the large set of packages that ship a self-contained CJS/UMD bundle OR a fully-inlined ESM bundle via esm.sh ?bundle. Fails for: (1) packages with residual peer imports that esm.sh did not inline — __esmEval returns WouldBlock; (2) packages requiring native addons; (3) packages that write to the filesystem or spawn processes. CDN availability/fetch-allowlist is also a runtime dependency. Once loaded, cached in __mods and snapshot-persists across hibernation — no re-fetch on cold restore. This is the intended npm story, not a Node parity claim.  
  *mechanism:* host-call — use() calls globalThis.host.fetch() (DO-side fetch, mediated, allowlist-gated), then evals the bundle in a CJS frame via indirect eval; ESM bundles routed through __esmEval (rquickjs Module::declare+eval). Defined at lib.rs:2561-2696.  
  *constraint:* No synchronous host I/O (VM cannot do sync fetch); determinism requires fetch results to be oplog-recorded via host.fetch not raw fetch  
  *evidence:* apps/kernel/engine/src/lib.rs:2553-2696 (use() implementation), apps/kernel/engine/src/lib.rs:2948-2998 (__esmEval), apps/kernel/src/kernel-glue.ts:1243 (fetch allowlist)
- **use() — ESM namespace survivability across cold restore** `[stub-unacceptable]` — api: `N/A (engram-specific durability contract)`  
  The live QuickJS module-namespace exotic object does NOT reliably survive W4 byte-delta heap snapshots. The code copies the namespace into a plain object before caching (lib.rs:2629-2641), but this loses live bindings, getters, and any non-enumerable exports not explicitly copied. A module whose value depends on live bindings (e.g. a mutable re-export) will silently return stale values after cold restore. The code acknowledges this and deletes the exotic from __esm afterward, but the plain-object copy is lossy for non-trivial ESM module patterns.  
  *mechanism:* pure-JS shim — namespace copy at lib.rs:2629-2641; comment at 2621-2628 documents the known limitation  
  *constraint:* W4 byte-delta snapshot mechanism does not preserve QuickJS module-namespace exotic objects reliably; monotonic memory  
  *evidence:* apps/kernel/engine/src/lib.rs:2621-2641 (namespace copy + comment on durability limitation)
- **REPL persistence transform — top-level let/const/function/class** `[partial]` — api: `Node REPL top-level declaration persistence (Node v18+ globalThis hoisting)`  
  A pre-eval source transform (repl-transform.ts) rewrites depth-0 let/const to bare assignment and function/class to globalThis.NAME= so declarations persist across cells. Correct for the common cases. Bails (returns source unchanged) on: async function, function*, export, unterminated string/regex, unbalanced braces — so those fall to indirect global eval where let/const vanish. A reserved-host-global name (crypto, fetch, host, process, console, Buffer, require, use, performance, globalThis) is intentionally kept lexical to avoid clobbering host primitives — diverges from Node where crypto would be globally writable.  
  *mechanism:* pure-JS shim — host-side source rewrite in apps/kernel/src/repl-transform.ts, applied at kernel-glue.ts:1573-1578 before passing to engine  
  *constraint:* QuickJS indirect-eval scoping: top-level let/const in indirect eval get their own lexical scope, not globalThis — identical to V8 behavior but a REPL anti-pattern  
  *evidence:* apps/kernel/src/repl-transform.ts:1-30 (design comments), apps/kernel/src/kernel-glue.ts:1573-1578 (application point), apps/kernel/src/repl-transform.ts RESERVED_HOST_GLOBALS set
- **TypeScript cell preprocessing (sucrase strip)** `[real]` — api: `No Node equivalent at runtime; ts-node / tsx analogue`  
  sucrase with transforms:['typescript'] strips all TS type syntax (annotations, generics, interfaces, as, satisfies, declare) and lowers enum to an IIFE before the cell reaches the engine. disableESTransforms:true leaves modern ES2022 (async/await, spread, optional chaining) untouched. Fails gracefully: a sucrase parse error falls back to passing the raw source. JSX is NOT supported (no jsx transform).  
  *mechanism:* pure-JS shim — sucrase is inlined by esbuild into kernel-glue.mjs; applied at kernel-glue.ts:34-49 + 1529-1578  
  *constraint:* No constraint prevents this; it is purely additive pre-processing on the host (JS) side before eval  
  *evidence:* apps/kernel/src/kernel-glue.ts:21-28 (sucrase import), apps/kernel/src/kernel-glue.ts:34-49 (stripTypes), apps/kernel/src/kernel-glue.ts:1529-1578 (TS-strip then transformCell)
- **Preloaded stdlib via use()/config.modules — esbuilt IIFEs injected at create** `[partial]` — api: `No Node equivalent; analogous to pre-require'd npm packages`  
  Modules declared in config.modules (or the default set: nanoid, uuid, dayjs, zod) are eval'd as esbuilt Text-module IIFEs into the heap at session create and snapshot-persist. They survive cold restore without re-fetch. Registered into __stdmods (not __mods) so require('lodash') resolves post-inject. Hard cap: injected source ≤~500 KB (≤~7 MB raw heap); mathjs is opt-in only (29x source-to-heap amplification). Exceeding the cap causes a silent OOM cliff (snapshot fails) not a clean error unless the MAX_DUMP_BUFFER_BYTES guard fires.  
  *mechanism:* stdlib inject — kernel-glue.ts:1282-1325 (_injectStdlib); Text-module bundles in apps/kernel/stdlib-src/; wrangler builds them as Text modules  
  *constraint:* Monotonic WASM memory — large stdlib bundles raise the high-water mark permanently; snapshot size-admission cap (~18 MB raw) limits total injected stdlib  
  *evidence:* apps/kernel/src/kernel-glue.ts:1292-1326 (_injectStdlib), apps/kernel/engine/src/lib.rs:2310-2317 (require() __stdmods check), CLAUDE.md v0.6 section (500 KB source cap, mathjs opt-in)
- **CJS interop within use() — module.exports / __dirname / __filename** `[stub-acceptable]` — api: `CJS module wrapper (module, exports, require, __dirname, __filename)`  
  use() wraps the bundle in a CJS frame function with module, exports, require, Buffer, process, global, __dirname, __filename injected. __dirname and __filename are hardcoded to '/' and '/index.js' respectively — adequate for self-contained bundles that reference these only for path operations, but wrong for bundles that encode their real install path. No circular-dependency tracking; no module caching during execution of a single bundle (re-require inside a bundle calls the global require).  
  *mechanism:* pure-JS shim — CJS frame at lib.rs:2590 and 2678  
  *constraint:* No real filesystem; __dirname/filename are vestigial stubs  
  *evidence:* apps/kernel/engine/src/lib.rs:2586-2679 (CJS frame + frame call)
- **vm module — runInNewContext / runInThisContext / Script / createContext** `[stub-unacceptable]` — api: `require('vm').runInNewContext, Script, createContext, isContext`  
  runInNewContext is NOT context-isolated. It constructs a Function with the context keys as formal parameters and calls it — the code runs in the SAME QuickJS realm with globalThis accessible. Calling isContext() always returns true regardless of argument. createContext() returns its argument unchanged. Any code that uses vm for security sandboxing or true variable isolation will silently get no isolation whatsoever. The shim is documented as 'no security/context isolation boundary' but callers who miss the caveat will be bitten.  
  *mechanism:* pure-JS shim — lib.rs:2145-2153  
  *constraint:* Single QuickJS realm; rquickjs does not expose multiple realm creation via its public API in the version used here  
  *evidence:* apps/kernel/engine/src/lib.rs:2143-2153 (vm shim + comment), apps/kernel/engine/src/lib.rs:2240 (__nodeCompat degraded.vm caveat)
- **import.meta (import.meta.url, import.meta.resolve, import.meta.env)** `[absent]` — api: `import.meta.url, import.meta.resolve(), import.meta.env`  
  No import.meta shim exists. Cells execute as scripts (not ES modules), so import.meta is a SyntaxError in that context. Only code loaded via __esmEval (internally for ESM bundles from use()) runs in a real QuickJS module context where import.meta could exist, but no properties are set on it. Code that checks import.meta.url to detect ESM context or derive paths will either SyntaxError (cells) or see undefined properties (use()-loaded modules).  
  *mechanism:* absent — no import.meta shim registered in inject_host_fns or BOOTSTRAP  
  *constraint:* Cells are script-eval contexts where import.meta is invalid syntax; not built for __esmEval either  
  *evidence:* apps/kernel/engine/src/lib.rs:2909-2999 (inject_host_fns — no import.meta), apps/kernel/engine/src/lib.rs:3016-3062 (build_runtime — no module meta handler)

### Buffer + TypedArray (Buffer.from/alloc/concat, encodings, Blob)

- **Buffer.from(string, encoding)** `[real]` — api: `Buffer.from(string, encoding) — utf8/hex/base64/base64url/latin1/binary/ascii/ucs2/utf16le`  
  All 9 Node encodings handled: utf8 via TextEncoder, hex via parseInt loop, base64/base64url via atob (base64url normalizes -/_ before decode), latin1/binary/ascii via charCodeAt mask, ucs2/utf16le via DataView setUint16. Behavior is byte-identical to Node for valid inputs. Edge case: atob is strict about padding; Node's base64 is tolerant of missing padding — atob on a non-padded string will throw in some QuickJS builds (not validated against Node's lenient behavior).  
  *mechanism:* pure-JS shim in BOOTSTRAP (engine/src/lib.rs:1462–1474)  
  *constraint:* pure in-VM; no host round-trip needed  
  *evidence:* apps/kernel/engine/src/lib.rs:1462, apps/kernel/engine/src/lib.rs:1465, apps/kernel/engine/src/lib.rs:1468
- **Buffer.from(arrayBuffer / TypedArray / array)** `[real]` — api: `Buffer.from(arrayBuffer[, byteOffset[, length]]) / Buffer.from(array) / Buffer.from(buffer)`  
  ArrayBuffer copies with optional offset+length. Uint8Array copies. Array-like via Uint8Array.from. toJSON round-trip ({type:'Buffer',data:[...]}) restored correctly. Returns a plain Uint8Array, NOT a true Buffer subclass instance — see prototype-chain issue under 'Buffer instanceof Buffer'.  
  *mechanism:* pure-JS shim in BOOTSTRAP (engine/src/lib.rs:1471–1474)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1471, apps/kernel/engine/src/lib.rs:1472, apps/kernel/engine/src/lib.rs:1473
- **Buffer.alloc / Buffer.allocUnsafe / Buffer.allocUnsafeSlow** `[real]` — api: `Buffer.alloc(size[, fill[, encoding]]) / Buffer.allocUnsafe(size) / Buffer.allocUnsafeSlow(size)`  
  alloc zero-fills (new Uint8Array) and supports numeric, string-with-encoding, and Buffer fills via the patched Uint8Array.prototype.fill. allocUnsafe/allocUnsafeSlow both return new Uint8Array(n) — content is zero-initialized by the JS engine (no uninitialized memory), so the 'unsafe' distinction is moot but not wrong.  
  *mechanism:* pure-JS shim in BOOTSTRAP (engine/src/lib.rs:1490–1492)  
  *constraint:* pure in-VM; WASM linear memory always zero-fills new pages  
  *evidence:* apps/kernel/engine/src/lib.rs:1490, apps/kernel/engine/src/lib.rs:1491, apps/kernel/engine/src/lib.rs:1492
- **Buffer.concat(list[, totalLength])** `[real]` — api: `Buffer.concat(list[, totalLength])`  
  Correct: pre-sizes when totalLength given, clips oversized chunks, returns Uint8Array. Returns plain Uint8Array, not a Buffer subclass — same prototype-chain divergence as all other factory methods.  
  *mechanism:* pure-JS shim in BOOTSTRAP (engine/src/lib.rs:1509)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1509
- **Buffer.isBuffer(x)** `[stub-unacceptable]` — api: `Buffer.isBuffer(x)`  
  Returns (x instanceof Uint8Array). In Node, Buffer IS a Uint8Array subclass, so the check is symmetric: Buffer.isBuffer(Buffer.from([])) === true AND Buffer.from([]) instanceof Buffer === true. Here __B is a plain factory function with no prototype chain inheritance from Uint8Array. So Buffer.isBuffer(Buffer.from([])) === true (correct), but Buffer.from([]) instanceof Buffer === false (WRONG). Libraries that do `x instanceof Buffer` as a fast-path (e.g. has-buffer, readable-stream internal checks, some blob libs) will silently mis-classify objects. This is the top divergence risk.  
  *mechanism:* pure-JS shim; Buffer is a factory function, not a class extending Uint8Array (engine/src/lib.rs:1461, 1493, 1510)  
  *constraint:* QuickJS ES2020 class syntax does not support `class Buffer extends Uint8Array` with a constructor that returns a non-Buffer Uint8Array — doing so correctly requires Symbol.species plumbing; skipped for simplicity  
  *evidence:* apps/kernel/engine/src/lib.rs:1461, apps/kernel/engine/src/lib.rs:1493, apps/kernel/engine/src/lib.rs:1510
- **Buffer.isEncoding(enc)** `[real]` — api: `Buffer.isEncoding(encoding)`  
  Covers all 10 Node-recognised encoding names. Exact match.  
  *mechanism:* pure-JS shim in BOOTSTRAP (engine/src/lib.rs:1494)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1494
- **Buffer.byteLength(string, encoding)** `[real]` — api: `Buffer.byteLength(string[, encoding])`  
  Handles string (utf8 via TextEncoder.encode().length, hex closed-form /2, base64/base64url closed-form, latin1/binary/ascii = .length) and Uint8Array/ArrayBuffer (.byteLength). Matches Node semantics for all supported encodings.  
  *mechanism:* pure-JS shim in BOOTSTRAP (engine/src/lib.rs:1497–1504)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1497, apps/kernel/engine/src/lib.rs:1504
- **Buffer.compare(a, b)** `[real]` — api: `Buffer.compare(buf1, buf2)`  
  Byte-by-byte lexicographic, returns -1/0/1. Matches Node.  
  *mechanism:* pure-JS shim in BOOTSTRAP (engine/src/lib.rs:1506)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1506
- **buf.toString(encoding)** `[stub-unacceptable]` — api: `buf.toString([encoding[, start[, end]]])`  
  Encoding-aware toString is patched onto Uint8Array.prototype (engine/src/lib.rs:1357–1365), covering utf8/hex/base64/latin1/binary/ascii. MISSING: (1) 'base64url' — the toString switch has no base64url branch; falls through to TextDecoder().decode() which will produce garbled output instead of base64url-encoded bytes. (2) 'ucs2'/'utf16le' — no branch; falls to TextDecoder which interprets the bytes as UTF-8, wrong. (3) start/end slicing parameters — not implemented; Node's buf.toString('utf8', 0, 5) slices first; here callers must pre-slice. These gaps silently produce wrong output rather than throwing.  
  *mechanism:* pure-JS shim on Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1357–1365)  
  *constraint:* pure in-VM; gap is implementation oversight, not a platform constraint  
  *evidence:* apps/kernel/engine/src/lib.rs:1357, apps/kernel/engine/src/lib.rs:1363, apps/kernel/engine/src/lib.rs:1364
- **buf.write(string[, offset[, length]][, encoding])** `[real]` — api: `buf.write(string[, offset[, length]][, encoding])`  
  Supports utf8, hex, base64, latin1/binary/ascii. Returns bytes written. Handles offset/length/encoding arg-position overloading matching Node's unusual signature. Missing ucs2/utf16le write path (same gap as toString).  
  *mechanism:* pure-JS shim patched onto Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1442–1456)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1442, apps/kernel/engine/src/lib.rs:1456
- **buf.readUInt32BE/LE, readInt32BE/LE, readUInt16BE/LE, readUInt8, readInt8, readInt16BE/LE, readFloatBE/LE, readDoubleBE/LE, readBigInt64BE/LE, readBigUInt64BE/LE, readUIntBE/LE, readIntBE/LE** `[real]` — api: `Buffer numeric read methods (full read matrix)`  
  Full read matrix via DataView honouring byteOffset. Covers all Node numeric read methods including variable-length readUIntBE/LE(offset, byteLength). Values <=2^48 exact in JS number; larger values require BigInt variants which are provided.  
  *mechanism:* pure-JS shim patched onto Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1370–1402)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1370, apps/kernel/engine/src/lib.rs:1400
- **buf.writeUInt32BE/LE, writeInt32BE/LE, writeUInt16BE/LE, writeUInt8, writeInt8, writeInt16BE/LE, writeFloatBE/LE, writeDoubleBE/LE, writeBigInt64BE/LE, writeBigUInt64BE/LE, writeUIntBE/LE, writeIntBE/LE** `[real]` — api: `Buffer numeric write methods (full write matrix)`  
  Full write matrix via DataView. Returns offset+byteSize matching Node. swap16/swap32/swap64 in-place byte-swap also provided.  
  *mechanism:* pure-JS shim patched onto Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1378–1422)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1378, apps/kernel/engine/src/lib.rs:1419
- **buf.copy(target[, targetStart[, sourceStart[, sourceEnd]]])** `[real]` — api: `buf.copy(target[, targetStart[, sourceStart[, sourceEnd]]])`  
  Implemented via subarray+set. Returns bytes copied. Matches Node.  
  *mechanism:* pure-JS shim on Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1437)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1437
- **buf.equals(other)** `[real]` — api: `buf.equals(otherBuffer)`  
  Byte-by-byte comparison. Returns boolean. Matches Node.  
  *mechanism:* pure-JS shim on Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1438)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1438
- **buf.compare(other)** `[stub-acceptable]` — api: `buf.compare(target[, targetStart[, targetEnd[, sourceStart[, sourceEnd]]]])`  
  Only the one-arg form (compare(other)) is implemented. The five-argument form with source/target range slicing is absent. The one-arg form is what most code uses (sorting). The five-arg form would silently fall to type error.  
  *mechanism:* pure-JS shim on Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1507)  
  *constraint:* pure in-VM; gap is implementation completeness  
  *evidence:* apps/kernel/engine/src/lib.rs:1507
- **buf.indexOf(value[, byteOffset[, encoding]]) / buf.includes(value[, byteOffset[, encoding]])** `[real]` — api: `buf.indexOf / buf.includes with string/Buffer/number needle`  
  Handles number needle (byte match), string needle (Buffer.from(val, enc)), and Buffer/Uint8Array needle via byte scan. Negative byteOffset handled. Matches Node for common usage.  
  *mechanism:* pure-JS shim on Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1427–1435)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1427, apps/kernel/engine/src/lib.rs:1433
- **buf.fill(value[, offset[, end]][, encoding])** `[real]` — api: `buf.fill(value[, offset[, end]][, encoding])`  
  Number fill via native Uint8Array.fill; string fill encodes then repeats pattern; Buffer/Uint8Array fill repeats pattern. Arg-position encoding overloading handled. Matches Node.  
  *mechanism:* pure-JS shim on Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1478–1488)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1478, apps/kernel/engine/src/lib.rs:1488
- **buf.toJSON()** `[real]` — api: `buf.toJSON() — { type: 'Buffer', data: [...] }`  
  Patched onto Uint8Array.prototype. Returns {type:'Buffer', data:[...byte array]} matching Node. Buffer.from() round-trips it correctly.  
  *mechanism:* pure-JS shim on Uint8Array.prototype in BOOTSTRAP (engine/src/lib.rs:1424)  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:1424
- **Buffer.poolSize / kMaxLength / INSPECT_MAX_BYTES** `[stub-acceptable]` — api: `Buffer.poolSize, buffer.kMaxLength, buffer.constants.MAX_LENGTH`  
  kMaxLength exposed as 0x7fffffff via the 'buffer' module export. Buffer.poolSize is absent. INSPECT_MAX_BYTES absent. These are rarely checked at runtime by application code; mainly used by sizing/introspection libraries.  
  *mechanism:* partial constant in BOOTSTRAP require('buffer') shim (engine/src/lib.rs:2112)  
  *constraint:* pure in-VM; poolSize irrelevant (no slab allocator)  
  *evidence:* apps/kernel/engine/src/lib.rs:2112
- **Uint8Array / Int8Array / Uint8ClampedArray / Int16Array / Uint16Array / Int32Array / Uint32Array / Float32Array / Float64Array / BigInt64Array / BigUint64Array** `[real]` — api: `Node TypedArray globals (native via V8; same in QuickJS)`  
  QuickJS natively provides all ES2020 TypedArrays including BigInt64Array/BigUint64Array. Float16Array is documented as present in the VM environment (docs/research/repl-env-surface.md:91) — QuickJS-ng does support it. DataView is native. ArrayBuffer.isView works. structuredClone clones TypedArrays and ArrayBuffers correctly (engine/src/lib.rs:505–506).  
  *mechanism:* native QuickJS built-ins; no shim needed  
  *constraint:* none — QuickJS provides these natively  
  *evidence:* docs/research/repl-env-surface.md:91, apps/kernel/engine/src/lib.rs:505, apps/kernel/engine/src/lib.rs:506
- **SharedArrayBuffer** `[stub-unacceptable]` — api: `SharedArrayBuffer constructor + Atomics`  
  SharedArrayBuffer is constructible in the VM but the BOOTSTRAP docs note 'Atomics is ABSENT'. The code adds a stub Atomics object (engine/src/lib.rs:226–239) with single-threaded no-op implementations: load/store/add/sub/and/or/xor/exchange/compareExchange work as plain memory ops (correct for one thread), but Atomics.wait() always returns 'not-equal' and Atomics.notify() returns 0. This means thread-detecting libraries that check Atomics.wait will see a non-blocking result and may activate multi-threaded code paths that then fail. The research doc explicitly recommends deleting SharedArrayBuffer (docs/research/repl-env-surface.md:285–287) but the engine does NOT do this deletion. Libraries like piscina, workerpool that do SAB+Atomics.wait coordination will malfunction silently.  
  *mechanism:* stub Atomics object in BOOTSTRAP (engine/src/lib.rs:226–239); SharedArrayBuffer constructor left in place (QuickJS native)  
  *constraint:* no real threads in WASM single-threaded; Atomics.wait cannot block (would deadlock the single WASM thread)  
  *evidence:* apps/kernel/engine/src/lib.rs:223, apps/kernel/engine/src/lib.rs:226, apps/kernel/engine/src/lib.rs:238, docs/research/repl-env-surface.md:285
- **Blob constructor (new Blob(parts, {type}))** `[real]` — api: `Blob (WHATWG Blob / Node v15+ globalThis.Blob)`  
  Pure-JS in-VM Blob. Accepts string/Uint8Array/ArrayBuffer/other TypedArray/Blob parts, concatenates into a single Uint8Array backing. .size, .type, .arrayBuffer(), .bytes(), .text(), .slice() all implemented correctly. .stream() works only when the stream module is loaded (throws otherwise — acceptable, stream() is a late addition). File subclass with .name/.lastModified also present.  
  *mechanism:* pure-JS shim in BOOTSTRAP WAVE 4 (engine/src/lib.rs:897–924)  
  *constraint:* pure in-VM; no host round-trip  
  *evidence:* apps/kernel/engine/src/lib.rs:897, apps/kernel/engine/src/lib.rs:916, apps/kernel/engine/src/lib.rs:919, apps/kernel/engine/src/lib.rs:920
- **Blob.stream()** `[partial]` — api: `blob.stream() -> ReadableStream`  
  Works only when the stream stdlib module is loaded (config.modules includes 'stream'). Otherwise throws 'Blob.stream requires the stream module'. Node's globalThis.Blob.stream() always works. Code relying on blob.stream() without the module loaded will get an error, not a stream.  
  *mechanism:* conditional in BOOTSTRAP (engine/src/lib.rs:920); depends on __builtins.stream being populated  
  *constraint:* stream module is optional/lazy-loaded; not a platform constraint  
  *evidence:* apps/kernel/engine/src/lib.rs:920
- **require('buffer') module** `[real]` — api: `require('buffer') — { Buffer, kMaxLength, constants }`  
  Module shim exports { Buffer: globalThis.Buffer, kMaxLength: 0x7fffffff, constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffff } }. The stdlib-src/shims/buffer.js is a passthrough that returns the BOOTSTRAP-installed globalThis.Buffer. Buffer.poolSize absent but not commonly required.  
  *mechanism:* pure-JS shim in BOOTSTRAP require() registry (engine/src/lib.rs:2112) + shim passthrough at apps/kernel/stdlib-src/shims/buffer.js  
  *constraint:* pure in-VM  
  *evidence:* apps/kernel/engine/src/lib.rs:2112, apps/kernel/stdlib-src/shims/buffer.js:4
- **buf.toString('base64url')** `[stub-unacceptable]` — api: `buf.toString('base64url') — URL-safe base64 without padding`  
  Buffer.from(str, 'base64url') correctly decodes (normalizes -/_ before atob). But Uint8Array.prototype.toString (engine/src/lib.rs:1357–1365) has NO 'base64url' branch — it falls through to the final default: new TextDecoder().decode(this), producing garbled UTF-8 decode of the bytes instead of base64url-encoded output. Code doing buf.toString('base64url') to produce a JWT component or URL-safe token will silently get the wrong string.  
  *mechanism:* gap in toString() switch; Buffer.from decode is correct but encode via toString is broken (engine/src/lib.rs:1357–1365)  
  *constraint:* pure implementation gap; fixable with one branch  
  *evidence:* apps/kernel/engine/src/lib.rs:1357, apps/kernel/engine/src/lib.rs:1364
- **buf.toString('ucs2') / buf.toString('utf16le')** `[stub-unacceptable]` — api: `buf.toString('ucs2') / buf.toString('utf16le')`  
  Buffer.from(str, 'ucs2'/'utf16le') correctly encodes (DataView setUint16 LE). But Uint8Array.prototype.toString has no ucs2/utf16le branch — falls to TextDecoder().decode() treating bytes as UTF-8, producing wrong output. Code round-tripping UCS2/UTF16LE buffers via toString will corrupt data silently.  
  *mechanism:* gap in toString() switch (engine/src/lib.rs:1357–1365); Buffer.from encode works but decode path is missing  
  *constraint:* pure implementation gap  
  *evidence:* apps/kernel/engine/src/lib.rs:1362, apps/kernel/engine/src/lib.rs:1364
- **buf.toString(encoding, start, end) with start/end slicing** `[stub-unacceptable]` — api: `buf.toString([encoding[, start[, end]]])`  
  The patched Uint8Array.prototype.toString takes only one argument (enc). The start/end range parameters are not implemented. Calling buf.toString('utf8', 0, 10) will decode the FULL buffer, not the slice, silently returning extra bytes. This trips up HTTP parsers and binary protocol implementations that slice-decode.  
  *mechanism:* single-arg toString shim (engine/src/lib.rs:1357)  
  *constraint:* pure implementation gap; callers must pre-slice with .subarray(start, end).toString(enc)  
  *evidence:* apps/kernel/engine/src/lib.rs:1357
- **Buffer instanceof Buffer (prototype chain)** `[stub-unacceptable]` — api: `In Node: Buffer.from([]) instanceof Buffer === true AND Buffer.from([]) instanceof Uint8Array === true`  
  globalThis.Buffer is a plain factory function (__B), not a class extending Uint8Array. Buffer.from() returns a plain new Uint8Array — it IS a Uint8Array (so Buffer.isBuffer() works), but it is NOT an instanceof Buffer. Any library doing `x instanceof Buffer` (e.g. some versions of bl, concat-stream, browserify-cipher, internal readable-stream fast-paths) will get false and fall into a slower/wrong code path. This is a silent correctness hazard, not a thrown error.  
  *mechanism:* factory-function pattern; __B has no prototype inheriting Uint8Array (engine/src/lib.rs:1461, 1510)  
  *constraint:* could be fixed with Object.setPrototypeOf(__B.prototype, Uint8Array.prototype) but Buffer.from() returns new Uint8Array not new __B, so instanceof __B is always false unless re-wrapped  
  *evidence:* apps/kernel/engine/src/lib.rs:1461, apps/kernel/engine/src/lib.rs:1510, apps/kernel/engine/src/lib.rs:1493
- **Buffer.from(string) with invalid base64 (Node-lenient decode)** `[stub-unacceptable]` — api: `Buffer.from(str, 'base64') lenient: ignores non-base64 chars`  
  Implementation uses atob() (engine/src/lib.rs:1465). atob is strict: throws on invalid characters and on missing padding. Node's Buffer.from(str, 'base64') is lenient: strips whitespace and non-base64 chars, pads if needed. Code passing unpadded base64 (common in JWTs, HTTP auth headers) or base64 with embedded whitespace will throw instead of silently tolerating as Node does.  
  *mechanism:* atob() used directly; no pre-normalization (engine/src/lib.rs:1465)  
  *constraint:* pure implementation gap; fixable with a strip-and-pad normalization step before atob  
  *evidence:* apps/kernel/engine/src/lib.rs:1465

### fs (in-heap VFS + R2-backed unified /workspace, sync vs async, promises, streams, cwd/chdir, watch)

- **readFileSync / fs.promises.readFile** `[partial]` — api: `fs.readFileSync / fs.promises.readFile`  
  VFS provider: fully sync, encoding-aware (utf8/base64/hex/latin1/buffer), binary exact. R2 provider: promises-only (sync throws ERR_FS_ASYNC_ONLY); reads cross 64 KB HOSTCALL boundary as base64 chunks but the READ result comes back on the 1-32 MB scratch buffer (one call, no client-side chunking needed). Both paths correct for the isomorphic-git `readFile(path,{})` binary-bytes contract. Missing: no streaming read for files near the scratch ceiling (~24 MB uncompressed).  
  *mechanism:* VFS: pure-JS over globalThis.__vfs heap object (snapshot-persisted). R2: host-call via host.__fs({op:'read',...}) -> DO-side r2_fs_op -> R2 GET with optional range.  
  *constraint:* VFS path: sync possible because all data lives in WASM linear memory (no async IO). R2 path: every host IO crosses the WASM<->JS boundary as an async host-call; the 6-WASI-fn ceiling forbids real file descriptors. Scratch buffer cap (~32 MB) bounds single-read size.  
  *evidence:* apps/kernel/engine/src/lib.rs:2379 (readFileSync VFS impl), apps/kernel/engine/src/lib.rs:2439-2442 (hReadFile R2 impl), apps/kernel/engine/src/lib.rs:2530 (promises dispatch A() wrapper), apps/kernel/engine/src/lib.rs:2434-2438 (scratch-buffer read note), apps/kernel/src/lib.rs:4319-4439 (r2_fs_op 'read' arm)
- **writeFileSync / fs.promises.writeFile** `[partial]` — api: `fs.writeFileSync / fs.promises.writeFile`  
  VFS provider: sync, correct for all encodings, replaces. R2 provider: promises-only; body chunked in 32 KB slices across host-calls (each chunk < 64 KB HOSTCALL buffer); chunks are STAGED in DO memory and flushed to R2 only at the cell's checkpoint commit — so a write is not durable until the cell completes. Divergence from Node: a process crash mid-cell loses the write (staged-commit model, not POSIX atomic write-then-rename). Acceptable for most tooling; silently wrong if code inspects Node's synchronous durability guarantee.  
  *mechanism:* VFS: pure-JS heap mutation. R2: host-call chain -> DO-side r2_fs_op 'write' -> staged into DO StagedFs buffer -> flush_staged_fs at checkpoint -> R2 PUT + fs_files upsert.  
  *constraint:* 64 KB HOSTCALL request buffer forces chunked writes. Staged-commit is required by the DO single-threaded model: R2 writes must be coherent with the heap snapshot (same checkpoint version). No POSIX fdatasync/fsync semantics possible.  
  *evidence:* apps/kernel/engine/src/lib.rs:2377 (writeFileSync VFS), apps/kernel/engine/src/lib.rs:2426-2432 (hWriteFile chunked staging), apps/kernel/engine/src/lib.rs:2419-2422 (FS_CHUNK = 32 KB comment), apps/kernel/src/lib.rs:4442-4469 (r2_fs_op 'write' staging arm), apps/kernel/src/lib.rs:1177-1231 (flush_staged_fs at checkpoint)
- **appendFileSync / fs.promises.appendFile** `[partial]` — api: `fs.appendFileSync / fs.promises.appendFile`  
  VFS: correct, concatenates bytes in-heap. R2: implemented as read-then-write (hAppendFile = hReadFile + hWriteFile). This is NOT atomic — a concurrent cell (impossible within one DO but relevant across cells) or a crash after the read but before the write would silently truncate. For a single-tenant sequential REPL the divergence is benign. Missing: no O_APPEND flag semantics (no atomic append to R2 object).  
  *mechanism:* VFS: pure-JS byte concatenation. R2: host-call read + write round-trip via hAppendFile.  
  *constraint:* R2 has no partial PUT / atomic append. All R2 writes are PUT-whole-object.  
  *evidence:* apps/kernel/engine/src/lib.rs:2378 (appendFileSync VFS), apps/kernel/engine/src/lib.rs:2444 (hAppendFile = hReadFile + hWriteFile), apps/kernel/engine/src/lib.rs:2530-2532 (promises.appendFile dispatch)
- **readdirSync / fs.promises.readdir** `[stub-unacceptable]` — api: `fs.readdirSync / fs.promises.readdir`  
  VFS: works including `{withFileTypes:true}` returning Dirent objects. R2 (hReaddir): calls hostFs('list') which returns only flat file names (r.names array) — no Dirent objects, no `{withFileTypes:true}` support. Code that passes `{withFileTypes:true}` to `fs.promises.readdir` under the R2 provider gets back plain strings, not Dirent instances; isDirectory()/isFile() calls blow up. Libraries like isomorphic-git and glob that rely on withFileTypes will silently get wrong results or throw.  
  *mechanism:* VFS: pure-JS scan of __vfs.files/__vfs.dirs. R2: host-call -> r2_fs_op 'list' -> returns names[] only.  
  *constraint:* R2 is a flat key-value store with no directory concept; the 'list' op returns the immediate-child name set from fs_files rows but has no isDirectory flag per entry. Synthesizing Dirent objects would require a second stat per entry (N host-calls for N children).  
  *evidence:* apps/kernel/engine/src/lib.rs:2392 (readdirSync VFS with Dirent), apps/kernel/engine/src/lib.rs:2446 (hReaddir returns r.names only, no withFileTypes), apps/kernel/engine/src/lib.rs:2532 (promises.readdir uses hReaddir for non-vfs), apps/kernel/src/lib.rs:4495-4523 (r2_fs_op 'list' returns name strings only)
- **statSync / lstatSync / fs.promises.stat / fs.promises.lstat** `[stub-acceptable]` — api: `fs.statSync / fs.promises.stat`  
  Returns {size, mtimeMs, mode, isFile(), isDirectory(), isSymbolicLink()}. Missing real POSIX fields: atime, ctime, birthtime, nlink, ino, dev, uid, gid, blocks, blksize. VFS mtimeMs is always 0 (hardcoded). R2 mtimeMs maps to created_ms (write time), not true mtime; container-written files return mtime:0. lstat is an alias for stat (no symlink distinction). The subset returned is sufficient for bundlers/git clients that only check size + isFile/isDirectory; code that reads numeric timestamps for ordering or POSIX mode bits will get wrong answers.  
  *mechanism:* VFS: pure-JS from __vfs metadata. R2 (hStat): host-call -> r2_fs_op 'stat' -> fs_files row or R2 HEAD fallback.  
  *constraint:* VFS is a flat byte store with no inode table. No OS kernel to supply atime/ctime/nlink/ino. Determinism requires all timestamps be seeded or fixed.  
  *evidence:* apps/kernel/engine/src/lib.rs:2395 (statSync VFS: mtimeMs:0, mode hardcoded), apps/kernel/engine/src/lib.rs:2447 (hStat: mtimeMs from r.mtimeMs), apps/kernel/src/lib.rs:1473-1510 (vfs_stat: mtime=created_ms for files, 0 for dirs/container files), apps/kernel/src/lib.rs:4479-4493 (r2_fs_op 'stat': no mtime returned)
- **mkdirSync / fs.promises.mkdir** `[stub-acceptable]` — api: `fs.mkdirSync / fs.promises.mkdir`  
  VFS: correct including recursive:true. R2 provider: mkdir is a no-op (the async implementation is `async function(){ /* r2 has no dirs */ }`). This is intentional (R2 is a flat key store; paths implied by file keys), but code that calls `await fs.promises.mkdir('/workspace/foo', {recursive:true})` under the R2 provider gets `undefined` silently (no error, no directory created, no EEXIST). Most modern tooling that does `mkdir({recursive:true})` before writes tolerates a no-op; code that checks the returned path or expects EEXIST to throw will break.  
  *mechanism:* VFS: pure-JS __vfs.dirs mutation. R2: literal no-op function.  
  *constraint:* R2 has no concept of directories. Emulating them would require a sentinel key, adding complexity and latency for no gain (file writes auto-create parent path structure).  
  *evidence:* apps/kernel/engine/src/lib.rs:2375 (mkdirSync VFS with recursive), apps/kernel/engine/src/lib.rs:2531 (mkdir: A(mkdirSync, async function(){ /* r2 has no dirs */ }))
- **unlinkSync / rmSync / rmdirSync / fs.promises.unlink / fs.promises.rm / fs.promises.rmdir** `[partial]` — api: `fs.unlinkSync / fs.rmSync / fs.promises.unlink`  
  VFS: unlinkSync/rmSync correct. rmSync with recursive:true deletes files and dirs recursively. rmdirSync is an alias of rmSync. VFS does NOT throw ENOTEMPTY on non-empty rmdir without recursive (no check). R2: hUnlink stages a delete tombstone; correct for files. R2 provider has no concept of rmdir (no-op equivalent). VFS rename of a directory does NOT move child files (only moves the dir key itself: `V.dirs[b] = true; delete V.dirs[a]` without re-parenting children), which silently breaks directory moves.  
  *mechanism:* VFS: pure-JS __vfs mutation. R2: staged FsStageOp::Delete flushed at checkpoint.  
  *constraint:* VFS is a flat key/value store; directories are separate key sets with no enforced parent-child link. No OS-level dir locking or nlink tracking.  
  *evidence:* apps/kernel/engine/src/lib.rs:2380-2381 (unlinkSync, rmSync), apps/kernel/engine/src/lib.rs:2393 (renameSync: dir rename does NOT move children), apps/kernel/engine/src/lib.rs:2520 (rmdirSync alias), apps/kernel/engine/src/lib.rs:2532 (promises.rmdir = hUnlink for R2)
- **renameSync / fs.promises.rename** `[stub-unacceptable]` — api: `fs.renameSync / fs.promises.rename`  
  VFS file rename: correct (moves file entry, preserves bytes). VFS directory rename: silently broken — only the dir key is moved, none of the child file or subdir keys are updated, so any file under the old path becomes orphaned. R2 rename: implemented as hReadFile(a) + hWriteFile(b) + hUnlink(a), which is NOT atomic and reads the entire file body into WASM memory (doubles memory pressure). Large-file directory rename under VFS will silently produce an inconsistent state.  
  *mechanism:* VFS: pure-JS __vfs key mutation. R2: three sequential host-calls (read + write + delete).  
  *constraint:* VFS is a flat key store with no tree structure. R2 has no rename primitive; PUT + DELETE is the only mechanism.  
  *evidence:* apps/kernel/engine/src/lib.rs:2393 (renameSync: only V.dirs[b]=true; delete V.dirs[a], NO child re-parenting), apps/kernel/engine/src/lib.rs:2533 (promises.rename = read+write+delete)
- **copyFileSync / fs.promises.copyFile** `[stub-acceptable]` — api: `fs.copyFileSync / fs.promises.copyFile`  
  VFS: copies bytes correctly. R2: read whole file then write (non-atomic, but acceptable for a single-tenant REPL). COPYFILE_EXCL flag is not respected (overwrites silently).  
  *mechanism:* VFS: pure-JS byte slice. R2: hReadFile + hWriteFile.  
  *constraint:* R2 has no server-side copy primitive. COPYFILE_EXCL would require an extra stat round-trip.  
  *evidence:* apps/kernel/engine/src/lib.rs:2394 (copyFileSync VFS), apps/kernel/engine/src/lib.rs:2534 (promises.copyFile = hWriteFile(b, await hReadFile(a))), apps/kernel/engine/src/lib.rs:2541 (constants includes COPYFILE_EXCL:1 but not enforced)
- **existsSync** `[partial]` — api: `fs.existsSync`  
  VFS: correct. R2 provider: existsSync is wrapped by S() which throws ERR_FS_ASYNC_ONLY (no sync path for host-backed). There is no `fs.promises.exists` exposed (Node deprecated it; access() is the canonical path). Under R2, code calling existsSync() will throw synchronously rather than return false, which is a breaking divergence for any guard pattern like `if (!fs.existsSync(p)) return`.  
  *mechanism:* VFS: pure-JS __vfs check. R2: sync throws, no async equivalent exposed.  
  *constraint:* R2 IO is inherently async. 6-WASI-fn ceiling forbids synchronous host IO.  
  *evidence:* apps/kernel/engine/src/lib.rs:2374 (existsSync VFS), apps/kernel/engine/src/lib.rs:2517 (existsSync: S(...) wrapper — throws for non-vfs), apps/kernel/engine/src/lib.rs:2539 (promises.access exists but existsSync not provided async)
- **realpathSync / fs.promises.realpath** `[stub-acceptable]` — api: `fs.realpathSync / fs.promises.realpath`  
  No symlinks in the VFS, so realpath just returns the normalized path after existence check. Diverges from Node only in that it never follows symlinks (there are none). ENOENT is thrown for a missing path, matching Node. The R2 async path checks existence via hExists (a stat round-trip).  
  *mechanism:* VFS: pure-JS norm + existence check. R2: hExists + norm.  
  *constraint:* VFS has no inode table or symlink table. Symlinks stored as plain file bytes (symlinkSync writes target as bytes).  
  *evidence:* apps/kernel/engine/src/lib.rs:2452 (realpathSync VFS), apps/kernel/engine/src/lib.rs:2538 (promises.realpath R2)
- **symlinkSync / fs.promises.symlink / readlinkSync / fs.promises.readlink** `[stub-unacceptable]` — api: `fs.symlinkSync / fs.promises.symlink / fs.readlinkSync`  
  symlinkSync writes the symlink target as a PLAIN FILE containing the target path string — no actual symbolic link semantics. readlinkSync always throws EINVAL (correct for VFS with no real symlinks, but wrong if code called symlinkSync first and expects to read back the target). Any library that creates a symlink and then opens the link expecting transparent dereferencing (e.g. pnpm hoisting, git index symlinks) will get a file containing a string instead of the linked content. Isomorphic-git explicitly catches readlinkSync EINVAL, but other libraries won't.  
  *mechanism:* VFS: symlinkSync writes target string as file bytes. readlinkSync unconditionally throws EINVAL. R2: symlink = hWriteFile(p, String(t)); readlink = delegates to VFS readlinkSync (always EINVAL).  
  *constraint:* VFS is a flat byte store with no inode or symlink table. Symlink semantics (kernel-level dereference on open) are impossible without OS support.  
  *evidence:* apps/kernel/engine/src/lib.rs:2396-2400 (VFS has no symlinks comment + readlinkSync EINVAL + symlinkSync writes bytes), apps/kernel/engine/src/lib.rs:2536-2537 (promises: readlink->readlinkSync always EINVAL; symlink->hWriteFile)
- **fs.promises.access** `[stub-acceptable]` — api: `fs.promises.access / fs.accessSync`  
  access() with no mode (F_OK) checks existence and throws ENOENT if absent. R_OK/W_OK/X_OK mode flags are accepted but not checked (the VFS has no permission model). Node's access() with mode R_OK can throw EACCES even if the file exists; this implementation never throws EACCES for mode reasons. Acceptable for the common `try { await access(p) } catch { /* not found */ }` pattern.  
  *mechanism:* VFS: existsSync. R2: hExists stat round-trip.  
  *constraint:* VFS has no Unix permission bits. No uid/gid/umask in the sandbox.  
  *evidence:* apps/kernel/engine/src/lib.rs:2539 (promises.access: only existence check, mode ignored)
- **createReadStream** `[partial]` — api: `fs.createReadStream`  
  VFS provider: works; emits one chunk (entire file bytes or {start,end} slice) on microtask, emits 'open'/'ready'/'end'/'close'. Not a true streaming read — no highWaterMark chunking, no pause/resume backpressure against disk, single-shot push. For files that fit in memory (all VFS files do) this is fine. R2 provider: throws ERR_FS_ASYNC_ONLY synchronously (not implemented). Libraries expecting createReadStream to work in R2 mode will break.  
  *mechanism:* VFS: in-VM Readable (stream module) with queueMicrotask push of full bytes.  
  *constraint:* VFS is a flat in-memory byte store; a single push is correct. R2 would require an async pull-based implementation that suspends the VM per chunk — not built. WASM VM has no thread to park for true streaming.  
  *evidence:* apps/kernel/engine/src/lib.rs:2461-2486 (createReadStream: vfs-only, single-chunk push), apps/kernel/engine/src/lib.rs:2462 (provider() !== 'vfs' -> throws asyncOnly)
- **createWriteStream** `[partial]` — api: `fs.createWriteStream`  
  VFS provider: works; buffers all chunks in memory, commits to VFS on stream finish (end()). Flags 'w' (truncate) and 'a' (append) honoured. bytesWritten set on finish. Not a true streaming write — the whole body accumulates in memory before the VFS mutation (same as writeFileSync). R2 provider: throws ERR_FS_ASYNC_ONLY (not implemented). No fd-based file handle, no O_SYNC, no highWaterMark backpressure against a real sink.  
  *mechanism:* VFS: in-VM Writable whose _final calls writeFileSync/appendFileSync.  
  *constraint:* VFS is a flat in-memory byte store. R2 would require async staging of the entire body, which is equivalent to writeFile and not incrementally durable.  
  *evidence:* apps/kernel/engine/src/lib.rs:2487-2509 (createWriteStream: vfs-only, buffer-then-commit), apps/kernel/engine/src/lib.rs:2488 (provider() !== 'vfs' -> throws asyncOnly)
- **fs.promises.open / FileHandle** `[absent]` — api: `fs.promises.open / fs.FileHandle`  
  No open() returning a FileHandle object. No fd-based read/write/close/fstat/ftruncate/fsync. Libraries that use the low-level FileHandle API (e.g. sqlite3 wasm, some tar writers) will throw 'fs.promises.open is not a function'.  
  *mechanism:* Not implemented.  
  *constraint:* File descriptors require OS kernel support (fd table, per-fd position tracking). The 6-WASI-fn ceiling and the absence of a real POSIX layer inside the WASM sandbox make true fds impossible. A pure-JS FileHandle emulation over the VFS is buildable but not built.  
  *evidence:* apps/kernel/engine/src/lib.rs:2529-2540 (promises object definition — no 'open' key)
- **fs.watch / fs.watchFile / fs.unwatchFile** `[impossible]` — api: `fs.watch / fs.watchFile`  
  Not present and cannot be built. The VFS is a plain in-memory object in a single-threaded WASM VM — there is no OS inotify/kqueue/FSEvents facility. A polling emulation would require real timers and a background ticker, but the VM clock is frozen in-turn and there is no native event loop. Even if polling were implemented it would only observe in-heap VFS changes, not changes from the container or other cells.  
  *mechanism:* Not implemented. No mention anywhere in the codebase.  
  *constraint:* Single-threaded WASM VM with frozen in-turn clock, no OS file-change notification, no background threads, no event loop outside eval turns.  
  *evidence:* apps/kernel/engine/src/lib.rs:2516-2547 (fs object definition — no watch/watchFile/unwatchFile keys)
- **process.cwd() / process.chdir()** `[real]` — api: `process.cwd / process.chdir`  
  Fully implemented with /workspace root clamping. chdir resolves paths via __wsResolveAbs (same normalizer as fs path resolution), throws EACCES on escape above /workspace. cwd() returns globalThis.__cwd or '/workspace'. State is a JS global (__cwd), snapshot-persisted, survives hibernate/restore. Relative paths in all fs methods resolve against this cwd. The DO-side norm_fs_path_cwd mirrors the exact same logic for the R2 provider and out-of-band vfs-* ops.  
  *mechanism:* Pure-JS global __cwd + __wsResolveAbs in the bootstrap. DO-side mirror in norm_fs_path_cwd (Rust).  
  *constraint:* None — this is fully in-heap and deterministic.  
  *evidence:* apps/kernel/engine/src/lib.rs:809-810 (process.cwd / process.chdir), apps/kernel/engine/src/lib.rs:800-806 (__wsResolveAbs with EACCES escape guard), apps/kernel/src/lib.rs:4199-4254 (norm_fs_path_cwd Rust mirror)
- **Unified /workspace — cell fs ↔ R2 ↔ container coherence** `[partial]` — api: `N/A (platform-level, not a Node API)`  
  Cell writes under R2 provider are staged and become visible in R2 only after checkpoint (not within the same cell's reads — the staged overlay handles read-after-write within a cell). Container (engram-sandbox) writes go directly to R2 with no fs_files row; a cell reads container files via direct R2 GET fallback (no row check fails, falls back to R2 HEAD+GET). Direction cell->container is visible immediately (R2 is the shared store). fsVersion is bumped on every durable mutation and exported to R2 manifest.json for external readers. Divergence: container-written files have mtime:0 in stat (R2 HEAD returns no created_ms). Out-of-band vfs-write (SDK upload) bypasses the staged-commit model and is immediately durable.  
  *mechanism:* R2 as shared data plane. fs/<doId>/ key prefix with isolation. Staged-commit for cell writes, immediate PUT for vfs-write frames.  
  *constraint:* DO single-thread means no concurrent cell writes, but the staged-commit model means writes are not durable until cell completes. R2 has no compare-and-swap, no partial PUT.  
  *evidence:* apps/kernel/src/lib.rs:1122-1170 (write_manifest, unified-fs merge), apps/kernel/src/lib.rs:4344-4398 (r2_fs_op read: container fallback via direct R2 GET), apps/kernel/src/lib.rs:1285-1389 (vfs_write: immediate-durable, outside staged-commit)
- **chmod / chown / fchmod / fchown / lchown / utimes / lutimes / futimes / fdatasync / fsync / ftruncate / truncate** `[absent]` — api: `fs.chmodSync, fs.chownSync, fs.utimesSync, etc.`  
  None of these POSIX metadata-manipulation APIs exist. Code that calls them (e.g. npm install scripts, tar extraction with permissions, git checkout with executable bit) will throw 'fs.chmodSync is not a function'. The VFS has no permission model, no uid/gid, no atime/mtime update API.  
  *mechanism:* Not implemented.  
  *constraint:* VFS is a flat byte store with no Unix metadata. No OS kernel in the WASM sandbox to honor these calls.  
  *evidence:* apps/kernel/engine/src/lib.rs:2516-2547 (full fs object: no chmod/chown/utimes/truncate keys)
- **mtimeMs / atime / ctime / birthtime in stat()** `[stub-unacceptable]` — api: `fs.Stats fields`  
  VFS statSync always returns mtimeMs:0 (hardcoded). R2 stat returns mtimeMs=created_ms (wall time of first write under config.clock=real; always 0 for vfs provider or container-written files). atime/ctime/birthtime are absent from the returned object entirely. Code that sorts files by mtime (build tools, git status, make-style incremental builds) will treat all files as equally old (epoch 0) and skip rebuilds or produce wrong ordering. This is a real correctness trap for users using engram as a build environment.  
  *mechanism:* VFS: hardcoded mtime:0 in statSync. R2: created_ms from fs_files row.  
  *constraint:* VFS is deterministic; a real wall-clock mtime would break determinism (clock is seeded). Even with clock:real, the mtime field is not updated on subsequent writes (only created_ms is stored, not updated).  
  *evidence:* apps/kernel/engine/src/lib.rs:2395 (statSync: mtimeMs:0 hardcoded), apps/kernel/engine/src/lib.rs:2377 (writeFileSync: mtime:0 on every write), apps/kernel/src/lib.rs:1474 (vfs_stat doc: mtime maps to created_ms), apps/kernel/src/lib.rs:1490-1498 (vfs_stat responses: mtime=created for files, 0 for dirs)
- **fs.Dirent (instanceof / constructor exposure)** `[real]` — api: `fs.Dirent`  
  Dirent constructor exposed as fs.Dirent. isFile(), isDirectory(), isSymbolicLink(), isBlockDevice(), isCharacterDevice(), isFIFO(), isSocket() all implemented. .name, .path, .parentPath set correctly. instanceof fs.Dirent works. Only limitation: isSymbolicLink() always returns false (no symlinks in VFS).  
  *mechanism:* Pure-JS constructor in engine bootstrap.  
  *constraint:* None.  
  *evidence:* apps/kernel/engine/src/lib.rs:2384-2391 (Dirent constructor and prototype methods), apps/kernel/engine/src/lib.rs:2528 (Dirent exposed on fs object)
- **fs.constants** `[stub-acceptable]` — api: `fs.constants`  
  Exposes F_OK/R_OK/W_OK/X_OK/O_RDONLY/O_WRONLY/O_RDWR/O_CREAT/O_TRUNC/O_APPEND/COPYFILE_EXCL. Missing: O_EXCL, O_NONBLOCK, O_SYNC, O_DSYNC, S_IFMT/S_IFREG/S_IFDIR/S_IFLNK/UV_FS_COPYFILE_FICLONE etc. Most libraries that import fs.constants only use F_OK/R_OK.  
  *mechanism:* Pure-JS literal object.  
  *constraint:* None — this is purely cosmetic.  
  *evidence:* apps/kernel/engine/src/lib.rs:2541 (constants: F_OK through COPYFILE_EXCL)
- **VFS in-heap durability (snapshot-persisted across hibernate)** `[real]` — api: `N/A (engram-specific, no Node equivalent)`  
  The entire __vfs object (files dict + dirs dict) lives in the QuickJS heap and is snapshotted with every heap checkpoint into DO SQLite/R2. After a genuine DO eviction and cold restore, the VFS contents are fully intact — this is the core value proposition. Size is bounded by the heap size-admission cap (~18-20 MB raw dump ceiling; see v0.7 guard). VFS itself does not count toward the separate R2 committed file index.  
  *mechanism:* globalThis.__vfs is a plain JS object in WASM linear memory; dump/restore of linear memory preserves it exactly. No special serialization.  
  *constraint:* Monotonic WASM memory: VFS files count toward the heap high-water-mark and are never reclaimed without a scrub (W4 arena scrub zeros freed pages but does not shrink linear memory).  
  *evidence:* apps/kernel/engine/src/lib.rs:2337-2343 (VFS design comment: durable, deterministic, in-heap), CLAUDE.md status section v0.2 (arena SCRUB, used-heap guard, snapshot persistence)

### net (TCP sockets via cloudflare:sockets host shim: connect/server/keepalive/read-block)

- **net.connect / net.createConnection (outbound TCP client)** `[partial]` — api: `net.connect(port[,host][,cb]) / net.createConnection(options[,cb])`  
  Outbound connect to public hosts works: emits 'connect'/'ready', queues pre-connect writes, honors allowHalfOpen. Non-public (loopback/private/RFC1918/link-local/CGNAT) is hard-blocked by dual SSRF guards (kernel-glue.ts:1757-1763 + host-sockets.mjs:93-125). Unix-domain sockets (options.path) throw ENOTSUP synchronously. Port 0 is syntactically accepted (passes 0-65535 range check) but cloudflare:sockets will reject it at connect time — no ephemeral-port assignment; localPort stays undefined. remoteAddress/remotePort are populated from the user-supplied host string (not from the OS), so they reflect the DNS name, not the resolved IP.  
  *mechanism:* host-call: socket.open -> cloudflare:sockets connect() in the DO; integer handleId token in VM heap. VM shim in apps/kernel/stdlib-src/shims/net.js, host provider in apps/kernel/src/host-sockets.mjs, dispatch in apps/kernel/src/kernel-glue.ts:1757-1764.  
  *constraint:* cloudflare:sockets is outbound-only (no listen); SSRF policy blocks private IPs; no OS networking inside WASM isolate; 12-import WASM ceiling means all I/O must cross the host boundary.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:1-44 (header, constraints), apps/kernel/stdlib-src/shims/net.js:218-290 (Socket.prototype.connect), apps/kernel/stdlib-src/shims/net.js:226-228 (unix-domain ENOTSUP), apps/kernel/src/host-sockets.mjs:93-125 (ssrfReason SSRF guard), apps/kernel/src/kernel-glue.ts:1757-1764 (_socketOpen, dual SSRF + fetch allowlist)
- **net.Socket (Duplex stream: read / write / end / destroy)** `[partial]` — api: `net.Socket (inherits stream.Duplex)`  
  Socket IS a Duplex subclass; write/end/destroy all work with the correct Node callback shape. All binary data crosses the DO boundary as base64 (JSON envelope), adding latency and a chunking round-trip (1MB SOCKET_READ_CHUNK_BYTES per socket.read call). The VM-side _deliver() picks between .emit('data') and .push() based on flowing state but does not implement the full Readable._read() protocol — it has no _read override, meaning consumers that use the Readable.read(n) pull model (rather than 'data' events or for-await) may not get data flushed correctly. Encoding support in write() is utf8 only; latin1/ascii/hex/base64 encodings on write() are silently treated as utf8.  
  *mechanism:* pure-JS shim over host-call chain: each read/write/close is a sequential JSON host call via the per-socket _runLoop. apps/kernel/stdlib-src/shims/net.js:178-563.  
  *constraint:* No real streaming primitives across the WASM boundary; the engine has a single global __settleHost slot so all host calls must be strictly sequential (no concurrent host I/O). base64 encoding is the only safe way to pass bytes through the 64KB JSON envelope.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:54-58 (toU8, only utf8 fallback), apps/kernel/stdlib-src/shims/net.js:62-88 (_hostCall, sequential global tail), apps/kernel/stdlib-src/shims/net.js:313-376 (_startLoop, command loop), apps/kernel/stdlib-src/shims/net.js:385-396 (_deliver, data event vs push), apps/kernel/src/host-sockets.mjs:49 (SOCKET_READ_CHUNK_BYTES = 1MB)
- **net.Socket.setKeepAlive / TCP keepalive knobs** `[stub-unacceptable]` — api: `socket.setKeepAlive(enable[,initialDelay])`  
  setKeepAlive() is a pure no-op that returns `this`. cloudflare:sockets exposes no TCP keepalive knobs, so the SO_KEEPALIVE socket option cannot be set. Code that relies on keepalive to detect dead connections (e.g. database connection pools, long-lived Redis/Postgres clients) will silently get no keepalives. The socket will appear alive to the VM until the peer closes or the DO is evicted — there is no OS-level detection of a broken connection.  
  *mechanism:* pure-JS no-op shim in apps/kernel/stdlib-src/shims/net.js:520.  
  *constraint:* cloudflare:sockets SocketOptions exposes only secureTransport and allowHalfOpen — no TCP_KEEPIDLE, TCP_KEEPINTVL, or TCP_KEEPCNT. Not configurable from the DO.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:519-521 (setNoDelay/setKeepAlive/setTimeout no-ops), apps/kernel/stdlib-src/shims/net.js:7-13 (keep-alive / no inactivity timer warning)
- **net.Socket.setTimeout / inactivity timeout** `[stub-unacceptable]` — api: `socket.setTimeout(ms[,cb]) -> emits 'timeout' event`  
  setTimeout() records the ms value and registers the callback on 'timeout', but the 'timeout' event is NEVER emitted. The host socket.read call blocks (awaits reader.read()) with no time limit; there is no mechanism to abort a parked host call from the VM. Code that sets a socket timeout to handle idle connections (HTTP clients, database clients) will hang forever on a connection that stops sending data without closing, rather than receiving a 'timeout' event.  
  *mechanism:* pure-JS no-op shim, apps/kernel/stdlib-src/shims/net.js:521. Explicitly documented as an open tracked item in the shim header.  
  *constraint:* Timers in the VM fire on the microtask queue ignoring wall-clock delay (seeded determinism); there is no mechanism to cancel an in-flight host await from a VM-side timer. The fix would require a time-bounded host read on the DO side (not implemented).  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:7-13 (explicit ⚠ warning: parks forever, tracked item), apps/kernel/stdlib-src/shims/net.js:521 (setTimeout no-op), apps/kernel/engine/src/lib.rs:2261 (timers are immediate, no wall clock)
- **net.Socket.setNoDelay / TCP_NODELAY** `[stub-acceptable]` — api: `socket.setNoDelay([noDelay])`  
  No-op that returns `this`. cloudflare:sockets does not expose TCP_NODELAY. In practice Nagle's algorithm rarely matters for application-layer code that drives a full request-response; the divergence is invisible unless sub-millisecond write coalescing behavior is being tested.  
  *mechanism:* pure-JS no-op shim, apps/kernel/stdlib-src/shims/net.js:519.  
  *constraint:* cloudflare:sockets SocketOptions does not include TCP_NODELAY.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:519 (setNoDelay no-op)
- **socket.read-block (blocking read / idle long-poll)** `[stub-unacceptable]` — api: `Readable data delivery from a live socket that stops sending (HTTP keep-alive, long-poll, idle DB connection)`  
  socket.read on the host side performs a single await reader.read() with no timeout. If the peer holds the connection open and sends no further bytes (HTTP keep-alive without Connection:close, an idle Redis connection waiting for a SUBSCRIBE push, etc.), the read loop parks forever — the cell never completes, the VM mutex is never released, and the kernel becomes unresponsive for that session. The shim header explicitly warns callers to ensure the peer half-closes. In Node.js the 'timeout' event and socket.destroy() provide an escape; here the timeout event is never emitted (see above).  
  *mechanism:* host-sockets.mjs:267 (`await r.read()` with no AbortSignal/timeout); shim comment at net.js:7-13.  
  *constraint:* No AbortSignal threading from the VM host-call boundary to the DO-side reader.read(); seeded deterministic timers cannot cancel in-flight DO-side awaits.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:7-13 (explicit ⚠ warning), apps/kernel/src/host-sockets.mjs:267 (await r.read(), no timeout/AbortSignal)
- **Concurrent outbound socket limit (EMFILE)** `[real]` — api: `net.connect() beyond OS fd limit -> EMFILE`  
  The 7th concurrent open socket surfaces a typed EMFILE error (code 'EMFILE') both at the VM shim level (local guard, MAX_SOCKETS=6) and at the host level (SOCKET_MAX_CONCURRENT=6). The error fires synchronously on the next tick, never hangs. This mirrors Node's EMFILE behavior, though the limit is 6 (per cloudflare:sockets per-invocation cap) vs Node's OS-level fd limit.  
  *mechanism:* dual guard: VM shim apps/kernel/stdlib-src/shims/net.js:161-245 + host apps/kernel/src/host-sockets.mjs:196-204.  
  *constraint:* cloudflare:sockets caps concurrent connections awaiting response at 6 per invocation.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:162 (MAX_SOCKETS=6), apps/kernel/stdlib-src/shims/net.js:238-244 (local EMFILE guard), apps/kernel/src/host-sockets.mjs:47-48 (SOCKET_MAX_CONCURRENT=6), apps/kernel/src/host-sockets.mjs:196-204 (host EMFILE guard)
- **Socket durability across DO hibernation/cold-restore** `[stub-unacceptable]` — api: `Node sockets survive process lifetime; reconnect is explicit`  
  Live sockets are held in a DO-memory Map that is NOT snapshotted. After a cold-restore the VM heap still holds stale handleIds. Any read/write on a stale handle returns a typed ECONNRESET-coded error rather than hanging — that part is safe. However, Node code that holds a net.Socket object across an `await` that happens to trigger DO eviction will get a silent ECONNRESET with no reconnect logic, and the 'close' event fires with hadError=true. There is no lifecycle event to warn that the DO hibernated. Code that pools or reuses connections across session boundaries (e.g. a persistent DB connection) will break silently.  
  *mechanism:* host-sockets.mjs:128-168 (Map in DO memory, not in snapshot); net.js:30-32 (durability comment); host-sockets.mjs:229-232 and 252-255 (stale-handle ECONNRESET path).  
  *constraint:* DO hibernation tears down the in-memory JS context including all live sockets; WASM linear memory (the heap snapshot) cannot encode a live OS socket.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:30-32 (DURABILITY warning), apps/kernel/src/host-sockets.mjs:8-10 (map in DO memory, dies on eviction), apps/kernel/src/host-sockets.mjs:229-232 (stale-handle ECONNRESET on write), apps/kernel/src/host-sockets.mjs:252-255 (stale-handle ECONNRESET on read)
- **net.Server / createServer / listen (inbound TCP)** `[impossible]` — api: `net.createServer([options][,connectionListener]) + server.listen(port[,host][,cb])`  
  net.createServer() throws a typed NotSupportedError (code 'EPERM') immediately. net.Server.listen() throws the same. There is also a host backstop in host-sockets.mjs:330-332. Cloudflare Workers/DOs have no TCP listen capability; they only receive HTTP/WebSocket connections brokered by the CF edge. This is a hard platform constraint, not a missing implementation.  
  *mechanism:* VM shim throws synchronously: net.js:540-542 (Server), net.js:527 (Socket.prototype.listen). Host backstop: host-sockets.mjs:329-332.  
  *constraint:* Cloudflare DO/Worker has no inbound TCP socket API; all inbound traffic arrives as HTTP/WebSocket requests via the fetch() handler.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:97-100 (notSupported, EPERM), apps/kernel/stdlib-src/shims/net.js:540-542 (Server/createServer throw), apps/kernel/stdlib-src/shims/net.js:527 (Socket.prototype.listen throw), apps/kernel/src/host-sockets.mjs:329-332 (host backstop listen -> EPERM)
- **Unix-domain sockets / IPC (options.path)** `[impossible]` — api: `net.connect({path: '/tmp/foo.sock'})`  
  connect({path:...}) triggers an async ENOTSUP error ('unix-domain sockets (options.path) are not supported on this substrate'). There is no filesystem namespace shared with a peer process; the only socket primitive is outbound TCP via cloudflare:sockets.  
  *mechanism:* VM shim: net.js:226-228.  
  *constraint:* No shared Unix namespace on Cloudflare Workers; no peer processes to connect to.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:226-228 (path -> ENOTSUP async)
- **dgram / UDP sockets** `[impossible]` — api: `require('dgram').createSocket('udp4')`  
  No dgram shim exists. require('dgram') hits the excluded-module list in __nodeCompat (lib.rs:2225,2247) and throws NotSupportedError with 'UDP sockets — no networking primitives. No alternative.' cloudflare:sockets is TCP-only.  
  *mechanism:* excluded module, lib.rs:2225+2247.  
  *constraint:* cloudflare:sockets is TCP-only; no UDP primitives on Cloudflare Workers.  
  *evidence:* apps/kernel/engine/src/lib.rs:2225 (excluded list includes 'dgram'), apps/kernel/engine/src/lib.rs:2247 (excludedReasons.dgram)
- **tls.connect / TLS-from-start** `[partial]` — api: `tls.connect(options[,cb]) with secureTransport:'on'`  
  TLS-from-start works: opens the host socket with secureTransport:'on', cloudflare:sockets performs the TLS handshake on the DO side, and the socket emits 'secureConnect'. TLS terminates entirely host-side — the VM never sees certificates or key material. Cert/key/ca/passphrase options are accepted but silently ignored (tls.js:15). authorized is always reported as true on any successful handshake (tls.js:51), so cert-verification failures at the CF layer do not surface as authorized=false in the VM. getPeerCertificate() returns {}; getProtocol() returns the nominal 'TLSv1.3' (not negotiated); getCipher() returns all-null.  
  *mechanism:* host-call: socket.open with secureTransport:'on' -> cloudflare:sockets. VM shim: apps/kernel/stdlib-src/shims/tls.js:64-99.  
  *constraint:* TLS termination is in cloudflare:sockets (DO host), not the VM. Cert inspection/custom verification is impossible because the VM never receives the TLS session.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:1-19 (header, cert/key/ca ignored), apps/kernel/stdlib-src/shims/tls.js:49-61 (markSecure: authorized=true always, empty cert), apps/kernel/stdlib-src/shims/tls.js:93-99 (TLS-from-start path), apps/kernel/src/host-sockets.mjs:147-153 (secureTransport passed to connect())
- **STARTTLS upgrade (tls.connect({socket}) / tls.TLSSocket(plainSocket))** `[partial]` — api: `tls.connect({socket: existingSocket}) — upgrade plain to TLS mid-stream`  
  STARTTLS is implemented: a plain socket opened with secureTransport:'starttls' can be upgraded by calling socket._startTls() (or via tls.connect({socket})). The host calls socket.startTls() on the old handle, which calls cloudflare:sockets' .startTls() and returns a new Socket with a fresh handleId. The old read loop detects the handle swap on its next turn and exits; a new loop starts on the new handle. The divergence: the caller MUST pre-open the socket with secureTransport:'starttls' explicitly — there is no auto-detection. A plain socket opened with secureTransport:'off' (the default) will reject startTls with EINVAL.  
  *mechanism:* host-call: socket.startTls -> cloudflare:sockets .startTls(). VM shim: tls.js:71-89 (STARTTLS path), net.js:499-515 (_startTls), host-sockets.mjs:288-314 (startTls).  
  *constraint:* cloudflare:sockets .startTls() requires the socket was opened with secureTransport:'starttls'; the underlying socket object is consumed and a new one returned.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:71-89 (STARTTLS path), apps/kernel/stdlib-src/shims/net.js:499-515 (Socket._startTls), apps/kernel/src/host-sockets.mjs:288-314 (host startTls, EINVAL if not starttls)
- **TLS certificate / key / CA customization** `[stub-unacceptable]` — api: `tls.connect({cert, key, ca, rejectUnauthorized, checkServerIdentity})`  
  cert/key/ca/passphrase/rejectUnauthorized/pfx options are accepted by the API surface but SILENTLY IGNORED. TLS terminates in cloudflare:sockets on the DO host; the VM has no path to pass key material or custom CA bundles to the TLS layer. Code that sets rejectUnauthorized:false to allow self-signed certs, or that provides a custom CA, will believe these options are honored when they are not. checkServerIdentity() always returns undefined (never fails). authorized is always true.  
  *mechanism:* pure-JS shim: tls.js:49-61 (markSecure ignores all cert options, authorized hardcoded true). tls.js:122 (checkServerIdentity always undefined).  
  *constraint:* cloudflare:sockets manages TLS entirely host-side with CF's own cert store; no API to inject key material or custom trust anchors.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:15-16 (cert/key/ca ignored, header warning), apps/kernel/stdlib-src/shims/tls.js:51 (authorized hardcoded true), apps/kernel/stdlib-src/shims/tls.js:54-59 (getPeerCertificate={}, getProtocol nominal, getCipher all-null), apps/kernel/stdlib-src/shims/tls.js:122 (checkServerIdentity always undefined)
- **tls.Server / createServer (inbound TLS)** `[impossible]` — api: `tls.createServer(options, secureConnectionListener)`  
  tls.createServer() throws NotSupportedError (code 'EPERM') immediately, same as net.createServer(). No inbound socket capability on this substrate.  
  *mechanism:* VM shim: tls.js:118-120 (Server throws), tls.js:121 (createServer throws).  
  *constraint:* Same as net.Server — no inbound TCP on Cloudflare Workers/DOs.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:118-121 (Server/createServer throw EPERM)
- **socket.localAddress / localPort / address()** `[stub-acceptable]` — api: `socket.localAddress, socket.localPort, socket.address() -> {address,port,family}`  
  localAddress and localPort are initialized to undefined and never populated (cloudflare:sockets does not expose the ephemeral local address). address() always returns {}. Code that inspects the local bind address (e.g. for telemetry or PASV FTP mode) will get undefined/empty values. In most client-only code this is irrelevant.  
  *mechanism:* VM shim: net.js:203-204 (undefined init), net.js:524 (address() returns {}).  
  *constraint:* cloudflare:sockets does not report the local endpoint; DO workers have no fixed source IP.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:203-204, apps/kernel/stdlib-src/shims/net.js:524
- **SSRF / egress allowlist enforcement for sockets** `[real]` — api: `No direct Node equivalent — engram-specific capability gate`  
  Socket connections are subject to the same dual-layer SSRF block as fetch/ws: private/loopback/link-local/CGNAT IP ranges and .localhost/.local/.internal names are blocked at both kernel-glue (_socketOpen, kernel-glue.ts:1758-1760) and host-sockets (ssrfReason, host-sockets.mjs:93-125). Additionally, socket connections use the config.fetch allowlist (_fetchAllow): unset=allow-all, false=block-all, [hosts]=hostname whitelist (kernel-glue.ts:1761-1763). Both layers return typed FetchBlockedError/EACCES, never silent failures.  
  *mechanism:* dual host-call guard: kernel-glue.ts:1757-1764 (_socketOpen) + host-sockets.mjs:93-125 (ssrfReason).  
  *constraint:* Fail-closed SSRF defense required because DO can reach CF-internal metadata endpoints that must never be reachable from user cells.  
  *evidence:* apps/kernel/src/kernel-glue.ts:1757-1764 (_socketOpen), apps/kernel/src/host-sockets.mjs:93-125 (ssrfReason), apps/kernel/src/kernel-glue.ts:1761-1763 (_fetchAllow allowlist applied to sockets)
- **net.isIP / net.isIPv4 / net.isIPv6** `[real]` — api: `net.isIP(s), net.isIPv4(s), net.isIPv6(s)`  
  Full pure-JS implementations matching Node semantics. isIPv4 validates 4 octets 0-255 with no leading zeros. isIPv6 handles compressed notation, zone IDs, and embedded IPv4. isIP returns 4, 6, or 0.  
  *mechanism:* pure-JS in VM shim: net.js:119-159.  
  *constraint:* None — pure string validation, no host dependency.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:119-159
- **socket.ref() / socket.unref()** `[stub-acceptable]` — api: `socket.ref(), socket.unref() — prevent/allow process exit when socket is only active handle`  
  Both return `this` silently. In Node, ref/unref control whether an open socket keeps the event loop alive. In the engram VM there is no persistent event loop — the cell runs to completion or parks on a host call. The concept does not apply.  
  *mechanism:* pure-JS no-op: net.js:522-523.  
  *constraint:* No persistent event loop in the QuickJS-WASM substrate; all async execution is cell-scoped.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:522-523
- **socket.destroySoon() / socket.resetAndDestroy()** `[real]` — api: `socket.destroySoon(), socket.resetAndDestroy()`  
  destroySoon() delegates to destroy(). resetAndDestroy() destroys with a synthesized ECONNRESET error. Both emit 'error' and 'close' as expected.  
  *mechanism:* pure-JS shim: net.js:493-494.  
  *constraint:* None.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:493-494

### tls (TLS/starttls over the socket host shim)

- **tls.connect() — TLS-from-start (outbound client)** `[stub-acceptable]` — api: `tls.connect(port, host, options, cb) / tls.connect(options, cb)`  
  Functional for the common outbound-client case: opens the cloudflare:sockets handle with secureTransport:'on', emits 'secureConnect', sets .encrypted=true. Diverges: cert/key/ca/pfx/passphrase/rejectUnauthorized/secureProtocol/ciphers options are silently ignored (TLS terminates host-side; cloudflare:sockets does the handshake, VM never sees key material). authorized is hardcoded true on any successful connect. getPeerCertificate() returns {}, getCipher() returns {name:null,…}, getProtocol() returns hardcoded 'TLSv1.3' regardless of actual negotiated version. SNI is accepted (options.servername stored on socket) but NOT forwarded to cloudflare:sockets — the host uses the connection hostname for SNI, so servername overrides are silently dropped.  
  *mechanism:* Pure-JS IIFE shim (stdlib-src/shims/tls.js) in the QuickJS heap; all I/O crosses host boundary via host['socket.open'](addr, {secureTransport:'on'}) in the DO (host-sockets.mjs), which calls cloudflare:sockets connect(). Shim is in STDLIB defaults, auto-loaded at create.  
  *constraint:* TLS termination lives in cloudflare:sockets on the DO host; the WASM VM has no access to raw TLS libraries or key material. No WASM import slot consumed for TLS (12-import ceiling constraint not binding here).  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:1-99 (connect(), markSecure(), TLS-from-start path), apps/kernel/stdlib-src/shims/tls.js:51-62 (markSecure: authorized=true hardcoded, getPeerCertificate={}, getProtocol='TLSv1.3'), apps/kernel/stdlib-src/shims/tls.js:15-16 (cert/key/ca ignored comment), apps/kernel/src/host-sockets.mjs:147-153 (newSocket calls cloudflare:sockets connect() with secureTransport), apps/kernel/src/host-sockets.mjs:196-222 (open() dispatches to newSocket)
- **STARTTLS upgrade (tls.connect({socket}) over existing plain net.Socket)** `[stub-acceptable]` — api: `tls.connect({ socket: plainSocket, ... })`  
  Functional for SMTP/IMAP/XMPP-style STARTTLS: plain net.Socket opened with secureTransport:'starttls', then tls.connect({socket}) calls host['socket.startTls'](handleId) on the DO. Host retires the old handle, registers a new one for the TLS socket, read pump restarts on the new handle, 'secureConnect' is emitted. Diverges: the plain socket MUST have been originally opened with secureTransport:'starttls' — if it was opened with 'off' the DO returns a SocketTlsError (EINVAL). This differs from Node where any established plaintext socket can be upgraded. Also: all cert/key/ca/rejectUnauthorized options are silently ignored for the same host-termination reason.  
  *mechanism:* net.Socket._startTls() calls _hostCall('socket.startTls', oldId); host-sockets.mjs startTls() calls cloudflare:sockets socket.startTls(). New handleId registered, old retired.  
  *constraint:* cloudflare:sockets startTls() requirement: socket must be opened with secureTransport:'starttls'. Structural constraint of the CF Sockets API, not fixable in the shim.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:70-89 (STARTTLS upgrade path in connect()), apps/kernel/stdlib-src/shims/net.js:496-515 (Socket._startTls implementation), apps/kernel/src/host-sockets.mjs:288-315 (startTls host implementation), apps/kernel/src/host-sockets.mjs:293-294 (secureTransport:'starttls' guard)
- **new tls.TLSSocket(socket, options) constructor** `[stub-acceptable]` — api: `tls.TLSSocket`  
  Constructor-shaped: new tls.TLSSocket(plainSocket) triggers STARTTLS upgrade on the same socket instance (returns the SAME net.Socket, now encrypted — not a wrapper class). new tls.TLSSocket() (no socket) returns a fresh unconnected socket with secureTransport:'on'. In Node, TLSSocket is a proper subclass of net.Socket with a separate wrapping object. Here it is the same object, which is fine for most use but will break code that uses instanceof checks against tls.TLSSocket specifically.  
  *mechanism:* Pure-JS alias: TLSSocket() delegates to connect({socket}) or new net.Socket({_secureTransport:'on'}). stdlib-src/shims/tls.js:106-116.  
  *constraint:* No separate TLS wrapper class needed because TLS is a mode of the same socket handle, not a separate object. Structural consequence of cloudflare:sockets model.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:102-116 (TLSSocket constructor), apps/kernel/stdlib-src/shims/tls.js:13-14 (comment: same object, not a wrapper)
- **socket.setTimeout() / inactivity timeout** `[stub-unacceptable]` — api: `tls.TLSSocket.setTimeout(ms, cb) / net.Socket.setTimeout()`  
  setTimeout() stores the ms value and registers a 'timeout' event listener but NEVER fires the event and never cancels a blocked read. The host socket.read() call parks indefinitely until the peer sends data or closes. There is no way for the shim to unblock an in-flight host call. Code relying on socket timeouts (e.g. HTTP clients that set a connect/read timeout, TLS handshake timeout) will hang forever on an idle connection without error — the 'timeout' event is never emitted, the socket is never destroyed automatically. This silently breaks any library pattern of `socket.setTimeout(N, () => socket.destroy())`.  
  *mechanism:* Pure no-op in net.js: `Socket.prototype.setTimeout = function(ms, cb) { this.timeout = ms; if (cb) this.once('timeout', cb); return this; }`. The 'timeout' event is never emitted anywhere in the shim or the host.  
  *constraint:* The engine host-call boundary is strictly sequential (one in-flight call at a time via _hostTail). There is no side-channel to abort an in-progress socket.read(). Cloudflare:sockets has no per-read timeout API. Tracked as an open item in net.js header comment ('make the host read time-bounded').  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:7-13 (KEEP-ALIVE / NO INACTIVITY TIMER warning comment), apps/kernel/stdlib-src/shims/net.js:519-521 (setTimeout no-op implementation)
- **socket.setKeepAlive() / TCP keepalive** `[stub-acceptable]` — api: `tls.TLSSocket.setKeepAlive(enable, delay) / net.Socket.setKeepAlive()`  
  No-op that returns this. On CF Workers/DOs the underlying TCP keepalive is controlled by the platform, not the application. The absence of setKeepAlive does not cause data loss or wrong results; it just means keepalive probe intervals cannot be tuned. Most library code calls it for robustness but does not rely on it functionally.  
  *mechanism:* Pure no-op: `Socket.prototype.setKeepAlive = function() { return this; }` in net.js.  
  *constraint:* cloudflare:sockets exposes no TCP keepalive knobs. Platform-managed.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:520 (setKeepAlive no-op)
- **socket.setNoDelay() / Nagle algorithm** `[stub-acceptable]` — api: `tls.TLSSocket.setNoDelay(enable) / net.Socket.setNoDelay()`  
  No-op. cloudflare:sockets does not expose Nagle control; the platform decides. Functionally benign for almost all use.  
  *mechanism:* Pure no-op: `Socket.prototype.setNoDelay = function() { return this; }` in net.js.  
  *constraint:* cloudflare:sockets API does not expose Nagle toggle.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:519 (setNoDelay no-op)
- **tls.createSecureContext() / SecureContext** `[absent]` — api: `tls.createSecureContext(options)`  
  Not exported from the tls shim. Not implemented. Code that creates a SecureContext to pass as secureContext: ctx into tls.connect() will get a TypeError ('tls.createSecureContext is not a function'). This affects libraries that use createSecureContext explicitly for custom CAs, client certs (mTLS), or cipher suites.  
  *mechanism:* Not present in stdlib-src/shims/tls.js exports. Even if added, the options would be silently ignored because TLS terminates host-side.  
  *constraint:* TLS terminates in cloudflare:sockets on the DO; the VM has no crypto context for key material. A createSecureContext() shim could be added that returns a dummy object, but all options (ca, cert, key, ciphers) are structurally impossible to honor.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:124-137 (api export — no createSecureContext)
- **tls.Server / tls.createServer() / inbound TLS** `[impossible]` — api: `tls.createServer(options, cb) / new tls.Server(options)`  
  Throws NotSupportedError (code 'EPERM') immediately. A Durable Object has no listening socket; it only accepts inbound connections brokered by the CF runtime (HTTP/WS upgrades). There is no listen() primitive and no way to obtain a server socket. This is a hard platform constraint.  
  *mechanism:* Typed throw: `function createServer() { throw notSupported(); }` and `Server.prototype.listen = function() { throw notSupported(); }` in tls.js. Also blocked at host-sockets.mjs listen() backstop.  
  *constraint:* Cloudflare Durable Objects have no POSIX listen()/accept() socket primitives. The DO runtime only surfaces inbound requests via fetch/WebSocket upgrade handlers. Structurally impossible regardless of WASM ceiling.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:29-32 (notSupported() error text), apps/kernel/stdlib-src/shims/tls.js:118-120 (Server constructor + createServer throw), apps/kernel/src/host-sockets.mjs:329-332 (host listen() backstop)
- **getPeerCertificate() / certificate introspection** `[stub-unacceptable]` — api: `tls.TLSSocket.getPeerCertificate(detailed?)`  
  Always returns {} (empty object). In Node this returns the full peer cert chain including subject, issuer, fingerprint, valid dates, etc. Code that uses getPeerCertificate() to pin certificates, validate CN/SAN, or inspect the cert chain will silently get an empty object and likely proceed without error — meaning certificate pinning is silently bypassed. authorized is hardcoded true regardless of actual cert validity (CF terminates TLS). The combination means mTLS client-auth verification and cert-based access control cannot be performed in the VM.  
  *mechanism:* Hardcoded stub in markSecure(): `sock.getPeerCertificate = function() { return {}; }` because cloudflare:sockets does not expose cert data to the DO.  
  *constraint:* cloudflare:sockets does not surface peer certificate data. The DO never sees the TLS cert chain; TLS terminates in the CF edge before the DO.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:54 (getPeerCertificate stub), apps/kernel/stdlib-src/shims/tls.js:51 (authorized=true hardcoded)
- **getProtocol() / negotiated TLS version** `[stub-unacceptable]` — api: `tls.TLSSocket.getProtocol()`  
  Always returns 'TLSv1.3' regardless of what was actually negotiated. cloudflare:sockets does not expose the negotiated protocol version. Code that checks getProtocol() to enforce minimum TLS version (e.g. refuse TLSv1.2) will silently believe it has TLSv1.3 even if the actual connection is lower. In practice cloudflare:sockets likely negotiates TLSv1.2+ but the nominal 'TLSv1.3' is a lie.  
  *mechanism:* Hardcoded in markSecure(): `sock.getProtocol = function() { return 'TLSv1.3'; }`  
  *constraint:* cloudflare:sockets does not surface negotiated TLS version metadata to the DO.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:55 (getProtocol hardcoded 'TLSv1.3')
- **getCipher() / cipher suite info** `[stub-acceptable]` — api: `tls.TLSSocket.getCipher()`  
  Returns {name:null, standardName:null, version:null}. Code that just calls getCipher() without checking the result (or ignores null) won't break. Code that uses getCipher().name to enforce cipher policy will silently get null. Divergence is documented in the comment. Acceptable because enforcing cipher suites is not a realistic use case on this substrate — cipher negotiation is entirely controlled by cloudflare:sockets.  
  *mechanism:* Hardcoded stub in markSecure().  
  *constraint:* cloudflare:sockets does not expose cipher suite details.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:56 (getCipher stub)
- **exportKeyingMaterial()** `[impossible]` — api: `tls.TLSSocket.exportKeyingMaterial(length, label, context)`  
  Throws NotSupportedError (EPERM) immediately. TLS key material is terminated host-side in cloudflare:sockets and never exposed to the DO or the VM. There is no way to obtain it.  
  *mechanism:* Typed throw in markSecure(): `sock.exportKeyingMaterial = function() { throw mkErr('NotSupportedError','EPERM','keying material is not exposed (TLS terminates host-side)'); }`  
  *constraint:* TLS session key material is inside the CF edge TLS terminator, inaccessible to the DO or WASM VM.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:59 (exportKeyingMaterial throw)
- **getSession() / isSessionReused() / session resumption** `[stub-acceptable]` — api: `tls.TLSSocket.getSession() / isSessionReused()`  
  getSession() always returns undefined, isSessionReused() always returns false. Session resumption (TLS tickets/PSK) happens inside cloudflare:sockets and is invisible to the VM. Code that uses these for session caching/debugging won't break, it just sees no session data. Unlikely to bite realistic code.  
  *mechanism:* Hardcoded stubs in markSecure().  
  *constraint:* cloudflare:sockets does not expose session state.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:57-58 (getSession/isSessionReused stubs)
- **tls.checkServerIdentity(hostname, cert)** `[stub-acceptable]` — api: `tls.checkServerIdentity(hostname, cert)`  
  Always returns undefined (no error), meaning 'identity check passed'. This is correct behavior in context: the host-side cloudflare:sockets already validates the server identity (cert chain + hostname). The VM doesn't need to re-validate against an empty cert. Code that overrides checkServerIdentity to disable validation would have no effect anyway since cert verification already happened host-side.  
  *mechanism:* Exported no-op: `function checkServerIdentity() { return undefined; }` in tls.js.  
  *constraint:* Cert data is not available in the VM; host-side validation is the only layer.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:122 (checkServerIdentity stub), apps/kernel/stdlib-src/shims/tls.js:129 (exported)
- **tls.getCiphers()** `[stub-acceptable]` — api: `tls.getCiphers()`  
  Always returns []. In Node this returns an array of supported cipher names. Since cipher selection is controlled entirely by cloudflare:sockets and the VM cannot influence it, returning [] is honest. Unlikely to break code in practice.  
  *mechanism:* Inline stub in api object: `getCiphers: function() { return []; }`  
  *constraint:* cloudflare:sockets controls cipher negotiation, not the VM.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:130 (getCiphers stub)
- **tls.rootCertificates** `[stub-acceptable]` — api: `tls.rootCertificates`  
  Exported as empty array []. In Node this is an array of PEM strings for the bundled CA roots. Since TLS terminates host-side with cloudflare's CA bundle, the VM never uses these. Code that reads rootCertificates to augment trust won't crash but its additions are never applied.  
  *mechanism:* Hardcoded empty array in tls.js api export.  
  *constraint:* Host-side CA validation.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:131 (rootCertificates: [])
- **alpnProtocol negotiation** `[stub-unacceptable]` — api: `tls.TLSSocket.alpnProtocol`  
  alpnProtocol is hardcoded to false (no protocol negotiated). cloudflare:sockets does not allow specifying ALPN protocols on connect() nor does it expose the negotiated value. Code that sets options.ALPNProtocols to negotiate h2 or http/1.1 (e.g. http2 over TLS, grpc) will silently get a connection without the requested protocol, and .alpnProtocol will always be false. gRPC and HTTP/2 clients that check alpnProtocol to confirm h2 negotiation will silently believe ALPN failed.  
  *mechanism:* Hardcoded in markSecure(): `sock.alpnProtocol = false`. cloudflare:sockets connect() does not accept an ALPNProtocols option.  
  *constraint:* cloudflare:sockets API does not expose ALPN negotiation to the caller.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:60 (alpnProtocol=false), apps/kernel/src/host-sockets.mjs:147-153 (newSocket: no ALPNProtocols option passed to connect())
- **rejectUnauthorized / mTLS client certificates** `[stub-unacceptable]` — api: `tls.connect({ rejectUnauthorized, cert, key, ca, pfx }) / mutual TLS`  
  All cert/key/ca/pfx/passphrase/rejectUnauthorized options are accepted silently but never forwarded to cloudflare:sockets or acted upon. rejectUnauthorized:false (disable cert verification) has no effect — cloudflare:sockets always verifies the server cert and there is no override. Client cert (mTLS) options (cert/key) are silently dropped — the socket connects without presenting a client cert, which will cause authentication failures on servers requiring mTLS. Code that sets rejectUnauthorized:false expecting to connect to self-signed cert servers will get a connection refused or TLS error from cloudflare:sockets instead of the expected silent bypass. This is the most dangerous silent divergence.  
  *mechanism:* tls.js comment line 15: 'Cert/key/ca options are accepted but IGNORED'. cloudflare:sockets connect() has no cert/rejectUnauthorized option surface.  
  *constraint:* cloudflare:sockets performs TLS termination with its own CA bundle and does not expose per-connection cert or verification policy knobs to the DO.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:15-16 (cert/key/ca options accepted but IGNORED comment), apps/kernel/src/host-sockets.mjs:147-153 (newSocket: only secureTransport and allowHalfOpen passed to connect())
- **6-connection concurrent socket cap** `[partial]` — api: `net.createConnection / tls.connect (connection limit)`  
  Node has no built-in concurrent outbound connection limit. cloudflare:sockets caps at 6 concurrent connections per invocation. The shim implements a local guard (MAX_SOCKETS=6) and returns a typed EMFILE error on the 7th attempt — it does not hang. The error is surfaced as a Node-shaped EMFILE (net.js emits 'error' + 'close'), recoverable. Diverges in that Node programs expecting unlimited concurrent TLS connections (e.g. connection pools) will fail with EMFILE at the 7th.  
  *mechanism:* Local counter _openCount in net.js; guard in Socket.prototype.connect. Backstop in host-sockets.mjs open() liveCount() check.  
  *constraint:* cloudflare:sockets platform limit: max 6 concurrent outbound connections per invocation awaiting a response.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:34-35 (6-connection cap comment), apps/kernel/stdlib-src/shims/net.js:162 (MAX_SOCKETS=6), apps/kernel/stdlib-src/shims/net.js:237-244 (EMFILE guard in connect()), apps/kernel/src/host-sockets.mjs:47 (SOCKET_MAX_CONCURRENT=6)
- **Socket durability across DO hibernation** `[stub-unacceptable]` — api: `Implicit: live sockets survive process restart`  
  Live sockets die on DO eviction/hibernation — the host-side Map is in DO memory, not persisted. The WASM heap snapshot preserves the integer handleId token. After a cold restore, any socket.read/write on a stale handleId returns a typed ECONNRESET-shaped error immediately (never hangs). This is correctly documented and handled. However, code that saves a TLS socket in a closure, hibernates the kernel, and resumes expecting the socket to still be valid will silently get ECONNRESET on all operations. Since long-lived TLS connections (e.g. database connection pools, persistent gRPC streams) are common patterns, and since cell-to-cell state persistence is engram's core value proposition, this gap is particularly likely to surprise users who store net.Socket objects in their namespace.  
  *mechanism:* By design: sockets are held in KernelState._sockets (DO memory), never part of the WASM snapshot. stale handle -> ECONNRESET in host-sockets.mjs.  
  *constraint:* WASM linear-memory snapshot is the durability primitive; live OS-level file descriptors / TCP sockets cannot be represented in it. Structural impossibility.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:30-33 (DURABILITY comment: sockets die on eviction), apps/kernel/src/host-sockets.mjs:6-12 (socket Map is DO-memory-only comment), apps/kernel/src/host-sockets.mjs:228-232 (stale handle -> ECONNRESET in write), apps/kernel/src/host-sockets.mjs:251-254 (stale handle -> ECONNRESET in read)
- **SNI servername override (options.servername)** `[stub-unacceptable]` — api: `tls.connect({ servername: 'custom.host' })`  
  options.servername is stored on the socket as sock.servername but is never forwarded to cloudflare:sockets. cloudflare:sockets always uses the connection hostname for SNI. Code that uses a different servername from the connection host (e.g. connecting to a CDN IP but expecting SNI for a virtual host) will silently use the wrong SNI value and likely get a TLS handshake failure or the wrong certificate.  
  *mechanism:* markSecure() stores servername: `sock.servername = options.servername || options.host`. But host-sockets.mjs newSocket() only receives hostname (the connection target) — no servername parameter is threaded through to cloudflare:sockets connect().  
  *constraint:* cloudflare:sockets connect() does not currently expose a per-connection SNI override separate from the hostname.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:53 (sock.servername = options.servername || options.host), apps/kernel/src/host-sockets.mjs:147-153 (newSocket: only hostname+port+secureTransport+allowHalfOpen passed, no servername)

### http / https (client via host.fetch; SERVER createServer/listen)

- **http.request / https.request** `[partial]` — api: `http.request(url|opts[, cb]) → ClientRequest`  
  Works for the core request/response cycle (method, headers, body write+end, response callback, data/end events). Does NOT pass opts.auth as an Authorization: Basic header — opts.auth is parsed from the URL but never injected into init.headers (buildUrl drops it silently, line 2042). Does NOT forward opts.signal (AbortController) — the init object built at line 2064 never includes signal. No chunked-transfer encoding: entire request body is buffered before the host.fetch call (line 2065). No support for opts.socketPath, opts.localAddress, opts.family, opts.lookup.  
  *mechanism:* pure-JS shim in engine/src/lib.rs:2028-2083; delegates to globalThis.fetch (the WHATWG fetch backed by host.fetch in kernel-glue.ts:2091). The shim is injected as part of BOOTSTRAP and snapshot-persists.  
  *constraint:* WASM/CF determinism: all I/O must cross the host boundary; the single-slot __settleHost resolver serialises host calls. No native TCP. Body must be fully buffered before crossing the JSON/base64 host boundary (FETCH_MAX_BODY_BYTES = 2 MB cap, kernel-glue.ts:575-578).  
  *evidence:* apps/kernel/engine/src/lib.rs:2028-2083, apps/kernel/engine/src/lib.rs:2042 (buildUrl drops auth), apps/kernel/engine/src/lib.rs:2064 (init never includes signal), apps/kernel/src/kernel-glue.ts:575-578 (2 MB body cap)
- **http.get / https.get** `[partial]` — api: `http.get(url[, opts][, cb]) → ClientRequest`  
  Works: immediately calls .end(), correct default method GET. Same gaps as http.request (no opts.auth→Authorization header injection, no signal forwarding, 2 MB body cap).  
  *mechanism:* pure-JS shim; thin wrapper over request() in engine/src/lib.rs:2080  
  *constraint:* Same as http.request — proxied through host.fetch.  
  *evidence:* apps/kernel/engine/src/lib.rs:2080
- **http.createServer / https.createServer (inbound server)** `[impossible]` — api: `http.createServer([opts][, requestListener]) → Server`  
  Throws NotSupportedError immediately. A Cloudflare Durable Object is a request-handler, not a TCP listener; there is no mechanism to bind a port or accept inbound connections from the QuickJS-WASM context. net.Server and tls.Server also throw NotSupportedError (code EPERM).  
  *mechanism:* Explicit throw in engine/src/lib.rs:2081 and stdlib-src/shims/net.js:540  
  *constraint:* CF DO has no listen() primitive; WASM isolate cannot bind a TCP port. Inbound networking is structurally absent from the substrate.  
  *evidence:* apps/kernel/engine/src/lib.rs:2081, apps/kernel/stdlib-src/shims/net.js:99-100 (notSupported helper), apps/kernel/stdlib-src/shims/net.js:540-541 (Server/createServer throw), apps/kernel/stdlib-src/shims/tls.js:118-121 (same for TLS)
- **http.Server / net.Server / tls.Server API surface** `[impossible]` — api: `http.Server, net.Server, tls.Server (listen, close, on('request'), etc.)`  
  All constructors throw NotSupportedError(EPERM). No server events (request, connection, upgrade, close). No http.ServerResponse, no http.IncomingMessage on the server path. Architecturally impossible: DO is invoked by CF, never the other way.  
  *mechanism:* Throw stubs in shims and engine bootstrap.  
  *constraint:* No inbound networking primitive in CF Workers/DO runtime from WASM.  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:540-542, apps/kernel/stdlib-src/shims/tls.js:118-120, apps/kernel/engine/src/lib.rs:2081
- **IncomingMessage (http client response object)** `[stub-unacceptable]` — api: `http.IncomingMessage as a Readable stream with statusCode/headers/data/end`  
  statusCode, statusMessage, headers, url, method, complete are correct. CRITICAL divergence: IncomingMessage inherits from EventEmitter (not Readable) — it has no .push(), no flowing/paused state machine, no .pipe() method, no backpressure. The body is delivered as a SINGLE 'data' event then 'end' (line 2075): any code that treats the response as a real Readable stream and calls .pipe(), .resume(), stream.pipeline(), or does for-await-of (Symbol.asyncIterator yields the whole body as one chunk) will appear to work only because the body is already buffered. Code expecting incremental 'data' events from a large response will hang or get partial data. Also: opts.auth parsed from URL is silently dropped (never converted to Authorization: Basic header) — http.request('http://user:pass@host/') sends no credentials.  
  *mechanism:* Pure-JS EventEmitter subclass in engine/src/lib.rs:2043-2050; body buffered by host.fetch (r.arrayBuffer()) before response callback fires.  
  *constraint:* The host.fetch boundary is a single request-response round trip (not a true stream at the http.request layer, even though fetchStream exists for WHATWG fetch). No wall clock means no real inactivity/timeout.  
  *evidence:* apps/kernel/engine/src/lib.rs:2043-2044 (inherits EventEmitter, not Readable), apps/kernel/engine/src/lib.rs:2067-2075 (full arrayBuffer before emit), apps/kernel/engine/src/lib.rs:2075 (single data emit + end, no chunking), apps/kernel/engine/src/lib.rs:2035-2042 (opts.auth parsed but buildUrl omits it from Authorization header)
- **ClientRequest (http.request return value)** `[stub-unacceptable]` — api: `http.ClientRequest — Writable EventEmitter with write/end/setHeader/getHeader/removeHeader/abort/destroy`  
  write/end/setHeader/getHeader/removeHeader work. setTimeout is a no-op (line 2056). abort() sets _aborted and emits 'abort' but does NOT cancel the in-flight host.fetch — the request still completes (Node deprecated .abort() in favour of AbortSignal, but callers of .abort() expect cancellation). opts.signal is NEVER forwarded to the underlying fetch init (line 2064 builds init without signal), so AbortController-based cancellation is silently non-functional. No flushHeaders(), writeContinue(), addTrailers(), or headersSent. No request socket exposure (this.socket is not set).  
  *mechanism:* Pure-JS EventEmitter subclass in engine/src/lib.rs:2051-2078.  
  *constraint:* Single-slot host-call serialisation means no mid-flight cancellation path from inside the VM; the host.fetch is already in-flight by the time abort() is called.  
  *evidence:* apps/kernel/engine/src/lib.rs:2051-2078, apps/kernel/engine/src/lib.rs:2056 (setTimeout no-op), apps/kernel/engine/src/lib.rs:2058 (abort emits event but cannot cancel fetch), apps/kernel/engine/src/lib.rs:2064 (init never includes signal)
- **http.Agent / https.Agent** `[stub-acceptable]` — api: `http.Agent({ keepAlive, maxSockets, ... }) — connection pooling and keep-alive`  
  Agent constructor accepts options and is exported as http.Agent / http.globalAgent, so code that instantiates or passes an agent does not throw. All connection management is a no-op: CF Workers have no persistent TCP connections, each host.fetch is an independent round-trip. keepAlive, maxSockets, maxFreeSockets, scheduling are all silently ignored. For code that just passes { agent: false } or new Agent() without relying on connection-reuse semantics, this is fine.  
  *mechanism:* Stub constructor in engine/src/lib.rs:2082 — stores options, no methods.  
  *constraint:* CF Workers have no persistent connection pool; every fetch crosses the DO boundary as an independent call.  
  *evidence:* apps/kernel/engine/src/lib.rs:2082
- **http.METHODS / http.STATUS_CODES** `[partial]` — api: `http.METHODS (array of method strings), http.STATUS_CODES (map of code→text)`  
  Both exported. METHODS covers the common 7 (GET/POST/PUT/DELETE/HEAD/OPTIONS/PATCH). Node's real list has 30+ methods (ACL, BIND, CHECKOUT, CONNECT, COPY, LINK, LOCK, M-SEARCH, MERGE, MKACTIVITY, MKCALENDAR, MKCOL, MOVE, NOTIFY, PROPFIND, PROPPATCH, PURGE, REPORT, SEARCH, SOURCE, SUBSCRIBE, UNLINK, UNLOCK, UNSUBSCRIBE). STATUS_CODES covers ~14 codes vs Node's full RFC set of 60+. Code that iterates these arrays to determine valid methods/codes will silently miss entries.  
  *mechanism:* Hard-coded literal in engine/src/lib.rs:2083.  
  *constraint:* No structural constraint — just not fully populated.  
  *evidence:* apps/kernel/engine/src/lib.rs:2083
- **https.request / https.get (TLS client)** `[partial]` — api: `https.request / https.get — same as http but defaults to https: protocol`  
  Implemented as a thin wrapper over __http that forces protocol:'https:' when not set. TLS termination happens host-side (CF Workers) — the VM never sees cert/key material. cert/key/ca/passphrase options accepted but silently ignored. getPeerCertificate returns {}. Same gaps as http.request: no opts.auth→Authorization, no signal forwarding, 2 MB body cap.  
  *mechanism:* Pure-JS wrapper in engine/src/lib.rs:2086-2096; TLS via cloudflare:sockets on host side.  
  *constraint:* TLS is handled by CF network layer; the WASM VM cannot do raw TLS.  
  *evidence:* apps/kernel/engine/src/lib.rs:2086-2096, apps/kernel/stdlib-src/shims/tls.js:51-61 (cert options silently ignored, authorized=true)
- **Response body streaming (chunked transfer / server-sent events via http.request)** `[stub-unacceptable]` — api: `http.IncomingMessage as a streaming Readable for chunked/SSE responses`  
  The http/https client fully buffers the response body via r.arrayBuffer() before emitting 'response' + 'data' (lines 2067-2075). There is no incremental chunk delivery. Code consuming chunked responses or SSE via http.request's 'data' event expecting progressive delivery will receive ALL bytes in one burst after the response completes — or nothing if the server keeps the connection open (keep-alive with no Connection:close hangs the read loop, per net.js:8-13). The WHATWG fetch().body ReadableStream (via fetchStream) does support true streaming but that path is not exposed through the http/https module.  
  *mechanism:* engine/src/lib.rs:2072: r.arrayBuffer() — single buffered round-trip via host.fetch (_doFetch), not _doFetchStream.  
  *constraint:* The http shim delegates to globalThis.fetch which uses host.fetch (_doFetch), the buffered path. _doFetchStream exists for WHATWG fetch only. Wiring streaming to the http module would require a separate path not currently built.  
  *evidence:* apps/kernel/engine/src/lib.rs:2067-2075, apps/kernel/src/kernel-glue.ts:593-596 (STREAM_INLINE_THRESHOLD, fetchStream path exists but not used by http shim), apps/kernel/stdlib-src/shims/net.js:8-13 (keep-alive read hangs warning)
- **Request body > 2 MB via http.request** `[stub-unacceptable]` — api: `http.request with large request body (streaming upload)`  
  Request body is collected via write() calls into Uint8Array chunks (line 2065) and sent as a single fetch init.body. The host-side FETCH_MAX_BODY_BYTES cap is 2 MB (kernel-glue.ts:575-578) — responses above 2 MB are silently truncated. Request bodies above 2 MB are not capped but will inflate WASM linear memory (each chunk is a Uint8Array allocation). There is no streaming upload path through the http shim (the fetchStream upload path at kernel-glue.ts:2154 is for WHATWG fetch with requestStream:true only).  
  *mechanism:* Buffer-and-send in engine/src/lib.rs:2065; cap enforced host-side at kernel-glue.ts:2103.  
  *constraint:* Monotonic WASM linear memory + JSON/base64 host boundary. Streaming upload requires requestStream protocol not wired to http module.  
  *evidence:* apps/kernel/engine/src/lib.rs:2065, apps/kernel/src/kernel-glue.ts:575-578 (2 MB cap), apps/kernel/src/kernel-glue.ts:2103-2105 (truncation)
- **http.request opts.auth (Basic Auth from URL credentials)** `[stub-unacceptable]` — api: `http.request('http://user:pass@host/') → Authorization: Basic header injected automatically`  
  opts.auth is parsed from the URL string (line 2035) and from URL objects (line 2036), but buildUrl (line 2042) reconstructs only proto+host+port+path — opts.auth is never converted to an Authorization: Basic btoa(user:pass) header and never appended to the URL. Requests to authenticated endpoints via URL credentials are sent without credentials. This silently fails with a 401 instead of authenticating.  
  *mechanism:* engine/src/lib.rs:2033-2042: normalizeArgs extracts opts.auth but buildUrl and the init construction at 2064 ignore it.  
  *constraint:* Not a WASM/CF constraint — this is an unimplemented feature in the shim.  
  *evidence:* apps/kernel/engine/src/lib.rs:2035-2036 (opts.auth parsed), apps/kernel/engine/src/lib.rs:2042 (buildUrl discards auth), apps/kernel/engine/src/lib.rs:2064 (init.headers not augmented with Authorization)
- **AbortController / signal cancellation via http.request** `[stub-unacceptable]` — api: `http.request({ signal: controller.signal }) — cancel an in-flight request`  
  opts.signal is never extracted from this._opts and never passed to the globalThis.fetch call (line 2064 builds { method, headers } only). ClientRequest.abort() emits 'abort' but cannot cancel the in-flight fetch on the host side. Code that calls req.destroy() or controller.abort() expecting request cancellation will see the request complete normally. AbortController works correctly for direct WHATWG fetch() calls (engine/src/lib.rs:1075-1136).  
  *mechanism:* engine/src/lib.rs:2064 (init object never includes signal); AbortController is wired for fetch but not for the http shim's ClientRequest.  
  *constraint:* Not structural — the host.fetch path supports signal (kernel-glue.ts fetchPrep accepts it), the shim just doesn't plumb it.  
  *evidence:* apps/kernel/engine/src/lib.rs:2058 (abort() emits but no cancellation), apps/kernel/engine/src/lib.rs:2064 (signal absent from init)
- **http.request timeout (opts.timeout / req.setTimeout)** `[stub-unacceptable]` — api: `http.request({ timeout: ms }) or req.setTimeout(ms) — emit 'timeout' and abort after ms`  
  setTimeout() on ClientRequest is a no-op (returns this, engine/src/lib.rs:2056). There is no wall clock in the VM (AbortSignal.timeout aborts on the next microtask, not after real ms). A hung request (peer holds connection open) will park the cell until the DO eviction watchdog fires. Code that relies on request timeout to prevent hangs will not be protected.  
  *mechanism:* No-op at engine/src/lib.rs:2056; no wall-clock timer available.  
  *constraint:* Seeded deterministic clock — no real wall-clock timer. AbortSignal.timeout(ms) fires immediately (next microtask), not after ms.  
  *evidence:* apps/kernel/engine/src/lib.rs:2056 (setTimeout no-op), apps/kernel/engine/src/lib.rs:953 (AbortSignal.timeout fires immediately), apps/kernel/src/kernel-glue.ts:608-617 (WHATWG fetch has no real timeout either)
- **WHATWG fetch() as alternative to http.request** `[real]` — api: `globalThis.fetch(url, init) → Promise<Response> (WHATWG Fetch API)`  
  Full WHATWG-shaped Response with ok/status/statusText/headers/url/redirected/.json()/.text()/.arrayBuffer()/.bytes()/.blob()/.clone(). Request/Response/Headers/Blob/File/FormData/AbortController/AbortSignal all present. True streaming response body via fetchStream + host.streamRead when response is chunked. Binary-safe (base64 boundary). SSRF-blocked (RFC1918, loopback, link-local). AbortSignal wired. Redirect following is SSRF-safe (per-hop re-check). 2 MB buffered cap; above that requires streaming (.body ReadableStream). This is the preferred outbound HTTP primitive — http.request is a compatibility shim on top of it.  
  *mechanism:* WHATWG fetch shim in engine/src/lib.rs:1069-1137 backed by host.fetch (_doFetch) and host.fetchStream (_doFetchStream) in kernel-glue.ts:2091 and 2145.  
  *constraint:* All I/O mediated through host boundary. Allowlist enforced host-side (config.fetch). AbortSignal.timeout() fires immediately (no wall clock).  
  *evidence:* apps/kernel/engine/src/lib.rs:1069-1137, apps/kernel/src/kernel-glue.ts:2091-2138 (_doFetch), apps/kernel/src/kernel-glue.ts:2145-2200 (_doFetchStream), apps/kernel/src/kernel-glue.ts:649-845 (SSRF guards)
- **net.Socket (outbound TCP client)** `[partial]` — api: `net.Socket / net.connect / net.createConnection — outbound TCP`  
  Outbound TCP connect works (up to 6 concurrent per invocation via cloudflare:sockets). connect/write/end/destroy/setNoDelay/setKeepAlive/setTimeout all present with correct Node shapes. setTimeout is a no-op. setNoDelay/setKeepAlive are no-ops (CF sockets). ECONNRESET on stale handles after hibernation. No unix domain sockets. Binary data crosses via base64. Keep-alive read BLOCKS until peer closes (no inactivity timer — a hung peer parks the read loop forever per net.js:8-13).  
  *mechanism:* Pure-JS Duplex subclass in stdlib-src/shims/net.js; delegates to host['socket.*'] calls (cloudflare:sockets in kernel-glue.ts/lib.rs).  
  *constraint:* 6-socket CF limit per invocation. No wall-clock timer for inactivity. Sockets die on DO eviction (not snapshotted).  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:1-43 (overview + caveats), apps/kernel/stdlib-src/shims/net.js:162-163 (6-socket cap), apps/kernel/stdlib-src/shims/net.js:519-521 (setNoDelay/setKeepAlive no-ops)
- **tls.connect / tls.TLSSocket (outbound TLS client)** `[partial]` — api: `tls.connect(opts) / tls.TLSSocket — outbound TLS`  
  Outbound TLS connect works. STARTTLS upgrade (tls.connect({ socket })) works. cert/key/ca/passphrase accepted but silently ignored (TLS terminates host-side). getPeerCertificate returns {}. getProtocol returns 'TLSv1.3' (nominal). exportKeyingMaterial throws NotSupportedError. getCiphers returns []. checkServerIdentity is a no-op (always returns undefined). No SNI configuration passed (servername stored but not forwarded to CF sockets API). authorized is always true on successful connect.  
  *mechanism:* Pure-JS shim in stdlib-src/shims/tls.js layered on net shim; TLS handshake done by cloudflare:sockets.  
  *constraint:* TLS terminates in CF network layer; VM has no access to raw TLS internals.  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:14-19 (overview), apps/kernel/stdlib-src/shims/tls.js:51-61 (cert options ignored, authorized=true), apps/kernel/stdlib-src/shims/tls.js:55 (getProtocol nominal), apps/kernel/stdlib-src/shims/tls.js:59 (exportKeyingMaterial throws)

### crypto (webcrypto subtle, randomBytes, createHash/Hmac, randomUUID, sign/verify) + determinism

- **crypto.getRandomValues** `[stub-unacceptable]` — api: `globalThis.crypto.getRandomValues (Web Crypto / Node webcrypto)`  
  Fills array bytes from a 64-bit LCG (Knuth multiplicative, engine/src/lib.rs:184-188, 2924-2928), not a CSPRNG. Any code that treats the output as cryptographically random (token generation, key material, nonces) silently produces predictable output. The W3C spec explicitly requires a CSPRNG. The caveats string in the engine (lib.rs:2267) does document this, but the API surface is identical to the real thing so callers never fail; they just get insecure output.  
  *mechanism:* Pure-JS shim backed by WASI `random_get`, which is itself a seeded LCG injected at create/restore time (kernel-glue.ts:254-317, engine/src/lib.rs:2923-2932). Bootstrap at lib.rs:363-376 installs getRandomValues on globalThis.crypto before subtle; require('crypto') captures the seeded ref at lib.rs:1800-1802.  
  *constraint:* Determinism invariant: real OS entropy injected between cells would break snapshot/replay byte-identity (docs/ENV-SURFACE-POLICY.md:62). The 6-WASI-fn ceiling and the WASM import cap (12) make wiring a real CSPRNG host-call technically feasible but architecturally rejected.  
  *evidence:* apps/kernel/engine/src/lib.rs:184-188 (LCG implementation), apps/kernel/engine/src/lib.rs:2923-2932 (inject __rand), apps/kernel/engine/src/lib.rs:363-376 (crypto.getRandomValues = LCG wrapper), apps/kernel/src/kernel-glue.ts:253-317 (WASI random_get = seeded mulberry32), apps/kernel/engine/src/lib.rs:2238 (caveat string: 'SEEDED (deterministic), not CSPRNG')
- **crypto.randomUUID** `[stub-unacceptable]` — api: `globalThis.crypto.randomUUID (Web Crypto / Node webcrypto)`  
  Produces v4-shaped UUIDs (correct bit masking) but the 122 bits of randomness come from the LCG seeded RNG, not a CSPRNG. Two sessions with the same rngSeed produce identical UUID sequences. Suitable for uniqueness within a single session; completely unsuitable as security tokens or where collision resistance under adversarial conditions matters.  
  *mechanism:* Seeded PRNG (LCG), same as getRandomValues. lib.rs:371-375 (bootstrap) and lib.rs:1810 (require('crypto').randomUUID). Falls back to the captured __seededUUID ref.  
  *constraint:* Determinism invariant. Same constraint as getRandomValues.  
  *evidence:* apps/kernel/engine/src/lib.rs:371-375, apps/kernel/engine/src/lib.rs:1803-1810
- **randomBytes / randomFillSync / randomFill / randomInt** `[stub-unacceptable]` — api: `require('crypto').randomBytes / randomFillSync / randomFill / randomInt`  
  Same LCG source as getRandomValues. randomBytes returns a Buffer whose bytes are predictable given rngSeed. randomInt uses rejection sampling over randomBytes(4) which is correct in distribution but not in entropy. No async randomBytes callback is ever truly async (uses queueMicrotask). Any use as key material or security tokens is insecure.  
  *mechanism:* Pure-JS shim at lib.rs:1806-1812 using captured __seededRandom. Deterministic, no host round-trip.  
  *constraint:* Determinism invariant. Cannot break snapshot/replay with real entropy.  
  *evidence:* apps/kernel/engine/src/lib.rs:1806-1812, apps/kernel/engine/src/lib.rs:1792-1802 (shadow-safety capture)
- **createHash (SHA-256, SHA-1, MD5 — synchronous)** `[real]` — api: `require('crypto').createHash(algo).update(data).digest([enc])`  
  Pure-JS software implementations of SHA-256, SHA-1, MD5. Multi-call .update() is supported (chunks are buffered and concatenated before digest). Output is byte-identical to Node for the same input. The .digest() encoding forms ('hex', 'base64', 'buffer') work via Buffer.toString. No streaming or incremental digest after finalize (calling .digest() twice will error because the chunks are consumed — same as Node). Deterministic, no entropy.  
  *mechanism:* Pure-JS shim (__sha256/__sha1/__md5 in globalThis.__hashes). Installed as snapshot-persisted globals (lib.rs:541-701). createHash at lib.rs:1813-1818.  
  *constraint:* No WASM extension for native SHA; 12-import ceiling makes adding a new host import non-trivial. Pure-JS is sufficient and snapshot-safe.  
  *evidence:* apps/kernel/engine/src/lib.rs:541-701 (hash implementations), apps/kernel/engine/src/lib.rs:1813-1818 (createHash/Hash class)
- **createHash (SHA-512, SHA-384 — synchronous)** `[stub-unacceptable]` — api: `require('crypto').createHash('sha512' | 'sha384')`  
  createHash('sha512') and createHash('sha384') throw a hard Error telling users to use crypto.subtle.digest('SHA-512', ...) instead (lib.rs:1815). However, getHashes() returns ['sha256','sha384','sha512','sha1','md5'] (lib.rs:1862), so code that probes getHashes() and then calls createHash('sha512') will discover the API and then crash at runtime. This is a silent divergence from Node semantics — the API claims to support these algorithms but does not.  
  *mechanism:* Throws in the Hash constructor; the __hashes table does include __sha512/__sha384 but the constructor explicitly rejects them with a redirect message.  
  *constraint:* SHA-512 in sync path is available (the __sha512 implementation exists at lib.rs:692) but was intentionally gated. The error message redirects to the async subtle path.  
  *evidence:* apps/kernel/engine/src/lib.rs:1815 (Hash constructor error for sha512/sha384/sha224), apps/kernel/engine/src/lib.rs:1862 (getHashes returns sha512/sha384 — diverges from what createHash actually accepts), apps/kernel/engine/src/lib.rs:692-693 (__sha512/__sha384 implementations exist)
- **createHmac (SHA-256, SHA-1, MD5)** `[real]` — api: `require('crypto').createHmac(algo, key).update(data).digest([enc])`  
  RFC 2104 pure-JS HMAC over any supported hash (sha256/sha1/md5). Key normalisation (truncate if >blockSize, zero-pad if <blockSize) is correct. Multi-call .update() buffered. Byte-identical to Node for same inputs. SHA-512/SHA-384 HMAC also works through the __hashes table even though createHash throws for those algos — this is an internal inconsistency but HMAC itself works for all 5 algos.  
  *mechanism:* Pure-JS Hmac class at lib.rs:1820-1823. Uses __hashes table directly, bypasses the Hash constructor gate.  
  *constraint:* None beyond the no-real-entropy constraint. Deterministic and pure.  
  *evidence:* apps/kernel/engine/src/lib.rs:1820-1823 (Hmac class), apps/kernel/engine/src/lib.rs:1836 (hmacRaw helper reused by scryptSync)
- **crypto.subtle.digest** `[partial]` — api: `crypto.subtle.digest(algo, data) [WebCrypto]`  
  Only SHA-256 and SHA-1 are wired in the error-reporting path (lib.rs:711 error message says 'supported: SHA-256, SHA-1'); however the dispatch at lib.rs:710 also falls through to globalThis.__hashes which includes sha512/sha384/md5, so in practice SHA-512 and SHA-384 DO work via subtle.digest (the example in the engine's own help at lib.rs:2219 uses 'SHA-512'). Returns a Promise<ArrayBuffer> as spec requires. No other subtle methods (sign, verify, generateKey, importKey, exportKey, encrypt, decrypt, deriveKey, deriveBits, wrapKey, unwrapKey) exist — the object is a plain {} with only a digest property.  
  *mechanism:* Pure-JS wrapped in a Promise over the same __hashes pure-JS implementations (lib.rs:704-717). Not a host call — no host WebCrypto involved.  
  *constraint:* The determinism invariant forbids routing to host WebCrypto (which uses real hardware entropy for sign/verify/generateKey). The 12-import ceiling also makes a non-deterministic host subtle hard to justify.  
  *evidence:* apps/kernel/engine/src/lib.rs:704-717 (subtle object, only digest method), apps/kernel/engine/src/lib.rs:380-383 (comment: 'subtle.digest is SHA-256' — undersells SHA-512 too), apps/kernel/engine/src/lib.rs:711 (error message lists only SHA-256/SHA-1 but dispatch reaches sha512/sha384)
- **crypto.subtle.sign / crypto.subtle.verify** `[absent]` — api: `crypto.subtle.sign(algorithm, key, data) / crypto.subtle.verify(algorithm, key, signature, data) [WebCrypto]`  
  The subtle object (lib.rs:705-716) has exactly one property: digest. sign and verify do not exist. Any call to crypto.subtle.sign() will throw 'crypto.subtle.sign is not a function'. This blocks JWT signing, ECDSA, RSA-PSS, HMAC-via-subtle, Ed25519 in the VM.  
  *mechanism:* Not implemented. Would require either a pure-JS asymmetric crypto library injected into the heap (large bundle, snapshot cost) or a host-call round-trip that touches real key material (breaks determinism).  
  *constraint:* Determinism invariant (asymmetric key operations require real entropy for key generation). No pure-JS implementation shipped. 12-import WASM ceiling.  
  *evidence:* apps/kernel/engine/src/lib.rs:704-717 (subtle object definition — only digest)
- **crypto.subtle.generateKey / importKey / exportKey / deriveKey / deriveBits / encrypt / decrypt** `[absent]` — api: `crypto.subtle.generateKey / importKey / exportKey / deriveKey / deriveBits / encrypt / decrypt [WebCrypto]`  
  None of these methods exist on the subtle object. The entire key management and symmetric/asymmetric encryption surface of WebCrypto is missing. Calling any of these throws 'not a function'.  
  *mechanism:* Not implemented. Same constraints as sign/verify.  
  *constraint:* Determinism invariant + no pure-JS implementation shipped + 12-import WASM ceiling.  
  *evidence:* apps/kernel/engine/src/lib.rs:704-717 (subtle object only has digest)
- **createSign / createVerify (Node crypto streams)** `[absent]` — api: `require('crypto').createSign(algo) / createVerify(algo)`  
  Not in the require('crypto') return object (lib.rs:1856-1864). The exported __crypto object has no createSign, createVerify, Sign, or Verify class.  
  *mechanism:* Not implemented.  
  *constraint:* Asymmetric ops require key objects (PEM parsing, ASN.1 DER, OpenSSL primitives) that are not present in the pure-JS environment. Would need a host-call or a pure-JS crypto library.  
  *evidence:* apps/kernel/engine/src/lib.rs:1856-1864 (full export list of require('crypto') — no createSign/createVerify)
- **createCipheriv / createDecipheriv (symmetric encryption streams)** `[absent]` — api: `require('crypto').createCipheriv(algo, key, iv) / createDecipheriv`  
  Not in the require('crypto') export. AES-GCM, AES-CBC, AES-CTR, ChaCha20-Poly1305 etc. are all absent. Common usage pattern (AES-256-GCM for data encryption) will throw at runtime.  
  *mechanism:* Not implemented.  
  *constraint:* No pure-JS AES shipped. Would be feasible as a pure-JS injection (e.g. aes-js bundle) but has snapshot cost. Not built.  
  *evidence:* apps/kernel/engine/src/lib.rs:1856-1864 (export list — no Cipher/Decipher)
- **scryptSync / pbkdf2Sync** `[partial]` — api: `require('crypto').scryptSync(password, salt, keylen[, options]) / pbkdf2Sync(password, salt, iterations, keylen, digest)`  
  scryptSync is a pure-JS RFC 7914 implementation (lib.rs:1837-1854) but is hard-capped: N*r*128 > 16MB throws (lib.rs:1839). Real Node allows arbitrarily large parameters (limited only by memory). pbkdf2Sync only supports SHA-256 as the digest; other digests throw (lib.rs:1860). Neither pbkdf2 (async) nor scrypt (async) exists. These are deterministic (no entropy) and correct for small parameters.  
  *mechanism:* Pure-JS over __hashes.sha256 + hmacRaw. No host call. Snapshot-safe.  
  *constraint:* Monotonic WASM memory ceiling (~57MB dump limit, ~18MB safe ceiling). Large scrypt N values would OOM the VM before finishing.  
  *evidence:* apps/kernel/engine/src/lib.rs:1824-1854 (scryptSync + pbkdf2Sha256), apps/kernel/engine/src/lib.rs:1839 (16MB cap), apps/kernel/engine/src/lib.rs:1860 (pbkdf2Sync: sha256 only)
- **timingSafeEqual** `[stub-acceptable]` — api: `require('crypto').timingSafeEqual(a, b)`  
  Constant-time XOR fold over the two buffers (lib.rs:1863). In a single-threaded WASM VM without shared memory or side-channel timing attacks via cache lines, this is equivalent to the Node implementation for all practical purposes. The divergence (no hardware constant-time guarantee) is not exploitable in this environment.  
  *mechanism:* Pure-JS bitwise XOR fold at lib.rs:1863.  
  *constraint:* No real threads, no shared-memory side channel. The no-thread constraint (QuickJS-WASM) that makes timing attacks infeasible is the same constraint that makes this acceptable.  
  *evidence:* apps/kernel/engine/src/lib.rs:1863
- **getHashes / getCiphers / getCurves** `[partial]` — api: `require('crypto').getHashes() / getCiphers() / getCurves()`  
  getHashes() returns ['sha256','sha384','sha512','sha1','md5'] (lib.rs:1862). This is misleading because createHash('sha512') and createHash('sha384') throw (lib.rs:1815). getCiphers and getCurves do not exist in the export object and will throw 'not a function'.  
  *mechanism:* Hardcoded array at lib.rs:1862.  
  *constraint:* No cipher or curve implementations shipped.  
  *evidence:* apps/kernel/engine/src/lib.rs:1862, apps/kernel/engine/src/lib.rs:1815 (createHash gate contradicts getHashes output), apps/kernel/engine/src/lib.rs:1856-1864 (no getCiphers/getCurves in export)
- **createDiffieHellman / createECDH / generateKeyPair / KeyObject** `[absent]` — api: `require('crypto').createDiffieHellman / createECDH / generateKeyPair / KeyObject`  
  None present. The entire public-key infrastructure (DH key exchange, ECDH, RSA key generation, KeyObject wrapping/unwrapping) is absent.  
  *mechanism:* Not implemented. Would require a pure-JS big-integer + elliptic-curve library (large bundle, snapshot cost) or host-call to Node crypto (not available in WASM-on-CF context).  
  *constraint:* No big-integer arithmetic library shipped. Pure-JS EC/RSA feasible but expensive on snapshot. 12-import WASM ceiling.  
  *evidence:* apps/kernel/engine/src/lib.rs:1856-1864 (full crypto export — no DH/ECDH/generateKeyPair/KeyObject)
- **Date.now() determinism (seeded clock)** `[real]` — api: `Date.now() / new Date() / performance.now()`  
  In default seeded mode: starts at a 1.7e12 epoch (Nov 2023) and advances +1ms per call — byte-identical across snapshot/restore/replay. In clock:real mode: re-anchored at the start of each cell eval to the DO host wall clock (kernel-glue.ts:1557-1563), so inter-cell time is real but within a cell workerd freezes the clock. new Date() argless correctly uses the seeded clock (not the engine's internal frozen 1970 clock — fixed by EngramDate wrapper at lib.rs:208-221). performance.now() routes through the same __now function.  
  *mechanism:* Rust thread-local CLOCK counter injected as __now (lib.rs:2911-2921). CLOCK monotonically advanced +1 per call. Bootstrap overwrites Date.now and Math.random (lib.rs:198-199). clock:real mode seeds CLOCK from real epoch offset (kernel-glue.ts:1232-1235, 1557-1563).  
  *constraint:* Determinism invariant: workerd also freezes its own wall clock in-turn, so real sub-turn timing is impossible regardless. clock:real is a per-cell-boundary re-anchor only.  
  *evidence:* apps/kernel/engine/src/lib.rs:184-188, 2911-2921 (LCG clock counter), apps/kernel/engine/src/lib.rs:198-221 (BOOTSTRAP: Date.now override, EngramDate), apps/kernel/src/kernel-glue.ts:1557-1563 (clock:real re-anchor)
- **Math.random() determinism** `[real]` — api: `Math.random()`  
  Replaced by the seeded LCG at bootstrap (lib.rs:199). Byte-identical across restore for same rngSeed. Not a CSPRNG, but Math.random() is not a CSPRNG in Node either — this is a correct stub. The output range is [0,1) matching the spec.  
  *mechanism:* Rust LCG (lib.rs:184-188, 2923-2932) injected as __rand; Math.random overwritten at lib.rs:199.  
  *constraint:* Determinism invariant.  
  *evidence:* apps/kernel/engine/src/lib.rs:184-188, apps/kernel/engine/src/lib.rs:199, apps/kernel/engine/src/lib.rs:2923-2932
- **Entropy counter persistence across cold restore** `[real]` — api: `N/A — internal determinism mechanism`  
  The engine exports clock_calls() / rng_calls() / set_counters() (lib.rs:3092-3103). The Rust DO persists these in the snapshot manifest and re-injects them via set_counters on restore, so the LCG state is fully reproduced: a cold-restored session continues the exact same clock/RNG sequence as if it never hibernated. This is the core determinism invariant.  
  *mechanism:* Rust WASM exports (lib.rs:3092-3103) + manifest persistence in the Rust DO (apps/kernel/src/lib.rs). set_counters seeds CLOCK and RNG thread-locals on restore.  
  *constraint:* The snapshot-restore model requires this; without it the LCG would reset to the seed value, producing duplicate random sequences after each hibernate.  
  *evidence:* apps/kernel/engine/src/lib.rs:10, 16-17 (export declarations), apps/kernel/engine/src/lib.rs:3092-3103 (clock_calls/rng_calls/set_counters exports)
- **require('crypto').webcrypto** `[stub-acceptable]` — api: `require('crypto').webcrypto (Node >=19 alias for globalThis.crypto)`  
  require('crypto').webcrypto is set to globalThis.crypto (lib.rs:1861), which is the same seeded shim object (getRandomValues + randomUUID + subtle.digest only). This is correct structural aliasing but the underlying crypto is still the seeded LCG / pure-JS digest shim rather than the Node webcrypto CryptoKey-based API.  
  *mechanism:* Direct assignment of globalThis.crypto reference at lib.rs:1861.  
  *constraint:* Same as globalThis.crypto constraints.  
  *evidence:* apps/kernel/engine/src/lib.rs:1861

### streams (Readable/Writable/Duplex/Transform/pipeline/backpressure)

- **Readable (core)** `[partial]` — api: `stream.Readable`  
  push/read/resume/pause/pipe/destroy/setEncoding/Symbol.asyncIterator/Readable.from all present. Missing: highWaterMark (no buffer cap, push() never returns false), no hwm-driven pause, no 'readable' event pulse (only 'data'/'end'/'close'), no readableLength/readableHighWaterMark/readableFlowing getters on prototype, no autoDestroy option.  
  *mechanism:* pure-JS shim injected into QuickJS heap at bootstrap (BOOTSTRAP const string in engine)  
  *constraint:* no real threads, determinism — backpressure modelled on microtasks only; highWaterMark requires a buffer-size accounting loop that would interact with the tick-budget interrupt  
  *evidence:* apps/kernel/engine/src/lib.rs:1728-1746, apps/kernel/engine/src/lib.rs:1718 (comment: 'no real backpressure')
- **Writable (core) — backpressure return value** `[stub-unacceptable]` — api: `stream.Writable / Writable.prototype.write()`  
  write() ALWAYS returns true (lib.rs:1751 — the return true is unconditional regardless of _writableState). In real Node, write() returns false when the internal buffer exceeds highWaterMark, signalling the producer to pause. Any producer that gates on the return value of write() (the correct pattern for backpressure) will NEVER pause, silently accumulating unbounded in-memory buffers until the tick budget fires or memory explodes. drain is emitted correctly after each _write() completes, so code that only listens for drain and never checks the return value works fine.  
  *mechanism:* pure-JS shim; needDrain flag exists in _writableState but is never set to true (write() never returns false, so .pipe() never sees false, so pause is never triggered via the write return path)  
  *constraint:* no highWaterMark accounting — there is no hwm concept in the shim at all  
  *evidence:* apps/kernel/engine/src/lib.rs:1751 (Writable.prototype.write always ends with `return true`), apps/kernel/engine/src/lib.rs:1748 (_writableState.needDrain initialised false, never set true by write()), apps/kernel/engine/src/lib.rs:1740 (pipe() calls dest.write(chunk); if ok === false — that branch never fires)
- **Readable.prototype.pipe()** `[partial]` — api: `stream.Readable#pipe`  
  Present and wired: pauses source on dest.write() returning false, resumes on 'drain'. Works correctly for the transform/passthrough in-VM case. However because Writable.write() always returns true (see above finding), the pause/resume branch in pipe() is dead code — actual backpressure pause never fires. Error forwarding and { end: false } option work. Only the default (single) dest case is handled; calling pipe() twice on the same source does not accumulate piped destinations correctly (the unpipe check is a no-op).  
  *mechanism:* pure-JS shim — lib.rs:1740  
  *constraint:* backpressure dead because Writable.write() always returns true  
  *evidence:* apps/kernel/engine/src/lib.rs:1740, apps/kernel/engine/src/lib.rs:1741 (unpipe is a no-op)
- **Readable.prototype.unpipe()** `[stub-unacceptable]` — api: `stream.Readable#unpipe`  
  Implemented as a complete no-op (returns `this` with no body). Any code that unpipes a destination mid-stream to stop data flowing will silently continue to receive data. Libraries that use unpipe for flow-control (through2, csv-parse) will malfunction.  
  *mechanism:* pure-JS shim — single-line stub  
  *constraint:* no destination tracking implemented in the Readable state; would require a destinations array  
  *evidence:* apps/kernel/engine/src/lib.rs:1741 (Readable.prototype.unpipe = function(){ return this; })
- **Duplex** `[partial]` — api: `stream.Duplex`  
  Readable + Writable methods composited on the prototype. Works in practice for the net.Socket use case. Critical structural bug: Duplex.prototype._writableState = undefined (lib.rs:1763) nulls the property on the prototype so instances get the Writable constructor's instance property via the call to Writable.call(this, opts) — this works but means any code that reads _writableState from the prototype (rather than instance) will see undefined. Missing: allowHalfOpen option ignored at the Duplex level (net.Socket implements it manually), no readableObjectMode/writableObjectMode, no writableNeedDrain/writableFinished/writableEnded getters.  
  *mechanism:* pure-JS shim compositing Readable + Writable prototype chains  
  *constraint:* no real prototype multiple-inheritance; workaround copies methods  
  *evidence:* apps/kernel/engine/src/lib.rs:1758-1763, apps/kernel/engine/src/lib.rs:1763 (Duplex.prototype._writableState = undefined)
- **Transform** `[partial]` — api: `stream.Transform`  
  _transform(chunk,enc,cb) and _flush(cb) work. The default passthrough identity transform is correct. Missing: Transform.prototype.end() fires 'finish' synchronously via queueMicrotask but does NOT wait for _flush to call back before emitting 'finish' — the cb() is in a queueMicrotask alongside origEnd(), so a slow async _flush will emit 'finish' before the flush data is pushed. Also missing: allowHalfOpen, writableObjectMode/readableObjectMode distinct modes, _destroy override support.  
  *mechanism:* pure-JS shim  
  *constraint:* single-threaded microtask event loop — async flush timing is tricky without a real event-loop tick boundary  
  *evidence:* apps/kernel/engine/src/lib.rs:1765-1770, apps/kernel/engine/src/lib.rs:1770 (Transform.prototype.end: queueMicrotask fires both origEnd and cb together)
- **PassThrough** `[real]` — api: `stream.PassThrough`  
  Identity Transform sub-class; _transform passes chunk through unchanged. No divergence beyond the Transform-level limitations above.  
  *mechanism:* pure-JS shim  
  *constraint:* none beyond Transform limitations  
  *evidence:* apps/kernel/engine/src/lib.rs:1772-1774
- **pipeline()** `[partial]` — api: `stream.pipeline / stream/promises.pipeline`  
  Works for in-VM streams: wires src.pipe() chain, listens for error on all streams, destroys all on error, calls back/resolves on terminal finish. Promise-returning form present. Missing: AbortSignal option (pipeline({signal}) not supported — no abort wiring), does not support async-generator sources/transforms (only EventEmitter-shaped streams), no stream/web (WHATWG) ReadableStream/WritableStream sources.  
  *mechanism:* pure-JS shim — lib.rs:1780; stream/promises alias at lib.rs:2162  
  *constraint:* no AbortSignal integration with pipeline; WHATWG stream interop absent  
  *evidence:* apps/kernel/engine/src/lib.rs:1779-1780, apps/kernel/engine/src/lib.rs:1783 (promises: { pipeline, finished }), apps/kernel/engine/src/lib.rs:2162 (B['stream/promises'] = __stream.promises)
- **finished()** `[stub-acceptable]` — api: `stream.finished`  
  Listens for 'end'/'finish'/'error'/'close' and calls back/resolves. Promise form works. Missing: options object ({readable, writable, error, signal}) — all options ignored. Does not distinguish readable-end vs writable-finish, so on a Duplex it fires on first of either. Acceptable for the common use case of 'wait for stream to be done'.  
  *mechanism:* pure-JS shim  
  *constraint:* no options parsing  
  *evidence:* apps/kernel/engine/src/lib.rs:1776-1777
- **stream/web (require('stream/web'))** `[stub-unacceptable]` — api: `stream/web — WHATWG ReadableStream/WritableStream/TransformStream`  
  require('stream/web') returns the Node-style __stream object (Readable/Writable/Duplex/Transform), NOT the WHATWG ReadableStream/WritableStream/TransformStream classes. Any code that imports { ReadableStream, WritableStream, TransformStream } from 'stream/web' to get Web-standard streaming will get undefined for those names (they are not properties of __stream). This is a silent mismatch — no error is thrown, the destructuring just returns undefined.  
  *mechanism:* pure-JS shim aliased incorrectly — lib.rs:2163 sets B['stream/web'] = __stream  
  *constraint:* WHATWG WritableStream/TransformStream not implemented in the VM; only a minimal ReadableStream shim exists on globalThis  
  *evidence:* apps/kernel/engine/src/lib.rs:2163 (B['stream/web'] = __stream — the Node streams object, not WHATWG), apps/kernel/engine/src/lib.rs:263-313 (globalThis.ReadableStream minimal shim — no getDefaultReader controller, no queuingStrategy, no backpressure), apps/kernel/engine/src/lib.rs:263 (comment: 'no real backpressure')
- **WHATWG ReadableStream (globalThis.ReadableStream)** `[partial]` — api: `globalThis.ReadableStream (Web Streams API)`  
  Minimal shim: start/pull/cancel underlying source hooks, getReader() with read()/releaseLock()/cancel(), Symbol.asyncIterator, locked getter. No queuingStrategy, no byob reader, no tee(), no pipeThrough(), no pipeTo(), no WHATWG backpressure (no desiredSize/pull throttling). Only used as a shim for Response.body. Code that calls rs.tee() or rs.pipeThrough() will throw TypeError.  
  *mechanism:* pure-JS shim injected at BOOTSTRAP  
  *constraint:* single-threaded microtask model cannot implement WHATWG controller backpressure (desiredSize/pull scheduling requires a real microtask checkpoint boundary per chunk)  
  *evidence:* apps/kernel/engine/src/lib.rs:263-313, apps/kernel/engine/src/lib.rs:263 (comment: 'minimal WHATWG ReadableStream (no real backpressure)')
- **WHATWG WritableStream / TransformStream** `[absent]` — api: `globalThis.WritableStream / globalThis.TransformStream`  
  Neither class is shimmed in the VM. The DO host-side uses TransformStream (kernel-glue.ts:2155) for request-body upload, but that never crosses into the QuickJS heap. Code that does `new WritableStream(...)` or `new TransformStream(...)` in a cell will throw ReferenceError.  
  *mechanism:* not provided  
  *constraint:* not blocked by a hard WASM constraint — it is simply not implemented; would be implementable as a pure-JS shim  
  *evidence:* apps/kernel/engine/src/lib.rs:263-313 (only ReadableStream shimmed), apps/kernel/src/kernel-glue.ts:2155 (TransformStream used on the DO/host side only)
- **fs.createReadStream** `[partial]` — api: `fs.createReadStream`  
  Works only on the in-heap VFS provider (throws asyncOnly error under host-backed R2 provider). Reads the entire file synchronously in one queueMicrotask, pushes a single chunk, then pushes null — there is no chunked streaming (no highWaterMark chunk sizing). The {start, end} byte-range slice is correct. 'open'/'ready' events emitted. 'close' fires via Readable's end path. Missing: fd option, autoClose option, position option, actual chunked emission for large files.  
  *mechanism:* pure-JS shim over in-heap VFS array — lib.rs:2461-2485  
  *constraint:* in-heap VFS is a flat Uint8Array; no streaming read handle; chunked emission would require storing a cursor in heap state across microtasks  
  *evidence:* apps/kernel/engine/src/lib.rs:2461-2485, apps/kernel/engine/src/lib.rs:2462 (if (provider() !== 'vfs') throw asyncOnly('createReadStream')), apps/kernel/engine/src/lib.rs:2480-2481 (pushes entire slice then null in single microtask)
- **fs.createWriteStream** `[partial]` — api: `fs.createWriteStream`  
  Works only on the in-heap VFS. Buffers all written chunks in memory, commits them atomically to the VFS on end()/_final. Flags 'w' (truncate) and 'a' (append) work. Missing: encoding option on read side, fd option, autoClose, highWaterMark, partial-write durability (if the cell crashes mid-stream the write is lost). The whole-buffer-on-end approach means large streaming writes consume the full data in-memory simultaneously before committing.  
  *mechanism:* pure-JS shim over in-heap VFS — lib.rs:2487-2508  
  *constraint:* in-heap VFS has no incremental write handle; sync flat-byte store only  
  *evidence:* apps/kernel/engine/src/lib.rs:2487-2508, apps/kernel/engine/src/lib.rs:2488 (if (provider() !== 'vfs') throw asyncOnly('createWriteStream')), apps/kernel/engine/src/lib.rs:2494-2504 (buffers all parts, commits in _final)
- **zlib streaming Transforms (createGzip/createGunzip/createDeflate/createInflate etc.)** `[absent]` — api: `zlib.createGzip / createGunzip / createDeflate / createInflate / createDeflateRaw / createInflateRaw / createUnzip`  
  zlib only provides sync (*Sync) and callback/Promise async bulk functions. There are no streaming Transform class wrappers. Code that pipes a stream through zlib.createGunzip() (e.g. tar.gz extraction, piping a gzip HTTP response through a gunzip transform) will fail with TypeError: zlib.createGunzip is not a function.  
  *mechanism:* not provided — only sync/async bulk API exists  
  *constraint:* not a hard constraint; Transform-based streaming zlib is buildable on top of the existing inflateRaw/deflateRaw primitives and the Transform class — it is simply not implemented  
  *evidence:* apps/kernel/engine/src/lib.rs:1974-1985 (zlib exports: only *Sync and async bulk, no create* factories), apps/kernel/engine/src/lib.rs:1867-1875 (comment confirms 'sync+async' only, no streaming transforms)
- **net.Socket as Duplex** `[partial]` — api: `net.Socket (extends stream.Duplex)`  
  The most complete Duplex implementation in the codebase. Outbound TCP via cloudflare:sockets host call. connect/write/end/destroy/setTimeout/setNoDelay/setKeepAlive all present. Strict sequential per-socket command loop prevents the host single-slot __settleHost race. Key divergences: (1) inbound (net.Server/createServer/listen) throws NotSupportedError — impossible on CF DO; (2) sockets do NOT survive DO hibernation/cold-restore (stale handle surfaces as ECONNRESET, not a hang); (3) max 6 concurrent outbound connections (cloudflare:sockets cap); (4) no inactivity timer (setTimeout sets timeout but cannot fire — no wall clock); (5) unix domain sockets throw ENOTSUP.  
  *mechanism:* host-call via host['socket.open/read/write/close/startTls'] — cloudflare:sockets on the DO side  
  *constraint:* no listen socket on CF DO (EPERM), 6-connection cap per invocation from cloudflare:sockets, no wall-clock timer  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:1-563, apps/kernel/stdlib-src/shims/net.js:30 (DURABILITY: live sockets DIE on DO eviction), apps/kernel/stdlib-src/shims/net.js:34 (cloudflare:sockets caps ~6 outbound connections), apps/kernel/stdlib-src/shims/net.js:37 (INBOUND IS IMPOSSIBLE)
- **stream.compose()** `[absent]` — api: `stream.compose`  
  Not implemented. Not exported from the __stream object. Added in Node 16.9; not commonly required by older npm packages but any code using it will get TypeError.  
  *mechanism:* not provided  
  *constraint:* not a hard constraint — buildable on top of existing pipeline/Duplex shims  
  *evidence:* apps/kernel/engine/src/lib.rs:1783 (api object — compose absent)
- **stream.addAbortSignal()** `[absent]` — api: `stream.addAbortSignal`  
  Not implemented. AbortSignal/AbortController exist in the VM but are not wired into the stream module.  
  *mechanism:* not provided  
  *constraint:* not a hard constraint — AbortSignal wiring to stream.destroy() is implementable  
  *evidence:* apps/kernel/engine/src/lib.rs:1783 (api object — addAbortSignal absent), apps/kernel/engine/src/lib.rs:942-955 (AbortSignal shim present but not connected to streams)
- **Readable.toWeb() / Writable.toWeb() / Readable.fromWeb()** `[absent]` — api: `stream.Readable.toWeb / Writable.toWeb / Readable.fromWeb (Node 17+)`  
  Not implemented. Conversion between Node streams and WHATWG streams is unavailable. Since WritableStream/TransformStream are also absent, this whole interop surface is missing.  
  *mechanism:* not provided  
  *constraint:* WHATWG WritableStream/TransformStream not shimmed in VM; absent by consequence  
  *evidence:* apps/kernel/engine/src/lib.rs:1783 (api — toWeb/fromWeb absent), apps/kernel/engine/src/lib.rs:2163 (stream/web aliased to wrong object)
- **HTTP IncomingMessage / response body as Readable** `[partial]` — api: `http.IncomingMessage (stream.Readable subclass)`  
  http/https module's response is a Readable with 'data'/'end' events, statusCode, headers. Body bytes come from the buffered host.fetch response, drained in a single queueMicrotask emit (not truly chunked from the network). The Readable is usable but not a live streaming tap on the TCP socket — it is a replay from the already-buffered response. For truly chunked responses (content-length unknown / transfer-encoding chunked), the kernel-glue true-streaming path (#13) can expose a streamId-backed body, but only if the caller uses Response.body (WHATWG) not http.request().  
  *mechanism:* pure-JS shim over buffered host.fetch response  
  *constraint:* http.request goes through the DO-mediated host.fetch, which buffers inline for non-streaming responses; the per-chunk streamRead path is WHATWG-fetch-only  
  *evidence:* apps/kernel/engine/src/lib.rs:2265 (caveat: 'http/https are CLIENT-ONLY over the mediated host.fetch'), apps/kernel/src/kernel-glue.ts:1773-1774 (streamRead/streamCancel host ops), apps/kernel/engine/src/lib.rs:1047-1062 (Response.body returns ReadableStream backed by host.streamRead)

### process (argv/env/cwd/chdir/nextTick/exit/stdout/stderr/hrtime/platform/version)

- **process.platform / process.arch** `[stub-acceptable]` — api: `process.platform, process.arch`  
  Hard-coded to 'linux' / 'x64'. This is the correct feature-detect target for the vast majority of npm packages that gate on platform. Never wrong in a way that causes silent misbehavior — it is intentionally lying to look like the most common Node host.  
  *mechanism:* Pure-JS shim, baked into the WASM heap at engine create via an IIFE in the engine source.  
  *constraint:* No real OS identity in a Cloudflare Worker / WASM sandbox. Value is a cosmetic constant.  
  *evidence:* apps/kernel/engine/src/lib.rs:788-789
- **process.version / process.versions / process.release** `[stub-acceptable]` — api: `process.version, process.versions, process.release`  
  Hard-coded to 'v20.11.1' with a plausible v8/uv/zlib/openssl versions map. Also exposes 'quickjs' and 'engram' keys. Libraries that feature-detect on versions.node (e.g. 'node >= 18') will pass. The v8 version string is fabricated but believable.  
  *mechanism:* Pure-JS constant shim in the WASM heap.  
  *constraint:* No real V8 or Node runtime; cosmetic constants are the only feasible implementation.  
  *evidence:* apps/kernel/engine/src/lib.rs:790-792
- **process.env** `[stub-unacceptable]` — api: `process.env`  
  Starts as an empty plain object {} at session create. The engine code reads globalThis.__processEnv and populates process.env from it if set — but __processEnv is NEVER populated by the glue (kernel-glue.ts has no code that sets it). There is NO path for a caller to inject env vars via the {t:'create', config:{...}} message. Code that reads process.env.NODE_ENV, process.env.API_KEY, etc. always gets undefined. The comment says 'the glue MAY seed it from config/ctx' but no such seeding is implemented. This silently misbehaves for any library that gates on NODE_ENV (e.g. React in dev vs prod, dotenv).  
  *mechanism:* Pure-JS shim; __processEnv hook exists but is never exercised — the seeding path is documented-as-intended but absent in the actual glue.  
  *constraint:* No implementation blocker; the hook is wired but never called. A config.env field in KernelConfig and a corresponding glue line would fix it.  
  *evidence:* apps/kernel/engine/src/lib.rs:769 (comment: 'the glue MAY seed it'), apps/kernel/engine/src/lib.rs:779-781 (conditional read of __processEnv), apps/kernel/src/kernel-glue.ts:1216-1253 (_applyConfig — no env/processEnv field handled)
- **process.argv / process.argv0 / process.execPath / process.execArgv** `[stub-acceptable]` — api: `process.argv, process.argv0, process.execPath, process.execArgv`  
  Fixed to ['node','repl'], 'node', '/usr/local/bin/node', []. Any library that reads argv[0] for identification works. Scripts that parse process.argv[2]+ for CLI flags will find nothing — but this is a REPL/kernel, not a CLI runner, so that is the correct semantics.  
  *mechanism:* Pure-JS constant in WASM heap.  
  *constraint:* No real argv in a Cloudflare DO. There is no concept of a command-line invocation.  
  *evidence:* apps/kernel/engine/src/lib.rs:783-786
- **process.cwd()** `[real]` — api: `process.cwd()`  
  Returns globalThis.__cwd, defaulting to '/workspace'. The __cwd global is kept coherent with the virtual filesystem root. Matches Node semantics for relative-path resolution.  
  *mechanism:* Pure-JS shim backed by the in-heap __cwd global; aligned with the host-side norm_fs_path_cwd resolver in lib.rs.  
  *constraint:* No real OS CWD; the VM is clamped to /workspace.  
  *evidence:* apps/kernel/engine/src/lib.rs:809
- **process.chdir()** `[partial]` — api: `process.chdir()`  
  Changes __cwd (survives in-session, in-heap). Path is normalized through __wsResolveAbs which enforces /workspace root — attempts to escape via '..' throw EACCES. Does NOT propagate back to the host-side cwd used by fs frame messages: the Rust DO reads msg.get('cwd') from the WS frame, not from an engine-side global. So process.chdir('/workspace/sub') works for in-VM relative path resolution but fs.readFile calls from cells must pass explicit paths or the cell must pass cwd in the frame (not automatic).  
  *mechanism:* Pure-JS shim updating __cwd; __wsResolveAbs enforces the /workspace jail. Host-side lib.rs:1294 reads a separate per-frame cwd field.  
  *constraint:* No real OS CWD. The in-VM and host-side cwd are separate state, only synchronized if the cell passes cwd explicitly in fs host-calls.  
  *evidence:* apps/kernel/engine/src/lib.rs:800-810, apps/kernel/src/lib.rs:1293-1295
- **process.nextTick()** `[stub-acceptable]` — api: `process.nextTick()`  
  Implemented as queueMicrotask(). In Node, nextTick queue drains before the microtask queue (Promise callbacks). Here they are interleaved as a single microtask queue. This is a known, benign deviation — the vast majority of code that uses nextTick(fn) for 'defer to end of turn' works correctly. Code that relies on nextTick firing before Promise.resolve().then() will see different ordering.  
  *mechanism:* Pure-JS shim: p.nextTick = function(f){ queueMicrotask(...) }  
  *constraint:* QuickJS has one microtask queue; there is no separate nextTick phase. Implementing a true separate nextTick queue is possible (drain before settling) but not done.  
  *evidence:* apps/kernel/engine/src/lib.rs:818
- **process.exit()** `[stub-unacceptable]` — api: `process.exit()`  
  Throws a catchable ProcessExit error (name='ProcessExit', e.processExit=true) instead of terminating the process. The kernel survives. Code that calls process.exit(1) expecting the program to stop will instead see execution continue in the caller (the throw unwinds only to the nearest catch). Any outer try/catch that does not specifically check e.processExit will swallow the exit silently and continue running. This is documented but will silently break programs that treat process.exit as a hard stop (e.g. CLI tools, test runners that call exit(1) on failure, any code after a conditional process.exit that should never run).  
  *mechanism:* Pure-JS shim; throws Error with processExit=true flag.  
  *constraint:* There is no real process to kill. Terminating the WASM instance would destroy the live kernel state. The kernel must remain alive across cells.  
  *evidence:* apps/kernel/engine/src/lib.rs:827-831, apps/kernel/engine/src/lib.rs:2268 (documented caveat)
- **process.stdout.write() / process.stderr.write()** `[stub-acceptable]` — api: `process.stdout, process.stderr`  
  Both are write-only plain objects routing to console.log / console.error respectively. isTTY=false, columns=80, rows=24 are fixed. .write() accepts string or Uint8Array, strips trailing newline, delegates to console. Missing: pipe(), setEncoding(), highWaterMark, backpressure, 'drain' events. Sufficient for the common case of console-output libraries that write to stderr/stdout.  
  *mechanism:* Pure-JS shim (mkStream factory) in WASM heap.  
  *constraint:* No real file descriptors or OS stream in a WASM/CF context. The only output channel is console (captured by the kernel per-cell).  
  *evidence:* apps/kernel/engine/src/lib.rs:851-854
- **process.stdin** `[stub-unacceptable]` — api: `process.stdin`  
  Always returns null from read(), all event listeners are no-ops, pipe() is a no-op. Any code that reads from stdin (CLI tools, readline, interactive input) will hang silently or get null/EOF immediately. isTTY=false. This is a hard semantic gap — stdin is fundamentally unavailable in a request-driven serverless REPL.  
  *mechanism:* Pure-JS null-stub in WASM heap.  
  *constraint:* Cloudflare DO Workers have no stdin fd. There is no interactive TTY or pipe into the WASM instance. Impossible to implement real stdin without a separate protocol channel.  
  *evidence:* apps/kernel/engine/src/lib.rs:855
- **process.hrtime() / process.hrtime.bigint()** `[stub-unacceptable]` — api: `process.hrtime(), process.hrtime.bigint()`  
  Derived from the SEEDED millisecond clock (Date.now() which is the seeded tick counter). Node's hrtime is a high-resolution monotonic clock with nanosecond precision. Here: (1) granularity is ms only — the nanoseconds field is always (ms%1000)*1e6 with zero sub-ms component, so hrtime()[1] only takes values 0,1000000,2000000,...999000000. (2) In seeded mode the clock ticks +1ms per JS Date call, not per real time — benchmark code using hrtime for wall-clock measurement will get useless numbers. (3) Across hibernation, the clock may jump or reset depending on config. Code that uses hrtime to measure elapsed real time (benchmarks, timeouts) gets misleading results. The bigint variant has the same ms-only granularity issue.  
  *mechanism:* Pure-JS shim backed by seeded Date.now() / the rquickjs seeded clock.  
  *constraint:* WASI clock_time_get returns 0n (kernel-glue.ts:282-284); the engine has its own seeded monotone clock. Sub-millisecond timing is not available in a WASM/CF environment.  
  *evidence:* apps/kernel/engine/src/lib.rs:819-823, apps/kernel/src/kernel-glue.ts:281-284 (clock_time_get returns 0n)
- **process.uptime()** `[stub-unacceptable]` — api: `process.uptime()`  
  Returns seconds since the first hrtime observation in the current in-memory VM session, using the seeded clock. Across hibernation/cold-restore __procT0 is re-evaluated from the seeded clock on the first call — it does NOT track real wall-clock uptime from process start, and it does NOT persist the original process-start time across restarts. Code measuring real elapsed process uptime will get wrong values.  
  *mechanism:* Pure-JS shim; __procT0 stored in-heap, re-set on each fresh VM instantiation.  
  *constraint:* No real process lifecycle. The VM is instantiated fresh on cold restore; __procT0 resets.  
  *evidence:* apps/kernel/engine/src/lib.rs:825-826
- **process.on() / process.once() / process.emit() for lifecycle events** `[stub-unacceptable]` — api: `process.on('exit'), process.on('uncaughtException'), process.on('SIGINT'), etc.`  
  The EventEmitter interface (on/once/off/emit/removeListener/etc.) is implemented as a plain object map. However, the runtime NEVER auto-fires any events — 'exit' is never emitted (process.exit() throws instead of emitting), 'uncaughtException' is never emitted (QuickJS errors surface as returned values), 'beforeExit' is never emitted, POSIX signals (SIGINT/SIGTERM/SIGUSR1) are never emitted. Code that installs cleanup handlers via process.on('exit', fn) will never have them called. Test frameworks that rely on uncaughtException will not catch kernel-level errors.  
  *mechanism:* Pure-JS EventEmitter-like object map in WASM heap; no runtime dispatch from the kernel side.  
  *constraint:* No real process lifecycle in a DO. No POSIX signal delivery to WASM. process.exit() is a throw, not a lifecycle event.  
  *evidence:* apps/kernel/engine/src/lib.rs:835-848
- **process.kill()** `[impossible]` — api: `process.kill(pid, signal)`  
  Always returns true (no-op). There is no ability to send signals to any process, including itself. PID 1 is a cosmetic constant. Silently succeeds instead of throwing ESRCH or EPERM.  
  *mechanism:* Pure-JS stub returning true.  
  *constraint:* No process model in a Cloudflare Worker/DO. No kill() syscall available to WASM.  
  *evidence:* apps/kernel/engine/src/lib.rs:834
- **process.memoryUsage() / process.cpuUsage()** `[stub-unacceptable]` — api: `process.memoryUsage(), process.cpuUsage()`  
  Always returns zeros for all fields (rss=0, heapTotal=0, heapUsed=0, external=0, arrayBuffers=0 and user=0, system=0). Code that uses memoryUsage() for memory monitoring or cpuUsage() for profiling will get no signal. This is particularly bad since the kernel does track WASM used-heap internally (via getMemoryUsage().memoryUsedSize in Rust) but that value is never exposed to the VM.  
  *mechanism:* Pure-JS stub returning zero objects.  
  *constraint:* WASM linear memory stats are not accessible from within the JS VM directly. The host-side (Rust) has the WASM memory view but does not inject it back into process.memoryUsage.  
  *evidence:* apps/kernel/engine/src/lib.rs:814-816
- **process.pid / process.ppid** `[stub-acceptable]` — api: `process.pid, process.ppid`  
  Fixed to pid=1, ppid=0. Acceptable for feature-detect purposes. Code that uses pid for temp file naming or IPC will get collisions across concurrent sessions, but this is edge-case usage in a single-session REPL context.  
  *mechanism:* Pure-JS constant in WASM heap.  
  *constraint:* No real OS process; there is no pid namespace in a CF Worker.  
  *evidence:* apps/kernel/engine/src/lib.rs:787
- **process.binding()** `[impossible]` — api: `process.binding()`  
  Throws 'process.binding is not supported in this sandbox'. Correct behavior — this is a Node internal that accesses C++ native bindings. Any package that calls process.binding() will throw.  
  *mechanism:* Pure-JS stub that throws explicitly.  
  *constraint:* No C++ V8 bindings layer in QuickJS/WASM. Intrinsically impossible.  
  *evidence:* apps/kernel/engine/src/lib.rs:856
- **process.title / process.config / process.features / process.allowedNodeEnvironmentFlags** `[stub-acceptable]` — api: `process.title, process.config, process.features`  
  process.title='node', process.config={target_defaults:{},variables:{}}, process.features={inspector:false,...}. These are checked by very few packages. No fidelity issues for normal use.  
  *mechanism:* Pure-JS constants in WASM heap.  
  *constraint:* No real Node config/build system. Cosmetic constants only.  
  *evidence:* apps/kernel/engine/src/lib.rs:793-796

### timers (setTimeout/setInterval/setImmediate/clearX) + seeded clock + durability across hibernate

- **setTimeout(fn, delay, ...args)** `[stub-unacceptable]` — api: `global setTimeout`  
  The delay argument is completely ignored. The callback fires on the microtask queue within the same cell turn — effectively synchronous. Code that relies on any real wall-clock deferral (rate limiting, retry backoff, debounce, animation scheduling) breaks silently: `setTimeout(fn, 1000)` runs ~now. Return value is a numeric id (not a Node Timeout object), so `.unref()/.ref()` are absent but that divergence is minor compared to the timing lie.  
  *mechanism:* pure-JS shim — schedules via `queueMicrotask`; delay argument read but discarded  
  *constraint:* no wall-clock timers in bare QuickJS-WASM; workerd provides no cross-turn timer API to the WASM side; determinism requirement forbids non-reproducible wakeup ordering  
  *evidence:* apps/kernel/engine/src/lib.rs:859-867, apps/kernel/engine/src/lib.rs:863 (comment: 'CAVEAT: setTimeout(fn, 1000) runs ~now, not after 1s')
- **clearTimeout(id)** `[stub-acceptable]` — api: `global clearTimeout`  
  Works correctly as a cancellation primitive within the microtask model: sets a flag in `__tcancel`; the pending microtask checks the flag before invoking the callback. Because setTimeout fires on a microtask (not a real timer), clearTimeout is only useful if called before the next microtask drain — which in synchronous code means it works. Edge case: if the id is a Node Timeout object (e.g. from a bundled library using its own internal representation), the numeric-id shim diverges.  
  *mechanism:* pure-JS shim — sets `__tcancel[id] = true`  
  *constraint:* no real timer infrastructure; cancellation is local to the microtask queue flag  
  *evidence:* apps/kernel/engine/src/lib.rs:868
- **setImmediate(fn, ...args)** `[stub-acceptable]` — api: `global setImmediate`  
  Fires on the microtask queue — semantically correct for the common use case of 'run after current synchronous code'. In real Node, setImmediate fires after I/O events in the check phase, AFTER promise microtasks. Here it fires as a microtask (before I/O), so ordering relative to resolved Promises is inverted. Code that depends on setImmediate running strictly after Promises may misbehave, but the vast majority of setImmediate usage (deferral, stack unwinding) works.  
  *mechanism:* pure-JS shim — `queueMicrotask(fn.apply)`  
  *constraint:* single-turn QuickJS event loop has no separate check/I/O phases  
  *evidence:* apps/kernel/engine/src/lib.rs:869
- **clearImmediate(id)** `[stub-unacceptable]` — api: `global clearImmediate`  
  Completely empty function — `function(){}`. Does nothing. Any code that calls clearImmediate to cancel a pending setImmediate will silently fail to cancel; the callback will fire regardless. Unlike clearTimeout which at least implements the cancellation flag logic, clearImmediate is a documented hole.  
  *mechanism:* pure-JS shim — empty no-op function body  
  *constraint:* oversight; setImmediate uses queueMicrotask which has no cancellation API in QuickJS  
  *evidence:* apps/kernel/engine/src/lib.rs:870 (body is empty: `globalThis.clearImmediate = function(){};`)
- **setInterval(fn, delay, ...args)** `[stub-unacceptable]` — api: `global setInterval`  
  Fires on the microtask queue with NO delay between iterations. This means: (1) the delay is silently ignored, (2) ALL iterations run to completion within the same cell turn — so `setInterval(fn, 1000)` fires all 10k iterations immediately before the cell returns, not once per second. Bounded to 10,000 iterations as a guard against infinite loops, but that bound is invisible to user code and will silently stop calling fn. Code that uses setInterval for periodic background work (polling, heartbeat) is silently broken. Note the code comment says the prior no-op was 'a silent lie' — the current implementation replaced one lie with a different one.  
  *mechanism:* pure-JS shim — self-referencing microtask chain, bounded to 10k iterations, delay discarded  
  *constraint:* no wall-clock timers in bare QuickJS-WASM; repeating timers cannot span snapshot boundaries; determinism requirement  
  *evidence:* apps/kernel/engine/src/lib.rs:871-875, apps/kernel/engine/src/lib.rs:871 (comment: 'FIX: setInterval was a no-op (never fired — a silent lie)')
- **clearInterval(id)** `[stub-acceptable]` — api: `global clearInterval`  
  Works correctly within the microtask-loop model: sets `__tcancel[id]` which the tick loop checks on every iteration. Cancellation is instant. No divergence for the common case.  
  *mechanism:* pure-JS shim — sets `__tcancel[id] = true`  
  *constraint:* same as setInterval  
  *evidence:* apps/kernel/engine/src/lib.rs:875
- **process.nextTick(fn, ...args)** `[stub-acceptable]` — api: `process.nextTick`  
  Implemented as `queueMicrotask(fn)`. In real Node, nextTick runs in its own 'nextTickQueue' which drains BEFORE the promise microtask queue. Here it joins the same microtask queue as resolved Promises. Ordering between nextTick and Promise.then is inverted from Node semantics. For the overwhelming majority of usage (defer a callback, yield to I/O) this is acceptable; micro-ordering tests will fail.  
  *mechanism:* pure-JS shim — `queueMicrotask`  
  *constraint:* QuickJS has a single unified microtask queue with no nextTick-priority lane  
  *evidence:* apps/kernel/engine/src/lib.rs:818
- **require('timers') module** `[absent]` — api: `require('timers') / import from 'timers'`  
  The `timers` module is NOT in the `__builtins` map and not in the `builtinModules` list. `require('timers')` will throw 'not a built-in'. It is only mentioned in the caveats string in the discoverability block. Code that does `const { setTimeout } = require('timers')` will break.  
  *mechanism:* not registered in __builtins at engine/src/lib.rs:2098-2157; builtins list at line 2174 omits 'timers'  
  *constraint:* not built; the global shims exist but no module export wrapping them  
  *evidence:* apps/kernel/engine/src/lib.rs:2174 (builtins list does not include 'timers'), apps/kernel/engine/src/lib.rs:2242 (only appears in the caveats description string, not as a module key)
- **require('timers/promises') module** `[absent]` — api: `require('timers/promises') — setTimeout/setImmediate/setInterval returning Promises`  
  The `timers/promises` submodule (Node v15+, widely used for `await setTimeout(ms)`) is not registered. `require('timers/promises')` throws. Even if it were registered, the underlying semantics would be stub-unacceptable for the same reasons as setInterval/setTimeout.  
  *mechanism:* not registered; the submodule alias block at line 2158-2167 only adds stream/promises, fs/promises, util/types, assert/strict, path/posix  
  *constraint:* not built  
  *evidence:* apps/kernel/engine/src/lib.rs:2158-2167 (submodule aliases — timers/promises absent), apps/kernel/engine/src/lib.rs:2174 (builtins list)
- **Date.now() / new Date() — seeded clock** `[stub-acceptable]` — api: `Date.now(), new Date()`  
  In default 'seeded' mode: clock starts at a fixed epoch (1.7e12 ms = Nov 2023) and increments +1ms on each `__now()` call. Byte-identical across cold restore — deterministic. In 'real' mode (config.clock==='real'): seeded from the host wall clock at create, re-anchored to real wall time between cells (monotonic: never moves backward), but still ticks +1ms per call within a cell turn (workerd freezes wall time in-turn). For seeded mode: code that computes real elapsed time will get wrong results; code that just needs a monotone timestamp for ordering or cache keys is fine. For real mode: acceptable for user-facing timestamps; still diverges on sub-cell granularity.  
  *mechanism:* seeded host-call: engine creates a WASM-exported `__now()` that reads `CLOCK` thread-local (incremented per call); kernel-glue.ts:1232-1237 seeds it; Date constructor wrapped via EngramDate shim  
  *constraint:* workerd freezes wall clock in-turn; determinism requirement for default seeded sessions; WASM linear memory snapshot requires reproducible re-hydration of entropy counters  
  *evidence:* apps/kernel/engine/src/lib.rs:198-217 (Date/performance.now override), apps/kernel/engine/src/lib.rs:2912-2921 (WASM __now implementation), apps/kernel/src/kernel-glue.ts:1223-1237 (clockSeed config logic), apps/kernel/src/kernel-glue.ts:884-886 (CLOCK_EPOCH_BASE_MS comment)
- **performance.now()** `[stub-acceptable]` — api: `performance.now() / require('perf_hooks').performance.now()`  
  Routed through the same seeded `__now()` as Date.now() — NOT a real high-resolution monotonic clock. Resolution is 1ms per call (not sub-millisecond). In real Node, performance.now() returns nanosecond-resolution time since process start; here it returns the seeded millisecond tick. Code measuring real elapsed time will get wrong results; code using it for ordering or simple monotone IDs is fine. `perf_hooks.PerformanceObserver` is a no-op stub.  
  *mechanism:* pure-JS override of `performance.now` property to call `__now()`; `perf_hooks` module in __builtins wraps the same  
  *constraint:* same as Date.now() — seeded clock, workerd in-turn freeze  
  *evidence:* apps/kernel/engine/src/lib.rs:200-201 (performance.now override), apps/kernel/engine/src/lib.rs:2141-2142 (perf_hooks builtin with PerformanceObserver no-op)
- **process.hrtime() / process.hrtime.bigint()** `[stub-acceptable]` — api: `process.hrtime, process.hrtime.bigint`  
  Derived from the seeded Date.now() (ms granularity), not a real nanosecond monotonic clock. Returns `[seconds, nanoseconds]` where nanoseconds = `(ms % 1000) * 1e6` — sub-millisecond precision is always zero. `hrtime.bigint()` returns ms * 1_000_000n. For differential timing (hrtime(prev)), the diff arithmetic is correct in structure but has 1ms floor resolution instead of nanoseconds. Code expecting sub-ms precision will get zeros.  
  *mechanism:* pure-JS shim over Date.now() in the process shim block  
  *constraint:* seeded clock is ms-granularity; no real high-res timer available inside WASM  
  *evidence:* apps/kernel/engine/src/lib.rs:821-823 (hrtime and hrtime.bigint implementation)
- **Clock state durability across hibernate/cold-restore** `[real]` — api: `N/A — internal clock durability primitive`  
  The clock tick counter (`clock_calls`) is persisted in the SQLite snapshot manifest alongside the heap image. On cold-restore, `set_counters(clockCalls, rngCalls)` re-injects the saved counter before the restored heap is used. For seeded sessions this ensures byte-identical clock values across evictions. For clock:real sessions the clock is re-anchored to real wall time between cells (set_clock called in kernel-glue.ts:1566), preserving monotonicity. This is correct and complete: no clock discontinuity from hibernation.  
  *mechanism:* WASM-exported `clock_calls()` read at dump time (kernel-glue.ts:2612); stored in SQL column `clock_calls` (lib.rs:305); restored via `set_counters` WASM export (kernel-glue.ts:1381) after heap blit  
  *constraint:* snapshot-based durability requires restoring all in-VM entropy state to preserve determinism; the heap blit alone does not restore the WASM thread-local CLOCK counter  
  *evidence:* apps/kernel/src/kernel-glue.ts:2612 (clockCalls captured in dump), apps/kernel/src/kernel-glue.ts:1381 (set_counters called after blit on restore), apps/kernel/src/lib.rs:305 (clock_calls column in manifest schema), apps/kernel/src/lib.rs:2989 (clock_calls persisted in checkpoint)
- **Timers spanning snapshot boundaries** `[impossible]` — api: `any timer whose callback should fire after a DO hibernation/eviction`  
  There is no mechanism for a timer callback registered in one cell to fire across a snapshot boundary or after a DO eviction. The microtask-queue timers are heap state — they exist only in the live WASM instance. When the DO hibernates, the heap is snapshotted but there is no host-side alarm wired to resume the instance and drain a pending timer queue. Code that sets a setTimeout/setInterval expecting it to fire in a later cell or after a wake from idle is silently broken: the callback is simply never invoked.  
  *mechanism:* not possible — microtask queue lives in WASM linear memory which is restored on resume, but the DO alarm mechanism is used only for flush/warm-keep, not for user timer delivery  
  *constraint:* WASM linear memory snapshot restores heap state but the workerd/DO platform does not deliver microtasks from a restored heap; alarms cannot be set from a WASM context (facet alarm restriction); no host-timer registration API in the WASM ABI  
  *evidence:* apps/kernel/engine/src/lib.rs:860-861 (comment: 'no timer ever spans a snapshot'), apps/kernel/src/lib.rs:612-618 (alarm handler used only for flush, not user timers)
- **AbortSignal.timeout(ms)** `[stub-unacceptable]` — api: `AbortSignal.timeout`  
  The `ms` argument is ignored. The signal aborts immediately on the next microtask, not after ms milliseconds. Code using `fetch(url, { signal: AbortSignal.timeout(5000) })` to enforce a 5-second network timeout will instead abort the fetch on the next microtask — before the response arrives. This silently breaks all real-timeout use patterns.  
  *mechanism:* pure-JS shim — `queueMicrotask` fires abort immediately regardless of ms argument  
  *constraint:* no wall-clock timers; same root cause as setTimeout  
  *evidence:* apps/kernel/engine/src/lib.rs:943-953, apps/kernel/engine/src/lib.rs:2264 (documented in caveats)

### zlib / compression (gzip/deflate/brotli/zstd)

- **gzipSync / gunzipSync** `[stub-acceptable]` — api: `zlib.gzipSync / zlib.gunzipSync`  
  Produces valid RFC 1952 gzip frames (10-byte header + DEFLATE + CRC32 + ISIZE) using a greedy fixed-Huffman LZ77 DEFLATE. Inflate decodes all three RFC 1951 block types (stored, fixed, dynamic Huffman) so it correctly gunzips real-world server responses. Divergences: (1) opts parameter (level, memLevel, windowBits, strategy, chunkSize) is accepted but silently ignored — output is always fixed-Huffman at a single compression level, so opts.level has no effect; (2) greedy single-pass LZ77 produces larger output than zlib's lazy matching at level >= 2; (3) no FNAME/FCOMMENT/FEXTRA header fields written; (4) large inputs run fully in-memory with no streaming, which can trigger the WASM monotonic-memory size-admission guard. For the common use-case of compress/decompress correctness the output is standards-compliant and interoperable with real Node zlib.  
  *mechanism:* pure-JS shim embedded in the rquickjs engine binary (engine/src/lib.rs:1963-1964); registered as require('zlib') via globalThis.__builtins.zlib (lib.rs:2100)  
  *constraint:* rquickjs WASM has no CompressionStream (workerd-host-only); no sync host round-trip possible; determinism requires no host I/O; 12-WASM-import ceiling prevents a separate zlib WASM module  
  *evidence:* apps/kernel/engine/src/lib.rs:1867-1985, apps/kernel/engine/src/lib.rs:2100
- **deflateSync / inflateSync** `[stub-acceptable]` — api: `zlib.deflateSync / zlib.inflateSync`  
  Produces valid RFC 1950 zlib frames (2-byte CMF+FLG header + DEFLATE body + Adler32 checksum). inflateSync strips the 2-byte header and optional dict id (4 bytes if FDICT set) and delegates to inflateRaw. Same divergences as gzipSync: opts silently ignored, fixed-Huffman only, greedy LZ77. Output is interoperable with Node's zlib.inflateSync.  
  *mechanism:* pure-JS shim at engine/src/lib.rs:1965-1966  
  *constraint:* same as gzipSync: no sync host call, determinism, 12-WASM-import ceiling  
  *evidence:* apps/kernel/engine/src/lib.rs:1965-1966
- **deflateRawSync / inflateRawSync** `[stub-acceptable]` — api: `zlib.deflateRawSync / zlib.inflateRawSync`  
  Raw DEFLATE with no framing header/checksum. Same implementation constraints as deflateSync. inflateRaw handles all three block types. Opts ignored.  
  *mechanism:* pure-JS shim at engine/src/lib.rs:1967-1968  
  *constraint:* same as gzipSync  
  *evidence:* apps/kernel/engine/src/lib.rs:1967-1968
- **unzipSync** `[stub-acceptable]` — api: `zlib.unzipSync`  
  Auto-detects gzip (magic 0x1f 0x8b) and falls back to inflateSync (zlib framing). Correct for the two formats it handles. Does not detect brotli or zstd streams (would throw a misleading inflate error rather than a clear format error).  
  *mechanism:* pure-JS shim at engine/src/lib.rs:1969  
  *constraint:* same as gzipSync  
  *evidence:* apps/kernel/engine/src/lib.rs:1969
- **gzip / gunzip / deflate / inflate / deflateRaw / inflateRaw / unzip (async callback/promise forms)** `[stub-unacceptable]` — api: `zlib.gzip / zlib.gunzip / zlib.deflate / zlib.inflate / zlib.deflateRaw / zlib.inflateRaw / zlib.unzip`  
  Implemented as mkAsync(syncFn): the synchronous codec is called inside a queueMicrotask. There is NO background thread, no streaming, no backpressure. The entire input is held in-memory and the callback fires in the microtask queue, not in a true async I/O callback on the next event-loop tick. For large buffers this blocks the single QuickJS execution thread during compression and can trigger the 24 MB incompressible-heap size-admission guard mid-cell. More critically: Node's async zlib functions accept an AbortSignal and emit progress events; neither is honored here. Code that expects true async chunked processing (e.g. piping large streams through zlib.gzip()) will silently buffer everything and may hit WASM memory limits.  
  *mechanism:* pure-JS shim wrapping sync codec via queueMicrotask; engine/src/lib.rs:1972  
  *constraint:* QuickJS WASM is single-threaded; no real async I/O inside the VM; no Worker threads; determinism  
  *evidence:* apps/kernel/engine/src/lib.rs:1972, apps/kernel/engine/src/lib.rs:1977-1978, apps/kernel/src/kernel-glue.ts (INCOMPRESSIBLE_BUFFER_CEILING_BYTES = 24MB)
- **createGzip / createDeflate / createGunzip / createInflate / createDeflateRaw / createInflateRaw / createUnzip (Transform stream classes)** `[absent]` — api: `zlib.createGzip / zlib.createDeflate / zlib.createGunzip etc.`  
  Not present in the zlib shim object at all. The exported object at lib.rs:1974-1984 contains only the sync/async buffer functions and constants. Any code that does `const gz = zlib.createGzip(); readable.pipe(gz).pipe(writable)` will get `TypeError: zlib.createGzip is not a function`.  
  *mechanism:* not built  
  *constraint:* no blocking reason — the stream module (Readable/Writable/Transform) does exist in the VM; this is a missing implementation, not a hard constraint  
  *evidence:* apps/kernel/engine/src/lib.rs:1974-1984 (exported object has no create* keys)
- **zlib.constants** `[partial]` — api: `zlib.constants`  
  Exports a subset of constants: Z_NO_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH, Z_OK, Z_STREAM_END, Z_BEST_SPEED, Z_BEST_COMPRESSION, Z_DEFAULT_COMPRESSION. Missing: Z_NO_COMPRESSION (0), Z_DEFAULT_LEVEL (-1 alias), Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED, Z_DEFAULT_STRATEGY, all BROTLI_PARAM_* constants, BROTLI_MIN/MAX/DEFAULT_QUALITY, BROTLI_MIN/MAX_WINDOW_BITS, Z_PARTIAL_FLUSH, Z_TREES, Z_BUF_ERROR, Z_STREAM_ERROR, Z_DATA_ERROR, Z_MEM_ERROR. Code that reads specific constants for strategy or error-code checking will get undefined.  
  *mechanism:* hardcoded object literal at engine/src/lib.rs:1983  
  *constraint:* implementation gap, not a hard constraint; opts/strategy are not wired anyway so the constants have no effect even if present  
  *evidence:* apps/kernel/engine/src/lib.rs:1983
- **brotliCompressSync / brotliDecompressSync / brotliCompress / brotliDecompress** `[stub-acceptable]` — api: `zlib.brotliCompressSync / zlib.brotliDecompressSync / zlib.brotliCompress / zlib.brotliDecompress`  
  All four entry points are present and throw/reject with a clear NotSupportedError naming the reason ('pure-JS brotli needs the static dictionary'). This is the correct behavior for an unsupported codec — callers get an actionable error rather than silent data corruption. The message also suggests the alternative (use gzip/deflate). Verdict is stub-acceptable rather than impossible because a Brotli WASM module could in principle be added, but the 12-WASM-import ceiling and bundle-size constraints make it impractical currently.  
  *mechanism:* named stub functions at engine/src/lib.rs:1973, 1979-1981  
  *constraint:* pure-JS Brotli requires the ~120 KB static dictionary embedded in code; 12-WASM-import ceiling prevents a separate Brotli WASM codec; bundle size budget  
  *evidence:* apps/kernel/engine/src/lib.rs:1873-1875, apps/kernel/engine/src/lib.rs:1973, apps/kernel/engine/src/lib.rs:1979-1981
- **zstd (node:zlib zstd* functions — Node v21.7+ experimental)** `[absent]` — api: `zlib.zstdSync / zlib.unzstdSync / zlib.createZstd etc.`  
  No zstd functions are exposed via require('zlib'). The zstd-codec.wasm module that lives at apps/kernel/src/zstd-codec.wasm is a host-side-only codec used exclusively by the kernel-glue snapshot pipeline (kernel-glue.ts zstdCompress/zstdDecompress) and is never injected into the QuickJS VM heap. A user cell cannot call require('zlib').zstdSync. This is also a Node v21.7+ experimental feature, so the divergence matches the stated Node v20 target.  
  *mechanism:* zstd-codec.wasm is host-only (kernel-glue.ts); not wired into __builtins.zlib  
  *constraint:* deliberate: host-side only; also outside Node v20 API surface  
  *evidence:* apps/kernel/src/kernel-glue.ts (zstdCompress/zstdDecompress host functions), apps/kernel/engine/src/lib.rs:1974-1984 (no zstd* in exported object), apps/kernel/src/zstd-codec.wasm (binary present but host-only)
- **compression level / windowBits / memLevel / strategy options** `[stub-unacceptable]` — api: `zlib.gzipSync(buf, {level, windowBits, memLevel, strategy}) etc.`  
  The opts parameter is accepted by the function signatures (gzipSync(data, opts), deflateSync(data, opts)) but is completely ignored — deflateRaw is called unconditionally with no level, strategy, or windowBits parameter. Code that passes opts.level=9 for maximum compression or opts.level=1 for speed will silently receive the same fixed-Huffman output regardless. This is stub-unacceptable because callers relying on opts to trade off size vs. speed (e.g. HTTP response compression pipelines) will get silent divergence: different output sizes, different timing, and interoperability issues with tools that verify compression headers.  
  *mechanism:* opts silently dropped in gzipSync/deflateSync at engine/src/lib.rs:1963,1965; deflateRaw() takes no level parameter  
  *constraint:* pure-JS DEFLATE only implements fixed-Huffman; no multi-strategy engine is wired; implementation gap  
  *evidence:* apps/kernel/engine/src/lib.rs:1963 (gzipSync opts ignored), apps/kernel/engine/src/lib.rs:1965 (deflateSync opts ignored), apps/kernel/engine/src/lib.rs:1921-1961 (deflateRaw: no level/strategy param)
- **CompressionStream / DecompressionStream (WHATWG Streams API)** `[absent]` — api: `global CompressionStream / DecompressionStream (Node v18+ / Web Streams)`  
  CompressionStream/DecompressionStream are workerd-host-only globals and are not available inside the QuickJS VM. The kernel-glue snapshot code uses them on the host side (kernel-glue.ts gzip/gunzip functions use `new CompressionStream('gzip')`), but they are never injected into the VM global scope. A user cell that attempts `new CompressionStream('gzip')` will get ReferenceError.  
  *mechanism:* host-only (workerd built-in); explicitly noted at engine/src/lib.rs:1868  
  *constraint:* rquickjs WASM does not include workerd's WHATWG stream runtime; no mechanism to bridge async WHATWG streams into the synchronous QuickJS VM without a host round-trip  
  *evidence:* apps/kernel/engine/src/lib.rs:1868 ('rquickjs has no CompressionStream (that is workerd-host-only)'), apps/kernel/src/kernel-glue.ts (DecompressionStream used in host gunzip())

### events (EventEmitter, once, on, error semantics)

- **EventEmitter class (constructor, prototype chain)** `[real]` — api: `require('events').EventEmitter / new EventEmitter()`  
  Full prototype: on/addListener/once/off/removeListener/removeAllListeners/prependListener/prependOnceListener/emit/listeners/rawListeners/listenerCount/eventNames/setMaxListeners/getMaxListeners. Registered as both 'events' and 'node:events' via the node:-alias loop at lib.rs:2161. EventEmitter.EventEmitter self-alias present (lib.rs:1546). No divergence for common usage.  
  *mechanism:* pure-JS shim baked into the engine bootstrap string (lib.rs:1519-1548), snapshotted into the QuickJS heap on create, survives cold-restore  
  *constraint:* none — pure in-VM JS, no host calls needed  
  *evidence:* apps/kernel/engine/src/lib.rs:1519-1548, apps/kernel/engine/src/lib.rs:2104, apps/kernel/engine/src/lib.rs:2161
- **instance.on / addListener** `[real]` — api: `emitter.on(event, listener) / emitter.addListener(event, listener)`  
  Appends to a per-key array stored on `this._e`. Fires 'newListener' if a listener for 'newListener' is already registered (lib.rs:1526). Returns `this` for chaining. Identical to Node semantics for ordinary use. 'newListener' event is emitted on `.on()` only (not `.once()`, `.prependListener()`, `.prependOnceListener()`) — that diverges from Node which fires 'newListener' for all four methods.  
  *mechanism:* pure-JS shim  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1526-1527
- **instance.once** `[real]` — api: `emitter.once(event, listener)`  
  Wraps listener in a one-shot guard (sets g.listener = f for rawListeners/removeListener identity). Correct: removeListener with the original fn unwraps via g.listener (lib.rs:1531). Matches Node semantics.  
  *mechanism:* pure-JS shim  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1529
- **instance.emit** `[real]` — api: `emitter.emit(event, ...args)`  
  Calls listeners synchronously in registration order (via ls.slice().forEach). Unhandled 'error' event throws the Error or wraps a non-Error (lib.rs:1534). Returns true/false. Matches Node semantics for synchronous dispatch.  
  *mechanism:* pure-JS shim  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1534
- **instance.removeListener / off** `[real]` — api: `emitter.removeListener(event, listener) / emitter.off(event, listener)`  
  Correctly unwraps once-wrapped listeners via g.listener identity check (lib.rs:1531). Deletes the key when array empties. Matches Node behavior.  
  *mechanism:* pure-JS shim  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1531-1532
- **instance.removeAllListeners** `[real]` — api: `emitter.removeAllListeners([event])`  
  No 'removeListener' event is fired (Node fires it for each removed listener). Benign for almost all usage.  
  *mechanism:* pure-JS shim  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1533
- **prependListener / prependOnceListener** `[real]` — api: `emitter.prependListener / emitter.prependOnceListener`  
  Unshift to front of listener array. 'newListener' is NOT fired for prepend variants (only for .on()). Diverges from Node which also fires 'newListener' for prepend variants. Unlikely to matter in practice.  
  *mechanism:* pure-JS shim  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1528, apps/kernel/engine/src/lib.rs:1530
- **listeners / rawListeners / listenerCount / eventNames** `[real]` — api: `emitter.listeners() / rawListeners() / listenerCount() / eventNames()`  
  listeners() unwraps once-wrappers via g.listener (Node compat). rawListeners() returns wrapped fns. listenerCount() counts array length. eventNames() returns Object.keys. All match Node semantics.  
  *mechanism:* pure-JS shim  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1535-1538
- **setMaxListeners / getMaxListeners (instance)** `[stub-acceptable]` — api: `emitter.setMaxListeners(n) / emitter.getMaxListeners()`  
  setMaxListeners stores n in this._max; getMaxListeners returns it. The max-listeners WARNING (the 'MaxListenersExceededWarning' on process) is NEVER emitted — no enforcement at all. For real code that uses setMaxListeners to suppress a legitimate warning (e.g. passing an AbortSignal to many fns), absence of the warning is benign. Code that relies on the warning to detect leaks silently gets no signal.  
  *mechanism:* pure-JS shim — stores value but never enforces  
  *constraint:* no process warning channel that is actually live in the sandbox; process.on('warning') listeners are stored but never fired by the runtime  
  *evidence:* apps/kernel/engine/src/lib.rs:1539-1540, apps/kernel/engine/src/lib.rs:835-837
- **EventEmitter.defaultMaxListeners (static)** `[stub-acceptable]` — api: `EventEmitter.defaultMaxListeners`  
  Set to 10 (lib.rs:1545) but never read by the emit/on path — the limit is never enforced globally either. Same benign non-enforcement as instance setMaxListeners.  
  *mechanism:* pure-JS shim  
  *constraint:* same as instance setMaxListeners  
  *evidence:* apps/kernel/engine/src/lib.rs:1545
- **EventEmitter.once (static) — Promise form** `[real]` — api: `EventEmitter.once(emitter, event) -> Promise`  
  Returns a Promise that resolves to the args array on the first event, or rejects on 'error'. Correctly cross-wires the error listener cleanup (lib.rs:1543). Matches Node v12+ semantics. No AbortSignal option (Node v15+) — that option is absent.  
  *mechanism:* pure-JS shim  
  *constraint:* none for the base form; AbortSignal option absent  
  *evidence:* apps/kernel/engine/src/lib.rs:1543
- **EventEmitter.listenerCount (static, deprecated)** `[real]` — api: `EventEmitter.listenerCount(emitter, event)`  
  Delegates to emitter.listenerCount(). Exact Node semantics.  
  *mechanism:* pure-JS shim  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1544
- **events.on (static async-generator / async-iterator form)** `[absent]` — api: `events.on(emitter, event[, options]) -> AsyncIterator (Node v13.6+)`  
  Not present on __events (lib.rs:1519-1548 — only once/listenerCount/defaultMaxListeners/EventEmitter on the constructor). Code that does `for await (const [v] of events.on(emitter, 'data'))` will throw TypeError at runtime.  
  *mechanism:* not built  
  *constraint:* none architectural — pure JS is possible; simply not implemented  
  *evidence:* apps/kernel/engine/src/lib.rs:1519-1548
- **EventEmitter.setMaxListeners (static, Node v15+)** `[absent]` — api: `EventEmitter.setMaxListeners(n, ...emitters)`  
  The static form (sets limit on multiple emitters at once, used by AbortController/AbortSignal fan-out patterns) is not on the constructor. Calling it throws TypeError. Code that does `events.setMaxListeners(20, signal)` to suppress AbortSignal-fan-out warnings will crash.  
  *mechanism:* not built  
  *constraint:* none architectural  
  *evidence:* apps/kernel/engine/src/lib.rs:1519-1548
- **EventEmitter.getEventListeners (static, Node v22+)** `[absent]` — api: `EventEmitter.getEventListeners(emitter, event)`  
  Not on the constructor. Less commonly used; code that introspects via this static will crash.  
  *mechanism:* not built  
  *constraint:* none architectural  
  *evidence:* apps/kernel/engine/src/lib.rs:1519-1548
- **EventEmitter.addAbortListener (static, Node v20+)** `[absent]` — api: `EventEmitter.addAbortListener(signal, listener)`  
  Not implemented. Code that relies on this helper for AbortSignal-driven teardown will crash.  
  *mechanism:* not built  
  *constraint:* none architectural; AbortSignal/AbortController are present in the global scope  
  *evidence:* apps/kernel/engine/src/lib.rs:1519-1548
- **captureRejections / captureRejectionSymbol** `[absent]` — api: `EventEmitter.captureRejections / Symbol.for('nodejs.rejection')`  
  captureRejections static and instance property are not implemented. In Node, if an async listener rejects and captureRejections=true, the rejection is re-emitted on the emitter as 'error'. Without it, an async listener that rejects silently swallows the rejection — code that relies on this for error routing will silently lose errors.  
  *mechanism:* not built; would require wrapping every listener invocation to catch async returns  
  *constraint:* none architectural — implementable in pure JS; just not built  
  *evidence:* apps/kernel/engine/src/lib.rs:1519-1548
- **errorMonitor symbol** `[absent]` — api: `EventEmitter.errorMonitor (Symbol, Node v13.6+)`  
  Not exported. Middleware-style error observers registered via errorMonitor will not fire. Since errorMonitor is for observing before the throw, its absence means monitoring-first patterns silently fall back to normal error semantics. Uncommon in library code.  
  *mechanism:* not built  
  *constraint:* none architectural  
  *evidence:* apps/kernel/engine/src/lib.rs:1519-1548
- **process.on / process.once for lifecycle events (exit, uncaughtException, unhandledRejection)** `[stub-unacceptable]` — api: `process.on('exit', fn) / process.on('uncaughtException', fn) / process.on('unhandledRejection', fn)`  
  process has a custom EventEmitter-ish .on/.once/.emit/.off implementation (lib.rs:838-848). Listeners ARE stored. But the runtime NEVER fires them (lib.rs:835-837: 'NOT auto-fired by the runtime'). process.exit() throws a catchable ProcessExit error — it does NOT fire 'exit' listeners before throwing. Unhandled promise rejections are NOT routed through 'unhandledRejection'. Code that registers cleanup handlers via process.on('exit') or safety nets via process.on('uncaughtException') will see them silently not invoked. This is a real semantic trap for library teardown code.  
  *mechanism:* custom object-based event store; stored but never automatically dispatched by the engine or host  
  *constraint:* QuickJS engine's lifecycle hooks are not exposed through rquickjs to the host glue; there is no 'before exit' or unhandled-rejection callback wired between the Rust eval loop and the process shim  
  *evidence:* apps/kernel/engine/src/lib.rs:835-848, apps/kernel/engine/src/lib.rs:830-831
- **process.on('warning') / process.emitWarning** `[stub-unacceptable]` — api: `process.on('warning', fn) / process.emitWarning(msg)`  
  process.emitWarning writes to console.warn (lib.rs:850) — it does NOT emit on process as an event. process.on('warning', fn) stores the listener (via the same stub registry) but that listener is NEVER called, even when emitWarning is invoked. Code that monitors warnings via process.on('warning') will see nothing.  
  *mechanism:* emitWarning -> console.warn only; process event bus not wired  
  *constraint:* same as process lifecycle events — no wiring between emitWarning and the stored listeners  
  *evidence:* apps/kernel/engine/src/lib.rs:847-850
- **Stream classes inherit EventEmitter (Readable/Writable/Duplex/Transform/PassThrough)** `[real]` — api: `stream.Readable, stream.Writable, etc — EventEmitter base`  
  All stream classes call EventEmitter.call(this) and setPrototypeOf to EventEmitter.prototype (lib.rs:1725-1788). 'data'/'end'/'error'/'finish'/'close'/'drain' events all wired. net.Socket (net.js shim) extends Duplex the same way. EventEmitter inheritance is correct.  
  *mechanism:* pure-JS shim — __stream receives __events as its constructor argument (lib.rs:1724, 1788)  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1724-1788, apps/kernel/stdlib-src/shims/net.js:207
- **http.ClientRequest / http.IncomingMessage inherit EventEmitter** `[real]` — api: `http.ClientRequest ('response'/'error' events), http.IncomingMessage ('data'/'end'/'error' events)`  
  Both functions call EventEmitter.call(this) and setPrototypeOf to EventEmitter.prototype (lib.rs:2043-2052). EventEmitter event machinery works on these objects. Response body is a pull-on-host-call Readable; 'data'/'end' events fire through the Readable flow machinery.  
  *mechanism:* pure-JS shim  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:2043-2052
- **EventTarget / Event / CustomEvent (Web-events API)** `[partial]` — api: `EventTarget, Event, CustomEvent (also exposed by Node v15+ as globals)`  
  Minimal synchronous-dispatch shim installed at lib.rs:317-332. addEventListener/removeEventListener/dispatchEvent are present. Missing: event propagation (bubbles/capture phase — stopPropagation is a no-op), the AbortSignal-as-EventTarget integration, and once/signal options on addEventListener. Sufficient for simple custom emitters; breaks code that depends on capture-phase or once-option.  
  *mechanism:* pure-JS shim installed in the WASM engine bootstrap  
  *constraint:* no DOM tree — bubbling/capture model is inherently vacuous in a non-DOM context; once-option omitted  
  *evidence:* apps/kernel/engine/src/lib.rs:317-332
- **Async listeners and unhandled Promise rejections from emit()** `[stub-unacceptable]` — api: `async listener rejection routing (captureRejections=true path in Node)`  
  emit() calls listeners synchronously via forEach. If a listener is async and throws/rejects, the rejection is an unhandled Promise rejection in the QuickJS micro-task queue — it silently disappears (no 'unhandledRejection', no captureRejections re-emit on the emitter). In Node without captureRejections, the same rejection goes to 'unhandledRejection' on process. In engram, neither path works — the rejection is swallowed. Any async event handler whose rejection must propagate to an 'error' listener will silently fail.  
  *mechanism:* synchronous listener dispatch with no async return handling  
  *constraint:* QuickJS does not expose an unhandled-rejection callback into the Rust engine; rquickjs does not surface it to the host glue in a way that is plumbed back to the process shim  
  *evidence:* apps/kernel/engine/src/lib.rs:1534, apps/kernel/engine/src/lib.rs:835-837
- **require('events') module identity / instanceof across modules** `[real]` — api: `require('events').EventEmitter instanceof checks across separate require() calls`  
  Both 'events' and 'node:events' resolve to the SAME __events object (registered once in __builtins, aliased via the node: loop at lib.rs:2161). require('events').EventEmitter === require('node:events').EventEmitter is true. instanceof checks across modules work correctly.  
  *mechanism:* single shared __builtins object; aliased by reference  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:2104, apps/kernel/engine/src/lib.rs:2161

### path / url / querystring (URL/URLSearchParams)

- **path.join / path.normalize / path.dirname / path.basename / path.extname / path.isAbsolute / path.resolve / path.relative / path.parse / path.format** `[real]` — api: `node:path (POSIX subset)`  
  Pure-JS POSIX implementation covering the full function set. sep='/', delimiter=':'. Semantics match Node's path.posix exactly. No platform divergence on a POSIX-only system.  
  *mechanism:* pure-JS shim evaluated into the QuickJS heap at bootstrap (lib.rs:1679–1696); registered as require('path') and require('node:path').  
  *constraint:* WASM/CF substrate has no OS path layer; pure-JS is the only option and is fully sufficient for POSIX semantics.  
  *evidence:* apps/kernel/engine/src/lib.rs:1679-1696, apps/kernel/engine/src/lib.rs:2106, apps/kernel/engine/src/lib.rs:2161
- **path.win32** `[stub-unacceptable]` — api: `node:path (win32 sub-object)`  
  path.win32 is aliased to the POSIX object (posix.win32 = posix). sep is '/' not '\\', delimiter is ':' not ';'. Any code doing path.win32.join('C:\\foo','bar') or testing path.sep === '\\' will get wrong results silently. No path/win32 alias is registered as a separate require() entry — require('path/win32') will fall through to the same posix object via the __builtins alias expansion.  
  *mechanism:* pure-JS alias: posix.win32 = posix at lib.rs:1694. No separate node:path/win32 entry in __builtins.  
  *constraint:* WASM on Linux CF workers; Windows path semantics are meaningless on the runtime but the alias is a silent wrong-answer trap for cross-platform code.  
  *evidence:* apps/kernel/engine/src/lib.rs:1694, apps/kernel/engine/src/lib.rs:2159-2166
- **path.posix / path/posix** `[real]` — api: `node:path/posix`  
  path.posix === path (same object). require('path/posix') and require('node:path/posix') both work and return the POSIX implementation.  
  *mechanism:* pure-JS shim; require aliases registered at lib.rs:2166.  
  *constraint:* None — pure-JS shim with no CF-specific constraint.  
  *evidence:* apps/kernel/engine/src/lib.rs:1693, apps/kernel/engine/src/lib.rs:2166
- **globalThis.URL (WHATWG URL constructor — parsing)** `[partial]` — api: `WHATWG URL (globalThis.URL)`  
  Installed as a pure-JS fallback polyfill guarded by typeof globalThis.URL === 'undefined'. If the Tier-0 C extension (quickjs-wasi .so) already provided URL, the polyfill is skipped. Comment at lib.rs:380 says 'rquickjs ships no … URL' and 'we install pure-JS polyfills'. The polyfill is an RFC-3986-ish regex parser (lib.rs:462). MISSING from the polyfill: (1) all property SETTERS — hostname, pathname, search, hash, username, password, protocol, port are plain data properties set at construction; mutating them does NOT update href or other dependent properties; (2) URL.searchParams is not live-synced — mutating searchParams._l does not update url.search and vice-versa; (3) IPv6 bracket stripping in hostname; (4) percent-encoding normalization of pathname/search; (5) opaque-origin handling; (6) file:// host handling. URL.canParse is present. toString() uses searchParams._l if non-empty, falls back to stored this.search — so a mutated searchParams.set() will appear in toString() but url.search stays stale.  
  *mechanism:* pure-JS fallback polyfill in QuickJS heap (lib.rs:458–490); registered as a global, also re-exported by require('url').URL.  
  *constraint:* rquickjs has no native WHATWG URL; quickjs-wasi Tier-0 C extension could provide it but the polyfill guard means it only runs if the native is absent — actual runtime behavior depends on whether the .so was successfully loaded.  
  *evidence:* apps/kernel/engine/src/lib.rs:380-384, apps/kernel/engine/src/lib.rs:458-490, apps/kernel/engine/src/lib.rs:2024
- **globalThis.URLSearchParams** `[partial]` — api: `WHATWG URLSearchParams (globalThis.URLSearchParams)`  
  Pure-JS polyfill (same Tier-0 guard). Implements: append, set, get, getAll, has, delete, forEach, keys, values, entries, [Symbol.iterator], sort, toString, size (getter). MISSING: (1) USP constructor from iterable of non-array iterables; (2) the USP._l array is exposed as a public property — instanceof checks fail against native; (3) URL.searchParams is NOT live-linked to url.search — mutating url.search directly does not update searchParams, and vice versa unless toString() is called (which uses _l). The __enc helper uses encodeURIComponent + replaces %20 with '+', matching application/x-www-form-urlencoded. No deviation for RFC-3986 percent-encoding in non-form contexts.  
  *mechanism:* pure-JS polyfill in QuickJS heap (lib.rs:427–456).  
  *constraint:* rquickjs has no native WHATWG URLSearchParams; no WASM import needed.  
  *evidence:* apps/kernel/engine/src/lib.rs:427-456, apps/kernel/engine/src/lib.rs:481-485
- **url.parse / url.format / url.resolve (legacy Node url module)** `[real]` — api: `require('url').parse / .format / .resolve`  
  parse() returns a Url object with all standard fields (protocol/slashes/auth/host/port/hostname/hash/search/query/pathname/path/href). Delegates parseQueryString=true path to querystring.parse. format() round-trips correctly including auth+search+hash. resolve() delegates to new URL(to, from) internally — so shares the polyfill URL limitations for edge cases (malformed relative refs). These APIs are deprecated in Node but widely used; semantics match Node for the common cases.  
  *mechanism:* pure-JS shim at lib.rs:1989–2025, registered as require('url').  
  *constraint:* None specific — pure-JS.  
  *evidence:* apps/kernel/engine/src/lib.rs:1987-2025, apps/kernel/engine/src/lib.rs:2101
- **url.fileURLToPath** `[stub-unacceptable]` — api: `require('url').fileURLToPath`  
  Implementation is: s.replace(/^file:\/\//, '') || '/'. This does NOT decode percent-encoded characters in the path (e.g. file:///foo%20bar becomes /foo%20bar not /foo bar). Also does not strip the authority component when present (file://localhost/foo → /localhost/foo not /foo). Any code using fileURLToPath for real file:// URLs produced by import.meta.url or pathToFileURL will get paths with literal percent-sequences.  
  *mechanism:* pure-JS shim at lib.rs:2021.  
  *constraint:* No constraint prevents a correct implementation; it is just incomplete.  
  *evidence:* apps/kernel/engine/src/lib.rs:2021
- **url.pathToFileURL** `[stub-acceptable]` — api: `require('url').pathToFileURL`  
  Returns new URL('file://' + path). Works correctly for simple POSIX absolute paths. Does not percent-encode spaces or special characters in the path before constructing the URL, so roundtripping through pathToFileURL → fileURLToPath with a path containing spaces will fail. Fine for the typical use in import() resolution where paths are already clean.  
  *mechanism:* pure-JS shim at lib.rs:2022.  
  *constraint:* None.  
  *evidence:* apps/kernel/engine/src/lib.rs:2022
- **url.domainToASCII / url.domainToUnicode** `[stub-unacceptable]` — api: `require('url').domainToASCII / .domainToUnicode`  
  Both are identity functions: function(d){ return String(d); }. No punycode/IDNA encoding. IDN hostnames (e.g. 'bücher.de') will not be converted to ACE ('xn--bcher-kva.de'). Any code relying on these for internationalized domain name handling will silently get the wrong hostname.  
  *mechanism:* pure-JS stub at lib.rs:2024. No ICU or punycode library available in the VM.  
  *constraint:* ICU/punycode requires either a native C library or a non-trivial pure-JS implementation (~7KB). Not built; absent by design.  
  *evidence:* apps/kernel/engine/src/lib.rs:2024
- **url.urlToHttpOptions** `[real]` — api: `require('url').urlToHttpOptions`  
  Returns the expected {protocol, hostname, port, path, hash, search, href, auth} shape. hostname strips IPv6 brackets. Used internally by http/https shim for URL→options conversion.  
  *mechanism:* pure-JS shim at lib.rs:2023.  
  *constraint:* None.  
  *evidence:* apps/kernel/engine/src/lib.rs:2023, apps/kernel/engine/src/lib.rs:2036
- **URL.createObjectURL / URL.revokeObjectURL** `[absent]` — api: `URL.createObjectURL / URL.revokeObjectURL`  
  Not provided. These require a blob registry tied to a browsing context or runtime. Not relevant to a REPL kernel; rarely used in Node either.  
  *mechanism:* Not implemented anywhere in lib.rs.  
  *constraint:* No blob URL registry in the WASM kernel; no browsing context. Not a Node standard API either.  
  *evidence:* apps/kernel/engine/src/lib.rs:458-490
- **querystring.parse / querystring.stringify** `[real]` — api: `require('querystring').parse / .stringify`  
  parse(): splits on sep ('&'), eq ('='), unescapes with decodeURIComponent+'+'-as-space, accumulates duplicate keys as arrays. stringify(): encodes with encodeURIComponent. encode and decode are aliases for stringify and parse respectively (same as Node). DIVERGENCE: Node's parse() accepts a maxKeys option to cap the number of keys parsed — this shim has no maxKeys support. Node's stringify() also accepts an encodeURIComponent option to override the encoder — also absent. For normal use (no maxKeys limit needed, default separators) the behaviour is identical.  
  *mechanism:* pure-JS shim at lib.rs:1698–1705, registered as require('querystring') and require('node:querystring').  
  *constraint:* None. The divergences are missing options, not impossible features.  
  *evidence:* apps/kernel/engine/src/lib.rs:1698-1705, apps/kernel/engine/src/lib.rs:2109, apps/kernel/engine/src/lib.rs:2161
- **querystring.escape / querystring.unescape** `[real]` — api: `require('querystring').escape / .unescape`  
  escape = encodeURIComponent; unescape = decodeURIComponent with '+' substitution. Matches Node defaults. Node allows overriding querystring.escape/unescape globally; that pattern works here too since the shim references the exported functions, not closures.  
  *mechanism:* pure-JS shim at lib.rs:1700–1701.  
  *constraint:* None.  
  *evidence:* apps/kernel/engine/src/lib.rs:1700-1701
- **URL mutable property setters (href=, hostname=, pathname=, search=, hash=, port=, protocol=, username=, password=)** `[stub-unacceptable]` — api: `WHATWG URL property setters`  
  The pure-JS URL polyfill sets all fields as plain data properties in the constructor. There are no defineProperty setters. Doing url.hostname = 'new.host' silently overwrites the data property but does NOT update url.href, url.host, url.origin, or url.search. Code that builds URLs by mutation (common pattern: const u = new URL(base); u.searchParams.set('k','v')) will fail silently — searchParams.set() updates _l but url.search is stale, and url.href is never recomputed. The toString() method does re-read searchParams._l to produce the query string, so toString()/href-via-toString works for searchParams mutations only, but not for direct property assignment.  
  *mechanism:* pure-JS polyfill with no setter defineProperty at lib.rs:458–490.  
  *constraint:* No technical barrier; a correct implementation would need Object.defineProperty setters that re-serialize href. Not built.  
  *evidence:* apps/kernel/engine/src/lib.rs:458-490, apps/kernel/engine/src/lib.rs:483-486

### util (promisify/inspect/types/TextEncoder/TextDecoder) / os / assert

- **util.inspect** `[stub-unacceptable]` — api: `util.inspect(value, opts)`  
  Only the `depth` option is honoured; all other options (`colors`, `compact`, `breakLength`, `showHidden`, `sorted`, `getters`, `numericSeparator`, `maxArrayLength`, `maxStringLength`) are silently ignored. Output does not include ANSI color codes so any code that passes `{colors:true}` and then strips/parses ANSI will get wrong results. Symbol-keyed own properties are not rendered. Custom `[util.inspect.custom]` / `Symbol.for('nodejs.util.inspect.custom')` methods are not called.  
  *mechanism:* pure-JS shim: wraps globalThis.__preview, which is a bespoke depth-limited renderer defined at engine/src/lib.rs:2699  
  *constraint:* bare QuickJS heap — no V8 inspector protocol; no ANSI terminal; __preview was built for value-preview UX, not full Node inspect semantics  
  *evidence:* apps/kernel/engine/src/lib.rs:1552 (inspect calls __preview, extracts only depth), apps/kernel/engine/src/lib.rs:2699 (__preview implementation — no color, no custom symbol, no showHidden)
- **util.format / util.formatWithOptions** `[stub-acceptable]` — api: `util.format(fmt, ...args) / util.formatWithOptions(opts, fmt, ...args)`  
  Handles %s/%d/%i/%f/%o/%O/%j/%% substitutions and tail arguments. %i and %f are present. formatWithOptions exists and threads opts through to inspect. Missing: %c (CSS, silently ignored in Node too), width/precision modifiers. Close enough for logging use-cases.  
  *mechanism:* pure-JS shim inside the __util IIFE at engine/src/lib.rs:1554  
  *constraint:* none — this is a pure-JS shim; existing behaviour is a deliberate scope limit  
  *evidence:* apps/kernel/engine/src/lib.rs:1554-1574 (formatWithOptions + format implementation)
- **util.promisify / util.promisify.custom** `[real]` — api: `util.promisify(fn)`  
  Checks `f.__promisify_custom` first (the standard escape hatch), then wraps callback-last convention. `promisify.custom` is `Symbol.for('nodejs.util.promisify.custom')` — the canonical symbol. Semantically equivalent to Node for the common case.  
  *mechanism:* pure-JS shim at engine/src/lib.rs:1594  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1594-1595 (promisify + promisify.custom)
- **util.callbackify** `[real]` — api: `util.callbackify(fn)`  
  Correctly wraps async fn to callback-last style; handles null/undefined rejection value per Node spec (wraps in new Error). Semantically equivalent.  
  *mechanism:* pure-JS shim at engine/src/lib.rs:1596  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1596 (callbackify)
- **util.inherits** `[real]` — api: `util.inherits(constructor, superConstructor)`  
  Sets `constructor.super_` and delegates to `Object.setPrototypeOf(c.prototype, p.prototype)`, which is exactly what Node does internally.  
  *mechanism:* pure-JS shim at engine/src/lib.rs:1597  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1597 (inherits)
- **util.deprecate** `[stub-acceptable]` — api: `util.deprecate(fn, message)`  
  Emits a console.warn on first call (no `--no-deprecation` flag, no `DEP00xx` codes, no process.emitWarning). Benign for library use.  
  *mechanism:* pure-JS shim at engine/src/lib.rs:1598  
  *constraint:* no process.emitWarning, no CLI flags in a WASM kernel  
  *evidence:* apps/kernel/engine/src/lib.rs:1598 (deprecate)
- **util.debuglog** `[stub-acceptable]` — api: `util.debuglog(section)`  
  Returns a no-op function unconditionally. Any `NODE_DEBUG=...` checks will silently produce no output. This is harmless for library code that only logs in dev; it would silently swallow debug output a developer expects.  
  *mechanism:* pure-JS stub at engine/src/lib.rs:1602  
  *constraint:* no process.env.NODE_DEBUG in the WASM kernel (env surface is host-configured, not shell environment)  
  *evidence:* apps/kernel/engine/src/lib.rs:1602 (debuglog: function(){ return function(){}; })
- **util.isDeepStrictEqual** `[stub-unacceptable]` — api: `util.isDeepStrictEqual(a, b)`  
  Delegates to __deepEqual which uses `Object.keys()` for own enumerable string keys only — Symbol-keyed own properties are NOT compared. Node's `isDeepStrictEqual` does compare own Symbol-keyed properties. Any code that relies on Symbol-keyed property equality (common in well-typed library code) will get false positives.  
  *mechanism:* pure-JS shim via globalThis.__deepEqual at engine/src/lib.rs:1612  
  *constraint:* deliberate scope limit in the shim; Symbol keys require `Object.getOwnPropertySymbols()` which is available in QuickJS but not used  
  *evidence:* apps/kernel/engine/src/lib.rs:1593 (isDeepStrictEqual delegates to __deepEqual), apps/kernel/engine/src/lib.rs:1636 (__deepEqual uses Object.keys(a) — string-keyed only)
- **util.types (isTypedArray / isDate / isRegExp / isMap / isSet / isPromise / isAsyncFunction / isArrayBuffer / isDataView / isProxy / isNativeError / isBoxedPrimitive / isWeakMap / isWeakSet / isUint8Array)** `[partial]` — api: `util.types.*`  
  The listed predicates are implemented as pure instanceof / constructor checks. Missing from the shim: isGeneratorFunction, isGeneratorObject, isModuleNamespaceObject, isSharedArrayBuffer, isExternal, isNumberObject, isStringObject, isBooleanObject, isBigInt64Array, isFloat32Array, isFloat64Array, isInt8Array/Int16Array/Int32Array, isUint8ClampedArray, isUint16Array/Uint32Array, isBigUint64Array. isProxy always returns false (QuickJS exposes no Proxy introspection). Code doing exhaustive typed-array type detection will fail silently.  
  *mechanism:* pure-JS shim at engine/src/lib.rs:1575  
  *constraint:* QuickJS has no Proxy introspection API; remaining gaps are pure scope omissions  
  *evidence:* apps/kernel/engine/src/lib.rs:1575-1591 (types object — exhaustive list of what IS present)
- **util.parseArgs** `[absent]` — api: `util.parseArgs(config) — added Node 18.3`  
  Not present in the __util object. Code using it will get TypeError: util.parseArgs is not a function.  
  *mechanism:* not implemented  
  *constraint:* pure scope omission — no fundamental barrier  
  *evidence:* apps/kernel/engine/src/lib.rs:1600-1605 (return block of __util — parseArgs not listed)
- **util.styleText** `[absent]` — api: `util.styleText(format, text) — added Node 21.7 / backported 20.12`  
  Not present. Code using it throws TypeError.  
  *mechanism:* not implemented; ANSI output also meaningless without a real TTY  
  *constraint:* no ANSI TTY in a WASM kernel; pure scope omission  
  *evidence:* apps/kernel/engine/src/lib.rs:1600-1605 (return block of __util — styleText not listed)
- **util.MIMEType / util.MIMEParams** `[absent]` — api: `util.MIMEType (added Node 19 / stable 21)`  
  Not present.  
  *mechanism:* not implemented  
  *constraint:* pure scope omission  
  *evidence:* apps/kernel/engine/src/lib.rs:1600-1605 (return block — MIMEType not listed)
- **util.getSystemErrorName / util.getSystemErrorMap** `[absent]` — api: `util.getSystemErrorName(errno)`  
  Not present. No POSIX errno table in the WASM kernel.  
  *mechanism:* not implemented; no libuv errno mapping exists in QuickJS-WASM  
  *constraint:* no POSIX syscall layer — impossible to provide accurate errno names  
  *evidence:* apps/kernel/engine/src/lib.rs:1600-1605 (return block — not listed)
- **TextEncoder (global + util.TextEncoder)** `[stub-acceptable]` — api: `TextEncoder (WHATWG Encoding; also re-exported from util)`  
  Pure-JS UTF-8 encoder. encode() and encodeInto() are implemented. Only UTF-8 is supported (constructor ignores the label argument). Node's TextEncoder also only supports UTF-8 (the spec mandates it), so this is acceptable. Exposed as both globalThis.TextEncoder and util.TextEncoder.  
  *mechanism:* pure-JS shim at engine/src/lib.rs:386; re-exported via util at engine/src/lib.rs:1603  
  *constraint:* quickjs-wasi encoding.so native ext is available but the pure-JS fallback is used (check at line 386: only installs if typeof globalThis.TextEncoder === 'undefined')  
  *evidence:* apps/kernel/engine/src/lib.rs:386-408 (TextEncoder pure-JS shim), apps/kernel/engine/src/lib.rs:1603 (util re-exports globalThis.TextEncoder)
- **TextDecoder (global + util.TextDecoder)** `[stub-unacceptable]` — api: `TextDecoder (WHATWG Encoding)`  
  Pure-JS UTF-8 decoder only. The constructor accepts a `label` argument and stores it in `this.encoding` but always decodes as UTF-8 regardless. In Node, TextDecoder supports all WHATWG-specified encodings (latin-1, UTF-16LE, GBK, etc.) via ICU. Code that passes 'latin1', 'utf-16le', 'windows-1252', etc. will silently produce garbled output instead of throwing or decoding correctly. Also missing: `fatal` mode (malformed bytes are silently replaced rather than throwing), `ignoreBOM` option.  
  *mechanism:* pure-JS shim at engine/src/lib.rs:409; re-exported via util at engine/src/lib.rs:1603  
  *constraint:* no ICU in QuickJS-WASM build; multi-encoding support would require bundling a full encoding table  
  *evidence:* apps/kernel/engine/src/lib.rs:409-426 (TextDecoder — label stored but never consulted), apps/kernel/engine/src/lib.rs:1603 (util re-exports globalThis.TextDecoder)
- **os.platform / os.arch / os.type / os.release / os.hostname / os.EOL / os.homedir / os.tmpdir** `[stub-acceptable]` — api: `os module — identity/environment constants`  
  All return hardcoded deterministic constants: platform='engram', arch='wasm', type='Engram', release='0.0.0', hostname='engram', EOL='\n', homedir='/', tmpdir='/tmp'. Code that only uses these for routing decisions (e.g., pick path separator, pick line ending) will work. Code that expects a real OS name or hostname will get wrong values — acceptable since the kernel explicitly documents itself as not real Node.  
  *mechanism:* pure-JS inline object in the builtins map at engine/src/lib.rs:2111  
  *constraint:* no OS syscalls in a WASM/CF isolate; determinism requirement forbids real hostname  
  *evidence:* apps/kernel/engine/src/lib.rs:2111 (os inline object — full definition on one line)
- **os.cpus / os.totalmem / os.freemem / os.uptime** `[stub-unacceptable]` — api: `os.cpus() / os.totalmem() / os.freemem() / os.uptime()`  
  cpus() returns [] (empty array). totalmem/freemem return 0. uptime returns 0. Code that uses these to size work queues, detect CPU count for parallelism, or check available memory before allocation will silently get wrong answers (e.g., Worker pool sized to 0, memory-availability check always fails). These are commonly used by production libraries (e.g., cluster, workerpool, os-utils).  
  *mechanism:* hardcoded stubs in the inline os object at engine/src/lib.rs:2111  
  *constraint:* no POSIX sysinfo in a WASM isolate; Cloudflare Workers have no exposed CPU/memory metrics API  
  *evidence:* apps/kernel/engine/src/lib.rs:2111 (cpus: function(){ return []; }, totalmem: function(){ return 0; }, freemem: function(){ return 0; }, uptime: function(){ return 0; })
- **os.endianness** `[stub-acceptable]` — api: `os.endianness()`  
  Always returns 'LE'. WASM is inherently little-endian (DataView operations default to big-endian but the underlying spec treats linear memory as LE). Real CF/x86 hardware is also LE so this is correct for all current targets.  
  *mechanism:* hardcoded constant in the inline os object at engine/src/lib.rs:2111  
  *constraint:* WASM linear memory is little-endian by spec  
  *evidence:* apps/kernel/engine/src/lib.rs:2111 (endianness: function(){ return 'LE'; })
- **os.networkInterfaces / os.userInfo / os.setPriority / os.getPriority / os.availableParallelism / os.machine / os.version / os.constants / os.loadavg / os.devNull** `[absent]` — api: `os module — system introspection APIs added variously in Node 6–20`  
  None of these are in the os shim object. Calling them throws TypeError: os.X is not a function. networkInterfaces and userInfo are commonly used by deployment/networking code; availableParallelism by concurrency libraries. Silent TypeError is the failure mode.  
  *mechanism:* not implemented  
  *constraint:* no POSIX network/user/priority interfaces in a WASM/CF isolate; impossible for networkInterfaces, userInfo, setPriority/getPriority; others are pure scope omissions  
  *evidence:* apps/kernel/engine/src/lib.rs:2111 (os object — exhaustive list of what IS present, none of these appear)
- **assert (ok / equal / strictEqual / notEqual / notStrictEqual / fail / ifError / throws / doesNotThrow / rejects / doesNotReject / match / doesNotMatch)** `[real]` — api: `assert module`  
  All standard assert methods are present and semantically correct. AssertionError carries `.actual`, `.expected`, `.operator`, `.code='ERR_ASSERTION'`, `.generatedMessage`. throws/doesNotThrow handle Error subclass, RegExp, and object-shape matchers. rejects/doesNotReject return a Promise. assert.strict is an alias to the full assert object (Node does the same — strict mode just makes deepEqual behave like deepStrictEqual, which this shim already does via the same __deepEqual).  
  *mechanism:* pure-JS shim (__assert IIFE) at engine/src/lib.rs:1644  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:1644-1676 (full __assert implementation)
- **assert.deepEqual / assert.deepStrictEqual** `[stub-unacceptable]` — api: `assert.deepEqual / assert.deepStrictEqual`  
  Backed by __deepEqual which compares only own enumerable string-keyed properties via Object.keys(). Symbol-keyed own properties are skipped. In Node 20 deepStrictEqual compares Symbol-keyed own properties. Also: the Set equality check uses `b.has(v)` which uses SameValueZero, not deep equality — so Set<{a:1}> deepStrictEqual Set<{a:1}> will FAIL (different object references), whereas Node correctly recurses. This will silently produce wrong pass/fail verdicts in test suites.  
  *mechanism:* pure-JS shim via globalThis.__deepEqual at engine/src/lib.rs:1612  
  *constraint:* deliberate scope limit; Symbol introspection and deep-Set equality are buildable but not done  
  *evidence:* apps/kernel/engine/src/lib.rs:1612-1643 (__deepEqual — Object.keys only, b.has(v) for Sets), apps/kernel/engine/src/lib.rs:1656-1659 (assert.deepEqual/deepStrictEqual delegate to __deepEqual)
- **assert/strict (submodule alias)** `[real]` — api: `require('assert/strict') / require('node:assert/strict')`  
  Registered as `B['assert/strict'] = __assert` and `B['node:assert/strict'] = __assert`. Since the base assert.strict already maps to the same object with deepEqual===deepStrictEqual, this is consistent.  
  *mechanism:* module alias at engine/src/lib.rs:2165  
  *constraint:* none  
  *evidence:* apps/kernel/engine/src/lib.rs:2165 (B['assert/strict'] = __assert; B['node:assert/strict'] = __assert)

### child_process / worker_threads / cluster / vm (the genuinely-missing primitives)

- **child_process (entire module)** `[impossible]` — api: `require('child_process') — spawn/exec/execFile/fork/spawnSync/execSync/execFileSync/ChildProcess`  
  No implementation exists at any level. require('child_process') throws a named NotSupportedError immediately. The exclusion is total: no shim, no partial stub, no host-call bridge. There is no process model, no fork/exec syscall, and the CF isolate has no OS-process primitives. The engine README comment says 'do the work in-VM or via host.fetch to a service' as the only alternative.  
  *mechanism:* Uniform excluded-module error path in globalThis.require() — lib.rs:2225 exclusion list, lib.rs:2250 reason string, lib.rs:2322-2327 throw NotSupportedError at call site  
  *constraint:* No OS process model in a WASM isolate running on Cloudflare Workers. No fork/exec/waitpid syscalls exist in WASI or in the CF sandbox. Single WASM linear-memory single-process model is the entire execution environment.  
  *evidence:* apps/kernel/engine/src/lib.rs:2225 — excluded: [..., 'child_process', ...], apps/kernel/engine/src/lib.rs:2250 — excludedReasons child_process: 'no process spawning in the isolate', apps/kernel/engine/src/lib.rs:2322-2327 — NotSupportedError throw on require(), docs/ENV-SURFACE-POLICY.md:177 — 'child_process spawn/exec/fork — no process model, no fork/exec syscall'
- **worker_threads (entire module)** `[impossible]` — api: `require('worker_threads') — Worker/isMainThread/parentPort/workerData/MessageChannel/MessagePort/receiveMessageOnPort/threadId/BroadcastChannel/workerData`  
  No implementation exists at any level. require('worker_threads') throws NotSupportedError immediately. The engine is a single-threaded WASM instance; there is no OS thread creation capability, no shared-memory cross-thread messaging, and no mechanism to spin a second WASM instance from within the VM. The exclusion reason string is explicit: 'no threads (single-threaded WASM)'.  
  *mechanism:* Uniform excluded-module error path in globalThis.require() — lib.rs:2225 exclusion list, lib.rs:2252 reason string  
  *constraint:* Single-threaded WASM execution model. WASI has no thread primitives in the version used by quickjs-wasi. CF Workers isolate model is also single-threaded. Heap-snapshot durability requires all state in one linear memory; a real Worker would need a second memory space that cannot be co-snapshotted.  
  *evidence:* apps/kernel/engine/src/lib.rs:2225 — excluded: [..., 'worker_threads', ...], apps/kernel/engine/src/lib.rs:2252 — excludedReasons worker_threads: 'no threads (single-threaded WASM)', docs/ENV-SURFACE-POLICY.md:171 — 'Real OS threads / worker_threads / cluster — single WASM linear memory, single...', docs/research/repl-env-surface.md:17 — 'no child_process'
- **cluster (entire module)** `[impossible]` — api: `require('cluster') — cluster.fork/isMaster/isPrimary/isWorker/worker/workers/SCHED_NONE/SCHED_RR`  
  No implementation exists at any level. require('cluster') throws NotSupportedError immediately. Cluster builds on child_process.fork() and OS process primitives, both of which are absent. The exclusion reason string is 'no multi-process. Alternative: none (single-threaded deterministic VM).' — notably no alternative is offered, unlike child_process.  
  *mechanism:* Uniform excluded-module error path in globalThis.require() — lib.rs:2225 exclusion list, lib.rs:2251 reason string  
  *constraint:* No OS process model, no fork/exec. Additionally requires IPC channels across processes, which have no host-side representation. Single-tenant per-DO-instance model makes multi-process meaningless architecturally.  
  *evidence:* apps/kernel/engine/src/lib.rs:2225 — excluded: [..., 'cluster', ...], apps/kernel/engine/src/lib.rs:2251 — excludedReasons cluster: 'no multi-process. Alternative: none'
- **vm.runInThisContext** `[stub-acceptable]` — api: `require('vm').runInThisContext(code, options)`  
  Implemented as (0, eval)(String(code)) in the single QuickJS realm. For code that only needs to evaluate a string in the global scope this is functionally equivalent. The divergence: Node's runInThisContext runs in the current V8 context but with a fresh micro-task queue and with specific options like filename/lineOffset/columnOffset/timeout/breakOnSigint — none of those options are honoured. Filename and stack-trace offsets are silently ignored.  
  *mechanism:* Pure-JS shim in BOOTSTRAP — eval() wrapper. lib.rs:2146  
  *constraint:* Single QuickJS realm — no context/module separation concept in rquickjs at this layer. Determinism gate: options.timeout cannot be wired to the real interrupt budget from inside the shim.  
  *evidence:* apps/kernel/engine/src/lib.rs:2146 — function runInThisContext(code){ return (0, eval)(String(code)); }, apps/kernel/engine/src/lib.rs:2143-2144 — comment: 'NOT real context isolation (single QuickJS realm)'
- **vm.runInNewContext** `[stub-unacceptable]` — api: `require('vm').runInNewContext(code, contextObject, options)`  
  Implemented by injecting context keys as Function() arguments. This is the highest-severity finding: in Node, runInNewContext creates a genuinely isolated V8 context — code running inside cannot access globalThis, cannot escape to the outer realm, and prototype pollution is impossible. In this shim, the code runs in the SAME QuickJS realm. A crafted payload can: (1) read/write globalThis from inside the 'sandboxed' code (prototype chain is shared), (2) mutate ctx keys' prototypes affecting the outer realm, (3) escape via Function.prototype or any shared intrinsic. Any library using vm.runInNewContext as a security boundary (e.g. isolated-vm users, template engines like nunjucks, handlebars compile) will silently have NO isolation. Additionally, the options argument (timeout, filename, contextExtensions, microtaskMode) is entirely ignored.  
  *mechanism:* Pure-JS shim in BOOTSTRAP — Function(ks, 'return ('+code+')') with ctx values as arguments. lib.rs:2147  
  *constraint:* Single QuickJS realm — rquickjs exposes one Context per kernel. Creating a second context with a fresh globalThis is theoretically possible in rquickjs but not wired. The shim was added for env-fidelity (gate 3: observed breakage in nunjucks/template-engine use), not for security parity.  
  *evidence:* apps/kernel/engine/src/lib.rs:2147 — function runInNewContext(code, ctx){ ... var f = Function(ks.join(','), 'return (' + code + ')'); ... }, apps/kernel/engine/src/lib.rs:2143-2144 — 'NOT real context isolation (single QuickJS realm). runInNewContext injects ctx keys as fn args — NO security/context isolation boundary', apps/kernel/engine/src/lib.rs:2240 — degraded.vm: 'single QuickJS realm; runInNewContext injects ctx keys as fn args — NO security/context isolation boundary'
- **vm.createContext / vm.isContext** `[stub-unacceptable]` — api: `require('vm').createContext(sandbox) / isContext(obj)`  
  createContext() returns the object unchanged (identity function). isContext() always returns true regardless of argument. In Node, createContext() contextifies the object — it becomes the globalThis for any script run against it, with a fresh set of intrinsics. Here it is a no-op identity, so code that calls createContext then runInContext expecting an isolated sandbox gets the same broken-isolation problem as runInNewContext. isContext always returning true is also a lie that can confuse code that uses it as a feature-detect.  
  *mechanism:* Pure-JS shim in BOOTSTRAP — lib.rs:2148-2149  
  *constraint:* Single QuickJS realm. No host-call path to create a second rquickjs Context.  
  *evidence:* apps/kernel/engine/src/lib.rs:2148 — function createContext(o){ return o || {}; }, apps/kernel/engine/src/lib.rs:2153 — isContext: function(){ return true; }
- **vm.Script (new vm.Script / script.runInThisContext / runInNewContext / runInContext)** `[stub-unacceptable]` — api: `require('vm').Script`  
  Script class exists and .runInThisContext()/.runInNewContext()/.runInContext() are wired — but they delegate to the same broken single-realm eval/Function shim described above. No context isolation. Script constructor options (filename, lineOffset, columnOffset, cachedData, produceCachedData) are ignored. cachedData / createCachedData are absent entirely. Node's Script instances can produce and consume V8 bytecode cache — this is absent.  
  *mechanism:* Pure-JS shim in BOOTSTRAP — lib.rs:2149-2152  
  *constraint:* Single QuickJS realm; QuickJS has its own bytecode but it is not exposed via the vm.Script API in this shim.  
  *evidence:* apps/kernel/engine/src/lib.rs:2149-2152 — Script constructor + prototype methods
- **vm.compileFunction** `[absent]` — api: `require('vm').compileFunction(code, params, options)`  
  Not implemented. require('vm') returns an object; calling .compileFunction would throw TypeError: not a function. Node's vm.compileFunction compiles code into a function within a specific context with optional paramsNames, contextExtensions, and produceCachedData. Used by bundlers (esbuild runtime wrapper, webpack) as an alternative to new Function() that respects the vm context. Its absence means code relying on it fails with a clear TypeError rather than silently misbehaving.  
  *mechanism:* Not present in the vm shim object returned at lib.rs:2153  
  *constraint:* Not built — no fundamental WASM ceiling prevents it (it could be shimmed as new Function(params, code) like runInNewContext), just not implemented.  
  *evidence:* apps/kernel/engine/src/lib.rs:2153 — vm object: { runInThisContext, runInNewContext, runInContext, createContext, isContext, Script } — no compileFunction
- **vm.measureMemory** `[absent]` — api: `require('vm').measureMemory(options)`  
  Not implemented. Calling it would throw TypeError. Node's measureMemory returns a Promise resolving to V8 heap statistics per context. The information is theoretically available via rquickjs (getMemoryUsage exists in the Rust engine) but is not plumbed into the vm shim.  
  *mechanism:* Not present in the vm shim object  
  *constraint:* Not built. No fundamental barrier — QuickJS memory stats are available in Rust (used internally for admission guard) but not exposed through the vm module surface.  
  *evidence:* apps/kernel/engine/src/lib.rs:2153 — vm object does not include measureMemory
- **vm.SourceTextModule / vm.SyntheticModule** `[absent]` — api: `require('vm').SourceTextModule / SyntheticModule (--experimental-vm-modules)`  
  Not implemented. These are Node's experimental ES Module linker API. They are absent from the vm shim entirely. Note that the kernel DOES have a real ESM path via __esmEval / use() (lib.rs:2596 — QuickJS Module.declare), but it is not exposed through the vm.SourceTextModule API surface.  
  *mechanism:* Not present in the vm shim object  
  *constraint:* Not built. The underlying QuickJS capability (Module.declare/eval) exists in Rust but is not plumbed through vm.SourceTextModule.  
  *evidence:* apps/kernel/engine/src/lib.rs:2153 — vm object does not include SourceTextModule or SyntheticModule, apps/kernel/engine/src/lib.rs:2596 — real QuickJS Module path used internally by use()
- **Atomics (worker_threads shared-memory primitive)** `[stub-acceptable]` — api: `globalThis.Atomics — used heavily by worker_threads and any shared-memory concurrency code`  
  Atomics object is shimmed as plain non-atomic memory operations (load/store/add/sub/and/or/xor/exchange/compareExchange all directly operate on the TypedArray without any actual atomicity guarantee). Since the engine is single-threaded, real atomicity is meaningless and the shim is functionally correct for all single-threaded use. The critical divergence: Atomics.wait() always returns 'not-equal' immediately (never blocks, never resolves 'ok' or 'timed-out') and Atomics.notify() always returns 0. This means any code that uses Atomics.wait to synchronize across threads (the worker_threads use-case) silently gets 'not-equal' and proceeds without blocking — wrong behavior, but that code is also impossible anyway since worker_threads is excluded. For single-threaded uses (seqlocks, progress counters, atomicCAS patterns used in WASM-compiled code) the shim is acceptable.  
  *mechanism:* Pure-JS shim in BOOTSTRAP — lib.rs:227-241. SharedArrayBuffer presence/absence not confirmed separately but Atomics shim operates on TypedArrays.  
  *constraint:* Single-threaded WASM. The shim comment at lib.rs:223 acknowledges: 'The VM is single-threaded, so atomic ops are plain memory ops — correct for one thread.'  
  *evidence:* apps/kernel/engine/src/lib.rs:223-241 — Atomics shim implementation, apps/kernel/engine/src/lib.rs:238 — wait: function(){ return 'not-equal'; }, apps/kernel/engine/src/lib.rs:239 — notify: function(){ return 0; }
- **process.send / process.connected / process.disconnect / IPC channel** `[absent]` — api: `process.send(msg) / process.on('message') / process.connected — child_process IPC`  
  process.send, process.connected, process.disconnect, and process.channel are not present on the process shim. In Node these are only defined when a process is spawned as a child with IPC; most code guards with if(process.send). The absence is benign for code that guards correctly, but any code that calls process.send() unconditionally (e.g. expecting to be a cluster worker) will get a clear TypeError.  
  *mechanism:* Not implemented in the process shim at lib.rs:770-856  
  *constraint:* No IPC channel exists — child_process and cluster are excluded entirely, so no parent process can spawn this kernel as a child with an IPC fd.  
  *evidence:* apps/kernel/engine/src/lib.rs:770-856 — process shim (no send/connected/disconnect/channel), apps/kernel/engine/src/lib.rs:2250-2251 — child_process and cluster excluded

### WHATWG fetch / Headers / Request / Response / structuredClone / queueMicrotask / AbortController

- **fetch() global** `[partial]` — api: `globalThis.fetch / undici fetch`  
  Core idiom `await fetch(url)` returning a real Response works; binary-safe over base64 host boundary. Missing: `redirect:'error'` and `redirect:'manual'` are stored on the Request but the host always performs SSRF-safe follow — the vm-side redirect field is never forwarded in `sendInit` (engine/src/lib.rs:1080 — sendInit only carries method/headers/bodyB64). `keepalive`, `cache`, `referrer`, `integrity`, `mode`, `credentials` are stored on Request but silently dropped before the host call. `Request.duplex` streaming is implemented but only for the async-iterable/ReadableStream upload path. No CORS enforcement (host is a DO-side bare fetch). FormData body is urlencoded, not multipart (lib.rs:971-973).  
  *mechanism:* pure-JS shim in-VM (Wave 4, engine/src/lib.rs:884-1143) over host-call `host.fetchStream` → DO-side `ssrfSafeFetch` (kernel-glue.ts:825-855). Bytes cross as base64.  
  *constraint:* single-threaded WASM; no wall-clock timers; DO-side host call is the only network egress; serialisation over JSON/base64 WASM boundary limits which init fields survive  
  *evidence:* apps/kernel/engine/src/lib.rs:884-1143, apps/kernel/engine/src/lib.rs:1080 (sendInit drops redirect/cache/mode/credentials/keepalive), apps/kernel/engine/src/lib.rs:971-973 (FormData → urlencoded not multipart), apps/kernel/src/kernel-glue.ts:819-855 (ssrfSafeFetch, always follows redirects), apps/kernel/src/kernel-glue.ts:2091-2138 (_doFetch)
- **Headers** `[stub-unacceptable]` — api: `globalThis.Headers`  
  Core get/set/has/delete/append/forEach/keys/values/entries/Symbol.iterator work. Silently wrong in three ways: (1) `getSetCookie()` is absent — any code that calls `headers.getSetCookie()` throws TypeError; this is the standard way to read multiple Set-Cookie values. (2) The shim merges duplicate headers with `', '` separator (lib.rs:528) — which is correct for most headers but wrong for Set-Cookie (must remain separate). (3) No header guard / immutability enforcement — response headers from a real fetch can be mutated, which the spec forbids for 'immutable' requests. (4) No `toJSON()`. These gaps are largely benign for typical REST clients but will silently misbehave for cookie-jar or duplicate-header code.  
  *mechanism:* pure-JS polyfill evaled at bootstrap, lives in heap across hibernate (engine/src/lib.rs:516-538)  
  *constraint:* bare QuickJS has no native Web API; pure-JS shim is the only path; getSetCookie is a spec addition (2022) not in the original shim  
  *evidence:* apps/kernel/engine/src/lib.rs:516-538, apps/kernel/engine/src/lib.rs:528 (comma-merge of duplicate values), apps/kernel/engine/src/lib.rs:2175 (listed in globals)
- **Request** `[partial]` — api: `globalThis.Request`  
  Constructor, url/method/headers/signal/bodyUsed/.clone()/.text()/.json()/.arrayBuffer()/.bytes()/.blob()/.formData() all present. Properties cache/referrer/credentials/mode/redirect/integrity are stored (lib.rs:1016-1021) but none forwarded to the host — they are inert. `duplex` for streaming upload works through a separate isStreamBody path (lib.rs:1085). `RequestInit.window` absent. No SRI integrity check. `Request.clone()` does not preserve signal (lib.rs:1025 — new Request copies url/method/headers but passes `signal:this.signal` only as the passed arg, which it does — that looks correct on re-read). bodyUsed enforcement tracks consumption.  
  *mechanism:* pure-JS Wave 4 shim (engine/src/lib.rs:1010-1026)  
  *constraint:* init options that require host-side semantics (cache, CORS, integrity) cannot be enforced inside the WASM VM; they are properties of a fetch-to-network, which is DO-controlled  
  *evidence:* apps/kernel/engine/src/lib.rs:1010-1026, apps/kernel/engine/src/lib.rs:1016-1021 (inert properties), apps/kernel/engine/src/lib.rs:1080 (sendInit: only method+headers forwarded)
- **Response** `[partial]` — api: `globalThis.Response`  
  status/statusText/ok/headers/url/redirected/.json()/.text()/.arrayBuffer()/.bytes()/.blob()/.formData()/.clone()/ Response.json()/Response.error()/Response.redirect() all work. `Response.prototype.body` returns a real ReadableStream when the host sent a streaming body (lib.rs:1046-1062); falls back to a single-enqueue buffered stream otherwise. bodyUsed enforced. Missing: `Response.prototype.body` is absent when `ReadableStream` is not yet defined at call time (returns null — lib.rs:1050). No `WritableStream`/`TransformStream` globals, so streaming pipelines using `pipeThrough`/`pipeTo` are absent. `type` field is set but is always `'default'` from fetch (opaque responses not possible through the allowed-egress model). `response.sse()` is a non-standard sugar added.  
  *mechanism:* pure-JS Wave 4 shim (engine/src/lib.rs:1028-1067) over binary-safe base64 host channel  
  *constraint:* single-threaded WASM; no native Web streams; WritableStream/TransformStream require more complex controller machinery not yet shimmed  
  *evidence:* apps/kernel/engine/src/lib.rs:1028-1067, apps/kernel/engine/src/lib.rs:1050-1062 (body getter, null guard on ReadableStream), apps/kernel/engine/src/lib.rs:1182-1183 (non-standard .sse())
- **ReadableStream** `[stub-unacceptable]` — api: `globalThis.ReadableStream`  
  Only the default (push) source type is implemented. Missing: BYOB (byte) reader (`getReader({mode:'byob'})` — absent); `tee()`; `pipeThrough()`; `pipeTo()`; `WritableStream` and `TransformStream` entirely absent (no globals). The internal `locked` property exists. No high-water-mark / queuingStrategy / backpressure signals — the controller just accumulates without bound. Code that calls `stream.tee()`, `stream.pipeThrough()`, or `stream.pipeTo()` will throw TypeError. Code expecting BYOB will throw. Libraries like `node-fetch` polyfills or `whatwg-streams` consumers can encounter these gaps.  
  *mechanism:* minimal pure-JS shim 'EngramRS' (engine/src/lib.rs:266-313)  
  *constraint:* single-threaded WASM; full WHATWG streams spec requires WritableStream/TransformStream/BYOB which add significant code; not yet implemented  
  *evidence:* apps/kernel/engine/src/lib.rs:263-315 (EngramRS, no tee/pipeThrough/pipeTo/BYOB), apps/kernel/engine/src/lib.rs:1050 (Response.body uses ReadableStream)
- **WritableStream / TransformStream** `[absent]` — api: `globalThis.WritableStream, globalThis.TransformStream`  
  No globals defined anywhere in the bootstrap or shims. `stream.pipeline`/`pipeThrough`/`pipeTo` over WHATWG streams are unavailable. Node.js streams (Readable/Writable/Transform from `require('stream')`) are present but are not WHATWG-interoperable WritableStream/TransformStream.  
  *mechanism:* not implemented  
  *constraint:* not inherently impossible — pure-JS shim could be added — but adds complexity and has not been built  
  *evidence:* apps/kernel/engine/src/lib.rs:263-315 (only ReadableStream shimmed, no Writable/Transform WHATWG globals)
- **structuredClone** `[stub-acceptable]` — api: `globalThis.structuredClone`  
  Handles plain objects, arrays, Map, Set, Date, RegExp, ArrayBuffer, all TypedArray views. Circular references handled via seen-Map (lib.rs:501). Throws DataCloneError for functions. Missing spec-compliant items: (1) second `{transfer:[]}` argument silently ignored — the function signature accepts only one arg (lib.rs:494); calling `structuredClone(ab, {transfer:[ab]})` deep-copies instead of transferring (ab still valid after call). (2) Error objects cloned as plain `{}` (no instanceof Error check), losing name/message/stack. (3) Blob/File/FormData/MessagePort/ImageBitmap/CryptoKey not handled. In practice `transfer` semantics are largely relevant to multi-thread/worker scenarios absent here, so (1) is benign for typical use. (2) and the missing Blob/File handling are mildly surprising but rarely relied upon in structuredClone specifically.  
  *mechanism:* pure-JS polyfill evaled in bootstrap (engine/src/lib.rs:492-514), lives in heap  
  *constraint:* no real threads (no SharedArrayBuffer transfer semantics needed); single QuickJS realm  
  *evidence:* apps/kernel/engine/src/lib.rs:492-514, apps/kernel/engine/src/lib.rs:494 (single-arg, no transfer support)
- **queueMicrotask** `[real]` — api: `globalThis.queueMicrotask`  
  Backed by rquickjs native `rt.execute_pending_job()` job queue (engine/src/lib.rs:3233). The JS shim code calls `queueMicrotask(fn)` directly and it is the native QuickJS Promise job queue. All promise continuation, setTimeout, setImmediate, and stream events are built on top of it (lib.rs:867-874). Semantics are correct: runs before the next macro-task. The per-cell pump loop runs up to 2,000,000 pending jobs (lib.rs:3230) — an extremely high ceiling so no practical difference from unbounded. Fully snapshot-safe: queueMicrotask callbacks that are pending when a snapshot fires simply do not exist at restore time (cells settle before checkpoint).  
  *mechanism:* native QuickJS job queue via rquickjs `rt.execute_pending_job()` (engine/src/lib.rs:3221-3236)  
  *constraint:* single-threaded WASM; job queue is part of rquickjs runtime — no workaround needed  
  *evidence:* apps/kernel/engine/src/lib.rs:3221-3236 (pump_jobs loop, execute_pending_job), apps/kernel/engine/src/lib.rs:867-874 (setTimeout/setImmediate built on queueMicrotask), apps/kernel/engine/src/lib.rs:2175 (listed in globals)
- **AbortController** `[stub-acceptable]` — api: `globalThis.AbortController`  
  constructor, `.signal`, `.abort(reason)` all work. `AbortSignal`: `aborted`, `reason`, `addEventListener('abort')`, `removeEventListener`, `dispatchEvent`, `throwIfAborted`, static `AbortSignal.abort(reason)`, `AbortSignal.any(signals)` all present. `fetch({signal})` wires correctly: rejects immediately if already aborted, or races the host promise against abort (lib.rs:1133-1138). Key divergence: `AbortSignal.timeout(ms)` ignores `ms` and fires on the next microtask tick (lib.rs:953) — documented caveat (lib.rs:2264). This is an unacceptable divergence for code that actually wants a real timeout duration (e.g. `fetch(url, {signal: AbortSignal.timeout(5000)})`), but the abort itself fires correctly (just immediately rather than after 5 seconds). There is no wall clock to fix this without a host-side timer effect.  
  *mechanism:* pure-JS Wave 4 shim (engine/src/lib.rs:942-959)  
  *constraint:* no wall-clock timers in WASM sandbox; setTimeout also ignores delay (lib.rs:863-864); determinism requirement forbids real-time timers  
  *evidence:* apps/kernel/engine/src/lib.rs:942-959, apps/kernel/engine/src/lib.rs:953 (timeout fires on microtask, ignores ms), apps/kernel/engine/src/lib.rs:1133-1138 (signal wiring in fetch), apps/kernel/engine/src/lib.rs:2264 (documented caveat)
- **AbortSignal.timeout(ms)** `[stub-unacceptable]` — api: `AbortSignal.timeout`  
  The `ms` argument is silently discarded. The signal aborts on the very next microtask tick regardless of the specified delay (lib.rs:953). Any code that uses `AbortSignal.timeout(5000)` as a real 5-second network timeout will abort immediately, making all such timed-fetch patterns silently broken. This is the highest-severity divergence in this area: it looks like it works (fetch rejects with TimeoutError) but does so at the wrong time.  
  *mechanism:* pure-JS shim; queueMicrotask fires immediately; no host-side timer effect exists for deferred abort  
  *constraint:* no wall-clock in WASM sandbox; determinism requirement; 6-WASI-fn ceiling makes adding a real timer WASI import non-trivial  
  *evidence:* apps/kernel/engine/src/lib.rs:953, apps/kernel/engine/src/lib.rs:2264 (documented)
- **Blob / File** `[partial]` — api: `globalThis.Blob, globalThis.File`  
  Blob: constructor with parts (strings/Uint8Array/ArrayBuffer/other Blobs), `.size`, `.type`, `.arrayBuffer()`, `.bytes()`, `.text()`, `.slice()` all work. `.stream()` works only when `require('stream').Readable` is loaded (lib.rs:920). File: inherits Blob, adds `.name` and `.lastModified`. Missing from Blob: `Blob.prototype.stream()` throws if stream module not loaded (a surprise for code that doesn't need streams otherwise). `File.prototype.stream()` same. No `file.webkitRelativePath`.  
  *mechanism:* pure-JS Wave 4 shim (engine/src/lib.rs:896-924)  
  *constraint:* stream module must be loaded separately; stream dependency is lazy  
  *evidence:* apps/kernel/engine/src/lib.rs:896-924, apps/kernel/engine/src/lib.rs:920 (stream() throws without stream module)
- **FormData** `[stub-unacceptable]` — api: `globalThis.FormData`  
  append/set/get/getAll/has/delete/forEach/keys/values/entries/Symbol.iterator all work correctly. Critical gap: when a FormData is used as a `fetch()` body, it is encoded as `application/x-www-form-urlencoded` (lib.rs:971-973), not `multipart/form-data` with a boundary. Any server that parses the `Content-Type: multipart/form-data` boundary will receive malformed data. File/Blob entries are serialised as the literal string `'[blob]'` (lib.rs:972). Code that uses FormData to upload files via fetch will silently send wrong data.  
  *mechanism:* pure-JS Wave 4 shim (engine/src/lib.rs:926-940); body encoding via `bodyToBytes` (lib.rs:970-973)  
  *constraint:* multipart encoding is non-trivial to implement in pure JS; not yet done  
  *evidence:* apps/kernel/engine/src/lib.rs:970-973 (urlencoded fallback, '[blob]' placeholder), apps/kernel/engine/src/lib.rs:926-940 (FormData shim)
- **fetch() redirect mode** `[stub-unacceptable]` — api: `fetch init.redirect ('follow'|'manual'|'error')`  
  `redirect:'follow'` works correctly (host always follows, SSRF-safe). `redirect:'manual'` and `redirect:'error'` are stored on the Request object but never forwarded in `sendInit` (lib.rs:1080 — only `method` and `headers` are set). The host `ssrfSafeFetch` always follows redirects manually regardless of the VM's requested mode (kernel-glue.ts:827-828). Code that sets `redirect:'manual'` to get an opaque-redirect response will silently receive the fully-followed response instead. Code that sets `redirect:'error'` to fail on redirect will silently follow it.  
  *mechanism:* sendInit construction in VM shim drops redirect (lib.rs:1080); host always follows via ssrfSafeFetch  
  *constraint:* the host fetch loop pre-dates the Wave 4 Request shim; sendInit was never extended to carry redirect mode  
  *evidence:* apps/kernel/engine/src/lib.rs:1016 (redirect stored on Request), apps/kernel/engine/src/lib.rs:1080 (sendInit: only method+headers, no redirect), apps/kernel/src/kernel-glue.ts:827-828 (host always uses redirect:'manual' for its own loop)
- **Headers.getSetCookie()** `[absent]` — api: `Headers.prototype.getSetCookie`  
  The WHATWG Fetch spec (and Node 18+) adds `headers.getSetCookie()` returning an array to allow multiple Set-Cookie values. Not present in the shim. Code calling it throws TypeError. The shim also merges Set-Cookie values with ', ' (lib.rs:528) rather than keeping them separate, so `headers.get('set-cookie')` returns a single comma-joined string.  
  *mechanism:* not implemented in the pure-JS Headers shim  
  *constraint:* absent, not impossible — pure-JS addition  
  *evidence:* apps/kernel/engine/src/lib.rs:516-538 (no getSetCookie method), apps/kernel/engine/src/lib.rs:528 (comma-join append)
- **fetch() keepalive / integrity / credentials / mode / cache** `[stub-acceptable]` — api: `fetch init options: keepalive, integrity, credentials, mode, cache`  
  All five are stored on the Request object (lib.rs:1016-1021) but silently dropped before the host call (sendInit at lib.rs:1080 only carries method+headers). In practice: keepalive is meaningless on a DO (no persistent TCP), integrity (SRI) checking doesn't apply to server-side code, cache mode is irrelevant (DO has no HTTP cache), credentials/mode are cross-origin browser concepts irrelevant in a server-side fetch context. Benign for realistic server-side REPL use.  
  *mechanism:* stored as inert properties on Request; not forwarded to host  
  *constraint:* DO-side fetch does not expose these knobs; server-side context makes them mostly meaningless  
  *evidence:* apps/kernel/engine/src/lib.rs:1016-1021, apps/kernel/engine/src/lib.rs:1080

### console (log/error/table/dir capture + structured preview)

- **console.log / console.info / console.warn / console.error / console.debug — basic multi-arg capture** `[stub-unacceptable]` — api: `console.log / console.info / console.warn / console.error / console.debug`  
  Arguments are serialized with a custom `__fmt` function: strings pass through as-is, non-strings go through `__preview(x, 2)`. Node's `console.log` uses `util.format` which handles `%s`/`%d`/`%i`/`%f`/`%o`/`%O` printf-style substitution when the first arg is a string. Engram does NOT apply format substitution — `console.log('val=%d', 42)` emits `'val=%d 42'` not `'val=42'`. This silently produces wrong output for any code using printf-style console logging, which is widespread. The `util.format` function IS implemented in `__util` (lib.rs:1554) but is NOT wired into `console.log`. Capture itself (buffering into `__logs[]`, draining per-cell by Rust via `__drainLogs`) is solid.  
  *mechanism:* Pure-JS shim in BOOTSTRAP constant (engine/src/lib.rs:725-731). Logs pushed to `globalThis.__logs[]`, drained by Rust via `__drainLogs()` at cell-result time (lib.rs:3277). Delivered in eval reply JSON as `logs: [{level, msg}]`.  
  *constraint:* No constraint prevents fixing this — `util.format` is already in-VM at lib.rs:1574. It is a wiring gap, not an architectural limit.  
  *evidence:* apps/kernel/engine/src/lib.rs:724-731, apps/kernel/engine/src/lib.rs:1553-1574, apps/kernel/src/lib.rs:2794
- **console log capture per-cell (buffer, drain, deliver in reply)** `[real]` — api: `Node console streams (process.stdout / process.stderr side-effects)`  
  All five levels (log/info/warn/error/debug) buffer into `globalThis.__logs[]`. Rust drains them at eval-result time (lib.rs:3277) and attaches `logs: [{level, msg}]` to the eval reply. This is the correct Jupyter-kernel-style per-cell capture pattern — not a streaming side-effect but a discrete per-cell payload. Works across async cells (drainLogs is called after Promise resolution). Level labels are preserved exactly.  
  *mechanism:* Pure-JS push into `__logs[]` in BOOTSTRAP (engine/src/lib.rs:726-731). `__drainLogs()` called from the Rust frame-build JS at lib.rs:3277. Delivered in `reply.logs` at lib.rs:2794.  
  *constraint:* No constraint — pure in-VM array, snapshot-safe (but logs are drained per-cell and NOT persisted across hibernation, which is correct).  
  *evidence:* apps/kernel/engine/src/lib.rs:722-732, apps/kernel/engine/src/lib.rs:3277, apps/kernel/src/lib.rs:2794
- **console.dir** `[stub-acceptable]` — api: `console.dir(obj, options)`  
  Implemented: `console.dir(x, {depth})` calls `__preview(x, depth || 4)`. Node's `console.dir` also accepts `colors` and `showHidden` options — colors are irrelevant (no ANSI in the capture), `showHidden` (non-enumerable props) is not supported by `__preview`. Divergence is benign for the common case.  
  *mechanism:* Pure-JS shim added at engine/src/lib.rs:1329, delegates to `__preview` with depth option.  
  *constraint:* No blocking constraint; `__preview` does not enumerate non-enumerable properties.  
  *evidence:* apps/kernel/engine/src/lib.rs:1329
- **console.table** `[stub-unacceptable]` — api: `console.table(tabularData, properties)`  
  Implemented as `console.log(__preview(rows, 3))`. Node's `console.table` renders an ASCII table with column headers, respects the optional `properties` filter array, and pads cells. Engram's version just dumps the preview of the object/array. Any code asserting on `console.table` output format will see `__preview` serialization, not a table. The second `properties` argument is ignored entirely.  
  *mechanism:* Pure-JS shim at engine/src/lib.rs:1332, delegates to `__preview`.  
  *constraint:* No architectural constraint — this is purely an implementation gap.  
  *evidence:* apps/kernel/engine/src/lib.rs:1332
- **console.group / console.groupEnd / console.groupCollapsed** `[stub-acceptable]` — api: `console.group / console.groupEnd / console.groupCollapsed`  
  `console.group(...args)` passes through to `console.log`, so the label is captured. `console.groupEnd()` is a no-op. `console.groupCollapsed` is absent (undefined). Node's version indents all subsequent console output until `groupEnd`; there is no indentation tracking here. For code that only uses groups for visual structure in DevTools, the missing indentation is benign. Code that parses indentation depth from captured output will break.  
  *mechanism:* Pure-JS shims at engine/src/lib.rs:1330-1331. `groupCollapsed` is absent — calling it throws TypeError.  
  *constraint:* No architectural constraint; indentation tracking would require a counter in `__logs` push logic.  
  *evidence:* apps/kernel/engine/src/lib.rs:1330-1331
- **console.assert** `[real]` — api: `console.assert(condition, ...data)`  
  Checks condition; on falsy, calls `console.error(['Assertion failed:'].concat(args))`. Matches Node semantics: does NOT throw (just logs), passes through additional args. Minor divergence: Node's `console.assert` uses `util.format` on remaining args — same missing format-substitution caveat as `console.log`, but for assertions this is rarely observable.  
  *mechanism:* Pure-JS shim at engine/src/lib.rs:1333.  
  *constraint:* None.  
  *evidence:* apps/kernel/engine/src/lib.rs:1333
- **console.time / console.timeEnd / console.timeLog** `[absent]` — api: `console.time / console.timeEnd / console.timeLog`  
  Not implemented. Calling any of these will throw `TypeError: console.time is not a function`. Code using `console.time('label')` / `console.timeEnd('label')` for timing will break with an unhandled exception unless caught. Node measures wall-clock elapsed time via `process.hrtime`; the seeded-clock model means real wall-time measurement is impossible in seeded mode anyway, but an approximation using the seeded `Date.now()` could be built.  
  *mechanism:* Absent — not provided.  
  *constraint:* In seeded-clock mode, real elapsed time is unavailable; an approximation using the seeded clock is architecturally feasible. In clock:real mode it would be real elapsed. The absence is an implementation gap, not an impossibility.  
  *evidence:* apps/kernel/engine/src/lib.rs:725-731 (console object defined; no time/timeEnd/timeLog keys)
- **console.count / console.countReset** `[absent]` — api: `console.count / console.countReset`  
  Not implemented. Calling `console.count()` throws TypeError. Code that relies on labeled counters will fail silently if inside a try/catch, or throw otherwise.  
  *mechanism:* Absent — not provided.  
  *constraint:* No architectural constraint. Pure state tracking in a Map on the console object; implementable as a pure-JS shim.  
  *evidence:* apps/kernel/engine/src/lib.rs:725-731 (console object defined; no count/countReset keys)
- **console.trace** `[absent]` — api: `console.trace(...data)`  
  Not implemented. Calling `console.trace()` throws TypeError. Node prints 'Trace: ...' followed by a stack trace. QuickJS does not expose a JS-accessible call stack (no `Error.captureStackTrace` or equivalent), so a faithful implementation is not straightforward — a `new Error().stack` approximation is possible but QuickJS stack format diverges from V8.  
  *mechanism:* Absent — not provided.  
  *constraint:* QuickJS provides `new Error().stack` in its own format (not V8 format), so a partial approximation is feasible. Full V8 stack frame format is impossible on QuickJS.  
  *evidence:* apps/kernel/engine/src/lib.rs:725-731 (console object defined; no trace key)
- **console.clear** `[absent]` — api: `console.clear()`  
  Not implemented. In Node, `console.clear()` clears the terminal stdout. In a REPL context with per-cell captured logs, the meaningful analog would be to discard any buffered `__logs` accumulated so far in the current cell. Neither behavior is implemented.  
  *mechanism:* Absent — not provided.  
  *constraint:* No architectural constraint; clearing `globalThis.__logs = []` inside the cell would be the obvious implementation.  
  *evidence:* apps/kernel/engine/src/lib.rs:725-731 (console object defined; no clear key)
- **console.groupCollapsed** `[absent]` — api: `console.groupCollapsed`  
  Not implemented — `console.groupCollapsed` is undefined. `console.group` IS implemented (as a log pass-through). Code that patterns on `groupCollapsed` specifically will get TypeError.  
  *mechanism:* Absent — not provided (console.group is present, groupCollapsed is not).  
  *constraint:* No architectural constraint.  
  *evidence:* apps/kernel/engine/src/lib.rs:1330-1331 (group/groupEnd defined; groupCollapsed absent)
- **printf-style format substitution in console.log (%s, %d, %i, %f, %o, %O, %c)** `[stub-unacceptable]` — api: `console.log format specifiers (via util.format)`  
  Node's `console.log('x=%d', 42)` outputs `'x=42'`. Engram's `console.log` uses `__fmt = (a) => (typeof a === 'string' ? a : __preview(a, 2))` and joins with spaces — the format string is treated as a plain string argument, so `'x=%d 42'` is emitted verbatim. `util.format` IS implemented in `__util` (lib.rs:1554) with correct `%s`/`%d`/`%f`/`%j`/`%o`/`%O`/`%c` handling and correctly handles non-string first args, but is not wired into `console.log`. This silently produces wrong output — a clear stub-unacceptable divergence affecting common logging patterns like `console.log('count=%d', n)` or `console.log('%j', obj)`.  
  *mechanism:* Pure-JS shim gap: `__util.formatWithOptions` at lib.rs:1554 is correct but `console.log` at lib.rs:726 does not call it.  
  *constraint:* No constraint — the fix is wiring `console.log` to call `__util.formatWithOptions` when the first argument is a string.  
  *evidence:* apps/kernel/engine/src/lib.rs:724, apps/kernel/engine/src/lib.rs:726, apps/kernel/engine/src/lib.rs:1553-1574
- **Structured value preview (__preview) — util.inspect-style serialization** `[partial]` — api: `util.inspect (used internally by console.log for objects)`  
  Implemented as `globalThis.__preview(v, depth)` (lib.rs:2701-2759). Handles: null/undefined/number/boolean/bigint/string/symbol/function/Date/RegExp/Error/Promise/Map/Set/TypedArrays/Array/plain objects including circular references. Constructor name prefix for custom classes. Truncates strings at 4096 chars, arrays/objects at 100 entries. Depth default 2. Does NOT handle: WeakMap/WeakSet (unrepresentable by design), non-enumerable properties, getters, Symbol-keyed properties, Proxy internals, custom [util.inspect.custom] / Symbol.for('nodejs.util.inspect.custom') hooks. The depth=2 default means deeply nested objects collapse to '[Object]' / '[Array]' earlier than Node's default of 2 (which is the same, so this matches). No color/ANSI support (irrelevant in captured-log context).  
  *mechanism:* Pure-JS function `__preview` in BOOTSTRAP at engine/src/lib.rs:2701. Also exposed as `util.inspect` via `__util` shim at lib.rs:1552.  
  *constraint:* WeakMap/WeakSet contents are genuinely inaccessible by the JS spec. Symbol-keyed and non-enumerable properties are accessible via `Object.getOwnPropertySymbols` / `Object.getOwnPropertyDescriptors` — absent here. [util.inspect.custom] hooks require the shim to check `Symbol.for('nodejs.util.inspect.custom')` before falling back — not done.  
  *evidence:* apps/kernel/engine/src/lib.rs:2699-2759, apps/kernel/engine/src/lib.rs:1552
- **process.stdout.write / process.stderr.write routing to console** `[stub-acceptable]` — api: `process.stdout.write / process.stderr.write`  
  Both `process.stdout` and `process.stderr` are writable stream stubs (isTTY=false, columns=80, rows=24) whose `write(chunk)` method routes to `console.log` / `console.error` respectively, stripping a trailing newline. Uint8Array chunks are TextDecoder-decoded. This covers the most common case of libraries that call `process.stdout.write` for output. Divergence: `write` always returns `true` synchronously (no backpressure), `drain` events never fire, `highWaterMark` is absent, no `fd`-level write syscall.  
  *mechanism:* Pure-JS stream stub in BOOTSTRAP at engine/src/lib.rs:852, routed to `console.log`/`console.error`.  
  *constraint:* No real file descriptor or OS pipe exists in a WASM CF Worker — impossible to provide real fd-level semantics.  
  *evidence:* apps/kernel/engine/src/lib.rs:851-852

### perf_hooks (performance.now) / async_hooks / AsyncLocalStorage

- **performance.now()** `[stub-unacceptable]` — api: `perf_hooks.performance.now / globalThis.performance.now`  
  Returns a monotonically-increasing counter — but NOT elapsed wall-time. The underlying __now() increments by exactly +1ms on every call regardless of real elapsed time (engine/src/lib.rs:2912-2920: CLOCK.with(|c|{ let t=c.get(); c.set(t+1); 1_700_000_000_000.0+t })). In seeded mode (default) the epoch base is 2023-11-14 (1.7e12), making .now() return a giant absolute timestamp rather than ms-since-navigation-start. timeOrigin is hardcoded to 0 (kernel-glue.ts:201). In clock:real mode the CLOCK is re-anchored to real wall-time at the START of each cell (kernel-glue.ts:1548-1563), but within a cell still advances +1ms/call. Net divergence: (a) default seeded mode returns epoch-ms not relative-ms — code that does `const t0=performance.now(); work(); performance.now()-t0` gets the right DELTA but `t0` is ~1.7e12 not ~0; (b) no sub-millisecond resolution (integer steps only); (c) timeOrigin=0 not the real page/process start; (d) repeated same-synchronous calls advance the counter — real Node gives identical values within the same microtask drain.  
  *mechanism:* seeded — pure-JS shim over Rust CLOCK cell (+1ms/call), injected as globalThis.__now via inject_host_fns, wired onto globalThis.performance.now at bootstrap (engine/src/lib.rs:200-201); also exposed via require('perf_hooks').performance.  
  *constraint:* determinism requirement: no real clock in WASM turn (workerd freezes wall-clock in-turn); the +1ms-per-call tick is the only stable monotone source that survives snapshot/restore byte-identically.  
  *evidence:* apps/kernel/engine/src/lib.rs:200-201 (performance.now bootstrap shim), apps/kernel/engine/src/lib.rs:2909-2921 (inject_host_fns: CLOCK cell +1ms/call), apps/kernel/engine/src/lib.rs:2141-2142 (perf_hooks builtin registration), apps/kernel/src/kernel-glue.ts:1548-1563 (clock:real re-anchor at cell start), apps/kernel/src/kernel-glue.ts:884-887 (CLOCK_EPOCH_BASE_MS = 1_700_000_000_000)
- **performance.timeOrigin** `[stub-unacceptable]` — api: `perf_hooks.performance.timeOrigin`  
  Hardcoded to 0 in seeded mode (kernel-glue.ts:201: `if (typeof __perfNew.timeOrigin !== 'number') __perfNew.timeOrigin = 0`). In clock:real mode, session create seeds clockSeed = realEpochMs - 1.7e12, so performance.now() reads real time but timeOrigin remains 0. Node guarantees timeOrigin = the high-resolution epoch at process start; the WHATWG spec defines it as the time at which the global context was created. Any code that uses `timeOrigin + now()` to reconstruct an absolute timestamp gets 0 + giant_counter = still a giant counter, but any code that reads timeOrigin expecting a sane origin (e.g. constructing a DOMHighResTimeStamp absolute) is silently wrong.  
  *mechanism:* seeded / pure-JS shim — fallback assignment in the performance bootstrap block (engine/src/lib.rs:201).  
  *constraint:* no wall-clock at WASM init time; determinism requires a fixed seed, not a real epoch.  
  *evidence:* apps/kernel/engine/src/lib.rs:201 (timeOrigin fallback to 0)
- **performance.mark() / performance.measure() / getEntriesByName() / getEntriesByType() / clearMarks() / clearMeasures()** `[absent]` — api: `perf_hooks Performance Timeline API (mark/measure/getEntries*)`  
  The performance object only has .now (and .timeOrigin=0). No mark, measure, getEntries, getEntriesByName, getEntriesByType, clearMarks, clearMeasures, or PerformanceEntry/PerformanceMark/PerformanceMeasure constructors exist anywhere in the shim. Calling performance.mark('x') will throw TypeError: performance.mark is not a function. Libraries that use the User Timing API (e.g. React DevTools profiler, web-vitals) will break silently or throw.  
  *mechanism:* not built — the performance object is a minimal two-key object (now + timeOrigin) constructed in the bootstrap block.  
  *constraint:* not impossible, just not built; a pure-JS in-heap store could implement the Timeline API. Low priority given the REPL use case.  
  *evidence:* apps/kernel/engine/src/lib.rs:201 (only .now and .timeOrigin set), apps/kernel/engine/src/lib.rs:2141-2142 (perf_hooks builtin: only performance + PerformanceObserver + monotonicNow + constants)
- **PerformanceObserver** `[stub-acceptable]` — api: `perf_hooks.PerformanceObserver`  
  Constructible but entirely no-op: observe(), disconnect(), and takeRecords() are present but do nothing. No callbacks ever fire. Code that does `new PerformanceObserver(cb).observe({entryTypes:['measure']})` will not throw, but the callback is never invoked. Acceptable for production code that uses PerformanceObserver as an optional enhancement (most do); unacceptable for code that REQUIRES the observer to fire to make progress (rare in REPL contexts).  
  *mechanism:* pure-JS stub — constructor with three no-op methods, registered in __builtins.perf_hooks at engine/src/lib.rs:2142.  
  *constraint:* no Performance Timeline entries are generated (mark/measure absent), so there is nothing to observe; a firing implementation would be vacuous anyway.  
  *evidence:* apps/kernel/engine/src/lib.rs:2142 (PerformanceObserver: no-op constructor with observe/disconnect/takeRecords)
- **perf_hooks.monotonicNow()** `[stub-acceptable]` — api: `perf_hooks.monotonicNow`  
  Present and wired to __now(), so it advances monotonically at +1ms/call exactly like performance.now(). Node's monotonicNow() is documented as a monotonic high-res clock not subject to NTP jumps. The seeded-clock guarantee means it never goes backwards, which is the only real contract of monotonicNow. Delta measurements work; absolute values are seeded, not real wall-time — same divergence as performance.now().  
  *mechanism:* seeded — delegates to globalThis.__now() in the perf_hooks builtin object (engine/src/lib.rs:2142).  
  *constraint:* determinism; same seeded CLOCK cell as performance.now.  
  *evidence:* apps/kernel/engine/src/lib.rs:2142 (monotonicNow: function(){ return globalThis.__now(); })
- **perf_hooks.constants** `[stub-acceptable]` — api: `perf_hooks.constants (NODE_PERFORMANCE_GC_* etc.)`  
  Exposed as an empty object {}. Code that destructures specific constants (NODE_PERFORMANCE_GC_MAJOR etc.) gets undefined, not a thrown error. Most user code either doesn't use these or only passes them through to a PerformanceObserver that is itself a no-op here.  
  *mechanism:* pure-JS stub — empty object literal in the perf_hooks builtin (engine/src/lib.rs:2142).  
  *constraint:* N/A — purely additive constants with no runtime hook.  
  *evidence:* apps/kernel/engine/src/lib.rs:2142 (constants: {})
- **process.hrtime() / process.hrtime.bigint()** `[stub-unacceptable]` — api: `process.hrtime / process.hrtime.bigint`  
  Implemented over Date.now() (itself backed by the seeded __now()). Returns [seconds, nanoseconds] where nanoseconds is (ms%1000)*1e6, so sub-millisecond resolution is always zero-padded — every call with the same ms bucket returns identical ns. bigint form returns ms*1000000n. Code using hrtime for high-resolution benchmarking gets only 1ms granularity. More critically: in seeded mode the absolute value is epoch-based (seconds ~ 1.7e9), not process-uptime-relative. `hrtime(prev)` delta arithmetic is correct at ms granularity.  
  *mechanism:* seeded — pure-JS shim over Date.now() (which wraps __now()) in the process object built at kernel-glue.ts:821-823.  
  *constraint:* WASM has no sub-ms timer; workerd freezes clock in-turn; determinism bars real hrtime.  
  *evidence:* apps/kernel/src/kernel-glue.ts:819-823 (hrtime/hrtime.bigint implementation), apps/kernel/src/kernel-glue.ts:772-773 (caveat comment: 'hrtime/uptime derived from SEEDED clock')
- **async_hooks module (require('async_hooks'))** `[absent]` — api: `async_hooks (createHook, executionAsyncId, triggerAsyncId, AsyncResource, AsyncLocalStorage)`  
  async_hooks does not appear anywhere in __builtins, the excluded list, or the capability manifest. require('async_hooks') will fall through to the module-not-found path and throw. This is a hard hole for any library that depends on continuation-local context propagation: express-async-errors, cls-hooked, OpenTelemetry tracing (which uses AsyncLocalStorage internally), Sentry, DataDog APM, etc. will fail at import time.  
  *mechanism:* not built, not stubbed, not in excluded list — simply absent from __builtins registration.  
  *constraint:* async_hooks relies on the V8 async task-tracking machinery (promise hooks, PromiseReactionJob IDs). QuickJS has no equivalent public hook API; adding it would require patching the rquickjs/QuickJS engine to emit lifecycle callbacks on every promise reaction — infeasible without forking the engine. It is not listed as excluded (engine/src/lib.rs:2225) because the author's IMPLEMENTATION-TRUTH exclusion list covers only 'intrinsically impossible' modules, and async_hooks simply was never considered.  
  *evidence:* apps/kernel/engine/src/lib.rs:2098-2165 (__builtins object: no async_hooks key), apps/kernel/engine/src/lib.rs:2225 (excluded list: no async_hooks), apps/kernel/engine/src/lib.rs:2175 (__nodeCompat.globals: no AsyncLocalStorage)
- **AsyncLocalStorage** `[impossible]` — api: `async_hooks.AsyncLocalStorage`  
  AsyncLocalStorage propagates a context value automatically across async boundaries by hooking into V8's promise/async-task tracking. QuickJS has no equivalent engine-level hook API — there is no PromiseHook or async-context callback mechanism exposed in rquickjs. A pure-JS polyfill (manually wrapping every then/await call) is theoretically possible but cannot intercept third-party async chains transparently, breaking the core guarantee. The global AsyncLocalStorage symbol does not exist in the VM at all.  
  *mechanism:* not present — impossible to implement with correct propagation semantics on bare QuickJS-WASM without engine-level async hooks.  
  *constraint:* QuickJS has no PromiseHook / async-task lifecycle API (V8-specific capability). Single-threaded WASM also means no thread-local storage analogue. Any shim would be a broken polyfill that misses un-instrumented third-party promise chains.  
  *evidence:* apps/kernel/engine/src/lib.rs:2175 (__nodeCompat.globals list — AsyncLocalStorage absent), apps/kernel/engine/src/lib.rs:2098-2165 (__builtins — no async_hooks or AsyncLocalStorage)
- **AsyncResource** `[impossible]` — api: `async_hooks.AsyncResource`  
  AsyncResource.bind() and the runInAsyncScope() method rely on the same V8 async-context infrastructure as AsyncLocalStorage. Not present. Same root constraint as AsyncLocalStorage — no engine-level async lifecycle hooks in QuickJS.  
  *mechanism:* not present — same engine constraint as AsyncLocalStorage.  
  *constraint:* QuickJS lacks V8 PromiseHook / async task tracking API needed to implement bind/runInAsyncScope correctly.  
  *evidence:* apps/kernel/engine/src/lib.rs:2098-2165 (__builtins — no async_hooks key)
- **createHook / executionAsyncId / triggerAsyncId** `[impossible]` — api: `async_hooks.createHook / executionAsyncId / triggerAsyncId`  
  These are the low-level instrumentation primitives of the async_hooks module — init/before/after/destroy/promiseResolve callbacks per async resource. Require engine-level promise lifecycle hooks. Not present. Not stubbable in a useful way on QuickJS.  
  *mechanism:* not present — requires V8 PromiseHook API or equivalent engine introspection, which QuickJS does not expose.  
  *constraint:* V8-specific engine-level async instrumentation API; 12-WASM-import ceiling also precludes adding a new WASM import to pump lifecycle callbacks.  
  *evidence:* apps/kernel/engine/src/lib.rs:2225 (excluded list — async_hooks not even mentioned, i.e. off the radar entirely), apps/kernel/engine/src/lib.rs:2098-2165 (__builtins — absent)

### TypeScript support (sucrase type-erasure for cells: generics/enums/satisfies)

- **Type annotations on variables, parameters, return types** `[real]` — api: `TypeScript type syntax (`: string`, `: number`, `: SomeType`)`  
  Sucrase strips annotations to plain JS before QuickJS sees the cell. Semantically identical to tsc erasure — the JS runtime value is unchanged. No divergence for realistic use.  
  *mechanism:* pure-JS shim (sucrase@3.35.1 inlined into kernel-glue.mjs by esbuild; runs host-side in workerd, never in WASM). `transforms:["typescript"], disableESTransforms:true`.  
  *constraint:* QuickJS-WASM has no TS parser; erasure must happen before the JS reaches the WASM engine. Host-side (workerd JS) is the only viable location.  
  *evidence:* apps/kernel/src/kernel-glue.ts:21-46 (stripTypes implementation, sucrase import + call), apps/kernel/src/kernel-glue.ts:1534-1545 (evalCode integration, tsEnabled guard), docs/TS-REPL.md:62-73 (supported table)
- **Interfaces and type aliases** `[real]` — api: `TypeScript `interface` / `type` declarations`  
  Erased entirely (to whitespace / blank lines) by sucrase `typescript` transform. No runtime value emitted in real TS either — semantically identical.  
  *mechanism:* pure-JS shim (sucrase, same path as above)  
  *constraint:* QuickJS-WASM has no TS parser.  
  *evidence:* apps/kernel/src/kernel-glue.ts:36-46, docs/TS-REPL.md:64-65 (interfaces/type aliases listed as erasable)
- **Generics (function, class, arrow function type parameters)** `[real]` — api: `TypeScript generic syntax `<T>`, `<T extends U>``  
  Erased cleanly by sucrase. The sucrase call does NOT use `disableESTransforms:false`, so arrow-function generics like `<T,>` (comma-disambiguated) are handled. No runtime divergence.  
  *mechanism:* pure-JS shim (sucrase `transforms:["typescript"]`)  
  *constraint:* QuickJS-WASM has no TS parser.  
  *evidence:* apps/kernel/src/kernel-glue.ts:46, docs/TS-REPL.md:69 (generics listed as erasable), docs/SESSION-SUMMARY.md:30 (generics listed)
- **`as` type assertions** `[real]` — api: `TypeScript `expr as T``  
  Erased by sucrase. The runtime expression value is unchanged — identical to tsc output.  
  *mechanism:* pure-JS shim (sucrase `transforms:["typescript"]`)  
  *constraint:* QuickJS-WASM has no TS parser.  
  *evidence:* apps/kernel/src/kernel-glue.ts:23-24 (`as` listed in comment), docs/TS-REPL.md:70 (`as` listed as erasable)
- **`satisfies` operator** `[real]` — api: `TypeScript `expr satisfies T` (TS 4.9+)`  
  Erased by sucrase (sucrase@3.35.1 recognises the `_satisfies` contextual keyword). Runtime value is unchanged. Semantically equivalent to tsc erasure.  
  *mechanism:* pure-JS shim (sucrase, `transforms:["typescript"]`)  
  *constraint:* QuickJS-WASM has no TS parser.  
  *evidence:* apps/kernel/src/kernel-glue.ts:23-24 (`satisfies` listed in comment), docs/TS-REPL.md:70 (`satisfies` listed as erasable), apps/kernel/src/kernel-glue.mjs:1831 (sucrase `_satisfies` contextual keyword token)
- **`declare` statements** `[real]` — api: `TypeScript `declare const/function/class/var``  
  Blanked/erased by sucrase. Emit-less in real TS too — no runtime divergence.  
  *mechanism:* pure-JS shim (sucrase `transforms:["typescript"]`)  
  *constraint:* QuickJS-WASM has no TS parser.  
  *evidence:* apps/kernel/src/kernel-glue.ts:37, docs/TS-REPL.md:71 (`declare` listed as erasable)
- **`abstract` classes and abstract members** `[real]` — api: `TypeScript `abstract class` / `abstract method(): void``  
  The `abstract` keyword is erased by sucrase (abstract class becomes a plain class; abstract members are blanked). Identical to tsc `--removeComments` output for abstract syntax. No runtime value lost.  
  *mechanism:* pure-JS shim (sucrase `transforms:["typescript"]`)  
  *constraint:* QuickJS-WASM has no TS parser.  
  *evidence:* docs/TS-REPL.md:7 (`abstract` listed as erasable), docs/TS-REPL.md:72 (table row)
- **Regular `enum` declarations** `[real]` — api: `TypeScript `enum E { A, B, C }``  
  Sucrase `transforms:["typescript"]` lowers regular enums to an IIFE pattern that assigns members as numbered/string properties on a plain object, matching tsc's standard enum output. Numeric auto-increment and string initializers work. The result is a runtime JS object accessible as `E.A` / `E[0]`, identical to tsc output.  
  *mechanism:* pure-JS shim (sucrase `transforms:["typescript"]`, enum lowering built into the TypeScript transform; no separate 'decorators' or 'imports' transform needed)  
  *constraint:* QuickJS-WASM has no TS parser; enum lowering requires code generation so pure erasure is not possible — sucrase generates the IIFE.  
  *evidence:* apps/kernel/src/kernel-glue.ts:24 (comment: 'transforms enum -> IIFE'), apps/kernel/src/kernel-glue.ts:37 ('lowers `enum` -> an IIFE'), apps/kernel/src/kernel-glue.mjs:438-450 (sucrase enumtype/enumlit helpers in bundled output), docs/SESSION-SUMMARY.md:30 ('enums' listed as supported)
- **`const enum` declarations** `[stub-unacceptable]` — api: `TypeScript `const enum E { A = 1 }` (cross-file inlining)`  
  Sucrase README explicitly warns: `const enum` requires cross-file compilation (inlining member values at use-sites) and recommends `isolatedModules` flag to disallow them. With `transforms:["typescript"]` sucrase does NOT inline const-enum references — it may lower them to a regular runtime object (like a plain enum) but uses of the const-enum that tsc would inline as a numeric literal are instead left as property accesses. In a REPL every cell is a separate file-equivalent, so a `const enum` defined in cell 1 and referenced in cell 2 will fail with a runtime error (the IIFE name is not in scope across cells unless it survived the REPL-transform top-level hoisting). Additionally, docs/TS-REPL.md (written for the prior ts-blank-space implementation) listed `const enum` as a `TypeScriptError`-rejected construct. The current sucrase path may or may not throw — the behaviour is undocumented for the post-migration path — but cross-cell inlining is definitively broken.  
  *mechanism:* pure-JS shim (sucrase, but no cross-file inlining; REPL cells are isolated eval units)  
  *constraint:* No real module system in the REPL — each cell is an isolated eval; const-enum inlining requires the compiler to see all use-sites, which is impossible across independently eval'd cells.  
  *evidence:* node_modules/.bun/sucrase@3.35.1/node_modules/sucrase/README.md:75-76 (const enum cross-file caveat), docs/TS-REPL.md:80 (const enum listed as TypeScriptError reject under ts-blank-space), apps/kernel/src/kernel-glue.ts:1531 (comment still says 'enum' reject — may be stale for plain enum after sucrase migration)
- **`namespace` / `module` declarations** `[absent]` — api: `TypeScript `namespace N { ... }` / `module M { ... }` (value-emitting)`  
  Requires code generation (namespace object + IIFE). Sucrase `transforms:["typescript"]` does NOT lower namespaces. The cell is rejected with a `TypeScriptError` before eval, so the socket stays alive. Cleanly fails rather than miscompiling.  
  *mechanism:* pure-JS shim (sucrase parse error path → TypeScriptError reject in evalCode)  
  *constraint:* No code-generation transform available in sucrase for namespaces; QuickJS-WASM has no TS parser to fall back to.  
  *evidence:* apps/kernel/src/kernel-glue.ts:1531 ('enum / namespace / parameter-properties reject'), docs/TS-REPL.md:81-82 (namespace/module listed as TypeScriptError-rejected, SyntaxKind 267)
- **Parameter properties (`constructor(private x: T)`)** `[absent]` — api: `TypeScript constructor parameter properties`  
  Requires code generation (field declaration + assignment). Sucrase `transforms:["typescript"]` does NOT transform parameter properties. Cell is rejected with `TypeScriptError`. Clean fail.  
  *mechanism:* pure-JS shim (sucrase parse error path → TypeScriptError reject)  
  *constraint:* No parameter-property lowering in sucrase without the `imports` transform; QuickJS-WASM has no TS parser.  
  *evidence:* apps/kernel/src/kernel-glue.ts:1531, docs/TS-REPL.md:83 (parameter properties listed as TypeScriptError-rejected, SyntaxKind 123)
- **TS decorators (legacy `@decorator` syntax)** `[stub-unacceptable]` — api: `TypeScript `experimentalDecorators` / TC39 stage-3 decorator syntax`  
  SESSION-SUMMARY.md:30 claims 'decorators' are supported via sucrase, but this is false for the current implementation. The sucrase call uses `transforms:["typescript"]` only (kernel-glue.ts:46). Sucrase has no 'decorators' or 'legacy-decorators' Transform value (Options-gen-types.js lists only jsx/typescript/flow/imports/react-hot-loader/jest). With `typescript` transform only, sucrase parses decorator syntax but does NOT emit the `__decorate`/`__metadata` calls that give decorators their semantics. The decorated class will be emitted without any decorator application. QuickJS (ES2020+) does not natively support the TC39 stage-3 `@decorator` syntax either. A cell with decorators will either be silently mis-compiled (legacy syntax erased, class field effects lost) or throw a QuickJS syntax error.  
  *mechanism:* pure-JS shim (sucrase — but the required transform is absent; decorators are not lowered)  
  *constraint:* Sucrase Transform enum has no decorator transform; QuickJS-WASM has no native decorator support; the `typescript`-only transform strips type annotations but not decorator call-site code.  
  *evidence:* apps/kernel/src/kernel-glue.ts:46 (transforms:["typescript"] only — no decorator transform), node_modules/.bun/sucrase@3.35.1/node_modules/sucrase/dist/Options-gen-types.js (Transform union: jsx|typescript|flow|imports|react-hot-loader|jest — no decorators), docs/SESSION-SUMMARY.md:30 (claim 'decorators' supported — contradicted by the code)
- **`import type` / `export type` statements** `[real]` — api: `TypeScript type-only imports/exports (TS 3.8+)`  
  Sucrase `transforms:["typescript"]` removes type-only imports/exports. The `disableESTransforms:true` flag leaves the `imports` transform off, so ESM `import`/`export` syntax is NOT converted to CJS require(). Since QuickJS receives the cell as a plain eval (not an ES module), `import` statements from other modules are blocked anyway by the REPL eval context — but `import type` / `export type` are stripped and do not cause syntax errors.  
  *mechanism:* pure-JS shim (sucrase `transforms:["typescript"]`; import/export type are part of the typescript transform, not the imports transform)  
  *constraint:* QuickJS-WASM has no TS parser; type-only import/export are stripped pre-eval.  
  *evidence:* apps/kernel/src/kernel-glue.ts:36-46, node_modules/.bun/sucrase@3.35.1/node_modules/sucrase/README.md:72-78 (typescript transform handles enums + type-only syntax)
- **Source-map-aware error locations (TS line/column in stack traces)** `[absent]` — api: `Node.js `--enable-source-maps` / V8 source map support in stack traces`  
  Sucrase produces non-length-preserving output (kernel-glue.ts:41 explicitly notes this). No source maps are generated or passed to QuickJS. Stack traces from runtime errors report post-transform JS line numbers, not original TS line/column. The TypeScriptError returned for parse failures has `stack: ""` (kernel-glue.ts:1543) — zero location info.  
  *mechanism:* none — source maps are not generated (sucrase `sourceMapOptions` not set; QuickJS has no source map consumer API)  
  *constraint:* QuickJS-WASM exposes no source map API; the WASM engine ABI provides raw JS stack strings only. The host-side sucrase transform does not emit source maps (option not set).  
  *evidence:* apps/kernel/src/kernel-glue.ts:41 ('Output is NOT length-preserving'), apps/kernel/src/kernel-glue.ts:1543 (TypeScriptError: stack: ""), apps/kernel/src/kernel-glue.ts:46 (sucraseTransform call — no sourceMapOptions key)
- **`typescript: false` config opt-out** `[real]` — api: `N/A — engram-specific config`  
  Setting `KernelConfig.typescript: false` disables sucrase entirely; cells go straight to transformCell and QuickJS as raw JS. Persisted across cold restore via configJson. Correctly documented and implemented.  
  *mechanism:* host-side config flag (`this.tsEnabled = cfg.typescript !== false`; kernel-glue.ts:1241)  
  *constraint:* none  
  *evidence:* apps/kernel/src/kernel-glue.ts:1239-1241, apps/kernel/src/kernel-glue.ts:1534-1536 (tsEnabled guard in evalCode), docs/TS-REPL.md:88-96
- **TypeScript error isolation (TypeScriptError does not kill the session)** `[real]` — api: `N/A — engram-specific error envelope`  
  A sucrase parse failure is caught before the eval mutex is acquired; the result is a well-formed `{ok:false,valueType:'error',error:{name:'TypeScriptError',...}}` JSON. The session/socket remains alive and the next eval works.  
  *mechanism:* host-side error wrapping in evalCode (kernel-glue.ts:1534-1545); mutex never taken on TS parse error path  
  *constraint:* none  
  *evidence:* apps/kernel/src/kernel-glue.ts:1534-1545, docs/TS-REPL.md:56-58, docs/TS-REPL.md:136-137

### stdlib npm libs injected at create (lodash/dayjs/zod/ramda/uuid/nanoid/date-fns/immer/decimal/js-yaml/papaparse/marked/rxjs/mathjs)

- **lodash (lodash-es 4.18.1)** `[real]` — api: `require('lodash') / globalThis._ / globalThis.lodash`  
  Full lodash-es IIFE (97 339 bytes minified), all ~300 methods present. Exposed as globalThis._ and globalThis.lodash; registered as require('lodash') via __stdmods. Divergence: require('lodash-es') does NOT resolve (registration key is 'lodash' only, alt lookup strips hyphens to 'lodashes' which doesn't match). Seeded RNG means any lodash method relying on Math.random() (_.shuffle, _.sample, _.random) is deterministic per session, not truly random.  
  *mechanism:* stdlib inject — esbuilt lodash-es IIFE evaled into QuickJS heap at create; snapshot-persists across hibernation  
  *constraint:* 500 KB combined source cap (this lib alone = 95 KB; fits within default set of 184 KB)  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (versions.lodash='4.18.1', sizes.lodash=97339), apps/kernel/src/stdlib.bundle.txt (keys include 'lodash', globalThis._= and globalThis.lodash= assignments), apps/kernel/src/kernel-glue.ts:1320-1321 (registration: __stdmods[name]=globalThis[name]), apps/kernel/src/kernel-glue.ts:931 (MAX_STDLIB_SOURCE_BYTES=500*1024)
- **dayjs (v1.11.21) — base only** `[stub-unacceptable]` — api: `require('dayjs') / globalThis.dayjs`  
  Base dayjs only (7 724 bytes). dayjs.extend() method IS present so plugins can be attached, but NO plugins are bundled — no relativeTime, no duration, no timezone, no advancedFormat, no customParseFormat, no isBetween, etc. Any code that calls e.g. dayjs.extend(relativeTime) must first obtain the plugin via await use('dayjs/plugin/relativeTime') from CDN (async, allowlisted host required). dayjs internally uses the seeded Date.now() — date arithmetic is correct but 'now' is the session-seed time, not wall-clock time, which silently breaks .fromNow() / relative-time even if the plugin is loaded.  
  *mechanism:* stdlib inject — esbuilt dayjs base IIFE; no plugin tree included  
  *constraint:* determinism constraint: Date.now is seeded; dayjs.now() returns synthetic time, not real wall-clock  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (sizes.dayjs=7724, versions.dayjs='1.11.21'), apps/kernel/src/stdlib.bundle.txt ('relativeTime' absent, 'duration' absent, .extend present), apps/kernel/engine/src/lib.rs:198 (Date.now overwritten with seeded __now), docs/results/v0.6-stdlib.md:110 (dayjs SAFE DEFAULT, 0.13 MB heap)
- **nanoid (v5.1.11)** `[stub-acceptable]` — api: `globalThis.nanoid / globalThis.nanoid.customAlphabet / require('nanoid')`  
  nanoid() and customAlphabet() are present (646-byte IIFE). urlAlphabet is NOT exported (not present in bundle). IDs use crypto.getRandomValues which is routed through the seeded WASI __rand — IDs are deterministic per session seed, not truly random. For session-unique IDs within one session this is fine; cross-session uniqueness holds only if seeds differ. Divergence from Node nanoid: urlAlphabet export absent.  
  *mechanism:* stdlib inject — esbuilt nanoid ESM IIFE; getRandomValues -> seeded __rand (WASI random_get path)  
  *constraint:* determinism: seeded crypto.getRandomValues (engine/src/lib.rs:367); no true entropy  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (sizes.nanoid=646), apps/kernel/src/stdlib.bundle.txt (urlAlphabet absent, customAlphabet present), apps/kernel/engine/src/lib.rs:363-376 (seeded crypto.getRandomValues/randomUUID), apps/kernel/src/kernel-glue.ts:931 (size guard)
- **uuid (v11.1.1)** `[stub-acceptable]` — api: `globalThis.uuid / require('uuid')`  
  Full uuid v11 bundle (10 562 bytes): v1, v3, v4, v5, v6, v7, validate, version, NIL all present. All versions backed by crypto.getRandomValues which routes through the seeded RNG — deterministic per seed, not truly unique across sessions unless seeds differ. v1 uses getRandomValues for the node identifier (no real MAC available in WASM), which is spec-conformant. The seeded behavior is intentional for replay-consistent sessions.  
  *mechanism:* stdlib inject — full uuid ESM bundle evaled into QuickJS; crypto.getRandomValues -> seeded __rand  
  *constraint:* determinism: seeded RNG (engine/src/lib.rs:363-376)  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (versions.uuid='11.1.1', sizes.uuid=10562), apps/kernel/src/stdlib.bundle.txt (v1/v3/v4/v5/v6/v7/validate all present)
- **zod (v3.25.76)** `[real]` — api: `globalThis.z / globalThis.zod / require('zod')`  
  Full Zod v3 (59 555 bytes minified). ZodType, ZodString, ZodNumber, ZodObject, ZodArray, ZodUnion, ZodEnum, ZodLazy, ZodEffects, ZodTransform, ZodPromise, ZodNativeEnum, ZodDate, ZodError, safeParse, parseAsync all present. Pure schema validation with no I/O dependency — QuickJS-compatible. No known divergence for realistic use.  
  *mechanism:* stdlib inject — esbuilt Zod v3 IIFE; pure-JS schema library  
  *constraint:* 500 KB source cap (59 KB well within the 184 KB default set)  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (versions.zod='3.25.76', sizes.zod=59555), apps/kernel/src/stdlib.bundle.txt (ZodType, ZodString, ZodNumber etc. all verified present)
- **mathjs (v12.4.3)** `[stub-unacceptable]` — api: `globalThis.math / require('mathjs')`  
  mathjs is opt-in and in the bundle (631 999 bytes) with a full create(all) instance exposing bignumber, fraction, complex, matrix, sparse, evaluate, compile, parse, derivative, simplify, rationalize. However it is DOUBLE-BLOCKED: (1) it is opt-in so not loaded by default or by config.modules:true; (2) it alone exceeds the 500 KB combined source guard (631 999 > 512 000 bytes), so even config.modules:['mathjs'] triggers a SizeAdmissionError — the defaults (184 KB) plus mathjs (632 KB) = 816 KB > 500 KB cap. In practice mathjs is unreachable via the stdlib injection path. A user could try await use('mathjs') via CDN, but mathjs is large and CDN use() requires the host on the allowlist. The opt-in flag exists but the guard makes it unloadable.  
  *mechanism:* stdlib inject — esbuilt mathjs IIFE with create(all); opt-in in stdlib-meta; SizeAdmissionError blocks it  
  *constraint:* 500 KB combined source cap (kernel-glue.ts:931, MAX_STDLIB_SOURCE_BYTES=512000); mathjs alone=632 KB > cap; monotonic memory OOM cliff at 24-30 MB raw drives the cap  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (optIn includes mathjs, sizes.mathjs=631999), apps/kernel/src/kernel-glue.ts:931 (MAX_STDLIB_SOURCE_BYTES=500*1024=512000), apps/kernel/src/kernel-glue.ts:1299-1302 (total > MAX_STDLIB_SOURCE_BYTES -> SizeAdmissionError), apps/kernel/src/kernel-glue.ts:963 (resolveStdlibModules adds defaults to any extras, making total 184+632=816 KB), docs/results/v0.6-stdlib.md:122 (mathjs OPT-IN ONLY, 20.6 MB heap 29x amplification, trips OOM cliff)
- **isomorphic-git (v1.27.1)** `[partial]` — api: `require('isomorphic-git') / globalThis.git`  
  Full isomorphic-git bundle (214 872 bytes) with clone, commit, push, pull, fetch, init, log, status, statusMatrix, add, branch, checkout, merge, diff, readBlob all present. Proven live: git.clone of a public GitHub repo works over the binary-safe host.fetch. Divergences: (1) opt-in only — must name in config.modules; fits within 500 KB cap (defaults 184 KB + git 216 KB = 400 KB < 500 KB). (2) The in-heap VFS has no real symlinks: readlink throws EINVAL, symlink stores the target as a file (no OS-level symlink). (3) push to private repos requires passing onAuth credentials in-cell — no credential store; user must supply tokens explicitly. (4) requires the git remote host on config.fetch allowlist. (5) All git timestamps use the seeded clock, so commit timestamps are synthetic.  
  *mechanism:* stdlib inject — esbuilt isomorphic-git CJS IIFE (all deps inlined) + isomorphic-git-http smart-HTTP client; I/O via host.fetch (binary-safe); VFS = in-heap fs  
  *constraint:* opt-in (opt-in flag in stdlib-meta); git host must be on fetch allowlist; VFS symlink limitation (no real OS symlinks in QuickJS heap VFS)  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (optIn includes isomorphic-git, sizes.isomorphic-git=214872), apps/kernel/stdlib-src/isomorphic-git.js (import * from isomorphic-git, globalThis.git=mod), apps/kernel/stdlib-src/isomorphic-git-http.js (http.request over host.fetch, binary Uint8Array bodies), apps/kernel/engine/src/lib.rs:2396-2536 (VFS: lstat=stat alias, readlink throws EINVAL, symlink stores as file), docs/decisions.md:174-193 (ADR-0012: binary-safe fetch + git proven live, clone of public repo works)
- **net (Node-shaped TCP client shim)** `[partial]` — api: `require('net') / require('node:net')`  
  net.Socket (Duplex-based), net.createConnection, net.connect, net.isIP/isIPv4/isIPv6 all implemented. The real TCP socket lives DO-side via cloudflare:sockets; VM holds only an integer handle token. Notable divergences: (1) net.Server / createServer / listen throw NotSupportedError (EPERM) — inbound connections impossible. (2) No inactivity timers: setTimeout on a socket is accepted but never fires a 'timeout' event (cloudflare:sockets has no inactivity timeout). (3) Max 6 concurrent outbound connections per invocation (cloudflare:sockets cap) — 7th gets EMFILE. (4) Live sockets die on DO eviction — stale handleIds return ECONNRESET on cold restore. (5) setNoDelay/setKeepAlive are no-ops.  
  *mechanism:* stdlib inject — pure-JS shim in stdlib-src/shims/net.js; real TCP via host['socket.open/read/write/close'] (cloudflare:sockets DO-side)  
  *constraint:* no listen socket on CF Workers DO (no inbound TCP); 6-connection invocation cap from cloudflare:sockets  
  *evidence:* apps/kernel/stdlib-src/shims/net.js:1-563 (full shim; server throws EPERM, max 6 sockets, stale-handle ECONNRESET), apps/kernel/src/stdlib-meta.ts:2 (versions.net='builtin', sizes.net=9585, in defaults)
- **tls (Node-shaped TLS client shim)** `[partial]` — api: `require('tls') / require('node:tls')`  
  tls.connect (TLS-from-start and STARTTLS upgrade paths both implemented), tls.TLSSocket constructor alias, checkServerIdentity (no-op, host validates), getCiphers returns []. Cert/key/ca options are accepted but IGNORED — TLS terminates host-side in cloudflare:sockets; the VM never sees key material. authorized is always true on a successful handshake. getProtocol() returns 'TLSv1.3' (nominal, not negotiated from VM). getPeerCertificate returns {}. exportKeyingMaterial throws NotSupportedError. tls.Server / createServer throw NotSupportedError. Same 6-connection and stale-handle limits as net.  
  *mechanism:* stdlib inject — pure-JS shim in stdlib-src/shims/tls.js; layers on net shim; TLS negotiated host-side via cloudflare:sockets secureTransport:'on' or startTls()  
  *constraint:* TLS terminates host-side (cloudflare:sockets), cert material not exposed to VM; no listen socket  
  *evidence:* apps/kernel/stdlib-src/shims/tls.js:1-143 (cert opts ignored, authorized=true, getPeerCertificate={}, exportKeyingMaterial throws), apps/kernel/src/stdlib-meta.ts:2 (versions.tls='builtin', sizes.tls=2535, in defaults)
- **ramda — absent** `[absent]` — api: `require('ramda') / globalThis.R`  
  Was SAFE DEFAULT in the v0.6 JS kernel study (0.88 MB heap, compatible with QuickJS). Not included in the Rust kernel stdlib bundle. The stdlib-meta.ts lists only: lodash, dayjs, nanoid, uuid, zod (defaults) + mathjs, isomorphic-git* (opt-in). Users must use await use('ramda') from CDN.  
  *mechanism:* not built — source entry file deleted in 7973c9e cleanup; not in stdlib.bundle.txt  
  *constraint:* deliberate scope reduction when porting to Rust kernel; not technically impossible  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (modules list does not include ramda), apps/kernel/src/stdlib.bundle.txt (no ramda key), git show 7973c9e -- apps/kernel/stdlib-src/lodash.js (cleanup deleted all individual lib source entries), docs/results/v0.6-stdlib.md:112 (ramda SAFE DEFAULT in JS kernel)
- **date-fns — absent** `[absent]` — api: `require('date-fns') / import from 'date-fns'`  
  Was SAFE DEFAULT in v0.6 study (1.0 MB heap). Not in Rust kernel bundle. Users must use await use('date-fns') via CDN.  
  *mechanism:* not built — no source entry or bundle key in current Rust kernel  
  *constraint:* deliberate scope reduction; not technically impossible  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (not in modules list), apps/kernel/src/stdlib.bundle.txt (no date-fns key), docs/results/v0.6-stdlib.md:111 (date-fns SAFE DEFAULT)
- **immer — absent** `[absent]` — api: `require('immer') / globalThis.immer`  
  Was SAFE DEFAULT in v0.6 study (0.19 MB heap, smallest of the safe set). Not in Rust kernel bundle.  
  *mechanism:* not built — no source entry or bundle key in current Rust kernel  
  *constraint:* deliberate scope reduction; not technically impossible  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (not in modules list), apps/kernel/src/stdlib.bundle.txt (no immer key), docs/results/v0.6-stdlib.md:113 (immer SAFE DEFAULT)
- **decimal.js — absent** `[absent]` — api: `require('decimal.js') / globalThis.Decimal`  
  Was SAFE DEFAULT in v0.6 study (0.38 MB heap). Not in Rust kernel bundle.  
  *mechanism:* not built — no source entry or bundle key in current Rust kernel  
  *constraint:* deliberate scope reduction; not technically impossible  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (not in modules list), apps/kernel/src/stdlib.bundle.txt (no decimal.js key), docs/results/v0.6-stdlib.md:114 (decimal.js SAFE DEFAULT)
- **js-yaml — absent** `[absent]` — api: `require('js-yaml') / globalThis.jsyaml`  
  Was SAFE DEFAULT in v0.6 study (0.5 MB heap). Not in Rust kernel bundle. The stdlib injection comment at kernel-glue.ts:1315 mentions 'Map common name->global-var mismatches (js-yaml->jsyaml etc.)' — indicating it was planned but never ported to the Rust kernel.  
  *mechanism:* not built — name->global alias logic is present in kernel-glue.ts but no js-yaml bundle key exists  
  *constraint:* deliberate scope reduction; not technically impossible  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (not in modules list), apps/kernel/src/stdlib.bundle.txt (no js-yaml key), apps/kernel/src/kernel-glue.ts:1315 (comment references js-yaml->jsyaml alias, dead code), docs/results/v0.6-stdlib.md:116 (js-yaml SAFE DEFAULT)
- **papaparse — absent** `[absent]` — api: `require('papaparse') / globalThis.Papa`  
  Was SAFE DEFAULT in v0.6 study (0.25 MB heap). Not in Rust kernel bundle.  
  *mechanism:* not built — no source entry or bundle key in current Rust kernel  
  *constraint:* deliberate scope reduction; not technically impossible  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (not in modules list), apps/kernel/src/stdlib.bundle.txt (no papaparse key), docs/results/v0.6-stdlib.md:117 (papaparse SAFE DEFAULT)
- **marked — absent** `[absent]` — api: `require('marked') / globalThis.marked`  
  Was SAFE DEFAULT in v0.6 study (0.63 MB heap). Not in Rust kernel bundle.  
  *mechanism:* not built — no source entry or bundle key in current Rust kernel  
  *constraint:* deliberate scope reduction; not technically impossible  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (not in modules list), apps/kernel/src/stdlib.bundle.txt (no marked key), docs/results/v0.6-stdlib.md:118 (marked SAFE DEFAULT)
- **rxjs — absent** `[absent]` — api: `require('rxjs') / globalThis.rxjs`  
  Was tested as 'OK' in v0.6 study (1.06 MB heap — larger than most; was in recommended 13-lib set). Not in Rust kernel bundle.  
  *mechanism:* not built — no source entry or bundle key in current Rust kernel  
  *constraint:* deliberate scope reduction; not technically impossible  
  *evidence:* apps/kernel/src/stdlib-meta.ts:2 (not in modules list), apps/kernel/src/stdlib.bundle.txt (no rxjs key), docs/results/v0.6-stdlib.md:121 (rxjs OK)

### globals (globalThis/global, REPL top-level decl persistence, error stack/determinism)

- **globalThis** `[real]` — api: `globalThis (ECMAScript global object reference)`  
  QuickJS natively exposes globalThis. The engine assigns nothing unusual to it; it is the real top-level scope object. All bootstrap values are written to it and survive snapshot/restore because the heap is blit-restored.  
  *mechanism:* native QuickJS runtime; no shim needed  
  *constraint:* none — this is a stock ECMAScript feature of QuickJS  
  *evidence:* apps/kernel/engine/src/lib.rs:765 (globalThis.global = globalThis), apps/kernel/engine/src/lib.rs:197 (BOOTSTRAP constant, dozens of globalThis.X = … assignments)
- **global (Node alias for globalThis)** `[real]` — api: `global (the legacy Node-specific synonym for globalThis)`  
  global === globalThis is set explicitly at bootstrap. Mutations to global.X immediately appear on globalThis.X and vice versa, matching Node semantics exactly.  
  *mechanism:* pure-JS bootstrap: `globalThis.global = globalThis` at BOOTSTRAP runtime  
  *constraint:* none — trivial alias  
  *evidence:* apps/kernel/engine/src/lib.rs:765
- **REPL top-level var persistence** `[real]` — api: `Node REPL: var declarations at the top level persist across cells`  
  Top-level var in a non-await cell lands in indirect global eval (`(0,eval)(src)`), which makes var a global property in non-strict mode. Fully matches Node REPL var persistence semantics.  
  *mechanism:* indirect global eval path (mode 'global') in install_cell; no transform needed for var  
  *constraint:* indirect eval in non-strict mode is the only path that globalises var without a source rewrite; QuickJS honours this  
  *evidence:* apps/kernel/engine/src/lib.rs:3526-3528 (mode 'global', `(0,eval)(src)`)
- **REPL top-level let/const/function/class persistence** `[real]` — api: `Node REPL: let/const/function/class at the top level persist to subsequent cells`  
  A host-side pre-eval source transform (`transformCell`) rewrites: `let x = e` → `x = e` (globalises); `const x = e` → `x = e`; `function f(){…}` → `globalThis['f'] = function f(){…};` hoisted; `class C{…}` → `globalThis['C'] = class C{…};`. Brace-depth-0 only. Falls back to ORIGINAL source on any ambiguity (unbalanced, generator, async function, export, unrecognised declarator) — those cells then use indirect eval and let/const/class may NOT persist. Known gaps: `async function f(){}` at depth-0 is a BAIL → f does not persist; `export` keyword is a BAIL → export cells silently don't persist. These are uncommon in interactive use.  
  *mechanism:* host-side pure-JS tokenizer/source-rewrite in apps/kernel/src/repl-transform.ts, applied in kernel-glue.ts before the source is sent to the engine  
  *constraint:* QuickJS indirect eval gives depth-0 let/const/class their own lexical scope (not globalThis), exactly as V8 strict mode does — the rewrite is the only way to persist them without a VM patch  
  *evidence:* apps/kernel/src/repl-transform.ts:1-26 (problem statement and fix description), apps/kernel/src/repl-transform.ts:192 (bail on async function / export), apps/kernel/src/repl-transform.ts:251 (bail on generator function*), apps/kernel/src/repl-transform.ts:252 (bail on anonymous / default), apps/kernel/src/kernel-glue.ts:1573-1578 (transformCell call site)
- **REPL top-level async function declaration persistence** `[stub-unacceptable]` — api: `Node REPL: `async function f(){}` at top level persists across cells`  
  The transformCell tokenizer explicitly BAILs when it sees `async` immediately before a `function`/`class` keyword at depth-0 (`pendingAsyncOrExport = true` → bail). The cell then falls through to indirect global eval, where `async function f(){}` creates a locally-scoped binding that VANISHES after the cell. `f` is undefined in the next cell. Node REPL persists it. This is silent: no error is thrown, eval succeeds, the function just doesn't persist.  
  *mechanism:* repl-transform.ts bail path (line 192) → indirect global eval → lexical scope lost  
  *constraint:* The tokenizer conservatively bails on async+function to avoid misrewriting `async function*` or `async` as a variable name; fixing it would require more lookahead  
  *evidence:* apps/kernel/src/repl-transform.ts:25 (comment: 'async function' → bail), apps/kernel/src/repl-transform.ts:192 (bail on pendingAsyncOrExport before a KW), apps/kernel/src/repl-transform.ts:208 (sets pendingAsyncOrExport=true on 'async')
- **REPL top-level export declaration persistence** `[stub-unacceptable]` — api: `Node REPL: export declarations at top level (not standard but tolerated in some envs)`  
  transformCell bails on the `export` keyword at depth-0 (same pendingAsyncOrExport bail path). `export const x = 1` or `export function f(){}` inside a cell: the bail means x/f are not rewritten to globalThis, so they don't persist. The cell runs through indirect eval, which also rejects `export` as a SyntaxError. The user sees a SyntaxError rather than a persistence failure, which is at least noisy. Node does not support export at the REPL top level either, so this is NOT a Node-parity gap — but users who paste ES-module code will see SyntaxErrors.  
  *mechanism:* repl-transform.ts bail path (line 192) → indirect eval → QuickJS SyntaxError on export  
  *constraint:* QuickJS indirect eval forbids module syntax; engine does support ESM via Module::declare but that path is only taken by use()/ESM-specific path, not the normal cell eval  
  *evidence:* apps/kernel/src/repl-transform.ts:192 (bail on pendingAsyncOrExport, which includes 'export'), apps/kernel/engine/src/lib.rs:2225 (excluded: 'repl' module — nesting unsupported)
- **REPL _ (last cell completion value)** `[real]` — api: `Node REPL: _ holds the last evaluated expression value`  
  After each cell, if the completion value is not undefined, `globalThis._ = r` is executed. _ persists in the heap across cells and across hibernate/restore (snapshot-persisted). Matches Node REPL _ semantics; the only minor divergence is that Node REPL also sets _ on explicit assignments to _ (and warns), whereas here _ is a plain globalThis property that can be overwritten without warning.  
  *mechanism:* inline assignment in install_cell driver JS: `if (r !== undefined) globalThis._ = r`  
  *constraint:* none — pure in-VM global assignment  
  *evidence:* apps/kernel/engine/src/lib.rs:3531-3532
- **REPL reserved-host-global shadowing (const crypto = require('crypto') etc.)** `[real]` — api: `Node: `const crypto = require('crypto')` in a module creates a local binding that shadows the global`  
  transformCell detects declarations that bind a RESERVED_HOST_GLOBALS name (crypto, fetch, host, process, console, Buffer, require, use, performance, globalThis) and keeps them LEXICAL (cell-local), so they shadow the host primitive inside the cell without clobbering globalThis. The host primitive remains intact in subsequent cells. The cost: that specific name does not persist to later cells (re-require it). This matches the intent of module-scoped require() in Node.  
  *mechanism:* repl-transform.ts RESERVED_HOST_GLOBALS set + keepLexical path  
  *constraint:* If crypto were globalized it would self-recurse (globalThis.crypto.getRandomValues delegates to itself → stack overflow, surfaced as RuntimeError: unreachable) — the keep-lexical path is a correctness guard  
  *evidence:* apps/kernel/src/repl-transform.ts:30-47 (RESERVED_HOST_GLOBALS and rationale), apps/kernel/src/repl-transform.ts:294 (declListBindsReserved → keepLexical), apps/kernel/src/repl-transform.ts:260 (function/class reserved name → keepLexical)
- **error.stack property** `[stub-unacceptable]` — api: `Error.prototype.stack (V8 format: 'ErrorType: message\n    at fn (file:line:col)\n...')`  
  QuickJS provides error.stack but uses its own format: `ErrorType: message\n    at functionName (file:lineNumber)` without column numbers, without `<anonymous>` for unnamed functions in the same way V8 does it, and without native-frame markers. The `error.stack` is propagated and serialised correctly (engine/src/lib.rs:3305-3307), so it is NOT absent — but code that parses V8 stack frames (source-map libraries, error reporters like Sentry, `callsites`, `stack-trace`, `stackframe`, any library using `Error.captureStackTrace`) will fail or produce wrong output. The stack IS present and useful for human reading; it just diverges from V8 format.  
  *mechanism:* QuickJS native error.stack; serialised via `e.stack||''` in cell error handler  
  *constraint:* QuickJS is not V8 — its stack format is engine-internal and cannot be changed without patching rquickjs/QuickJS-ng. No WASM or WASI hook available to intercept it.  
  *evidence:* apps/kernel/engine/src/lib.rs:3305-3307 (stack serialisation in cell error handler), apps/kernel/engine/src/lib.rs:3267 (stack: '' in early error path — Rust-side, stack may be empty string), apps/kernel/engine/src/lib.rs:2253 ('v8': 'no V8 engine internals (this is QuickJS)')
- **Error.prepareStackTrace / Error.captureStackTrace / Error.stackTraceLimit (V8 stack customization API)** `[absent]` — api: `Error.captureStackTrace(obj, ctorOpt), Error.prepareStackTrace(err, structuredFrames), Error.stackTraceLimit`  
  None of these V8-specific APIs are shimmed or present. grep across all kernel source files returns zero hits. Libraries that depend on them (e.g. `callsites`, `stack-trace`, Sentry's SDK, `source-map-support`, `@babel/register`) will throw TypeError: Error.captureStackTrace is not a function or silently produce no structured frames. This is a hard gap for any stack-augmentation or source-map tooling.  
  *mechanism:* absent — no shim exists anywhere in apps/kernel/  
  *constraint:* These are V8 internals that expose structured CallSite objects. QuickJS has no equivalent internal API; adding stubs that return empty arrays or throw would require patching rquickjs. The 12-import WASM ceiling does not block it, but the QuickJS engine has no hook to enumerate JS call frames from JS code.  
  *evidence:* apps/kernel/engine/src/lib.rs:2253 ('v8': 'no V8 engine internals (this is QuickJS). Alternative: none.'), (grep for prepareStackTrace/captureStackTrace/stackTraceLimit across entire apps/kernel/ returns no results)
- **Stack depth / recursion guard (RangeError on stack overflow)** `[real]` — api: `Node: deep recursion throws RangeError: Maximum call stack size exceeded`  
  rquickjs's set_max_stack_size(256*1024) makes QuickJS throw an `InternalError: stack overflow` (which surfaces as a RangeError-class error) before the 8 MiB native WASM stack is exhausted. The JS guard is catchable. The name is `InternalError` not `RangeError`, which some Node code checks, but the error IS catchable with a plain try/catch. Depth budget: ~256 KB JS stack vs. Node's ~10k frames — shallower than Node (default Node stack ~984 frames for simple recursion; here measurably smaller given 256 KB JS guard).  
  *mechanism:* rquickjs rt.set_max_stack_size(256*1024) + 8 MiB WASM native stack configured via -zstack-size=8388608 in engine/.cargo/config.toml  
  *constraint:* WASM linear memory is monotonic; a stack overflow that corrupts the WASM stack would be unrecoverable. The JS guard must fire before the native overflow. The 256 KB limit is conservative for safety (docs: 'sweet spot; re-tune ONLY in lockstep with native stack size').  
  *evidence:* apps/kernel/engine/src/lib.rs:3020-3034 (stack guard rationale + set_max_stack_size(256*1024))
- **Deterministic error stack across restore** `[real]` — api: `Node: error.stack lines include stable file/line references across process restarts`  
  error.stack lines reference cell source positions, which are determined by the source string, not by wall-clock or session state. A cell evaled before hibernate produces the same stack after restore because the source is identical. This is an accidental property of QuickJS's approach (no JIT, no address-space randomisation in stack frames). The stack format itself is QuickJS-flavoured (see above), but it is deterministic.  
  *mechanism:* QuickJS engine source-position tracking; seeded clock/rng do not affect stack frames  
  *constraint:* determinism requirement (ADR-0002 heap-snapshot); QuickJS has no JIT so no ASLR-induced address variation in stack frames  
  *evidence:* apps/kernel/engine/src/lib.rs:183 (determinism section header), apps/kernel/engine/src/lib.rs:3305-3307 (e.stack propagated verbatim)
- **globalThis.window / globalThis.self (browser globals)** `[absent]` — api: `Node: window is undefined (not set); browser: window === self === globalThis`  
  Neither `window` nor `self` are assigned to globalThis. This matches Node (window is undefined in Node). Libraries that gate on `typeof window !== 'undefined'` to detect browser environment will correctly fall through to the Node path. Libraries that assume `self` exists (some WebWorker-targeting code) will get ReferenceError unless they guard it.  
  *mechanism:* absent by design — Node compatibility target  
  *constraint:* None blocking. Could be added. The absence is intentional: the facade targets Node, not browser.  
  *evidence:* apps/kernel/engine/src/lib.rs:765 (only `global` alias is set, no `window` or `self`)
- **process.version / process.versions.node identity** `[stub-acceptable]` — api: `process.version === 'v20.11.1'; process.versions.node === '20.11.1'`  
  Hardcoded to Node v20.11.1 strings (process.version, process.versions). process.versions also contains v8, uv, zlib, openssl entries with plausible values plus a 'quickjs' and 'engram' entry that expose the truth. Code that gates on `process.version` for feature detection (e.g. `semver.gte(process.versions.node, '18')`) will pass correctly. Code that tries to use actual V8 features based on the version string will fail at runtime rather than at the version check — but that is the correct failure mode.  
  *mechanism:* pure-JS bootstrap: hardcoded strings in process object at BOOTSTRAP runtime  
  *constraint:* none; these are identity strings, not functional APIs  
  *evidence:* apps/kernel/engine/src/lib.rs:790-791 (p.version + p.versions assignments)

### Tier-1 worker-loader registry (registerWorker/invokeWorker, env.VFS) + Tier-2 sandbox container (exec/git/expose)

- **worker-register (s.registerWorker / {t:'worker-register'})** `[real]` — api: `No Node equivalent — content-addressed Worker-Loader isolate registry, analogous to dynamic require() of a remote module`  
  Genuine: sha256 content-address, idempotent R2 store, per-session invite gate (registry_workers SQLite row). Source cap 512KB. Cached=true if already registered by this session.  
  *mechanism:* host-call: WS frame {t:'worker-register', source} -> lib.rs worker_register() -> sha256_hex -> R2 put at workers/<hash>.js -> SQLite upsert into registry_workers  
  *constraint:* Workers Paid plan required (env.LOADER binding). R2 write on every new source; SQLite gate per session. Source cap mirrors 500KB stdlib culture.  
  *evidence:* apps/kernel/src/lib.rs:1596-1651, apps/kernel/src/lib.rs:2351, packages/sdk/src/index.ts:1735-1752
- **worker-invoke (s.invokeWorker / {t:'worker-invoke'})** `[real]` — api: `No Node equivalent — runs a registered JS module in a fresh Worker-Loader isolate with a scoped VFS, analogous to a remote RPC with dynamic code execution`  
  Genuine: loads source from R2, runs via env.LOADER.get(codeId, cb) in a fresh isolate, races a wall timeout, reconciles fs_files after invoke. Output cap 1MB JSON. Input cap 1MB JSON. cpuMs cap 60000, timeoutMs cap 120000. Both user contracts (export run(input,env) and export default {fetch}) are supported via the HARNESS_SRC adapter.  
  *mechanism:* host-call: WS frame -> lib.rs worker_invoke() -> R2 GET source -> kernel-glue.ts registryInvoke() -> LOADER.get(codeId, cb) -> stub.getEntrypoint().fetch(POST inputBytes) -> response text -> lib.rs reconcile_fs_files()  
  *constraint:* Workers Paid plan required (LOADER binding). VfsGateway requires enable_ctx_exports compat flag. globalOutbound:null enforced — no fetch/connect egress inside the worker. WASM runtime compile blocked (CompiledWasm delivery used instead). Warm-cache keyed on doIdShort+hash to prevent cross-session isolate reuse.  
  *evidence:* apps/kernel/src/lib.rs:1654-1841, apps/kernel/src/lib.rs:2352, apps/kernel/src/kernel-glue.ts:474-554, apps/kernel/src/kernel-glue.ts:387-434 (HARNESS_SRC), apps/kernel/src/kernel-glue.ts:531 (globalOutbound:null)
- **worker-list (s.listWorkers / {t:'worker-list'})** `[real]` — api: `No Node equivalent`  
  Returns only this session's registry_workers rows (hash, bytes, createdMs). NOT the global R2 namespace — isolation preserved.  
  *mechanism:* host-call: WS frame -> lib.rs worker_list() -> SQLite SELECT on registry_workers  
  *constraint:* Per-session isolation: reads only the DO's own SQLite rows.  
  *evidence:* apps/kernel/src/lib.rs:1843-1865, apps/kernel/src/lib.rs:2353, packages/sdk/src/index.ts:1776-1784
- **env.VFS (VfsGateway: readFile / readFileBytes / writeFile / deleteFile / list)** `[real]` — api: `Analogous to Node fs module, but R2-backed, path-isolated, and injected as env.VFS into each worker-loader isolate`  
  Genuine R2-backed CRUD: readFile returns UTF-8 string or null; readFileBytes returns ArrayBuffer or null; writeFile accepts string/ArrayBuffer/ArrayBufferView; deleteFile is best-effort; list returns leading-slash paths under prefix. Path normalization matches kernel's norm_fs_path exactly (resolveWs from @engram/fs). Path escape via '..' throws FsPathError. No streaming reads or partial range reads. No metadata (mtime/mode). Not POSIX — no rename, no hardlinks, no atomic ops.  
  *mechanism:* WorkerEntrypoint class (VfsGateway in entry.ts) instantiated via ctx.exports.VfsGateway({props:{doId}}); doId is the TRUSTED kernel state.id(), never chosen by the dynamic worker. Injected as env.VFS into Worker-Loader isolate at kern-glue.ts:530.  
  *constraint:* enable_ctx_exports compat flag required. Worker-rs wasm-bindgen boundary passes ctx as NULL so env.VfsGateway is resolved out-of-band via globalThis.__ENGRAM_DO_CTX map keyed by trusted doId. Fails closed (RegistryUnavailableError) if map misses — never hands the worker the raw R2 bucket.  
  *evidence:* apps/kernel/entry.ts:41-119, apps/kernel/entry.ts:122-147 (__ENGRAM_DO_CTX capture), apps/kernel/src/kernel-glue.ts:493-533, apps/kernel/wrangler.jsonc:13 (enable_ctx_exports flag)
- **VFS post-invoke reconciliation (fs_files sync after worker invoke)** `[real]` — api: `No Node equivalent — internal coherence mechanism`  
  After each worker-invoke, lib.rs acquires the mutex and runs reconcile_fs_files() which re-lists R2 under fs/<doId>/ and upserts/deletes fs_files SQLite rows. This makes gateway-written files visible to a later cell's host.fs / vfs-* without an explicit vfs-sync call.  
  *mechanism:* host-call post-processing: lib.rs:1792-1801 acquires self.mutex, calls reconcile_fs_files()  
  *constraint:* Mutex required to avoid interleaving with an eval's staged flush. Gateway writes are immediate-durable (outside staged-commit); reconcile is the only indexing step.  
  *evidence:* apps/kernel/src/lib.rs:1792-1801, apps/kernel/src/lib.rs:2045
- **vfs-sync frame (explicit VFS reconcile)** `[real]` — api: `No Node equivalent`  
  The explicit {t:'vfs-sync'} frame triggers the same reconcile_fs_files() path. Returns {ok:true, files:[{path,size}]} of all committed files. Needed when a container op writes to R2 directly and a cell needs to see the result without an intervening invoke.  
  *mechanism:* host-call: WS frame -> lib.rs vfs_sync() -> mutex acquire -> reconcile_fs_files() -> read_fs_committed()  
  *constraint:* Mutex prevents interleave with in-progress eval; container->cell half of the shared VFS.  
  *evidence:* apps/kernel/src/lib.rs:1564-1578, apps/kernel/src/lib.rs:2343
- **Worker isolation: globalOutbound:null (no egress from hash-worker)** `[real]` — api: `No Node equivalent — Cloudflare Worker-Loader-specific capability restriction`  
  Genuine: globalOutbound:null is passed to LOADER.get() callback, so fetch()/connect() throw inside the loaded isolate. The worker's only I/O channel is env.VFS (the prefix-isolated R2 gateway). This is enforced by the Workers runtime, not by userland code.  
  *mechanism:* Worker-Loader API option: kernel-glue.ts:531 passes globalOutbound:null in the loader callback  
  *constraint:* Workers Paid / Worker-Loader API. Without it a hash-worker could exfiltrate data or do SSRF.  
  *evidence:* apps/kernel/src/kernel-glue.ts:531
- **Worker CPU cap (cpuMs per invoke)** `[real]` — api: `No Node equivalent`  
  cpuMs (default 5000, max 60000) is passed as limits.cpuMs in the loader callback AND in getEntrypoint opts. Exceeding it throws immediately inside the worker (WorkerCode-level cap). Wall timeout (timeoutMs, default 30000, max 120000) is also raced by lib.rs via race_timeout.  
  *mechanism:* Worker-Loader limits API: kernel-glue.ts:532 (callback), :535 (getEntrypoint). lib.rs:1767 race_timeout for wall clock.  
  *constraint:* Worker-Loader API. Isolate startup counts against cpuMs.  
  *evidence:* apps/kernel/src/kernel-glue.ts:532-535, apps/kernel/src/lib.rs:1686-1698, apps/kernel/src/lib.rs:1767-1789
- **sandbox.exec (s.sandbox.exec / host.sandbox.exec — run shell command in Linux container)** `[real]` — api: `Analogous to child_process.exec / child_process.execSync, but in a remote Linux container`  
  Genuine: runs arbitrary shell cmd in the @cloudflare/sandbox Linux container (cwd defaults to /workspace). Returns {stdout, stderr, exitCode, success}. Output is fully buffered (not streamed). No stdin injection. cwd must be absolute; relative paths not normalized server-side. Container sleeps after 10-min idle and cold-restarts (ephemeral process state, durable R2 data).  
  *mechanism:* host-call (from cell: kernel-glue.ts:1796 -> _doSandbox -> DO-side fetch to ENGRAM_SANDBOX_URL/exec) or SDK frame {t:'sandbox', op:'exec'} -> lib.rs sandbox_frame() -> DO-side fetch to engram-sandbox /exec -> sandbox.exec(cmd, {cwd}) -> {stdout,stderr,exitCode}  
  *constraint:* config.sandbox:true required. ENGRAM_SANDBOX_URL + ENGRAM_SANDBOX_KEY must be set in kernel env. Workers Paid plan + @cloudflare/sandbox DO. Container is ephemeral; mount is re-established via ensureSessionMount() on every request (idempotent mountpoint -q check).  
  *evidence:* apps/kernel/src/lib.rs:1910-1917, apps/kernel/src/kernel-glue.ts:1854-1860, apps/sandbox/src/index.ts:201-210, packages/sdk/src/index.ts:1271-1284
- **sandbox exec-stream (execStream / SSE streaming stdout)** `[partial]` — api: `Analogous to child_process stdout stream, or child_process.spawn streaming`  
  The engram-sandbox container worker implements /exec-stream (POST, returns SSE ReadableStream) using sandbox.execStream(). However, this route is NOT wired through the kernel WS frame dispatch (lib.rs has no 'exec-stream' case, sandbox_frame() only maps 'exec'). It is also NOT exposed in the SDK's s.sandbox surface. It exists only as a raw HTTP endpoint on engram-sandbox that callers could hit directly — but not through the normal cell/SDK path.  
  *mechanism:* HTTP-only: apps/sandbox/src/index.ts:213-221 handles /exec-stream directly. Not wired in lib.rs sandbox_frame() dispatch or kernel-glue.ts _doSandbox.  
  *constraint:* WS frame dispatch is request-response (id-correlated). Streaming SSE cannot traverse the existing {t:'sandbox'} WS frame protocol without protocol changes.  
  *evidence:* apps/sandbox/src/index.ts:213-221, apps/kernel/src/lib.rs:1909-1964 (no exec-stream case)
- **sandbox.git (s.sandbox.git / host.sandbox.git — git checkout into workspace)** `[partial]` — api: `No direct Node equivalent — git CLI via container, analogous to child_process.exec('git clone ...')`  
  Only the 'checkout' (clone) operation is implemented. sandbox.gitCheckout(repo, {branch, targetDir, depth:1}) is the single wired path. Any other op field value returns {error:'unsupported git op'} from the sandbox worker. So git push, pull, commit, status, diff, etc. are all absent — only shallow clone into the workspace is supported. The SDK and kernel-glue both pass gitOp through, but sandbox/index.ts gates on body.op==='checkout'.  
  *mechanism:* host-call or WS frame -> lib.rs sandbox_frame() op='git' -> DO fetch to engram-sandbox /git -> sandbox.gitCheckout(repo, {branch, targetDir, depth:1})  
  *constraint:* @cloudflare/sandbox SDK only exposes gitCheckout on the Sandbox DO type as of this implementation. Other git ops would require sandbox.exec('git ...') instead.  
  *evidence:* apps/sandbox/src/index.ts:225-245 (only checkout branch), apps/kernel/src/lib.rs:1919-1929, apps/kernel/src/kernel-glue.ts:1862-1867, packages/sdk/src/index.ts:1285-1293
- **sandbox.expose (s.sandbox.expose / host.sandbox.expose — expose container port)** `[real]` — api: `No Node equivalent — expose a container's listening port as a public preview URL (analogous to ngrok/cloudflared tunnel)`  
  Genuine: sandbox.exposePort(port, {hostname}) returns a preview URL object. The URL is ephemeral (container cold-restart invalidates it). The SDK surface returns {url?: string} & Record<string,unknown>. Not exposed through the in-cell host.sandbox route list in kernel-glue.ts:1894-1898 — only via the SDK s.sandbox.expose path.  
  *mechanism:* WS frame {t:'sandbox', op:'expose', port} -> lib.rs sandbox_frame() -> DO fetch to engram-sandbox /expose -> sandbox.exposePort(port, {hostname})  
  *constraint:* @cloudflare/sandbox exposePort API. URL is tied to live container; 10-min idle invalidates it.  
  *evidence:* apps/sandbox/src/index.ts:294-299, apps/kernel/src/lib.rs:1950-1953, apps/kernel/src/kernel-glue.ts:1894-1898, packages/sdk/src/index.ts:1320-1327
- **sandbox.writeFile / sandbox.readFile / sandbox.list (files over sandbox)** `[stub-acceptable]` — api: `Analogous to fs.writeFile / fs.readFile / fs.readdir`  
  writeFile and readFile pass through to sandbox.writeFile/readFile via the container's /files route; list uses sandbox.listFiles. All ops go through ensureSessionMount first so they operate on the R2-backed /workspace. Content is string-only (no binary for write via this path; readFile returns text). No mkdir, no delete, no rename, no stat, no mode/mtime. The sandbox.mkdir and sandbox.deleteFile routes exist on the container worker (/files POST with op:mkdir/delete) but are NOT wired through lib.rs sandbox_frame() or kernel-glue.ts _doSandbox — they are absent from the kernel/SDK surface. Use host.fs or sandbox.exec('mkdir ...'/'rm ...') instead.  
  *mechanism:* WS frame -> lib.rs sandbox_frame() -> DO fetch to engram-sandbox /files (GET for read/list, POST for write)  
  *constraint:* s3fs-over-R2 is NOT POSIX: no rename-atomicity, weak consistency, no lockfiles. Sandbox writes go directly to R2; fs_files SQLite index updated only by vfs-sync or next worker-invoke reconcile.  
  *evidence:* apps/sandbox/src/index.ts:247-279 (mkdir+delete wired in sandbox but not in kernel dispatch), apps/kernel/src/lib.rs:1930-1960 (only 'write','read','list','expose','mount','unmount' ops handled), packages/sdk/src/index.ts:1294-1318
- **sandbox.mount / sandbox.unmount (explicit R2 mount lifecycle)** `[real]` — api: `No Node equivalent`  
  mount triggers ensureSessionMount (idempotent mountpoint -q check + s3fs mount) and returns {ok:true, mountPath, prefix}. unmount calls sandbox.unmountBucket. Both are wired through lib.rs sandbox_frame() and kernel-glue.ts _doSandbox. NOT exposed in the SDK's s.sandbox typed surface (the TS interface only declares exec/git/writeFile/readFile/list/expose), but can be sent as raw frames via the WS.  
  *mechanism:* WS frame {t:'sandbox', op:'mount'|'unmount'} -> lib.rs sandbox_frame() -> DO fetch to engram-sandbox /mount or /unmount  
  *constraint:* s3fs stacking bug: calling mount on an already-live container stacks a second s3fs (corrupts buffered writes). The mountpoint -q guard prevents double-mount but requires the container exec permission.  
  *evidence:* apps/kernel/src/lib.rs:1955-1959, apps/kernel/src/kernel-glue.ts:1901-1907, apps/sandbox/src/index.ts:281-291, packages/sdk/src/index.ts:1174-1193 (mount/unmount absent from typed surface)
- **Sandbox R2 VFS isolation (one container per session, prefix-scoped)** `[stub-unacceptable]` — api: `No Node equivalent`  
  CRITICAL ISOLATION CAVEAT documented in sandbox/src/index.ts:33-41: the R2 prefix (fs/<doId>/) is a PATH VIEW, not a credential scope. The container (via the egress-intercepting ContainerProxy) has access to the WHOLE engram-snapshots R2 bucket; the prefix only changes which keys appear at /workspace. A process inside the container that breaks out of s3fs and talks to the egress proxy directly (or an R2-aware library) is NOT confined to the session prefix. Isolation between sessions relies on (a) one Sandbox DO id per session and (b) this Worker only mounting that session's prefix — NOT on R2 ACLs. This diverges silently from the advertised 'session-scoped' isolation for untrusted multi-tenant workloads.  
  *mechanism:* s3fs-FUSE mount via @cloudflare/sandbox mountBucket('SANDBOX_R2', '/workspace', {prefix: '/fs/<doId>/'}) — prefix is path-view, not ACL  
  *constraint:* @cloudflare/sandbox credential-less mount model: ContainerProxy intercepts egress but applies no per-key ACL. The design requires one DO per session to be the isolation primitive.  
  *evidence:* apps/sandbox/src/index.ts:33-41 (explicit doc: not ACL-scoped), apps/sandbox/src/index.ts:76-79 (sessionPrefix function), apps/sandbox/src/index.ts:144-158 (mountBucket with prefix)
- **Sandbox container cold-start / ephemeral process state** `[partial]` — api: `No Node equivalent`  
  The container sleeps after 10-min idle and cold-restarts (ephemeral). The R2 data is durable. ensureSessionMount is called on every sandbox request to re-establish the mount after sleep. However, any in-memory state (running background processes, open file descriptors, environment variables set during a prior exec) is lost on cold restart. No keepAlive option is currently configured (commented out in sandbox/src/index.ts:195-197). This means long-running background processes (servers started via exec) are NOT durable across the idle timeout.  
  *mechanism:* @cloudflare/sandbox Sandbox DO with default sleepAfter '10m'. ensureSessionMount() called before every op.  
  *constraint:* @cloudflare/sandbox platform constraint. In-memory container state is ephemeral; only R2-backed /workspace is durable.  
  *evidence:* apps/sandbox/src/index.ts:28-30, apps/sandbox/src/index.ts:49-54, apps/sandbox/src/index.ts:193-197 (keepAlive commented out)
- **Worker-Loader warm-cache codeId isolation (doIdShort prefix)** `[real]` — api: `No Node equivalent — internal warm-cache dedup mechanism`  
  codeId is constructed as 'wkr1:<doIdShort>:<hash>' where doIdShort is the first 16 hex chars of the DO id. This ensures two sessions sharing a hash get SEPARATE warm isolates with SEPARATE VFS env bindings — the warm cache cannot leak session A's env.VFS into session B's invoke. The REGISTRY_ABI prefix ('wkr1') invalidates stale warm isolates on harness/env shape changes.  
  *mechanism:* kernel-glue.ts:520-521: doIdShort computed from trusted doId; codeId = REGISTRY_ABI+':'+doIdShort+':'+hash  
  *constraint:* Worker-Loader warm cache keys on codeId only. Without doIdShort prefix, two sessions with the same source would share an isolate and its env.VFS, allowing cross-session R2 reads/writes.  
  *evidence:* apps/kernel/src/kernel-glue.ts:517-521, apps/kernel/src/lib.rs:1589-1592 (comment on isolation invariant b)
- **In-cell host.sandbox.* (sandbox from within a VM cell)** `[real]` — api: `No Node equivalent`  
  Cells can call host.sandbox.exec(cmd), host.sandbox.git(...), host.sandbox.writeFile(...), host.sandbox.readFile(...), host.sandbox.list(...), host.sandbox.expose(port), host.sandbox.mount, host.sandbox.unmount. These are DO-side host effects (not in-VM compute): the VM issues a __hostCall which routes through kernel-glue.ts _doSandbox() -> DO-side fetch to engram-sandbox. The Bearer key and sandbox URL never enter the VM heap or any snapshot. Capability-gated: config.sandbox:true required.  
  *mechanism:* In-VM host-call: kernel-glue.ts:1796 routes 'sandbox.*' names to _doSandbox(). DO-side fetch to ENGRAM_SANDBOX_URL with Bearer key from _sandboxKey (never snapshotted).  
  *constraint:* config.sandbox:true capability gate. Key lives in DO-instance memory only, not in the WASM heap blit. In-cell sandbox calls hold the eval mutex, so they block other cells until the container responds.  
  *evidence:* apps/kernel/src/kernel-glue.ts:1793-1796, apps/kernel/src/kernel-glue.ts:1836-1910, apps/kernel/src/kernel-glue.ts:1081-1088 (set_sandbox_config storing url/key in instance memory)
- **Worker source persistence across session cold-restore** `[stub-unacceptable]` — api: `No Node equivalent`  
  The R2 source body (workers/<hash>.js) is global and persists indefinitely. BUT the per-session invoke gate (registry_workers SQLite row) lives in the DO's SQLite storage — which IS durable across cold-restore. So after a cold-restore, the session can still invoke hashes it registered before the eviction. HOWEVER: there is no explicit test cited in the codebase for registry_workers surviving cold-restore, and the SQLite store (like all DO storage) is eviction-durable by design. The subtle risk: if the DO is ever migrated or the schema is reset (e.g. via reset or session wipe), the registry rows are gone, requiring re-register. This is a correctness footgun if callers assume the hash is permanently invokable after one register call.  
  *mechanism:* registry_workers SQLite table (upsert on register; SELECT on invoke gate). R2 source body at workers/<hash>.js is immutable global.  
  *constraint:* DO SQLite is durable but not immutable — schema migrations (exec_ignore ALTER TABLE) and session resets can wipe rows. The global R2 body is separately durable.  
  *evidence:* apps/kernel/src/lib.rs:1618-1644 (R2 put + SQLite upsert), apps/kernel/src/lib.rs:1673-1684 (invoke gate check), apps/kernel/src/lib.rs:2026-2043 (registry_has)