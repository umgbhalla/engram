// GAP-4 store: protoA SqliteSim + R2Sim, PLUS a durable per-etag refcount column.
//
// The protoA caveat: rm GC scanned ALL file metas (`sqlite.list('').some(...)`) to
// decide if an R2 object was still referenced -> O(n) in the number of files.
// Here SQLite owns a `refcounts` table: etag -> integer count, committed
// transactionally with the file meta. inc on write, dec on rm, GC at 0. O(1) rm.
// The refcounts map is JSON-persisted alongside files+manifest, so it survives a
// genuine eviction + cold restore exactly like the files table does.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export class SqliteSim {
  constructor(dir) {
    this.path = join(dir, 'sqlite.json');
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    // instrumentation: count how many file-meta rows we touch per rm (the O(n) tell)
    this.scanRows = 0;
    this._load();
  }
  _load() {
    if (existsSync(this.path)) {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      this.files = new Map(Object.entries(raw.files || {}));
      this.refcounts = new Map(Object.entries(raw.refcounts || {})); // etag -> int (DURABLE column)
      this.manifest = raw.manifest || {};
    } else {
      this.files = new Map();
      this.refcounts = new Map();
      this.manifest = {};
    }
  }
  _flush() {
    const obj = {
      files: Object.fromEntries(this.files),
      refcounts: Object.fromEntries(this.refcounts),
      manifest: this.manifest,
    };
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, this.path); // atomic crash-safe commit
  }
  getFileMeta(path) { return this.files.get(path) || null; }
  list(prefix) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort(); }
  setManifest(k, v) { this.manifest[k] = v; this._flush(); }
  getManifest(k) { return this.manifest[k]; }

  // ---- refcount column ops (all O(1) Map ops) ----
  refGet(etag) { return this.refcounts.get(etag) || 0; }

  // Atomic "write" transaction: set file meta + adjust refcounts in one commit.
  // If the path previously pointed at a different etag, that old etag is decremented
  // (overwrite-in-place must not leak a reference). Returns {gcEtag} if an old etag
  // hit zero and should have its R2 object collected.
  writeMeta(path, meta) {
    let gcEtag = null;
    const prev = this.files.get(path);
    // increment new etag's refcount
    this.refcounts.set(meta.etag, this.refGet(meta.etag) + 1);
    // if overwriting a path that held a different etag, decrement the old one
    if (prev && prev.etag && prev.etag !== meta.etag) {
      const n = this.refGet(prev.etag) - 1;
      if (n <= 0) { this.refcounts.delete(prev.etag); gcEtag = prev.etag; }
      else this.refcounts.set(prev.etag, n);
    } else if (prev && prev.etag === meta.etag) {
      // same path rewritten with identical content: net refcount change is 0
      this.refcounts.set(meta.etag, this.refGet(meta.etag) - 1);
    }
    this.files.set(path, meta);
    this._flush();
    return { gcEtag };
  }

  // Atomic "rm" transaction: delete file meta + decrement its etag refcount in one
  // commit. O(1) — NO scan of other rows. Returns {gcEtag} if refcount hit 0.
  rmMeta(path) {
    const m = this.files.get(path);
    if (!m) return { existed: false, gcEtag: null };
    this.files.delete(path);
    let gcEtag = null;
    if (m.etag) {
      const n = this.refGet(m.etag) - 1;
      if (n <= 0) { this.refcounts.delete(m.etag); gcEtag = m.etag; }
      else this.refcounts.set(m.etag, n);
    }
    this._flush();
    return { existed: true, gcEtag, meta: m };
  }
}

export class R2Sim {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); this.puts = 0; this.gets = 0; this.dels = 0; }
  _p(key) { return join(this.dir, key.replace(/\//g, '__')); }
  put(key, buf) { this.puts++; writeFileSync(this._p(key), buf); }
  get(key) { this.gets++; const p = this._p(key); return existsSync(p) ? readFileSync(p) : null; }
  delete(key) { this.dels++; const p = this._p(key); if (existsSync(p)) rmSync(p); }
  has(key) { return existsSync(this._p(key)); }
}

export { sha256 };
