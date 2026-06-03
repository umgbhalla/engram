---
title: SDK
description: The @engram/sdk Node client — typed, auto-reconnecting, durable-session sugar.
---

`@engram/sdk` (v2) is a strict-TypeScript Node client with typed frames, auto-reconnect, and durable
session sugar. It lives in `packages/sdk`.

```js
import { Engram } from "@engram/sdk";

const s = await Engram.connect({ url, apiKey });

await s.eval("globalThis.x = 41");
const r = await s.eval("x + 1");   // → 42 — survives eviction & cold restore

await s.reset();                   // drop the namespace
const status = await s.status();   // generation / inMemory (warm vs cold)
await s.close();
```

## What you get

- **Stateful evals.** Each `eval(src)` mutates the kernel's QuickJS WASM heap. The namespace
  persists across calls, idle eviction, and cold restore — no replay.
- **Auto-reconnect.** The client reconnects transparently after eviction; the kernel-side state is
  still there, so the next `eval` continues mid-namespace.
- **Typed frames.** Reply shape `{ ok, value | error, console, valueType }`. Errors arrive as a
  typed envelope, never a thrown socket close.
- **Config at connect.** Pass an `EngramConfig` (clock, rngSeed, capture, cellBudgetTicks, fetch,
  tools, modules, typescript) — persisted across cold wake. See the
  [frame protocol & config](/reference/protocol/).

## Browser note

The SDK hard-depends on the Node `ws` package, so in the browser the notebook UI uses a small
DOM-free typed client (`apps/ui/src/kernel.ts`) that mirrors the SDK's type names but is
browser-native. See the [Notebook UI](/using/ui/).
