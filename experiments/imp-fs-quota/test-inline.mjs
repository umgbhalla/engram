// Proves the quota counts INLINE-SQLite bytes too (sub-4096B files), same counter as R2.
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteSim, R2Sim } from './store.mjs';
import { makeHostFs } from './hostfs.mjs';
import { createKernel, restoreKernel, snapshotHeap, ev } from './kernel.mjs';
const ROOT = new URL('./store-inline', import.meta.url).pathname;
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true });
let sqlite = new SqliteSim(join(ROOT,'sqlite')), r2 = new R2Sim(join(ROOT,'r2'));
let pass=0,fail=0; const ok=(n,c,x='')=>{c?pass++:fail++;console.log(`${c?'PASS':'FAIL'}  ${n}${x?' | '+x:''}`);};
// tiny cap = 1000 bytes, all inline (<4096)
let hostfs = makeHostFs(sqlite,r2,'s2',{quotaBytes:1000});
let vm = await createKernel(hostfs);
const w=(p,b,t)=>`(function(){try{var s="${t}".repeat(${b});var r=host.fs.writeFile("${p}",s);return JSON.stringify({ok:true,used:r.used,storage:host.fs.stat("${p}").storage});}catch(e){return JSON.stringify({ok:false,name:e.name});}})()`;
let a=JSON.parse(ev(vm,w('x',600,'a'))); ok('inline 600B ok',a.ok&&a.used===600&&a.storage==='inline',`used=${a.used}`);
let b=JSON.parse(ev(vm,w('y',500,'b'))); ok('inline +500B rejects (600+500>1000)',!b.ok&&b.name==='QuotaError');
let c=JSON.parse(ev(vm,w('z',400,'c'))); ok('inline 400B ok (600+400=1000)',c.ok&&c.used===1000,`used=${c.used}`);
// restore + counter
const snap=snapshotHeap(vm); vm.dispose();
sqlite=new SqliteSim(join(ROOT,'sqlite')); r2=new R2Sim(join(ROOT,'r2'));
hostfs=makeHostFs(sqlite,r2,'s2',{quotaBytes:1000}); vm=await restoreKernel(snap.gz,hostfs);
ok('inline counter rehydrated 1000',hostfs._used()===1000,`used=${hostfs._used()}`);
ok('inline post-restore 1B rejects',!JSON.parse(ev(vm,w('q',1,'q'))).ok);
vm.dispose();
console.log(`# RESULT: ${pass} PASS, ${fail} FAIL`); process.exit(fail?1:0);
