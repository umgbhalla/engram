# TypeScript in the REPL

> **Headline: YES — users can now write TypeScript directly in REPL cells, and it is deployed
> live on `engram-kernel`.** TS type syntax is erased host-side (in the workerd JS shim, never in
> WASM) before the cell reaches the QuickJS engine, so determinism, snapshot fidelity, and the
> engine hash are all unchanged. Erasable TypeScript (type annotations, interfaces, generics, `as`,
> `satisfies`, `declare`, `abstract`) just works. Non-erasable constructs that would require code
> generation (`enum`, `const enum`, `namespace`/`module`, parameter properties) are cleanly
> rejected with a typed `TypeScriptError` — the socket stays alive and the next eval works.

## Why TS, why now

The kernel is a stateful JS REPL. Users increasingly paste TypeScript. Until now a cell like
`const x: number = 41` was a syntax error inside QuickJS (the engine has no TS parser). The fix
is **type erasure**: strip the TS-only syntax to whitespace before eval, leaving valid JS.

## Design: host-side erase → existing REPL transform → eval

The transform pipeline runs entirely **host-side** in `apps/kernel/src/kernel-glue.ts`
(`evalCode`), in the workerd JS shim. The QuickJS WASM heap never sees TypeScript or the TS
parser. New stage prepended ahead of the existing REPL-persistence transform:

```
cell source
  → stripTypes(src)        [NEW: ts-blank-space, host-side, only if config.typescript !== false]
  → transformCell(stripped) [existing depth-0 let/const/function/class → global rewrite]
  → engine eval (QuickJS in WASM)
```

`stripTypes` calls `tsBlankSpace(src, onError)` from
[`ts-blank-space`](https://www.npmjs.com/package/ts-blank-space) `@0.9.0`:

- **Length-preserving, position-preserving erasure.** Type syntax is replaced byte-for-byte with
  spaces; `out.length === src.length`. No codegen, no source maps. This is the load-bearing
  property: the existing depth-0 declaration tokenizer in `repl-transform.ts` sees **identical
  offsets** — erased annotations become whitespace, which the tokenizer already skips as trivia.
  No change needed to `transformCell`.
- **`onError` callback** fires once per un-erasable construct, with `node.kind` = the TS
  `SyntaxKind` number. `stripTypes` collects those kinds; if any fired, it throws a typed
  `TypeScriptError` (`new Error(...)` with `.name = "TypeScriptError"`) **without evaluating the
  partially-blanked output** — the partial output still contains illegal TS and must never be
  eval'd.

The reject is shaped exactly like the eval-error envelope so the client handles it uniformly:

```json
{ "ok": false, "valueType": "error", "logs": [],
  "error": { "name": "TypeScriptError", "message": "un-erasable TypeScript construct(s) ...", "stack": "" } }
```

Mutex is never taken for a TS reject (it happens before `this._ex()`), socket stays alive, and the
session continues — same recoverability contract as a runtime error.

## What is supported vs rejected

**Supported (erased cleanly, evaluated as JS):**

| Construct | Example |
|---|---|
| Type annotations | `const x: number = 41` |
| Interfaces / type aliases | `interface P { a: number }`, `type N = number` |
| Function return / param types | `function add(a: number, b: number): number` |
| Generics | `const f = <T,>(x: T): T => x` |
| Type assertions | `(z as string).length`, `x satisfies T` |
| `declare` | `declare const z: number` (blanked) |
| `abstract` classes/members | `abstract class A { abstract m(): void }` (blanked) |
| Plain JS | unchanged byte-for-byte |

**Rejected → `TypeScriptError` (need codegen ts-blank-space does not do):**

| Construct | TS SyntaxKind |
|---|---|
| `enum E { A, B }` | 266 |
| `const enum` | 266 |
| `namespace N { ... }` | 267 |
| `module M { ... }` | 267 |
| Parameter properties `constructor(private x: number)` | 123 |

These all emit a value (a runtime object / scope), so erasing them to whitespace would change
program semantics — they require real code generation. We reject rather than silently miscompile.

## Config: `typescript` defaults ON

`KernelConfig.typescript?: boolean`. Resolved at `create` **and** persisted across cold restore
via the same `configJson` path as `clock`/`rngSeed` (`this.tsEnabled = cfg.typescript !== false`).

- **Default ON.** Stripping a valid-JS or plain-TS cell is a near no-op (annotations → spaces, the
  tokenizer already skips whitespace), so there is no reason to make users opt in.
- `{ typescript: false }` skips the strip entirely (cell goes straight to `transformCell`), for
  callers who want raw QuickJS behavior or who feed pre-compiled JS.

## Determinism argument

`tsBlankSpace(src)` is a **pure function of its input string** — no `Date`, no RNG, no entropy,
no I/O. Verified byte-identical across repeated calls. It runs host-side in the workerd JS shim,
**not in the WASM linear memory**, so:

- The snapshot (WASM heap image) is unaffected — the engine hash is unchanged; the TS strip is
  not part of the determinism boundary.
- Seeded sessions stay byte-identical across restore; the strip adds zero entropy and is applied
  identically pre- and post-restore.

## The cost (the one real tradeoff)

`ts-blank-space` itself is tiny (~26 KB), but it hard-depends on the full `typescript` package for
its scanner/parser, and esbuild cannot tree-shake TypeScript's monolithic CJS bundle. Bundling it
into `kernel-glue.mjs` grows that file from ~36 KB to **~10.0 MB raw / ~1.65 MB gzip**.

- The Worker code budget is 10 MB **after gzip/compression**, so the ~1.65 MB gzip glue + the
  ~1.45 MB `quickjs.wasm` CompiledWasm sit comfortably under the cap.
- The `typescript` parser `require()`s Node built-ins eagerly at module init (e.g. `os.platform()`
  env-probing). The wasm-bindgen snippet that `worker-build` re-bundles must be **fully
  self-contained** (it re-runs esbuild with no externals, browser platform), so we cannot leave
  `node:*` imports. `scripts/build-ts.ts` aliases every bare/`node:` builtin to a tiny
  behavior-correct shim (`scripts/node-builtin-shim.mjs`) and injects a `require()`/`__filename`/
  `__dirname` banner. The shim only needs to satisfy TS's init-time env probe; the in-memory
  `createSourceFile`/scanner path ts-blank-space uses does no real fs/process I/O, so the shim is
  never functionally relied on beyond init.

This is **not a free add**, but it fits the budget and is determinism-safe.

## Live result

Verified on a scratch worker (`engram-kernel-ts`, since deleted) before this writeup:

- `const x: number = 41; x + 1` → **42**
- `interface P { a: number } ...` + typed function → **7**
- generics + `as number[]` → **3**
- plain JS `... 100` → **100** (unchanged)
- `enum E { A, B }` → typed `{ name: "TypeScriptError", message: "un-erasable TypeScript ..." }`,
  socket alive, next eval works.

Strip behavior re-verified locally against `ts-blank-space@0.9.0` at writeup time: 8/8 erasable
cases length-preserving and valid JS; enum / const-enum / namespace / module / parameter-property
fire `onError`; `declare` / `abstract` erase cleanly.

## Files

- `apps/kernel/src/kernel-glue.ts` — `stripTypes()`, `KernelConfig.typescript`, `tsEnabled`
  (resolved + persisted), TS strip stage prepended in `evalCode`.
- `apps/kernel/scripts/build-ts.ts` — Node-builtin alias map + `require()` banner so the bundled
  `typescript` parser survives the `worker-build` re-bundle.
- `apps/kernel/scripts/node-builtin-shim.mjs` — tiny self-contained shim for TS's init-time
  Node-builtin probe.
- `apps/kernel/scripts/ts-smoke.mjs` — live WS smoke harness (TS cells over a deployed worker).
- `apps/kernel/package.json` — adds `ts-blank-space@^0.9.0` (devDependency).
