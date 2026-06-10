# T003 Product and Code Correctness Map

## Scope

Read-only Scout task: map product/code correctness and architecture improvement opportunities without changing behavior. The `improve-codebase-architecture` skill was not loaded because this task said it is a later execution requirement, not a prep-time dependency.

## Commands Run

- `find apps/kernel/src apps/cloud/src apps/ui/src packages/sdk/src packages/cli/src -type f -maxdepth 4 -print | sort`
- `find apps/kernel/src apps/cloud/src apps/ui/src packages/sdk/src packages/cli/src -type f \\( -name '*.ts' -o -name '*.rs' -o -name '*.mjs' \\) -print0 | xargs -0 wc -l`
- `rg -n 'TODO|FIXME|HACK|XXX|@ts-ignore|@ts-expect|unwrap\\(|panic!|expect\\(|any\\b|as any|throw new Error|process\\.exit' apps/kernel/src apps/cloud/src apps/ui/src packages/sdk/src packages/cli/src scripts tests -g '!apps/kernel/src/stdlib.bundle.txt'`
- `sed -n '1,260p' docs/CODEBASE-STATE.md`
- `sed -n '1,220p' docs/PRODUCT.md`
- `sed -n '1,220p' docs/SYSTEM-LIMITS.md`
- `rg -n 'montydyn-snapshots|montydyn_kernel|montydyn-v|engram-rust2|engram-rust1b|engram-rustf|engram-bench-w4|engram-kernel-ouru|montydyn-ui|montydyn-v12|engram-scale-cloud' apps packages docs scripts tests -g '!apps/kernel/src/stdlib.bundle.txt'`
- `curl -sS -i --max-time 10 https://engram-ui.umg-bhalla88.workers.dev/healthz`
- `sed -n '1,130p' apps/ui/index.html`
- `sed -n '1,80p' apps/ui/src/main.ts`
- `sed -n '1,140p' apps/docs/src/content/docs/how-it-works/architecture.md`
- `sed -n '1,180p' apps/kernel/ARCHITECTURE.md`
- `sed -n '1,120p' apps/kernel/Cargo.toml`
- `sed -n '1,40p' apps/cloud/package-lock.json`

## Current Code Shape

- Main authored runtime surfaces:
  - Kernel Rust DO: `apps/kernel/src/lib.rs` (1226 lines).
  - Kernel JS/WASI glue authored TS: `apps/kernel/src/kernel-glue.ts` (1227 lines).
  - Cloud supervisor: `apps/cloud/src/supervisor.ts` (667 lines).
  - UI: `apps/ui/src/main.ts`, `apps/ui/src/kernel.ts`, `apps/ui/src/seed.ts`, `apps/ui/src/styles.css`.
  - SDK: `packages/sdk/src/index.ts` (1490 lines).
  - CLI: `packages/cli/src/repl.ts` and `packages/cli/src/engram.ts`.
- Generated/bundled files are checked into source paths and dominate line counts, especially `apps/kernel/src/kernel-glue.mjs` (214128 lines) and stdlib bundles. This is likely intentional for deployment, but it makes search/review noisy.

## Product/Code Correctness Findings

1. Current UI defaults are now correct: `apps/ui/src/main.ts` and `apps/ui/index.html` default to `wss://engram-kernel.umg-bhalla88.workers.dev`, not the deleted `engram-bench-w4` endpoint. Older `docs/CODEBASE-STATE.md` still says the UI default points at deleted `engram-bench-w4`; that part is stale.
2. `scripts/e2e-ui.ts` is stale against the current UI worker:
   - It defaults `KERNEL_ENDPOINT` to `wss://engram-bench-w4.umg-bhalla88.workers.dev`.
   - It asserts the served HTML includes `engram-bench-w4.umg-bhalla88.workers.dev`.
   - It expects `/healthz` to return JSON `{ ok: true, app: "engram-ui" }`, but the live assets-only UI serves the SPA HTML at `/healthz` with HTTP 200 and `content-type: text/html`.
3. Docs/resource naming drift remains:
   - `apps/docs/src/content/docs/reference/deployed.md` names R2 `montydyn-snapshots` and AE `montydyn_kernel`, while current configs/live checks use `engram-snapshots` and `engram_kernel`.
   - `apps/docs/src/content/docs/how-it-works/architecture.md` still names AE `montydyn_kernel`.
4. App/package identity drift remains:
   - `apps/kernel/package.json` name is `engram-rust1b`, while `apps/kernel/Cargo.toml` is `engram-rust` and the deployed worker is `engram-kernel`.
   - `apps/cloud/package-lock.json` root name is `montydyn-v11`, while `apps/cloud/package.json` is `@engram/cloud-app`.
   - `apps/kernel/ARCHITECTURE.md` still presents the scratch `engram-rust2` build as deployed, even though current deployed worker is `engram-kernel`.
5. Marker scan did not expose a clear urgent correctness bug in current app code. The notable code concerns are mostly maintainability/reviewability: broad `any` usage in the SDK WebSocket abstraction, Rust `unwrap/expect` in setup/checkpoint paths, and generated artifacts under source trees.

## Highest-Leverage Low-Risk Candidates

- Fix `scripts/e2e-ui.ts` so it targets current `engram-kernel`, checks the actual assets-only UI surface, and stops asserting deleted bench-worker strings.
- Reconcile docs/reference deployed resources with live configs: `engram-snapshots`, `engram_kernel`, and docs worker.
- Add a root no-write check script that uses the typechecks already proven green; this converts discovered verification knowledge into a repeatable operator gate.
- Normalize obvious package identity drift only if lockfile/package-manager implications are understood by Judge first.

## Owner-Approval or Deferred Items

- Do not rename deployed resources, R2 buckets, AE datasets, or worker names in this tranche without explicit approval.
- Do not delete historical docs/results or old proof scripts; many are provenance, not current product docs.
- Do not refactor SDK `any` usage or Rust unwraps until a focused architecture task with stronger tests is selected.
