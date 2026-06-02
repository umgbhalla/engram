// build-baseline/strategy.mjs — the CURRENT Engram durability strategy.
//
// Reference baseline: FULL heap dump every cell -> gzip -> SQLite-first / R2-overflow,
// no compaction, no delta. Every other strategy is compared against this.
//
// This is the exact v0 kernel behaviour. It imports the SHARED harness store/session
// via the runner; the strategy itself only implements the {onCheckpoint, onRestore}
// interface defined in _bench/README.md.

export const baseline = {
  name: 'baseline-full-dump',

  // Persist a full checkpoint: serialize the WHOLE heap image, store via kernel routing
  // (gzip -> <2MB SQLite 64KB chunks, else R2 overflow). Host state goes in a tiny manifest.
  onCheckpoint(prevImage, curImage, hostState, store, ctx) {
    const key = `${ctx.key}/snap`;
    const res = store.putSnapshot(key, curImage); // gzip + kernel SQLite/R2 routing
    const hs = new TextEncoder().encode(JSON.stringify(hostState ?? {}));
    const hostKey = `${ctx.key}/host`;
    store.putRaw(hostKey, hs);
    return { stored: { key, hostKey }, bytes: res.bytes + hs.byteLength };
  },

  // Cold-restore: read the full image back verbatim + the host manifest.
  onRestore(stored, store) {
    const image = store.getSnapshot(stored.key);
    const hsBytes = store.getRaw(stored.hostKey);
    const hostState = hsBytes ? JSON.parse(new TextDecoder().decode(hsBytes)) : {};
    return { image, hostState };
  },
};

export default baseline;
