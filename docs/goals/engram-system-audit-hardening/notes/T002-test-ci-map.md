# T002 Test and CI Reliability Map

## Scope

Read-only Scout task: inventory test, CI, and verification infrastructure; run inexpensive no-write checks; identify reliability and coverage gaps.

## Commands Run

- `find .github -maxdepth 4 -type f -print`
- `rg -n '"(scripts|test|smoke|verify|build|typecheck|lint|e2e|deploy|preview|dev)"|vitest|playwright|tsc|wrangler|bun ' package.json apps packages tests scripts docs/TODO.md .github`
- `find tests -maxdepth 3 -type f -print | sort`
- `find apps packages -maxdepth 2 -name package.json -print | sort`
- `find . -maxdepth 2 \\( -name 'bun.lock' -o -name 'bun.lockb' -o -name 'package-lock.json' -o -name 'pnpm-lock.yaml' -o -name 'yarn.lock' \\) -print`
- `sed -n '1,260p' docs/TODO.md`
- `sed -n '1,260p' apps/kernel/package.json`
- `sed -n '1,260p' apps/cloud/package.json`
- `sed -n '1,260p' apps/ui/package.json`
- `sed -n '1,260p' packages/sdk/package.json`
- `sed -n '1,260p' packages/cli/package.json`
- `bun --version`
- `bun run --filter @engram/sdk typecheck`
- `bun run --filter @engram/cli typecheck`
- `bun run --filter @engram/ui-app typecheck`
- `bun run --filter @engram/cloud-app typecheck`
- `bun x tsc -p tsconfig.json` from `apps/kernel`
- `sed -n` samples of live/smoke/e2e harnesses
- `rg -n 'montydyn-|engram-rust2|engram-bench-w4|engram-scale-cloud|workers.dev' tests scripts apps packages docs -g '!apps/kernel/src/stdlib.bundle.txt'`
- `git status --short` after typechecks

## Passing No-Write Gates

- Bun is available: `1.3.11`.
- `@engram/sdk typecheck`: pass.
- `@engram/cli typecheck`: pass.
- `@engram/ui-app typecheck`: pass.
- `@engram/cloud-app typecheck`: pass.
- `apps/kernel` TypeScript no-emit check: pass.
- Post-check `git status --short` showed no additional generated changes from typechecks.

## Verification Inventory

- Root `package.json` has deploy/build entrypoints but no root `test`, `typecheck`, `smoke`, or `ci` aggregate.
- Package typecheck scripts exist for SDK, CLI, UI, and cloud. Kernel has no package script for typecheck, but wrangler build command and direct `bun x tsc -p tsconfig.json` cover it.
- Test harnesses exist under:
  - `tests/kernel/`: historical/versioned kernel smokes, obs smokes, persistence, benches.
  - `tests/kernel-rust/`: local workerd and live Rust-kernel checks.
  - `tests/sdk/`: SDK smoke/extension smoke.
  - `tests/ui/`: protocol/UI smoke.
  - `tests/scale/`: cloud scale harness requiring tenant keys.
- `scripts/e2e-ui.ts` is a full UI/kernel E2E script, but its defaults include a deleted/scratch kernel endpoint.

## Gaps and Risks

1. High: no CI workflow exists in this checkout (`.github` has no files). Nothing automatically runs the passing typechecks or a smoke gate.
2. High: no root test/check aggregate exists. Operators must know individual package and smoke commands, increasing the chance of partial verification.
3. High: many smoke/e2e defaults target retired or scratch workers:
   - `tests/ui/smoke.mjs` defaults to `montydyn-v092`.
   - `scripts/e2e-ui.ts` defaults to `engram-bench-w4`, and asserts that string in served HTML.
   - several `tests/kernel/*.mjs` default to `montydyn-v0x/v09x`.
   - several `tests/kernel-rust/*.mjs` default to `engram-rust2`, `engram-rust1b`, `engram-rustf`, `engram-kernel-ouru`, or `engram-bench-w4` scratch hosts.
4. Medium: live smoke commands are not clearly separated into safe current-production smoke, historical proof archive, owner-gated cloud smoke, and destructive/scale/adversarial tests.
5. Medium: `docs/TODO.md` is stale relative to AGENTS/status; it still shows early feasibility/setup tasks incomplete even though many are now done.
6. Medium: package manager surfaces are mixed. Root has `bun.lock`; cloud also has `package-lock.json`; some package deploy scripts use `npm run build` while root uses Bun. This may be intentional, but it complicates reproducible operator gates.

## Recommended Gate Shape

- Fast local gate: root script that runs SDK/CLI/UI/cloud/kernel typechecks without writing build artifacts.
- Current live smoke gate: small harness defaulting to `engram-kernel`, `engram-cloud`, `engram-ui`, and `engram-docs`; only unauthenticated health/info checks by default; optional env-driven API-key checks.
- Historical harnesses: keep versioned `montydyn-*` proof scripts, but mark them archive-only or require explicit endpoint arguments.
- CI: add a minimal GitHub Actions workflow or repo-native equivalent only after Judge decides this repo should have CI in scope.

## Spawned Candidate Tasks

- Add a root no-write `check` or `typecheck` script that runs all current package/kernel typechecks.
- Add or repair a current live smoke harness for kernel/cloud/UI/docs with safe defaults and optional credential-gated checks.
- Move stale/historical smoke defaults behind explicit endpoint args or archive labels so they do not masquerade as current tests.
- Add CI to run the fast no-write gate if GitHub Actions is in scope.
- Refresh `docs/TODO.md` or replace it with a pointer to current GoalBuddy/status docs.
