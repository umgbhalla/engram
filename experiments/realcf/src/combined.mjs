// combined.mjs — the PRODUCTION durability stack (W5 compaction + W4 byte-delta + E6
// oplog), ported VERBATIM from experiments/build-combined/strategies/combined.mjs to the
// async CF store (gz / store ops are async on workerd). Algorithm is byte-for-byte the
// same; only awaits were added. See that file's header for the full design rationale.

import { gz, gunzip } from "./store.mjs";

const PAGE = 4096; // dirty-page granularity for W4 byte-delta
const REBASE_CHAIN_RATIO = 3.0; // W5: rebase when cumulative chain gz >= this * base gz
const REBASE_MAX_CHAIN = 64; // hard cap on chain length (bounds restore replay cost)
const REBASE_RECLAIM_RATIO = 0.6; // W5: rebase if used-heap dropped to < this * peak seen

// ---- page-delta codec (W4) -------------------------------------------------
function encodeDelta(prev, cur) {
  const totalPages = Math.ceil(cur.length / PAGE);
  const dirty = [];
  for (let p = 0; p < totalPages; p++) {
    const s = p * PAGE;
    const e = Math.min(s + PAGE, cur.length);
    let isDirty = false;
    for (let j = s; j < e; j++) {
      const pv = prev && j < prev.length ? prev[j] : 0;
      if (cur[j] !== pv) {
        isDirty = true;
        break;
      }
    }
    if (!isDirty && prev && s >= prev.length) isDirty = true;
    if (isDirty) dirty.push(p);
  }
  const head = [];
  pushVarint(head, cur.length);
  pushVarint(head, dirty.length);
  for (const p of dirty) pushVarint(head, p);
  const headBuf = Uint8Array.from(head);
  const body2 = new Uint8Array(dirty.length * PAGE);
  for (let i = 0; i < dirty.length; i++) {
    const p = dirty[i];
    const s = p * PAGE,
      e = Math.min(s + PAGE, cur.length);
    body2.set(cur.subarray(s, e), i * PAGE);
  }
  const out = new Uint8Array(headBuf.length + body2.length);
  out.set(headBuf, 0);
  out.set(body2, headBuf.length);
  return { out, nDirty: dirty.length, totalPages };
}

function applyDelta(base, deltaRaw) {
  const raw = deltaRaw;
  let off = 0;
  const r = () => {
    const [v, n] = readVarint(raw, off);
    off = n;
    return v;
  };
  const curLen = r();
  const nDirty = r();
  const pages = [];
  for (let i = 0; i < nDirty; i++) pages.push(r());
  const bodyStart = off;
  const out = new Uint8Array(curLen);
  out.set(base.subarray(0, Math.min(base.length, curLen)), 0);
  for (let i = 0; i < nDirty; i++) {
    const p = pages[i];
    const s = p * PAGE,
      e = Math.min(s + PAGE, curLen);
    out.set(raw.subarray(bodyStart + i * PAGE, bodyStart + i * PAGE + (e - s)), s);
  }
  return out;
}

function pushVarint(arr, v) {
  v = v >>> 0;
  while (v >= 0x80) {
    arr.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  arr.push(v);
}
function readVarint(buf, off) {
  let v = 0,
    shift = 0,
    b;
  do {
    b = buf[off++];
    v |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [v >>> 0, off];
}

export const combined = {
  name: "combined",
  _st: new Map(),
  _state(key) {
    if (!this._st.has(key)) {
      this._st.set(key, {
        baseGen: 0,
        baseGzBytes: 1,
        baseImage: null,
        chain: [],
        chainGzBytes: 0,
        peakUsed: 0,
        oplog: [],
        oplogKeys: [],
        seq: 0,
      });
    }
    return this._st.get(key);
  },
  // drop in-process cache so a genuine cold-restore re-reads durable storage
  evict(key) {
    const st = this._st.get(key);
    if (st) st.baseImage = null;
  },

  async onCheckpoint(prevImage, curImage, hostState, store, ctx) {
    const st = this._state(ctx.key);
    const gen = ctx.generation;
    let bytes = 0;

    // E6: append the cell to the oplog tail (append-only).
    st.seq++;
    const entry = {
      seq: st.seq,
      gen,
      src: (hostState && hostState.__src) || null,
      rngCounter: (hostState && hostState.__rng) || 0,
    };
    st.oplog.push(entry);
    const opR = await store.putRaw(
      `${ctx.key}/op.${st.seq}`,
      new TextEncoder().encode(JSON.stringify(entry)),
    );
    bytes += opR.bytes;
    st.oplogKeys.push(`${ctx.key}/op.${st.seq}`);

    // W5 rebase decision
    const usedHeapHint = (hostState && hostState.__usedHeap) || curImage.length;
    if (usedHeapHint > st.peakUsed) st.peakUsed = usedHeapHint;
    const reclaimed = st.peakUsed > 0 && usedHeapHint < st.peakUsed * REBASE_RECLAIM_RATIO;

    const forceBase = st.baseImage === null;
    const needBase =
      forceBase ||
      st.chain.length >= REBASE_MAX_CHAIN ||
      st.chainGzBytes >= st.baseGzBytes * REBASE_CHAIN_RATIO ||
      reclaimed;

    if (needBase) {
      // ---- W5 rebase: full compacted base ----
      const baseKey = `${ctx.key}/base.${gen}`;
      const res = await store.putSnapshot(baseKey, curImage);
      bytes += res.bytes;
      if (st.baseImage !== null) {
        await store.deleteSnapshot(`${ctx.key}/base.${st.baseGen}`);
        for (const d of st.chain) await store.deleteSnapshot(d.key);
        for (const ok of st.oplogKeys.slice(0, -1)) await store.deleteSnapshot(ok);
        st.oplogKeys = [`${ctx.key}/op.${st.seq}`];
        st.oplog = [entry];
      }
      st.baseGen = gen;
      st.baseGzBytes = res.bytes; // gz size of the routed base
      st.baseImage = curImage;
      st.chain = [];
      st.chainGzBytes = 0;
      st.peakUsed = usedHeapHint;
    } else {
      // ---- W4 byte-delta: only dirty pages vs previous image ----
      const ref = prevImage || st.baseImage;
      const { out } = encodeDelta(ref, curImage);
      const blob = await gz(out);
      const dKey = `${ctx.key}/d.${gen}`;
      const r = await store.putRaw(dKey, blob);
      bytes += r.bytes;
      st.chain.push({ gen, key: dKey });
      st.chainGzBytes += blob.byteLength;
    }

    // host state (single commit point alongside)
    const hs = new TextEncoder().encode(JSON.stringify(hostState ?? {}));
    const hr = await store.putRaw(`${ctx.key}/host`, hs);
    bytes += hr.bytes;

    // manifest written LAST (commit point)
    const manifest = {
      baseKey: `${ctx.key}/base.${st.baseGen}`,
      chain: st.chain.map((d) => d.key),
      hostKey: `${ctx.key}/host`,
      oplogKeys: st.oplogKeys.slice(),
    };
    const mr = await store.putRaw(
      `${ctx.key}/manifest`,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    bytes += mr.bytes;

    return {
      stored: { manifestKey: `${ctx.key}/manifest` },
      bytes,
      // telemetry for /metrics
      rebased: needBase,
      chainLen: st.chain.length,
      oplogLen: st.oplog.length,
    };
  },

  async onRestore(stored, store, ctx) {
    const t = {};
    const t0 = Date.now();
    const mBytes = await store.getRaw(stored.manifestKey);
    const manifest = JSON.parse(new TextDecoder().decode(mBytes));
    const tRead0 = Date.now();
    let image = await store.getSnapshot(manifest.baseKey); // base (gunzipped)
    let replayMs = 0;
    for (const dKey of manifest.chain) {
      const deltaGz = await store.getRaw(dKey);
      const dr0 = Date.now();
      const deltaRaw = await gunzip(deltaGz);
      image = applyDelta(image, deltaRaw);
      replayMs += Date.now() - dr0;
    }
    t.readMs = Date.now() - t0;
    t.gunzipMs = replayMs; // delta-chain gunzip+apply time (base gunzip folded into read)
    const hsBytes = await store.getRaw(manifest.hostKey);
    const hostState = hsBytes ? JSON.parse(new TextDecoder().decode(hsBytes)) : {};
    return { image, hostState, timings: t, chainLen: manifest.chain.length };
  },
};
export default combined;
