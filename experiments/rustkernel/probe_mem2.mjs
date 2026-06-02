import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
const WASM=new URL('./target/wasm32-wasip1/release/rustkernel.wasm',import.meta.url);
const mod=await WebAssembly.compile(readFileSync(WASM));
async function inst(){const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{}});const i=await WebAssembly.instantiate(mod,{wasi_snapshot_preview1:wasi.wasiImport});try{wasi.initialize(i);}catch{}return i;}
function ev(i,src,budget=5_000_000){const enc=new TextEncoder().encode(src);const off=i.exports.scratch_ptr();new Uint8Array(i.exports.memory.buffer).set(enc,off);i.exports.eval_cell(off,enc.length,BigInt(budget));const ptr=i.exports.result_ptr(),len=i.exports.result_len();return JSON.parse(new TextDecoder().decode(new Uint8Array(i.exports.memory.buffer,ptr,len).slice()));}
// single big string alloc - does 64MB limit catch this one early?
const a=await inst();a.exports.create(0n,1n);
console.log('big-single-string',JSON.stringify(ev(a,"'a'.repeat(200*1024*1024).length")));
console.log('pages',a.exports.memory.buffer.byteLength/65536);
console.log('used',Number(a.exports.used_heap()));
// snapshot after the 4GB grow earlier would be 4GB. Check: does a post-bomb snapshot even fit / blit?
