// strategies/full-dump.mjs — the trivial pass-through baseline.
//
// Every checkpoint serializes the WHOLE heapImage and stores it via the kernel routing
// rule (SQLite chunks <2MB gz else R2). onRestore reads it back verbatim. This is the
// v0 kernel behaviour and the fairness baseline every other strategy is measured against.

export const fullDump = {
  name: 'full-dump',

  onCheckpoint(prevImage, curImage, hostState, store, ctx) {
    const key = `${ctx.key}/snap`;
    const res = store.putSnapshot(key, curImage);
    // host state goes in a tiny manifest blob alongside (counted via putRaw->sqlite)
    const hs = new TextEncoder().encode(JSON.stringify(hostState ?? {}));
    store.putRaw(`${ctx.key}/host`, hs);
    return { stored: { key, hostKey: `${ctx.key}/host` }, bytes: res.bytes + hs.byteLength };
  },

  onRestore(stored, store) {
    const image = store.getSnapshot(stored.key);
    const hsBytes = store.getRaw(stored.hostKey);
    const hostState = hsBytes ? JSON.parse(new TextDecoder().decode(hsBytes)) : {};
    return { image, hostState };
  },
};
