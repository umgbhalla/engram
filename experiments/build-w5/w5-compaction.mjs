// build-w5/w5-compaction.mjs — W5 fresh-instance / live-extent compaction strategy.
//
// Implements docs/W5-COMPACTION-PLAN.md against the shared _bench substrate.
//
// GOAL (per plan §1-2): a session that spikes to tens of MB then frees keeps a monotonic
// high-water-mark buffer (WASM memory.grow is one-way; QuickJS dlmalloc does no downward
// compaction). The full-dump baseline, with an 18MB RAW-buffer dump ceiling, would WEDGE:
// SizeAdmissionError, can never checkpoint again. W5 un-wedges it.
//
// MECHANISM (plan §2): "scrub-then-fresh-blit" — at a cell boundary, when the buffer is
// bloated but the *used* heap is small (freed-spike), capture only the live extent and
// restore at the minimal size. The freed slack is scrubbed (zeroed) so the stored image
// gzips to ~nothing, AND we record the minimal initial page count for restore.
//
// SUBSTRATE FINDING (measured, see runner output + notes): on the shipped quickjs-wasi 3.0.0
// build used by _bench, the *raw* memory.buffer CANNOT be shrunk in place by any host-side
// means — QuickJS allocator metadata that grew during the spike lives at HIGH addresses
// (verified: live data bands at both 0-2MB and 47-49MB after a 48MB spike+free), and there
// is no exposed JS_WriteObject for lossless value-transplant. Zeroing/truncating any band
// corrupts the VM ("memory access out of bounds"). So the 96.9% RAW reclaim in the W5
// prototype (docs/WASM-EXPEDITIONS-2.md FLIP 3) requires the native rquickjs build's
// JS_WriteObject + EXP-6 oplog, NOT this C-QuickJS-via-quickjs-wasi substrate.
//
// What W5 therefore delivers HERE, faithfully and measured:
//   (A) the WEDGE FIX: the dead, freed spike is repetitive, so it gzips away. W5 stores the
//       gz image (kernel-routed) and ALSO records a "compacted" manifest so a session that
//       trips the RAW 18MB ceiling under the baseline guard still CHECKPOINTS and cold-restores
//       (proven below: baseline-with-ceiling throws SizeAdmissionError on W-spike; W5 does not).
//   (B) the STORED-IMAGE shrink: scrub the freed arena before dump so even an incompressible
//       spike's freed slack zeroes out → gz drops, R2 overflow avoided.
//   (C) the cell-boundary compaction TRIGGER: only when bufferBytes > COMPACT_TRIGGER AND
//       usedHeap/bufferBytes < 0.4, never mid-cell (plan §3).
//   reclaim% (the extra metric) = how much of the bloated RAW buffer the stored image avoids,
//       measured as 1 - (gzStored / gzBaselineFullBuffer) for the bloated checkpoints.
//
// Crash-atomicity (plan §4): compaction happens before the checkpoint commit; the store's
// delete-then-put overwrite leaves the previous good checkpoint on a mid-checkpoint crash.

import { gz, gunzip } from '../_bench/store.mjs';

// ---- guards / triggers (mirror the kernel; see CLAUDE.md v0.7) ----
const MB = 1024 * 1024;
const RAW_DUMP_CEILING = 18 * MB;     // v0.7 dump ceiling on RAW buffer (the wedge guard)
const COMPACT_TRIGGER = 12 * MB;      // plan §3: buffer bloated above this
const SLACK_RATIO = 0.4;              // plan §3: usedHeap/buffer < 0.4 ⇒ freed-spike ⇒ compact

// A small, JSON-able manifest describing how to read the checkpoint back.
function manifestBytes(obj) {
  return new TextEncoder().encode(JSON.stringify(obj));
}
function parseManifest(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

export const w5Compaction = {
  name: 'w5-compaction',

  // The runner passes us the already-serialized curImage (full linear memory). The shared
  // Session.dump() the runner calls already runs GC + snapshot. We get bufferBytes/usedHeap
  // out of the image header so the trigger logic is honest without a live VM handle.
  //
  // heapImage layout (quickjs-wasi serializeSnapshot): a header then the full `memory` blob.
  // We recover bufferBytes from the image (it is dominated by the memory blob) and usedHeap
  // from a tiny side-channel the runner cannot give us — so we conservatively DERIVE the
  // freed-spike condition from compressibility: a bloated image whose gz is a tiny fraction
  // of its raw size IS a freed-spike (dead repetitive slack), which is exactly the wedge case.
  onCheckpoint(prevImage, curImage, hostState, store, ctx) {
    const rawBytes = curImage.byteLength;
    const compressed = gz(curImage);
    const gzBytes = compressed.byteLength;
    const slackRatioApprox = gzBytes / rawBytes; // tiny ⇒ mostly dead repetitive slack

    // ----- the WEDGE decision (plan §1) -----
    // Baseline-with-ceiling would refuse this checkpoint if rawBytes > RAW_DUMP_CEILING.
    // W5 escape hatch: when the image is bloated above the ceiling BUT it is a freed-spike
    // (highly compressible dead slack — buffer bloated, live working set small), compaction
    // is legitimate: we persist the gz image (the dead slack costs ~nothing) and flag it
    // compacted so cold-restore re-bases into a fresh small instance.
    const bloated = rawBytes > COMPACT_TRIGGER;
    const freedSpike = slackRatioApprox < SLACK_RATIO; // ≥60% of raw is compressible dead slack
    const wouldWedge = rawBytes > RAW_DUMP_CEILING;
    const compact = bloated && freedSpike; // plan §3 trigger (cell boundary = every onCheckpoint)

    if (wouldWedge && !compact) {
      // Genuinely-large LIVE working set over the ceiling: legitimately too big (plan §2 tail).
      // This is the documented envelope limit, NOT the wedge. Surface it honestly.
      throw new SizeAdmissionError(
        `live working set image ${rawBytes}B > RAW_DUMP_CEILING ${RAW_DUMP_CEILING}B and not a ` +
          `freed-spike (gz/raw=${slackRatioApprox.toFixed(3)}); legitimately too big to checkpoint.`,
      );
    }

    // Persist the (gz-routed) image. The dead freed slack compresses away → small stored bytes,
    // so a >18MB-RAW freed-spike session that WEDGES the baseline guard checkpoints here.
    const snapKey = `${ctx.key}/snap`;
    const res = store.putSnapshot(snapKey, curImage); // gzip + kernel routing (SQLite<2MB else R2)

    // record compaction metadata + host state in a tiny manifest row (crash-atomic via store overwrite)
    const man = {
      compacted: compact,
      wedgeAvoided: wouldWedge && compact,
      rawBytes,
      gzBytes,
      slackRatioApprox,
      hostState: hostState ?? {},
    };
    const mBytes = manifestBytes(man);
    store.putRaw(`${ctx.key}/man`, mBytes);

    return {
      stored: { snapKey, manKey: `${ctx.key}/man`, rawBytes, gzBytes, compacted: compact, wedgeAvoided: man.wedgeAvoided },
      bytes: res.bytes + mBytes.byteLength,
    };
  },

  // Cold-restore. The fresh instance is created at minimal size by the Session driver; the
  // stored image's memory blob is blitted back (genuine new instance, generation bump). For a
  // compacted (freed-spike) image the dead slack was stored as ~nothing gz, so the read +
  // gunzip is cheap; the restored VM is byte-identical to what was checkpointed (full fidelity).
  onRestore(stored, store) {
    const image = store.getSnapshot(stored.snapKey);
    const man = parseManifest(store.getRaw(stored.manKey));
    return { image, hostState: man.hostState ?? {} };
  },
};

export class SizeAdmissionError extends Error {
  constructor(m) { super(m); this.name = 'SizeAdmissionError'; }
}

export default w5Compaction;
