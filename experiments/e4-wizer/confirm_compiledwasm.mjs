import { readFileSync } from 'fs';
import { WASI } from 'node:wasi';
// Simulate workerd CompiledWasm: compile ONCE (deploy time), instantiate at runtime.
const mod = await WebAssembly.compile(readFileSync('qjs_baked.wasm')); // deploy-time precompile
// ---- runtime: NO WebAssembly.compile of raw bytes, only instantiate(Module) ----
const wasi = new WASI({ version:'preview1', returnOnExit:true });
const env = { host_get_timezone_offset:()=>0, host_interrupt:()=>0, host_promise_rejection:()=>{}, host_module_normalize:()=>0, host_module_load:()=>0, host_call:()=>0 };
const inst = await WebAssembly.instantiate(mod, { env, ...wasi.getImportObject() });
console.log('instantiated from precompiled Module:', inst instanceof WebAssembly.Instance);
wasi.initialize(inst);
const ex=inst.exports, mem=ex.memory;
function cstr(p){const u8=new Uint8Array(mem.buffer);let e=p;while(u8[e])e++;return Buffer.from(u8.subarray(p,e)).toString();}
function w(b){const p=ex.wasm_malloc(b.length+1);new Uint8Array(mem.buffer).set(b,p);new Uint8Array(mem.buffer)[p+b.length]=0;return p;}
function ev(code){const b=Buffer.from(code);const vp=ex.qjs_eval(w(b),b.length,w(Buffer.from('<e>')),0);const sp=ex.qjs_get_string(vp);const s=cstr(sp);ex.qjs_free_cstring(sp);ex.qjs_free_value(vp);return s;}
// NO qjs_init, NO inject, NO wizer.initialize re-call
console.log('typeof _ =', ev('typeof _'));
console.log('typeof dayjs =', ev('typeof dayjs'));
console.log('_.sum([1,2,3,4]) =', ev('String(_.sum([1,2,3,4]))'));
console.log('dayjs add =', ev('dayjs("2020-01-01").add(1,"year").format("YYYY")'));
console.log('wizer.initialize present?', typeof ex['wizer.initialize']);
