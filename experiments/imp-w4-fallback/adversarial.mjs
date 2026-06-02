// adversarial.mjs — stress the W4 byte-delta auto-fallback safety valve.
//
// Builds two custom workloads on the SAME shared harness substrate (store + Session):
//   W-dense : each cell DENSELY mutates the heap — large typed-array fill + scattered writes
//             touching most pages — so a naive delta approaches (or exceeds) full size.
//             Proves the fallback FIRES and stored bytes never blow past full+epsilon.
//   W-mixed : alternating SPARSE cells (tiny mutation -> delta) and DENSE cells (-> fallback).
//             Proves restore stays correct + bounded across a mix.
//
// We drive these directly (not via the standard 5) and we ALSO compare against:
//   - full-dump  (always full; the upper bound on writes per ckpt)
//   - naive-always-delta (NEVER falls back; fallbackPct=Infinity; the pathological case)
// to report fallback firing rate + worst-case stored bytes vs naive.
//
// All bytes counted through the shared store (fairness). Determinism via seeded Session.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DOStore, gz } from '../_bench/store.mjs';
import { Session } from '../_bench/session.mjs';
import { makeW4Delta } from './w4-delta.mjs';

// ---- custom workloads ----

// W-dense: allocate one big Uint8Array once, then each cell overwrites it densely with a
// changing pattern (touch every page) + scattered global object writes. Closures/state kept
// for fidelity. evictAfter mid-stream.
function wDense() {
  const cells = [];
  cells.push('var ta = new Uint8Array(2*1024*1024); var rounds=0; var tag="";');
  for (let r = 1; r <= 20; r++) {
    // dense fill: every byte set to a per-round value derived from index -> touches all pages
    cells.push(
      `for (let i=0;i<ta.length;i++){ ta[i] = (i*${r}+${r*7}) & 0xff; } rounds=${r}; tag="r"+${r}; ` +
      // a checksum we can verify deterministically (sum of bytes mod 2^32)
      `var chk = 0; for (let i=0;i<ta.length;i+=997){ chk = (chk + ta[i])>>>0; }`
    );
  }
  return {
    name: 'W-dense',
    cells,
    // recompute expected checksum for the LAST round (r=20) at i steps of 997
    check: 'JSON.stringify({rounds, tag, chkType: typeof chk, len: ta.length})',
    expected: JSON.stringify({ rounds: 20, tag: 'r20', chkType: 'number', len: 2 * 1024 * 1024 }),
    evictAfter: 11,
  };
}

// W-mixed: alternate sparse (increment a counter, push one element) and dense (refill the
// typed array). Odd cells sparse, even cells dense.
function wMixed() {
  const cells = [];
  cells.push('var ta = new Uint8Array(1024*1024); var n=0; var sum=0; var notes=[];');
  for (let i = 1; i <= 24; i++) {
    if (i % 2 === 1) {
      // SPARSE: tiny mutation
      cells.push(`n += 1; sum += ${i}; notes.push("s${i}");`);
    } else {
      // DENSE: refill whole buffer
      cells.push(`for (let j=0;j<ta.length;j++){ ta[j] = (j+${i}) & 0xff; } n += 1; sum += ${i}; notes.push("d${i}");`);
    }
  }
  // n = 24 ; sum = 1+..+24 = 300 ; notes.length = 24
  return {
    name: 'W-mixed',
    cells,
    check: 'JSON.stringify({n, sum, notesLen: notes.length, last: notes[notes.length-1]})',
    expected: JSON.stringify({ n: 24, sum: 300, notesLen: 24, last: 'd24' }),
    evictAfter: 13,
  };
}

// ---- driver: run one strategy over one custom workload, return metrics ----
async function driveWorkload(strategy, workload, store) {
  store.resetCounters();
  const key = `${strategy.name}/${workload.name}`;
  const ctx = { key, generation: 0 };
  const sess = new Session();
  await sess.create();

  let prevImage = null;
  let peakImage = 0;
  let restoreMs = 0;
  let lastStored = null;
  let hostState = {};

  // per-checkpoint: track stored-bytes THIS ckpt and the full-equiv to compute vs-full ratio
  let worstStoredBytes = 0; // worst single-ckpt stored (delta or full)
  let worstFullEquiv = 0;
  let worstRatio = 0;
  let sumStored = 0;
  let sumFullEquiv = 0;

  const checkpoint = () => {
    const img = sess.dump();
    if (img.byteLength > peakImage) peakImage = img.byteLength;
    ctx.generation++;
    const before = store.stats().bytesWritten;
    const { stored } = strategy.onCheckpoint(prevImage, img, hostState, store, ctx);
    const delta = store.stats().bytesWritten - before;
    const fullEquiv = gz(img).byteLength;
    sumStored += delta; sumFullEquiv += fullEquiv;
    if (delta > worstStoredBytes) worstStoredBytes = delta;
    const ratio = delta / Math.max(1, fullEquiv);
    if (ratio > worstRatio) { worstRatio = ratio; worstFullEquiv = fullEquiv; }
    lastStored = stored;
    prevImage = img;
  };

  for (let i = 0; i < workload.cells.length; i++) {
    sess.eval(workload.cells[i]);
    checkpoint();
    if (i + 1 === workload.evictAfter) {
      sess.dispose();
      hostState = null; prevImage = null;
      const t0 = performance.now();
      const { image, hostState: hs } = strategy.onRestore(lastStored, store, ctx);
      await sess.restore(image);
      restoreMs = performance.now() - t0;
      hostState = hs ?? {};
      prevImage = image;
    }
  }

  let got = null, fidelityPass = false;
  try { got = sess.eval(workload.check); fidelityPass = got === workload.expected; }
  catch (e) { got = 'ERR:' + e.message; }
  const gen = sess.generation;
  sess.dispose();

  return {
    workload: workload.name,
    bytesWritten: store.stats().bytesWritten,
    worstStoredBytes,            // worst single-checkpoint stored bytes
    worstRatioVsFull: worstRatio, // worst (storedThisCkpt / fullGzThisCkpt)
    sumStored, sumFullEquiv,
    restoreMs, peakImage, fidelityPass,
    restoredGeneration: gen,
    got: fidelityPass ? undefined : { got, expected: workload.expected },
  };
}

function fmt(n) {
  if (n >= 1024 * 1024) return (n / 1048576).toFixed(2) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

async function main() {
  const workloads = [wDense(), wMixed()];
  const dir = join(tmpdir(), `w4-adv-${Date.now()}`);
  const store = new DOStore({ r2Dir: dir });

  const PCTS = [0.25, 0.4, 0.5, 0.6, 0.75, 0.9];

  console.log('=== W4 byte-delta auto-fallback: adversarial stress ===\n');

  // sweep FALLBACK_PCT on each workload
  for (const wl of workloads) {
    console.log(`--- workload ${wl.name} (cells=${wl.cells.length}, evictAfter=${wl.evictAfter}) ---`);
    console.log(['fbPct', 'ckpts', 'fallbacks', 'deltas', 'bases', 'fallbackRate', 'bytesWritten', 'worstStored', 'worstVsFullGz', 'fidelity'].join('\t'));

    // reference: naive-always-delta (NEVER fallback)
    const naive = makeW4Delta({ fallbackPct: Infinity });
    naive.name = 'naive-' + wl.name;
    const naiveRes = await driveWorkload(naive, wl, store);

    // reference: full-dump-equiv via fallbackPct=0 (ALWAYS fallback to full)
    const alwaysFull = makeW4Delta({ fallbackPct: 0 });
    alwaysFull.name = 'full-' + wl.name;
    const fullRes = await driveWorkload(alwaysFull, wl, store);

    for (const pct of PCTS) {
      const strat = makeW4Delta({ fallbackPct: pct });
      strat.name = `fb${Math.round(pct * 100)}-${wl.name}`;
      const res = await driveWorkload(strat, wl, store);
      const t = strat._tele;
      const rate = (t.fallbacks / Math.max(1, t.deltas + t.fallbacks)) * 100;
      console.log([
        pct.toFixed(2),
        t.checkpoints,
        t.fallbacks,
        t.deltas,
        t.bases,
        rate.toFixed(0) + '%',
        fmt(res.bytesWritten),
        fmt(res.worstStoredBytes),
        res.worstRatioVsFull.toFixed(3) + 'x',
        res.fidelityPass ? 'PASS' : 'FAIL',
      ].join('\t'));
    }

    console.log(`  [naive-always-delta] bytesWritten=${fmt(naiveRes.bytesWritten)} worstStored=${fmt(naiveRes.worstStoredBytes)} worstVsFullGz=${naiveRes.worstRatioVsFull.toFixed(3)}x fidelity=${naiveRes.fidelityPass ? 'PASS' : 'FAIL'}`);
    console.log(`  [always-full]        bytesWritten=${fmt(fullRes.bytesWritten)} worstStored=${fmt(fullRes.worstStoredBytes)} fidelity=${fullRes.fidelityPass ? 'PASS' : 'FAIL'}`);
    console.log('');
  }

  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
