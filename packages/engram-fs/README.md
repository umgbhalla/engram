# @engram/fs

The Engram **unified filesystem substrate**.

> **R2 is the bytes · the manifest is the truth · the heap is a cache.**

One coherent namespace that the durable kernel brain, hash-worker isolates, Sandbox containers, and
external bindings all read/write through the same contract — collapsing today's fragmented fs
surfaces (in-heap VFS, host.fs/R2, artifacts, container `/workspace`, KV sugar) into one.

This package is the **sound core** of the unified-fs design (`docs/research/UNIFIED-FS.md`): the key
scheme, prefix isolation, the manifest authority, the pointer contract, and the txn/direct coherence
modes. It depends on **nothing CF-specific** — only a minimal `R2Like` binding shape + a
`ManifestStore` — so it runs identically with in-memory fakes (tests), the kernel's real R2 +
`fs_files` SQLite table, the hash-worker `VfsGateway`, and the container bridge.

## Why it's its own package (and own repo later)

The fs is cross-cutting: every muscle tier needs it. As a standalone package with a **hard boundary**
(public API only, zero kernel internals), all consumers bind to it uniformly. It is built
**extraction-ready** — when the ABI stabilizes and an external consumer appears, `git subtree split`
it to its own repo with no rewrite. Until then it incubates here for velocity (fs + kernel co-evolve).
The kernel DO stays the **commit coordinator** (preserving the single-DO atomic staged-commit
invariant) — this package is a library, not a separate service, so there is no cross-DO hop or
two-phase-commit cost.

## Model

```
fs/<doId>/                      session root — doId is the HARD isolation boundary (never user input)
  <rel>                         mutable tree, FLAT + PATH-keyed (matches kernel/container scheme; no live/)
  cas/<sha256>                  immutable content-addressed objects (results/artifacts), deduped
  .engram/manifest.json         committed-manifest export (external consumers read without SQLite)
```

`<rel>` is the **/workspace-canonical** path: every path (bare-absolute `/x`, `/workspace/x`, or
relative `x` against the session CWD) resolves under the ONE fs root `/workspace`, then has the
`/workspace` prefix stripped. So `/workspace/a/b`, `/a/b`, and (at cwd=/workspace) `a/b` ALL key to
`fs/<doId>/a/b` — backward-compatible with existing bare-`/` keys, no data migration. A `..` that
escapes `/workspace` throws `EACCES`; NUL throws `EINVAL`. `chdir(dir)` / the `cwd` option move the
CWD (clamped under /workspace); `resolve(path, cwd)` is the shared canonical resolver.

- **Manifest = authority.** A row exists iff the body is durable in R2. `ls`/`stat` read the
  manifest, never R2 listing.
- **`fsVersion` bumps on EVERY durable mutation** (not just heap checkpoints) — so a read cache can
  never serve stale bytes where an external writer (frame/container) enters. (Final-review fix.)
- **Pointers, not payloads.** Writes return `{ path, etag, size, sha256?, preview }`. The muscle
  contract: produce a durable R2 artifact, hand the brain a pointer — keep the ≤18MB heap small.

## Coherence modes

| mode | path | semantics |
|---|---|---|
| `txn` | in-VM cell writes | `stageWrite` → `flushStaged()` commits atomically (the kernel flushes the staged set together with the heap snapshot — the proven staged-commit invariant). Transactional, never torn. |
| `direct` | SDK frames, hash-workers, containers | immediate R2-put + manifest-upsert + version bump. Boundary-reconciled (last-write-wins + etag surfacing), not transactional with the heap. |

## API

```ts
import { EngramFs } from "@engram/fs";

const fs = new EngramFs({ r2, manifest, doId, cell, nowMs });

await fs.writeFile("dir/x.txt", "hi");              // direct (default) → Pointer
await fs.readFileText("dir/x.txt");                 // "hi" | null
await fs.ls("dir");                                 // FsEntry[] (from manifest)
await fs.stat("dir/x.txt");                         // FsEntry | null
await fs.deleteFile("dir/x.txt");

const { sha256, pointer } = await fs.putCas(bytes); // immutable, deduped
await fs.readCas(sha256);

fs.stageWrite("a.txt", "staged");                   // txn: stage…
await fs.flushStaged();                             // …commit atomically (bumps fsVersion once)
await fs.version();                                 // current fsVersion
```

All paths are normalized through the isolation boundary (`normPath`): `..` that escapes the session
root throws `FsPathError` (`EACCES`); NUL throws `EINVAL`; every key is `fs/<doId>/…`, so a session
can never address another session's bytes — proven in `test/engram-fs.test.ts` (cross-session
isolation, traversal rejection, CAS dedup, txn atomicity, fsVersion-on-every-write).

## Kernel consumption (the adapter, when wired)

The kernel implements the two interfaces over its real substrate:
- `R2Like` → the `SNAPSHOTS` R2 binding (`get`/`put`/`delete`/`list`/`head`, with range on `get`).
- `ManifestStore` → the `fs_files(path, r2_key, size, etag, sha256, cell, created_ms, origin)` SQLite
  table + a session `fsVersion` counter.

Then: in-VM cell `fs.*` → `txn` staged set flushed in `flush_staged_fs` (heap + fs one atomic
commit); the `vfs-*` WS frames + the hash-worker `VfsGateway` → `direct`; the container `/workspace`
FUSE mount → `direct` writes reconciled into the manifest post-run (manifest stays source of truth).
The in-heap VFS demotes to a sync read cache, **purged at checkpoint** (final-review fix), with a
typed `ERR_FS_COLD` + `warm()` for the sync-over-async gap.

Status: **core built + tested (17/17), not yet wired into the kernel** (held to avoid clobbering the
in-flight kernel deploys). See `docs/research/ACTION-ITEMS.md` for the wiring plan.
