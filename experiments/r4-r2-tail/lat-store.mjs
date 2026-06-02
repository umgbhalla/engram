// lat-store.mjs — a latency-aware snapshot store for the R2-tail experiment.
//
// Builds on the SAME routing rule as experiments/_bench/store.mjs (gz, <2MB-gz =>
// SQLite 64KB rows ~0ms; >=2MB-gz => R2) but ADDS the measured R2 GET latency that
// the bench store charged as 0ms (the "single largest fiction" per REALCF). It also
// supports splitting an image into K R2 objects so we can sim chunked-parallel GET.
//
// READ-ONLY import of _bench is honored: we re-use its gz/gunzip + CHUNK constants by
// re-deriving them here (no mutation, no import side effects), keeping this dir
// self-contained per the task's write-isolation rule.

import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { singleGetMs, parallelGetMs, gunzipMs, MB } from './latency-model.mjs';

export const CHUNK_BYTES = 64 * 1024;
export const R2_OVERFLOW_GZ_BYTES = 2 * MB;

export function gz(buf, level = 6) { return gzipSync(buf, { level }); }
export function gunzip(buf) { return gunzipSync(buf); }

export class LatStore {
  constructor({ r2Dir }) {
    this.r2Dir = r2Dir;
    this.sqlite = new Map();   // key -> { manifest, chunks: Uint8Array[] }  (SQLite sim, ~0ms reads)
    this.resetCounters();
    rmSync(r2Dir, { recursive: true, force: true });
    mkdirSync(r2Dir, { recursive: true });
  }
  resetCounters() {
    this.bytesWritten = 0; this.r2Bytes = 0; this.sqliteBytes = 0;
    this.putCount = 0; this.getCount = 0; this.r2GetCount = 0;
  }
  _r2Path(key) { return join(this.r2Dir, encodeURIComponent(key) + '.bin'); }
  _r2Put(key, bytes) {
    writeFileSync(this._r2Path(key), Buffer.from(bytes));
    this.r2Bytes += bytes.byteLength; this.bytesWritten += bytes.byteLength;
  }
  _r2GetBytes(key) { return new Uint8Array(readFileSync(this._r2Path(key))); }

  // ---------------- WRITE ----------------
  // Store a single gz blob as ONE R2 object (baseline / prefer-sqlite path).
  putSnapshotSingle(key, rawBytes, { level = 6, forceR2 = false } = {}) {
    this.putCount++;
    const compressed = gz(rawBytes, level);
    const toR2 = forceR2 || compressed.byteLength >= R2_OVERFLOW_GZ_BYTES;
    if (toR2) {
      this._r2Put(`snap/${key}/0`, compressed);
      this.sqlite.set(key, { manifest: { where: 'r2', k: 1, gzBytes: compressed.byteLength, rawBytes: rawBytes.byteLength, partSizes: [compressed.byteLength] }, chunks: [] });
    } else {
      const chunks = chunkify(compressed, CHUNK_BYTES);
      let n = 0; for (const c of chunks) n += c.byteLength;
      this.sqliteBytes += n; this.bytesWritten += n;
      this.sqlite.set(key, { manifest: { where: 'sqlite', k: 0, gzBytes: compressed.byteLength, rawBytes: rawBytes.byteLength }, chunks });
    }
    return { where: toR2 ? 'r2' : 'sqlite', gzBytes: compressed.byteLength };
  }

  // Store the gz blob SPLIT into K independent R2 objects (chunked-parallel path).
  // We split the RAW image into K parts, gz each part independently, store each as
  // its own R2 object so each can be GET concurrently. (Independent gz per part is
  // required for streaming/parallel gunzip; costs a small ratio penalty vs one stream.)
  putSnapshotSplit(key, rawBytes, k, { level = 6 } = {}) {
    this.putCount++;
    const partRaw = splitEven(rawBytes, k);
    const partGz = partRaw.map((p) => gz(p, level));
    let totalGz = 0;
    partGz.forEach((g, i) => { this._r2Put(`snap/${key}/${i}`, g); totalGz += g.byteLength; });
    this.sqlite.set(key, {
      manifest: { where: 'r2', k, gzBytes: totalGz, rawBytes: rawBytes.byteLength, partSizes: partGz.map((g) => g.byteLength), partRawSizes: partRaw.map((p) => p.byteLength) },
      chunks: [],
    });
    return { where: 'r2', gzBytes: totalGz, k };
  }

  // Store the gz blob across DO-SQLite 64KB rows EVEN THOUGH it's >2MB-gz (HOT-TIER):
  // accept the SQLite size cost to get ~0ms synchronous reads.
  putSnapshotHotTier(key, rawBytes, { level = 6 } = {}) {
    this.putCount++;
    const compressed = gz(rawBytes, level);
    const chunks = chunkify(compressed, CHUNK_BYTES);
    let n = 0; for (const c of chunks) n += c.byteLength;
    this.sqliteBytes += n; this.bytesWritten += n;
    this.sqlite.set(key, { manifest: { where: 'sqlite-hot', k: 0, gzBytes: compressed.byteLength, rawBytes: rawBytes.byteLength }, chunks });
    return { where: 'sqlite-hot', gzBytes: compressed.byteLength };
  }

  // ---------------- READ (returns raw bytes + a latency report) ----------------
  // regime: 'warm' | 'cold'. streaming: overlap gunzip with network (chunked path).
  getSnapshot(key, { regime = 'cold', streaming = false } = {}) {
    this.getCount++;
    const rec = this.sqlite.get(key);
    if (!rec) return null;
    const m = rec.manifest;

    if (m.where === 'sqlite' || m.where === 'sqlite-hot') {
      // synchronous SQLite read ~0ms in-turn; gunzip CPU off-clock on workerd.
      const compressed = concat(rec.chunks);
      const raw = gunzip(compressed);
      return { raw, latencyMs: 0, readMs: 0, gunzipMs: gunzipMs(raw.byteLength), where: m.where, k: 0 };
    }

    // R2 path
    const k = m.k;
    if (k === 1) {
      const compressed = this._r2GetBytes(`snap/${key}/0`);
      this.r2GetCount++;
      const readMs = singleGetMs(compressed.byteLength, regime);
      const raw = gunzip(compressed);
      // serial: gunzip happens AFTER the read on a real machine (no overlap with one object)
      const gz_ms = gunzipMs(raw.byteLength);
      return { raw, latencyMs: readMs + (streaming ? 0 : gz_ms), readMs, gunzipMs: gz_ms, where: 'r2', k: 1 };
    }

    // split / parallel
    const parts = [];
    let totalGz = 0;
    for (let i = 0; i < k; i++) { const b = this._r2GetBytes(`snap/${key}/${i}`); this.r2GetCount++; parts.push(b); totalGz += b.byteLength; }
    const readMs = parallelGetMs(totalGz, k, regime);
    // gunzip each part; if streaming, it overlaps the network -> ~0 added wall-clock.
    const rawParts = parts.map((p) => gunzip(p));
    const raw = concat(rawParts);
    const gz_ms = gunzipMs(raw.byteLength);
    return { raw, latencyMs: readMs + (streaming ? 0 : gz_ms), readMs, gunzipMs: gz_ms, where: 'r2-split', k };
  }

  stats() {
    return { bytesWritten: this.bytesWritten, r2Bytes: this.r2Bytes, sqliteBytes: this.sqliteBytes, putCount: this.putCount, getCount: this.getCount, r2GetCount: this.r2GetCount };
  }
}

function chunkify(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.byteLength; i += size) out.push(bytes.slice(i, Math.min(i + size, bytes.byteLength)));
  if (out.length === 0) out.push(new Uint8Array(0));
  return out;
}
function splitEven(bytes, k) {
  const out = []; const n = bytes.byteLength; const per = Math.ceil(n / k);
  for (let i = 0; i < n; i += per) out.push(bytes.slice(i, Math.min(i + per, n)));
  while (out.length < k) out.push(new Uint8Array(0));
  return out;
}
function concat(parts) {
  let t = 0; for (const p of parts) t += p.byteLength;
  const o = new Uint8Array(t); let off = 0; for (const p of parts) { o.set(p, off); off += p.byteLength; }
  return o;
}
