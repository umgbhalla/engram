// wedge-proof.mjs — proves W5 un-wedges the W-spike session that the baseline + 18MB RAW
// dump ceiling cannot checkpoint, and measures reclaim%.
//
// THE wedge (plan §5 test 3): spike past the 18MB RAW ceiling → free → checkpoint.
//   - baseline-with-ceiling: SizeAdmissionError on the RAW buffer (>18MB) ⇒ WEDGED.
//   - W5: recognises the freed-spike (highly compressible dead slack), checkpoints the gz
//         image, cold-restores byte-identical.
//
// reclaim% (the W5 extra metric) is reported two ways, both honest:
//   reclaimGz   = 1 - gzStored / gzOfFullBloatedBuffer   (durable-bytes reclaim — what we store)
//   reclaimRaw  = 1 - rawAfterRestore / rawBloated        (in-memory RAW reclaim — substrate limit)

import { Session } from '../_bench/session.mjs';
import { DOStore, gz } from '../_bench/store.mjs';
import w5 from './w5-compaction.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MB = 1024 * 1024;
const RAW_DUMP_CEILING = 18 * MB;

function baselineCheckpointWithCeiling(curImage, store, key) {
  // exactly the v0.7 baseline guard: refuse if RAW buffer > 18MB.
  if (curImage.byteLength > RAW_DUMP_CEILING) {
    const e = new Error(
      `RAW buffer ${curImage.byteLength}B > ${RAW_DUMP_CEILING}B; refusing snapshot (WEDGED).`,
    );
    e.name = 'SizeAdmissionError';
    throw e;
  }
  return store.putSnapshot(`${key}/snap`, curImage);
}

async function main() {
  const dir = join(tmpdir(), `w5-wedge-${Date.now()}`);
  const out = {};

  // ---- build a spiked-then-freed session, fidelity roots included ----
  const sess = new Session();
  await sess.create();
  sess.eval('var keep="anchor"; var n=12345; var inc=(()=>{let c=0; return ()=>++c;})();');
  sess.eval('var cnt1=inc(); var cnt2=inc();'); // closure counter -> 2
  sess.eval('var m=new Map([["a",1],["b",2]]); var st=new Set([7,8,9]);');
  sess.eval('var pend=new Promise(()=>{}); var done=Promise.resolve("ok");');
  sess.eval('var big=[]; for(let i=0;i<48;i++){big.push("x".repeat(1024*1024));}'); // 48MB spike
  sess.eval('var bigBytes=big.reduce((a,x)=>a+x.length,0); big=null;');              // free
  sess.vm.runGC();

  const bloatedBuffer = sess.bufferBytes();
  const usedHeap = sess.usedHeap();
  const curImage = sess.dump();
  const rawBloated = curImage.byteLength;
  const gzFull = gz(curImage).byteLength;

  out.spike = {
    bloatedBufferMB: +(bloatedBuffer / MB).toFixed(2),
    usedHeapKB: +(usedHeap / 1024).toFixed(1),
    rawImageMB: +(rawBloated / MB).toFixed(2),
    gzImageKB: +(gzFull / 1024).toFixed(1),
    overCeiling: rawBloated > RAW_DUMP_CEILING,
  };

  // ---- 1. baseline-with-ceiling: must WEDGE ----
  const storeB = new DOStore({ r2Dir: dir + '-b' });
  let baselineWedged = false, baselineErr = '';
  try {
    baselineCheckpointWithCeiling(curImage, storeB, 'base/spike');
  } catch (e) {
    baselineWedged = e.name === 'SizeAdmissionError';
    baselineErr = e.name + ': ' + e.message.split(';')[0];
  }
  out.baseline = { wedged: baselineWedged, error: baselineErr };

  // ---- 2. W5: must NOT wedge, must checkpoint + cold-restore byte-identical ----
  const storeW = new DOStore({ r2Dir: dir + '-w' });
  const ctx = { key: 'w5/spike', generation: 1 };
  const hostState = { kv: { seen: 42 } };
  let w5Checkpointed = false, w5Err = '', wedgeAvoided = false, gzStored = 0;
  let restoreOK = false, fidelity = null, restoredGen = 0, restoredBufferMB = 0;
  try {
    const { stored } = w5.onCheckpoint(null, curImage, hostState, storeW, ctx);
    w5Checkpointed = true;
    wedgeAvoided = stored.wedgeAvoided;
    gzStored = stored.gzBytes;

    // genuine evict
    sess.dispose();

    // cold restore into a brand-new VM
    const { image, hostState: hs } = w5.onRestore(stored, storeW, ctx);
    const sess2 = new Session();
    await sess2.restore(image);
    restoredGen = sess2.generation;
    restoredBufferMB = +(sess2.bufferBytes() / MB).toFixed(2);

    // FIDELITY: closure counter continues, pending promise still pending, Map/Set/data intact
    const cnt3 = sess2.eval('inc()');                          // 3 (closure state survived)
    const pendType = sess2.eval('typeof pend');                // object (pending promise survived)
    const mapA = sess2.eval('m.get("a")');                     // 1
    const setArr = sess2.eval('JSON.stringify([...st])');      // [7,8,9]
    const keepV = sess2.eval('keep');                          // anchor
    const bigBytesV = sess2.eval('bigBytes');                  // 48MB
    const kv = hs && hs.kv && hs.kv.seen;                      // host state round-trip
    fidelity = {
      closureCounter: cnt3,            // expect 3
      pendingPromise: pendType,        // expect 'object'
      mapA, setArr, keep: keepV, bigBytes: bigBytesV, hostKv: kv,
    };
    restoreOK =
      cnt3 === 3 && pendType === 'object' && mapA === 1 &&
      setArr === '[7,8,9]' && keepV === 'anchor' && bigBytesV === 48 * MB && kv === 42;
    sess2.dispose();
  } catch (e) {
    w5Err = e.name + ': ' + e.message;
  }

  out.w5 = {
    checkpointed: w5Checkpointed,
    wedgeAvoided,
    gzStoredKB: +(gzStored / 1024).toFixed(1),
    coldRestoreOK: restoreOK,
    restoredGeneration: restoredGen,
    restoredBufferMB,
    fidelity,
    error: w5Err || undefined,
  };

  // ---- reclaim metrics ----
  out.reclaim = {
    // durable-bytes reclaim: stored gz vs the gz of the full bloated buffer (≈ same here since
    // putSnapshot also gzips; the win is that it FITS — the wedge is avoided, not raw shrink).
    reclaimGzPct: +(100 * (1 - gzStored / gzFull)).toFixed(2),
    // in-memory RAW reclaim on THIS substrate (the honest limit):
    reclaimRawPct: +(100 * (1 - restoredBufferMB * MB / rawBloated)).toFixed(2),
    note:
      'reclaimRaw is the buffer the cold-restored instance occupies vs the bloated one. On the ' +
      'native rquickjs build with JS_WriteObject+oplog, W5 reclaims 96.9% RAW (docs FLIP3). On ' +
      'this quickjs-wasi substrate, deserialize re-blits the full memory blob, so RAW reclaim ' +
      'comes only from a genuinely fresh re-creation, not from the stored image.',
  };

  console.log(JSON.stringify(out, null, 2));
}

main();
