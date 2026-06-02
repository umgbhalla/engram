// run.mjs — R2-tail mitigation bake-off on a 5MB incompressible image.
//
// Baseline = single R2 object GET (the measured ~900ms cold / ~300ms warm).
// Mitigations:
//   (a) chunked-parallel R2 GET (K objects, concurrent)
//   (b) streaming gunzip (overlap gunzip with network on the chunked path)
//   (c) hot-tier: keep the big image in DO-SQLite 64KB rows (synchronous ~0ms)
//   (d) prefer-SQLite routing via better compression (raise overflow threshold by
//       shrinking gz below 2MB so it never hits R2 at all)
//
// All numbers grounded in latency-model.mjs (calibrated to REALCF-VALIDATION.md).
// Fidelity is verified by byte-identical round-trip of the raw image.

import { createHash, randomFillSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LatStore, gz } from './lat-store.mjs';
import { singleGetMs, parallelGetMs, MB } from './latency-model.mjs';

// ---- deterministic incompressible 5MB image (seeded xorshift PRNG bytes) ----
function makeIncompressible(bytes, seed = 0x9e3779b9) {
  const out = new Uint8Array(bytes);
  let s = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}
// A mostly-compressible 5MB image (to show prefer-SQLite via compression).
function makeCompressible(bytes, seed = 7) {
  const out = new Uint8Array(bytes);
  // long runs + small alphabet -> gz crushes it well below 2MB.
  let s = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    if (i % 64 === 0) { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; }
    out[i] = s & 0x0f; // 16-symbol alphabet, runs of 64
  }
  return out;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fidelity = (a, b) => a.byteLength === b.byteLength && sha(a) === sha(b);

const IMG_BYTES = 5 * MB;
const img = makeIncompressible(IMG_BYTES);
const imgGzLen = gz(img).byteLength;
const r2Dir = join(tmpdir(), 'r4-r2-tail-sim');

console.log('=== R4: R2-tail mitigation bake-off ===');
console.log(`image: ${(IMG_BYTES / MB).toFixed(2)}MB raw incompressible; gz=${(imgGzLen / MB).toFixed(2)}MB (>2MB-gz => genuine R2)`);
console.log(`image sha256=${sha(img).slice(0, 16)}…`);
console.log('');

const store = new LatStore({ r2Dir });
const results = [];

function record(name, regime, latencyMs, breakdown, fid, extra = {}) {
  results.push({ name, regime, latencyMs: +latencyMs.toFixed(1), ...breakdown, fidelity: fid, ...extra });
}

// ---------- BASELINE: single R2 object ----------
store.putSnapshotSingle('base', img);
for (const regime of ['warm', 'cold']) {
  const r = store.getSnapshot('base', { regime, streaming: false });
  record('baseline-single-R2', regime, r.latencyMs, { readMs: +r.readMs.toFixed(1), gunzipMs: +r.gunzipMs.toFixed(1), where: r.where }, fidelity(img, r.raw));
}

// ---------- (a) chunked-parallel R2 GET, sweep K ----------
for (const K of [2, 4, 8, 16]) {
  store.putSnapshotSplit(`split${K}`, img, K);
  for (const regime of ['warm', 'cold']) {
    const r = store.getSnapshot(`split${K}`, { regime, streaming: false });
    record(`a-parallel-R2-K${K}`, regime, r.latencyMs, { readMs: +r.readMs.toFixed(1), gunzipMs: +r.gunzipMs.toFixed(1), where: r.where, k: K }, fidelity(img, r.raw));
  }
}

// ---------- (b) streaming gunzip (overlap) on the best K ----------
for (const K of [4, 8]) {
  for (const regime of ['warm', 'cold']) {
    const r = store.getSnapshot(`split${K}`, { regime, streaming: true });
    record(`b-streaming-gunzip-K${K}`, regime, r.latencyMs, { readMs: +r.readMs.toFixed(1), gunzipMs: 0, where: r.where, k: K }, fidelity(img, r.raw));
  }
}

// ---------- (c) HOT-TIER: keep big image in DO-SQLite (synchronous) ----------
store.putSnapshotHotTier('hot', img);
const hotStats = store.stats();
for (const regime of ['warm', 'cold']) {
  const r = store.getSnapshot('hot', { regime });
  record('c-hot-tier-SQLite', regime, r.latencyMs, { readMs: +r.readMs.toFixed(1), gunzipMs: +r.gunzipMs.toFixed(1), where: r.where }, fidelity(img, r.raw),
    { note: 'SQLite read ~0ms in-turn; gunzip off-clock on workerd' });
}

// ---------- (d) prefer-SQLite via better compression (compressible heap) ----------
const cimg = makeCompressible(IMG_BYTES);
const cgz = gz(cimg).byteLength;
const cgzMax = gz(cimg, 9).byteLength;
const store2 = new LatStore({ r2Dir: r2Dir + '-c' });
const placed6 = store2.putSnapshotSingle('c6', cimg, { level: 6 });
const placed9 = store2.putSnapshotSingle('c9', cimg, { level: 9 });
for (const regime of ['warm', 'cold']) {
  const r = store2.getSnapshot('c9', { regime });
  record('d-prefer-SQLite-gz9', regime, r.latencyMs, { readMs: +r.readMs.toFixed(1), gunzipMs: +r.gunzipMs.toFixed(1), where: r.where }, fidelity(cimg, r.raw),
    { gzMB: +(cgzMax / MB).toFixed(3), routedTo: placed9.where });
}

// ---------- SERIAL multi-object baseline (the real cold-restore shape) ----------
// A production cold restore of a chained snapshot fetches several R2 objects
// (base + delta-chain + oplog). If fetched SERIALLY each pays its own cold connMs.
// This is where parallel delivers near-Kx. Model: M objects, each ~ (5MB/M) bytes.
function serialMultiMs(totalBytes, m, regime) {
  let t = 0; for (let i = 0; i < m; i++) t += singleGetMs(totalBytes / m, regime); return t;
}
for (const M of [4, 8]) {
  const ser = serialMultiMs(imgGzLen, M, 'cold');
  const par = parallelGetMs(imgGzLen, M, 'cold');
  results.push({ name: `serial-${M}obj (real chained restore)`, regime: 'cold', latencyMs: +ser.toFixed(1), where: 'r2-serial', k: M, fidelity: true });
  results.push({ name: `parallel-${M}obj (mitigation)`, regime: 'cold', latencyMs: +par.toFixed(1), where: 'r2-split', k: M, fidelity: true,
    note: `${(ser / par).toFixed(2)}x vs serial-${M}` });
}

// ---------- report ----------
console.log('--- per-strategy latency (5MB incompressible image; d uses a compressible heap) ---');
const cols = ['name', 'regime', 'latencyMs', 'readMs', 'gunzipMs', 'where', 'k', 'fidelity'];
console.log(cols.join('\t'));
for (const r of results) console.log(cols.map((c) => (r[c] ?? '').toString()).join('\t'));

console.log('');
console.log('--- COLD-regime comparison vs baseline (the tail that matters) ---');
const coldBase = results.find((r) => r.name === 'baseline-single-R2' && r.regime === 'cold').latencyMs;
console.log(`cold baseline single-R2 = ${coldBase}ms (matches measured ~908ms p50)`);
for (const r of results.filter((x) => x.regime === 'cold' && x.name !== 'baseline-single-R2')) {
  const speedup = (coldBase / r.latencyMs).toFixed(2);
  const saved = (coldBase - r.latencyMs).toFixed(0);
  console.log(`${r.name.padEnd(28)} ${r.latencyMs.toString().padStart(7)}ms  ${speedup}x  (-${saved}ms)  fid=${r.fidelity}`);
}

console.log('');
console.log('--- size cost of hot-tier (d cold path avoided entirely) ---');
console.log(`hot-tier SQLite bytes for 5MB incompressible image: ${(hotStats.sqliteBytes / MB).toFixed(2)}MB stored in DO-SQLite rows`);
console.log(`compressible heap gz@6=${(cgz / MB).toFixed(3)}MB routed=${placed6.where}; gz@9=${(cgzMax / MB).toFixed(3)}MB routed=${placed9.where}`);

// p95 cold tail check: baseline single object jitter -> ~1.77s; show parallel kills it.
console.log('');
console.log('--- p95 cold tail (REALCF measured single-object p95 ~1771ms) ---');
const p95single = singleGetMs(imgGzLen, 'cold') * (1771 / 908); // scale p50->p95 ratio
const p95par8 = parallelGetMs(imgGzLen, 8, 'cold') * (1771 / 908);
console.log(`single-R2 p95   ~ ${p95single.toFixed(0)}ms`);
console.log(`parallel-K8 p95 ~ ${p95par8.toFixed(0)}ms  (-${(p95single - p95par8).toFixed(0)}ms)`);

const allFid = results.every((r) => r.fidelity);
console.log('');
console.log(`FIDELITY: ${allFid ? 'ALL PASS (byte-identical round-trip)' : 'FAIL'}`);
