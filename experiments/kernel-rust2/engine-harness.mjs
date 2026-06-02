// Validate the engine ABI + snapshot/restore + guards + host calls locally (Node WASI).
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

const WASM = new URL('./engine/target/wasm32-wasip1/release/engine.wasm', import.meta.url);
const mod = await WebAssembly.compile(readFileSync(WASM));

function newInst() {
  const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {} });
  const i = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  try { wasi.initialize(i); } catch {}
  return i;
}

const HOST_CALL = 1;

function writeScratch(i, s) {
  const enc = new TextEncoder().encode(s);
  const off = i.exports.scratch_ptr();
  new Uint8Array(i.exports.memory.buffer).set(enc, off);
  return enc.length;
}
function readResult(i) {
  const ptr = i.exports.result_ptr(), len = i.exports.result_len();
  return JSON.parse(new TextDecoder().decode(new Uint8Array(i.exports.memory.buffer, ptr, len).slice()));
}
function readHostCall(i) {
  const ptr = i.exports.pending_host_call_ptr(), len = i.exports.pending_host_call_len();
  return JSON.parse(new TextDecoder().decode(new Uint8Array(i.exports.memory.buffer, ptr, len).slice()));
}

// drive an eval to completion, handling host.fetch (mocked) parks.
function evalCell(i, src, { budget = 2_000_000, growCapPages = 256 } = {}) {
  const n = writeScratch(i, src);
  let status = i.exports.eval_begin(i.exports.scratch_ptr(), n, BigInt(budget), growCapPages);
  let guard = 0;
  while (status === HOST_CALL && guard++ < 50) {
    const req = readHostCall(i);
    let res;
    if (req.name === 'fetch') {
      res = { ok: true, value: { status: 200, ok: true, body: 'MOCK:' + req.args[0] } };
    } else {
      res = { ok: false, error: 'unknown host fn ' + req.name };
    }
    const rn = writeScratch(i, JSON.stringify(res));
    status = i.exports.eval_resume(i.exports.scratch_ptr(), rn);
  }
  return readResult(i);
}

const out = {};
const a = newInst();
a.exports.create(0n, 42n);

out.det1 = evalCell(a, 'Date.now()');
out.det2 = evalCell(a, 'Date.now()');
out.rand = evalCell(a, 'Math.random()');
out.arith = evalCell(a, '1+2*3');
out.str = evalCell(a, '"hi"+"!"');
// value-preview (the FAFO fix): Map/Set/Date/RegExp rendered, not {}
out.map = evalCell(a, 'new Map([["a",1],["b",2]])');
out.set = evalCell(a, 'new Set([1,2,3])');
out.date = evalCell(a, 'new Date(1700000000000)');
out.regex = evalCell(a, '/ab+c/gi');
out.obj = evalCell(a, '({a:1,b:[1,2,{c:3}]})');
out.err = evalCell(a, 'throw new TypeError("boom")');
out.console = evalCell(a, 'console.log("x",{a:1}); 7');
// stateful
evalCell(a, 'globalThis.x = 42;');
evalCell(a, 'let _n=100; globalThis.inc=function(){_n+=1;return _n;};');
out.inc1 = evalCell(a, 'globalThis.inc()');
out.inc2 = evalCell(a, 'globalThis.inc()');
// pending promise
evalCell(a, 'globalThis.pResult=null; globalThis.p=new Promise(r=>{globalThis._res=()=>r(7);}); globalThis.p.then(v=>{globalThis.pResult=v;});');
// host.kv (in-engine)
out.kvset = evalCell(a, 'await host.kv("set","k1","v1")');
out.kvget = evalCell(a, 'await host.kv("get","k1")');
out.kvkeys = evalCell(a, 'await host.kv("keys")');
// host.fetch (shim round-trip, mocked)
out.fetch = evalCell(a, '(await host.fetch("https://x")).body');

out.usedHeap = Number(a.exports.used_heap());
out.bufferBytes = Number(a.exports.buffer_bytes());
out.clockCalls = Number(a.exports.clock_calls());
out.rngCalls = Number(a.exports.rng_calls());

// kv export
const kvPtr = a.exports.kv_export_ptr(), kvLen = a.exports.kv_export_len();
out.kvExport = new TextDecoder().decode(new Uint8Array(a.exports.memory.buffer, kvPtr, kvLen).slice());

// SNAPSHOT
const snap = Buffer.from(new Uint8Array(a.exports.memory.buffer));
out.snapBytes = snap.length;
const ccA = Number(a.exports.clock_calls()), rcA = Number(a.exports.rng_calls());

// RESTORE into fresh instance
const b = newInst();
const needPages = snap.length >> 16, havePages = b.exports.memory.buffer.byteLength >> 16;
if (needPages > havePages) b.exports.memory.grow(needPages - havePages);
new Uint8Array(b.exports.memory.buffer).set(snap);
out.reattach = b.exports.reattach();
b.exports.set_counters(BigInt(ccA), BigInt(rcA));
out.B_inc3 = evalCell(b, 'globalThis.inc()');       // 103
out.B_x = evalCell(b, 'globalThis.x');              // 42
evalCell(b, 'globalThis._res();');
out.B_pResult = evalCell(b, 'globalThis.pResult');  // 7
out.B_kvget = evalCell(b, 'await host.kv("get","k1")'); // v1 survived
out.B_clock = evalCell(b, 'Date.now()');

// GUARDS
const g = newInst(); g.exports.create(0n, 7n);
out.G_loop = evalCell(g, 'var s=0; while(true){s++;} s', { budget: 5000 });
out.G_recover = evalCell(g, '1+1');
// buffer-growth tripwire: fast-array bomb
const g2 = newInst(); g2.exports.create(0n, 7n);
out.G_bomb = evalCell(g2, 'let a=[]; while(true){ a.push(new Array(100000).fill(7)); }', { budget: 50_000_000, growCapPages: 64 });
out.G_bomb_recover = evalCell(g2, '40+2');

// determinism: two fresh same-seed
const d1 = newInst(); d1.exports.create(0n, 99n);
const d2 = newInst(); d2.exports.create(0n, 99n);
const s1 = [evalCell(d1,'Math.random()+":"+Date.now()').value, evalCell(d1,'Math.random()').value];
const s2 = [evalCell(d2,'Math.random()+":"+Date.now()').value, evalCell(d2,'Math.random()').value];
out.detMatch = JSON.stringify(s1) === JSON.stringify(s2);

console.log(JSON.stringify(out, null, 2));

out.PASS =
  out.det1.value === 1700000000000 && out.det2.value === 1700000000001 &&
  out.arith.value === 7 && out.str.value === 'hi!' &&
  out.map.valuePreview.includes('Map(2)') && out.map.valuePreview.includes('=>') &&
  out.set.valuePreview.includes('Set(3)') &&
  out.date.valuePreview.includes('2023') &&
  out.regex.valuePreview === '/ab+c/gi' &&
  out.err.ok === false && out.err.error.name === 'TypeError' &&
  out.console.logs.length === 1 && out.console.value === 7 &&
  out.inc1.value === 101 && out.inc2.value === 102 &&
  out.kvget.value === 'v1' &&
  out.fetch.value === 'MOCK:https://x' &&
  out.reattach === 1 && out.B_inc3.value === 103 && out.B_x.value === 42 &&
  out.B_pResult.value === 7 && out.B_kvget.value === 'v1' &&
  out.G_loop.error && out.G_loop.error.name === 'TimeoutError' && out.G_recover.value === 2 &&
  out.G_bomb.error && out.G_bomb.error.name === 'MemoryLimitError' && out.G_bomb_recover.value === 42 &&
  out.detMatch === true;

console.log('\nPASS =', out.PASS);
process.exit(out.PASS ? 0 : 1);
