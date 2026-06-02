import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
const mod = await WebAssembly.compile(readFileSync(new URL('./snapshotter/target/wasm32-wasip1/release/snapshotter.wasm', import.meta.url)));
const wasi = new WASI({ version: 'preview1' });
const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
try { wasi.initialize(inst); } catch {}
// NO blit, NO setup: reattach must be 0, poke must be the no-runtime sentinel
console.log(JSON.stringify({ reattach_no_blit: inst.exports.reattach(), poke_no_runtime: inst.exports.poke_inc() }));
