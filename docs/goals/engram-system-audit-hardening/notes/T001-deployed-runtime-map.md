# T001 Deployed Runtime Map

## Scope

Read-only Scout task: map deployed/runtime confidence for Engram without changing code, deployed resources, or production state.

## Commands Run

- `node /Users/umang/.agents/skills/goalbuddy/scripts/check-update.mjs --json`
- `git status --short`
- `rg --files | rg '(^|/)(wrangler\\.toml|package\\.json|bun\\.lockb|bun\\.lock|pnpm-lock\\.yaml|package-lock\\.json|deploy|smoke|eval|bench|REALCF|PLATFORM|RUST|TODO|\\.github/workflows/)'`
- `sed -n '1,260p' package.json`
- `sed -n '1,320p' apps/kernel/wrangler.jsonc`
- `sed -n '1,360p' apps/cloud/wrangler.jsonc`
- `sed -n '1,300p' apps/ui/wrangler.jsonc`
- `sed -n '1,240p' apps/docs/wrangler.jsonc`
- `sed -n '1,320p' scripts/deploy.ts`
- `sed -n '1,260p' apps/docs/src/content/docs/reference/deployed.md`
- `awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ {print $1}' .env | sort`
- `npx wrangler --version`
- `npx wrangler whoami` with env from .env
- `npx wrangler deployments list --name engram-kernel --json` with env from .env
- `npx wrangler deployments list --name engram-cloud --json` with env from .env
- `npx wrangler deployments list --name engram-ui --json` with env from .env
- `npx wrangler deployments list --name engram-docs --json` with env from .env
- `npx wrangler r2 bucket list` with env from .env
- `npx wrangler secret list --name engram-cloud` with env from .env
- `npx wrangler secret list --name engram-kernel` with env from .env
- `curl -sS -I --max-time 10 https://engram-ui.umg-bhalla88.workers.dev`
- `curl -sS -I --max-time 10 https://engram-docs.umg-bhalla88.workers.dev`
- `curl -sS --max-time 10 https://engram-kernel.umg-bhalla88.workers.dev/health`
- `curl -sS -I --max-time 10 https://engram-kernel.umg-bhalla88.workers.dev/`
- `curl -sS --max-time 10 https://engram-cloud.umg-bhalla88.workers.dev/health`
- `curl -sS --max-time 10 https://engram-cloud.umg-bhalla88.workers.dev/`
- `curl -sS -i --max-time 10 https://engram-cloud.umg-bhalla88.workers.dev/usage`

## Current Deployed Surface

- `engram-kernel`: configured at `apps/kernel/wrangler.jsonc`, main `entry.mjs`, Durable Object binding `KERNEL_DO`, R2 binding `SNAPSHOTS` to bucket `engram-snapshots`, Analytics Engine dataset `engram_kernel`.
- `engram-cloud`: configured at `apps/cloud/wrangler.jsonc`, main `dist/worker.mjs`, Supervisor DO binding `SUPERVISOR`, Worker Loader binding `LOADER`, R2 bucket `engram-snapshots`, AE dataset `engram_kernel`, secret names `ADMIN_TOKEN` and `CF_API_TOKEN`.
- `engram-ui`: configured at `apps/ui/wrangler.jsonc`, static Workers Assets from `./dist`.
- `engram-docs`: configured at `apps/docs/wrangler.jsonc`, static Workers Assets from `./dist`.
- Root deploy scripts cover kernel/cloud/ui: `package.json` has `deploy:kernel`, `deploy:cloud`, `deploy:ui`, and `deploy:all`; `scripts/deploy.ts` hardcodes only `kernel`, `cloud`, and `ui`.

## Live Read-Only Checks

- Cloudflare token worked: `wrangler whoami` resolved account `54a86ffba6a98141d2b1b4a1035334ed`.
- Wrangler deployments listed successfully:
  - `engram-kernel`: latest listed deployment created `2026-06-10T15:40:19.608151Z`, version `2010c54a-dfe5-4b6d-b7da-beca608be14b`.
  - `engram-cloud`: latest listed deployment created `2026-06-05T07:37:05.725364Z`, version `056cb633-9376-4fd4-85b1-55370071719d`.
  - `engram-ui`: latest listed deployment created `2026-06-05T09:26:13.089139Z`, version `efe456a6-9a59-4268-8378-d9891d143615`.
  - `engram-docs`: listed deployment created `2026-06-03T11:31:02.98642Z`, version `b241bfbf-ca56-420d-bc32-53cbca565f75`.
- Public endpoints:
  - `https://engram-kernel.umg-bhalla88.workers.dev/health` returned `ok`.
  - `https://engram-cloud.umg-bhalla88.workers.dev/health` returned `{ ok: true, codeId: "rustkernel-a41a123a789e8069", engineHash: "rust-0bde065ca1cce46430b9066787e6e496", kernel: "rust" }`.
  - `https://engram-cloud.umg-bhalla88.workers.dev/` returned the advertised routes and auth description.
  - Unauthenticated `/usage` returned HTTP 401 `{ "error": "unauthorized" }`, matching source auth gating.
  - `engram-ui` and `engram-docs` returned HTTP 200.
- R2 bucket list includes `engram-snapshots`.

## Source Evidence

- Kernel `/health` route and session DO routing: `apps/kernel/src/lib.rs:1052`.
- Cloud supervisor health, route list, API-key auth, `/usage`, and admin gates: `apps/cloud/src/supervisor.ts:491`, `apps/cloud/src/supervisor.ts:603`, `apps/cloud/src/supervisor.ts:631`, `apps/cloud/src/supervisor.ts:653`.
- Browser client endpoint selection: `apps/ui/src/kernel.ts:68`.
- SDK transport selection between cloud HTTP and kernel/cloud WebSocket: `packages/sdk/src/index.ts:1161`.
- Root deploy target set: `package.json`, `scripts/deploy.ts`.

## Runtime/Deploy Risks and Candidates

1. Medium: local Wrangler is stale for repo expectations. `npx wrangler --version` reported `4.83.0`, while the repo instructions say Wrangler must be at least `4.86.0`; Wrangler also says `4.99.0` is available. Candidate: add a repo-native deploy preflight or pin/update Wrangler so deploy operators do not run below the documented minimum.
2. Medium: deployed docs/reference page names supporting resources as `montydyn-snapshots` and `montydyn_kernel`, but current configs and live R2 check show `engram-snapshots` and `engram_kernel`. Candidate: update docs so operator-facing deployed-resource truth matches current config/live state.
3. Low/Medium: root `deploy:all` excludes `engram-docs` even though docs are part of the deployed surface. This may be intentional, but it is an operator-footgun if `all` is expected to mean all live workers. Candidate: Judge whether docs deploy should be included or separately documented.
4. Low: kernel `/health` returns plain `ok` only, while cloud health returns codeId/engineHash. Candidate: consider a non-breaking richer kernel health route only if tests and clients prove no text-body dependency.
5. Blocked/owner-gated: live admin routes, API-key data-plane checks, and usage metering with real tenant keys require secrets/tenant keys beyond safe unauthenticated checks. Candidate: add a read-only operator smoke that uses existing ignored env keys if present, otherwise skips with a clear message.

## Spawned Candidate Tasks

- Add or repair a deploy/runtime preflight around Wrangler version and read-only live smoke commands.
- Reconcile deployed-resource documentation with current Engram resource names.
- Decide whether docs should be included in root deploy orchestration or explicitly excluded with documentation.
- Add a credential-aware live smoke harness for kernel/cloud/UI/docs that skips owner-gated checks cleanly.
