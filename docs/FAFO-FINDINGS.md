# FAFO — live-prod dogfood findings

> Hands-on probing of the LIVE deployed kernel (wss://engram-kernel.umg-bhalla88.workers.dev) while the
> deep codebase-research workflow ran. Non-destructive (throwaway sessions). What broke vs held.

## What held (live prod, solid)

```
   basic eval / sync IIFE / multi-cell state     42 · 99 · x persists across cells
   seeded determinism                            byte-stable
   typed errors + mutex recovery                 throw TypeError → ok:false typed → next eval works
   memory guards                                 "a".repeat(50e6) and Array(1e9).fill → NativeAllocLimitError
                                                 (typed, socket alive, namespace intact, next eval works)
   top-level await                               `await Promise.resolve(7)` → 7 ; `await host.fetch(...)` → 26
   stash-then-await                              globalThis.p = (async..)() ; await globalThis.p → 42
```

## BUG-FAFO-1 (real, P2 usability) — promise-valued cell result previews as `{}`

A cell whose top-level **value is a promise** (without an explicit `await`) is previewed as `value:"{}"`,
`valueType:"object"` — the kernel serializes the *unresolved promise object* instead of driving it to
settlement and showing the resolved value.

```
   eval                                  live result      expected
   ────                                  ───────────      ────────
   Promise.resolve(7).then(v=>v*2)       value "{}"       14
   (async()=>42)()                        value "{}"       42
   await Promise.resolve(7)               7  ✓             7
```

**Why it matters:** Node and browser REPLs auto-await a top-level promise result and display the resolved
value — it is expected REPL behavior. Engram only resolves when the user writes `await`; a bare async
expression silently shows `{}`. For a REPL/notebook this is a genuine UX gap (and it is why earlier live
tests saw `host.fetch` "preview as {}" — same root cause).

**Root cause (likely):** `evalCode` / `_drivePromise` (apps/kernel/src/glue.js) drives pending jobs for
explicit-await cells, but `_preview` serializes the cell's return value directly when that value is itself
a Promise — no "if result is a thenable, settle it then preview the resolution" step.

**Fix shape (small, snapshot-safe):** after eval, if the result handle is a Promise, drive
`executePendingJobs()` to settlement (bounded by the existing tick budget) and preview the resolved value
(or `Promise { <pending> }` if still pending after the budget). Pure preview/host-side change; no engine,
determinism, or snapshot-format impact. Add to the fix queue alongside the W4 ceiling regression.

### BUG-FAFO-1 is the narrow case of a wider preview-class bug

`_preview` JSON-serializes the result, so any non-plain built-in renders uselessly (data is FINE — only the
displayed preview is wrong; E5 proved the underlying values round-trip 21/21):

```
   eval                  live preview     correct REPL preview
   ────                  ────────────     ────────────────────
   new Map([["a",1]])    "{}"             Map(1) { "a" => 1 }
   new Set([1,2,3])      "{}"             Set(3) { 1, 2, 3 }
   new Date(0)           "{}"             1970-01-01T00:00:00.000Z
   /re/g                 "{}"             /re/g
   Symbol("s")           null             Symbol(s)
   Promise.resolve(7)    "{}"             7  (settle first)
   ── render OK: class instance {x:1}, function [Function: f], 10n, Uint8Array, plain/nested objects
```

**Verdict:** the snapshot/durability core is correct; the kernel's **value-preview formatter is the weak
spot** — it should special-case Map/Set/Date/RegExp/Symbol/Promise (and ideally show `Map(n)`/`Set(n)`
tags) like Node's `util.inspect`, instead of `JSON.stringify`. Single host-side function (`_preview` in
glue.js / a Rust formatter if the kernel goes Rust). P2, high user-visible value for a notebook product.

## Not bugs, noted

- `host.fetch` works (github 200, 26-byte body) — the `{}` people saw was BUG-FAFO-1, not a fetch failure.
- Tier-0 (`crypto`/`TextEncoder`/`structuredClone`) present.
- The kernel emits an eval-result frame AND a checkpoint frame per cell — clients must filter `t:checkpoint`.
