# REPL Hoisting Fix — in-cell `function` declarations now hoist (LIVE on engram-kernel)

**Headline:** A call site **above** a `function` declaration in the same cell now resolves —
`f(); function f(){return 7}` returns `7`. The cell-source transform that makes top-level
declarations persist across cells previously rewrote each `function NAME(){…}` **in place** to
`globalThis.NAME = function NAME(){…};`, which silently dropped JavaScript's function-hoisting
(any call above the declaration threw `ReferenceError`). Fixed, deployed live to `engram-kernel`,
verified 12/12 in production. Zero regression.

## The bug (caveat that was documented but not fixed)

The kernel evals a no-`await` statement/declaration cell via indirect global `(0,eval)(src)`.
In QuickJS (and V8), indirect global eval gives top-level `let`/`const`/`class`/`function`
their **own** lexical scope — they do **not** become `globalThis` properties, so across cells
only `var x` and bare `x = …` survived. The `repl-transform` (host-side, pre-eval) rewrites
top-level declarations into global assignments to restore cross-cell persistence (Node-REPL
parity).

For `function`, the old rewrite was an **in-place** edit:

```
function f(){return 7}   →   globalThis.f = function f(){return 7};
```

That is a function **expression**, evaluated where it sits. It correctly publishes `f` for
later cells, but it is **not hoisted** — so within the same cell a call that lexically precedes
the declaration sees no binding:

```
const r = f(); function f(){return 7}; r   →   ReferenceError: f is not defined   (WRONG)
```

Real JS hoists `function` declarations to the top of their scope, so this should return `7`.

## The fix

In `repl-transform.mjs` (and its inlined copy in `kernel-glue.mjs`), depth-0
`function NAME(){…}` declarations are now **hoisted**:

1. Every depth-0 `function NAME(){…}` is collected in **source order**.
2. Each original declaration is removed in place, replaced with an empty statement `;`
   (preserves statement boundaries and the cell's completion value).
3. All `globalThis["NAME"] = function NAME(…){…};` assignments are concatenated and emitted
   at **offset 0 — the top of the transformed cell**, in source order.

So `const r = f(); function f(){return 7}; r` transforms to:

```
globalThis["f"] = function f(){return 7};r = ... f(); ;; r
```

A call site above the declaration now resolves; recursion still works (the named function
**expression** keeps `NAME` visible inside itself); and the global is published for cross-cell use.

**Edit-ordering correctness:** edits apply right-to-left by offset. The hoist prefix is tagged
`prefix:true` and the sort comparator became `(b.at - a.at) || ((a.prefix?1:0)-(b.prefix?1:0))`
so the prefix is applied **last** and lands strictly at the front even when a function
declaration itself starts at offset 0.

**Unchanged (deliberately):**
- `let`/`const` → drop-keyword global assignment (no hoist — they have a TDZ in real JS).
- `class NAME` → in-place `globalThis.NAME = class NAME …;` (TDZ semantics, no hoist).
- Bare `let x;` → `void(globalThis.x ??= undefined)`.
- `function` **nested in a block/function/arrow** is NOT hoisted (only depth-0, statement-start).
- All bail paths (`async function`, `function*`/generator, `export`, unterminated
  string/regex, unbalanced braces) → source returned unchanged → plain eval. Completion value
  preserved throughout.

## Files changed

- `apps/kernel-rust/src/repl-transform.mjs` — reference transform.
- `apps/kernel-rust/src/kernel-glue.mjs` — **inlined live copy** (`transformCell`). Kept
  byte-identical to the reference because the glue is wired into `entry.mjs`'s CompiledWasm /
  wasm-bindgen snippet inlining and must carry its own copy.

No `lib.rs` / Rust change. No git commit (per guardrails).

## Verification

**Unit (transform suite):** 10/10 pass on both `repl-transform.mjs` and the inlined
`kernel-glue.mjs` copy (byte-identical behavior). Cases include the required
`f(); function f(){return 7} → 7`, completion-value-after-fn, two-functions-in-call-order,
recursion, fn-as-completion-value, `let`/`const`, `class`, nested-fn-not-hoisted, async-bail.

**Live (`tests/kernel/verify-trackA.mjs`, 12/12 PASS on production `engram-kernel`):**
- In-cell function hoisting: `const r = f(); function f(){return 7}; r` ⇒ **7** (call above decl).
- Cross-cell function persist: define `add()`, then `add(20,22)` ⇒ 42.
- `let`/`const`/`class` persist across cells ⇒ 112.
- `for(let i)` NOT leaked: `typeof i === 'undefined'` after the loop cell.
- Evict → cold-restore: survivor string, `function add()`, and `let`/`const`/`class` all
  survived socket-close + reconnect (×3).
- Determinism preserved: seeded `Date.now`/`Math.random` byte-identical before vs after
  restore; two fresh same-seed sessions produce identical
  `[1700000000000, 0.4932122668392295, 0.955659538405286]`.

**Deploy:** `wrangler deploy` of `apps/kernel-rust` to live `engram-kernel`.
- Rollback anchor (prior live): `be1ecbc8-64e6-40d5-a470-5264bd9c72b9` (2026-06-03T04:16:44Z).
- New version: `dc42e8a3-245b-4061-85ed-52bd0b4cebc9` (also published `f6304b4e…` during verify).
- Upload 2010.51 KiB / gzip 723.64 KiB, startup 14ms. `GET /health` ⇒ 200 `ok`.
- Bindings intact: `KERNEL_DO`, `SNAPSHOTS` (engram-snapshots R2), `AE` (engram_kernel).
- Rollback if needed: `wrangler rollback` to `be1ecbc8-64e6-40d5-a470-5264bd9c72b9`.
