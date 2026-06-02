// build-w4/byte-delta.mjs — W4 fine-grain byte-delta durability strategy.
//
// Per docs/W4-BYTEDELTA-PLAN.md:
//   - 256B content-chunked delta vs the retained `prevImage` (the previous checkpoint's image).
//   - A full (base) snapshot every N cells (BASE_EVERY); deltas chain off the most recent base.
//   - Auto-fallback to a full snapshot when a delta would exceed FALLBACK_PCT of a full dump.
//
// Storage layout (all keyed off ctx.key so strategies don't collide):
//   <key>/base/<g>      a full gzip'd image (kernel routing via putSnapshot)
//   <key>/delta/<g>     a gzip'd delta blob (verbatim putRaw)
//   <key>/host/<g>      host state JSON for that checkpoint (verbatim putRaw)
//   <key>/head          a tiny pointer manifest: { baseGen, deltaGens:[...], hostKey, kind }
//
// On checkpoint we update the head pointer to describe the current restore chain. onRestore reads
// the head, loads the base, applies the ordered deltas → byte-identical reconstructed image.
//
// Crash-atomicity: base/delta/host blobs are written BEFORE the head pointer is overwritten, and
// the head is a single small row (the kernel's write-coalescing makes a single-row replace atomic).
// A partial delta write that never updated head is simply unreferenced → restore uses the last
// complete head, i.e. falls back to the previous complete checkpoint.

import { gz, gunzip } from '../_bench/store.mjs';

export const GRAIN = 256;            // W4-proven sweet spot
export const BASE_EVERY = 20;        // full (base) snapshot cadence
export const FALLBACK_PCT = 0.5;     // if delta gz >= 50% of full gz, store a full instead

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- delta codec --------------------------------------------------------------
// Format (uncompressed, then gzipped):
//   magic  'D4'                    2 bytes
//   curLen (u32 LE)                4 bytes   — exact byte length of cur image
//   nChunks(u32 LE)                4 bytes   — number of changed 256B chunks emitted
//   then nChunks records, each:
//     idx  (u32 LE)                4 bytes   — chunk index (offset = idx*GRAIN)
//     len  (u16 LE)                2 bytes   — bytes in this chunk (256 except possibly the tail)
//     bytes(len)
// Reconstruction: start from base of length curLen (copy prev image, resize to curLen),
// then overwrite each emitted chunk.
function encodeDelta(prev, cur) {
  const curLen = cur.byteLength;
  const prevLen = prev ? prev.byteLength : 0;
  const nGrains = Math.ceil(curLen / GRAIN);
  const changed = [];
  for (let g = 0; g < nGrains; g++) {
    const off = g * GRAIN;
    const len = Math.min(GRAIN, curLen - off);
    let differ = false;
    if (off + len > prevLen) {
      differ = true; // beyond prev image → entirely new
    } else {
      for (let k = 0; k < len; k++) {
        if (cur[off + k] !== prev[off + k]) { differ = true; break; }
      }
    }
    if (differ) changed.push({ idx: g, off, len });
  }
  // header + records
  let total = 2 + 4 + 4;
  for (const c of changed) total += 4 + 2 + c.len;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = 0x44; out[1] = 0x34; // 'D4'
  dv.setUint32(2, curLen, true);
  dv.setUint32(6, changed.length, true);
  let p = 10;
  for (const c of changed) {
    dv.setUint32(p, c.idx, true); p += 4;
    dv.setUint16(p, c.len, true); p += 2;
    out.set(cur.subarray(c.off, c.off + c.len), p); p += c.len;
  }
  return out;
}

function applyDelta(base, deltaRaw) {
  const dv = new DataView(deltaRaw.buffer, deltaRaw.byteOffset, deltaRaw.byteLength);
  if (deltaRaw[0] !== 0x44 || deltaRaw[1] !== 0x34) throw new Error('bad delta magic');
  const curLen = dv.getUint32(2, true);
  const nChunks = dv.getUint32(6, true);
  const out = new Uint8Array(curLen);
  if (base) out.set(base.subarray(0, Math.min(base.byteLength, curLen)));
  let p = 10;
  for (let i = 0; i < nChunks; i++) {
    const idx = dv.getUint32(p, true); p += 4;
    const len = dv.getUint16(p, true); p += 2;
    out.set(deltaRaw.subarray(p, p + len), idx * GRAIN); p += len;
  }
  return out;
}

export const byteDelta = {
  name: 'byte-delta',
  // expose tunables for sweeps/inspection
  _params: { GRAIN, BASE_EVERY, FALLBACK_PCT },

  onCheckpoint(prevImage, curImage, hostState, store, ctx) {
    const g = ctx.generation;
    // per-session chain state lives on the strategy via a WeakMap-free Map keyed by ctx.key.
    // The runner reuses one ctx per workload, so we can hang state off ctx itself.
    const st = (ctx._w4 ||= { baseGen: null, baseImage: null, deltaGens: [], deltaImages: [] });

    const hostKey = `${ctx.key}/host/${g}`;
    const hsBytes = enc.encode(JSON.stringify(hostState ?? {}));
    store.putRaw(hostKey, hsBytes);

    // decide: full base, or delta?
    // - first checkpoint of a session (no prevImage retained) → must be full
    // - every BASE_EVERY checkpoints → full (resets the chain, bounds restore cost)
    // - no retained base (cold) → full
    const needBaseByCadence = st.baseGen === null || (g - st.baseGen) >= BASE_EVERY;
    let kind;
    let storeRes;

    if (prevImage === null || needBaseByCadence) {
      kind = 'base';
    } else {
      // try a delta against prevImage
      const deltaRaw = encodeDelta(prevImage, curImage);
      const deltaGz = gz(deltaRaw);
      // compare against what a full would cost (gz of full image)
      const fullGz = gz(curImage);
      if (deltaGz.byteLength >= fullGz.byteLength * FALLBACK_PCT) {
        kind = 'base';
      } else {
        kind = 'delta';
        const dKey = `${ctx.key}/delta/${g}`;
        store.putRaw(dKey, deltaGz); // verbatim (already compressed)
        st.deltaGens.push(g);
        st.deltaImages.push(curImage);
      }
    }

    if (kind === 'base') {
      const bKey = `${ctx.key}/base/${g}`;
      storeRes = store.putSnapshot(bKey, curImage);
      st.baseGen = g;
      st.baseImage = curImage;
      st.deltaGens = [];
      st.deltaImages = [];
    }

    // overwrite the single head pointer describing the current restore chain
    const head = {
      baseGen: st.baseGen,
      deltaGens: st.deltaGens.slice(),
      hostKey,
      kind,
    };
    const headKey = `${ctx.key}/head`;
    store.putRaw(headKey, enc.encode(JSON.stringify(head)));

    return {
      stored: { key: ctx.key, headKey },
      bytes: 0, // runner trusts store.stats()
    };
  },

  onRestore(stored, store, ctx) {
    const headBytes = store.getRaw(stored.headKey);
    const head = JSON.parse(dec.decode(headBytes));
    let image = store.getSnapshot(`${stored.key}/base/${head.baseGen}`);
    for (const dg of head.deltaGens) {
      const deltaGz = store.getRaw(`${stored.key}/delta/${dg}`);
      const deltaRaw = gunzip(deltaGz);
      image = applyDelta(image, deltaRaw);
    }
    const hsBytes = store.getRaw(head.hostKey);
    const hostState = hsBytes ? JSON.parse(dec.decode(hsBytes)) : {};
    // reset chain state so post-restore checkpoints rebase cleanly (cold: no retained base)
    if (ctx) ctx._w4 = { baseGen: null, baseImage: null, deltaGens: [], deltaImages: [] };
    return { image, hostState };
  },
};

export default byteDelta;
