// Adversarial red-team against the Rust kernel slice.
// Mirrors the attack classes the JS kernels (glue.js) face.
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
  const enc = new TextEncoder().encode(s);
  const off = i.exports.scratch_ptr();
  if (enc.length > 65536) throw new Error('src exceeds scratch (host-side guard)');
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
  const [off, len] = writeStr(i, src);
  i.exports.eval_cell(off, len, BigInt(budget));
  return readResult(i);
}

const results = [];
function record(name, fn) {
  const start = Date.now();
  let r;
  try { r = fn(); } catch (e) { r = { THREW: String(e && e.message || e) }; }
  const ms = Date.now() - start;
  results.push({ name, ms, ...r });
}

// ---- sandbox-escape attempts (VM-side) ----
const s = await inst(); s.exports.create(0n, 1n);
function probe(i, src) {
  const r = evalCell(i, src);
  // SURVIVED if it errored OR returned a benign value; BREACH if it reached a host capability
  return { ok: r.ok, value: r.value, error: r.error, tripped: r.tripped };
}

record('escape:read-file', () => probe(s, "(()=>{try{return typeof require!=='undefined'?'require!':'no-require'}catch(e){return 'err:'+e}})()"));
record('escape:process', () => probe(s, "typeof process"));
record('escape:globalThis-enum', () => probe(s, "Object.getOwnPropertyNames(globalThis).join(',')"));
record('escape:wasi-import', () => probe(s, "typeof fd_write + ',' + typeof __wasi_fd_write"));
record('escape:Function-ctor', () => probe(s, "(function(){return this})().constructor===Object?'sealed-ish':'F'"));
record('escape:eval-host', () => probe(s, "typeof globalThis.__now + ',' + typeof globalThis.__rand"));
record('escape:import', () => probe(s, "(async()=>{try{await import('node:fs');return 'IMPORTED'}catch(e){return 'blocked'}})(); 'sync-done'"));
record('escape:scratch-peek', () => probe(s, "typeof scratch_ptr + ',' + typeof memory"));
// Try to clobber the injected host fns then verify determinism still derives from them
record('escape:clobber-now', () => probe(s, "try{globalThis.__now=()=>999;Date.now()}catch(e){'caught:'+e}"));
record('escape:stack-bomb', () => probe(s, "(function r(n){return r(n+1)})(0)")); // recursion -> stack guard

// ---- resource bombs ----
const b = await inst(); b.exports.create(0n, 1n);
record('bomb:infinite-loop', () => { const r = evalCell(b, "while(true){}", 50000); return { tripped: r.tripped, ok: r.ok }; });
record('bomb:recover-after-loop', () => { const r = evalCell(b, "1+1"); return { value: r.value, ok: r.ok }; });
record('bomb:tight-counter', () => { const r = evalCell(b, "var s=0;for(;;){s++}", 100000); return { tripped: r.tripped, ok: r.ok }; });
record('bomb:string-grow', () => { const r = evalCell(b, "let x='a';while(true){x+=x}x.length", 5_000_000); return { tripped: r.tripped, ok: r.ok, error: r.error }; });
record('bomb:array-alloc', () => { const r = evalCell(b, "let a=[];while(true){a.push(new Array(100000).fill(0))}a.length", 5_000_000); return { tripped: r.tripped, ok: r.ok, error: r.error }; });
record('bomb:typed-array-huge', () => { const r = evalCell(b, "new Uint8Array(1024*1024*1024).length", 5_000_000); return { tripped: r.tripped, ok: r.ok, error: r.error }; });
record('bomb:recover-after-alloc', () => { const r = evalCell(b, "2+2"); return { value: r.value, ok: r.ok }; });
record('bomb:memory-limit-probe', () => { return { used: Number(b.exports.used_heap()) }; });

// ---- tampered-snapshot round-trip ----
// Build a good snapshot then corrupt it before blit-restore; kernel must not crash the process.
function makeSnapshot() {
  const a = inst();
  return a;
}
record('snap:tamper-restore', () => {
  // synchronous: we already have b as a live instance; snapshot it
  const snap = Buffer.from(new Uint8Array(b.exports.memory.buffer));
  // tamper: zero a big middle region (likely inside QuickJS heap structures)
  const mid = Math.floor(snap.length / 2);
  for (let k = mid; k < mid + 65536 && k < snap.length; k++) snap[k] = 0xFF;
  return { tampered_bytes: 65536, snap_len: snap.length };
});

// async tampered restore (needs fresh instance)
const tamperResult = await (async () => {
  const src = Buffer.from(new Uint8Array(b.exports.memory.buffer));
  const corrupt = Buffer.from(src);
  const mid = Math.floor(corrupt.length / 2);
  for (let k = mid; k < mid + 131072 && k < corrupt.length; k++) corrupt[k] = 0x41;
  const t = await inst();
  const memT = t.exports.memory;
  const need = corrupt.length >> 16, have = memT.buffer.byteLength >> 16;
  if (need > have) memT.grow(need - have);
  let processAlive = true, outcome = '';
  try {
    new Uint8Array(memT.buffer).set(corrupt);
    const re = t.exports.reattach();
    // now try to eval on the corrupted heap
    try { const r = evalCell(t, "globalThis.x"); outcome = 'eval-ok:' + JSON.stringify(r); }
    catch (e) { outcome = 'eval-threw:' + String(e.message || e); }
  } catch (e) { outcome = 'restore-threw:' + String(e.message || e); }
  return { processAlive, outcome };
})();
results.push({ name: 'snap:corrupt-heap-restore', ...tamperResult });

// truncated snapshot restore
const truncResult = await (async () => {
  const src = Buffer.from(new Uint8Array(b.exports.memory.buffer));
  const trunc = src.subarray(0, Math.floor(src.length / 2)); // half image
  const t = await inst();
  const memT = t.exports.memory;
  let outcome = '';
  try {
    new Uint8Array(memT.buffer).set(trunc);
    t.exports.reattach();
    try { const r = evalCell(t, "1+1"); outcome = 'eval-ok:' + JSON.stringify(r); }
    catch (e) { outcome = 'eval-threw:' + String(e.message || e); }
  } catch (e) { outcome = 'restore-threw:' + String(e.message || e); }
  return { outcome };
})();
results.push({ name: 'snap:truncated-restore', ...truncResult });

// oversized scratch source (host-side guard)
record('host:oversized-src', () => {
  const big = 'x'.repeat(70000);
  try { evalCell(s, big); return { guard: 'NOT-TRIPPED-LEAK' }; }
  catch (e) { return { guard: 'tripped', msg: String(e.message || e) }; }
});

console.log(JSON.stringify({ results }, null, 2));
console.log('PROCESS_SURVIVED_TO_END');
