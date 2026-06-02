// adversarial2.mjs — push the fallback HARDER.
//
// The first pass showed gz-delta stays below gz-full even at 95%+ dirty pages, because the
// changed-page payload compresses about as well as the full image, so a page-delta is a
// strict win and the valve correctly DOESN'T fire. To actually exercise the valve we must
// create the pathological regime it exists for:
//   (1) NEAR-FULL dirty coverage  AND
//   (2) overhead that makes the delta's STORED size approach/exceed the full's stored size.
//
// We demonstrate the valve two honest ways:
//   A. INCOMPRESSIBLE dense mutation — fill a large typed array with seeded pseudo-random
//      bytes (xorshift, so it's deterministic but high-entropy). The changed pages don't
//      compress, AND the index overhead (4 bytes/page) + magic push delta past fullPct.
//      Here gz-delta really can exceed fallbackPct*gz-full -> valve FIRES.
//   B. RAW-DELTA measure — report what a NAIVE strategy that stores delta pages WITHOUT
//      compressing (raw page bodies + indices) would cost. This is the classic blow-up:
//      raw changed pages == nearly the whole raw image, but the full path gzips. Shows why
//      the valve (which compares against the kernel's gz'd full) is the right guard.
//
// We sweep fallbackPct and report firing rate + worst stored vs naive.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DOStore, gz } from '../_bench/store.mjs';
import { Session } from '../_bench/session.mjs';
import { makeW4Delta } from './w4-delta.mjs';

// High-entropy dense workload: each cell refills a big typed array with seeded random bytes.
// xorshift32 seeded per round -> deterministic, incompressible, touches every page.
function wEntropy() {
  const cells = [];
  cells.push('var ta = new Uint8Array(4*1024*1024); var rounds=0; var tag=""; var seed=12345>>>0;');
  for (let r = 1; r <= 16; r++) {
    cells.push(
      `seed = (${r}*2654435761)>>>0; ` +
      `for (let i=0;i<ta.length;i++){ seed ^= seed<<13; seed>>>=0; seed ^= seed>>>17; seed ^= seed<<5; seed>>>=0; ta[i]=seed & 0xff; } ` +
      `rounds=${r}; tag="e"+${r};`
    );
  }
  return {
    name: 'W-entropy',
    cells,
    check: 'JSON.stringify({rounds, tag, len: ta.length})',
    expected: JSON.stringify({ rounds: 16, tag: 'e16', len: 4 * 1024 * 1024 }),
    evictAfter: 9,
  };
}

async function driveWorkload(strategy, workload, store) {
  store.resetCounters();
  const key = `${strategy.name}/${workload.name}`;
  const ctx = { key, generation: 0 };
  const sess = new Session();
  await sess.create();

  let prevImage = null, peakImage = 0, restoreMs = 0, lastStored = null, hostState = {};
  let worstStoredBytes = 0, worstRatio = 0, sumStored = 0, sumFullEquiv = 0;
  // also track the NAIVE-RAW-DELTA hypothetical cost per ckpt (raw changed bytes, no gz)
  let naiveRawSum = 0, naiveRawWorst = 0;

  const PAGE = strategy._config.pageSize;

  const checkpoint = () => {
    const img = sess.dump();
    if (img.byteLength > peakImage) peakImage = img.byteLength;
    ctx.generation++;
    // measure naive-raw-delta size (raw dirty page bytes + 4B/page index) vs prevImage
    if (prevImage) {
      const nPages = Math.ceil(img.byteLength / PAGE);
      let raw = 0;
      for (let p = 0; p < nPages; p++) {
        const start = p * PAGE, end = Math.min(start + PAGE, img.byteLength);
        let same = false;
        if (start < prevImage.byteLength) {
          const pEnd = Math.min(start + PAGE, prevImage.byteLength);
          if (pEnd - start === end - start) {
            same = true;
            for (let i = start; i < end; i++) if (prevImage[i] !== img[i]) { same = false; break; }
          }
        }
        if (!same) raw += (end - start) + 4;
      }
      naiveRawSum += raw; if (raw > naiveRawWorst) naiveRawWorst = raw;
    }
    const before = store.stats().bytesWritten;
    const { stored } = strategy.onCheckpoint(prevImage, img, hostState, store, ctx);
    const written = store.stats().bytesWritten - before;
    const fullEquiv = gz(img).byteLength;
    sumStored += written; sumFullEquiv += fullEquiv;
    if (written > worstStoredBytes) worstStoredBytes = written;
    const ratio = written / Math.max(1, fullEquiv);
    if (ratio > worstRatio) worstRatio = ratio;
    lastStored = stored; prevImage = img;
  };

  for (let i = 0; i < workload.cells.length; i++) {
    sess.eval(workload.cells[i]);
    checkpoint();
    if (i + 1 === workload.evictAfter) {
      sess.dispose(); hostState = null; prevImage = null;
      const t0 = performance.now();
      const { image, hostState: hs } = strategy.onRestore(lastStored, store, ctx);
      await sess.restore(image);
      restoreMs = performance.now() - t0;
      hostState = hs ?? {}; prevImage = image;
    }
  }
  let got = null, fidelityPass = false;
  try { got = sess.eval(workload.check); fidelityPass = got === workload.expected; }
  catch (e) { got = 'ERR:' + e.message; }
  sess.dispose();
  return {
    bytesWritten: store.stats().bytesWritten, worstStoredBytes, worstRatio,
    sumStored, sumFullEquiv, restoreMs, peakImage, fidelityPass,
    naiveRawSum, naiveRawWorst, got: fidelityPass ? undefined : { got, expected: workload.expected },
  };
}

function fmt(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

async function main() {
  const wl = wEntropy();
  const store = new DOStore({ r2Dir: join(tmpdir(), `w4-adv2-${Date.now()}`) });
  console.log('=== W4 fallback: HIGH-ENTROPY dense mutation (incompressible) ===');
  console.log(`workload ${wl.name}: cells=${wl.cells.length}, ta=4MB random refill/cell, evictAfter=${wl.evictAfter}\n`);

  const PCTS = [0.5, 0.7, 0.8, 0.9, 0.95, 1.0, 1.1];
  console.log(['fbPct', 'ckpts', 'fb', 'deltas', 'bases', 'fbRate', 'bytesWritten', 'worstStored', 'worstVsFullGz', 'fidelity'].join('\t'));

  let naiveRes = null;
  for (const pct of PCTS) {
    const strat = makeW4Delta({ fallbackPct: pct });
    strat.name = `fb${Math.round(pct * 100)}`;
    const res = await driveWorkload(strat, wl, store);
    if (pct >= 1.1) naiveRes = res; // 1.1x ~= never-fallback (delta always <= 1.1*full holds)
    const t = strat._tele;
    const rate = (t.fallbacks / Math.max(1, t.deltas + t.fallbacks)) * 100;
    console.log([
      pct.toFixed(2), t.checkpoints, t.fallbacks, t.deltas, t.bases,
      rate.toFixed(0) + '%', fmt(res.bytesWritten), fmt(res.worstStoredBytes),
      res.worstRatio.toFixed(3) + 'x', res.fidelityPass ? 'PASS' : 'FAIL',
    ].join('\t'));
  }

  // explicit naive-always-delta (fallbackPct=Infinity) for the blow-up comparison
  const naive = makeW4Delta({ fallbackPct: Infinity }); naive.name = 'naive';
  const nr = await driveWorkload(naive, wl, store);
  // always-full
  const af = makeW4Delta({ fallbackPct: 0 }); af.name = 'full';
  const fr = await driveWorkload(af, wl, store);

  console.log('\n--- blow-up comparison ---');
  console.log(`naive-always-delta (gz pages, never falls back): bytesWritten=${fmt(nr.bytesWritten)} worstStored=${fmt(nr.worstStoredBytes)} worstVsFullGz=${nr.worstRatio.toFixed(3)}x`);
  console.log(`always-full                                     : bytesWritten=${fmt(fr.bytesWritten)} worstStored=${fmt(fr.worstStoredBytes)}`);
  console.log(`NAIVE-RAW-DELTA hypothetical (raw pages, no gz) : sum=${fmt(nr.naiveRawSum)} worst=${fmt(nr.naiveRawWorst)}  <-- classic blow-up if pages stored raw`);
  console.log(`  (a full gz store per ckpt would be ~${fmt(fr.worstStoredBytes)}; raw-delta worst ${fmt(nr.naiveRawWorst)} = ${(nr.naiveRawWorst / Math.max(1, fr.worstStoredBytes)).toFixed(1)}x the full store)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
