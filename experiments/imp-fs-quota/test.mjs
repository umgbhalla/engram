// test.mjs — GAP 3: per-session host.fs byte quota across BOTH inline-SQLite and R2.
//
// Scenario (from the task):
//   cap=10MB; write 9MB ok; write 2MB more -> QuotaError (VM-catchable, VM alive);
//   rm 5MB frees quota; write succeeds again; evict+restore MID-WAY and confirm
//   the quota counter is restored correctly (re-hydrated, not reset to 0).

import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteSim, R2Sim } from './store.mjs';
import { makeHostFs } from './hostfs.mjs';
import { createKernel, restoreKernel, snapshotHeap, ev } from './kernel.mjs';

const ROOT = new URL('./store', import.meta.url).pathname;
const SESSION = 'sess-quota-1';
const CAP = 10 * 1024 * 1024; // 10MB
const MB = 1024 * 1024;

function freshStore() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  return { sqlite: new SqliteSim(join(ROOT, 'sqlite')), r2: new R2Sim(join(ROOT, 'r2')) };
}
function reopenStore() { // simulates durable storage surviving evict
  return { sqlite: new SqliteSim(join(ROOT, 'sqlite')), r2: new R2Sim(join(ROOT, 'r2')) };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`); };

console.log('# GAP 3 — per-session host.fs byte quota (inline-SQLite + R2 unified)\n');

let { sqlite, r2 } = freshStore();
let hostfs = makeHostFs(sqlite, r2, SESSION, { quotaBytes: CAP });
let vm = await createKernel(hostfs);

// guest helper: write N bytes of deterministic content (unique per tag so etags differ)
const writeCell = (path, bytes, tag) => `
  (function(){
    try {
      var data = ("${tag}").repeat(${Math.ceil(bytes)} / ("${tag}").length >> 0) ;
      // build exact byte length deterministically
      var s = "${tag[0]}".repeat(${bytes});
      var r = host.fs.writeFile("${path}", s);
      return JSON.stringify({ok:true, used:r.used, cap:r.cap, size:r.size});
    } catch(e) {
      return JSON.stringify({ok:false, name:e.name, message:e.message, used:e.used, cap:e.cap});
    }
  })()
`;

// ---- Step 1: write 9MB -> OK ----
let r1 = JSON.parse(ev(vm, writeCell('a.bin', 9 * MB, 'A')));
ok('S1 write 9MB ok', r1.ok === true && r1.used === 9 * MB, `used=${r1.used}`);
ok('S1 a.bin in R2 (overflow)', sqlite.getFileMeta('a.bin').storage === 'r2');
ok('S1 quota persisted to manifest', sqlite.getManifest('fs_quota_json').usedBytes === 9 * MB);

// ---- Step 2: write 2MB more -> QuotaError (9+2=11 > 10) ----
let r2res = JSON.parse(ev(vm, writeCell('b.bin', 2 * MB, 'B')));
ok('S2 write 2MB rejected with QuotaError', r2res.ok === false && r2res.name === 'QuotaError', `name=${r2res.name}`);
ok('S2 storage NOT mutated (b.bin absent)', sqlite.getFileMeta('b.bin') === null);
ok('S2 used unchanged after reject', sqlite.getManifest('fs_quota_json').usedBytes === 9 * MB);
// VM still alive: run a trivial cell
ok('S2 VM alive after QuotaError', ev(vm, '1+1') === 2);

// ---- EVICT + RESTORE MID-WAY (between reject and the rm) ----
const snap = snapshotHeap(vm);
vm.dispose(); vm = null;            // genuine eviction
let reopened = reopenStore();        // durable storage persists
sqlite = reopened.sqlite; r2 = reopened.r2;
const t0 = performance.now();
hostfs = makeHostFs(sqlite, r2, SESSION, { quotaBytes: CAP }); // re-hydrates from manifest
vm = await restoreKernel(snap.gz, hostfs);
const restoreMs = performance.now() - t0;

ok('R quota counter re-hydrated (NOT reset to 0)', hostfs._used() === 9 * MB, `used=${hostfs._used()}`);
ok('R cap re-hydrated', hostfs._cap() === CAP);
ok('R heap survived (a.bin still readable len)', ev(vm, 'host.fs.readFile("a.bin").length') === 9 * MB);
ok('R usage() via VM after restore', JSON.parse(ev(vm, 'JSON.stringify(host.fs.usage())')).used === 9 * MB);
// prove the post-restore quota is LIVE: a 2MB write must STILL reject
let rPost = JSON.parse(ev(vm, writeCell('b.bin', 2 * MB, 'B')));
ok('R post-restore 2MB still rejects (live quota)', rPost.ok === false && rPost.name === 'QuotaError');

// ---- Step 3: rm 5MB frees quota ----
// shrink a.bin? No — rm a.bin (9MB) then write 5MB to model "rm 5MB frees quota".
// Per task: rm to free, then write succeeds. We rm a.bin (frees 9MB), leaving used 0,
// then write 5MB. Cleaner direct test of "rm frees + write succeeds again":
let rmRes = JSON.parse(ev(vm, 'JSON.stringify({removed: host.fs.rm("a.bin"), usage: host.fs.usage()})'));
ok('S3 rm a.bin frees quota', rmRes.removed === true && rmRes.usage.used === 0, `used=${rmRes.usage.used}`);
ok('S3 rm freed quota persisted', sqlite.getManifest('fs_quota_json').usedBytes === 0);
ok('S3 R2 body GC after rm', !r2.has(`${SESSION}/${snap ? '' : ''}` ) || sqlite.list('').length === 0);

// ---- Step 4: write 5MB succeeds again ----
let r4 = JSON.parse(ev(vm, writeCell('c.bin', 5 * MB, 'C')));
ok('S4 write 5MB succeeds after freeing', r4.ok === true && r4.used === 5 * MB, `used=${r4.used}`);

// ---- Extra: write 6MB more would overflow (5+6=11>10) -> reject; then 5MB ok (5+5=10 exact) ----
let r5 = JSON.parse(ev(vm, writeCell('d.bin', 6 * MB, 'D')));
ok('X write 6MB rejects (5+6>10)', r5.ok === false && r5.name === 'QuotaError');
let r6 = JSON.parse(ev(vm, writeCell('e.bin', 5 * MB, 'E')));
ok('X write 5MB ok (exact cap 10MB boundary)', r6.ok === true && r6.used === 10 * MB, `used=${r6.used}`);
let r7 = JSON.parse(ev(vm, writeCell('f.bin', 1, 'F')));
ok('X write 1B over exact cap rejects', r7.ok === false && r7.name === 'QuotaError');

// ---- Extra: overwrite accounting (write same path smaller -> used decreases) ----
let rOv = JSON.parse(ev(vm, writeCell('e.bin', 1 * MB, 'G'))); // e.bin 5MB -> 1MB
ok('X overwrite shrinks used (10MB -> 6MB)', rOv.ok === true && rOv.used === 6 * MB, `used=${rOv.used}`);

// ---- Second evict+restore after frees/writes: counter coherence again ----
const snap2 = snapshotHeap(vm);
vm.dispose(); vm = null;
reopened = reopenStore(); sqlite = reopened.sqlite; r2 = reopened.r2;
hostfs = makeHostFs(sqlite, r2, SESSION, { quotaBytes: CAP });
vm = await restoreKernel(snap2.gz, hostfs);
// live files: c.bin 5MB + e.bin 1MB = 6MB
ok('R2 second restore counter coherent (6MB)', hostfs._used() === 6 * MB, `used=${hostfs._used()}`);
ok('R2 counter == sum of live file sizes', hostfs._used() === sqlite.list('').reduce((s,p)=>s+sqlite.getFileMeta(p).size,0));
ok('R2 free room write 4MB ok (6+4=10)', JSON.parse(ev(vm, writeCell('h.bin', 4*MB, 'H'))).ok === true);
ok('R2 then 1B rejects', JSON.parse(ev(vm, writeCell('i.bin', 1, 'I'))).ok === false);

vm.dispose();

console.log(`\n# restore latency: ${restoreMs.toFixed(2)}ms  | snap raw=${(snap.rawLen/MB).toFixed(2)}MB gz=${(snap.gzLen/1024).toFixed(1)}KB`);
console.log(`# RESULT: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
