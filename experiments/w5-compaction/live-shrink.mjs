// W5 realistic case: session holds LARGE live heap, then shrinks to MODERATE live heap.
// Does fresh-instance compaction reclaim the buffer high-water-mark while preserving
// the surviving live data? And does it beat the dump-ceiling?
import { QuickJS } from '../e6-oplog/node_modules/quickjs-wasi/dist/index.js';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const WASM = readFileSync(new URL('../e6-oplog/node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
const mod = await WebAssembly.compile(WASM);
const MB = (b)=>(b/1048576).toFixed(2)+'MB';
const buf=(vm)=>vm.exports.memory.buffer.byteLength;
const used=(vm)=>vm.getMemoryUsage().memoryUsedSize;
const gz=(vm)=>gzipSync(QuickJS.serializeSnapshot(vm.snapshot()),{level:6}).length;

const vm = await QuickJS.create(mod);
// Phase A: grow to LARGE live state (a big retained dataset)
vm.evalCode(`globalThis.keep = []; for(let i=0;i<300000;i++){ keep.push({id:i, v:"payload-"+i}); } keep.length;`);
const A = { buf: buf(vm), used: used(vm), gz: gz(vm) };

// Phase B: shrink live state — keep only 1000 records (simulates a windowed buffer)
vm.evalCode(`globalThis.keep = keep.slice(0,1000); keep.length;`);
try { vm.evalCode('if(typeof gc==="function")gc();'); } catch {}
const B = { buf: buf(vm), used: used(vm), gz: gz(vm) }; // buffer monotonic -> still huge

// Phase C: COMPACT — serialize live `keep` into fresh instance
const data = vm.dump(vm.evalCode('JSON.stringify(globalThis.keep)'));
const lenBefore = vm.dump(vm.evalCode('keep.length'));
const sample = vm.dump(vm.evalCode('JSON.stringify(keep[999])'));
vm.dispose();

const vm2 = await QuickJS.create(mod);
vm2.evalCode(`globalThis.keep = JSON.parse(${JSON.stringify(data)});`);
const C = { buf: buf(vm2), used: used(vm2), gz: gz(vm2) };
const fidelity = {
  len: vm2.dump(vm2.evalCode('keep.length')),
  sampleMatch: vm2.dump(vm2.evalCode(`JSON.stringify(keep[999]) === ${JSON.stringify(sample)}`)),
};
vm2.dispose();

const DUMP_CEILING = 18*1048576; // v0.7 MAX_DUMP_BUFFER_BYTES
console.log(JSON.stringify({
  A_large: { buf: MB(A.buf), used: MB(A.used), gz: MB(A.gz), overCeiling: A.buf > DUMP_CEILING },
  B_shrunkLiveButMonotonicBuf: { buf: MB(B.buf), used: MB(B.used), gz: MB(B.gz), overCeiling: B.buf > DUMP_CEILING, wedged: B.buf > DUMP_CEILING },
  C_compacted: { buf: MB(C.buf), used: MB(C.used), gz: MB(C.gz), overCeiling: C.buf > DUMP_CEILING },
  reclaim_buf_pct: +(100*(1-C.buf/B.buf)).toFixed(1),
  unwedged: B.buf > DUMP_CEILING && C.buf <= DUMP_CEILING,
  fidelity, lenBefore,
}, null, 2));
