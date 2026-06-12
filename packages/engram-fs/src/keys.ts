// Key scheme + path normalization — the ISOLATION BOUNDARY. Every R2 key engram-fs touches is
// derived here from (doId, normalized path), and normalization rejects traversal/NUL. Because every
// consumer (kernel, hash-worker gateway, container bridge) goes through these functions, prefix
// isolation is enforced in ONE place: a session can never address another session's keys, and no
// path can escape its session root. This is the security-critical core of the unified fs.

/** A path that tried to escape its session root, or contained a NUL byte. */
export class FsPathError extends Error {
  code: string;
  constructor(message: string, code = "EACCES") {
    super(message);
    this.name = "FsPathError";
    this.code = code;
  }
}

function hasNul(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0) return true;
  return false;
}

/**
 * THE ONE FILESYSTEM ROOT. Every path — bare-absolute, /workspace-prefixed, or relative — resolves
 * to somewhere under /workspace. The owner's invariant: "root file system mapping should ALWAYS be
 * /workspace". A leading-slash path is ROOT-relative (root == /workspace), a bare name is CWD-
 * relative. The R2-relative form (the `<rel>` we key on) is the resolved /workspace path with the
 * "/workspace" prefix stripped — so "/workspace/a/b", "/a/b", and (at cwd=/workspace) "a/b" ALL
 * collapse to "a/b" → key fs/<doId>/a/b. BACKWARD-COMPATIBLE: every previously-written bare-"/a/b"
 * key stays reachable (it resolves to the SAME "a/b" rel), no data migration.
 */
export const WORKSPACE_ROOT = "/workspace";

/**
 * Normalize a chain of segments with ./.. semantics, clamped so the climb never pops above the
 * (implicit) /workspace root. `floor` is the number of leading segments that are the /workspace
 * prefix itself (so a `..` that would remove them THROWS — that is the escape). Returns the kept
 * segments INCLUDING the prefix floor.
 */
function normalizeSegments(rawSegs: string[], floor: number, original: string): string[] {
  const out: string[] = [];
  for (const seg of rawSegs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length <= floor) {
        throw new FsPathError(`path escapes /workspace: ${original}`, "EACCES");
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

const WS_SEGS = WORKSPACE_ROOT.split("/").filter(Boolean); // ["workspace"]

/**
 * Resolve a logical path to its R2-relative form (`<rel>`, no leading slash) under /workspace,
 * honoring a CWD for relative paths (shell semantics). Rules:
 *   - NUL anywhere → EINVAL.
 *   - path starts with "/" → ROOT-relative: joined under /workspace (so "/x" → /workspace/x).
 *   - otherwise → CWD-relative: joined under `cwd` (which is itself confined to /workspace).
 * Then `.`/`..` are normalized and clamped under /workspace (a `..` that escapes throws EACCES).
 * The returned value is the resolved /workspace path with the "/workspace" prefix removed (so the
 * root itself returns ""). This is the single canonical resolver every fs surface funnels through.
 */
export function resolve(path: string, cwd: string = WORKSPACE_ROOT): string {
  if (typeof path !== "string") throw new FsPathError("path must be a string", "EINVAL");
  if (hasNul(path)) throw new FsPathError("path contains NUL", "EINVAL");
  if (typeof cwd !== "string") throw new FsPathError("cwd must be a string", "EINVAL");
  if (hasNul(cwd)) throw new FsPathError("cwd contains NUL", "EINVAL");

  // Build the base chain rooted at /workspace, then append `path` (relative→under cwd). We always
  // carry the literal ["workspace", ...] prefix through normalization with floor=1 so a `..` can
  // never pop above /workspace (that throws EACCES). At the end we strip the prefix to get <rel>.
  let chain: string[];
  if (path.startsWith("/")) {
    // ROOT-relative: from /workspace, ignoring cwd. A caller-supplied "/workspace/..." re-roots at
    // /workspace (strip ONE leading "/workspace"); a bare "/a/b" is also root-relative -> a/b.
    let rooted = path;
    if (rooted === WORKSPACE_ROOT || rooted.startsWith(WORKSPACE_ROOT + "/")) {
      rooted = rooted.slice(WORKSPACE_ROOT.length); // "/workspace/a" -> "/a", "/workspace" -> ""
    }
    chain = [...WS_SEGS, ...rooted.split("/")];
  } else {
    // CWD-relative: normalize the cwd first (root-relative, clamped), then append `path`.
    const cwdSegs = normalizeSegments([...WS_SEGS, ...stripWsPrefix(cwd).split("/")], WS_SEGS.length, cwd);
    chain = [...cwdSegs, ...path.split("/")];
  }
  const segs = normalizeSegments(chain, WS_SEGS.length, path);
  // Strip the /workspace prefix floor -> the R2-relative <rel> form (root itself -> "").
  return segs.slice(WS_SEGS.length).join("/");
}

/** Strip ONE leading "/workspace" so a "/workspace/..."-form cwd re-roots correctly. */
function stripWsPrefix(p: string): string {
  if (p === WORKSPACE_ROOT) return "";
  if (p.startsWith(WORKSPACE_ROOT + "/")) return p.slice(WORKSPACE_ROOT.length);
  return p;
}

/**
 * Normalize a logical path to a clean, root-relative, no-leading-slash form (the R2-relative
 * `<rel>`). Now a thin wrapper over {@link resolve} with the default /workspace CWD, so a bare
 * "/a/b" still maps to "a/b" (SAME key as before — back-compat), and a relative "a/b" maps to
 * "a/b" too (both land under /workspace). Rejects NUL and any `..` that escapes /workspace.
 */
export function normPath(input: string): string {
  return resolve(input, WORKSPACE_ROOT);
}

/**
 * Clamp a candidate CWD under /workspace and return its canonical absolute form ("/workspace" or
 * "/workspace/<rel>"). Used by `chdir`: a relative dir resolves against the current cwd, an
 * absolute dir is root-relative; a `..` that would escape /workspace throws EACCES.
 */
export function resolveCwd(dir: string, cwd: string = WORKSPACE_ROOT): string {
  const rel = resolve(dir, cwd);
  return rel === "" ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${rel}`;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function assertSha256(hash: string): void {
  if (!HEX64.test(hash)) throw new FsPathError(`not a sha256 hex: ${hash}`, "EINVAL");
}

/** Session root prefix. The doId is the hard isolation root and is NEVER taken from user input. */
export function rootPrefix(doId: string): string {
  if (!doId) throw new FsPathError("doId required", "EINVAL");
  return `fs/${doId}/`;
}

/**
 * Key for a mutable file: FLAT `fs/<doId>/<rel>` (no `live/` subspace). This matches the kernel's
 * r2_fs_op / entry.ts VfsGateway / container-mount scheme EXACTLY, so a file written by any surface
 * is the SAME R2 object every other surface sees. `<rel>` is the /workspace-resolved path.
 */
export function liveKey(doId: string, path: string): string {
  const p = normPath(path);
  if (p === "") throw new FsPathError("cannot address the root as a file", "EISDIR");
  return `${rootPrefix(doId)}${p}`;
}

/** Prefix for listing the live tree under a directory ("" = whole tree). FLAT scheme. */
export function liveDirPrefix(doId: string, dir: string): string {
  const p = normPath(dir);
  return p === "" ? `${rootPrefix(doId)}` : `${rootPrefix(doId)}${p}/`;
}

/** Key for an immutable content-addressed object: fs/<doId>/cas/<sha256>. */
export function casKey(doId: string, sha256: string): string {
  assertSha256(sha256);
  return `${rootPrefix(doId)}cas/${sha256}`;
}

/** The committed-manifest export key (readable by external consumers without SQLite). */
export function manifestKey(doId: string): string {
  return `${rootPrefix(doId)}.engram/manifest.json`;
}
