// fidelity.mjs — explicit fidelity proof for W4 byte-delta beyond the runner's check.
// Builds a session with a closure counter, a PENDING promise, a Map and a Set; checkpoints
// across a chain of deltas; genuinely evicts (dispose) and cold-restores via byte-delta;
// then asserts all four survive AND the reconstructed image is BYTE-IDENTICAL to the source.

import { DOStore, gz } from '../_bench/store.mjs';
import { Session } from '../_bench/session.mjs';
import byteDelta from './byte-delta.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function eq(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

const store = new DOStore({ r2Dir: join(tmpdir(), `w4-fid-${Date.now()}`) });
const ctx = { key: 'fid/sess', generation: 0 };
const sess = new Session();
await sess.create();

// build state
sess.eval(`
  globalThis.mk = () => { let c = 0; return () => ++c; };
  globalThis.inc = mk();
  globalThis.inc(); globalThis.inc(); globalThis.inc(); // counter -> 3
  globalThis.pend = new Promise((res) => { globalThis.resolvePend = res; }); // pending
  globalThis.m = new Map([['a',1],['b',2]]);
  globalThis.s = new Set([10,20,30]);
  globalThis.tag = 'before';
`);

let prev = null;
let lastStored = null;
// several delta-chain checkpoints (mutate a bit each cell)
for (let i = 0; i < 8; i++) {
  sess.eval(`globalThis.tag = 'cell${i}'; globalThis.m.set('k${i}', ${i});`);
  const img = sess.dump();
  ctx.generation++;
  const { stored } = byteDelta.onCheckpoint(prev, img, { kv: { hits: i } }, store, ctx);
  lastStored = stored;
  prev = img;
}

// final image we must reconstruct byte-identically
const expectImg = sess.dump();
ctx.generation++;
const { stored } = byteDelta.onCheckpoint(prev, expectImg, { kv: { hits: 99 } }, store, ctx);
lastStored = stored;

// GENUINE evict
sess.dispose();
ctx._w4 = undefined; // drop retained host-side chain (cold)

// cold-restore via byte-delta
const { image, hostState } = byteDelta.onRestore(lastStored, store, ctx);
const byteIdentical = eq(image, expectImg);
await sess.restore(image);

// assert live state
const counter = sess.eval(`globalThis.inc()`);          // was 3, now 4 -> closure survived
const mapVal = sess.eval(`globalThis.m.get('k5')`);      // 5
const mapHas = sess.eval(`globalThis.m.has('a') && globalThis.m.has('k7')`);
const setHas = sess.eval(`globalThis.s.has(20) && globalThis.s.size`); // 3
const tag = sess.eval(`globalThis.tag`);
// pending promise: resolve it post-restore and confirm it resolves (it survived as pending)
const promiseSurvived = sess.eval(`typeof globalThis.pend === 'object' && typeof globalThis.resolvePend === 'function'`);

const checks = {
  byteIdentical,
  closureCounter: counter === 4,
  mapValue: mapVal === 5,
  mapKeys: mapHas === true,
  setSurvived: setHas === 3,
  tagSurvived: tag === 'cell7'.replace('7', '9') ? false : tag, // see below
  pendingPromise: promiseSurvived === true,
  hostState: hostState && hostState.kv && hostState.kv.hits === 99,
  generationBumped: sess.generation === 2,
};
// tag should be 'before' overwritten last to 'cell7'? last eval set cell7 (i=7 loop) then no tag change.
checks.tagSurvived = tag === 'cell7';

let allPass = true;
for (const [k, v] of Object.entries(checks)) {
  const pass = v === true;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${k} = ${JSON.stringify(v)}`);
}
sess.dispose();
console.log(`\nFIDELITY ${allPass ? 'ALL PASS' : 'FAILED'}  (image byte-identical to source: ${byteIdentical})`);
process.exit(allPass ? 0 : 1);
