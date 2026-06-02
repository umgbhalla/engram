// commit.mjs — the SINGLE COMMIT POINT (coherence invariant §2).
//
// checkpoint() commits, in ONE flush with no intervening storage-yielding await:
//   1) flush staged R2 fs-bodies (put-before-meta);
//   2) dump live WASM heap -> staged heap chunks (SQLite <2MB gz, else R2);
//   3) commit the ENTIRE staged set together: heap chunks + heap-manifest + host manifest
//      (files meta + kv + timer registry + nowTick) as one logical version.
//
// So heap and host share one version: a cold restore reads them at byte-identical version.
// Anything written after the last checkpoint rolls back together (we re-create the staged
// R2/state from the committed manifest on restore, dropping uncommitted mutations).

export function checkpoint(sess, r2, store, ctx) {
  ctx.generation++;
  // (1) bodies first — put-before-commit ordering
  r2.flushBodies();
  // (2) heap dump
  const image = sess.dump();
  store.putSnapshot(`${ctx.key}/heap`, image);
  // (3) host manifest — files meta + kv + timer registry + virtual clock — committed together
  const manifest = {
    version: ctx.generation,
    files: sess.state.files,
    kv: sess.state.kv,
    timers: sess.state.timers,
    nowTick: sess.state.nowTick,
    timerSeq: sess.state.timerSeq,
  };
  const mbytes = new TextEncoder().encode(JSON.stringify(manifest));
  store.putRaw(`${ctx.key}/hostmanifest`, mbytes);
  return { heapKey: `${ctx.key}/heap`, manifestKey: `${ctx.key}/hostmanifest`, image };
}

export function restore(sess, stored, r2, store, ctx) {
  // re-read the committed host manifest -> rebuild durable state (drops uncommitted writes)
  const mbytes = store.getRaw(stored.manifestKey);
  const manifest = JSON.parse(new TextDecoder().decode(mbytes));
  sess.state.files = manifest.files;
  sess.state.kv = manifest.kv;
  sess.state.timers = manifest.timers;
  sess.state.nowTick = manifest.nowTick;
  sess.state.timerSeq = manifest.timerSeq;
  sess.nowTickRef.tick = manifest.nowTick;
  // re-bind committed R2 bodies so getCommittedOrStaged can fetch them
  const r2keys = Object.values(manifest.files).filter((m) => m.storage === 'r2').map((m) => m.r2key);
  r2.markCommitted(r2keys);
  const image = store.getSnapshot(stored.heapKey);
  return image;
}
