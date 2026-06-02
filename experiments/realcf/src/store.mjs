// store.mjs — REAL Cloudflare DO-SQLite + R2 snapshot store. Mirrors the kernel's
// snapshot routing rule (see CLAUDE.md / v0 build report) and the bench harness'
// `_bench/store.mjs` semantics, but backed by genuine durable storage:
//
//   - a blob is gzip-compressed by the strategy (it calls putRaw with already-final
//     bytes) OR by putSnapshot (which gzips then routes):
//       * if final size  < 2 MB  -> DO SQLite as chunked ~64KB rows + a manifest row
//       * if final size >= 2 MB  -> "R2 overflow": the blob goes to R2 under
//                                   bench/<doId>/<key>, the SQLite row records the R2 key
//
// Compression uses the platform CompressionStream/DecompressionStream (gzip). Level is
// not configurable there, but the COMBINED strategy gzips its own delta/base blobs via
// `gz()` here so the same routing + byte accounting applies on real CF.
//
// Byte accounting: bytesWritten / sqliteBytes / r2Bytes / bytesRead are tracked so
// /metrics can report SQLite-vs-R2 split + write amplification, exactly like the bench.

export const CHUNK_BYTES = 64 * 1024;                 // 64KB SQLite rows (kernel rule)
export const R2_OVERFLOW_GZ_BYTES = 2 * 1024 * 1024;  // >=2MB -> R2 (kernel rule)

// ---- platform gzip (async) -------------------------------------------------
export async function gz(buf) {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(buf);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
export async function gunzip(buf) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(buf);
  w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export class DOStore {
  /**
   * @param {SqlStorage} sql   ctx.storage.sql
   * @param {R2Bucket}   r2    SNAPSHOTS bucket
   * @param {string}     prefix  R2 key prefix, e.g. "bench/<doId>/"
   */
  constructor(sql, r2, prefix) {
    this.sql = sql;
    this.r2 = r2;
    this.prefix = prefix;
    this.bytesWritten = 0;
    this.bytesRead = 0;
    this.sqliteBytes = 0;
    this.r2Bytes = 0;
    this.putCount = 0;
    this.getCount = 0;
    this.deleteCount = 0;
    this._initSchema();
  }

  _initSchema() {
    // blob manifest: one row per logical key. where='sqlite' -> chunks in blob_chunk;
    // where='r2' -> bytes live in R2 at r2_key.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS blob_manifest (
      key TEXT PRIMARY KEY,
      where_ TEXT NOT NULL,
      r2_key TEXT,
      n_bytes INTEGER NOT NULL,
      n_chunks INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS blob_chunk (
      key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (key, seq)
    )`);
  }

  resetCounters() {
    this.bytesWritten = 0;
    this.bytesRead = 0;
    this.sqliteBytes = 0;
    this.r2Bytes = 0;
    this.putCount = 0;
    this.getCount = 0;
    this.deleteCount = 0;
  }

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

  // ---- snapshot path: caller passes RAW bytes; store gzips + routes ----
  async putSnapshot(key, rawBytes) {
    this.putCount++;
    const compressed = await gz(rawBytes);
    await this.deleteSnapshot(key); // overwrite (delete-then-put)
    return await this._putFinal(key, compressed, compressed.byteLength);
  }

  // ---- raw path: caller passes already-final (e.g. pre-gzipped) bytes ----
  async putRaw(key, finalBytes) {
    this.putCount++;
    await this.deleteSnapshot(key);
    return await this._putFinal(key, finalBytes, finalBytes.byteLength);
  }

  async _putFinal(key, finalBytes, finalLen) {
    if (finalLen >= R2_OVERFLOW_GZ_BYTES) {
      const r2Key = `${this.prefix}${key}`;
      await this.r2.put(r2Key, finalBytes);
      this.r2Bytes += finalLen;
      this.bytesWritten += finalLen;
      this.sql.exec(
        `INSERT OR REPLACE INTO blob_manifest (key, where_, r2_key, n_bytes, n_chunks) VALUES (?, 'r2', ?, ?, 0)`,
        key,
        r2Key,
        finalLen,
      );
      return { where: "r2", bytes: finalLen };
    }
    // chunk into SQLite
    let seq = 0;
    for (let i = 0; i < finalBytes.byteLength; i += CHUNK_BYTES) {
      const c = finalBytes.subarray(i, Math.min(i + CHUNK_BYTES, finalBytes.byteLength));
      this.sql.exec(`INSERT INTO blob_chunk (key, seq, data) VALUES (?, ?, ?)`, key, seq, c);
      seq++;
    }
    if (seq === 0) {
      this.sql.exec(`INSERT INTO blob_chunk (key, seq, data) VALUES (?, 0, ?)`, key, new Uint8Array(0));
      seq = 1;
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO blob_manifest (key, where_, r2_key, n_bytes, n_chunks) VALUES (?, 'sqlite', NULL, ?, ?)`,
      key,
      finalLen,
      seq,
    );
    this.sqliteBytes += finalLen;
    this.bytesWritten += finalLen;
    return { where: "sqlite", bytes: finalLen };
  }

  async _readFinal(key) {
    const rows = [...this.sql.exec(`SELECT where_, r2_key FROM blob_manifest WHERE key = ?`, key)];
    if (rows.length === 0) return null;
    const m = rows[0];
    if (m.where_ === "r2") {
      const obj = await this.r2.get(m.r2_key);
      if (!obj) return null;
      const b = new Uint8Array(await obj.arrayBuffer());
      this.bytesRead += b.byteLength;
      return b;
    }
    const chunks = [];
    for (const r of this.sql.exec(`SELECT data FROM blob_chunk WHERE key = ? ORDER BY seq`, key)) {
      chunks.push(new Uint8Array(r.data));
    }
    const b = concat(chunks);
    this.bytesRead += b.byteLength;
    return b;
  }

  // read RAW (pre-gzipped) blob verbatim
  async getRaw(key) {
    this.getCount++;
    return await this._readFinal(key);
  }

  // read snapshot blob (gunzip the routed bytes)
  async getSnapshot(key) {
    this.getCount++;
    const b = await this._readFinal(key);
    if (!b) return null;
    return await gunzip(b);
  }

  async deleteSnapshot(key) {
    const rows = [...this.sql.exec(`SELECT where_, r2_key FROM blob_manifest WHERE key = ?`, key)];
    if (rows.length === 0) return;
    this.deleteCount++;
    const m = rows[0];
    if (m.where_ === "r2" && m.r2_key) {
      await this.r2.delete(m.r2_key);
    }
    this.sql.exec(`DELETE FROM blob_chunk WHERE key = ?`, key);
    this.sql.exec(`DELETE FROM blob_manifest WHERE key = ?`, key);
  }
}
