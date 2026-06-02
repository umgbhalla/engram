// Live-heap snapshot round-trip harness for Rust-driven QuickJS (rquickjs) on wasm32-wasip1.
// Instance A: setup() -> creates QuickJS runtime, evals closure+pending-promise+global var.
//   poke_inc() twice (101,102), read_x() (42).
// Snapshot: dump FULL linear memory (memory.buffer) to a file.
// Instance B (FRESH): blit snapshot bytes back into its memory, then WITHOUT setup():
//   reattach(), poke_inc() (should be 103 -> closure private state survived),
//   read_x() (42 -> global survived), resolve_promise() (7 -> pending promise survived & resolved).
import { readFileSync, writeFileSync } from 'node:fs';
import { WASI } from 'node:wasi';

const WASM = new URL('./snapshotter/target/wasm32-wasip1/release/snapshotter.wasm', import.meta.url);
const bytes = readFileSync(WASM);
const mod = await WebAssembly.compile(bytes);

function makeWasi() {
  return new WASI({ version: 'preview1', args: [], env: {}, preopens: {} });
}

async function instantiate() {
  const wasi = makeWasi();
  const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  // Initialize WASI/ctors WITHOUT running main: initialize() runs _initialize if present,
  // else is a no-op; active data segments are already applied at instantiation.
  try { wasi.initialize(inst); } catch (e) { /* command module: ignore */ }
  return inst;
}

const out = {};

// ---------- Instance A ----------
const a = await instantiate();
const setupRc = a.exports.setup();
out.setup_rc = setupRc;
out.A_inc1 = a.exports.poke_inc();
out.A_inc2 = a.exports.poke_inc();
out.A_x = a.exports.read_x();

// ---------- Snapshot ----------
const memA = a.exports.memory;
const t0 = process.hrtime.bigint();
const snap = Buffer.from(new Uint8Array(memA.buffer)); // full copy
const t1 = process.hrtime.bigint();
writeFileSync(new URL('./snapshot.bin', import.meta.url), snap);
out.snapshot_bytes = snap.length;
out.snapshot_dump_ms = Number(t1 - t0) / 1e6;

// drop A
// ---------- Instance B (fresh) ----------
const b = await instantiate();
const memB = b.exports.memory;
// grow B to match A if needed
const pages = (memB.buffer.byteLength) >> 16;
const needPages = (snap.length >> 16);
if (needPages > pages) memB.grow(needPages - pages);
const tr0 = process.hrtime.bigint();
new Uint8Array(memB.buffer).set(snap); // blit
const tr1 = process.hrtime.bigint();
out.restore_blit_ms = Number(tr1 - tr0) / 1e6;

out.B_reattach = b.exports.reattach(); // 1 => thread_local Runtime survived the blit
out.B_inc3 = b.exports.poke_inc();     // expect 103
out.B_x = b.exports.read_x();          // expect 42
out.B_promise = b.exports.resolve_promise(); // expect 7

// ---------- Verdict ----------
out.PASS =
  out.A_inc1 === 101 && out.A_inc2 === 102 && out.A_x === 42 &&
  out.B_reattach === 1 && out.B_inc3 === 103 && out.B_x === 42 && out.B_promise === 7;

console.log(JSON.stringify(out, null, 2));
