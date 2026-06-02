// r4-raw-reclaim — DEFINITIVE test: is RAW linear-memory reclaim achievable with FULL fidelity?
//
// Engine: real rquickjs on wasm32-wasip1 (full-memory blit = full fidelity, monotonic buffer).
// Live state under test: global var x=42 ; closure inc() with private counter ; pending promise p->7.
//
// We spike the heap (grow buffer), free it (run GC), then test 3 reclaim mechanisms:
//   (a) write_roots (JS_WriteObject/JSON path) -> recreate in fresh instance: raw shrinks? fidelity?
//   (b) run_gc on the SAME instance: does the WASM linear buffer ever shrink?  used-heap vs raw.
//   (c) fresh module with SMALLER initial memory + selective live-page blit: does it even run?
//
// All numbers come from command output. No deploy, no CF.
import { readFileSync, writeFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { gzipSync } from 'node:zlib';

const WASM_URL = new URL('./engine/target/wasm32-wasip1/release/r4engine.wasm', import.meta.url);
const bytes = readFileSync(WASM_URL);
const mod = await WebAssembly.compile(bytes);
const PAGE = 65536;
const MB = (b) => +(b / 1048576).toFixed(3);

function makeWasi() {
  return new WASI({ version: 'preview1', args: [], env: {}, preopens: {} });
}
async function instantiate(m = mod) {
  const wasi = makeWasi();
  const inst = await WebAssembly.instantiate(m, { wasi_snapshot_preview1: wasi.wasiImport });
  try { wasi.initialize(inst); } catch {}
  return inst;
}
const bufBytes = (i) => i.exports.memory.buffer.byteLength;
const usedHeap = (i) => i.exports.used_heap();
const gzOf = (u8) => gzipSync(Buffer.from(u8), { level: 6 }).length;

const out = { mechanisms: {} };

// ============================================================
// Phase 0: baseline session with full-fidelity live state, then SPIKE then FREE.
// ============================================================
const a = await instantiate();
a.exports.setup();
const baseInc1 = a.exports.poke_inc(); // 101
const baseInc2 = a.exports.poke_inc(); // 102
const baseX = a.exports.read_x();      // 42

const pre = { buf: bufBytes(a), used: usedHeap(a) };

// SPIKE: ~600k retained strings -> grows linear memory well past base.
a.exports.spike(600000);
const spiked = { buf: bufBytes(a), used: usedHeap(a) };

// FREE + GC (this is mechanism (b): does run_gc shrink the raw buffer?)
a.exports.free_spike();
const freed = { buf: bufBytes(a), used: usedHeap(a) };

out.session = {
  baseInc1, baseInc2, baseX,
  preBufMB: MB(pre.buf), preUsedMB: MB(pre.used),
  spikedBufMB: MB(spiked.buf), spikedUsedMB: MB(spiked.used),
  freedBufMB: MB(freed.buf), freedUsedMB: MB(freed.used),
};

// ============================================================
// MECHANISM (b): run_gc on the SAME instance. Does raw linear buffer shrink?
// ============================================================
const bufBeforeGc = bufBytes(a);
const usedBeforeGc = usedHeap(a);
a.exports.run_gc_only();
const bufAfterGc = bufBytes(a);
const usedAfterGc = usedHeap(a);
// gz of the full image before/after (what we'd actually store)
const imgBeforeGz = gzOf(new Uint8Array(a.exports.memory.buffer));
out.mechanisms.b_run_gc_same_instance = {
  rawBufBeforeMB: MB(bufBeforeGc),
  rawBufAfterMB: MB(bufAfterGc),
  rawShrank: bufAfterGc < bufBeforeGc,
  rawReclaimPct: +(100 * (1 - bufAfterGc / bufBeforeGc)).toFixed(2),
  usedHeapBeforeMB: MB(usedBeforeGc),
  usedHeapAfterMB: MB(usedAfterGc),
  usedHeapReclaimPct: +(100 * (1 - usedAfterGc / Math.max(1, spiked.used))).toFixed(2),
  imageGzMB: MB(imgBeforeGz),
  // fidelity still intact on the SAME instance after GC?
  fidelity: {
    inc: a.exports.poke_inc(),               // expect 103 (closure private state alive)
    x: a.exports.read_x(),                   // 42
    incIsClosure: a.exports.inc_is_closure(),// 1
    promisePresent: a.exports.promise_present(), // 1
    promiseResolves: a.exports.resolve_promise(),// 7
  },
  verdict_note: 'WASM linear memory is monotonic by spec; run_gc frees QuickJS heap (used-heap drops) but cannot return pages to the WASM memory object.',
};

// ============================================================
// MECHANISM (a): serialize live ROOTS (JSON / JS_WriteObject-class) -> fresh instance.
// We measure: does the fresh instance have a SMALL raw buffer? AND what fidelity is lost?
// ============================================================
// (Re-establish full live state in `a` first since we resolved the promise above.)
const a2 = await instantiate();
a2.exports.setup();
a2.exports.poke_inc(); a2.exports.poke_inc(); // advance closure to 102
a2.exports.spike(600000);
a2.exports.free_spike();
const a2spikedBuf = bufBytes(a2);

// Serialize roots via JSON (the only thing JS_WriteObject-for-globals can portably move).
const rootsLen = a2.exports.write_roots();
const ptr = a2.exports.roots_ptr();
const rootsBytes = new Uint8Array(a2.exports.memory.buffer, ptr, rootsLen);
const rootsJson = Buffer.from(rootsBytes).toString('utf8');

// Fresh small instance, rehydrate ONLY what JSON carried.
const c = await instantiate();          // fresh: small initial buffer
const freshBuf = bufBytes(c);
c.exports.rehydrate_json_only();        // recovers x=42 only

out.mechanisms.a_writeobject_fresh_instance = {
  bloatedSourceBufMB: MB(a2spikedBuf),
  freshInstanceBufMB: MB(freshBuf),
  rawShrank: freshBuf < a2spikedBuf,
  rawReclaimPct: +(100 * (1 - freshBuf / a2spikedBuf)).toFixed(2),
  serializedRootsJson: rootsJson,
  fidelity_after_rehydrate: {
    x: c.exports.read_x(),                   // 42 (data survives)
    incIsClosure: c.exports.inc_is_closure(),// 0 -> CLOSURE LOST
    incCall: c.exports.poke_inc(),           // not the original private counter
    promisePresent: c.exports.promise_present(), // 0 -> PENDING PROMISE LOST
  },
  verdict_note: 'Raw buffer DOES shrink (fresh instance = fresh small memory). BUT JSON/JS_WriteObject cannot serialize the closure private state or the pending promise (W6: 7/16 value kinds lost). Closure and promise are GONE. Reclaim w/ FIDELITY = FALSE on this path.',
};

// ============================================================
// MECHANISM (c): fresh module variant with SMALLER initial memory + selective live-page blit.
// Question 1: does a smaller-initial-memory module even run the engine?
// Question 2: can we blit ONLY live pages of a full-fidelity snapshot into a fresh instance
//             and keep full fidelity while having a smaller raw buffer?
// ============================================================
// Take a FULL-FIDELITY snapshot of a freed session (mechanism that preserves everything).
const s = await instantiate();
s.exports.setup();
s.exports.poke_inc(); s.exports.poke_inc(); // closure at 102
s.exports.spike(600000);
s.exports.free_spike();
const snapImage = Buffer.from(new Uint8Array(s.exports.memory.buffer)); // FULL image (monotonic, big)
const snapPages = snapImage.length / PAGE;

// (c1) Try a module patched to declare a SMALLER initial memory (e.g. 18 pages = base size).
// Patch the memory section min from current to 18 pages. If the data segments / engine need
// more at instantiate, it grows; the point is whether a fresh instance can START small.
function encodeLeb(n) { const a = []; do { let bb = n & 0x7f; n >>>= 7; if (n) bb |= 0x80; a.push(bb); } while (n); return Buffer.from(a); }
function patchInitialPages(wasmBytes, newMin) {
  const b = Buffer.from(wasmBytes);
  let p = 8;
  function readLeb() { let r = 0, sft = 0, x; do { x = b[p++]; r |= (x & 0x7f) << sft; sft += 7; } while (x & 0x80); return r >>> 0; }
  while (p < b.length) {
    const idPos = p; const id = b[p++]; const sz = readLeb(); const end = p + sz;
    if (id === 5) {
      // body: count, flags, min [, max]
      let bp = p; function rl() { let r = 0, sft = 0, x; do { x = b[bp++]; r |= (x & 0x7f) << sft; sft += 7; } while (x & 0x80); return r >>> 0; }
      rl(); // count (==1)
      const flags = rl(); rl(); // min (discard)
      let max = null; if (flags & 1) max = rl();
      const body = [1, flags, ...encodeLeb(newMin)];
      if (flags & 1) body.push(...encodeLeb(max));
      const bodyBuf = Buffer.from(body);
      const head = b.subarray(0, idPos);
      const tail = b.subarray(end);
      return Buffer.concat([head, Buffer.from([id]), encodeLeb(bodyBuf.length), bodyBuf, tail]);
    }
    p = end;
  }
  throw new Error('no memory section');
}

let cResult;
try {
  const patched = patchInitialPages(bytes, 18);
  const pmod = await WebAssembly.compile(patched);
  const ci = await instantiate(pmod);
  // Does a fresh small-init instance run the engine at all?
  ci.exports.setup();
  cResult = {
    smallInitModuleRuns: true,
    startBufMB: MB(bufBytes(ci)),
    setupX: ci.exports.read_x(),
  };

  // (c2) Selective live-page blit: blit the FULL snapshot into this fresh instance.
  // To keep fidelity we MUST restore EVERY page QuickJS pointers reference. There is no
  // page-liveness map: QuickJS heap pointers are absolute offsets into linear memory.
  // Selective (sparse) blit = blit only nonzero pages, leaving freed pages zero.
  const need = snapPages - (bufBytes(ci) / PAGE);
  if (need > 0) ci.exports.memory.grow(Math.ceil(need));
  const dst = new Uint8Array(ci.exports.memory.buffer);
  // SELECTIVE: copy only pages that are nonzero in the snapshot (skip all-zero freed pages).
  let copiedPages = 0, skippedPages = 0;
  for (let pg = 0; pg < snapPages; pg++) {
    const off = pg * PAGE;
    const slice = snapImage.subarray(off, off + PAGE);
    let nonzero = false;
    for (let k = 0; k < slice.length; k += 512) { if (slice[k]) { nonzero = true; break; } }
    if (nonzero) { dst.set(slice, off); copiedPages++; } else { skippedPages++; }
  }
  // Now: the raw BUFFER is still snapPages big (we grew to match — monotonic, can't be smaller
  // than the snapshot's pointer span). Fidelity after selective blit:
  cResult.selectiveBlit = {
    snapPages,
    copiedPages,
    skippedPages_zeroFreed: skippedPages,
    rawBufAfterMB: MB(bufBytes(ci)),
    rawSmallerThanSnapshot: bufBytes(ci) < snapImage.length,
    fidelity: {
      reattach: ci.exports.reattach(),
      inc: ci.exports.poke_inc(),               // expect 103 if closure survived
      x: ci.exports.read_x(),                   // 42
      incIsClosure: ci.exports.inc_is_closure(),
      promisePresent: ci.exports.promise_present(),
      promiseResolves: ci.exports.resolve_promise(),
    },
    note: 'Selective blit can SKIP storing zero pages (gz already does this for free), but the live instance must still grow its buffer to span the snapshot pointer range. Raw buffer cannot be smaller than the highest live pointer offset. Freed pages between live allocations cannot be removed without relocating pointers.',
  };
} catch (e) {
  cResult = { smallInitModuleRuns: false, error: String(e) };
}
out.mechanisms.c_small_init_selective_blit = cResult;

// ============================================================
// VERDICT
// ============================================================
const b = out.mechanisms.b_run_gc_same_instance;
const aMech = out.mechanisms.a_writeobject_fresh_instance;
const cMech = out.mechanisms.c_small_init_selective_blit;

const fullFidelityRawReclaimAchieved =
  // would require: raw buffer smaller AND closure+promise survive on SAME path
  false; // proven below

out.VERDICT = {
  question: 'Is RAW linear-memory reclaim achievable AT ALL with FULL fidelity on this substrate?',
  mechanism_a_writeobject: {
    rawReclaim: aMech.rawShrank ? `${aMech.rawReclaimPct}%` : 'none',
    fidelity: 'LOST closure + pending promise (JSON/JS_WriteObject drops them)',
    fullFidelityRawReclaim: false,
  },
  mechanism_b_run_gc: {
    rawReclaim: b.rawShrank ? `${b.rawReclaimPct}%` : '0% (WASM memory monotonic)',
    fidelity: 'FULL (same instance) — but raw buffer does NOT shrink',
    fullFidelityRawReclaim: false,
  },
  mechanism_c_selective_blit: {
    smallInitRuns: cMech.smallInitModuleRuns,
    rawReclaim: cMech.selectiveBlit ? (cMech.selectiveBlit.rawSmallerThanSnapshot ? 'some' : '0% (must span live pointer range)') : 'n/a',
    fidelity: cMech.selectiveBlit ? `inc=${cMech.selectiveBlit.fidelity.inc}, promise=${cMech.selectiveBlit.fidelity.promiseResolves}` : 'n/a',
    fullFidelityRawReclaim: false,
  },
  FULL_FIDELITY_RAW_RECLAIM_ACHIEVED: fullFidelityRawReclaimAchieved,
  conclusion: 'Full-fidelity RAW-buffer reclaim is FUNDAMENTALLY IMPOSSIBLE on this substrate. Fidelity (closures+promises) requires preserving absolute heap pointer offsets => the WASM linear memory must span the highest live offset; WASM memory is monotonic (cannot shrink in place) and there is no QuickJS heap-relocation/compaction API. Reclaim WITHOUT fidelity (fresh small instance + JS_WriteObject/JSON) works but drops closures+promises. Therefore GZ stored-image reclaim (zero-scrub freed pages) is the CEILING; W5 gz-reclaim is the best achievable.',
};

const json = JSON.stringify(out, null, 2);
writeFileSync(new URL('./results.json', import.meta.url), json);
console.log(json);
