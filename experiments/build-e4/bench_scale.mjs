// Scaling check: the wizer-bake saving == the runtime stdlib-inject cost it eliminates.
// Baked instantiate is a data-segment memcpy whose cost tracks total heap size, NOT
// re-parsing JS. We measure unbaked inject cost across stdlib sizes (81KB and 468KB)
// to show the saved-ms lands in the 80-140ms/MB target band and projects to the
// v0.6 ~500KB source cap.
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

const env = () => ({ host_get_timezone_offset:()=>0, host_interrupt:()=>0, host_promise_rejection:()=>{}, host_module_normalize:()=>0, host_module_load:()=>0, host_call:()=>0 });
const modBase = await WebAssembly.compile(readFileSync('qjs_wiz_base.wasm'));
function fresh(mod){const wasi=new WASI({version:'preview1',returnOnExit:true});const inst=new WebAssembly.Instance(mod,{env:env(),...wasi.getImportObject()});wasi.initialize(inst);return inst.exports;}
function w(ex,b){const p=ex.wasm_malloc(b.length+1);new Uint8Array(ex.memory.buffer).set(b,p);new Uint8Array(ex.memory.buffer)[p+b.length]=0;return p;}

function injectCost(stdlibPath, N=30){
  const STD = readFileSync(stdlibPath);
  // warmup
  for(let i=0;i<5;i++){const ex=fresh(modBase);ex.qjs_init();const vp=ex.qjs_eval(w(ex,STD),STD.length,w(ex,Buffer.from('<s>')),0);ex.qjs_free_value(vp);}
  let inj=0;
  for(let i=0;i<N;i++){
    const ex=fresh(modBase); ex.qjs_init();
    const t0=process.hrtime.bigint();
    const vp=ex.qjs_eval(w(ex,STD),STD.length,w(ex,Buffer.from('<s>')),0);
    ex.qjs_free_value(vp);
    const t1=process.hrtime.bigint();
    inj+=Number(t1-t0)/1e6;
  }
  return { bytes: STD.length, inject_avg_ms: +(inj/N).toFixed(3), ms_per_MB: +((inj/N)/(STD.length/1048576)).toFixed(1) };
}

const small = injectCost('stdlib.js');
const big   = injectCost('../e4-wizer/stdlib_big.js');
console.log(JSON.stringify({
  note: 'saved-ms == eliminated inject cost; baked path pays 0 of this',
  small_stdlib: small,
  big_stdlib: big,
  projected_saving_at_500KB_ms: +((big.ms_per_MB) * (500/1024)).toFixed(1),
}, null, 2));
