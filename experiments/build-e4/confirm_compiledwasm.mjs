// Confirm the baked wasm is CompiledWasm-loadable under workerd semantics:
// the Module is compiled ONCE (deploy-time precompile, what `import wasm from "x.wasm"`
// gives you in workerd), and at runtime we ONLY instantiate(Module) — never compile raw
// bytes (workerd forbids runtime WebAssembly.compile of arbitrary buffers).
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

const mod = await WebAssembly.compile(readFileSync('qjs_baked.wasm')); // == deploy-time CompiledWasm
const wasi = new WASI({ version:'preview1', returnOnExit:true });
const env = { host_get_timezone_offset:()=>0, host_interrupt:()=>0, host_promise_rejection:()=>{}, host_module_normalize:()=>0, host_module_load:()=>0, host_call:()=>0 };

// runtime: instantiate the precompiled Module only
const inst = await WebAssembly.instantiate(mod, { env, ...wasi.getImportObject() });
console.log('instance from precompiled Module:', inst instanceof WebAssembly.Instance);
wasi.initialize(inst);
const ex = inst.exports, mem = ex.memory;

// confirm exports the kernel/glue needs are intact after bake
const need = ['memory','qjs_eval','qjs_init','wasm_malloc','qjs_get_string','qjs_free_value','qjs_free_cstring'];
const have = Object.keys(ex);
console.log('required exports present:', need.every(n=>have.includes(n)), need.filter(n=>!have.includes(n)));

function cstr(p){const u8=new Uint8Array(mem.buffer);let e=p;while(u8[e])e++;return Buffer.from(u8.subarray(p,e)).toString();}
function w(b){const p=ex.wasm_malloc(b.length+1);new Uint8Array(mem.buffer).set(b,p);new Uint8Array(mem.buffer)[p+b.length]=0;return p;}
function ev(c){const b=Buffer.from(c);const vp=ex.qjs_eval(w(b),b.length,w(Buffer.from('<e>')),0);const sp=ex.qjs_get_string(vp);const s=cstr(sp);ex.qjs_free_cstring(sp);ex.qjs_free_value(vp);return s;}

// NO qjs_init, NO inject — heap already live from the bake
console.log('typeof _    =', ev('typeof _'));
console.log('typeof dayjs=', ev('typeof dayjs'));
console.log('_.sum       =', ev('String(_.sum([1,2,3,4]))'));
console.log('dayjs       =', ev('dayjs("2020-01-01").add(1,"year").format("YYYY")'));
console.log('mutable     =', ev('globalThis.zz=_.range(5); String(zz)'));
