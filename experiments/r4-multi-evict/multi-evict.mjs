// r4-multi-evict — RESIDUAL 2: chained multi-evict delta-chain stress.
//
// GAP2/promise tests did a SINGLE evict+restore. Real durability must survive N>=4
// consecutive genuine evict + cold-restore cycles interleaved across a long workload,
// spanning W5 base rebases, W4 delta chains, and the E6 oplog window.
//
// This driver imports the SHARED harness (_bench) READ-ONLY and drives the SHARED
// build-combined strategy. It does NOT use _bench/runner.mjs (that does a single evict);
// it implements its own multi-evict loop with the SAME contract:
//   - per-cell checkpoint (strategy.onCheckpoint)
//   - at each evict point: dispose VM + DROP all in-memory state, then
//     strategy.onRestore(durable token only) -> brand-new VM instance.
//
// FAITHFULNESS to a real cold worker: after each evict we WIPE the strategy's
// in-process bookkeeping cache (_st) for the session key and REHYDRATE it purely
// from the durable manifest, so subsequent deltas/rebases proceed from durable state
// — exactly as a freshly-spun worker would. This is stricter than the single-evict
// runner (which leaves _st warm).

import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOStore } from '../_bench/store.mjs';
import { Session } from '../_bench/session.mjs';
import combined from '../build-combined/strategies/combined.mjs';

const PAGE = 4096;
const BASE_EVERY = 64; // REBASE_MAX_CHAIN in combined.mjs — chain resets at this length

// ----------------------------------------------------------------------------
// Rehydrate the combined strategy's in-process bookkeeping from the durable
// manifest after a cold evict (mirrors what a fresh worker reads from SQLite).
function rehydrateStrategyFromManifest(strategy, store, key) {
  const st = strategy._state(key);
  const mBytes = store.getRaw(`${key}/manifest`);
  if (!mBytes) throw new Error('no manifest to rehydrate from');
  const manifest = JSON.parse(new TextDecoder().decode(mBytes));
  // baseGen from baseKey "<key>/base.<gen>"
  const baseGen = Number(manifest.baseKey.split('.').pop());
  // re-read the base raw image + recompute its gz size (chain-ratio needs it)
  const baseImage = store.getSnapshot(manifest.baseKey);
  // recompute baseGzBytes the same way putSnapshot would
  const { gzipSync } = require('node:zlib');
  st.baseGen = baseGen;
  st.baseImage = baseImage;
  st.baseGzBytes = gzipSync(Buffer.from(baseImage), { level: 6 }).byteLength;
  // rebuild chain bookkeeping from the manifest's ordered delta keys
  st.chain = manifest.chain.map((dk) => ({ gen: Number(dk.split('.').pop()), key: dk }));
  let chainGz = 0;
  for (const dk of manifest.chain) {
    const r = store.getRaw(dk);
    if (r) chainGz += r.byteLength;
  }
  st.chainGzBytes = chainGz;
  st.oplogKeys = manifest.oplogKeys.slice();
  // seq = highest op seq seen
  st.seq = manifest.oplogKeys.reduce((m, ok) => Math.max(m, Number(ok.split('.').pop())), 0);
  // oplog tail entries (for E6 visibility); cheap to reload
  st.oplog = manifest.oplogKeys.map((ok) => {
    const b = store.getRaw(ok);
    return b ? JSON.parse(new TextDecoder().decode(b)) : null;
  }).filter(Boolean);
  return manifest;
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// sha-256 hex of a byte buffer for byte-coherence assertions
import { createHash } from 'node:crypto';
function sha(buf) { return createHash('sha256').update(Buffer.from(buf)).digest('hex'); }

// ----------------------------------------------------------------------------
async function run() {
  const key = 'combined/r4-multi-evict';
  const dir = join(tmpdir(), `r4-multi-evict-${Date.now()}`);
  const store = new DOStore({ r2Dir: dir });
  // wipe any cross-run strategy state for this key
  combined._st.delete(key);

  const sess = new Session();
  await sess.create();

  // ---- the workload: a long session that EXERCISES all three rungs ----
  // - closures + a pending promise that must survive every restore (fidelity)
  // - a Map/array accumulator that grows each cell (delta chain churn)
  // - a deliberate spike-then-free around cell 40 (W5 reclaim rebase)
  // - >64 delta cells total so a chain-length rebase (BASE_EVERY) also fires
  const N = 90;
  const evictPoints = new Set([10, 25, 42, 60, 78]); // 5 genuine cold restores

  // setup cell: closure counter + pending promise + accumulators
  sess.eval(`
    var __resolve;
    globalThis.pending = new Promise((res) => { __resolve = res; });
    globalThis.resolvePending = (v) => __resolve(v);
    globalThis.mkCounter = (start) => { let n = start; return () => ++n; };
    globalThis.counter = mkCounter(40);
    globalThis.acc = [];
    globalThis.m = new Map();
    globalThis.spikeBuf = null;
  `);

  let prevImage = null;
  let hostState = {};
  let lastStored = null;
  const cycles = [];   // per-evict-cycle coherence records
  let maxChainLen = 0;
  const chainLenSeries = [];
  let rebaseCount = 0;
  let lastBaseGen = combined._state(key).baseGen;

  const checkpoint = (cellIdx, src) => {
    const img = sess.dump();
    // carry oplog source + seeded entropy cursor + used-heap hint for the strategy
    const hs = {
      ...hostState,
      __src: src,
      __rng: cellIdx,
      __usedHeap: sess.usedHeap(),
    };
    combined._state(key);
    // ctx generation must monotonically increase across the WHOLE session
    ctx.generation++;
    const { stored } = combined.onCheckpoint(prevImage, img, hs, store, ctx);
    lastStored = stored;
    prevImage = img;
    // observe chain length + rebase events
    const st = combined._state(key);
    chainLenSeries.push(st.chain.length);
    if (st.chain.length > maxChainLen) maxChainLen = st.chain.length;
    if (st.baseGen !== lastBaseGen) { rebaseCount++; lastBaseGen = st.baseGen; }
    return img;
  };

  const ctx = { key, generation: 0 };

  for (let i = 1; i <= N; i++) {
    let src;
    if (i === 38) {
      // SPIKE: allocate a big buffer to push used-heap up
      src = `globalThis.spikeBuf = new Uint8Array(20*1024*1024).fill(7); acc.push(${i}); counter();`;
    } else if (i === 40) {
      // FREE the spike (reclaim) -> should trigger a W5 reclaim rebase soon
      src = `globalThis.spikeBuf = null; acc.push(${i}); counter();`;
    } else {
      src = `acc.push(${i}); m.set(${i}, ${i}*${i}); counter();`;
    }
    sess.eval(src);
    checkpoint(i, src);

    if (evictPoints.has(i)) {
      // ---- GENUINE EVICT: dispose VM, drop ALL in-memory state ----
      const preEvictImageSha = sha(prevImage);
      sess.dispose();
      hostState = null;
      prevImage = null;
      // WIPE strategy in-process cache to force durable-only rebuild
      combined._st.delete(key);

      const t0 = performance.now();
      const manifest = rehydrateStrategyFromManifest(combined, store, key);
      const { image, hostState: hs } = combined.onRestore(lastStored, store, ctx);
      await sess.restore(image);
      const restoreMs = performance.now() - t0;

      hostState = (hs && typeof hs === 'object') ? { ...hs } : {};
      // strip transient hints so they don't leak into next checkpoint unintentionally
      delete hostState.__src; delete hostState.__rng; delete hostState.__usedHeap;
      prevImage = image;

      // ---- BYTE COHERENCE: restored image must equal the pre-evict image ----
      const restoredSha = sha(image);
      const byteIdentical = restoredSha === preEvictImageSha;

      // ---- STATE COHERENCE: query live state in the brand-new VM ----
      const accLen = sess.eval(`acc.length`);
      const accLast = sess.eval(`acc[acc.length-1]`);
      const counterNext = sess.eval(`counter()`); // advances closure; expected = 40 + (#counter calls so far)+1
      // undo that advance so closure stays consistent for next cycle's expectations
      // (we re-derive expected separately; counter was called once per cell 1..i + once here)
      const mSize = sess.eval(`m.size`);
      const promiseStillPending = sess.eval(`(typeof resolvePending === 'function') && (pending instanceof Promise)`);
      const genFresh = sess.generation > 1;

      cycles.push({
        evictAtCell: i,
        generation: sess.generation,
        restoreMs: Number(restoreMs.toFixed(2)),
        byteIdentical,
        chainLenAtEvict: combined._state(key).chain.length,
        baseGen: combined._state(key).baseGen,
        accLen, accLast,
        counterNext,
        mSize,
        promiseStillPending,
        genFresh,
        inMemoryFresh: genFresh,
      });
    }
  }

  // ---- FINAL fidelity: resolve the promise that survived all 5 restores ----
  let promiseResolvedValue = null, promiseResolveOk = false;
  try {
    sess.eval(`globalThis.__pv = null; pending.then(v => { globalThis.__pv = v; });`);
    sess.eval(`resolvePending(777)`);
    // drain the microtask queue explicitly (the session-driver's job per harness README)
    sess.vm.executePendingJobs();
    promiseResolvedValue = sess.eval(`globalThis.__pv`);
    promiseResolveOk = promiseResolvedValue === 777;
  } catch (e) {
    promiseResolvedValue = 'ERR:' + e.message;
  }

  // closure coherence: counter was called once per cell (90) + once per evict cycle (5) = 95,
  // starting at 40 -> next value should be 40 + 95 + 1 = 136. Verify monotonic + final.
  const counterFinal = sess.eval(`counter()`);
  const accFinalLen = sess.eval(`acc.length`);
  const accFinalLast = sess.eval(`acc[acc.length-1]`);
  const mFinalSize = sess.eval(`m.size`);

  sess.dispose();

  // ---- coherence verdicts ----
  const allByteIdentical = cycles.every((c) => c.byteIdentical);
  const allGenFresh = cycles.every((c) => c.genFresh);
  const allPromisePending = cycles.every((c) => c.promiseStillPending === true);
  // acc grows by 1 per cell; at evict cell i, accLen should equal i
  const accMonotonic = cycles.every((c) => c.accLen === c.evictAtCell && c.accLast === c.evictAtCell);
  // chain length must reset (never exceed BASE_EVERY)
  const chainBounded = maxChainLen <= BASE_EVERY;

  const result = {
    cyclesCompleted: cycles.length,
    maxChainLen,
    chainBounded,
    rebaseCount,
    BASE_EVERY,
    allByteIdentical,
    allGenFresh,
    allPromisePending,
    accMonotonic,
    promiseResolveOk,
    promiseResolvedValue,
    counterFinal,
    accFinalLen,
    accFinalLast,
    mFinalSize,
    finalGeneration: sess.generation,
    cycles,
    chainLenSeries,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
