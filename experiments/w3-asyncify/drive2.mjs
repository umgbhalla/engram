import { readFileSync } from 'fs';
const bytes = readFileSync('loop.async.wasm');
const mod = new WebAssembly.Module(bytes);
const DATA_ADDR=16, STACK_BEGIN=1024, STACK_END=8192;

function build(restore, mode){
  // mode: 'unwind' or 'rewind'
  let inst, did=false;
  const imports={host:{tick:()=>{
    const st=inst.exports.asyncify_get_state();
    if(st===2){ // rewinding: we are at the suspend point, stop the rewind
      inst.exports.asyncify_stop_rewind();
      return;
    }
    if(mode==='unwind' && st===0 && !did){
      const c=new Int32Array(inst.exports.memory.buffer)[0];
      if(c>=500000){did=true;
        const dv=new DataView(inst.exports.memory.buffer);
        dv.setInt32(DATA_ADDR,STACK_BEGIN,true);dv.setInt32(DATA_ADDR+4,STACK_END,true);
        inst.exports.asyncify_start_unwind(DATA_ADDR);}
    }
  }}};
  inst=new WebAssembly.Instance(mod,imports);
  if(restore) new Uint8Array(inst.exports.memory.buffer).set(restore);
  return inst;
}

const i1=build(null,'unwind');
i1.exports.run();
i1.exports.asyncify_stop_unwind();
console.log('unwound at',new Int32Array(i1.exports.memory.buffer)[0]);
const snap=new Uint8Array(i1.exports.memory.buffer).slice();

const i2=build(snap,'rewind');
i2.exports.asyncify_start_rewind(DATA_ADDR);
i2.exports.run();
const fin=new Int32Array(i2.exports.memory.buffer)[0];
console.log('final',fin, fin===1000000?'PASS':'FAIL');
