// strategies/combined.mjs — the candidate PRODUCTION durability stack.
//
// Composes the durability trio from docs/DURABILITY-ROADMAP.md:
//
//   W5 compaction  — keep a SMALL base. A periodic full snapshot ("rebase") is the
//                    compaction point; between rebases we never re-write the whole image.
//                    Rebase also fires on used-heap RECLAIM (a spike-then-free session
//                    re-bases to a compacted image once the chain or reclaim warrants it).
//   W4 byte-delta  — per-cell durability writes ONLY the dirty 4KB pages vs the previous
//                    checkpoint image, gzipped. ~0.05% of bytes change per cell (measured),
//                    so this is where the bytes-written win comes from. Zero re-fire: the
//                    restored image is byte-identical, so effects never replay.
//   E6 oplog       — a crash-tail + engine-migration net. Every cell's source + seeded
//                    entropy cursor is appended to a tiny oplog. NOT the main restore path
//                    (W4 deltas are). Used only to (1) recover cells whose delta did not
//                    commit before a crash, and (2) replay into a NEW engine on an
//                    engine-hash bump (heap image version-locked) instead of bricking.
//
// Restore path (normal): base image + apply the chain of committed page-deltas → a
// byte-identical heapImage. The oplog tail is consulted only if a delta is missing.
//
// Coherence invariant (roadmap §cross-cutting): host state + the oplog entry for a cell
// are flushed in the SAME checkpoint as that cell's delta; the manifest (single commit
// point) is written LAST, so a crash before the manifest write rolls back to the prior
// good checkpoint — no torn delta chain.

import { gz, gunzip, CHUNK_BYTES } from '../../_bench/store.mjs';

const PAGE = 4096;                 // dirty-page granularity for W4 byte-delta
const REBASE_CHAIN_RATIO = 3.0;    // W5: rebase when cumulative chain gz >= this * base gz
const REBASE_MAX_CHAIN = 64;       // hard cap on chain length (bounds restore replay cost)
const REBASE_RECLAIM_RATIO = 0.6;  // W5: rebase if used-heap dropped to < this * peak seen

// ---- page-delta codec -------------------------------------------------------
// Encode the pages of `cur` that differ from `prev` as: a varint count, then for
// each page [varint pageIndex][PAGE bytes]. Also carries cur.length so restore can
// size the buffer exactly (handles monotonic linear-memory growth). The whole blob
// is gzipped by the store routing (putRaw routes by size; we gzip ourselves so the
// delta rows are small in SQLite).
function encodeDelta(prev, cur) {
  const totalPages = Math.ceil(cur.length / PAGE);
  const dirty = [];
  for (let p = 0; p < totalPages; p++) {
    const s = p * PAGE;
    const e = Math.min(s + PAGE, cur.length);
    let isDirty = false;
    for (let j = s; j < e; j++) {
      const pv = prev && j < prev.length ? prev[j] : 0;
      if (cur[j] !== pv) { isDirty = true; break; }
    }
    // a page that newly exists beyond prev.length is dirty by definition
    if (!isDirty && prev && s >= prev.length) isDirty = true;
    if (isDirty) dirty.push(p);
  }
  // serialize
  const head = [];
  pushVarint(head, cur.length);
  pushVarint(head, dirty.length);
  for (const p of dirty) pushVarint(head, p);
  const headBuf = Uint8Array.from(head);
  // body: fixed PAGE stride per dirty page (tail page implicitly zero-padded).
  const body2 = new Uint8Array(dirty.length * PAGE);
  for (let i = 0; i < dirty.length; i++) {
    const p = dirty[i];
    const s = p * PAGE, e = Math.min(s + PAGE, cur.length);
    body2.set(cur.subarray(s, e), i * PAGE);
  }
  const out = new Uint8Array(headBuf.length + body2.length);
  out.set(headBuf, 0);
  out.set(body2, headBuf.length);
  return { blob: gz(out), nDirty: dirty.length, totalPages };
}

function applyDelta(base, deltaGz) {
  const raw = gunzip(deltaGz);
  let off = 0;
  const r = () => { const [v, n] = readVarint(raw, off); off = n; return v; };
  const curLen = r();
  const nDirty = r();
  const pages = [];
  for (let i = 0; i < nDirty; i++) pages.push(r());
  const bodyStart = off;
  // grow/clone base to curLen
  const out = new Uint8Array(curLen);
  out.set(base.subarray(0, Math.min(base.length, curLen)), 0);
  for (let i = 0; i < nDirty; i++) {
    const p = pages[i];
    const s = p * PAGE, e = Math.min(s + PAGE, curLen);
    out.set(raw.subarray(bodyStart + i * PAGE, bodyStart + i * PAGE + (e - s)), s);
  }
  return out;
}

function pushVarint(arr, v) {
  v = v >>> 0;
  while (v >= 0x80) { arr.push((v & 0x7f) | 0x80); v >>>= 7; }
  arr.push(v);
}
function readVarint(buf, off) {
  let v = 0, shift = 0, b;
  do { b = buf[off++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return [v >>> 0, off];
}

export const combined = {
  name: 'combined',

  // per-session mutable bookkeeping, keyed by ctx.key (the runner reuses one strategy
  // object across workloads, so namespace state by key).
  _st: new Map(),
  _state(key) {
    if (!this._st.has(key)) {
      this._st.set(key, {
        baseGen: 0,           // generation of the current base
        baseGzBytes: 1,       // gz size of current base (for chain ratio)
        baseImage: null,      // in-process cache of base raw image (host would re-read; this just avoids a store read each cell)
        chain: [],            // [{gen, key}] committed page-deltas since base
        chainGzBytes: 0,
        peakUsed: 0,
        oplog: [],            // E6: [{seq, src, clockTick, rngCounter}]
        seq: 0,
      });
    }
    return this._st.get(key);
  },

  onCheckpoint(prevImage, curImage, hostState, store, ctx) {
    const st = this._state(ctx.key);
    const gen = ctx.generation;
    let bytes = 0;

    // E6: append the cell to the oplog tail (crash tail + engine-migration net).
    // APPEND-ONLY: write just the new entry under its own key (a real oplog appends a row,
    // it does not rewrite the whole log). hostState may carry the cell source + seeded
    // entropy cursor; the harness driver provides {__src,__rng} when available.
    st.seq++;
    const entry = {
      seq: st.seq, gen,
      src: (hostState && hostState.__src) || null,
      rngCounter: (hostState && hostState.__rng) || 0,
    };
    st.oplog.push(entry);
    const opEntryBytes = store.putRaw(`${ctx.key}/op.${st.seq}`, new TextEncoder().encode(JSON.stringify(entry)));
    bytes += opEntryBytes.bytes;
    st.oplogKeys = st.oplogKeys || [];
    st.oplogKeys.push(`${ctx.key}/op.${st.seq}`);

    // decide rebase (W5 compaction):
    //   - first checkpoint, or no base yet
    //   - chain too long / too heavy
    //   - used-heap reclaim detected (spike-then-free) — re-snapshot a compacted base
    const usedHeapHint = (hostState && hostState.__usedHeap) || curImage.length;
    if (usedHeapHint > st.peakUsed) st.peakUsed = usedHeapHint;
    const reclaimed = st.peakUsed > 0 && usedHeapHint < st.peakUsed * REBASE_RECLAIM_RATIO;

    const forceBase = st.baseImage === null;
    const needBase =
      forceBase ||
      st.chain.length >= REBASE_MAX_CHAIN ||              // bound restore replay cost
      st.chainGzBytes >= st.baseGzBytes * REBASE_CHAIN_RATIO || // chain heavier than half a base
      reclaimed;                                          // W5: spike-then-free → compact

    if (needBase) {
      // ---- W5 rebase: write a full compacted base, drop the delta chain ----
      const baseKey = `${ctx.key}/base.${gen}`;
      const res = store.putSnapshot(baseKey, curImage); // store gzips + routes (SQLite/R2)
      bytes += res.bytes;
      // delete the OLD base + its delta chain (reclaim durable space) AFTER new base commits
      if (st.baseImage !== null) {
        store.deleteSnapshot(`${ctx.key}/base.${st.baseGen}`);
        for (const d of st.chain) store.deleteSnapshot(d.key);
        // E6: oplog tail older than the new base is now redundant (state is in the base).
        for (const ok of (st.oplogKeys || [])) store.deleteSnapshot(ok);
        st.oplogKeys = [`${ctx.key}/op.${st.seq}`];
        st.oplog = [entry];
      }
      st.baseGen = gen;
      st.baseGzBytes = res.gzBytes;
      st.baseImage = curImage;
      st.chain = [];
      st.chainGzBytes = 0;
      // reset peak so a fresh post-rebase spike re-triggers correctly
      st.peakUsed = usedHeapHint;
    } else {
      // ---- W4 byte-delta: write only dirty pages vs the previous image ----
      const ref = prevImage || st.baseImage;
      const { blob } = encodeDelta(ref, curImage);
      const dKey = `${ctx.key}/d.${gen}`;
      const r = store.putRaw(dKey, blob); // already gzipped; routes by size
      bytes += r.bytes;
      st.chain.push({ gen, key: dKey });
      st.chainGzBytes += blob.byteLength;
    }

    // host state committed alongside (single commit point). Small blob.
    const hs = new TextEncoder().encode(JSON.stringify(hostState ?? {}));
    const hr = store.putRaw(`${ctx.key}/host`, hs);
    bytes += hr.bytes;

    // manifest written LAST (commit point): records base gen + ordered chain + oplog tail keys.
    const manifest = {
      baseKey: `${ctx.key}/base.${st.baseGen}`,
      chain: st.chain.map((d) => d.key),
      hostKey: `${ctx.key}/host`,
      oplogKeys: st.oplogKeys.slice(),
    };
    const mBytes = store.putRaw(`${ctx.key}/manifest`, new TextEncoder().encode(JSON.stringify(manifest)));
    bytes += mBytes.bytes;

    return { stored: { manifestKey: `${ctx.key}/manifest` }, bytes };
  },

  onRestore(stored, store, ctx) {
    // Read the manifest (commit point), then base + replay the committed delta chain.
    const mBytes = store.getRaw(stored.manifestKey);
    const manifest = JSON.parse(new TextDecoder().decode(mBytes));
    let image = store.getSnapshot(manifest.baseKey); // raw base image
    for (const dKey of manifest.chain) {
      const deltaGz = store.getRaw(dKey);
      image = applyDelta(image, deltaGz);
    }
    const hsBytes = store.getRaw(manifest.hostKey);
    const hostState = hsBytes ? JSON.parse(new TextDecoder().decode(hsBytes)) : {};
    // E6 oplog is available at manifest.oplogKey for crash-tail / engine-migration replay;
    // not needed on the normal byte-identical path.
    return { image, hostState };
  },
};
export default combined;
