// strategy.mjs — expose the sandbox suite's commit/restore as a _bench STRATEGY so the
// build runs the 5 STANDARD WORKLOADS on the identical substrate (fairness). The sandbox's
// durable model = full heap image + a host manifest (kv) committed together. For the standard
// workloads the host state is just the runner's `hostState` (kv tool data), so this strategy
// is functionally the full-dump baseline PLUS the coherence-ordered host-manifest commit.

export const sandboxStrategy = {
  name: 'sandbox',

  onCheckpoint(prevImage, curImage, hostState, store, ctx) {
    // single commit point: heap image + host manifest committed together (no torn version).
    const heapKey = `${ctx.key}/heap`;
    const res = store.putSnapshot(heapKey, curImage);
    const manifestKey = `${ctx.key}/hostmanifest`;
    const mbytes = new TextEncoder().encode(JSON.stringify(hostState ?? {}));
    store.putRaw(manifestKey, mbytes);
    return { stored: { heapKey, manifestKey }, bytes: res.bytes + mbytes.byteLength };
  },

  onRestore(stored, store) {
    const image = store.getSnapshot(stored.heapKey);
    const mbytes = store.getRaw(stored.manifestKey);
    const hostState = mbytes ? JSON.parse(new TextDecoder().decode(mbytes)) : {};
    return { image, hostState };
  },
};
export default sandboxStrategy;
