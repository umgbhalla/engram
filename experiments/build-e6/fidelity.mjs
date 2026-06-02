// fidelity.mjs — E6 deep fidelity + engine-migration verification.
//
// (A) FIDELITY across evict -> cold-restore (full snapshot path AND oplog-replay path):
//     closure counter + pending promise + Map + Set must survive byte-identical.
// (B) ENGINE-MIGRATION: when the heap image is version-locked (cannot deserialize), replay
//     the retained source-cell oplog into a NEW engine instead of bricking.
//
// Uses the shared _bench Session (seeded clock/RNG) so replay is deterministic.

import assert from 'node:assert';
import { Session } from '../_bench/session.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name, extra ?? ''); }
  else { fail++; console.log('  FAIL', name, extra ?? ''); }
}

// The fidelity cells: a closure counter, a pending (unresolved-then-resolved) promise,
// a Map and a Set. These are the hard cases (closures + live promise state + collections).
const FID_CELLS = [
  'var n = 0; var inc = () => (++n);',          // closure over n
  'inc(); inc(); inc();',                        // n === 3
  'var m = new Map(); m.set("a",1); m.set("b",2);',
  'var s = new Set([10,20,30]);',
  // a promise that is pending at snapshot time then resolved post-restore via stored resolver
  'var resolveP; var p = new Promise(r=>{ resolveP = r; }); var pState = "pending";',
  'p.then(v=>{ pState = "resolved:"+v; });',
];
const CHECK = 'JSON.stringify({n, mapA:m.get("a"), mapB:m.get("b"), setHas20:s.has(20), setSize:s.size, pState})';

async function freshSeeded() {
  const sess = new Session();
  await sess.create();
  return sess;
}

// ---- (A1) FULL-SNAPSHOT restore fidelity (byte-identical image round-trip) ----
async function testFullRestore() {
  console.log('\n[A1] full-snapshot evict -> cold-restore fidelity');
  let sess = await freshSeeded();
  for (const c of FID_CELLS) sess.eval(c);
  const before = sess.eval(CHECK);
  const img1 = sess.dump();

  // evict
  sess.dispose();

  // cold restore from the exact image bytes
  sess = await freshSeeded();         // genuine new instance (generation bumps on restore below)
  await sess.restore(img1);
  ok('genuine new instance', sess.generation > 1, `gen=${sess.generation}`);

  // re-dump and assert BYTE-IDENTICAL image (snapshot determinism)
  const img2 = sess.dump();
  const identical = img1.byteLength === img2.byteLength && Buffer.compare(Buffer.from(img1), Buffer.from(img2)) === 0;
  ok('image byte-identical across restore', identical, `${img1.byteLength}B vs ${img2.byteLength}B`);

  // closure still works post-restore
  sess.eval('inc();'); // n -> 4
  // resolve the pending promise post-restore, then drain the QuickJS microtask queue
  sess.eval('resolveP(42);');
  sess.vm.executePendingJobs();
  const after = sess.eval(CHECK);
  ok('closure/Map/Set survived', JSON.parse(after).mapB === 2 && JSON.parse(after).setHas20 === true);
  ok('closure counter advanced post-restore', JSON.parse(after).n === 4, after);
  ok('pending promise resolved post-restore', JSON.parse(after).pState === 'resolved:42', after);
  sess.dispose();
}

// ---- (A2) OPLOG-REPLAY restore fidelity (last full + replay tail re-derives state) ----
async function testOplogReplay() {
  console.log('\n[A2] oplog-replay restore fidelity (last full + replay tail)');
  // Build to a "full" point, capture image, then run more cells as the oplog tail.
  let sess = await freshSeeded();
  const FULL_AT = 2; // first 2 cells captured as the full snapshot
  for (let i = 0; i < FULL_AT; i++) sess.eval(FID_CELLS[i]);
  const fullImg = sess.dump();
  const tail = FID_CELLS.slice(FULL_AT); // oplog tail cell sources
  for (const c of tail) sess.eval(c);
  const before = sess.eval(CHECK);

  // evict everything
  sess.dispose();

  // restore = load full + replay tail into a NEW engine
  sess = await freshSeeded();
  await sess.restore(fullImg);
  for (const c of tail) sess.eval(c); // REPLAY (deterministic; seeded entropy)
  const after = sess.eval(CHECK);
  ok('oplog replay re-derives state', after === before, `before=${before} after=${after}`);
  sess.eval('resolveP(42);');
  sess.vm.executePendingJobs();
  ok('promise resolvable after replay', JSON.parse(sess.eval(CHECK)).pState === 'resolved:42');
  sess.dispose();
}

// ---- (B) ENGINE MIGRATION: image version-locked -> replay source oplog into new engine ----
async function testEngineMigration() {
  console.log('\n[B] engine-migration: version-locked image -> replay oplog into new engine');
  // Simulate: we have the FULL source-cell oplog retained but the heap image won't deserialize
  // (engine hash bumped). The recovery path replays ALL retained sources into the fresh engine.
  let sess = await freshSeeded();
  for (const c of FID_CELLS) sess.eval(c);
  const expected = sess.eval(CHECK);
  const lockedImg = sess.dump();
  sess.dispose();

  // Corrupt the image header to simulate a version-locked / incompatible snapshot.
  const corrupt = lockedImg.slice();
  corrupt[0] ^= 0xff; corrupt[1] ^= 0xff; corrupt[2] ^= 0xff; corrupt[3] ^= 0xff;

  let restoreFailed = false;
  let migSess = await freshSeeded();
  try {
    await migSess.restore(corrupt);
    // if it somehow restored, dispose and force the migration path anyway
    migSess.dispose();
    migSess = await freshSeeded();
  } catch (e) {
    restoreFailed = true;
  }
  ok('version-locked image rejected by deserialize', restoreFailed, restoreFailed ? '' : '(deserialize did not throw; migration still used)');

  // MIGRATION: fresh engine + replay full retained source oplog
  // (migSess is a fresh engine; replay all sources)
  for (const c of FID_CELLS) migSess.eval(c);
  const migrated = migSess.eval(CHECK);
  ok('engine-migration via source replay rebuilds state', migrated === expected, `expected=${expected} migrated=${migrated}`);
  migSess.dispose();
}

await testFullRestore();
await testOplogReplay();
await testEngineMigration();

console.log(`\n=== fidelity: ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
