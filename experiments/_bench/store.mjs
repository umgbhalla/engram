// store.mjs — faithful Cloudflare DO-storage simulation for the benchmark harness.
//
// Mirrors the kernel's snapshot store rule (see CLAUDE.md / v0 build report):
//   - a snapshot is gzip-compressed, then:
//       * if gz size  < 2 MB  -> stored in DO SQLite as chunked ~64KB rows + a manifest row
//       * if gz size >= 2 MB  -> "R2 overflow": the gz blob goes to R2 (a filesystem dir),
//                                the SQLite manifest just records the R2 key.
//
// SQLite is simulated with a JS Map of chunk rows + a manifest row (no native dep needed,
// keeps the harness install-free and 100% deterministic). R2 is a real filesystem dir so
// bytes-on-disk are honest.
//
// Every byte that crosses INTO durable storage is counted in `bytesWritten` so strategies
// can be compared on write-amplification. Reads are counted separately (informational).

import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CHUNK_BYTES = 64 * 1024;          // 64KB SQLite rows, matches kernel
export const R2_OVERFLOW_GZ_BYTES = 2 * 1024 * 1024; // >=2MB gz -> R2 (kernel rule)

/**
 * gzip helpers exposed so strategies/runner measure the SAME compressed size the
 * store would persist. Level 6 (zlib default) matches what the kernel uses.
 */
export function gz(buf) {
  return gzipSync(buf, { level: 6 });
}
export function gunzip(buf) {
  return gunzipSync(buf);
}

export class DOStore {
  /**
   * @param {object} opts
   * @param {string} opts.r2Dir  filesystem dir backing the simulated R2 bucket
   */
  constructor({ r2Dir }) {
    this.r2Dir = r2Dir;
    // SQLite simulation: Map<key, { manifest, chunks: Uint8Array[] }>
    this.sqlite = new Map();
    // counters
    this.bytesWritten = 0;   // bytes persisted into durable storage (SQLite rows + R2 objects)
    this.bytesRead = 0;      // bytes read back out (informational)
    this.sqliteBytes = 0;    // subset of bytesWritten that landed in SQLite
    this.r2Bytes = 0;        // subset that landed in R2
    this.putCount = 0;
    this.getCount = 0;
    this.deleteCount = 0;

    rmSync(this.r2Dir, { recursive: true, force: true });
    mkdirSync(this.r2Dir, { recursive: true });
  }

  _r2Path(key) {
    return join(this.r2Dir, encodeURIComponent(key) + '.bin');
  }

  // ---- R2 primitives (filesystem-backed) ----
  _r2Put(key, bytes) {
    writeFileSync(this._r2Path(key), Buffer.from(bytes));
    this.r2Bytes += bytes.byteLength;
    this.bytesWritten += bytes.byteLength;
  }
  _r2Get(key) {
    const b = readFileSync(this._r2Path(key));
    this.bytesRead += b.byteLength;
    return new Uint8Array(b);
  }
  _r2Delete(key) {
    const p = this._r2Path(key);
    if (existsSync(p)) rmSync(p);
  }

  /**
   * Persist a logical blob under `key` applying the kernel routing rule.
   * The caller passes the RAW (uncompressed) bytes for the slot; the store
   * gzips and routes. This is what a full-dump strategy uses.
   *
   * Strategies that want fine control (e.g. delta page rows) should instead use
   * putRaw / putChunks / putR2 directly — see README.
   *
   * @param {string} key
   * @param {Uint8Array} rawBytes
   * @returns {{ bytes:number, where:'sqlite'|'r2', gzBytes:number }}
   */
  putSnapshot(key, rawBytes) {
    this.putCount++;
    const compressed = gz(rawBytes);
    this.deleteSnapshot(key); // overwrite semantics, crash-atomic-ish (delete then put)
    if (compressed.byteLength >= R2_OVERFLOW_GZ_BYTES) {
      const r2Key = `snap/${key}`;
      this._r2Put(r2Key, compressed);
      this.sqlite.set(key, {
        manifest: { where: 'r2', r2Key, gzBytes: compressed.byteLength, rawBytes: rawBytes.byteLength, nChunks: 0 },
        chunks: [],
      });
      // manifest row itself is tiny; count its JSON length for honesty
      const manifestBytes = jsonBytes(this.sqlite.get(key).manifest);
      this.sqliteBytes += manifestBytes;
      this.bytesWritten += manifestBytes;
      return { bytes: compressed.byteLength + manifestBytes, where: 'r2', gzBytes: compressed.byteLength };
    } else {
      const chunks = chunkify(compressed, CHUNK_BYTES);
      const manifest = { where: 'sqlite', r2Key: null, gzBytes: compressed.byteLength, rawBytes: rawBytes.byteLength, nChunks: chunks.length };
      this.sqlite.set(key, { manifest, chunks });
      let n = jsonBytes(manifest);
      for (const c of chunks) n += c.byteLength;
      this.sqliteBytes += n;
      this.bytesWritten += n;
      return { bytes: n, where: 'sqlite', gzBytes: compressed.byteLength };
    }
  }

  /**
   * Read a logical blob back, returning RAW (gunzipped) bytes — inverse of putSnapshot.
   * @param {string} key
   * @returns {Uint8Array|null}
   */
  getSnapshot(key) {
    this.getCount++;
    const rec = this.sqlite.get(key);
    if (!rec) return null;
    let compressed;
    if (rec.manifest.where === 'r2') {
      compressed = this._r2Get(rec.manifest.r2Key);
    } else {
      compressed = concat(rec.chunks);
      this.bytesRead += compressed.byteLength;
    }
    return gunzip(compressed);
  }

  deleteSnapshot(key) {
    const rec = this.sqlite.get(key);
    if (!rec) return;
    this.deleteCount++;
    if (rec.manifest.where === 'r2') this._r2Delete(rec.manifest.r2Key);
    this.sqlite.delete(key);
  }

  // ---- low-level primitives for delta / custom strategies ----
  /** Store an already-final (e.g. already-compressed) blob, routing by size. */
  putRaw(key, finalBytes, { forceR2 = false } = {}) {
    this.putCount++;
    if (forceR2 || finalBytes.byteLength >= R2_OVERFLOW_GZ_BYTES) {
      const r2Key = `raw/${key}`;
      this._r2Put(r2Key, finalBytes);
      this.sqlite.set(key, { manifest: { where: 'r2', r2Key, gzBytes: finalBytes.byteLength, rawBytes: finalBytes.byteLength, nChunks: 0 }, chunks: [] });
      return { where: 'r2', bytes: finalBytes.byteLength };
    }
    const chunks = chunkify(finalBytes, CHUNK_BYTES);
    let n = 0;
    for (const c of chunks) n += c.byteLength;
    this.sqlite.set(key, { manifest: { where: 'sqlite', r2Key: null, gzBytes: finalBytes.byteLength, rawBytes: finalBytes.byteLength, nChunks: chunks.length }, chunks });
    this.sqliteBytes += n; this.bytesWritten += n;
    return { where: 'sqlite', bytes: n };
  }
  /** Read back a putRaw blob verbatim (no gunzip). */
  getRaw(key) {
    this.getCount++;
    const rec = this.sqlite.get(key);
    if (!rec) return null;
    if (rec.manifest.where === 'r2') return this._r2Get(rec.manifest.r2Key);
    const b = concat(rec.chunks); this.bytesRead += b.byteLength; return b;
  }

  /** Counters snapshot. */
  stats() {
    return {
      bytesWritten: this.bytesWritten,
      bytesRead: this.bytesRead,
      sqliteBytes: this.sqliteBytes,
      r2Bytes: this.r2Bytes,
      putCount: this.putCount,
      getCount: this.getCount,
      deleteCount: this.deleteCount,
    };
  }
  resetCounters() {
    this.bytesWritten = 0; this.bytesRead = 0; this.sqliteBytes = 0; this.r2Bytes = 0;
    this.putCount = 0; this.getCount = 0; this.deleteCount = 0;
  }
}

function chunkify(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.byteLength; i += size) {
    out.push(bytes.slice(i, Math.min(i + size, bytes.byteLength)));
  }
  if (out.length === 0) out.push(new Uint8Array(0));
  return out;
}
function concat(chunks) {
  let total = 0; for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
function jsonBytes(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}
