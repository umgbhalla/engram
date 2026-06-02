import { readFileSync } from 'fs';
const bytes = readFileSync('loop.async.wasm');
const DATA_ADDR=16, STACK_BEGIN=1024, STACK_END=8192;
let inst;
const imports={host:{tick:()=>{
  if(globalThis.__u && !globalThis.__did){
    const c=new Int32Array(inst.exports.memory.buffer)[0];
    if(c>=500000){globalThis.__did=true;
      const dv=new DataView(inst.exports.memory.buffer);
      dv.setInt32(DATA_ADDR,STACK_BEGIN,true);dv.setInt32(DATA_ADDR+4,STACK_END,true);
      inst.exports.asyncify_start_unwind(DATA_ADDR);}
  }
}}};
const mod=new WebAssembly.Module(bytes);
globalThis.__u=true;globalThis.__did=false;
inst=new WebAssembly.Instance(mod,imports);
inst.exports.run();
inst.exports.asyncify_stop_unwind();
const dv=new DataView(inst.exports.memory.buffer);
console.log('after unwind: struct ptr=',dv.getInt32(DATA_ADDR,true),'end=',dv.getInt32(DATA_ADDR+4,true));
const snap=new Uint8Array(inst.exports.memory.buffer).slice();

globalThis.__u=false;globalThis.__did=true;
let inst2;
const imp2={host:{tick:()=>{}}};
inst2=new WebAssembly.Instance(mod,imp2);
new Uint8Array(inst2.exports.memory.buffer).set(snap);
const dv2=new DataView(inst2.exports.memory.buffer);
console.log('restored struct ptr=',dv2.getInt32(DATA_ADDR,true),'end=',dv2.getInt32(DATA_ADDR+4,true));
inst2.exports.asyncify_start_rewind(DATA_ADDR);
console.log('state after start_rewind=',inst2.exports.asyncify_get_state());
inst2.exports.run();
console.log('state after run=',inst2.exports.asyncify_get_state(),'counter=',new Int32Array(inst2.exports.memory.buffer)[0]);
