// Engram unified-fs — the dependency interfaces. The package depends ONLY on these (a minimal
// R2-binding shape + a manifest store), so it is testable with in-memory fakes and reusable by the
// kernel (real R2 + SQLite), hash-workers (the VfsGateway), and the container bridge — all behind
// the same contract. This is the "extraction-ready, clean boundary" the unified-fs design calls for.

export type Bytes = Uint8Array;

/** A ranged read result; `total` is the full object size (so callers can compute eof). */
export interface R2Body {
  bytes: Bytes;
  etag: string;
  /** total object size in bytes (NOT the ranged slice length) */
  total: number;
}

export interface R2Listed {
  key: string;
  size: number;
  etag: string;
}

/** The minimal R2-binding surface engram-fs needs. The CF R2 binding satisfies this; tests fake it. */
export interface R2Like {
  /** Get an object (optionally a byte range). Returns null if absent. */
  get(key: string, opts?: { offset?: number; length?: number }): Promise<R2Body | null>;
  /** Put an object; returns the committed etag (the version token the manifest records). */
  put(key: string, bytes: Bytes): Promise<{ etag: string }>;
  delete(key: string): Promise<void>;
  /** List object keys under a prefix (single page is fine for engram-fs ls). */
  list(prefix: string): Promise<R2Listed[]>;
  head(key: string): Promise<{ etag: string; size: number } | null>;
}

export type FsOrigin = "cell" | "frame" | "container" | "worker";

/** A manifest row = the durable, authoritative record that a body exists at `r2Key`. */
export interface FsEntry {
  /** logical path, normalized, no leading slash (e.g. "dir/file.txt") */
  path: string;
  /** the actual R2 key the body lives at (indirection => no data migration ever needed) */
  r2Key: string;
  size: number;
  /** R2 committed version token */
  etag: string;
  /** content hash for CAS entries / integrity (optional for live tree) */
  sha256?: string;
  /** monotonic cell counter at write time */
  cell: number;
  createdMs: number;
  origin: FsOrigin;
}

/**
 * The metadata + coherence authority. In the kernel this is the `fs_files` SQLite table; in tests
 * it's an in-memory map. `version()` is the session-monotonic `fsVersion` — per the final review it
 * MUST bump on EVERY durable write/reconcile (not just heap checkpoints), so the read cache can
 * never serve stale bytes where external writers (frames/containers) enter.
 */
export interface ManifestStore {
  get(path: string): Promise<FsEntry | null>;
  upsert(entry: FsEntry): Promise<void>;
  delete(path: string): Promise<void>;
  /** entries whose path is an immediate-or-deeper child of `dirPath` ("" = root) */
  list(dirPath: string): Promise<FsEntry[]>;
  /** bump and return the new fsVersion (called on every durable mutation) */
  bumpVersion(): Promise<number>;
  version(): Promise<number>;
}

/** What a muscle (any tier) returns instead of a payload — keeps the brain heap small. */
export interface Pointer {
  path: string;
  etag: string;
  size: number;
  sha256?: string;
  /** small inline preview (first N bytes as utf8, best-effort) for the brain to glance at */
  preview?: string;
}

export type WriteMode = "direct" | "txn";

export interface EngramFsOptions {
  r2: R2Like;
  manifest: ManifestStore;
  /** the Durable Object id — the hard isolation root; all keys live under fs/<doId>/ */
  doId: string;
  /** monotonic cell counter provider (kernel supplies; defaults to 0) */
  cell?: () => number;
  /** wall-clock ms provider (kernel supplies a seeded/real source; defaults to a fixed epoch in tests) */
  nowMs?: () => number;
  /** bytes of a value to inline as `preview` in returned pointers (default 256) */
  previewBytes?: number;
  /** initial session CWD — relative paths resolve against it; clamped under /workspace (default "/workspace") */
  cwd?: string;
}
