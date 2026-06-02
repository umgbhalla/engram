// mixed-verify.mjs — prove restore correctness + bounded storage across a TRUE mix of
// sparse (compressible -> delta) and dense (incompressible -> fallback-full) cells in ONE run,
// at the chosen threshold fbPct=0.9. Evict in the middle so cold-restore replays base+deltas.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DOStore, gz } from '../_bench/store.mjs';
import { Session } from '../_bench/session.mjs';
import { makeW4Delta } from './w4-delta.mjs';

function wTrueMix() {
  const cells = [];
  cells.push('var ta = new Uint8Array(2*1024*1024); var n=0; var sum=0; var log=[]; var seed=9;');
  // pattern: 2 sparse, 1 dense-incompressible, repeat
  for (let i = 1; i <= 18; i++) {
    if (i % 3 === 0) {
      // DENSE incompressible -> should fallback
      cells.push(`seed=(${i}*2654435761)>>>0; for(let j=0;j<ta.length;j++){seed^=seed<<13;seed>>>=0;seed^=seed>>>17;seed^=seed<<5;seed>>>=0;ta[j]=seed&0xff;} n++; sum+=${i}; log.push("D${i}");`);
    } else {
      // SPARSE -> delta
      cells.push(`n++; sum+=${i}; log.push("s${i}");`);
    }
  }
  return {
    name: 'W-truemix',
    cells,
    check: 'JSON.stringify({n, sum, logLen: log.length, last: log[log.length-1]})',
    expected: JSON.stringify({ n: 18, sum: 171, logLen: 18, last: 's17'.length ? (18 % 3 === 0 ? 'D18' : 's18') : '' }),
    evictAfter: 10,
  };
}

async function main() {
  const wl = wTrueMix();
  // fix expected precisely: i=18 -> 18%3==0 -> "D18"; sum 1..18 = 171
  wl.expected = JSON.stringify({ n: 18, sum: 171, logLen: 18, last: 'D18' });

  const store = new DOStore({ r2Dir: join(tmpdir(), `w4-mix-${Date.now()}`) });
  const strat = makeW4Delta({ fallbackPct: 0.9 });
  strat.name = 'truemix-fb90';
  const ctx = { key: `${strat.name}/${wl.name}`, generation: 0 };
  const sess = new Session();
  await sess.create();

  let prevImage = null, lastStored = null, hostState = {}, restoreMs = 0;
  let worstStored = 0, worstVsFull = 0;
  const perCell = [];

  const checkpoint = (label) => {
    const img = sess.dump();
    ctx.generation++;
    const before = store.stats().bytesWritten;
    const { stored } = strat.onCheckpoint(prevImage, img, hostState, store, ctx);
    const written = store.stats().bytesWritten - before;
    const fullGz = gz(img).byteLength;
    if (written > worstStored) worstStored = written;
    const r = written / Math.max(1, fullGz);
    if (r > worstVsFull) worstVsFull = r;
    perCell.push({ label, mode: stored.mode, written, fullGz, ratio: +r.toFixed(3) });
    lastStored = stored; prevImage = img;
  };

  for (let i = 0; i < wl.cells.length; i++) {
    sess.eval(wl.cells[i]);
    checkpoint(`cell${i + 1}`);
    if (i + 1 === wl.evictAfter) {
      sess.dispose(); hostState = null; prevImage = null;
      const t0 = performance.now();
      const { image, hostState: hs } = strat.onRestore(lastStored, store, ctx);
      await sess.restore(image);
      restoreMs = performance.now() - t0;
      hostState = hs ?? {}; prevImage = image;
    }
  }
  const got = sess.eval(wl.check);
  const fidelity = got === wl.expected;
  const gen = sess.generation;
  sess.dispose();

  const t = strat._tele;
  console.log('=== TRUE-MIX (sparse->delta + dense-incompressible->fallback), fbPct=0.90 ===\n');
  console.log('per-checkpoint mode + size:');
  for (const c of perCell) {
    const f = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + 'MB' : (n / 1024).toFixed(1) + 'KB';
    console.log(`  ${c.label.padEnd(8)} ${c.mode.padEnd(14)} written=${f(c.written).padStart(9)}  fullGz=${f(c.fullGz).padStart(9)}  ratio=${c.ratio}x`);
  }
  console.log('');
  console.log(`fallbacks=${t.fallbacks} deltas=${t.deltas} bases=${t.bases} checkpoints=${t.checkpoints}`);
  console.log(`worstStored=${(worstStored / 1048576).toFixed(2)}MB  worstVsFullGz=${worstVsFull.toFixed(3)}x`);
  console.log(`cold-restore: genuine? generation=${gen} (>1 means real restore happened), restoreMs=${restoreMs.toFixed(1)}ms`);
  console.log(`FIDELITY: ${fidelity ? 'PASS' : 'FAIL'}  got=${got}  expected=${wl.expected}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
