// host.fs — R2-backed durable virtual filesystem.
//
// API (exposed into the VM as host.fs.*):
//   writeFile(path, data)  -> {etag,size}
//   readFile(path)         -> string|null
//   list(prefix)           -> string[]
//   stat(path)             -> {path,size,etag,storage}|null
//   rm(path)               -> bool
//
// Storage mapping:
//   metadata               -> always DO-SQLite (files table row)
//   small files (<=INLINE) -> inline blob in the SQLite row
//   large files (>INLINE)  -> R2 object, key = sessionId/<path>, body = content
//
// CONTENT-ADDRESSED write-ordering rule (the coherence guarantee):
//   A file's identity is its etag = sha256(content). For large files the R2 key
//   embeds the etag: `${sessionId}/${etag}`. The SQLite metadata row (with that
//   etag + r2key) is committed ONLY AFTER the R2 put returns. Therefore:
//     - A metadata row NEVER references an R2 object that isn't durably present
//       (put-before-commit ordering).
//     - A missing R2 object is *detectable* (readFile verifies, returns torn=true).
//     - Re-writing identical content is idempotent (same etag -> same key).
//   This makes writeFile atomic from the heap's POV: the heap only ever learns of
//   a path after both R2 body AND SQLite meta are durable.

import { sha256 } from './store.mjs';

const INLINE_MAX = 4096; // bytes; <= this stays inline in SQLite, else R2 overflow

export function makeHostFs(sqlite, r2, sessionId) {
  const stats = { writes: 0, reads: 0, r2puts: 0, r2gets: 0, inlineWrites: 0, overflowWrites: 0, tornReads: 0 };

  function writeFile(path, data) {
    const buf = Buffer.from(String(data), 'utf8');
    const etag = sha256(buf);
    const size = buf.length;
    stats.writes++;
    if (size <= INLINE_MAX) {
      // small: body lives inline in SQLite. Single durable commit.
      stats.inlineWrites++;
      sqlite.putFileMeta(path, { size, etag, storage: 'inline', inline: buf.toString('base64'), r2key: null });
    } else {
      // large: PUT R2 first (content-addressed), THEN commit metadata.
      stats.overflowWrites++;
      const r2key = `${sessionId}/${etag}`;
      if (!r2.has(r2key)) { r2.put(r2key, buf); stats.r2puts++; }
      // ---- write-ordering rule: meta commit happens strictly after R2 put ----
      sqlite.putFileMeta(path, { size, etag, storage: 'r2', inline: null, r2key });
    }
    return { etag, size };
  }

  function readFile(path) {
    stats.reads++;
    const m = sqlite.getFileMeta(path);
    if (!m) return null;
    if (m.storage === 'inline') {
      const buf = Buffer.from(m.inline, 'base64');
      // integrity check even for inline
      if (sha256(buf) !== m.etag) { stats.tornReads++; return { __torn: true, path }; }
      return buf.toString('utf8');
    }
    // r2: verify object present + content matches etag (detect torn write)
    const buf = r2.get(m.r2key); stats.r2gets++;
    if (!buf) { stats.tornReads++; return { __torn: true, path, reason: 'r2-missing' }; }
    if (sha256(buf) !== m.etag) { stats.tornReads++; return { __torn: true, path, reason: 'etag-mismatch' }; }
    return buf.toString('utf8');
  }

  function list(prefix) { return sqlite.list(prefix || ''); }
  function stat(path) {
    const m = sqlite.getFileMeta(path);
    if (!m) return null;
    return { path, size: m.size, etag: m.etag, storage: m.storage };
  }
  function rm(path) {
    const m = sqlite.getFileMeta(path);
    if (!m) return false;
    sqlite.delFileMeta(path);
    // GC R2 only if no other path references the same etag (content-addressed)
    if (m.storage === 'r2') {
      const stillRef = sqlite.list('').some((p) => { const mm = sqlite.getFileMeta(p); return mm && mm.r2key === m.r2key; });
      if (!stillRef) r2.delete(m.r2key);
    }
    return true;
  }

  return { writeFile, readFile, list, stat, rm, stats, INLINE_MAX };
}
