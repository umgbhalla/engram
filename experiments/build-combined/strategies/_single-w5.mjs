// Reference: PURE W5 compaction (full snapshot every cell, but compacted = the harness
// already GC+snapshots). This is effectively full-dump's per-cell full image. Bounded
// restore (1 read) but MAX bytes-written. Included to show the combined beats it too.
export default { name:'single-w5',
  onCheckpoint(prev,cur,hs,store,ctx){ const k=`${ctx.key}/snap`; const r=store.putSnapshot(k,cur);
    return { stored:{k}, bytes:r.bytes }; },
  onRestore(stored,store){ return { image:store.getSnapshot(stored.k), hostState:{} }; } };
