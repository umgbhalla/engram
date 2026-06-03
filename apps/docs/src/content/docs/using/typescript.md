---
title: TypeScript cells
description: Write TypeScript directly in REPL cells — type syntax is erased host-side before the cell reaches the QuickJS engine.
---

You can write TypeScript directly in REPL cells, and it is live on `engram-kernel`. Type syntax is
**erased host-side** (in the workerd JS shim, never in WASM) before the cell reaches the QuickJS
engine, so determinism, snapshot fidelity, and the engine hash are all unchanged.

Erasable TypeScript — annotations, interfaces, generics, `as`, `satisfies`, `declare`, `abstract`
— just works. Constructs that would require code generation are cleanly rejected with a typed
`TypeScriptError`; the socket stays alive and the next eval works.

## How it works: erase, then transform, then eval

The pipeline runs entirely host-side in `apps/kernel/src/kernel-glue.ts`. The QuickJS WASM heap
never sees TypeScript or a TS parser:

```
cell source
  → stripTypes(src)          [ts-blank-space, host-side, if config.typescript !== false]
  → transformCell(stripped)  [existing depth-0 let/const/function/class → global rewrite]
  → engine eval (QuickJS in WASM)
```

`stripTypes` calls `ts-blank-space`, which does **length- and position-preserving** erasure: type
syntax is replaced byte-for-byte with spaces, so `out.length === src.length`. This is the
load-bearing property — the existing declaration tokenizer sees **identical offsets**, so no
change is needed downstream.

If any un-erasable construct is encountered, `stripTypes` throws a typed `TypeScriptError`
**without evaluating** the partially-blanked output. The reject is shaped exactly like the
eval-error envelope, so the client handles it uniformly:

```json
{ "ok": false, "valueType": "error", "logs": [],
  "error": { "name": "TypeScriptError", "message": "un-erasable TypeScript construct(s) …", "stack": "" } }
```

## Supported vs rejected

**Supported** (erased cleanly, evaluated as JS):

| Construct | Example |
|---|---|
| Type annotations | `const x: number = 41` |
| Interfaces / type aliases | `interface P { a: number }`, `type N = number` |
| Function return / param types | `function add(a: number, b: number): number` |
| Generics | `const f = <T,>(x: T): T => x` |
| Type assertions | `(z as string).length`, `x satisfies T` |
| `declare`, `abstract` | blanked |
| Plain JS | unchanged byte-for-byte |

**Rejected → `TypeScriptError`** (need codegen that erasure cannot do):

| Construct | Why |
|---|---|
| `enum` / `const enum` | emits a runtime object |
| `namespace` / `module` | emits a runtime scope |
| Parameter properties `constructor(private x: number)` | emits assignments |

We reject rather than silently miscompile.

## Config

`KernelConfig.typescript?: boolean`, resolved at `create` and persisted across cold restore.
**Default ON** — stripping valid-JS or plain-TS is a near no-op. Set `{ typescript: false }` to skip
the strip entirely and feed raw QuickJS.

## Determinism

`tsBlankSpace(src)` is a **pure function of its input string** — no `Date`, no RNG, no I/O — and runs
host-side, not in WASM linear memory. The snapshot is unaffected, the engine hash is unchanged, and
seeded sessions stay byte-identical across restore.

## The one real cost

`ts-blank-space` hard-depends on the `typescript` package for its scanner, growing the bundled glue
from ~36 KB to ~10 MB raw / ~1.65 MB gzip. The Worker code budget is 10 MB **after** compression, so
the gzip glue plus the ~1.45 MB `quickjs.wasm` sit comfortably under the cap.
