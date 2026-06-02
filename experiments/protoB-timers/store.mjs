// Faithful sim of the Engram DO storage model.
//  - SQLite  = chunked rows in a JS Map (key -> Uint8Array), like DO SQLite chunk table.
//  - R2      = a filesystem dir with put/get/delete (overflow only).
//  - manifest= a small JSON row (timers registry + kv + clock live here).
// The point of the sim: state must survive dropping ALL in-memory objects.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHUNK = 64 * 1024; // 64KB rows, like the kernel

export class SqliteSim {
  // rows: Map<string, Uint8Array>  — survives "eviction" because it is the durable medium.
  constructor() { this.rows = new Map(); }
  // chunked blob store keyed by logical name
  putBlob(name, bytes) {
    // clear old chunks
    for (const k of [...this.rows.keys()]) if (k.startsWith(name + '#')) this.rows.delete(k);
    const n = Math.ceil(bytes.length / CHUNK) || 1;
    for (let i = 0; i < n; i++) this.rows.set(`${name}#${i}`, bytes.slice(i * CHUNK, (i + 1) * CHUNK));
    this.rows.set(`${name}#count`, new TextEncoder().encode(String(n)));
  }
  getBlob(name) {
    const cnt = this.rows.get(`${name}#count`);
    if (!cnt) return null;
    const n = Number(new TextDecoder().decode(cnt));
    const parts = [];
    for (let i = 0; i < n; i++) {
      const c = this.rows.get(`${name}#${i}`);
      if (!c) throw new Error(`missing chunk ${name}#${i}`); // chunk-count guard
      parts.push(c);
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  putManifest(name, obj) { this.rows.set(`manifest:${name}`, new TextEncoder().encode(JSON.stringify(obj))); }
  getManifest(name) { const r = this.rows.get(`manifest:${name}`); return r ? JSON.parse(new TextDecoder().decode(r)) : null; }
  sizeBytes() { let s = 0; for (const v of this.rows.values()) s += v.length; return s; }
}

export class R2Sim {
  constructor(dir) { this.dir = dir; mkdirSync(dir, { recursive: true }); }
  put(key, bytes) { writeFileSync(join(this.dir, key), Buffer.from(bytes)); }
  get(key) { const p = join(this.dir, key); return existsSync(p) ? new Uint8Array(readFileSync(p)) : null; }
  delete(key) { const p = join(this.dir, key); if (existsSync(p)) rmSync(p); }
}
