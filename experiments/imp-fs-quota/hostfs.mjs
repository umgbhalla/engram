// hostfs.mjs — host.fs durable virtual filesystem WITH a per-session byte quota.
//
// GAP 3: "no quota — a session could fill SQLite/R2 unbounded."
//
// QUOTA MODEL
//   - One per-session cap `quotaBytes` (default 10MB here).
//   - `usedBytes` = sum of the on-storage CONTENT size of every live file, counted
//     IDENTICALLY whether the body lives inline-in-SQLite or in R2. This is the
//     "across BOTH inline-SQLite and R2 bytes" requirement: one unified counter.
//   - writeFile(path,data):
//       newUsed = usedBytes - oldSizeOfThisPath + newSize
//       if newUsed > quotaBytes  -> throw QuotaError (does NOT mutate storage)
//       else commit body+meta, set usedBytes = newUsed
//   - rm(path): usedBytes -= size of that path (frees quota).
//   - The counter is O(1) incremental (no O(n) re-scan), and PERSISTED in the
//     SQLite manifest (`fs_quota_json`) so it survives cold restore — re-hydrated,
//     NOT reset to 0.
//
//   Overwrite semantics: writing the same path replaces; quota delta = new-old.
//   Content-addressed dedup affects R2 PUT (skip identical body) but NOT the quota
//   accounting — each live PATH counts its bytes (a session's logical footprint),
//   which is the conservative/safe choice for a per-session cap.
//
// QuotaError is surfaced to the VM as a thrown JS Error (name 'QuotaError'); the
// host call returns {__err:{name,message}} and the in-heap shim re-throws it, so
// guest code can `try/catch` it and the socket/VM stays alive.

import { sha256 } from './store.mjs';

const INLINE_MAX = 4096;          // <= inline in SQLite, else R2 overflow
const QUOTA_MANIFEST_KEY = 'fs_quota_json';

export function makeHostFs(sqlite, r2, sessionId, { quotaBytes = 10 * 1024 * 1024 } = {}) {
  // ---- re-hydrate the quota counter from the manifest (survives cold restore) ----
  let usedBytes;
  const persisted = sqlite.getManifest(QUOTA_MANIFEST_KEY);
  if (persisted && typeof persisted.usedBytes === 'number') {
    usedBytes = persisted.usedBytes;
    // honor the persisted cap if present (config persistence), else use the arg
    if (typeof persisted.quotaBytes === 'number') quotaBytes = persisted.quotaBytes;
  } else {
    usedBytes = 0;
  }

  const stats = { writes: 0, reads: 0, rms: 0, quotaRejects: 0, r2puts: 0, rehydratedUsed: usedBytes };

  function persistQuota() {
    sqlite.setManifest(QUOTA_MANIFEST_KEY, { usedBytes, quotaBytes });
  }
  // ensure manifest has a row from creation onward
  if (!persisted) persistQuota();

  function writeFile(path, data) {
    const buf = Buffer.from(String(data), 'utf8');
    const size = buf.length;
    const etag = sha256(buf);
    const prev = sqlite.getFileMeta(path);
    const oldSize = prev ? prev.size : 0;
    const newUsed = usedBytes - oldSize + size;

    if (newUsed > quotaBytes) {
      stats.quotaRejects++;
      // typed, VM-catchable; storage NOT mutated, counter unchanged.
      return {
        __err: {
          name: 'QuotaError',
          message: `quota exceeded: would use ${newUsed} > cap ${quotaBytes} (path ${path}, +${size}B, current ${usedBytes}B)`,
          used: usedBytes, cap: quotaBytes, requested: size,
        },
      };
    }

    stats.writes++;
    if (size <= INLINE_MAX) {
      sqlite.putFileMeta(path, { size, etag, storage: 'inline', inline: buf.toString('base64'), r2key: null });
    } else {
      const r2key = `${sessionId}/${etag}`;
      if (!r2.has(r2key)) { r2.put(r2key, buf); stats.r2puts++; } // content-addressed PUT
      sqlite.putFileMeta(path, { size, etag, storage: 'r2', inline: null, r2key });
    }
    usedBytes = newUsed;
    persistQuota(); // commit counter alongside the file meta
    return { etag, size, used: usedBytes, cap: quotaBytes };
  }

  function readFile(path) {
    stats.reads++;
    const m = sqlite.getFileMeta(path);
    if (!m) return null;
    if (m.storage === 'inline') {
      const b = Buffer.from(m.inline, 'base64');
      if (sha256(b) !== m.etag) return { __torn: true, path };
      return b.toString('utf8');
    }
    const b = r2.get(m.r2key);
    if (!b) return { __torn: true, path, reason: 'r2-missing' };
    if (sha256(b) !== m.etag) return { __torn: true, path, reason: 'etag-mismatch' };
    return b.toString('utf8');
  }

  function list(prefix) { return sqlite.list(prefix || ''); }
  function stat(path) {
    const m = sqlite.getFileMeta(path);
    return m ? { path, size: m.size, etag: m.etag, storage: m.storage } : null;
  }
  function usage() { return { used: usedBytes, cap: quotaBytes, free: quotaBytes - usedBytes }; }

  function rm(path) {
    const m = sqlite.getFileMeta(path);
    if (!m) return false;
    stats.rms++;
    sqlite.delFileMeta(path);
    usedBytes -= m.size; // free quota
    if (usedBytes < 0) usedBytes = 0;
    // GC R2 body if no other path references the same etag (content-addressed)
    if (m.storage === 'r2') {
      const stillRef = sqlite.list('').some((p) => { const mm = sqlite.getFileMeta(p); return mm && mm.r2key === m.r2key; });
      if (!stillRef) r2.delete(m.r2key);
    }
    persistQuota();
    return true;
  }

  return { writeFile, readFile, list, stat, rm, usage, stats, INLINE_MAX, QUOTA_MANIFEST_KEY,
    _used: () => usedBytes, _cap: () => quotaBytes };
}
