# WorkOS Auth Wave — Remaining Work (PARKED)

Status as of this session. The WorkOS-backed auth wave (#37) is **parked mid-flight**.
Requirements: `docs/WORKOS-INFRA-REQUIREMENTS.md`. Full design: the wave plan (in chat / task #37).

## TL;DR — current infra works WITHOUT WorkOS
- **engram-kernel** (single-tenant): unchanged. Auth = `ENGRAM_KERNEL_KEY` shared bearer (verified live: eval 42).
  SDK `kernelKey` / CLI `ENGRAM_API_KEY` / UI key-entry all work against it. WorkOS is NOT involved in the kernel.
- **engram-cloud** (multi-tenant): WorkOS validation was added **additively** — the existing `md_` api-key →
  tenants-table flow STILL works (verified "legacy regression green" in W1 + W2). Nothing requires WorkOS to
  keep using the cloud with existing keys. If WorkOS secrets were unset, the cloud fails closed only on the
  WorkOS path; legacy keys keep resolving.

## DONE (landed on main, deployed, verified)
- **#38** cloud tenant-spoof fix — server-derive tenant only; deleted `?tenant`/`x-md-tenant`/`anon` fallbacks;
  `requireTenant()` fail-closed; `/sessions` scoped (was cross-tenant `SELECT *`). commit `126f3b1`.
- **W1** WorkOS resolver — `resolveCredential() -> {account=org_id, permissions, credType}`: WorkOS api-key
  (`POST /api_keys/validations`), AuthKit JWT (JWKS WebCrypto), legacy `md_`. account = WorkOS org_id. 60s cache.
  Secrets from keychain: `WORKOS_CLIENT_ID` (var), `WORKOS_API_KEY` (sk_test_ staging, wrangler secret).
  Roles+perms seeded. Live: minted key → org → eval 42 → deleted → 401. commit `d2a9003`.
- **#39** cloud facet kernel re-bake — bake now bundles `zstd-codec.wasm` (`apps/cloud/scripts/bake-rust.ts`);
  cloud checkpoints no longer `ZstdCodecError`; cloud durability verified (evict→cold-restore, state survives). commit `c63a683`.
- **W2** per-op permission enforcement — `x-eg-perms` server-set; op→perm map (eval=kernel:eval, reset=kernel:reset,
  /usage=usage:read, etc.); typed `403 PermissionDeniedError{missing}`; `permissions.includes(slug)` not roles;
  legacy + perms-less keys → developer profile (no regression). Live: viewer eval→403, developer eval→42. commit `7da3270`.

## REMAINING (parked)
- **W4 — CLI device-auth** (`packages/cli`): `engram login` via RFC-8628 device flow (no callback server, survives
  restart) + `logout/whoami/orgs/use-org`; `engram repl` cloud-backed passing the user JWT as apiKey; error taxonomy
  (not-logged-in / expired / no-org / insufficient-permissions / cloud-unavailable). Needs a WorkOS **Public app**
  (client_id, no secret). Caveat: the browser-approval step is human-interactive (can't fully auto-test).
- **W5 — SDK substrate ergonomics + docs** (`packages/sdk` + examples): `Engram.connect({apiKey})` as the
  drop-into-any-CF-worker substrate (one account key = the whole account, single-tenancy, account server-derived);
  typed `AuthInvalidError`/`PermissionDeniedError`; `kernelKey` `@deprecated`; a "drop into any worker" example +
  README. NOTE: the deployed cloud is HTTP-first (`POST /frame`); confirm the SDK cloud transport (HTTP vs a WS
  `/connect` route that may not exist) and use the working one.
- **W3 — Dashboard** (deferred per owner): a minimal AuthKit app at `dashboard.umgbhalla.xyz` (login + API Keys
  Widget to mint org-scoped keys + usage page). Until then mint via the `workos` CLI / console.
- **W6 — account-shared workspaces** (later): account-shared R2 prefixes, mount ownership/visibility, conflict
  surfacing (requirements lines 100-195). Presupposes verified account context (W1).

## OPEN ITEMS / CAVEATS to resolve before GA
1. **Per-key permissions**: this WorkOS env's api-key permission registry is EMPTY → org-scoped api-keys can't
   carry differentiated perms via CLI/API (slug 422s); they default to the developer profile. Populate the api-key
   permission registry in the WorkOS dashboard to scope keys (e.g. a read-only substrate key). User-JWTs already
   carry role-driven perms and enforce correctly.
2. **WorkOS env = staging/sandbox** (`WORKOS_API_KEY` = sk_test_). For production, switch to a production WorkOS
   environment + production secrets; re-seed roles/perms there.
3. **ADMIN_TOKEN** on engram-cloud was rotated to a throwaway during testing → set a real production value
   (`wrangler secret put ADMIN_TOKEN`). It gates `/admin/keys` minting (legacy `md_` keys).
4. **Cloud bake on kernel change**: `apps/cloud/scripts/bake-rust.ts` must re-run whenever `apps/kernel` changes,
   else the facet kernel goes stale (caused #39). Consider wiring it into the cloud deploy.
5. **Custom domains** available: `*.umgbhalla.xyz` (dashboard. / auth. / cloud. / api.) — not yet wired
   (`cloud.umgbhalla.xyz` returns 000). engram-kernel is at `engram.umgbhalla.xyz`.

## Key references
- Active WorkOS env: **staging/sandbox**. Org **"Engram Sandbox" = org_01KTTNFWQ30N2KK16F80SJ49XZ**.
  client_id `client_01KR5KPN41TQAGY5G62QFHY3KG`. CLI: `npx --yes workos@latest` (authenticated, working).
- Cloud deploy: engram-cloud (workers.dev), latest version `9cdc0e23...` (W2). Kernel: engram-kernel, `ENGRAM_AUTH_ENFORCE=1`.
- Files: `apps/cloud/src/supervisor.ts` (resolveCredential, requireTenant, requirePerm, op map),
  `apps/cloud/scripts/{bake-rust.ts,workos-seed.yml}`, `packages/sdk/src/index.ts`, `packages/cli/src/{engram.ts,repl.ts}`.
