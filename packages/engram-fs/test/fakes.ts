// In-memory fakes of the R2 binding + manifest store, so engram-fs is testable with zero CF deps.
// The kernel swaps these for the real R2 binding + the fs_files SQLite table behind the SAME
// interfaces — the package logic (keys, isolation, txn/direct, fsVersion, CAS dedup) is identical.

import type { Bytes, FsEntry, ManifestStore, R2Body, R2Like, R2Listed } from "../src/types.js";

export class FakeR2 implements R2Like {
  store = new Map<string, Bytes>();
  putCount = 0;
  private seq = 0;
  private etags = new Map<string, string>();

  async get(key: string, opts?: { offset?: number; length?: number }): Promise<R2Body | null> {
    const b = this.store.get(key);
    if (!b) return null;
    const { offset = 0, length } = opts ?? {};
    const slice = length == null ? b.subarray(offset) : b.subarray(offset, offset + length);
    return { bytes: slice, etag: this.etags.get(key)!, total: b.length };
  }
  async put(key: string, bytes: Bytes): Promise<{ etag: string }> {
    this.putCount++;
    const etag = `etag-${++this.seq}`;
    this.store.set(key, bytes);
    this.etags.set(key, etag);
    return { etag };
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.etags.delete(key);
  }
  async list(prefix: string): Promise<R2Listed[]> {
    const out: R2Listed[] = [];
    for (const [key, b] of this.store) {
      if (key.startsWith(prefix)) out.push({ key, size: b.length, etag: this.etags.get(key)! });
    }
    return out;
  }
  async head(key: string): Promise<{ etag: string; size: number } | null> {
    const b = this.store.get(key);
    return b ? { etag: this.etags.get(key)!, size: b.length } : null;
  }
}

export class FakeManifest implements ManifestStore {
  rows = new Map<string, FsEntry>();
  private ver = 0;
  bumpCount = 0;

  async get(path: string): Promise<FsEntry | null> {
    return this.rows.get(path) ?? null;
  }
  async upsert(entry: FsEntry): Promise<void> {
    this.rows.set(entry.path, { ...entry });
  }
  async delete(path: string): Promise<void> {
    this.rows.delete(path);
  }
  async list(dirPath: string): Promise<FsEntry[]> {
    const pfx = dirPath === "" ? "" : dirPath + "/";
    return [...this.rows.values()].filter((e) => e.path.startsWith(pfx));
  }
  async bumpVersion(): Promise<number> {
    this.bumpCount++;
    return ++this.ver;
  }
  async version(): Promise<number> {
    return this.ver;
  }
}
