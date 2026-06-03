---
title: Frame protocol & config
description: The WebSocket frame shapes, the eval reply envelope, and the EngramConfig passed at create.
---

The kernel speaks a small typed WebSocket protocol. Clients ([`@engram/sdk`](/using/sdk/), the
[CLI](/using/cli/), the [notebook UI](/using/ui/)) send frames and receive typed replies. Errors
arrive as a **typed envelope**, never as a thrown socket close.

## Connecting

A session is addressed by id. Single-tenant kernel:

```
wss://engram-kernel.umg-bhalla88.workers.dev/ws?id=<session>
```

Multi-tenant cloud supervisor (adds per-tenant auth):

```
wss://engram-cloud…/connect?session=<session>&apiKey=<key>
```

The SDK's `kernelUrl()` auto-detects which shape to build.

## Frames

| Frame | Purpose |
|---|---|
| `{ t: "create", config }` | establish / resume a session with an `EngramConfig` (persisted across cold wake) |
| `{ t: "eval", code }` | evaluate one cell against the live namespace |
| `{ t: "reset" }` | drop the namespace (fresh heap) |
| `{ t: "status" }` | report `generation` + `inMemory` (warm vs cold) |

## The eval reply envelope

Every `eval` resolves to a single typed reply:

```json
{
  "ok": true,
  "value": "42",
  "valueType": "number",
  "console": [{ "level": "log", "text": "…" }]
}
```

On failure the same shape carries a typed error instead of a value:

```json
{
  "ok": false,
  "valueType": "error",
  "console": [],
  "error": { "name": "TimeoutError", "message": "…", "stack": "…" }
}
```

- **`valueType`** is a structured tag (`number`, `string`, `object`, `function`, `error`, …) used
  by clients to render a value preview. Errors-as-values carry name + message + a short stack.
- **`console`** is the per-cell buffer of `console.*` calls, returned with the result.
- Typed error names you may see: `TimeoutError` (cell tick budget), `MemoryLimitError` (mid-cell
  growth tripwire), `SizeAdmissionError` (snapshot too large to instantiate safely),
  `FetchBlockedError` (egress not on the allowlist), `TypeScriptError` (un-erasable TS).

## EngramConfig

Passed in `create`, resolved at session start, and **persisted across cold restore** via the
manifest so a resumed session keeps the same behavior.

| Field | Type | Meaning |
|---|---|---|
| `clock` | `"real" \| "seeded"` | seeded clock makes `Date`/`performance.now` deterministic |
| `rngSeed` | `number` | seeds the LCG and seeded crypto entropy (byte-identical across restore) |
| `capture` | `boolean` | buffer `console.*` per cell and return it with the reply |
| `cellBudgetTicks` | `number` | per-cell interrupt-tick budget; on overrun a typed `TimeoutError` trips and the socket stays alive (default 1200) |
| `fetch` | `boolean \| string[]` | egress policy: `false` block all, `true` allow all, `[hosts]` allowlist; else `FetchBlockedError` |
| `tools` | `object` | host tools exposed in the VM as `host.<name>` (kv state survives restore) |
| `modules` | `string[]` | stdlib subset injected into the heap at create and snapshot-persisted |
| `typescript` | `boolean` | strip TS host-side before eval (default ON) — see [TypeScript cells](/using/typescript/) |

## Determinism boundary

With a seeded clock and RNG, the WASM heap snapshot is **byte-identical** across restore. All
non-determinism (time, randomness, crypto entropy, fetch) crosses the controlled host boundary;
`host.fetch` adds zero entropy to the snapshot, so egress preserves determinism.
