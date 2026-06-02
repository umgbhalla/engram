// w4-delta.mjs — W4 byte-delta snapshot strategy with DENSE-MUTATION AUTO-FALLBACK.
//
// GAP 5 (the byte-delta safety valve). A checkpoint diffs curImage against the previous
// STORED image in fixed-size pages. We persist only the changed pages as a delta blob,
// chained off a base full image. The safety valve: if the delta's stored size would exceed
// FALLBACK_PCT of a freshly-stored full image, we DROP the delta and store a NEW full base
// instead (re-anchor). This prevents the pathological "delta bigger than full" blow-up when
// a workload mutates densely (large typed-array fill / scattered writes touching most pages).
//
// Storage model (all through the shared store, kernel routing rule applies):
//   - base full image  : putSnapshot(`${key}/base/<gen>`, raw)   gzip+route
//   - delta blob        : putRaw(`${key}/delta/<gen>`, encodedDelta)  verbatim (already packed)
//   - manifest token (returned in `stored`) records the chain so onRestore can rebuild.
//
// Restore: read the base full, then replay each delta in chain order onto a working buffer
// => byte-identical reconstruction of the checkpointed curImage.
//
// Delta wire format (verbatim bytes, NOT gzipped by us — we let the store's putRaw route it;
// we DO gzip the changed-page payload ourselves so the on-wire delta is honestly compressed,
// matching how the kernel would persist a delta row):
//   magic   "W4D1" (4 bytes)
//   pageSize u32 LE
//   fullLen  u32 LE   (length of the full image this delta reconstructs to)
//   nPages   u32 LE   (number of changed pages encoded)
//   then nPages * (pageIndex u32 LE)         — the dirty page indices
//   then gzip( concat(changed page bodies) ) — the page bodies, gzipped together
//
// FALLBACK_PCT is configurable per strategy instance (sweepable). Default 0.5.

import { gz, gunzip } from '../_bench/store.mjs';

const MAGIC = new Uint8Array([0x57, 0x34, 0x44, 0x31]); // "W4D1"
const DEFAULT_PAGE = 4096;
const DEFAULT_FALLBACK_PCT = 0.5;

function u32le(n) {
  const b = new Uint8Array(4);
  b[0] = n & 0xff; b[1] = (n >>> 8) & 0xff; b[2] = (n >>> 16) & 0xff; b[3] = (n >>> 24) & 0xff;
  return b;
}
function readU32le(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

// Compute the set of dirty page indices comparing prev vs cur, plus the packed changed-page
// bodies. Pages that fall beyond prev (growth) are always dirty. A page whose tail is cut off
// by fullLen is stored at its true (possibly short) length.
function diffPages(prev, cur, pageSize) {
  const dirty = [];
  const bodies = [];
  const nPages = Math.ceil(cur.byteLength / pageSize);
  for (let p = 0; p < nPages; p++) {
    const start = p * pageSize;
    const end = Math.min(start + pageSize, cur.byteLength);
    const curPage = cur.subarray(start, end);
    let same = false;
    if (prev && start < prev.byteLength) {
      const pEnd = Math.min(start + pageSize, prev.byteLength);
      if (pEnd - start === end - start) {
        same = true;
        for (let i = start; i < end; i++) {
          if (prev[i] !== cur[i]) { same = false; break; }
        }
      }
    }
    if (!same) {
      dirty.push(p);
      bodies.push(curPage);
    }
  }
  return { dirty, bodies, nPages };
}

function encodeDelta(prev, cur, pageSize) {
  const { dirty, bodies } = diffPages(prev, cur, pageSize);
  // concat changed page bodies, then gzip them (honest on-wire delta size)
  let bodyLen = 0;
  for (const b of bodies) bodyLen += b.byteLength;
  const bodyBuf = new Uint8Array(bodyLen);
  { let o = 0; for (const b of bodies) { bodyBuf.set(b, o); o += b.byteLength; } }
  const gzBody = gz(bodyBuf);

  const header = [];
  header.push(MAGIC, u32le(pageSize), u32le(cur.byteLength), u32le(dirty.length));
  for (const idx of dirty) header.push(u32le(idx));
  let hLen = 0; for (const h of header) hLen += h.byteLength;
  const out = new Uint8Array(hLen + gzBody.byteLength);
  { let o = 0; for (const h of header) { out.set(h, o); o += h.byteLength; } out.set(gzBody, o); }
  return { encoded: out, nDirty: dirty.length, pageSize };
}

// Apply a delta onto `base` (a full reconstructed image) -> new full image.
function applyDelta(base, encoded) {
  for (let i = 0; i < 4; i++) if (encoded[i] !== MAGIC[i]) throw new Error('bad delta magic');
  let off = 4;
  const pageSize = readU32le(encoded, off); off += 4;
  const fullLen = readU32le(encoded, off); off += 4;
  const nPages = readU32le(encoded, off); off += 4;
  const indices = new Array(nPages);
  for (let i = 0; i < nPages; i++) { indices[i] = readU32le(encoded, off); off += 4; }
  const gzBody = encoded.subarray(off);
  const bodyBuf = gunzip(gzBody);

  const out = new Uint8Array(fullLen);
  // start from base (truncate/extend to fullLen)
  out.set(base.subarray(0, Math.min(base.byteLength, fullLen)));
  // apply changed pages
  let bo = 0;
  for (let i = 0; i < nPages; i++) {
    const p = indices[i];
    const start = p * pageSize;
    const end = Math.min(start + pageSize, fullLen);
    const len = end - start;
    out.set(bodyBuf.subarray(bo, bo + len), start);
    bo += len;
  }
  return out;
}

export function makeW4Delta({ pageSize = DEFAULT_PAGE, fallbackPct = DEFAULT_FALLBACK_PCT } = {}) {
  // per-instance live telemetry the runner/driver can read after a run
  const tele = {
    checkpoints: 0,
    fallbacks: 0,     // times we re-anchored to a full because delta too big
    deltas: 0,        // times we stored a delta
    bases: 0,         // base-full stores (includes forced first + fallbacks)
    worstStoredVsFull: 0, // max(storedBytesThisCkpt / fullBytesThisCkpt)
    sumDeltaStored: 0,
    sumFullEquivStored: 0, // what a full store would have cost each ckpt (for amp comparison)
  };

  // chain state lives keyed in `stored`, but we also need the prev STORED full to diff
  // against. The runner passes prevImage (the last curImage) which equals what we last
  // reconstructed, so diffing against prevImage is correct as long as we always keep the
  // chain anchored consistently. We anchor: base + ordered deltas.

  const strat = {
    name: `w4-delta-fb${Math.round(fallbackPct * 100)}`,
    _tele: tele,
    _config: { pageSize, fallbackPct },

    onCheckpoint(prevImage, curImage, hostState, store, ctx) {
      tele.checkpoints++;
      const gen = ctx.generation;
      const baseKey = `${ctx.key}/base`;
      const hostKey = `${ctx.key}/host`;

      // host state (tiny manifest blob, counted)
      const hs = new TextEncoder().encode(JSON.stringify(hostState ?? {}));
      store.putRaw(hostKey, hs);

      // what would a full store cost right now? (the fairness reference per ckpt)
      const fullGz = gz(curImage);
      const fullEquiv = fullGz.byteLength; // approximate stored full size (gz)
      tele.sumFullEquivStored += fullEquiv;

      // first checkpoint OR no prev -> must store a base full.
      if (!prevImage || !this._chain) {
        const res = store.putSnapshot(baseKey, curImage);
        this._chain = { baseKey, baseGen: gen, deltaKeys: [] };
        tele.bases++;
        tele.sumDeltaStored += res.gzBytes;
        const ratio = res.gzBytes / Math.max(1, fullEquiv);
        if (ratio > tele.worstStoredVsFull) tele.worstStoredVsFull = ratio;
        return {
          stored: { mode: 'base', baseKey, hostKey, chain: { ...this._chain } },
          bytes: res.bytes + hs.byteLength,
        };
      }

      // build a delta vs prevImage
      const { encoded, nDirty } = encodeDelta(prevImage, curImage, pageSize);
      const deltaStored = encoded.byteLength;

      // === THE SAFETY VALVE ===
      // If the delta (already gz'd payload) would cost more than fallbackPct of a fresh full,
      // re-anchor: store a new base full instead and reset the chain. Never let a bloated
      // delta land.
      if (deltaStored > fallbackPct * fullEquiv) {
        const res = store.putSnapshot(baseKey, curImage);
        this._chain = { baseKey, baseGen: gen, deltaKeys: [] };
        tele.fallbacks++;
        tele.bases++;
        tele.sumDeltaStored += res.gzBytes;
        const ratio = res.gzBytes / Math.max(1, fullEquiv);
        if (ratio > tele.worstStoredVsFull) tele.worstStoredVsFull = ratio;
        return {
          stored: { mode: 'fallback-base', baseKey, hostKey, chain: { ...this._chain } },
          bytes: res.bytes + hs.byteLength,
        };
      }

      // store the delta, extend the chain
      const deltaKey = `${ctx.key}/delta/${gen}`;
      const r = store.putRaw(deltaKey, encoded);
      this._chain.deltaKeys.push(deltaKey);
      tele.deltas++;
      tele.sumDeltaStored += r.bytes;
      const ratio = r.bytes / Math.max(1, fullEquiv);
      if (ratio > tele.worstStoredVsFull) tele.worstStoredVsFull = ratio;
      return {
        stored: { mode: 'delta', baseKey, hostKey, nDirty, chain: { ...this._chain } },
        bytes: r.bytes + hs.byteLength,
      };
    },

    onRestore(stored, store) {
      const hsBytes = store.getRaw(stored.hostKey);
      const hostState = hsBytes ? JSON.parse(new TextDecoder().decode(hsBytes)) : {};
      const chain = stored.chain;
      let image = store.getSnapshot(chain.baseKey);
      for (const dk of chain.deltaKeys) {
        const enc = store.getRaw(dk);
        image = applyDelta(image, enc);
      }
      // After restore, the live chain in this strategy instance is gone (genuine cold
      // process). Re-seed _chain so subsequent checkpoints diff/extend correctly: the
      // restored image is now the "prev", and we keep appending deltas onto the same base.
      this._chain = { baseKey: chain.baseKey, baseGen: chain.baseGen, deltaKeys: [...chain.deltaKeys] };
      return { image, hostState };
    },
  };
  return strat;
}

export default makeW4Delta();
