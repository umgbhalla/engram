import { readFileSync } from 'fs';
import { WASI } from 'node:wasi';
const STDLIB = readFileSync('stdlib_big.js');
const wasi = new WASI({ version:'preview1', returnOnExit:true });
const env = { host_get_timezone_offset:()=>0, host_interrupt:()=>0, host_promise_rejection:()=>{}, host_module_normalize:()=>0, host_module_load:()=>0, host_call:()=>0 };
const mod = await WebAssembly.compile(readFileSync('qjs_wiz_big.wasm'));
const inst = await WebAssembly.instantiate(mod, { env, ...wasi.getImportObject() });
wasi.initialize(inst);
const ex = inst.exports, mem = ex.memory;
function cstr(p){const u8=new Uint8Array(mem.buffer);let e=p;while(u8[e])e++;return Buffer.from(u8.subarray(p,e)).toString();}
function w(buf){const p=ex.wasm_malloc(buf.length+1);new Uint8Array(mem.buffer).set(buf,p);new Uint8Array(mem.buffer)[p+buf.length]=0;return p;}
ex.qjs_init();
const cp=w(STDLIB), fp=w(Buffer.from('<s>'));
const vp=ex.qjs_eval(cp,STDLIB.length,fp,0);
console.log('isExc', ex.qjs_is_exception(vp));
// get exception
const evp = ex.qjs_eval(w(Buffer.from('(globalThis.__e&&String(__e))||"none"')), 38, w(Buffer.from('<x>')),0);
// instead read result string of the eval value itself
const sp=ex.qjs_get_string(vp); console.log('exc msg:', cstr(sp));
