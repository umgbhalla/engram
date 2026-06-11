# WorkOS Cloud Auth Setup

Engram Cloud uses WorkOS as the account/user source of truth. A WorkOS Organization maps to an Engram account/tenant; a WorkOS User maps to a human identity. Kernel isolation still happens inside Engram by scoping every session/facet under the resolved account id.

## Provisioned Staging Resources

Created with:

```sh
npx workos@latest auth login
npx workos@latest seed --file workos-seed.yml --json
```

Verified resources in the active WorkOS `staging` sandbox:

- Organization: `Engram Sandbox` (`org_01KTTNFWQ30N2KK16F80SJ49XZ`)
- Roles: `engram-admin`, `engram-developer`, `engram-viewer`
- Permissions: `kernel:eval`, `kernel:read`, `kernel:reset`, `session:list`, `session:share`, `usage:read`, `account:admin`

The seed file is idempotent. Re-run it after changing roles/permissions:

```sh
npx workos@latest seed --file workos-seed.yml --json
```

## Runtime Auth Shape

CLI login should use WorkOS CLI Auth/device flow, then exchange the WorkOS identity for an Engram cloud token:

```text
engram login
  -> WorkOS device auth
  -> user approves in browser
  -> CLI sends WorkOS token/session to POST /auth/exchange
  -> engram-cloud validates WorkOS identity and org membership
  -> engram-cloud returns a short-lived Engram token
  -> SDK/CLI sends Authorization: Bearer <engram-token> on /frame, /eval, /usage
```

The data plane should not call WorkOS on every cell. `engram-cloud` should verify Engram-issued short-lived tokens locally, then resolve `{accountId, userId, permissions}` from token claims.

## Account And Session Scoping

Use these stable concepts in cloud storage and facet routing:

```text
account_id       internal Engram account id, backed by WorkOS org id
workos_org_id    WorkOS Organization id
workos_user_id   WorkOS User id
session_id       user-provided durable kernel id
facet_name       kr:<account_id>:<session_id>
```

Do not route by raw untrusted tenant strings from query parameters once WorkOS auth is enabled. The account id must come from verified auth claims.

## Secrets / Env

Cloudflare secrets:

```text
WORKOS_API_KEY
WORKOS_COOKIE_PASSWORD
ENGRAM_AUTH_JWT_SECRET
```

Cloudflare vars / public config:

```text
WORKOS_CLIENT_ID
WORKOS_AUTHKIT_DOMAIN
ENGRAM_AUTH_ISSUER=https://engram-cloud.umg-bhalla88.workers.dev
```

Keep the old `x-api-key` path temporarily for automation/backcompat, but mark it deprecated once `engram login` and token exchange are live.

## Next Implementation Slice

1. Add `apps/cloud` auth middleware that accepts either legacy `x-api-key` or new `Authorization: Bearer`.
2. Add `POST /auth/exchange` to validate WorkOS identity and mint an Engram token.
3. Add account/session tables keyed by WorkOS org/user ids.
4. Add `packages/cli` commands: `login`, `logout`, `whoami`, `orgs`, `use-org`.
5. Change `packages/sdk` HTTP transport to accept `authToken` in addition to `apiKey`.
6. Flip cloud routes from query/header tenant selection to verified account claims.
