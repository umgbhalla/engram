---
title: Deployed surface
description: The live Cloudflare workers, packages, and repository layout that make up Engram.
---

Engram is a Bun-workspace monorepo (`apps/*` + `packages/*`). The on-disk folder stays named
`montydyn`; the brand and deployed worker names are Engram.

## Live workers

| Worker | What it is |
|---|---|
| `engram-kernel` | The single-tenant kernel — a Rust Durable Object shell driving the rquickjs WASM engine, with eval / snapshot / guards / determinism / durability all in Rust. The hibernating REPL. |
| `engram-cloud` | The multi-tenant supervisor — Rust facets, one per-session Rust kernel via `{wasm}` Worker-Loader modules, per-tenant API-key auth + metering. |
| `engram-ui` | The notebook SPA (Vite + TypeScript), served via Workers Assets. [Live demo →](https://engram-ui.umg-bhalla88.workers.dev) |
| `engram-docs` | This documentation site (Astro Starlight, static, Workers Assets). |

Supporting Cloudflare resources: R2 `engram-snapshots` (large-image overflow) and Analytics
Engine dataset `engram_kernel` (per-op telemetry). Worker Loader and facets require the Workers
**Paid** plan.

## Packages

| Package | What it is |
|---|---|
| `@engram/sdk` | Strict-TypeScript Node client — typed frames, auto-reconnect, durable-session sugar. See [SDK](/using/sdk/). |
| `engram` (CLI) | The Node-like remote REPL. See [CLI REPL](/using/cli/). |

## Repository layout

| Path | Role |
|---|---|
| `apps/kernel/` | THE kernel — `engram-kernel`. Rust engine (`engine/src/lib.rs` + `src/lib.rs`) + a ~400-line `kernel-glue` for WASI / DO plumbing. |
| `apps/cloud/` | Multi-tenant supervisor — `engram-cloud`. Rust facets; bakes the kernel from `apps/kernel`. |
| `apps/ui/` | Notebook SPA — `engram-ui`. |
| `apps/docs/` | This site. |
| `packages/sdk/`, `packages/cli/` | The client SDK and CLI. |
| `tests/` | Gate / smoke harnesses. |
| `experiments/` | Frozen proof archive (the JS→Rust journey) — not built or deployed. |
| `docs/` | Source design docs, ADRs, and per-experiment results. |

## Status in one line

Engram is **product-complete**: a durable, hibernating, multi-tenant codemode / RLM REPL platform
— kernel + auth/metering + lambda-RLM + agent mode + SDK + CLI + UI — scale-validated, with all
known holes closed. Remaining-to-GA items (npm-publish the SDK, scale-at-1000s, R2 stale-key prune)
are owner-gated, not code work.
