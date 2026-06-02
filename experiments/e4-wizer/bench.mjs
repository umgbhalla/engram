import { readFileSync } from 'fs';
import { WASI } from 'node:wasi';
const STDLIB = readFileSync('stdlib.js');
const env=()=>({host_get_timezone_offset:()=>0,host_interrupt:()=>0,host_promise_rejection:()=>{},host_module_normalize:()=>0,host_module_load:()=>0,host_call:()=>0});
const modBase = await WebAssembly.compile(readFileSync('qjs_wiz_base.wasm'));
const modBaked = await WebAssembly.compile(readFileSync('qjs_baked.wasm'));
function fresh(mod){const wasi=new WASI({version:'preview1',returnOnExit:true});const inst=new WebAssembly.Instance(mod,{env:env(),...wasi.getImportObject()});wasi.initialize(inst);return inst.exports;}
function w(ex,b){const p=ex.wasm_malloc(b.length+1);new Uint8Array(ex.memory.buffer).set(b,p);new Uint8Array(ex.memory.buffer)[p+b.length]=0;return p;}
const N=20;
let baseTot=0, bakeTot=0, baseBoot=0, baseInj=0;
for(let i=0;i<N;i++){
  const ex=fresh(modBase);
  const t0=process.hrtime.bigint();
  ex.qjs_init();
  const t1=process.hrtime.bigint();
  const vp=ex.qjs_eval(w(ex,STDLIB),STDLIB.length,w(ex,Buffer.from('<s>')),0);
  ex.qjs_free_value(vp);
  const t2=process.hrtime.bigint();
  baseBoot+=Number(t1-t0)/1e6; baseInj+=Number(t2-t1)/1e6; baseTot+=Number(t2-t0)/1e6;
}
for(let i=0;i<N;i++){
  const t0=process.hrtime.bigint();
  const ex=fresh(modBaked);  // heap already live; create-time work = just instantiate
  const t1=process.hrtime.bigint();
  bakeTot+=Number(t1-t0)/1e6;
}
console.log(JSON.stringify({
  N, stdlibBytes: STDLIB.length,
  baseline_create_avgMs:+(baseTot/N).toFixed(3),
  baseline_boot_avgMs:+(baseBoot/N).toFixed(3),
  baseline_inject_avgMs:+(baseInj/N).toFixed(3),
  baked_instantiate_avgMs:+(bakeTot/N).toFixed(3),
  saved_per_create_avgMs:+((baseTot-bakeTot)/N).toFixed(3),
  inject_ms_per_MB:+((baseInj/N)/(STDLIB.length/1048576)).toFixed(1),
},null,2));
