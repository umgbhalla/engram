# REPL-NORMALJS — Normal JS persistence (no `globalThis` needed)

> Can you now write normal JS in an Engram cell — `let`, `const`, `function`, `class`,
> destructuring — and have it persist into the next cell, survive hibernation, and cold-restore?
> **Yes.** A host-side, pre-eval source transform rewrites depth-0 declarations into global
> publishes, so declared names become real `globalThis` properties that snapshot/restore like any
> other state. Proven live on `engram-kernel` (14/14 e2e PASS).

## The problem

The kernel evals each cell with the engine's sloppy **indirect global eval** (`(0,eval)(src)`), which
runs in the WASM-heap global scope. In that scope a bare `let x = 1` / `const` / `function` / `class`
binds **lexically to the eval invocation** — the binding evaporates when the cell returns. Only
implicit/`var`/`globalThis.x =` assignments became real global properties and persisted. So users had
to write `globalThis.x = 1` (or `x = 1`) to carry state between cells — not normal JS.

## Before → after

| Cell source | Before (persists to next cell?) | After |
|---|---|---|
| `x = 1` (implicit global) | yes | yes (unchanged) |
| `var x = 1` | yes | yes (unchanged) |
| `globalThis.x = 1` | yes | yes (unchanged) |
| `let z = 9` | **no** | **yes** — `z === 9` next cell |
| `const k = 3` | **no** | **yes** |
| `function f(){return 7}` | **no** | **yes** — `f()` callable next cell |
| `class C{}` | **no** | **yes** — `new C()` next cell |
| `const {a,b} = o` (destructure) | **no** | **yes** — both `a` and `b` |
| `let m=1, n=2` (multi-binding) | **no** | **yes** — both `m` and `n` |
| `let x;` (bare, no init) | **no** | **yes** — declared `undefined`, no clobber |
| `for(let i=0;…)` loop var | n/a | **NOT leaked** — `typeof i === 'undefined'` |
| `{ let q=1 }` block-scoped | n/a | **NOT leaked** — contained |
| `"let x = 5"` (string literal) | n/a | **NOT transformed** — returned verbatim |
| `1+1` (completion value) | `2` | `2` — completion value preserved |

## Transform design

One place: `apps/kernel-rust/src/kernel-glue.mjs`, function **`transformCell`** (inlined, ~lines 50–385),
invoked in async `evalCode` (~lines 716–725) on the cell **source** *before* it is marshalled to the
engine scratch buffer. The Rust engine eval path is unchanged. A standalone reference copy lives at
`apps/kernel-rust/src/repl-transform.mjs` (proven behaviorally identical across 16 cases).

**Mechanism** — a tiny hand-written tokenizer (`planEdits`) scans the cell tracking brace/paren/bracket
depth plus string / template / regex / line- and block-comment state. It acts **only** on depth-0,
statement-start declaration keywords and emits in-place edits applied **right-to-left** so byte offsets
stay valid. A regex pre-check fast-paths cells with no declaration keyword (no rewrite).

**Rewrites:**
- `let X = …` / `const X = …` → **drop the keyword**. In sloppy indirect global eval an unqualified
  assignment creates a global property, and the assignment value is the completion value when it's the
  last statement.
  - `let a=1, b=2` → comma sequence assigns both globally.
  - `const {a,b}=o` / `const [x,,z]=a` → the declarator region is wrapped in `( … )` so a leading `{`
    parses as an **object pattern**, not a block; sparse holes are preserved.
- `let x;` (no init) → `void(globalThis["x"] ??= undefined)` — declares the global without clobbering an
  existing value and without a `ReferenceError`.
- `function NAME(){}` → `globalThis["NAME"] = function NAME(){};` — a **named function expression**, so
  `NAME` stays visible inside for recursion (verified `fac(5)===120`) and is published globally; the
  trailing `;` terminates the statement without changing completion.
- `class NAME{}` → `globalThis["NAME"] = class NAME{};`.

## Edge-case handling (each verified)

- `for(let i…)`, `while`, etc. — the `let` is not a depth-0 statement-start → **untouched** (loop var
  stays scoped, does not leak).
- `let`/`const` inside a nested block, function, or arrow body (depth > 0) → **untouched**; an outer
  `const f = (…) => {…}` still persists as an ordinary const-assignment publish.
- Declaration keywords inside strings, template literals (incl. `${}` substitutions), regex literals,
  and `//` / `/* */` comments → **skipped** by the tokenizer (e.g. `"let x = 5"` returned verbatim).
- Destructuring publishes **all** names; multi-binding publishes **all** names; arrow funcs handled as
  ordinary const assignments.
- **Fallback (safety):** any ambiguity returns the source **unchanged** → plain eval. Triggers: async
  function, `function*`/generator, `export`, unterminated string/regex, unbalanced braces, unparseable
  declarator.

## Determinism + snapshot

Unaffected. The transform is a **pure, host-side, pre-eval source rewrite** — no clock/RNG/entropy, no
host calls; identical input → identical output. It runs before the engine touches the cell, so the WASM
linear-memory heap snapshot and the seeded clock/RNG path are untouched. Persisted declarations are now
real `globalThis` properties, so they snapshot and restore like any other global state — meaning they
**survive hibernation** too (that's the point).

## Live e2e result

Run against deployed **`engram-kernel`** (`wss://engram-kernel.umg-bhalla88.workers.dev/ws`) over the raw
WebSocket protocol, fresh session per run. Harness: `tests/kernel/persist-e2e.mjs`
(re-run: `SUB=umg-bhalla88 node tests/kernel/persist-e2e.mjs`). **14/14 PASS.**

- Persistence (1–6): `let z=9`→`z===9`; `const k=3`; `function f(){return 7}`→`f()===7`;
  `class C` → `new C().x===1`; `const {a,b}={a:1,b:2}`→`a+b===3`; `let m=1,n=2`→`m+n===3`.
- Edge (7–10): `for(let i)` not leaked; `"let x = 5"` returned verbatim and `x` undefined; block `let q`
  contained; `1+1`→`2` completion value still returned.
- No regression: implicit-global + `var` persist (R1); seeded determinism intact, `Math.random()` fixed
  (R2); **evict → cold restore** reconstructs from durable SQLite (`restoreSource=sqlite-restore`,
  `inMemoryBefore=false`) with full state and a live closure counter surviving with **no source replay**
  (R3); infinite-loop guard trips a typed `TimeoutError`, socket alive, next eval works (R4).

Build sanity: cargo release + `wasm-opt` clean, `wrangler deploy --dry-run` clean, Total Upload
~2003 KiB / gzip ~723 KiB, bindings intact. Deployed version `3f0054e5-…`; rollback anchor
`d49a9360-…` (number 6).

## Remaining gap

**Function var-hoisting within the same cell.** Rewriting `function f(){}` to an assignment removes
`var`-hoisting, so calling `f()` on a line **above** its declaration **within the same cell** no longer
works (rare in REPL cells). Cross-cell calls are unaffected — once a cell defines `f`, it is published
globally and every later cell sees it. Documented and accepted.

Everything else — async functions, generators, `export`, and any syntactically ambiguous input — falls
through to plain unchanged eval, so nothing regresses; those forms simply don't get the global-publish
sugar.
