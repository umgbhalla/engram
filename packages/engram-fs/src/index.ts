// @engram/fs — the unified filesystem substrate.
//
//   "R2 is the bytes, the manifest is the truth, the heap is a cache."
//
// One namespace per session (fs/<doId>/): a FLAT mutable tree keyed by the /workspace-canonical
// <rel> path (matches the kernel/entry.ts/container scheme — no `live/` subspace, so a container
// s3fs prefix-mount at /workspace sees the same bytes) + an immutable `cas/` store (content-
// addressed results/artifacts). EVERY path resolves under the ONE fs root /workspace (a relative
// path against the session CWD; default /workspace), the prefix is stripped for the R2 key.
// The manifest (ManifestStore) is the metadata + coherence authority; R2 holds the bytes. Every
// durable mutation bumps `fsVersion` (so a read cache can never serve stale bytes — final-review fix).
//
// Two write modes:
//   - "direct": immediate R2-put + manifest-upsert + version bump. The out-of-band / external-writer
//     path (SDK frames, hash-workers, containers). Coherence = boundary-reconciled (LWW + etag).
//   - "txn":    staged in memory, committed atomically by flushStaged(). The in-VM cell-write path
//     whose staged set the kernel flushes together with the heap snapshot (the staged-commit invariant).
//
// Muscle contract: writes return a Pointer { path, etag, size, sha256?, preview } — never a payload —
// keeping the brain heap small. This package is the extraction-ready core (own repo later); the
// kernel/hash-worker/container all consume it behind these interfaces.

import {
  casKey,
  FsPathError,
  liveDirPrefix,
  liveKey,
  manifestKey,
  resolve,
  resolveCwd,
  WORKSPACE_ROOT,
} from "./keys.js";
import type {
  Bytes,
  EngramFsOptions,
  FsEntry,
  FsOrigin,
  ManifestStore,
  Pointer,
  R2Like,
  WriteMode,
} from "./types.js";

export * from "./types.js";
export { FsPathError, normPath, casKey, liveKey, resolve, resolveCwd, WORKSPACE_ROOT } from "./keys.js";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function toBytes(data: string | Bytes): Bytes {
  return typeof data === "string" ? ENC.encode(data) : data;
}

export async function sha256Hex(bytes: Bytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const view = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < view.length; i++) s += view[i].toString(16).padStart(2, "0");
  return s;
}

interface StagedWrite {
  path: string;
  bytes: Bytes;
  origin: FsOrigin;
}

export class EngramFs {
  private readonly r2: R2Like;
  private readonly manifest: ManifestStore;
  private readonly doId: string;
  private readonly cell: () => number;
  private readonly nowMs: () => number;
  private readonly previewBytes: number;
  /** Session CWD — relative paths resolve against it (shell semantics); always under /workspace. */
  private _cwd: string;
  /** txn-mode staging buffer (last-write-wins per path), flushed atomically by the kernel. */
  private staged = new Map<string, StagedWrite>();

  constructor(opts: EngramFsOptions) {
    this.r2 = opts.r2;
    this.manifest = opts.manifest;
    this.doId = opts.doId;
    this.cell = opts.cell ?? (() => 0);
    this.nowMs = opts.nowMs ?? (() => 1_700_000_000_000);
    this.previewBytes = opts.previewBytes ?? 256;
    // CWD defaults to /workspace; a supplied cwd is clamped under /workspace (constructor opt).
    this._cwd = resolveCwd(opts.cwd ?? WORKSPACE_ROOT);
    if (!this.doId) throw new FsPathError("doId required", "EINVAL");
  }

  /** The current working directory (canonical absolute form, default "/workspace"). */
  cwd(): string {
    return this._cwd;
  }

  /** Change the working directory. Resolves `dir` (relative→against cwd, absolute→root-relative),
   * clamps it under /workspace (a `..` that escapes throws EACCES), and stores the canonical form. */
  chdir(dir: string): string {
    this._cwd = resolveCwd(dir, this._cwd);
    return this._cwd;
  }

  /** Resolve a logical path to its R2-relative `<rel>` form against the session CWD. */
  private rel(path: string): string {
    return resolve(path, this._cwd);
  }

  private preview(bytes: Bytes): string {
    try {
      return DEC.decode(bytes.subarray(0, this.previewBytes));
    } catch {
      return "";
    }
  }

  private pointer(entry: FsEntry, bytes?: Bytes): Pointer {
    return {
      path: entry.path,
      etag: entry.etag,
      size: entry.size,
      sha256: entry.sha256,
      preview: bytes ? this.preview(bytes) : undefined,
    };
  }

  /** Write a file. direct = immediate durable; txn = staged (flush later). Returns a Pointer. */
  async writeFile(
    path: string,
    data: string | Bytes,
    opts: { mode?: WriteMode; origin?: FsOrigin } = {},
  ): Promise<Pointer> {
    const p = this.rel(path);
    if (p === "") throw new FsPathError("cannot write the root", "EISDIR");
    const bytes = toBytes(data);
    const origin: FsOrigin = opts.origin ?? "frame";
    if ((opts.mode ?? "direct") === "txn") {
      this.staged.set(p, { path: p, bytes, origin });
      // optimistic pointer (no etag until flush); size is known
      return { path: p, etag: "(staged)", size: bytes.length, preview: this.preview(bytes) };
    }
    const entry = await this.commitOne(p, bytes, origin);
    await this.manifest.bumpVersion(); // EVERY durable write bumps fsVersion (final-review fix)
    return this.pointer(entry, bytes);
  }

  /** Read a file (optionally a byte range). Returns null if absent. */
  async readFile(path: string, opts: { offset?: number; length?: number } = {}): Promise<Bytes | null> {
    const p = this.rel(path);
    // staged (txn) writes are visible to the same session's reads before flush
    const st = this.staged.get(p);
    if (st) {
      const { offset = 0, length } = opts;
      return length == null ? st.bytes.subarray(offset) : st.bytes.subarray(offset, offset + length);
    }
    const entry = await this.manifest.get(p);
    if (!entry) return null;
    const body = await this.r2.get(entry.r2Key, opts);
    return body ? body.bytes : null;
  }

  async readFileText(path: string): Promise<string | null> {
    const b = await this.readFile(path);
    return b == null ? null : DEC.decode(b);
  }

  async stat(path: string): Promise<FsEntry | null> {
    const p = this.rel(path);
    const st = this.staged.get(p);
    if (st) {
      return {
        path: p, r2Key: liveKey(this.doId, p), size: st.bytes.length, etag: "(staged)",
        cell: this.cell(), createdMs: this.nowMs(), origin: st.origin,
      };
    }
    return this.manifest.get(p);
  }

  /** List entries under a directory ("" = whole live tree). Manifest is the authority, not R2. */
  async ls(dir = ""): Promise<FsEntry[]> {
    return this.manifest.list(this.rel(dir));
  }

  async deleteFile(path: string): Promise<boolean> {
    const p = this.rel(path);
    this.staged.delete(p);
    const entry = await this.manifest.get(p);
    if (!entry) return false;
    await this.r2.delete(entry.r2Key);
    await this.manifest.delete(p);
    await this.manifest.bumpVersion();
    return true;
  }

  /** Put an immutable content-addressed object. Dedups (skips the R2 PUT if the body already exists). */
  async putCas(data: string | Bytes): Promise<{ sha256: string; pointer: Pointer }> {
    const bytes = toBytes(data);
    const hash = await sha256Hex(bytes);
    const key = casKey(this.doId, hash);
    const existing = await this.r2.head(key);
    let etag: string;
    if (existing) {
      etag = existing.etag;
    } else {
      ({ etag } = await this.r2.put(key, bytes));
    }
    return {
      sha256: hash,
      pointer: { path: `cas/${hash}`, etag, size: bytes.length, sha256: hash, preview: this.preview(bytes) },
    };
  }

  async readCas(sha256: string): Promise<Bytes | null> {
    const body = await this.r2.get(casKey(this.doId, sha256));
    return body ? body.bytes : null;
  }

  // ----- txn (staged-commit) path -----

  /** Stage a write for atomic flush (the in-VM cell-write path). Alias of writeFile(mode:'txn'). */
  stageWrite(path: string, data: string | Bytes, origin: FsOrigin = "cell"): void {
    const p = this.rel(path);
    if (p === "") throw new FsPathError("cannot write the root", "EISDIR");
    this.staged.set(p, { path: p, bytes: toBytes(data), origin });
  }

  stagedCount(): number {
    return this.staged.size;
  }

  /**
   * Atomically commit all staged writes (the kernel calls this in the same flush as the heap dump,
   * preserving the staged-commit coherence invariant). Bumps fsVersion ONCE. Returns the pointers.
   */
  async flushStaged(): Promise<Pointer[]> {
    if (this.staged.size === 0) return [];
    const writes = [...this.staged.values()];
    const pointers: Pointer[] = [];
    for (const w of writes) {
      const entry = await this.commitOne(w.path, w.bytes, w.origin);
      pointers.push(this.pointer(entry, w.bytes));
    }
    this.staged.clear();
    await this.manifest.bumpVersion();
    return pointers;
  }

  /** Drop staged writes without committing (e.g. a cell that errored before checkpoint). */
  discardStaged(): void {
    this.staged.clear();
  }

  async version(): Promise<number> {
    return this.manifest.version();
  }

  /**
   * Write the committed-manifest export to fs/<doId>/.engram/manifest.json so an EXTERNAL consumer
   * (a container, another binding) can read the session's file index + fsVersion straight from R2,
   * with no SQLite access. The kernel calls this at each checkpoint. Returns the export pointer.
   */
  async exportManifest(): Promise<Pointer> {
    const rows = await this.manifest.list("");
    const version = await this.manifest.version();
    const doc = JSON.stringify({
      doId: this.doId,
      fsVersion: version,
      exportedMs: this.nowMs(),
      files: rows
        .slice()
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((e) => ({ path: e.path, size: e.size, etag: e.etag, sha256: e.sha256, origin: e.origin })),
    });
    const bytes = ENC.encode(doc);
    const key = manifestKey(this.doId);
    const { etag } = await this.r2.put(key, bytes);
    return { path: ".engram/manifest.json", etag, size: bytes.length, preview: this.preview(bytes) };
  }

  // ----- internals -----

  /** Put one body to R2 (live tree) + upsert its manifest row. The atomic unit of a commit. */
  private async commitOne(path: string, bytes: Bytes, origin: FsOrigin): Promise<FsEntry> {
    const key = liveKey(this.doId, path);
    const { etag } = await this.r2.put(key, bytes);
    const entry: FsEntry = {
      path,
      r2Key: key,
      size: bytes.length,
      etag,
      cell: this.cell(),
      createdMs: this.nowMs(),
      origin,
    };
    await this.manifest.upsert(entry);
    return entry;
  }
}

export { liveDirPrefix } from "./keys.js";
