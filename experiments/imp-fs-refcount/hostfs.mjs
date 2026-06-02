// host.fs — content-addressed, R2-backed durable virtual filesystem with a proper
// per-etag REFCOUNT column (GAP-4). Closes the protoA caveat: rm no longer scans
// all file metas O(n) to decide GC; SQLite owns refcount(etag) and rm is O(1).
//
// Content addressing: file identity is etag = sha256(content). R2 key = `${sid}/${etag}`.
// N paths with identical content share ONE R2 object and one refcount. Write inc's
// the etag's refcount; rm dec's it; the R2 object is collected ONLY when refcount==0.
//
// Write ordering preserved: R2 put happens BEFORE the meta+refcount commit, so the
// heap never references an un-durable object. Overwrite-in-place correctly releases
// the old etag's reference in the same transaction.

import { sha256 } from './store.mjs';

const INLINE_MAX = 4096;

export function makeHostFs(sqlite, r2, sessionId) {
  const stats = { writes: 0, reads: 0, r2puts: 0, r2gets: 0, r2dels: 0,
    inlineWrites: 0, overflowWrites: 0, tornReads: 0, dedupHits: 0, gcFired: 0 };

  function writeFile(path, data) {
    const buf = Buffer.from(String(data), 'utf8');
    const etag = sha256(buf);
    const size = buf.length;
    stats.writes++;
    let meta;
    if (size <= INLINE_MAX) {
      stats.inlineWrites++;
      meta = { size, etag, storage: 'inline', inline: buf.toString('base64'), r2key: null };
    } else {
      stats.overflowWrites++;
      const r2key = `${sessionId}/${etag}`;
      // content-addressed dedup: only put if the object isn't already durable
      if (!r2.has(r2key)) { r2.put(r2key, buf); stats.r2puts++; }
      else stats.dedupHits++;
      meta = { size, etag, storage: 'r2', inline: null, r2key };
    }
    // ---- single atomic commit: meta row + refcount inc (+ release old etag) ----
    const { gcEtag } = sqlite.writeMeta(path, meta);
    // an overwrite that orphaned a prior R2-backed etag -> collect it now
    if (gcEtag) gcCollect(gcEtag);
    return { etag, size };
  }

  function readFile(path) {
    stats.reads++;
    const m = sqlite.getFileMeta(path);
    if (!m) return null;
    if (m.storage === 'inline') {
      const buf = Buffer.from(m.inline, 'base64');
      if (sha256(buf) !== m.etag) { stats.tornReads++; return { __torn: true, path }; }
      return buf.toString('utf8');
    }
    const buf = r2.get(m.r2key); stats.r2gets++;
    if (!buf) { stats.tornReads++; return { __torn: true, path, reason: 'r2-missing' }; }
    if (sha256(buf) !== m.etag) { stats.tornReads++; return { __torn: true, path, reason: 'etag-mismatch' }; }
    return buf.toString('utf8');
  }

  function list(prefix) { return sqlite.list(prefix || ''); }
  function stat(path) {
    const m = sqlite.getFileMeta(path);
    if (!m) return null;
    return { path, size: m.size, etag: m.etag, storage: m.storage, refcount: sqlite.refGet(m.etag) };
  }

  // O(1) rm: delete meta + decrement refcount in one commit. R2 GC only at zero.
  function rm(path) {
    const { existed, gcEtag, meta } = sqlite.rmMeta(path);
    if (!existed) return false;
    if (gcEtag && meta && meta.storage === 'r2') gcCollect(meta.r2key);
    return true;
  }

  // collect either an r2key string (from rm) or an etag (from overwrite-release)
  function gcCollect(keyOrEtag) {
    const r2key = keyOrEtag.includes('/') ? keyOrEtag : `${sessionId}/${keyOrEtag}`;
    if (r2.has(r2key)) { r2.delete(r2key); stats.r2dels++; stats.gcFired++; }
  }

  return { writeFile, readFile, list, stat, rm, stats, INLINE_MAX, refGet: (e) => sqlite.refGet(e) };
}
