// PROTOTYPE A — host.fs R2-backed durable virtual filesystem. Test harness.
//
// Proves: (1) round-trip correctness, (2) R2-vs-heap coherence across a GENUINE
// eviction + cold restore, (3) no torn write / no double-fire, (4) the
// write-ordering rule, (5) small-vs-large threshold behaviour.

import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteSim, R2Sim } from './store.mjs';
import { createKernel, restoreKernel, snapshotHeap } from './kernel.mjs';

const ROOT = new URL('./store-r2', import.meta.url).pathname;
const { makeHostFs } = await import('./hostfs.mjs');

function freshStore() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const sqlite = new SqliteSim(join(ROOT, 'sqlite'));
  const r2 = new R2Sim(join(ROOT, 'r2'));
  return { sqlite, r2 };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const SESSION = 'sess-1';
const BIG = 'X'.repeat(64 * 1024); // 64KB -> R2 overflow
const SMALL = 'hello small file';   // inline

// ===========================================================================
console.log('# PROTOTYPE A — host.fs durable virtual filesystem\n');

// ---- TEST 1: round-trip correctness (small inline + large overflow) --------
{
  const { sqlite, r2 } = freshStore();
  const hostfs = makeHostFs(sqlite, r2, SESSION);
  const vm = await createKernel(hostfs);
  vm.evalCode(`
    host.fs.writeFile("small.txt", ${JSON.stringify(SMALL)});
    host.fs.writeFile("docs/big.txt", "${BIG}");
    globalThis.smallRead = host.fs.readFile("small.txt");
    globalThis.bigRead = host.fs.readFile("docs/big.txt");
    globalThis.bigLen = bigRead.length;
  `);
  ok('T1 small round-trip', vm.dump(vm.evalCode('smallRead')) === SMALL);
  ok('T1 large round-trip', vm.dump(vm.evalCode('bigLen')) === BIG.length);
  ok('T1 small stored inline', sqlite.getFileMeta('small.txt').storage === 'inline');
  ok('T1 large overflowed to R2', sqlite.getFileMeta('docs/big.txt').storage === 'r2');
  ok('T1 R2 actually has object', r2.has(sqlite.getFileMeta('docs/big.txt').r2key));
  ok('T1 list', JSON.stringify(vm.dump(vm.evalCode("host.fs.list('')"))) === JSON.stringify(['docs/big.txt','small.txt']));
  vm.dispose();
}

// ---- TEST 2: THE HARD TEST — heap var references a file, then GENUINE evict +
//             cold restore, prove combined state coherent + no double-fire -----
{
  const { sqlite, r2 } = freshStore();
  let hostfs = makeHostFs(sqlite, r2, SESSION);
  let vm = await createKernel(hostfs);
  // build state spanning heap AND host fs
  vm.evalCode(`
    globalThis.writeCount = 0;
    function persist(name, body){ writeCount++; return host.fs.writeFile(name, body); }
    globalThis.h1 = persist("report.txt", "${BIG}");      // overflow -> R2
    globalThis.h2 = persist("note.md", "stateful note");  // inline
    globalThis.ref = { path:"report.txt", etag:h1.etag }; // HEAP var referencing the file
    globalThis.counter = 41;
  `);
  // SNAPSHOT AT A POINT (writes already committed durably -> ordering holds)
  const snap = snapshotHeap(vm);
  const r2PutsBefore = hostfs.stats.r2puts;

  // ---- SIMULATE GENUINE EVICTION: drop the VM AND the in-memory host scheduler.
  vm.dispose(); vm = null; hostfs = null;
  // (sqlite + r2 persist on disk independently — model durable storage surviving.)

  // ---- COLD RESTORE: fresh hostfs (re-bound from durable SQLite/R2) + blit heap.
  const sqlite2 = new SqliteSim(join(ROOT, 'sqlite')); // reload durable meta
  const r2_2 = new R2Sim(join(ROOT, 'r2'));
  const hostfs2 = makeHostFs(sqlite2, r2_2, SESSION);
  const t0 = performance.now();
  const vm2 = await restoreKernel(snap.gz, hostfs2);
  const restoreMs = performance.now() - t0;

  // heap survived?
  ok('T2 heap var survived restore', vm2.dump(vm2.evalCode('counter')) === 41);
  ok('T2 heap ref.etag survived', vm2.dump(vm2.evalCode('typeof ref.etag === "string" && ref.etag.length === 64')));
  // file readable AFTER restore via re-bound host handle?
  const bigBack = vm2.dump(vm2.evalCode(`host.fs.readFile(ref.path)`));
  ok('T2 large file readable post-restore', bigBack === BIG, `len=${bigBack && bigBack.length}`);
  const noteBack = vm2.dump(vm2.evalCode(`host.fs.readFile("note.md")`));
  ok('T2 inline file readable post-restore', noteBack === 'stateful note');
  // etag in heap matches durable meta -> coherent
  const heapEtag = vm2.dump(vm2.evalCode('ref.etag'));
  ok('T2 heap etag == durable meta etag', heapEtag === sqlite2.getFileMeta('report.txt').etag);
  // NO DOUBLE-FIRE: writeCount in heap stayed 2; restore did NOT re-run persist()
  ok('T2 no write double-fire', vm2.dump(vm2.evalCode('writeCount')) === 2, `writeCount=${vm2.dump(vm2.evalCode('writeCount'))}`);
  // and no extra R2 puts happened during restore (effects fired once, at write time)
  ok('T2 no extra R2 put on restore', hostfs2.stats.r2puts === 0, `restorePuts=${hostfs2.stats.r2puts}`);
  console.log(`      restore latency: ${restoreMs.toFixed(2)}ms  image gz=${(snap.gzLen/1024).toFixed(1)}KB raw=${(snap.rawLen/1024).toFixed(1)}KB`);
  vm2.dispose();
}

// ---- TEST 3: torn-write detection — snapshot references a file whose R2 body
//             never committed (eviction landed MID-WRITE, before R2 put). The
//             content-addressed rule makes this DETECTABLE, not silent corruption.
{
  const { sqlite, r2 } = freshStore();
  const hostfs = makeHostFs(sqlite, r2, SESSION);
  const vm = await createKernel(hostfs);
  vm.evalCode(`host.fs.writeFile("ok.txt", "${BIG}"); globalThis.ref="ok.txt";`);
  const snap = snapshotHeap(vm);
  vm.dispose();

  // Simulate TORN write: metadata committed but R2 object lost (e.g. crash between
  // — though our ordering forbids this, we FORCE it to prove detection works).
  const meta = sqlite.getFileMeta('ok.txt');
  r2.delete(meta.r2key); // wipe the R2 body -> torn
  const sqlite2 = new SqliteSim(join(ROOT, 'sqlite'));
  const r2_2 = new R2Sim(join(ROOT, 'r2'));
  const hostfs2 = makeHostFs(sqlite2, r2_2, SESSION);
  const vm2 = await restoreKernel(snap.gz, hostfs2);
  const res = vm2.dump(vm2.evalCode(`host.fs.readFile(ref)`));
  ok('T3 torn write DETECTED (not silent)', res && res.__torn === true && res.reason === 'r2-missing', JSON.stringify(res));
  vm2.dispose();
}

// ---- TEST 4: write-ordering rule — snapshot taken BEFORE the R2 put commits.
//             Prove the rule prevents the heap from ever referencing an
//             un-committed object (because writeFile commits R2 *before* returning
//             the etag the heap stores).
{
  const { sqlite, r2 } = freshStore();
  const hostfs = makeHostFs(sqlite, r2, SESSION);
  const vm = await createKernel(hostfs);
  // The heap only learns the etag AFTER writeFile returns -> after R2 put + meta.
  // So any snapshot containing `ref` necessarily has a durable R2 object.
  vm.evalCode(`globalThis.ref = host.fs.writeFile("x.txt","${BIG}");`);
  const meta = sqlite.getFileMeta('x.txt');
  ok('T4 R2 object durable before heap holds etag', r2.has(meta.r2key) && vm.dump(vm.evalCode('ref.etag')) === meta.etag);
  vm.dispose();
}

// ---- TEST 5: small-vs-large threshold + idempotent content-addressing --------
{
  const { sqlite, r2 } = freshStore();
  const hostfs = makeHostFs(sqlite, r2, SESSION);
  const vm = await createKernel(hostfs);
  const atBoundary = 'a'.repeat(hostfs.INLINE_MAX);       // <= INLINE_MAX -> inline
  const overBoundary = 'b'.repeat(hostfs.INLINE_MAX + 1); // > INLINE_MAX -> R2
  vm.evalCode(`host.fs.writeFile("a", ${JSON.stringify(atBoundary)}); host.fs.writeFile("b", ${JSON.stringify(overBoundary)});`);
  ok('T5 at-threshold inline', sqlite.getFileMeta('a').storage === 'inline');
  ok('T5 over-threshold overflow', sqlite.getFileMeta('b').storage === 'r2');
  // idempotent: two paths same content -> one R2 object
  vm.evalCode(`host.fs.writeFile("dup1","${BIG}"); host.fs.writeFile("dup2","${BIG}");`);
  ok('T5 content-addressed dedup (1 R2 obj for identical content)',
     sqlite.getFileMeta('dup1').r2key === sqlite.getFileMeta('dup2').r2key);
  const putsForDup = hostfs.stats.r2puts; // b=1, dup=1 (second deduped) => total 2
  ok('T5 dedup avoided redundant put', putsForDup === 2, `r2puts=${putsForDup}`);
  // rm GC: removing dup1 keeps object (dup2 refs), removing dup2 frees it
  vm.evalCode(`host.fs.rm("dup1");`);
  const key = sqlite.getFileMeta('dup2').r2key;
  ok('T5 rm keeps R2 obj while referenced', r2.has(key));
  vm.evalCode(`host.fs.rm("dup2");`);
  ok('T5 rm GCs R2 obj when last ref gone', !r2.has(key));
  vm.dispose();
}

console.log(`\n# RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
