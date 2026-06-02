// store.mjs — DO-storage simulation (SQLite + R2), reimplemented locally for the
// quota experiment. SQLite = JSON-backed Map (durable across evict via on-disk file).
// R2 = filesystem dir. The manifest row carries kernel-side state that must survive
// cold restore: heap snapshot pointer, kv_json, AND the per-session quota counter.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export class SqliteSim {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, 'sqlite.json');
    mkdirSync(dir, { recursive: true });
    this._load();
  }
  _load() {
    if (existsSync(this.path)) {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      this.files = new Map(Object.entries(raw.files || {}));
      this.manifest = raw.manifest || {};
    } else {
      this.files = new Map();
      this.manifest = {};
    }
  }
  _flush() {
    const obj = { files: Object.fromEntries(this.files), manifest: this.manifest };
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, this.path); // crash-atomic commit
  }
  putFileMeta(path, meta) { this.files.set(path, meta); this._flush(); }
  getFileMeta(path) { return this.files.get(path) || null; }
  delFileMeta(path) { this.files.delete(path); this._flush(); }
  list(prefix) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort(); }
  setManifest(k, v) { this.manifest[k] = v; this._flush(); }
  getManifest(k) { return this.manifest[k]; }
}

export class R2Sim {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); this.puts = 0; this.gets = 0; this.dels = 0; }
  _p(key) { return join(this.dir, key.replace(/\//g, '__')); }
  put(key, buf) { this.puts++; writeFileSync(this._p(key), buf); }
  get(key) { this.gets++; const p = this._p(key); return existsSync(p) ? readFileSync(p) : null; }
  delete(key) { this.dels++; const p = this._p(key); if (existsSync(p)) rmSync(p); }
  has(key) { return existsSync(this._p(key)); }
}
