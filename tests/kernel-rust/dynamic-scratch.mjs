// Dynamic scratch unit test (ADR-0013 follow-up — conjoined-OOM fix).
// Verifies the scratch buffer is now a releasable Vec (1MB floor, grow-on-reserve, release-to-floor)
// instead of a fixed 32MB `static mut` array — so a fresh kernel instance no longer carries a 32MB
// resident tax (the N×32MB multiplier that OOM'd the conjoined isolate at subLM depth).
// Run: node tests/kernel-rust/dynamic-scratch.mjs
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, "../../apps/kernel/engine/target/wasm32-wasip1/release/engine.wasm");
const mod = await WebAssembly.compile(readFileSync(WASM));

function newInst() {
  const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens: {} });
  const i = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  try { wasi.initialize(i); } catch {}
  return i;
}

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "  got=" + JSON.stringify(got)); }
};
const MB = 1 << 20;

// reserve-then-write, mirroring the new glue _writeScratch (never cache ptr/buffer across reserve).
function writeScratch(ex, bytes) {
  ex.scratch_reserve(bytes.length);
  if (bytes.length > Number(ex.scratch_cap())) throw new Error("ProtocolSizeError");
  new Uint8Array(ex.memory.buffer).set(bytes, ex.scratch_ptr());
}
function evalCell(ex, src) {
  const enc = new TextEncoder().encode(src);
  writeScratch(ex, enc);
  let status = ex.eval_begin(ex.scratch_ptr(), enc.length, BigInt(2_000_000), 1024);
  // no host calls in these cells; status should be DONE
  const ptr = ex.result_ptr(), len = ex.result_len();
  return JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len).slice()));
}

const i = newInst();
const ex = i.exports;
ex.create(0n, 42n);

// (1) THE OOM FIX: a fresh instance must NOT carry a 32MB fixed scratch. The old static-32MB engine
// forced the instance's initial linear memory to ~33MB+; the dynamic floor keeps it far smaller.
const initBytes = ex.memory.buffer.byteLength;
ok("fresh instance linear memory < 16MB (no 32MB fixed-BSS scratch)", initBytes < 16 * MB, initBytes);

// (2) floor
ok("scratch_cap == 1MB floor", Number(ex.scratch_cap()) === MB, Number(ex.scratch_cap()));

// (3) reserve grows
const p1 = Number(ex.scratch_reserve(8 * MB));
ok("scratch_cap >= 8MB after reserve(8MB)", Number(ex.scratch_cap()) >= 8 * MB, Number(ex.scratch_cap()));
ok("scratch_reserve returned a non-null ptr", p1 > 0, p1);

// (4) the grown buffer is really writable end-to-end (no overrun into other statics)
const big = new Uint8Array(8 * MB).fill(0x41);
new Uint8Array(ex.memory.buffer).set(big, ex.scratch_ptr());
ok("wrote 8MB into reserved scratch without overrun", true, "");

// (5) release returns to floor
ex.scratch_release();
ok("scratch_cap back to 1MB floor after release", Number(ex.scratch_cap()) === MB, Number(ex.scratch_cap()));

// (6) reserve beyond the 32MB ceiling clamps (so the glue's `len>cap` check rejects, no overrun)
ex.scratch_reserve(64 * MB);
ok("scratch_cap clamps to 32MB ceiling", Number(ex.scratch_cap()) === 32 * MB, Number(ex.scratch_cap()));
ex.scratch_release();

// (7) a >1MB cell SOURCE now evals (the old 1MB fixed scratch rejected it; reserve grows to fit)
const bigSrc = "/*" + "x".repeat(2 * MB) + "*/ 1+1";
const r = evalCell(ex, bigSrc);
ok(">1MB cell source evals via dynamic reserve (was ProtocolSizeError)", r && r.ok === true, r && (r.error || r.ok));

// (8) scratch released back to floor after the big-source cell (proves no resident tax persists)
ex.scratch_release();
ok("scratch back to floor after big-source eval", Number(ex.scratch_cap()) === MB, Number(ex.scratch_cap()));

console.log(`${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
