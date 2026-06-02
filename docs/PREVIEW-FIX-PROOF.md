# PREVIEW-FIX-PROOF — value-preview class bug fixed, proven on real CF

> Display-only fix. Snapshot format, determinism, guards, and the WS frame protocol are **UNCHANGED**.
> Built + verified in `experiments/kernel-prev/` and deployed only to the scratch worker
> `engram-bench-prev` (now torn down). `apps/` was never edited; no LIVE worker (engram-kernel /
> engram-cloud / engram-ui) was touched; no git commit.

## Headline

The kernel rendered every non-plain JS value (`Map`/`Set`/`Date`/`RegExp`/`Symbol`/typed arrays/
`Promise`) as the useless string `"{}"` (or `null` for Symbol) because `_preview` ran
`JSON.stringify(kernel.dump(handle))`. Fixed by routing those types through a new in-VM
`__engramInspect` formatter and settling bare top-level Promises via a bounded `executePendingJobs`
pump. **12/12 preview cases now correct on real Cloudflare; 6/6 no-regression checks PASS.**
**CUTOVER-READY** to merge `_preview` into `apps/kernel/src/glue.js` pending owner OK.

## Bug (root cause)

`apps/kernel/src/glue.js` `_preview()` object/array tail:

```js
const dumped = this.kernel.dump(h);
let preview = JSON.stringify(dumped);   // <- collapses all builtins to "{}", Promise to null/"{}"
return { value: dumped, valuePreview: preview, valueType: Array.isArray(dumped) ? "array" : "object" };
```

`kernel.dump()` returns a plain-object projection: `Map`/`Set`/`Date`/`RegExp`/typed arrays have no
own-enumerable keys, so `JSON.stringify` yields `"{}"`; `Symbol` dumps to `null`; a `Promise` is
never settled, so it shows `"{}"`/`null` instead of its value. Tracked as **BUG-FAFO-1** plus the
wider preview class in `docs/FAFO-FINDINGS.md`.

## Before / after preview matrix (observed on real CF, `engram-bench-prev`)

| Input | Before (live behavior) | After (`_preview` fix) | valueType |
|---|---|---|---|
| `new Map([["a",1]])` | `{}` | `Map(1) { "a" => 1 }` | object |
| `new Set([1,2,3])` | `{}` | `Set(3) { 1, 2, 3 }` | object |
| `new Date(0)` | `{}` | `1970-01-01T00:00:00.000Z` | object |
| `/re/g` | `{}` | `/re/g` | object |
| `Symbol("s")` | `null` / `{}` | `Symbol(s)` | symbol |
| `new Uint8Array([1,2,3])` | `{}` | `Uint8Array(3) [ 1, 2, 3 ]` | object |
| `Promise.resolve(7).then(v=>v*2)` | `{}` | `value=14`, preview `Promise { 14 }` | number |
| `(async()=>42)()` | `{}` | `value=42`, preview `Promise { 42 }` | number |
| `1+1` | `2` | `2` (unchanged) | number |
| `({a:1})` | `{ a: 1 }` | `{ a: 1 }` (unchanged) | object |
| class `C` instance | `C { n: 5 }` | `C { n: 5 }` (unchanged) | object |
| `function foo(){}` | `[Function: foo]` | `[Function: foo]` (unchanged) | function |

All 12/12 correct over the live WS `/ws?id=` path (`{t:eval,src}`, `t:checkpoint` frames filtered).
None returned `"{}"`.

## Exact change-set (`_preview` change vs LIVE `apps/kernel`)

Only **one** source file carries logic changes: `src/glue.js` (**+248 / −5**).
The other two file diffs are infra-only and must NOT be ported:

- `src/lib.rs` — only the scratch R2 prefix `v093/` → `benchprev/` (2 sites: `r2_key`, `r2_key_for`). **Do not port.**
- `src/stdlib-meta.js` — only the auto-generated `builtAt` build timestamp. **Do not port.**

The portable `glue.js` change (4 hunks; line numbers are post-fix):

1. **NEW `__engramInspect(v, maxDepth=4, maxItems=100, maxStr=256)`** injected via `REBIND_SRC`
   (~L389) as a non-enumerable global. Runs **inside the sandbox** → deterministic, present after
   every cold restore (it travels in `REBIND_SRC` and is re-evaled on `createFresh`/replay), and
   returns an already-bounded string so the host arg stays small (protects `HOST_ARG_MAX`).
   util.inspect-style: `Map(n){k => v}`, `Set(n){a,b}`, `Date`→ISO (or `Invalid Date`),
   `RegExp`→source/flags, `Symbol(desc)`, typed arrays→`Uint8Array(n) [ … ]`,
   `ArrayBuffer(n)`, `Error`→`name: message`, fn→`[Function: name]`, arrays/plain+class objects
   (class ctor prefixed); depth cap (`[Object]`/`[Map]`/`[Set]`/`[Array]`), per-collection item cap
   (`… N more`), string clip, `[Circular]` guard.

2. **`_preview` rewritten** (~L1546–1620): fast paths kept (number/boolean/string/bigint/function/
   Error). Added `symbol` → `Symbol(desc)`; `object && isPromise` → `_previewPromise`;
   object/array/Map/Set/Date/RegExp/typed-array tail now routes through `_inspect` (was the bare
   `JSON.stringify(dump)` that produced `"{}"`). `value` still carries the structured dump for
   round-trippable plain objects/arrays; falls back to dump→toString if the inspector is absent.
   The **−5 removed lines** are exactly the old broken object/array tail above.

3. **NEW `_inspect(h)**` — calls in-VM `__engramInspect` on the result handle via
   `kernel.callFunction` (getGlobal→getProp→callFunction), returns the bounded string, disposes handles.

4. **NEW `_previewPromise(h)**` — drives `kernel.executePendingJobs()` bounded by
   `config.cellBudgetTicks` (re-arms `this.instrLeft` each round, stops when no job ran). Still
   pending → `Promise { <pending> }`. Settled → reads the value via
   `qjs_promise_result(h.ptr)`, recursively previews → `Promise { <preview> }`; rejections tagged
   `Promise { <rejected> … }`. The existing async-eval `_drivePromise`/`__cellP` top-level-await
   path is **untouched**.

## No-regression (6/6 PASS, real CF)

| Check | Result |
|---|---|
| stateful multi-cell | PASS — `x` persists, `inc()`→11,12 across cells |
| evict → cold-restore | PASS — 70s real eviction, gen 1→2, `sqlite-restore`, `x=42` `inc()=43`, no replay |
| determinism (seeded clock+RNG) | PASS — two sessions byte-identical (`Math.random ×3 + Date.now`) |
| guard: infinite loop | PASS — `while(true){globalThis.k=1}` → TimeoutError, socket alive |
| guard: big alloc | PASS — `new Uint8Array(900MB)` → `NativeAllocLimitError`, namespace+socket intact |
| async/await path | PASS — `await Promise.resolve(7)`→7; async-IIFE chain→10; promise-settle preview did not break it |

Plus: snapshot format unchanged — engine-hash `9f10a46b` identical; manifest fields
(`used_heap`, `kv_json`, `nChunks`) present; a fresh session round-trips Map/Set/Date/Array through
evict→`sqlite-restore` byte-correct. Guards (interrupt tick budget, native-alloc limit, size
admission), the WS frame protocol, and determinism are all behaviorally unchanged — the fix is
strictly the rendered `valuePreview`/`valueType` (and now-settled bare-Promise `value`).

## Build / deploy facts (scratch)

- `wrangler deploy --dry-run`: PASS (Rust+glue compiled 19.10s, wasm-opt done, bundle 3903 KiB /
  gzip 1267 KiB, index.js 97.9 kb).
- Deployed `engram-bench-prev` (≠ live workers); `/health`→200; engine-hash `9f10a46b` unchanged
  (cached `quickjs.wasm` 1447147 bytes, sha256 `9f10a46b…`).
- Re-runnable harnesses: `experiments/kernel-prev/verify.mjs`, `experiments/kernel-prev/probe.mjs`.

## CUTOVER-READINESS

**READY to merge — pending owner OK.**

- Port surface = a single self-contained file (`src/glue.js`): the new `__engramInspect`
  (REBIND_SRC injection), the rewritten `_preview`, and the helpers `_inspect` / `_previewPromise`.
- **Do NOT port** the two infra diffs: `lib.rs` R2 prefix (`benchprev/`→keep `v093/`) and the
  `stdlib-meta.js` `builtAt` timestamp.
- Risk: **LOW** — display-only; snapshot/determinism/guards/protocol unchanged; engine-hash
  unchanged (no migration); `__engramInspect` is in-VM so it survives cold restore automatically;
  bounded output protects `HOST_ARG_MAX`; the async/await eval path is untouched.
- Recommended merge gate: re-run `verify.mjs` against `engram-kernel` post-merge to re-confirm the
  12-case matrix + 6 no-regression checks on the live build.

## Teardown (done)

- **DELETED** scratch worker `engram-bench-prev` (confirmed by name; remaining engram-* workers =
  `engram-kernel`, `engram-cloud`, `engram-ui` only).
- R2 `engram-snapshots` `benchprev/` prefix: **0 keys** (nothing to clean — verified empty).
- `apps/` untouched; no git commit.
