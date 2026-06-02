// Track-2 harness: ALL kernel logic is in Rust. This harness only provides the
// WASI host shim + the literal memory.buffer blit (the snapshot substrate).
import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

const WASM = new URL('./target/wasm32-wasip1/release/rustkernel.wasm', import.meta.url);
const mod = await WebAssembly.compile(readFileSync(WASM));

async function inst() {
  const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {} });
  const i = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  try { wasi.initialize(i); } catch {}
  return i;
}

function writeStr(i, s) {
  // write source into the dedicated exported SCRATCH buffer (no offset guessing).
  const enc = new TextEncoder().encode(s);
  const off = i.exports.scratch_ptr();
  new Uint8Array(i.exports.memory.buffer).set(enc, off);
  return [off, enc.length];
}
function readResult(i) {
  const ptr = i.exports.result_ptr();
  const len = i.exports.result_len();
  const bytes = new Uint8Array(i.exports.memory.buffer, ptr, len);
  return JSON.parse(new TextDecoder().decode(bytes.slice()));
}
function evalCell(i, src, budget = 1_000_000) {
  // ensure room: grow so the top 64KB scratch is valid
  const [off, len] = writeStr(i, src);
  i.exports.eval_cell(off, len, BigInt(budget));
  return readResult(i);
}

const out = {};

// ---------- Instance A: create + eval cells ----------
const a = await inst();
out.create = a.exports.create(1000n, 42n);

// (d) determinism: seeded clock + RNG via Date.now / Math.random (Rust-injected)
out.A_clock = evalCell(a, "Date.now()");          // 1000
out.A_clock2 = evalCell(a, "Date.now()");         // 1001
out.A_rand = evalCell(a, "Math.random()");        // deterministic

// (snapshot subjects) closure private state + pending promise + global var
evalCell(a, "globalThis.x = 42;");
evalCell(a, "let _n=100; globalThis.inc=function(){_n+=1;return _n;};");
out.A_inc1 = evalCell(a, "globalThis.inc()");     // 101
out.A_inc2 = evalCell(a, "globalThis.inc()");     // 102
evalCell(a, "globalThis.pResult=null; globalThis.p=new Promise(r=>{globalThis._res=()=>r(7);}); globalThis.p.then(v=>{globalThis.pResult=v;});");
out.A_x = evalCell(a, "globalThis.x");            // 42
out.A_usedHeap = Number(a.exports.used_heap());

// ---------- SNAPSHOT: full linear memory (Rust state + QuickJS heap) ----------
const memA = a.exports.memory;
const t0 = process.hrtime.bigint();
const snap = Buffer.from(new Uint8Array(memA.buffer));
const t1 = process.hrtime.bigint();
out.snapshot_bytes = snap.length;
out.snapshot_dump_ms = Number(t1 - t0) / 1e6;

// ---------- Instance B (FRESH): blit + reattach, NO create/eval-setup ----------
const b = await inst();
const memB = b.exports.memory;
const needPages = snap.length >> 16;
const havePages = memB.buffer.byteLength >> 16;
if (needPages > havePages) memB.grow(needPages - havePages);
const tr0 = process.hrtime.bigint();
new Uint8Array(memB.buffer).set(snap);
const tr1 = process.hrtime.bigint();
out.restore_blit_ms = Number(tr1 - tr0) / 1e6;

out.B_reattach = b.exports.reattach();            // 1
out.B_inc3 = evalCell(b, "globalThis.inc()");     // 103 (closure private survived)
out.B_x = evalCell(b, "globalThis.x");            // 42 (global survived)
evalCell(b, "globalThis._res();");                // fire resolve; .then runs on microtask drain
out.B_resolve = evalCell(b, "globalThis.pResult"); // 7 (pending promise survived+resolved)
// determinism continues from blitted Rust-side clock/RNG state
out.B_clock = evalCell(b, "Date.now()");          // 1002 (continues from A's 1001)

// ---------- GUARD: interrupt budget trips on infinite loop ----------
const g = await inst();
g.exports.create(0n, 7n);
const tg0 = process.hrtime.bigint();
out.GUARD_loop = evalCell(g, "var s=0; while(true){ s++; } s", 2000); // must trip
const tg1 = process.hrtime.bigint();
out.GUARD_trip_ms = Number(tg1 - tg0) / 1e6;
// socket-alive equivalent: next eval works after a trip
out.GUARD_recover = evalCell(g, "1+1");           // 2

// ---------- determinism: two fresh instances, same seed => same sequence ----------
const d1 = await inst(); d1.exports.create(0n, 99n);
const d2 = await inst(); d2.exports.create(0n, 99n);
const seq1 = [evalCell(d1,"Math.random()+':'+Date.now()").value, evalCell(d1,"Math.random()+':'+Date.now()").value];
const seq2 = [evalCell(d2,"Math.random()+':'+Date.now()").value, evalCell(d2,"Math.random()+':'+Date.now()").value];
out.DET_match = JSON.stringify(seq1) === JSON.stringify(seq2);
out.DET_seq = seq1;

out.PASS =
  out.A_clock.value === "1000" && out.A_clock2.value === "1001" &&
  out.A_inc1.value === "101" && out.A_inc2.value === "102" && out.A_x.value === "42" &&
  out.B_reattach === 1 && out.B_inc3.value === "103" && out.B_x.value === "42" &&
  out.B_resolve.value === "7" && out.B_clock.value === "1002" &&
  out.GUARD_loop.tripped === true && out.GUARD_recover.value === "2" &&
  out.DET_match === true;

console.log(JSON.stringify(out, null, 2));
