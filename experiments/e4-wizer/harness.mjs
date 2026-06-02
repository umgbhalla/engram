import { readFileSync } from 'fs';
import { WASI } from 'node:wasi';

const STDLIB = readFileSync('stdlib.js');

function makeImports(getMem) {
  // env.host_* stubs (never called in our test paths) + wasi
  const wasi = new WASI({ version: 'preview1', args: [], env: {},
    returnOnExit: true });
  const env = {
    host_get_timezone_offset: () => 0,
    host_interrupt: () => 0,
    host_promise_rejection: () => {},
    host_module_normalize: () => 0,
    host_module_load: () => 0,
    host_call: () => 0,
  };
  return { wasi, importObject: { env, ...wasi.getImportObject() } };
}

function cstr(mem, ptr) {
  const u8 = new Uint8Array(mem.buffer);
  let end = ptr; while (u8[end] !== 0) end++;
  return Buffer.from(u8.subarray(ptr, end)).toString('utf8');
}

async function load(path) {
  const bytes = readFileSync(path);
  const t0 = process.hrtime.bigint();
  const mod = await WebAssembly.compile(bytes);   // simulates the precompiled CompiledWasm step (once)
  const tCompile = process.hrtime.bigint();
  const { wasi, importObject } = makeImports();
  const inst = await WebAssembly.instantiate(mod, importObject);
  const tInst = process.hrtime.bigint();
  // reactor: initialize
  wasi.initialize(inst);
  const tInit = process.hrtime.bigint();
  return { inst, ex: inst.exports, compileMs: Number(tCompile-t0)/1e6,
    instMs: Number(tInst-tCompile)/1e6, wasiInitMs: Number(tInit-tInst)/1e6 };
}

function writeStr(ex, mem, buf) {
  const ptr = ex.wasm_malloc(buf.length + 1);
  new Uint8Array(mem.buffer).set(buf, ptr);
  new Uint8Array(mem.buffer)[ptr + buf.length] = 0;
  return ptr;
}

function evalJS(ex, mem, code) {
  const buf = Buffer.from(code, 'utf8');
  const cptr = writeStr(ex, mem, buf);
  const fptr = writeStr(ex, mem, Buffer.from('<e>'));
  const valPtr = ex.qjs_eval(cptr, buf.length, fptr, 0);
  const isExc = ex.qjs_is_exception(valPtr);
  const sptr = ex.qjs_get_string(valPtr);
  const s = cstr(mem, sptr);
  ex.qjs_free_cstring(sptr);
  ex.qjs_free_value(valPtr);
  return { isExc, s };
}

const which = process.argv[2];

if (which === 'baseline') {
  // cold create: boot runtime + inject 81KB stdlib, then probe
  const m = await load('qjs_wiz_base.wasm');
  const ex = m.ex, mem = ex.memory;
  const t0 = process.hrtime.bigint();
  ex.qjs_init();
  const tBoot = process.hrtime.bigint();
  // inject stdlib
  const buf = STDLIB;
  const cptr = writeStr(ex, mem, buf);
  const fptr = writeStr(ex, mem, Buffer.from('<stdlib>'));
  const vp = ex.qjs_eval(cptr, buf.length, fptr, 0);
  const exc = ex.qjs_is_exception(vp);
  ex.qjs_free_value(vp);
  const tInject = process.hrtime.bigint();
  const probe1 = evalJS(ex, mem, 'typeof _');
  const probe2 = evalJS(ex, mem, 'String([_.chunk([1,2,3,4],2).length, dayjs("2020-01-15").year()])');
  console.log(JSON.stringify({
    mode:'baseline', compileMs:m.compileMs.toFixed(2), instMs:m.instMs.toFixed(2),
    wasiInitMs:m.wasiInitMs.toFixed(2),
    bootMs:(Number(tBoot-t0)/1e6).toFixed(3),
    injectMs:(Number(tInject-tBoot)/1e6).toFixed(3),
    injectExc:exc, probe_typeof_: probe1.s, probe_funcs: probe2.s,
  }, null, 2));
}

if (which === 'baked') {
  // resume from baked: NO qjs_init, NO inject. heap already live.
  const m = await load('qjs_baked.wasm');
  const ex = m.ex, mem = ex.memory;
  // immediately probe — globals should already exist
  const t0 = process.hrtime.bigint();
  const probe1 = evalJS(ex, mem, 'typeof _');
  const probe2 = evalJS(ex, mem, 'String([_.chunk([1,2,3,4],2).length, dayjs("2020-01-15").year()])');
  const tProbe = process.hrtime.bigint();
  console.log(JSON.stringify({
    mode:'baked', compileMs:m.compileMs.toFixed(2), instMs:m.instMs.toFixed(2),
    wasiInitMs:m.wasiInitMs.toFixed(2),
    bootMs:'0 (skipped)', injectMs:'0 (skipped)',
    firstProbeMs:(Number(tProbe-t0)/1e6).toFixed(3),
    probe_typeof_: probe1.s, probe_funcs: probe2.s,
  }, null, 2));
}
