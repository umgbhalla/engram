// W5 CF-viability: two QuickJS instances coexisting in one isolate (the handoff moment).
// In a DO, compaction = instantiate vm2 while vm1 still alive, transfer, dispose vm1.
// Both instances share the SAME CompiledWasm Module (no runtime compile) — workerd-legal.
import { QuickJS } from '../e6-oplog/node_modules/quickjs-wasi/dist/index.js';
import { readFileSync } from 'node:fs';
const WASM = readFileSync(new URL('../e6-oplog/node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
const mod = await WebAssembly.compile(WASM); // ONE module, reused (== CompiledWasm import in workerd)
const vm1 = await QuickJS.create(mod);
vm1.evalCode('globalThis.x = 111;');
const vm2 = await QuickJS.create(mod); // coexists
vm2.evalCode('globalThis.x = 222;');
const both = { vm1_x: vm1.dump(vm1.evalCode('x')), vm2_x: vm2.dump(vm2.evalCode('x')), separateMemory: vm1.exports.memory !== vm2.exports.memory };
vm1.dispose(); vm2.dispose();
// peak transient: during handoff both buffers are live simultaneously.
console.log(JSON.stringify({ both, note: "transient peak = bloatedBuf + freshBuf during handoff (matters for the OOM ceiling)" }, null, 2));
