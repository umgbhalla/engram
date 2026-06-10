# TODO / Task Board

This file used to mirror the early feasibility harness. That checklist is now historical:
Engram has shipped the JS/Rust kernel, multi-tenant cloud, SDK/CLI, UI, and docs surface. The
frozen proof trail lives in `docs/results/`, `docs/experiments.md`, and the ADR/design docs.

Current machine-truth board for the active audit/hardening tranche:

```text
docs/goals/engram-system-audit-hardening/state.yaml
```

## Current Verified Surface

- `engram-kernel`: live hibernating REPL kernel.
- `engram-cloud`: live multi-tenant supervisor with auth/metering.
- `engram-ui`: live notebook SPA.
- `engram-docs`: live static docs site.
- Supporting resources: R2 `engram-snapshots`, Analytics Engine `engram_kernel`.

## Current Local Gates

- `bun run check` — no-write TypeScript checks for SDK, CLI, UI, cloud, and kernel.
- `bun run e2e:ui` — live UI/kernel E2E against `engram-ui` and `engram-kernel` using a throwaway session.

## Active Audit / Hardening Follow-Ups

- Continue the GoalBuddy board until its final Judge/PM audit proves the full audit/hardening tranche complete.
- Decide whether to add CI for `bun run check`.
- Decide whether to package a broader current live smoke for `engram-kernel`, `engram-cloud`, `engram-ui`, and `engram-docs`.
- Review remaining package/docs identity drift, especially historical scratch names in package metadata and architecture docs.
- Use `improve-codebase-architecture` only in a dedicated architecture Scout/Judge task before any broad refactor.

## Owner-Gated GA Items

- Publish `@engram/sdk` / CLI packages to npm.
- Run scale validation at 1000s of concurrent sessions.
- Prune stale R2 keys when an R2 S3 token is available.

## Historical Note

The old Phase 0/1/2 feasibility checklist is superseded. Do not use it to infer current status.
Use `apps/docs/src/content/docs/reference/deployed.md`, `docs/PRODUCT.md`, and the GoalBuddy
state file above for current operator truth.
