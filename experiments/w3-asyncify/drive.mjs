import { readFileSync } from 'fs';
const bytes = readFileSync('loop.async.wasm');

// Asyncify data region: we reserve a struct in linear memory.
// struct: [current_stack_ptr (i32), end_ptr (i32)] then stack space.
const DATA_ADDR = 16;        // place asyncify struct at addr 16 (after our counter at 0)
const STACK_BEGIN = 1024;
const STACK_END = 8192;

function makeInst(memoryToRestore) {
  let inst;
  const imports = { host: { tick: () => {
    // While running normally, decide whether to unwind.
    const st = inst.exports.asyncify_get_state();
    if (st === 0 && globalThis.__shouldUnwind && !globalThis.__did) {
      const counter = new Int32Array(inst.exports.memory.buffer)[0];
      if (counter >= globalThis.__unwindAt) {
        globalThis.__did = true;
        // write asyncify struct: data[0]=stack begin, data[1]=stack end
        const dv = new DataView(inst.exports.memory.buffer);
        dv.setInt32(DATA_ADDR, STACK_BEGIN, true);
        dv.setInt32(DATA_ADDR + 4, STACK_END, true);
        inst.exports.asyncify_start_unwind(DATA_ADDR);
      }
    }
  }}};
  const mod = new WebAssembly.Module(bytes);
  inst = new WebAssembly.Instance(mod, imports);
  if (memoryToRestore) {
    new Uint8Array(inst.exports.memory.buffer).set(memoryToRestore);
  }
  return inst;
}

// ---- Phase 1: run, unwind mid-loop ----
globalThis.__shouldUnwind = true;
globalThis.__did = false;
globalThis.__unwindAt = 500000;
let inst1 = makeInst(null);
inst1.exports.run();   // returns when unwound
inst1.exports.asyncify_stop_unwind();
const counterAtSnap = new Int32Array(inst1.exports.memory.buffer)[0];
console.log('UNWOUND at counter =', counterAtSnap, 'asyncify_state=', inst1.exports.asyncify_get_state());

// ---- Snapshot entire linear memory ----
const snap = new Uint8Array(inst1.exports.memory.buffer).slice();
console.log('SNAPSHOT bytes =', snap.length);

// ---- Phase 2: fresh instance, blit memory, rewind ----
globalThis.__shouldUnwind = false;   // do not unwind again
globalThis.__did = true;
let inst2 = makeInst(snap);
const counterAfterRestore = new Int32Array(inst2.exports.memory.buffer)[0];
console.log('RESTORED counter (pre-rewind) =', counterAfterRestore);
// start rewind from the same struct, then call the original entry
inst2.exports.asyncify_start_rewind(DATA_ADDR);
inst2.exports.run();   // rewinds back into the loop and continues
inst2.exports.asyncify_stop_rewind && inst2.exports.asyncify_stop_rewind();
const finalCounter = new Int32Array(inst2.exports.memory.buffer)[0];
console.log('FINAL counter after resume =', finalCounter);
console.log(finalCounter === 1000000 ? 'PASS: continued to completion across snapshot/restore' : 'FAIL');
