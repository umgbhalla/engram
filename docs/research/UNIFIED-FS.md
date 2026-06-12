# Unified Filesystem — one namespace, one key, one coherence

> **One line:** "R2 is the bytes, the manifest is the truth, the heap is a cache."
> Build the unified data plane on what's already shipped (`host.fs` R2 provider +
> the `fs_files` SQLite manifest + the staged-commit invariant), **demote** the
> in-heap VFS to a sync read-cache, and make that one namespace mountable by every
> consumer in its native idiom. **Do NOT adopt artifact-fs as the primitive.**

Cross-links: [`COMPUTE-EDGE-AND-SUBSTRATE.md`](./COMPUTE-EDGE-AND-SUBSTRATE.md)
(why one fs is load-bearing for the muscle ladder + the pointer contract) ·
[`ACTION-ITEMS.md`](./ACTION-ITEMS.md) · [`ROADMAP-TODO.md`](./ROADMAP-TODO.md) ·
`../SANDBOX-API.md` (the coherence invariant this design must preserve).

Engram files referenced: `apps/kernel/engine/src/lib.rs` (in-heap VFS ~2325, node
compat caveats ~2228/2251), `apps/kernel/src/lib.rs` (host.fs R2 provider, `fs_files`
manifest ~365, `flush_staged_fs` ~721, `vfs-write/read/stat/ls` frames ~828–1060,
`reconcile_fs_files` post-invoke, artifacts ~1647–2011), `apps/kernel/src/kernel-glue.mjs`
(`_applyFsProvider` ~1699, `host.__fs` effect ~1575, 64KB HOSTCALL chunking ~2405),
`apps/kernel/entry.ts` (`VfsGateway` ~44). Deploy via alchemy.

---

## 1. The fragmentation problem (what we're solving)

Today the kernel has **five** ways to touch files, none of which agree:

| # | Surface | Where | Sync? | Durable? |
|---|---|---|---|---|
| a | **In-heap VFS** (`fs` builtin, default `provider:'vfs'`) | `globalThis.__vfs` in the WASM heap | **sync** | snapshot-persisted, mem-capped (eats the 18MB ceiling) |
| b | **host.fs R2 provider** (`config.fs.provider:'r2'`) | R2 `fs/<doId>/<path>` + `fs_files` SQLite manifest | async | yes, off-heap |
| c | **Artifacts** (`s.readArtifact`/`streamArtifact`) | server-side ranged frames, valid only for `lastArtifactCell` | read-only | ephemeral (cell-scoped) |
| d | **Container `/workspace`** | FUSE R2 mount (s3fs) | "sync" (not POSIX) | yes, but uncoordinated |
| e | **KV sugar** (`s.set`/`s.get`) | JSON in DO SQLite | — | yes |

A cell writes to (a), a hash-worker reads from (b), a container writes to (d), the
SDK streams (c) — and none of them are guaranteed to be looking at the same bytes.
For Engram to be a **substrate** (other people's bindings reading/writing coherently),
this MUST collapse to one namespace with one coherence authority.

---

## 2. Research verdict — artifact-fs / R2-mount / node:fs

**`github.com/cloudflare/artifact-fs` is NOT the unification primitive.** It's a
client/container-side Go FUSE daemon that mounts **git repositories** with lazy blob
hydration (blobless clone → on-demand `git cat-file --batch` → SQLite snapshot index +
CoW overlay → 500ms refs watcher). Beta, Apache-2.0, Go 1.24+, known perf cliffs
(~7s `git status` at 5800 entries). Useful only *inside* Tier2 containers for fast
git mounts — **not an R2 fs, not a Workers binding, not usable in a DO.**

**Cloudflare Artifacts** (the hosted companion, closed beta) is "versioned storage
that speaks Git" built **on Durable Objects, not R2** — git-semantics-only, ops-priced
($0.15/1k + $0.50/GB-mo), short-lived per-repo tokens, fork-from-commit. Not a primary
byte plane. **But:** its internal shape (DO SQLite metadata authority + R2 bodies +
overlay + reconcile) **validates exactly what Engram already shipped.** Treat Artifacts
as a future *versioning adapter* (time-travel/fork of session fs), not the data plane.

**Other platform mechanisms (mid-2026):**
- **Sandbox `mountBucket()`** — s3fs FUSE; supports **R2-binding mounts (no creds)**,
  `prefix` option (the `fs/<doId>/` isolation seam), `readonly`, `credentialProxy:true`.
  Hard caveats: NOT POSIX; mounts **lost on sandbox sleep → remount on wake**; shared
  across sandbox sessions; recent SDK added `S3FSMountError`/`BucketUnmountError`
  (failures used to be silent — pin a recent `@cloudflare/sandbox`).
- **Workers `node:fs` virtual FS** — native, ephemeral per-request; in a DO the temp
  space is shared across requests for the DO's in-memory lifetime. CF is "exploring"
  R2/DO-persistent backing but **nothing shipped; there is NO R2 filesystem binding.**
  Useful only as host-side scratch, not durability.
- **R2 semantics** — strongly consistent (read-after-write), conditional writes
  (`onlyIf:{etagMatches}` = CAS), event notifications → Queues. **No append, no partial
  PUT, no atomic rename, no directories** (already encoded as read-modify-write in
  `vfs_write`).

**Verdict: build the unified layer on R2 + the kernel manifest, the same shape we
already ship.** Small delta over live code, validated by Artifacts' own architecture.

---

## 3. The chosen design — one namespace, four planes

### Plane 1 — Data: R2, path-keyed
Canonical key: `fs/<tenantId>/<sessionDoId>/<normpath>` (today `fs/<doId>/…`; insert
the tenant segment only at engram-cloud session-mint time, so single-tenant paths
never change). Subspaces:

- `…/live/<normpath>` — the mutable tree. **Path-keyed, NOT content-addressed**,
  because s3fs `prefix` mounts and `ls` need keys==paths to see a real tree. Old
  sessions keep old keys via the manifest's `r2_key` indirection → **no data ever
  migrates.**
- `…/cas/<sha256>` — immutable content-addressed artifacts/results (the muscle-ladder
  pointer targets). `s.readArtifact`/`streamArtifact` re-backed by `cas/` rows.
- `…/.engram/manifest.json` — committed-view export per checkpoint (any external
  consumer reads it without SQLite) + a small commit journal.
- `code/<sha256>` — global, cross-session, read-only code registry (Tier1 hash-workers;
  sha256 = id = integrity = warm-cache key).

### Plane 2 — Coherence: extend `fs_files`, two named write modes
`fs_files(path PK, r2_key, size, cell, created_ms, etag, sha256?, origin, mode)` +
a session-level monotonic **`fsVersion`** bumped per commit (cheap cache-invalidation
token). Formalize what the code already does into two modes:

- **mode:txn** — in-VM cell writes: STAGED in DO memory → committed atomically WITH
  the heap checkpoint (the proven `flush_staged_fs` invariant). Heap and fs are always
  at one byte-identical version. **Untouched — the crown jewel.**
- **mode:direct** — `vfs-*` frames, hash-workers, containers, external bindings:
  immediate-durable R2-put-then-manifest-upsert, then **reconciled** at a boundary.
  Generalize the shipped post-`worker-invoke` `reconcile_fs_files()` into one
  `fsReconcile(prefix)` op, invoked after every muscle invoke, on container
  exec-return / wake-remount, on any vfs frame, and (async writers) via R2-event →
  Queue → supervisor wake.

Conflict rule: last-writer-wins per R2; the manifest records the etag the session last
saw, so a cell read of an externally-changed file surfaces `{etag, changed:true}`
instead of silent entropy. Cooperative writers use R2 `onlyIf:{etagMatches}` CAS.

### Plane 3 — Mounts: same bytes, native idiom per consumer

| Consumer | Mount |
|---|---|
| VM cell (`fs`, `host.fs`) | `host.__fs` R2 provider — **becomes the default**; in-heap VFS renamed `provider:'heap'`, opt-in |
| Hash-worker (Tier1) | `env.VFS` = `VfsGateway` stub, prefix-pinned via trusted props (exists; finish `ctx.exports` wiring) |
| Sandbox container (Tier2) | `mountBucket(SNAPSHOTS,{prefix:'/fs/<tenant>/<doId>'})` — `mode:sync` (copy-in/out, default) or `mode:mount` (FUSE + reconcile) |
| Workflow step (Tier3) | service-binding call to the gateway (no direct bucket) |
| External binding | lease-minted: gateway service binding, or scoped temp S3 creds |
| SDK / UI client | existing `vfs-read/write/ls/stat` frames (unchanged wire) |

### Plane 4 — Capability: the `FsLease`
Every mount is derived from `{leaseId, tenantId, prefix, modes, byteQuota, fileQuota,
ttlMs}`, minted only by the kernel/supervisor, recorded in SQLite, AE-metered per
(tenant, leaseId, op). `VfsGateway` props-pinning is the reference monitor (fail-closed,
never hand out the raw bucket). See `COMPUTE-EDGE-AND-SUBSTRATE.md` §2.

---

## 4. In-heap VFS — demoted, NOT deleted (the heap as page cache)

The in-heap VFS code stays; its **role flips** under the new default `provider:'unified'`
(alias the old `'r2'`):

- `fs.promises.*` always works (host round-trip, 64KB chunking — shipped).
- **Sync methods work iff the path is warm** in an in-heap LRU (reuse `__vfs` as the
  cache store, capped ~4–8MB — well under the 18MB ceiling). A cold sync read throws a
  typed **`ERR_FS_COLD`** ("EWOULDBLOCK-warm"): `fs.readFileSync('/a')` → throw; fix:
  `await fs.promises.warm('/a')` or `await host.fs.warm([paths])` at cell top. Writes
  are write-through (update cache + stage host op).
- Cache entries carry the manifest `etag`; at each cell start the glue compares
  `fsVersion` and drops stale entries (O(1) when unchanged). Snapshot-persisting the
  cache is harmless — it's revalidated on wake. Eviction is trivial because truth is R2.
- **`/tmp/**` stays pure in-heap** (never persisted to R2): zero-latency deterministic
  scratch, snapshot-carried, exempt from quota — and the implementation substrate of
  the cache itself.

What MUST stay in the heap stays (closures, promises, live objects, the cache, `/tmp`)
— snapshot fidelity untouched. File **bodies** leave the heap → smaller snapshots, no
more file-driven heap high-water-mark.

`provider:'vfs'`/`'heap'` remains for fully-deterministic / zero-binding sessions and
is the implementation substrate of `/tmp` + the cache — so it is not deleted, only
de-defaulted.

---

## 5. Sync-over-async reads — the tradeoff, stated honestly

Real Node code (and isomorphic-git, most stdlib) expects `readFileSync`. Truth on R2
is irreducibly async from a parked single-threaded VM. The cache + `ERR_FS_COLD`
pattern buys sync semantics for *warm* paths at the cost of:

- a new failure mode (cold sync read throws — strictly *more* capable than today's
  `ERR_FS_ASYNC_ONLY`, which threw on *all* sync calls for `provider:'r2'`);
- a warm-up step (`fs.promises.warm` / `host.fs.warm` prefetch at cell top);
- bounded heap reuse (~4–8MB) — accepted, because it's evictable and revalidated,
  unlike the old unbounded `__vfs`.

**Alternative rejected:** asyncifying the engine (cost/complexity not worth it).
**Compat gate:** before flipping the default, survey shipped stdlib for `readFileSync`
usage — silent breakage otherwise.

---

## 6. Container FUSE reconciliation

s3fs is explicitly not POSIX (no atomic rename, weak mmap/locking, slow metadata,
its own caches), and mounts die on sandbox sleep. So the container plane cannot be
papered over — it's reconcile-based:

- **`mode:sync` (default, coherent):** declared inputs copied into container scratch
  (`/tmp`), declared outputs copied back through the staged-commit path. Slower,
  perfectly coherent.
- **`mode:mount` (fast, big files):** `mountBucket(prefix)` at `/data/workspace`
  (avoid overlaying `/workspace` image files per CF guidance; symlink if needed),
  `readonly:true` when the cell only reads, **remount on every wake**. On `host.exec`
  return, the kernel lists `live/` with etags, diffs against the manifest, adopts
  new/changed objects as `origin:'container'` rows in the next checkpoint. Conflicts
  (manifest etag moved AND container etag differs) surface as `{__conflict:{ours,
  theirs}}`, LWW by default.

Disjoint lease prefixes per binding are the default partition convention (policy, not
locking) to avoid same-path container-vs-cell clobber between reconcile boundaries.

---

## 7. Migration path — nothing shipped breaks

**Principle:** `fs_files.r2_key` indirection means **no data ever moves**; only
defaults and new subspaces are introduced. `vfs-*` frames, `host.fs`/`fs.promises`
under `provider:'r2'`, eval staged-commit, and the in-heap VFS default all keep
working byte-for-byte at every phase. Each phase is a branch (`feat/unified-fs-pN`)
gated on: genuine evict→cold-restore coherence + the D-harness O1/O2/O3 + adversarial
path-traversal suite + zero regression on `tests/kernel-rust` smoke.

- **Phase 0 — additive, zero behavior change.** Add manifest columns (`etag`, `sha256`,
  `origin`, `mode`) with defaults (NULL etag = "trust r2_key"); record R2 etag on every
  put (staged-flush ~`lib.rs:765` and direct `vfs_write` ~915); add `fsVersion` meta
  bumped per commit. `vfs-*` frame shapes unchanged (new fields additive in `vfs-stat`).
  **Also finish the `ctx.exports.VfsGateway` wiring** that `lib.rs` ~1231 fails closed
  on (today hash-workers may have NO fs at all — fix first, it's the proof-of-pattern).
- **Phase 1 — `provider:'unified'` opt-in.** Implement as `provider:'r2'` + the in-heap
  LRU front: glue sets `__fsProvider='unified'`; sync methods consult the cache, throw
  `ERR_FS_COLD` on miss; add `fs.promises.warm`/`host.fs.warm`; `/tmp` carve-out stays
  in-heap. Existing `'vfs'`/`'r2'` sessions untouched (config persists across cold wake).
- **Phase 2 — namespace + export + reconcile.** New unified sessions write
  `fs/<doId>/live/<path>`; old keys resolve via manifest. Write `.engram/manifest.json`
  at checkpoint. Add `vfs-reconcile` frame + reconcile-on-`host.exec`-return. Wire
  Sandbox (`mountBucket` + `mode:sync`/`mode:mount` + remount-on-wake).
- **Phase 3 — flip the default.** New sessions default `provider:'unified'`; `'vfs'`
  (`'heap'`) becomes opt-in. Update the `__nodeCompat` caveats text (engine `lib.rs`
  ~2228/2251: "fs is an in-heap virtual filesystem" → "fs is R2-backed via the session
  manifest; sync reads need warm paths; /tmp is in-heap"). Re-back artifacts
  (`s.readArtifact`) on `cas/` rows; keep the old ranged-frame wire protocol.
- **Phase 4 — optional adapters.** Cloudflare Artifacts (when public beta) as a
  versioning/fork adapter; artifact-fs binary inside Tier2 containers for git mounts;
  per-session byte quota + orphan-object GC sweep land here if not earlier.

---

## 8. Tradeoffs & risks (the honest residual)

- **Sync-vs-async:** new `ERR_FS_COLD` failure mode + a warm-up step; bounded ~4–8MB
  heap cache reintroduced (evictable, revalidated). Compat survey gate before Phase 1.
- **Snapshot fidelity vs off-heap:** off-heap bodies shrink snapshots and kill the
  file-driven high-water-mark, but atomic-inside-the-blit only holds for mode:txn cell
  writes; class-2/3 writers are by definition outside the heap's commit point — inherent
  to being a substrate, not a regression.
- **POSIX vs object:** manifest papers over rename/mkdir/append for kernel/worker
  consumers; the container FUSE plane cannot be papered over → `mode:sync` default,
  "copy hot files to /tmp", real-POSIX work runs on container-local disk and commits
  back.
- **Determinism erosion:** unified reads break seeded byte-replay unless `(path,etag)`
  pins are recorded per read; deterministic-mode sessions stay on `provider:'vfs'`. MUST
  decide before flipping the default for seeded sessions or the v0.x thesis docs become
  dishonest.
- **Top open unknowns to validate empirically:** (1) is s3fs `prefix` a real *security*
  boundary or just a view (R2-binding credential scope unclear)? — gates untrusted Tier2;
  (2) R2 `onlyIf:{etagMatches}` conditional-PUT behavior via the binding (untested here)
  — gates mode:mount safety; (3) s3fs cache staleness during a live exec (needs a probe
  — `ROADMAP-TODO.md` prototype #3); (4) R2 list latency at 1k–10k manifest entries for
  reconcile.
- **Carried gaps:** no per-session byte quota (file-count cap only), `rm` GC O(n),
  orphaned R2 objects on crash-between-put-and-commit (needs sweep), R2 op-cost
  amplification on many-small-files trees, R2 stale-key prune still blocked on S3 token.
