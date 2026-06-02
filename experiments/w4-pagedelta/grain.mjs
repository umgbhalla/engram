// W4-b: granularity sweep. Why is page-delta only ~33%? Test sub-page chunks
// + measure how scattered the byte-level dirt actually is (GC scatter).
import { QuickJS } from '../e6-oplog/node_modules/quickjs-wasi/dist/index.js';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const WASM = readFileSync(new URL('../e6-oplog/node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
const mod = await WebAssembly.compile(WASM);
function installHost(vm,r){vm.global.setProp('hostCall',vm.newFunction('hostCall',()=>{let v;if(r.mode==='replay')v=r.log[r.idx++];else{v=r.hostState.counter++;r.log.push(v)}return vm.newNumber(v)}))}
function makeCells(n){const c=[`globalThis.store=[];globalThis.acc=0;globalThis.log=[];`];for(let i=1;i<n;i++){if(i%10===0)c.push(`for(let k=0;k<2000;k++){store.push("row-"+${i}+"-"+k+"-"+Math.random().toString())} store.length;`);else if(i%3===0)c.push(`log.push(hostCall(${i}));acc+=log[log.length-1];acc;`);else c.push(`acc+=${i};store.push({i:${i},v:acc});store.length;`)}return c.slice(0,n)}
const KB=b=>(b/1024).toFixed(1)+'KB';
const cells=makeCells(50);
const r={mode:'record',log:[],hostState:{counter:1000}};
const vm=await QuickJS.create(mod);installHost(vm,r);
const snaps=[];
for(const c of cells){vm.evalCode(c);vm.executePendingJobs();snaps.push(Uint8Array.from(vm.snapshot().memory))}
vm.dispose();
// for each chunk size, sum dirty-chunk gz across consecutive snaps (single base)
for(const CHUNK of [65536,16384,4096,1024,256]){
  let deltaGz=0, dirtyBytesRaw=0, totBytes=0;
  for(let i=1;i<snaps.length;i++){
    const a=snaps[i-1],b=snaps[i];const n=Math.ceil(b.length/CHUNK);const parts=[];
    for(let c=0;c<n;c++){const s=c*CHUNK,e=Math.min(s+CHUNK,b.length);let diff=false;
      if(s>=a.length)diff=true;else for(let j=s;j<e;j++){if(a[j]!==b[j]){diff=true;break}}
      if(diff){parts.push(Buffer.from(b.subarray(s,e)));dirtyBytesRaw+=e-s}}
    deltaGz+=gzipSync(Buffer.concat(parts),{level:6}).length;
  }
  // byte-level lower bound: count actually-changed bytes
  console.log(`chunk ${String(CHUNK).padStart(6)}B: delta total ${KB(deltaGz)} gz, dirty raw ${KB(dirtyBytesRaw)}`);
}
// true byte-level changed count (the floor)
let changed=0,tot=0;
for(let i=1;i<snaps.length;i++){const a=snaps[i-1],b=snaps[i];const L=Math.min(a.length,b.length);for(let j=0;j<L;j++)if(a[j]!==b[j])changed++;changed+=Math.abs(b.length-a.length);tot+=b.length}
console.log(`\nbyte-level: ${KB(changed)} of ${KB(tot)} actually changed across 49 transitions = ${(100*changed/tot).toFixed(1)}% true churn`);
