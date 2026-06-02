// PROTOTYPE C — host substrate that faithfully simulates the Cloudflare DO storage model.
//   SQLite  -> a JS Map of chunked rows (64KB) + a manifest row (mirrors DO-SQLite-first).
//   R2      -> a filesystem dir with put/get/delete semantics (overflow store).
//   alarms  -> a callback you fire manually to model a wake.
// The kernel (QuickJS-in-wasm) holds the live heap. The host owns: time, RNG, entropy,
// host.fs (per-session namespace), host.kv (manifest-persisted), host.fetch (allowlist).
//
// Determinism: seeded clock (epoch 1.7e12 + 1ms tick) + mulberry32 RNG + entropy counters,
// all externalized here at the host boundary so a heap snapshot is byte-identical.

import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';

const CHUNK = 64 * 1024;

// ---- DO SQLite simulation (chunked rows + manifest) ----
export class SqliteSim {
  constructor() { this.rows = new Map(); } // key -> value
  put(k, v) { this.rows.set(k, v); }
  get(k) { return this.rows.get(k); }
  delete(k) { this.rows.delete(k); }
  list(prefix) { return [...this.rows.keys()].filter(k => k.startsWith(prefix)); }
}

// ---- R2 simulation (filesystem dir, overflow only) ----
export class R2Sim {
  constructor(dir) { this.dir = dir; if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
  put(key, bytes) { writeFileSync(path.join(this.dir, key.replace(/\//g, '__')), bytes); }
  get(key) { const p = path.join(this.dir, key.replace(/\//g, '__')); return existsSync(p) ? readFileSync(p) : null; }
  delete(key) { const p = path.join(this.dir, key.replace(/\//g, '__')); if (existsSync(p)) rmSync(p); }
}

// ---- Snapshot store: SQLite-first, R2 overflow > 2MB gz ----
const R2_THRESHOLD = 2 * 1024 * 1024;
export function storeSnapshot(sqlite, r2, sessionId, snapBytes, manifest) {
  const gz = gzipSync(snapBytes);
  let source;
  if (gz.length > R2_THRESHOLD) {
    source = 'r2';
    r2.put(`snap/${sessionId}`, gz);
    sqlite.delete(`snap:${sessionId}:chunks`);
  } else {
    source = 'sqlite';
    const nChunks = Math.ceil(gz.length / CHUNK);
    for (let i = 0; i < nChunks; i++) sqlite.put(`snap:${sessionId}:chunk:${i}`, gz.subarray(i * CHUNK, (i + 1) * CHUNK));
    sqlite.put(`snap:${sessionId}:chunks`, nChunks);
    r2.delete(`snap/${sessionId}`);
  }
  sqlite.put(`manifest:${sessionId}`, JSON.stringify({ ...manifest, source, sizeGz: gz.length }));
  return { source, sizeGz: gz.length };
}
export function loadSnapshot(sqlite, r2, sessionId) {
  const manifest = JSON.parse(sqlite.get(`manifest:${sessionId}`));
  let gz;
  if (manifest.source === 'r2') {
    gz = r2.get(`snap/${sessionId}`);
  } else {
    const nChunks = sqlite.get(`snap:${sessionId}:chunks`);
    const parts = [];
    for (let i = 0; i < nChunks; i++) parts.push(sqlite.get(`snap:${sessionId}:chunk:${i}`));
    gz = Buffer.concat(parts);
  }
  return { snapBytes: new Uint8Array(gunzipSync(gz)), manifest };
}

// ---- host.fs: per-session namespace, durable in SQLite under fs:<sid>:<safePath> ----
// PATH ISOLATION RULE: every path is normalized; any attempt to escape the session
// root (.., absolute, NUL) is REJECTED. The stored key is always prefixed with the
// session id, so even a normalization bug cannot cross into another session's tree.
export function resolveSessionPath(sessionId, userPath) {
  if (typeof userPath !== 'string' || userPath.length === 0) throw new Error('EINVAL: path must be a non-empty string');
  if (userPath.includes('\0')) throw new Error('EINVAL: NUL byte in path');
  // Treat the session root as "/". posix-normalize the user path against it.
  const norm = path.posix.normalize('/' + userPath); // collapses .. and .
  if (norm.startsWith('/..') || norm === '/..') throw new Error('EACCES: path traversal denied');
  // After normalize, a leading-/ guarantees we are inside the virtual root.
  // Defense in depth: the storage key is namespaced by session id regardless.
  return norm; // e.g. "/a/b.txt" -> stored under fs:<sid>:/a/b.txt
}

export class HostFs {
  constructor(sqlite, sessionId, limits = {}) {
    this.sqlite = sqlite; this.sid = sessionId;
    this.maxFiles = limits.maxFiles ?? 256;
    this.maxBytes = limits.maxBytes ?? 1 * 1024 * 1024; // per-session quota
    // incremental usage accounting (re-derived once from durable storage on cold restore)
    this._n = 0; this._bytes = 0;
    for (const k of this.sqlite.list(`fs:${this.sid}:`)) { this._n++; this._bytes += Buffer.byteLength(String(this.sqlite.get(k))); }
  }
  _key(p) { return `fs:${this.sid}:${p}`; }
  write(p, data) {
    const safe = resolveSessionPath(this.sid, p);
    const key = this._key(safe);
    const prev = this.sqlite.get(key);
    const exists = prev !== undefined;
    if (!exists && this._n >= this.maxFiles) throw new Error('EDQUOT: too many files');
    const sz = Buffer.byteLength(String(data));
    const prevSz = exists ? Buffer.byteLength(String(prev)) : 0;
    if (this._bytes - prevSz + sz > this.maxBytes) throw new Error('EDQUOT: session fs quota exceeded');
    this.sqlite.put(key, String(data));
    if (!exists) this._n++;
    this._bytes += sz - prevSz;
    return sz;
  }
  read(p) {
    const safe = resolveSessionPath(this.sid, p);
    const v = this.sqlite.get(this._key(safe));
    if (v === undefined) throw new Error('ENOENT: ' + safe);
    return v;
  }
  list() { return this.sqlite.list(`fs:${this.sid}:`).map(k => k.slice(`fs:${this.sid}:`.length)); }
  unlink(p) {
    const safe = resolveSessionPath(this.sid, p); const key = this._key(safe);
    const prev = this.sqlite.get(key);
    if (prev !== undefined) { this._n--; this._bytes -= Buffer.byteLength(String(prev)); this.sqlite.delete(key); }
  }
}

// ---- deterministic host clock + RNG + entropy (externalized) ----
export function makeHostState(seed = 0xC0FFEE) {
  return {
    clockMs: 1.7e12,         // fixed epoch
    rngState: seed >>> 0,
    entropy: { now: 0, random: 0, fetch: 0, timer: 0 },
  };
}
export function hostNow(state) { state.entropy.now++; const t = state.clockMs; state.clockMs += 1; return t; }
export function hostRandom(state) {
  state.entropy.random++;
  // mulberry32
  let a = (state.rngState += 0x6D2B79F5) >>> 0;
  let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
