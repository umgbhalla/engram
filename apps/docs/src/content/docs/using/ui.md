---
title: Notebook UI
description: engram-ui — a durable browser notebook talking WebSocket to the live kernel, deployed via Cloudflare Workers Assets.
---

`apps/ui` (the deployed **`engram-ui`** notebook) is a Vite + TypeScript SPA, type-checked under
`tsc --strict`, built to a static bundle, and served via **Cloudflare Workers Assets**. It is a
durable browser REPL: cells run on the live `engram-kernel` over a WebSocket, and the namespace
survives eviction and cold restore exactly like the CLI.

import { LinkButton } from '@astrojs/starlight/components';

<LinkButton href="https://engram-ui.umg-bhalla88.workers.dev" target="_blank">Open the live notebook</LinkButton>

## What it is

A notebook of cells. Each cell is one `eval` to the kernel; ⇧⏎ runs a cell. The right-hand aside
shows the live **Session** state (generation, warm vs cold) and a **Config** editor that maps to
the kernel's `create` config (clock, RNG seed, capture, cell budget, fetch, tools, modules,
TypeScript). State survives idle eviction; reconnect and the namespace is still there.

## Structure

All paths under `apps/ui/`:

| File | Role |
|---|---|
| `index.html` | Vite entry shell — pure markup (header, toolbar, cells, Session/Config aside). |
| `src/styles.css` | The premium dark theme — CSS custom-property tokens, 8pt rhythm, layered shadows, `tabular-nums` on live numbers. |
| `src/kernel.ts` | Fully typed kernel WebSocket client (~5.4 KB). Exports `EngramConfig`, `KernelReply`, `kernelUrl()` (auto-detects cloud `/connect` vs kernel `/ws`), and a `Kernel` class with a serialized send queue. Zero DOM coupling. |
| `src/main.ts` | Strict-typed app: typed DOM helpers, cell add/run/delete + ⇧⏎, `buildConfig()`, state indicator, localStorage persistence, URL-param boot. |
| `vite.config.ts` | Build to `dist/`, `target: es2022`. |

### Why not `@engram/sdk`?

The SPA uses a small local typed client (`kernel.ts`) instead of the SDK because the SDK
hard-depends on the Node `ws` package and throws in browsers. The local client mirrors the SDK's
type names but is browser-native and DOM-free.

## The Workers-Assets deploy

`wrangler.jsonc` is **assets-only** — no worker `main`:

```jsonc
{
  "name": "engram-ui",
  "compatibility_date": "2025-05-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  },
  "observability": { "enabled": true }
}
```

`vite build` emits `dist/index.html` + hashed `dist/assets/index-*.{js,css}`; Workers Assets serves
them statically with SPA fallback. No worker code path, no bindings.

## Build

```sh
bun run --filter @engram/ui-app build   # tsc --noEmit && vite build
```
