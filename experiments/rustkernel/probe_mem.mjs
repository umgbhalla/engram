import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
const WASM = new URL('./target/wasm32-wasip1/release/rustkernel.wasm', import.meta.url);
const mod = await WebAssembly.compile(readFileSync(WASM));
async function inst(){const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{}});const i=await WebAssembly.instantiate(mod,{wasi_snapshot_preview1:wasi.wasiImport});try{wasi.initialize(i);}catch{}return i;}
function ev(i,src,budget=5_000_000){const enc=new TextEncoder().encode(src);const off=i.exports.scratch_ptr();new Uint8Array(i.exports.memory.buffer).set(enc,off);i.exports.eval_cell(off,enc.length,BigInt(budget));const ptr=i.exports.result_ptr(),len=i.exports.result_len();return JSON.parse(new TextDecoder().decode(new Uint8Array(i.exports.memory.buffer,ptr,len).slice()));}
const a=await inst();a.exports.create(0n,1n);
console.log('pages before',a.exports.memory.buffer.byteLength/65536);
const r=ev(a,"let arr=[];try{while(true){arr.push(new Array(100000).fill(7))}}catch(e){'caught:'+e.name}",5_000_000);
console.log('array-alloc result',JSON.stringify(r));
console.log('pages after',a.exports.memory.buffer.byteLength/65536,'bytes',a.exports.memory.buffer.byteLength);
console.log('rquickjs used_heap',Number(a.exports.used_heap()));
console.log('recover',JSON.stringify(ev(a,"1+1")));
