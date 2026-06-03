# UI-VITE — the notebook frontend, now Vite + TypeScript

**Headline: YES.** `apps/ui` (the deployed `engram-ui` notebook) is now a proper **Vite + TypeScript
SPA**, type-checked under `tsc --strict`, built to a static bundle, and deployed correctly via
**Cloudflare Workers Assets**. The old single-inline-`<script>` HTML page (wrapped by an esbuild
`worker.ts`) is gone. Live, serving 200, talking WebSocket to the live `engram-kernel`.

## What it replaced

The previous `apps/ui` was a single `src/index.html` with **all** markup, CSS, and app logic in one
inline `<script>`, plus a hand-rolled `src/worker.ts` (esbuild) that wrapped the HTML string and
served it from a Worker, with an `html.d.ts` shim and a stale `dist/worker.mjs`. No type checking on
the app code, no module boundaries, no real build.

Removed in the conversion: `src/worker.ts`, `src/html.d.ts`, the old inline `src/index.html`, the
stale `dist/worker.mjs`, and the `esbuild` + `@cloudflare/workers-types` devDeps.

## New structure

All paths under `/Users/umang/hub/zonko/montydyn/apps/ui/`:

| File | Role |
|---|---|
| `index.html` | Vite entry shell at the app root (NOT `src/`). Pure markup — header, toolbar, cells container, Session/Config aside. No inline script or style. Ends with `<script type="module" src="/src/main.ts">`. |
| `src/styles.css` | The former inline `<style>` block, verbatim: CSS vars + all rules (transitions, scale active-states, ≥40px hit areas, tabular-nums, text-wrap balance/pretty). Imported from `main.ts`. |
| `src/kernel.ts` | Fully typed kernel WebSocket client (~5.4 KB). Exports `EngramConfig`, `ConsoleLine`, `Checkpoint`, `EvalErrorInfo`, `FinalInfo`, `KernelFrame`, `KernelReply`, `kernelUrl()` (auto-detects cloud `/connect?session=&apiKey=` vs kernel `/ws?id=`), and `class Kernel` with a serialized send queue. Zero DOM coupling (takes a `resolve()` callback for endpoint/session/apiKey). |
| `src/main.ts` | Strict-typed app (~14 KB): typed DOM helpers (`el<T>`/`$in`/`$sel`, no `any`-abuse), cell add/run/delete + ⇧⏎, `buildConfig()`, state indicator, deployed-E2E runner, localStorage persistence, URL-param boot. Default endpoint `wss://engram-kernel.umg-bhalla88.workers.dev`. |
| `vite.config.ts` | Build to `dist/`, `target: es2022`, `emptyOutDir`. |
| `tsconfig.json` | `strict` + DOM libs + `vite/client` types + `noUnusedLocals`/`noUnusedParameters` + `noImplicitOverride` + `isolatedModules`. |
| `package.json` | `vite` + `typescript` devDeps only. Scripts: `dev` / `typecheck` (`tsc --noEmit`) / `build` (`tsc --noEmit && vite build`) / `deploy`. |
| `wrangler.jsonc` | Assets-only worker (below). |

### Why not `@engram/sdk`?

The SPA uses a small local typed client (`kernel.ts`) instead of `@engram/sdk` because the SDK
hard-depends on the node `ws` package and throws in browsers unless you inject a `WebSocket`. The
local client mirrors the SDK's type names but is browser-native and DOM-free.

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

`vite build` emits `dist/index.html` (2.71 KB) + `dist/assets/index-*.js` (10.25 KB) +
`dist/assets/index-*.css` (4.35 KB); Workers Assets serves them statically, with SPA fallback
(unknown paths → 200 + index.html). No worker code path, no bindings.

## Verification (live)

Build / typecheck:
- `bun run typecheck` (strict): **0 errors**.
- `bun run build` (vite v6.4.3): success ~59ms — `index.html` 2.71 KB, css 4.35 KB, js 10.25 KB.
- `wrangler@4 (4.97.0) deploy --dry-run`: 4 files read from `dist`, assets-only, No bindings, clean.

Deployed `engram-ui` (LIVE, verified this session):
- Rollback anchor (prior live): `f2b4d5dd-9482-4014-b7f7-07fa5e47c898` (2026-06-03T07:36:25Z).
- New live version: `ac51eb9b-6d7b-46d8-a2e3-5f4a6d819ea0`.
- `GET /` → **200** `text/html`; `GET /assets/index-CzcEu55F.css` → 200 `text/css`;
  `GET /assets/index-Ba31rs3W.js` → 200 `text/javascript`.
- Served JS references **only** `wss://engram-kernel.umg-bhalla88.workers.dev` — no other worker.
- Headless WS to live `engram-kernel` (replicating `kernel.ts`): `create` ok (generation 1, fresh);
  two evals confirmed stateful REPL (`x=42` then `x+1`, state survived via delta checkpoint).
- Live URL: https://engram-ui.umg-bhalla88.workers.dev

Rollback if needed: `wrangler rollback f2b4d5dd-9482-4014-b7f7-07fa5e47c898 --name engram-ui`.

## Scratch / guardrails

- Verify used a **scratch** worker `engram-ui-vite`; it was deleted and confirmed gone (`GET` → 404).
- Worker list now contains the three expected engram workers — `engram-kernel`, `engram-cloud`,
  `engram-ui` — and no `engram-ui-vite`. (`curl-worker`/`durelo`/`thinkx-api` are unrelated
  pre-existing workers, not part of this stack.)
- Only `apps/ui` touched; `apps/kernel` and `apps/cloud` untouched. No git commit.
