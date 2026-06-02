// Faithful simulation of the Engram DO storage model.
//   SQLite  = DO-SQLite (better-sqlite3 unavailable -> JS Map with chunked rows,
//             same row/blob semantics). Used for small files + ALL metadata.
//   R2      = a filesystem directory with put/get/delete semantics (the real
//             DO R2 binding). Used for large-file overflow.
//   alarms  = a callback you invoke to model a wake.
//
// Persistence boundary: SQLite + R2 survive eviction; in-memory JS state does NOT.
// We model that by separating the durable backing (disk dir + a JSON-persisted
// "sqlite file") from any in-memory scheduler/handle.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ----- DO SQLite (durable, JSON-backed to model on-disk persistence) ----------
export class SqliteSim {
  constructor(dir) {
    this.path = join(dir, 'sqlite.json');
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this._load();
  }
  _load() {
    if (existsSync(this.path)) {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      // files: path -> {size, etag, inline (base64|null), r2key|null, chunks}
      this.files = new Map(Object.entries(raw.files || {}));
      this.manifest = raw.manifest || {};
    } else {
      this.files = new Map();
      this.manifest = {}; // kv_json + heap snapshot manifest live here
    }
  }
  _flush() {
    // workerd coalesces writes; we model a single atomic durable commit.
    const obj = { files: Object.fromEntries(this.files), manifest: this.manifest };
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj));
    // atomic rename = crash-atomic commit
    renameSync(tmp, this.path);
  }
  putFileMeta(path, meta) { this.files.set(path, meta); this._flush(); }
  getFileMeta(path) { return this.files.get(path) || null; }
  delFileMeta(path) { this.files.delete(path); this._flush(); }
  list(prefix) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  setManifest(k, v) { this.manifest[k] = v; this._flush(); }
  getManifest(k) { return this.manifest[k]; }
}

// ----- DO R2 binding (durable, filesystem-backed) -----------------------------
export class R2Sim {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); this.puts = 0; this.gets = 0; this.dels = 0; }
  _p(key) { return join(this.dir, key.replace(/\//g, '__')); }
  put(key, buf) { this.puts++; writeFileSync(this._p(key), buf); }
  get(key) { this.gets++; const p = this._p(key); return existsSync(p) ? readFileSync(p) : null; }
  delete(key) { this.dels++; const p = this._p(key); if (existsSync(p)) rmSync(p); }
  has(key) { return existsSync(this._p(key)); }
}

export { sha256 };
