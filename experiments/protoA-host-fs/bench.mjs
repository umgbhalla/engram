import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteSim, R2Sim } from './store.mjs';
import { makeHostFs } from './hostfs.mjs';
const ROOT = new URL('./store-bench', import.meta.url).pathname;
function fresh(){ rmSync(ROOT,{recursive:true,force:true}); mkdirSync(ROOT,{recursive:true});
  return { sqlite:new SqliteSim(join(ROOT,'sqlite')), r2:new R2Sim(join(ROOT,'r2')) }; }
console.log('# threshold sweep: write+read 100x at each size, inline vs R2');
for (const sz of [256, 1024, 4096, 4097, 16*1024, 256*1024, 1024*1024]) {
  const {sqlite,r2}=fresh(); const fs=makeHostFs(sqlite,r2,'s');
  const body='z'.repeat(sz);
  const tw=performance.now(); for(let i=0;i<100;i++) fs.writeFile('f'+i, body); const wms=(performance.now()-tw)/100;
  const tr=performance.now(); for(let i=0;i<100;i++) fs.readFile('f'+i); const rms=(performance.now()-tr)/100;
  const m=sqlite.getFileMeta('f0');
  console.log(`  ${String(sz).padStart(8)}B  ${m.storage.padEnd(6)}  write ${wms.toFixed(3)}ms  read ${rms.toFixed(3)}ms`);
}
rmSync(ROOT,{recursive:true,force:true});
