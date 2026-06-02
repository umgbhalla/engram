// E4 cold-create latency: baked-vs-unbaked. Measures the create-time cost a DO
// pays on every cold wake to get a QuickJS VM with default stdlib (lodash+dayjs) resident.
//
// Unbaked path  = WebAssembly.instantiate(stock module) -> qjs_init() -> qjs_eval(stdlib)
// Baked path    = WebAssembly.instantiate(wizer-baked module)   [heap already live, NO init, NO inject]
//
// Both reuse a single precompiled WebAssembly.Module (== workerd CompiledWasm: compile once at
// deploy, instantiate per cold start), so we time only the per-cold-start work.
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

const STDLIB = readFileSync('stdlib.js');
const env = () => ({ host_get_timezone_offset:()=>0, host_interrupt:()=>0, host_promise_rejection:()=>{}, host_module_normalize:()=>0, host_module_load:()=>0, host_call:()=>0 });

// precompile once (deploy time) — NOT counted in per-create timing
const modBase  = await WebAssembly.compile(readFileSync('qjs_wiz_base.wasm'));
const modBaked = await WebAssembly.compile(readFileSync('qjs_baked.wasm'));

function fresh(mod) {
  const wasi = new WASI({ version:'preview1', returnOnExit:true });
  const inst = new WebAssembly.Instance(mod, { env: env(), ...wasi.getImportObject() });
  wasi.initialize(inst); // runs _initialize (wasi reactor ctors); for baked this is the data-segment blit
  return inst.exports;
}
function w(ex, b) { const p = ex.wasm_malloc(b.length+1); new Uint8Array(ex.memory.buffer).set(b,p); new Uint8Array(ex.memory.buffer)[p+b.length]=0; return p; }
function cstr(ex,p){const u8=new Uint8Array(ex.memory.buffer);let e=p;while(u8[e])e++;return Buffer.from(u8.subarray(p,e)).toString();}
function ev(ex,code){const b=Buffer.from(code);const vp=ex.qjs_eval(w(ex,b),b.length,w(ex,Buffer.from('<e>')),0);const sp=ex.qjs_get_string(vp);const s=cstr(ex,sp);ex.qjs_free_cstring(sp);ex.qjs_free_value(vp);return s;}

const N = 50, WARM = 5;
const baseSamp = [], bakeSamp = [];
let baseBoot = 0, baseInj = 0;

// warmup (JIT)
for (let i=0;i<WARM;i++){ const ex=fresh(modBase); ex.qjs_init(); const vp=ex.qjs_eval(w(ex,STDLIB),STDLIB.length,w(ex,Buffer.from('<s>')),0); ex.qjs_free_value(vp); }
for (let i=0;i<WARM;i++){ fresh(modBaked); }

for (let i=0;i<N;i++){
  const t0 = process.hrtime.bigint();
  const ex = fresh(modBase);
  const t1 = process.hrtime.bigint();
  ex.qjs_init();
  const t2 = process.hrtime.bigint();
  const vp = ex.qjs_eval(w(ex,STDLIB), STDLIB.length, w(ex,Buffer.from('<s>')), 0);
  ex.qjs_free_value(vp);
  const t3 = process.hrtime.bigint();
  baseSamp.push(Number(t3-t0)/1e6);
  baseBoot += Number(t2-t1)/1e6;
  baseInj  += Number(t3-t2)/1e6;
}
for (let i=0;i<N;i++){
  const t0 = process.hrtime.bigint();
  fresh(modBaked); // instantiate baked module = the entire create-time cost
  const t1 = process.hrtime.bigint();
  bakeSamp.push(Number(t1-t0)/1e6);
}

// fidelity: baked VM must already have stdlib resident, byte-correct, no init/inject
const exB = fresh(modBaked);
const fid = {
  typeof_underscore: ev(exB, 'typeof _'),
  typeof_dayjs:      ev(exB, 'typeof dayjs'),
  lodash_sum:        ev(exB, 'String(_.sum([1,2,3,4]))'),
  lodash_chunk:      ev(exB, 'String(_.chunk([1,2,3,4],2).length)'),
  dayjs_add:         ev(exB, 'dayjs("2020-01-01").add(1,"year").format("YYYY")'),
};
// post-bake eval still works (heap mutable after restore)
ev(exB, 'globalThis.__after = _.range(3)');
fid.post_bake_eval = ev(exB, 'String(__after)');

const stats = (a) => { const s=[...a].sort((x,y)=>x-y); const p=q=>s[Math.min(s.length-1,Math.floor(q*s.length))]; const mean=a.reduce((x,y)=>x+y,0)/a.length; return { mean:+mean.toFixed(3), p50:+p(.5).toFixed(3), p99:+p(.99).toFixed(3), min:+s[0].toFixed(3), max:+s[s.length-1].toFixed(3) }; };
const base = stats(baseSamp), bake = stats(bakeSamp);

console.log(JSON.stringify({
  N, stdlibBytes: STDLIB.length,
  unbaked_create_ms: base,
  unbaked_boot_avg_ms: +(baseBoot/N).toFixed(3),
  unbaked_inject_avg_ms: +(baseInj/N).toFixed(3),
  baked_create_ms: bake,
  saved_ms_p50: +(base.p50 - bake.p50).toFixed(3),
  saved_ms_mean: +(base.mean - bake.mean).toFixed(3),
  inject_ms_per_MB: +((baseInj/N)/(STDLIB.length/1048576)).toFixed(1),
  fidelity: fid,
}, null, 2));
