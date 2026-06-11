# WorkOS-Backed Shared Cloud Infrastructure Requirements

Engram Cloud must support a shared cloud infrastructure model where many users and
organizations run durable sessions on the same deployed platform, while account identity,
authorization, durable kernel state, workspace access, usage, and admin actions remain correctly
scoped.

This document defines product and infrastructure requirements only. It does not prescribe
implementation mechanisms.

## Core Requirement

Engram Cloud must use WorkOS as the source of truth for human users, organizations, roles, and
permissions. A WorkOS Organization represents an Engram account. A WorkOS User represents an
authenticated human. Engram sessions, workspaces, usage records, and shared resources must be
resolved through verified WorkOS-backed account context, not through untrusted client-provided
tenant labels.

The system must allow one shared Engram Cloud deployment to serve many organizations safely.
Sharing infrastructure is expected and desired. Isolation must be applied where correctness,
security, billing, or user expectations require it.

## Account Model

- A WorkOS Organization maps to one Engram account.
- A WorkOS User maps to one Engram user identity.
- A user may belong to multiple accounts.
- The active account must be explicit when a user has access to more than one account.
- All data-plane access must resolve to a verified account before a session, workspace, or usage object is touched.
- Account identity must not be derived from query-string tenant values, raw session names, or user-editable metadata.

## Authentication Requirements

- CLI users must be able to authenticate through WorkOS without manually handling API keys.
- CLI login must work without requiring a local callback server.
- CLI auth state must survive process restarts.
- Expired auth must fail clearly and support re-login.
- Users with no organization membership must receive a clear authorization error.
- Users with multiple organizations must be able to inspect and select the active organization.
- Human user auth and automation or service credentials must be distinguishable.

## Authorization Requirements

Access must be controlled by verified WorkOS organization membership and permissions.

Required permissions:

- kernel:eval
- kernel:read
- kernel:reset
- session:list
- session:share
- usage:read
- account:admin

Required roles:

- engram-admin
- engram-developer
- engram-viewer

Authorization must fail closed. Users must not be able to infer, access, mutate, or reset resources
outside their authorized account boundary.

## Session Requirements

- Every Engram session must belong to exactly one account.
- A session may be private to one user or shared within an account.
- Session visibility must be explicit: private, shared account session, or service/automation session.
- Session listing must respect account and visibility rules.
- Eval, read, reset, evict, delete, and sharing actions must require the appropriate permission.
- Session IDs must not allow escaping account boundaries.
- Durable kernel heap state must remain isolated per session.
- Durable kernel heap state must not be shared across accounts.

## Shared Infrastructure Requirements

Engram should share infrastructure where sharing improves cost, startup time, cache hit rate, or
collaboration without violating account boundaries.

Shared resources may include:

- Cloudflare Worker deployments.
- Supervisor/control-plane Durable Objects.
- Worker Loader kernel code bundles.
- Runtime code artifacts and WASM modules.
- Package caches and dependency layers.
- Read-only base images or base runtime filesystems.
- Public documentation and static UI assets.
- Global routing and health-check surfaces.
- Global observability pipelines.
- Aggregated, account-tagged usage events.
- Shared object-store buckets with account-scoped key prefixes.
- Shared metadata indexes where every row is account-scoped.
- Shared mounted workspace backends when access is explicitly account-scoped.

Shared infrastructure must never imply shared authorization. Any shared store, cache, mount, or
backend must enforce account-scoped reads and writes.

## Storage Requirements

Not every session should receive a completely independent storage folder by default. Storage should
support multiple scopes:

- Session-private storage: state that belongs only to one durable kernel session.
- User-private storage: files and metadata private to a user across sessions in the same account.
- Account-shared storage: workspace files, package artifacts, notebooks, datasets, and outputs shared by authorized account members.
- System-shared storage: read-only runtime assets, package caches, templates, and base layers shared across accounts.

Account-shared storage is required. Many sessions in the same account should be able to mount the
same workspace or project storage instead of duplicating it into each session. This is the expected
model for collaborative notebooks, shared repos, reusable datasets, and shared generated artifacts.

Session-private storage must still exist for ephemeral scratch state, temporary files, isolated
experiments, and security-sensitive per-session material.

## Mounted Workspace Requirements

Engram must support mounted workspaces as first-class account resources.

A mounted workspace may be:

- Backed by an object store.
- Backed by a synchronized local folder bridge.
- Backed by a git repository checkout.
- Backed by a virtual filesystem over account storage.
- Shared by many sessions in the same account.

Workspace mounts must have clear ownership and visibility:

- Private user mount.
- Account-shared mount.
- Read-only shared mount.
- Service-owned mount.

Multiple sessions may read and write the same mounted workspace when authorized. The system must
tolerate concurrent writers. Strong global locking is not required for every operation, but
conflicts must not silently corrupt data.

## Consistency Requirements

Eventual consistency is acceptable for shared workspace and backend storage when the user
experience makes that contract clear.

Eventual consistency is acceptable for:

- Workspace file sync.
- Directory listings.
- Search indexes.
- Package cache updates.
- Artifact discovery.
- Usage and billing dashboards.
- Cross-session visibility of newly written files.
- Background compaction or cleanup.

Strong consistency is required for:

- Authorization checks.
- Account boundary enforcement.
- Session ownership and visibility decisions.
- Kernel eval ordering within one session.
- Durable checkpoint commit order within one session.
- Reset/delete authorization.
- Secret access.
- Billing-critical event attribution at write time.

A user must never see another account's data because of eventual consistency. Delayed visibility is
acceptable; cross-account leakage is not.

## Workspace Conflict Requirements

When multiple sessions write to the same shared workspace:

- The system must preserve enough metadata to identify writer, session, account, timestamp, and source path.
- Overwrites must be detectable.
- Conflicts must be surfaced as conflicts or versioned writes when safe automatic merge is not possible.
- Background sync must be resumable.
- Failed sync must not destroy the last known good version.
- Deletes must be auditable or recoverable for shared workspaces.

## Backend Storage Sharing Requirements

Backend storage may be physically shared if logical isolation is strict.

Acceptable shared backends:

- One object bucket with account-scoped prefixes.
- One metadata database with account-scoped rows.
- One analytics dataset with account identifiers.
- One cache namespace with account-aware keys.
- One package/artifact cache for public or content-addressed data.

Storage that contains secrets, private source, notebook outputs, user files, or mounted workspace
contents must be account-scoped. Public or content-addressed immutable cache data may be shared
globally if it does not encode private account information.

## CLI Requirements

The CLI must support:

- engram login
- engram logout
- engram whoami
- engram orgs
- engram use-org
- cloud-backed engram repl without manually passing API keys after login

CLI errors must clearly distinguish:

- not logged in
- expired login
- no organization selected
- insufficient permissions
- cloud unavailable
- workspace unavailable
- workspace sync delayed
- storage conflict

The CLI must continue supporting explicit endpoint and session options.

## Usage And Billing Requirements

Usage must be attributable to the verified account. Client-provided tenant labels are not
acceptable for billing or enforcement.

Usage data must include at least:

- eval count
- active sessions
- checkpoint/storage bytes
- artifact/storage bytes
- workspace storage bytes
- warm/keepalive time where applicable
- egress where applicable

Users without usage:read must not access usage data.

Usage dashboards may be eventually consistent. Usage event attribution at write time must be
correct.

## Security Requirements

- No WorkOS or Engram secrets may be committed.
- Auth must fail closed when configuration is missing or invalid.
- Session, usage, workspace, and admin routes must reject unauthenticated requests.
- Cross-account data leakage is a blocking failure.
- Legacy API keys must be separated from WorkOS-authenticated users.
- Secret material must not be placed in shared workspace storage.
- Shared caches must not expose private account data through cache keys, filenames, previews, or metadata.
- Error responses must not expose token contents or private auth state.

## Migration Requirements

Existing legacy API-key access may remain temporarily for automation and compatibility. It must be
clearly marked as legacy. WorkOS-backed auth must become the primary human-user path.

Existing durable session behavior must remain intact during migration:

- session hibernation
- cold restore
- eval ordering
- checkpointing
- usage metering
- rich MIME output behavior

## Acceptance Criteria

- A user can authenticate from the CLI and inspect their WorkOS identity.
- A user can select the Engram Sandbox organization.
- A user with kernel:eval can run a cloud-backed eval.
- A user without kernel:eval cannot run eval.
- A user cannot list or access sessions from another organization.
- A user can mount or access an account-shared workspace from more than one session.
- Two sessions in the same account can observe shared workspace changes with documented eventual consistency.
- Two sessions in different accounts cannot access each other's workspace files, artifacts, sessions, or usage data.
- A viewer can read allowed metadata but cannot reset sessions.
- An admin can view account usage.
- Missing WorkOS configuration produces clear startup or request errors.
- WorkOS staging resources are reproducible from workos-seed.yml.
