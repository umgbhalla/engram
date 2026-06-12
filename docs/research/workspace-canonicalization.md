# /workspace canonicalization — the ONE filesystem root

**Owner invariant:** "root file system mapping should ALWAYS be /workspace." Relative paths are
allowed but resolve under /workspace ("allow them to be written but write in /workspace then").

## THE RULE (applied at every path→key site)

- **`/workspace` is the ONE filesystem root.** Every path resolves to somewhere under it.
- **Every service/session has a CWD**, default `/workspace`, settable via `process.chdir(dir)` /
  a `cwd` option / a session config — but ALWAYS confined under /workspace (a `chdir` that would
  escape clamps to /workspace, or throws EACCES). `process.cwd()` returns the CWD.
- **Resolution:**
  - `"/workspace/x"` → itself (root = /workspace)
  - bare-absolute `"/x"` → `"/workspace" + "/x"` (ROOT-relative, NOT cwd-relative)
  - relative `"x"` / `"dir/x"` / `"./x"` → `join(CWD, path)`
  - then normalize `.`/`..` and clamp under /workspace.
  - With CWD=/workspace: `"x.txt"`, `"/x.txt"`, `"/workspace/x.txt"` are ALL the same.
  - With CWD=/workspace/proj: `"x.txt"`→`/workspace/proj/x.txt`, `"/x.txt"`→`/workspace/x.txt`.
- **R2 key = `fs/<doId>/<rel>`**, `<rel>` = the resolved-under-/workspace path with the
  `/workspace` prefix stripped. So `/workspace/a/b.txt`, `/a/b.txt`, and `a/b.txt` ALL map to
  `fs/<doId>/a/b.txt` — **BACKWARD-COMPATIBLE** (existing bare-`/` keys stay reachable; NO
  migration).
- Only a `..` that escapes /workspace throws **EACCES**. NUL throws **EINVAL**.

## Where it lives (one shared resolver per surface)

| Surface | File | Resolver |
|---|---|---|
| @engram/fs core | `packages/engram-fs/src/keys.ts` | `WORKSPACE_ROOT`, `resolve(path,cwd)`, `resolveCwd`, `normPath` (= resolve at default cwd) |
| @engram/fs class | `packages/engram-fs/src/index.ts` | `EngramFs` gains `cwd()` / `chdir()` + `cwd` ctor opt; every op resolves via `this.rel()` |
| Kernel cell fs (VM) | `apps/kernel/engine/src/lib.rs` | the fs-shim `norm()` is /workspace+CWD-aware; `process.cwd/chdir` drive `globalThis.__cwd` (default /workspace, clamped) |
| Kernel DO fs | `apps/kernel/src/lib.rs` | `norm_fs_path_cwd(p,cwd)` (+ default-cwd `norm_fs_path` shim); vfs-* read a frame `cwd` |
| Hash-worker gateway | `apps/kernel/entry.ts` | `VfsGateway` uses `resolve(path, props.cwd ?? /workspace)` |
| SDK fs frames | `packages/sdk/src/index.ts` | `read/write/ls/stat` accept `cwd` (default /workspace), threaded into the frame; kernel resolves DO-side |
| Container mount | `apps/sandbox/src/index.ts` | the R2 prefix `fs/<doId>/` mounts at **/workspace** (was /session); exec/git cwd default /workspace |

### Flat key scheme

`@engram/fs` previously keyed `fs/<doId>/live/<rel>`. Dropped the `live/` subspace → `fs/<doId>/<rel>`,
matching the kernel `r2_fs_op` / `entry.ts` VfsGateway / container-mount layout. `liveKey` is not
consumed at runtime by the kernel (only `normPath`/`resolve` are tree-shaken into entry.ts), so the
re-point is safe; kernel-written data was always flat → no migration.

### Backward-compat (load-bearing)

A leading-slash path is treated as ROOT-relative under /workspace, so legacy bare `"/a/b"` →
rel `"a/b"` → the SAME key `fs/<doId>/a/b` it always had. Full regression (existing tests use bare
`/paths`) stays green. The DO-side `norm_fs_path_cwd` returns the same leading-slash `<rel>` form
the previous `norm_fs_path` did, so the unchanged key derivation
`format!("{}{}", prefix, path.trim_start_matches('/'))` yields identical keys.

## Container mount at /workspace (seeded-dir fix)

The `@cloudflare/sandbox` base image seeds `/workspace`. `ensureSessionMount` now, on a fresh
container (gated strictly on `mountpoint -q /workspace` returning non-zero, i.e. NOT already an R2
mount, so we never `rm` R2-backed bytes), clears the seed then mounts the kernel session's R2
prefix `fs/<doId>/` at /workspace with `s3fsOptions:["nonempty"]` so the R2 files win. Result: a
cell's `/workspace/x.txt` is LITERALLY the container's `/workspace/x.txt` over the same R2 key.

## Kernel ↔ engram-sandbox binding

Already present end-to-end (DO-side fetch in `sandbox_frame` / glue `_doSandbox`, Bearer
`ENGRAM_SANDBOX_KEY` + `x-engram-session: <kernel doId>`, capability-gated on `config.sandbox`).
This change flips the mount to /workspace and adds a typed **SandboxDisabledError** in the SDK
(maps the kernel's `SandboxUnavailable` string) so a disabled sandbox is `instanceof`-checkable.

## Engine-hash

The `apps/kernel/engine/src/lib.rs` bootstrap-JS change rebumps the build-time engine-hash
(expected/acceptable; guards a snapshot from being restored under a mismatched engine).
