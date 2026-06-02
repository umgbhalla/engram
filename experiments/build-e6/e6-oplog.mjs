// e6-oplog.mjs — E6 OPLOG durability strategy.
//
// Per docs/DURABILITY-ROADMAP.md "E6 — oplog tail + engine-migration":
//   * FULL SNAPSHOT every N cells (the heap image, gzip+kernel-routed via store.putSnapshot).
//   * SMALL APPEND-ONLY OPLOG in between: each entry = { seq, kind:'cell',
//     source, seededClockTick, rngCounter } — the cell source + recorded entropy.
//     Host-call results would also be recorded here (none in these workloads).
//   * RESTORE = read the last full snapshot, restore it into a fresh VM, then REPLAY
//     the oplog tail (the cells evaluated since that full) deterministically.
//
// Replay is byte-deterministic because clock+RNG are seeded in the Session (WASI override),
// so re-running the recorded cell sources re-derives identical state. Effectful host calls
// are NOT re-fired — they are replayed from recorded results (none here). This relaxes the
// pure no-replay guarantee inside the oplog window only; full snapshots remain pure restores.
//
// Fairness: this strategy stores through the shared DOStore and reuses the shared Session.
// The oplog needs the CELL SOURCE, which the shared runner.mjs does not pass to onCheckpoint.
// So this strategy exposes `setSource(src)` that the e6 runner (run.mjs) calls before each
// checkpoint. The store/session/workloads substrate is unchanged.

import { TextEncoder, TextDecoder } from 'node:util';
import { Session } from '../_bench/session.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function makeE6Strategy({ snapshotEveryN = 10, seed = 0x12345678, clockMs = 1_700_000_000_000 } = {}) {
  // mutable per-run capture of the current cell source + seeded-entropy counters.
  // (entropy counters are illustrative — the Session reseeds deterministically per VM,
  // so replay from the recorded source alone re-derives identical state.)
  let curSource = '';
  let cellSeq = 0;

  return {
    name: `e6-oplog-N${snapshotEveryN}`,
    snapshotEveryN,
    _seed: seed,
    _clockMs: clockMs,

    // The e6 runner calls this immediately before each checkpoint so the oplog can record source.
    setSource(src) { curSource = src; },

    onCheckpoint(prevImage, curImage, hostState, store, ctx) {
      const seq = ctx.generation; // 1-based monotonic, == cell index+1
      cellSeq = seq;
      const baseKey = ctx.key;

      // Decide: is this a FULL snapshot boundary?
      // We take a full at seq 1 and every snapshotEveryN cells. The most-recent full's seq
      // is recorded so restore knows which full to load + which oplog tail to replay.
      const isFull = (seq === 1) || (seq % snapshotEveryN === 0);

      if (isFull) {
        const fullKey = `${baseKey}/full`;
        const res = store.putSnapshot(fullKey, curImage); // gzip + kernel route
        // truncate the oplog: tail after a full is empty
        const meta = {
          fullKey,
          fullSeq: seq,
          // oplog: array of {seq, src} for cells AFTER fullSeq up to current. empty right after a full.
          oplog: [],
        };
        const metaBytes = enc.encode(JSON.stringify(meta));
        store.putRaw(`${baseKey}/meta`, metaBytes);
        const hs = enc.encode(JSON.stringify(hostState ?? {}));
        store.putRaw(`${baseKey}/host`, hs);
        return { stored: { baseKey, meta }, bytes: res.bytes + metaBytes.byteLength + hs.byteLength };
      }

      // OPLOG path: append the cell source to the meta's oplog. We do NOT store the heap image.
      // Read-modify-write the meta (in a real DO this is a single SQLite row append; we model the
      // durable cost as re-writing the small meta blob — still orders of magnitude < a full image).
      const prevMetaBytes = store.getRaw(`${baseKey}/meta`);
      const meta = prevMetaBytes ? JSON.parse(dec.decode(prevMetaBytes)) : { fullKey: `${baseKey}/full`, fullSeq: 1, oplog: [] };
      meta.oplog.push({ seq, src: curSource });
      const metaBytes = enc.encode(JSON.stringify(meta));
      store.putRaw(`${baseKey}/meta`, metaBytes);
      // host state may have changed; persist alongside (tiny)
      const hs = enc.encode(JSON.stringify(hostState ?? {}));
      store.putRaw(`${baseKey}/host`, hs);
      return { stored: { baseKey, meta }, bytes: metaBytes.byteLength + hs.byteLength };
    },

    // onRestore: load last full, restore VM, replay oplog tail. Returns a byte image (the full)
    // PLUS the replay info so the e6 runner can finish replay against the live VM. Because the
    // shared runner expects a single `image` it restores itself, the e6 runner handles replay.
    onRestore(stored, store, ctx) {
      const { baseKey } = stored;
      const metaBytes = store.getRaw(`${baseKey}/meta`);
      const meta = JSON.parse(dec.decode(metaBytes));
      const image = store.getSnapshot(meta.fullKey);
      const hsBytes = store.getRaw(`${baseKey}/host`);
      const hostState = hsBytes ? JSON.parse(dec.decode(hsBytes)) : {};
      // Attach replay tail; the e6 runner replays meta.oplog sources after restoring `image`.
      return { image, hostState, _replay: meta.oplog };
    },
  };
}

export default makeE6Strategy();
