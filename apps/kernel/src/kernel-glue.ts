// kernel-glue.ts — the THIN JS shim that the Rust DO (lib.rs) binds to.
//
// Authored in TS; esbuild bundles this to src/kernel-glue.mjs (the path wasm-bindgen's
// `#[wasm_bindgen(module = "/src/kernel-glue.mjs")]` reads + worker-build copies into its
// snippet dir) BEFORE worker-build runs. The REPL-persistence transform is imported from
// ./repl-transform.ts and INLINED into the single .mjs output by esbuild — so the runtime
// module remains a single file with no sibling import (which would not resolve in the
// worker-build snippet dir).
//
// IMPORTANT: this file contains NO kernel business logic. All eval / value-preview / guards /
// determinism / host-boundary logic lives in the Rust ENGINE wasm (src/engine.wasm). This shim
// only provides:
//   * the WASI host imports the engine needs (wasm32-wasip1),
//   * the literal memory.buffer BLIT (snapshot substrate) + gzip,
//   * the engine instantiate + the host-effect IMPLEMENTATION the engine can't do from inside
//     wasip1 (host.fetch -> DO-side fetch with allowlist).
//
// The engine ABI (C exports) is documented in engine/src/lib.rs.

import { transformCell } from "./repl-transform.js";
import tsBlankSpace from "ts-blank-space";

// stripTypes: erase TS type syntax to whitespace (length-preserving, no codegen) so the
// downstream depth-0 declaration tokenizer in repl-transform.ts still sees the same offsets.
// Pure host-side source fn — adds NO entropy (determinism + engine-hash unchanged). The optional
// onError callback fires once per UN-ERASABLE TS construct (enum / namespace / parameter
// properties); we collect their SyntaxKind numbers and throw so evalCode can reject the cell with
// a typed TypeScriptError (socket stays alive). On a valid-JS or plain-TS cell this is a near
// no-op (type annotations -> spaces, which the tokenizer already skips as trivia).
function stripTypes(src: string): string {
  const errKinds: number[] = [];
  const out = tsBlankSpace(src, (node) => {
    errKinds.push((node as { kind: number }).kind);
  });
  if (errKinds.length) {
    const e = new Error(
      "un-erasable TypeScript construct(s) (SyntaxKind " + errKinds.join(",") +
        "); enum / namespace / parameter-properties are not supported"
    );
    (e as Error & { name: string }).name = "TypeScriptError";
    throw e;
  }
  return out;
}

// ---- engine C-ABI export surface (the precompiled rquickjs engine.wasm) ----
interface EngineExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  create(clockSeed: bigint, rngSeed: bigint): void;
  reattach(): number;
  set_counters(clockCalls: bigint, rngCalls: bigint): void;
  clock_calls(): number | bigint;
  rng_calls(): number | bigint;
  buffer_bytes(): number | bigint;
  used_heap(): number | bigint;
  scrub_arena(budgetMb: number): number | bigint;
  scratch_ptr(): number;
  result_ptr(): number;
  result_len(): number;
  pending_host_call_ptr(): number;
  pending_host_call_len(): number;
  kv_export_ptr(): number;
  kv_export_len(): number;
  kv_import(ptr: number, len: number): void;
  eval_begin(ptr: number, len: number, budget: bigint, growCapPages: number): number;
  eval_resume(ptr: number, len: number): number;
}

interface WasiImports {
  [k: string]: (...args: number[]) => number | void;
}
interface WasiCtl {
  wasi: WasiImports;
  setMem: (m: WebAssembly.Memory) => void;
}

// A host call request emitted by the engine (e.g. {name:"fetch", args:[...]}).
interface HostCall {
  name: string;
  args?: unknown[];
}
// A host call result fed back to the engine.
type HostResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

interface KernelConfig {
  rngSeed?: number;
  typescript?: boolean;
  fetch?: boolean | string[];
  modules?: boolean | string[];
  cellBudgetTicks?: number;
  cellGrowCapPages?: number;
}

interface RestoreTimings {
  gunzipMs?: number;
  instantiateMs?: number;
  growCount?: number;
  neededPages?: number;
  deltas?: number;
}

interface DumpCommon {
  sizeRaw: number;
  usedHeap: number;
  bufferBytes: number;
  scrubbed: boolean;
  stackPointer: number;
  clockCalls: number;
  rngCalls: number;
  kvJson: string;
}

interface DumpResult extends DumpCommon {
  gz: Uint8Array;
  sizeGz: number;
  mode: "full" | "delta";
  grain: number;
  imageLen: number;
  nChanged: number;
  indicesGz: Uint8Array | null;
}

interface SerializeResult {
  raw: Uint8Array;
  usedHeap: number;
  bufferBytes: number;
  scrubbed: boolean;
}

// W4 delta descriptor consumed by restoreW4.
interface W4Delta {
  gz: Uint8Array;
  indicesGz: Uint8Array;
  grain?: number;
}

interface ReplayCell {
  src?: string;
  hostResults?: HostResult[];
}

// The precompiled engine WebAssembly.Module, exposed on globalThis by entry.ts
// (CompiledWasm import — workerd forbids runtime WebAssembly.compile of bytes).
const ENGINE_MODULE = (): WebAssembly.Module => globalThis.__ENGINE_MODULE as WebAssembly.Module;
const ENGINE_HASH = (): string => globalThis.__ENGINE_HASH || "rust-engine-unknown";

export function getEngineHash(): string {
  return ENGINE_HASH();
}

// ---- in-DO async mutex (JS promise-chain) — same shape lib.rs expects ----
export function newMutex(): Mutex {
  return new Mutex();
}
class Mutex {
  _tail: Promise<unknown>;
  constructor() {
    this._tail = Promise.resolve();
  }
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((res) => (release = res));
    const prev = this._tail;
    this._tail = next;
    return prev.then(() => release);
  }
}

// ---- minimal WASI preview1 shim sufficient for the engine ----
// The engine only needs: clock (seeded — we override via the Rust clock anyway), random_get
// (seeded), fd_write (stderr/stdout no-op-ish), proc_exit, args/env stubs, and the handful of
// fns rquickjs/std touch. Determinism: random_get is SEEDED so a seeded session is
// byte-reproducible across restore.
function makeWasi(rngSeed: number): WasiCtl {
  let mem: WebAssembly.Memory | null = null;
  const setMem = (m: WebAssembly.Memory): void => { mem = m; };
  // seeded mulberry32 for random_get (entropy externalized + deterministic).
  let s = (rngSeed >>> 0) || 0x9e3779b9;
  const rnd = (): number => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const view = (): DataView => new DataView((mem as WebAssembly.Memory).buffer);
  const u8 = (): Uint8Array => new Uint8Array((mem as WebAssembly.Memory).buffer);
  const wasi: WasiImports = {
    args_get: () => 0,
    args_sizes_get: (argc: number, argvBuf: number) => {
      view().setUint32(argc, 0, true);
      view().setUint32(argvBuf, 0, true);
      return 0;
    },
    environ_get: () => 0,
    environ_sizes_get: (c: number, b: number) => {
      view().setUint32(c, 0, true);
      view().setUint32(b, 0, true);
      return 0;
    },
    clock_res_get: (_id: number, out: number) => {
      view().setBigUint64(out, 1000n, true);
      return 0;
    },
    clock_time_get: (_id: number, _prec: number, out: number) => {
      // frozen deterministic clock; the engine uses its OWN seeded Date.now anyway.
      view().setBigUint64(out, 0n, true);
      return 0;
    },
    fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
      // count bytes; route stderr(2) to console for engine panics; drop stdout.
      let total = 0;
      const dv = view();
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < iovsLen; i++) {
        const ptr = dv.getUint32(iovs + i * 8, true);
        const len = dv.getUint32(iovs + i * 8 + 4, true);
        total += len;
        if (fd === 2 && len > 0) chunks.push(u8().slice(ptr, ptr + len));
      }
      if (chunks.length) {
        try {
          const all = chunks.reduce((a, c) => a + new TextDecoder().decode(c), "");
          if (all.trim()) console.error("[engine-stderr]", all);
        } catch { /* ignore */ }
      }
      dv.setUint32(nwritten, total, true);
      return 0;
    },
    fd_read: (_fd: number, _iovs: number, _iovsLen: number, nread: number) => {
      view().setUint32(nread, 0, true);
      return 0;
    },
    fd_close: () => 0,
    fd_seek: () => 0,
    fd_fdstat_get: () => 0,
    fd_fdstat_set_flags: () => 0,
    fd_prestat_get: () => 8, // WASI_EBADF -> end preopen enumeration
    fd_prestat_dir_name: () => 8,
    path_open: () => 8,
    random_get: (ptr: number, len: number) => {
      const a = u8();
      for (let i = 0; i < len; i++) a[ptr + i] = (rnd() * 256) & 0xff;
      return 0;
    },
    poll_oneoff: () => 0,
    sched_yield: () => 0,
    proc_exit: (code: number) => {
      throw new Error("engine proc_exit(" + code + ")");
    },
  };
  return { wasi, setMem };
}

// ---- the GlueKernel the Rust DO drives ----
export function newGlueKernel(): GlueKernel {
  return new GlueKernel();
}

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();
const STATUS_HOST_CALL = 1;

// ---- W5 compaction thresholds (docs/W5-COMPACTION-PLAN.md, REALCF-VALIDATION sized) ----
const MAX_USED_BYTES = 50 * 1024 * 1024;            // refuse snapshot above ~50MB live used heap
const MAX_RESTORE_USED_BYTES = 50 * 1024 * 1024;    // refuse restore above ~50MB recorded used heap
const SAFE_SERIALIZE_BUFFER_BYTES = 45 * 1024 * 1024; // ABSOLUTE cap (avoids the W4-ceiling regression)
const MAX_RESTORE_RAW_BYTES = 45 * 1024 * 1024;     // safe-to-instantiate raw ceiling (lockstep w/ dump)
const SCRUB_SLACK_BYTES = 4 * 1024 * 1024;          // scrub when freed slack exceeds this
const SCRUB_MAX_BUFFER_BYTES = 44 * 1024 * 1024;    // only scrub below this (stay under the absolute cap)
const COMPACT_TRIGGER_BYTES = 12 * 1024 * 1024;     // cell-boundary scrub trigger (bloated buffer)
const COMPACT_USED_RATIO = 0.4;                     // ...AND used/buffer < 0.4 (>=60% slack = freed spike)

// ---- W4 byte-delta thresholds (docs/W4-BYTEDELTA-PLAN.md, W4-proven) ----
const DELTA_GRAIN_BYTES = 256;   // W4-proven sweet spot (295KB gz delta vs ~1MB full)
const DELTA_FALLBACK_PCT = 0.5;  // delta >= 50% of full => store full base instead (dense-mutation fallback)

const MAX_STDLIB_SOURCE_BYTES = 500 * 1024; // V0.7 GUARD 1: combined injected stdlib source cap

// ---- v0.6 configurable in-VM stdlib (esbuilt IIFE bundle, evaled at create) ----
let __stdlibBundleCache: Record<string, string> | null = null;
function stdlibBundle(): Record<string, string> {
  if (__stdlibBundleCache) return __stdlibBundleCache;
  const raw = globalThis.__STDLIB_BUNDLE;
  try { __stdlibBundleCache = raw ? JSON.parse(raw) : {}; } catch { __stdlibBundleCache = {}; }
  return __stdlibBundleCache as Record<string, string>;
}
const STDLIB_NAMES: string[] = (() => { const m = globalThis.__STDLIB_META; return (m && Array.isArray(m.modules)) ? m.modules : []; })();
const STDLIB_OPTIN: string[] = (() => { const m = globalThis.__STDLIB_META; return (m && Array.isArray(m.optIn)) ? m.optIn : []; })();
// Normalize config.modules -> concrete name list. true=all defaults (opt-in EXCLUDED);
// [names]=explicit subset (opt-in allowed if named); false/undefined=none.
function resolveStdlibModules(cfgModules: boolean | string[] | undefined): string[] {
  const bundle = stdlibBundle();
  const available = new Set(Object.keys(bundle));
  const optIn = new Set(STDLIB_OPTIN);
  if (cfgModules === true) return STDLIB_NAMES.filter((n) => available.has(n) && !optIn.has(n));
  if (Array.isArray(cfgModules)) return cfgModules.filter((n) => available.has(n));
  return [];
}

class GlueKernel {
  inst: WebAssembly.Instance | null;
  wasiCtl: WasiCtl | null;
  config: KernelConfig;
  clockSeed: number;
  rngSeed: number;
  tsEnabled: boolean;
  lastTimings: RestoreTimings;
  _fetchAllow: boolean | string[];
  _lastImage: Uint8Array | null;
  _stdlibLoaded?: string[];
  _cellHostResults?: HostResult[];
  _replayHostResults?: HostResult[] | null;

  constructor() {
    this.inst = null;
    this.wasiCtl = null;
    this.config = {};
    this.clockSeed = 0;
    this.rngSeed = 42;
    this.tsEnabled = true; // default ON; resolved from config at create/restore
    this.lastTimings = {};
    this._fetchAllow = true; // resolved from config at create/restore
    // W4: the previous committed image, retained host-side (NOT in the VM heap), so the next
    // checkpoint can byte-diff against it. Dropped on evict; re-derived on cold wake (base+deltas).
    this._lastImage = null;
  }

  _newInstance(rngSeed: number): WebAssembly.Instance {
    const { wasi, setMem } = makeWasi(rngSeed);
    const inst = new WebAssembly.Instance(ENGINE_MODULE(), {
      wasi_snapshot_preview1: wasi,
    });
    const exports = inst.exports as unknown as EngineExports;
    setMem(exports.memory);
    // WASI reactor init: call _initialize if present (no _start for reactors).
    if (typeof exports._initialize === "function") {
      try {
        exports._initialize();
      } catch { /* ignore */ }
    }
    this.wasiCtl = { wasi, setMem };
    return inst;
  }

  _ex(): EngineExports {
    return (this.inst as WebAssembly.Instance).exports as unknown as EngineExports;
  }

  // seed scalars from config (clock mode + rngSeed) — parity with JS kernel.
  _applyConfig(configJson: string): KernelConfig {
    let cfg: KernelConfig = {};
    try {
      cfg = JSON.parse(configJson || "{}");
    } catch { /* keep empty */ }
    this.config = cfg;
    this.rngSeed = ((cfg.rngSeed ?? 0) >>> 0) || 42;
    // clock seed: seeded sessions start at 0 tick (engine adds the 1.7e12 epoch).
    this.clockSeed = 0;
    // TypeScript strip: default TRUE (stripping valid JS is a safe near no-op); {typescript:false}
    // disables. Persisted via configJson across cold restore (same path as clock/rngSeed).
    this.tsEnabled = cfg.typescript !== false;
    // fetch allowlist: true=all, false=none, [hosts]=hostnames.
    this._fetchAllow = cfg.fetch === undefined ? true : cfg.fetch;
    return cfg;
  }

  async createFresh(configJson: string): Promise<string> {
    const cfg = this._applyConfig(configJson);
    this.inst = this._newInstance(this.rngSeed);
    this._ex().create(BigInt(this.clockSeed), BigInt(this.rngSeed));
    // stdlib injection: eval the selected esbuilt IIFEs into the live VM so they snapshot-
    // persist (survive hibernation, no re-inject). Subset chosen by config.modules.
    this._injectStdlib(cfg.modules);
    this.lastTimings = { instantiateMs: 0, growCount: 0 };
    return "fresh";
  }

  _injectStdlib(cfgModules: boolean | string[] | undefined): void {
    this._stdlibLoaded = [];
    const modules = resolveStdlibModules(cfgModules);
    if (!modules.length) return;
    const bundle = stdlibBundle();
    // V0.7 GUARD 1: combined source cap (avoid the snapshot OOM cliff).
    let total = 0;
    for (const n of modules) { const s = bundle[n]; if (typeof s === "string") total += s.length; }
    if (total > MAX_STDLIB_SOURCE_BYTES) {
      throw new Error("SizeAdmissionError: selected stdlib source " + total + " > MAX_STDLIB_SOURCE_BYTES " +
        MAX_STDLIB_SOURCE_BYTES + " (modules: " + modules.join(",") + ")");
    }
    const ex = this._ex();
    for (const name of modules) {
      const iife = bundle[name];
      if (typeof iife !== "string") continue;
      try {
        // eval the IIFE in GLOBAL scope; it self-installs globalThis.<name>. Generous budget.
        const wrapped = "(0,eval)(" + JSON.stringify(iife) + ");0";
        const srcBytes = TEXT_ENC.encode(wrapped);
        this._writeScratch(srcBytes);
        const st = ex.eval_begin(ex.scratch_ptr(), srcBytes.length, BigInt(5_000_000), 0);
        // stdlib injection makes no host calls; if it parked, abandon (shouldn't happen).
        if (st === STATUS_HOST_CALL) continue;
        const res = JSON.parse(this._readResult());
        if (res.ok !== false) (this._stdlibLoaded as string[]).push(name);
      } catch { /* skip a failed module, never fatal */ }
    }
  }

  // restore: blit the gz image into a fresh instance, then re-seed counters + kv.
  async restore(
    gz: Uint8Array,
    engineHash: string,
    clockCalls: number,
    rngCalls: number,
    configJson: string,
    label: string,
    kvJson: string,
    usedHeap: number
  ): Promise<string> {
    this._applyConfig(configJson);
    const t0 = Date.now();
    // gunzip the snapshot image.
    const raw = await gunzip(gz);
    const gunzipMs = Date.now() - t0;
    // W5 RESTORE admission: a spiked-then-freed image gunzips back to the full (zeroed) raw
    // extent. Admit on the RECORDED used heap (the genuine fence); the raw ceiling only fails
    // images too big to safely instantiate. docs/W5-COMPACTION-PLAN.md.
    const recordedUsed = Number.isFinite(usedHeap) && usedHeap > 0 ? usedHeap | 0 : 0;
    if (recordedUsed > MAX_RESTORE_USED_BYTES) {
      throw new Error(
        "SizeAdmissionError: recorded used heap " + recordedUsed +
          "B > MAX_RESTORE_USED_BYTES " + MAX_RESTORE_USED_BYTES + "; refusing restore"
      );
    }
    if (raw.length > MAX_RESTORE_RAW_BYTES) {
      throw new Error(
        "SizeAdmissionError: restore raw image " + raw.length +
          "B > MAX_RESTORE_RAW_BYTES " + MAX_RESTORE_RAW_BYTES + "; refusing restore"
      );
    }
    // fresh instance, grow to fit, blit.
    this.inst = this._newInstance(this.rngSeed);
    const mem = this._ex().memory;
    const needPages = (raw.length + 0xffff) >> 16;
    const havePages = mem.buffer.byteLength >> 16;
    let growCount = 0;
    if (needPages > havePages) {
      mem.grow(needPages - havePages);
      growCount = 1;
    }
    new Uint8Array(this._ex().memory.buffer).set(raw);
    // re-validate the blitted runtime + restore entropy counters + kv state.
    const ok = this._ex().reattach();
    if (!ok) throw new Error("RestoreError: reattach failed after blit");
    this._ex().set_counters(BigInt(clockCalls | 0), BigInt(rngCalls | 0));
    if (kvJson && kvJson !== "{}") this._importKv(kvJson);
    // W4: retain the reconstructed image so the next warm checkpoint diffs against it.
    this._lastImage = raw.slice();
    this.lastTimings = { gunzipMs, instantiateMs: 0, growCount, neededPages: needPages };
    return label || "sqlite-restore";
  }

  // W4 restore: reconstruct the raw image from a gz'd full base + an ordered chain of gz'd
  // deltas, then blit (same path as restore()). deltaList = [{gz, indicesGz, grain}] applied
  // in order. docs/W4-BYTEDELTA-PLAN.md.
  async restoreW4(
    baseGz: Uint8Array,
    deltaList: W4Delta[],
    engineHash: string,
    clockCalls: number,
    rngCalls: number,
    configJson: string,
    label: string,
    kvJson: string,
    usedHeap: number
  ): Promise<string> {
    this._applyConfig(configJson);
    const t0 = Date.now();
    const base = await gunzip(baseGz);
    let image = base; // grown + mutated by deltas
    const deltas = Array.isArray(deltaList) ? deltaList : [];
    // Pre-decode each delta so we can size the reconstructed image to the LARGEST grain target
    // across the chain (the buffer grows monotonically, so a later delta may extend past the base).
    const decoded: Array<{ payload: Uint8Array; dv: DataView; grain: number; nIdx: number }> = [];
    let maxLen = image.byteLength;
    for (const d of deltas) {
      const payload = await gunzip(d.gz);
      const idxBytes = await gunzip(d.indicesGz);
      const grain = d.grain || DELTA_GRAIN_BYTES;
      const nIdx = (idxBytes.byteLength / 4) | 0;
      const dv = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength);
      let dMax = 0;
      for (let k = 0; k < nIdx; k++) { const gi = dv.getUint32(k * 4, true); if (gi > dMax) dMax = gi; }
      if (nIdx > 0) maxLen = Math.max(maxLen, (dMax + 1) * grain);
      decoded.push({ payload, dv, grain, nIdx });
    }
    if (maxLen > image.byteLength) {
      const grown = new Uint8Array(maxLen);
      grown.set(image);
      image = grown;
    }
    for (const d of decoded) {
      const { payload, dv, grain, nIdx } = d;
      for (let k = 0; k < nIdx; k++) {
        const gi = dv.getUint32(k * 4, true);
        const dst = gi * grain;
        const srcStart = k * grain;
        const n = Math.min(grain, image.byteLength - dst);
        if (n > 0) image.set(payload.subarray(srcStart, srcStart + n), dst);
      }
    }
    const gunzipMs = Date.now() - t0;
    // W5 RESTORE admission on the reconstructed image.
    const recordedUsed = Number.isFinite(usedHeap) && usedHeap > 0 ? usedHeap | 0 : 0;
    if (recordedUsed > MAX_RESTORE_USED_BYTES)
      throw new Error("SizeAdmissionError: recorded used heap " + recordedUsed + " > " + MAX_RESTORE_USED_BYTES);
    if (image.length > MAX_RESTORE_RAW_BYTES)
      throw new Error("SizeAdmissionError: restore raw image " + image.length + " > " + MAX_RESTORE_RAW_BYTES);

    this.inst = this._newInstance(this.rngSeed);
    const mem = this._ex().memory;
    const needPages = (image.length + 0xffff) >> 16;
    const havePages = mem.buffer.byteLength >> 16;
    let growCount = 0;
    if (needPages > havePages) { mem.grow(needPages - havePages); growCount = 1; }
    new Uint8Array(this._ex().memory.buffer).set(image);
    const ok = this._ex().reattach();
    if (!ok) throw new Error("RestoreError: reattach failed after W4 blit");
    this._ex().set_counters(BigInt(clockCalls | 0), BigInt(rngCalls | 0));
    if (kvJson && kvJson !== "{}") this._importKv(kvJson);
    this._lastImage = image.slice();
    this.lastTimings = { gunzipMs, instantiateMs: 0, growCount, neededPages: needPages, deltas: deltas.length };
    return label || "sqlite-restore";
  }

  lastRestoreTimings(): string {
    return JSON.stringify(this.lastTimings || {});
  }

  // E6: the host requests+results serviced during the last eval (for the crash-tail oplog).
  lastCellHostResults(): string {
    try { return JSON.stringify(this._cellHostResults || []); } catch { return "[]"; }
  }

  // evalCode: ASYNC. Drives the engine eval_begin/eval_resume loop, servicing host effects
  // (host.fetch -> DO-side fetch). Returns the rich JSON result STRING and NEVER throws across
  // the boundary (so the eval mutex is always released).
  async evalCode(src: string): Promise<string> {
    // TS-STRIP (runs BEFORE transformCell): erase TS type syntax to whitespace. Length-preserving,
    // so the depth-0 declaration tokenizer in transformCell sees identical offsets. On an
    // un-erasable construct (enum / namespace / parameter-properties) reject the cell with a typed
    // TypeScriptError mirroring the eval error envelope — socket alive, mutex released, next eval
    // works — do NOT crash. Disabled when config {typescript:false}.
    let tsOut: string;
    try {
      tsOut = this.tsEnabled ? stripTypes(src) : src;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      return JSON.stringify({
        ok: false,
        valueType: "error",
        logs: [],
        error: { name: err.name || "TypeScriptError", message: String(err.message || e), stack: "" },
      });
    }
    try {
      const ex = this._ex();
      // REPL-persistence transform: rewrite top-level let/const/function/class declarations into
      // global assignments so they persist across cells (Node-REPL semantics), preserving the
      // completion value. Pure deterministic pre-eval source rewrite; falls back to the ORIGINAL
      // source on any ambiguity (never corrupts the cell). See src/repl-transform.ts.
      let transformed = tsOut;
      try { transformed = transformCell(tsOut); } catch { transformed = tsOut; }
      const srcBytes = TEXT_ENC.encode(transformed);
      this._writeScratch(srcBytes);
      // per-cell guards: interrupt-tick budget + per-cell buffer-growth cap (pages). The budget
      // counts INTERRUPT-HANDLER invocations (QuickJS fires the handler every ~Nk bytecodes), so
      // the certified value is ~1200 (parity with the JS kernel's default 1200 / cap 2000).
      const budget = BigInt((this.config.cellBudgetTicks ?? 0) || 1200);
      const growCapPages = (this.config.cellGrowCapPages ?? 0) || 128; // ~8MB per cell
      let status = ex.eval_begin(ex.scratch_ptr(), srcBytes.length, budget, growCapPages);
      let guard = 0;
      // E6 oplog: capture host requests+results for the crash-tail journal (host-side).
      this._cellHostResults = [];
      while (status === STATUS_HOST_CALL && guard++ < 64) {
        const req = this._readHostCall();
        let res: HostResult;
        if (this._replayHostResults && this._replayHostResults.length) {
          // engine-migration replay: feed the recorded result, do NOT re-fire the effect.
          res = this._replayHostResults.shift() as HostResult;
        } else {
          res = await this._serviceHostCall(req);
        }
        this._cellHostResults.push(res);
        const resBytes = TEXT_ENC.encode(JSON.stringify(res));
        this._writeScratch(resBytes);
        status = ex.eval_resume(ex.scratch_ptr(), resBytes.length);
      }
      return this._readResult();
    } catch (e) {
      const err = e as { message?: string };
      return JSON.stringify({
        ok: false,
        valueType: "error",
        logs: [],
        error: { name: "GlueError", message: String((err && err.message) || e), stack: "" },
      });
    }
  }

  // host effects the ENGINE cannot do from wasip1: fetch (allowlisted). The RLM surface
  // (host.subLM / host.ctx.* / host.final / host.finalVar) and host.kv were removed.
  async _serviceHostCall(req: HostCall): Promise<HostResult> {
    const name = req.name;
    const args = req.args || [];
    if (name === "fetch") return this._doFetch(args[0] as string, args[1] as RequestInit | undefined);
    // unknown host fn -> typed reject (engine turns this into a rejected VM promise).
    return { ok: false, error: "UnknownHostFn: host." + name };
  }

  async _doFetch(url: string, init?: RequestInit): Promise<HostResult> {
    try {
      // allowlist enforcement (parity with P3 kernel).
      const allow = this._fetchAllow;
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        return { ok: false, error: "FetchError: invalid url" };
      }
      let permitted = false;
      if (allow === true) permitted = true;
      else if (allow === false) permitted = false;
      else if (Array.isArray(allow)) permitted = allow.includes(host);
      if (!permitted) return { ok: false, error: "FetchBlockedError: " + host + " not allowed" };

      const r = await fetch(url, init || undefined);
      const body = await r.text();
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => (headers[k] = v));
      return {
        ok: true,
        value: { status: r.status, ok: r.ok, headers, body: body.slice(0, 1 << 20) },
      };
    } catch (e) {
      const err = e as { message?: string };
      return { ok: false, error: "FetchError: " + String((err && err.message) || e) };
    }
  }

  // dump: read the live linear memory + counters + kv, gzip, return the image + meta.
  //
  // W5 compaction (docs/W5-COMPACTION-PLAN.md). The size-admission GUARD lives here. WASM linear
  // memory is MONOTONIC — it never shrinks. A session that spikes then frees keeps a high-water-
  // mark buffer. So the admission is on the USED heap (the genuine OOM fence), NOT the monotonic
  // buffer. We keep an ABSOLUTE safe-serialize cap on the raw buffer to avoid the adversarial
  // W4-ceiling regression. Returns { raw, usedHeap, bufferBytes, scrubbed }. Throws
  // SizeAdmissionError on a too-big (or wedged) buffer/heap — socket alive, next eval works.
  _serializeForDump(): SerializeResult {
    const ex = this._ex();
    const bufBytes0 = Number(ex.buffer_bytes());

    // ABSOLUTE cap FIRST (before any full-buffer touch): a buffer above the safe-serialize
    // ceiling risks an uncatchable OOM (snapshot+gz is ~2-3x). Hard-reject, socket alive.
    if (bufBytes0 > SAFE_SERIALIZE_BUFFER_BYTES) {
      throw new Error(
        "SizeAdmissionError: linear buffer " + bufBytes0 +
          "B > SAFE_SERIALIZE_BUFFER_BYTES " + SAFE_SERIALIZE_BUFFER_BYTES +
          " (WASM memory cannot shrink in place; refusing snapshot — reset to recover)"
      );
    }

    // W5 (a): admit on the live used heap. We only GC/scrub when the buffer is actually BLOATED
    // (a freed spike) — running GC on every checkpoint is unnecessary and can disturb in-flight
    // job state, so the steady-state path leaves the heap untouched. used_heap() alone does not GC.
    let usedHeap = Number(ex.used_heap());
    let scrubbed = false;
    const bloated = bufBytes0 > COMPACT_TRIGGER_BYTES;
    if (bloated) {
      // GC first (scrub_arena(0) GCs without allocating) so freed slack is reclaimable.
      usedHeap = Number(ex.scrub_arena(0));
    }
    if (usedHeap > MAX_USED_BYTES) {
      throw new Error(
        "SizeAdmissionError: live used heap " + usedHeap +
          "B > MAX_USED_BYTES " + MAX_USED_BYTES + "; refusing snapshot"
      );
    }
    // W5 (b)+(c): scrub freed slack so the STORED gz image shrinks below the soft ceiling.
    const slack = bufBytes0 - usedHeap;
    const wedgedRatio = bloated && usedHeap / bufBytes0 < COMPACT_USED_RATIO;
    if (bloated && (slack > SCRUB_SLACK_BYTES || wedgedRatio) && bufBytes0 <= SCRUB_MAX_BUFFER_BYTES) {
      const budgetMb = Math.max(0, Math.min(Math.floor((slack / (1024 * 1024)) * 0.6), 24));
      if (budgetMb >= 1) {
        usedHeap = Number(ex.scrub_arena(budgetMb));
        scrubbed = true;
      }
    }

    const bufferBytes = Number(ex.buffer_bytes());
    const raw = new Uint8Array(ex.memory.buffer.slice(0));
    return { raw, usedHeap, bufferBytes, scrubbed };
  }

  _dumpCommon(usedHeap: number, bufferBytes: number, scrubbed: boolean, raw: Uint8Array): DumpCommon {
    const ex = this._ex();
    return {
      sizeRaw: raw.length,
      usedHeap,
      bufferBytes,
      scrubbed,
      stackPointer: 0,
      clockCalls: Number(ex.clock_calls()),
      rngCalls: Number(ex.rng_calls()),
      kvJson: this._exportKv(),
    };
  }

  // dump: full-image W5-compacted snapshot (used by the non-delta path / first base).
  async dump(): Promise<DumpResult> {
    const { raw, usedHeap, bufferBytes, scrubbed } = this._serializeForDump();
    const gz = await gzip(raw);
    this._lastImage = raw.slice();
    return { gz, sizeGz: gz.length, mode: "full", grain: DELTA_GRAIN_BYTES, imageLen: raw.length,
      nChanged: 0, indicesGz: null, ...this._dumpCommon(usedHeap, bufferBytes, scrubbed, raw) };
  }

  // W4 BYTE-DELTA dump (docs/W4-BYTEDELTA-PLAN.md). Diffs the current raw image vs the retained
  // `this._lastImage` at a 256B grain. If a prior image exists, !forceFull, raw >= prev length,
  // AND the delta is small (< DELTA_FALLBACK_PCT of full) => emit mode:"delta" carrying ONLY the
  // changed grains + indices. Else => mode:"full" (W5-compacted base), reset the chain.
  async dumpW4(forceFull: boolean): Promise<DumpResult> {
    const { raw, usedHeap, bufferBytes, scrubbed } = this._serializeForDump();
    const common = this._dumpCommon(usedHeap, bufferBytes, scrubbed, raw);
    const prev = this._lastImage;
    // W4 (growth-tolerant): the WASM linear buffer is MONOTONIC and commonly grows by whole 64KB
    // pages between cells; allow a delta when the current buffer is the SAME size or LARGER than
    // prev — diff the overlapping prefix grain-by-grain and mark every newly-grown grain as
    // changed so its exact bytes are carried.
    const canDelta = !forceFull && prev && raw.byteLength >= prev.byteLength;

    if (canDelta && prev) {
      const grain = DELTA_GRAIN_BYTES;
      const nGrains = Math.ceil(raw.byteLength / grain);
      const prevLen = prev.byteLength;
      const changed: number[] = [];
      for (let i = 0; i < nGrains; i++) {
        const start = i * grain;
        const end = Math.min(start + grain, raw.byteLength);
        // grain entirely beyond prev => brand-new bytes, always carry.
        if (start >= prevLen) { changed.push(i); continue; }
        let diff = false;
        const cmpEnd = Math.min(end, prevLen);
        for (let j = start; j < cmpEnd; j++) { if (raw[j] !== prev[j]) { diff = true; break; } }
        // grain straddles the old/new boundary => the tail bytes are new, carry it.
        if (!diff && end > prevLen) diff = true;
        if (diff) changed.push(i);
      }
      const payload = new Uint8Array(changed.length * grain);
      for (let k = 0; k < changed.length; k++) {
        const i = changed[k];
        const start = i * grain;
        const end = Math.min(start + grain, raw.byteLength);
        payload.set(raw.subarray(start, end), k * grain);
      }
      const idx = new Uint32Array(changed.length);
      for (let k = 0; k < changed.length; k++) idx[k] = changed[k];
      const idxBytes = new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength);
      const [payGz, idxGz] = await Promise.all([gzip(payload), gzip(idxBytes)]);
      const deltaStored = payGz.byteLength + idxGz.byteLength;
      // AUTO-FALLBACK: dense mutation (delta >= FALLBACK_PCT of a full gz image) => store full.
      const fullGz = await gzip(raw);
      if (deltaStored < fullGz.byteLength * DELTA_FALLBACK_PCT) {
        this._lastImage = raw.slice();
        return { mode: "delta", gz: payGz, indicesGz: idxGz, nChanged: changed.length, grain,
          imageLen: raw.byteLength, sizeGz: deltaStored, ...common };
      }
      // dense — fall through to full base, reuse fullGz.
      this._lastImage = raw.slice();
      return { mode: "full", gz: fullGz, indicesGz: null, nChanged: 0, grain: DELTA_GRAIN_BYTES,
        imageLen: raw.byteLength, sizeGz: fullGz.byteLength, ...common };
    }

    // FULL (W5-compacted) base. Resets the delta chain.
    this._lastImage = raw.slice();
    const gz = await gzip(raw);
    return { mode: "full", gz, indicesGz: null, nChanged: 0, grain: DELTA_GRAIN_BYTES,
      imageLen: raw.byteLength, sizeGz: gz.byteLength, ...common };
  }

  _exportKv(): string {
    const ex = this._ex();
    const ptr = ex.kv_export_ptr();
    const len = ex.kv_export_len();
    return TEXT_DEC.decode(new Uint8Array(ex.memory.buffer, ptr, len).slice());
  }
  _importKv(json: string): void {
    const ex = this._ex();
    const bytes = TEXT_ENC.encode(json);
    this._writeScratch(bytes);
    ex.kv_import(ex.scratch_ptr(), bytes.length);
  }

  // stdlib injection: report which modules were injected at create (the esbuilt bundle evaled
  // into the VM). The actual catalog is wired by lib.rs via the STDLIB bundle Text module.
  stdlibInfo(): string {
    return JSON.stringify({ loaded: this._stdlibLoaded || [], available: STDLIB_NAMES, optIn: STDLIB_OPTIN });
  }
  // E6 ENGINE-MIGRATION journal replay (docs E6). On an engine-hash mismatch at cold wake, the
  // byte-blit image is invalid (a different engine layout), so the DO replays the retained cell
  // oplog into a FRESH instance under the same config — no re-fire of pure cells, host results
  // fed back from the recorded oplog. journal = [{src, hostResults:[...]}].
  async replayJournal(journal: ReplayCell[], configJson: string, kvJson: string): Promise<string> {
    await this.createFresh(configJson);
    if (kvJson && kvJson !== "{}") this._importKv(kvJson);
    const cells = Array.isArray(journal) ? journal : [];
    let replayed = 0, failed = 0, effectful = 0;
    const errors: string[] = [];
    for (const c of cells) {
      try {
        // feed recorded host results back in order (no re-fire of effects).
        this._replayHostResults = Array.isArray(c.hostResults) ? c.hostResults.slice() : [];
        if (this._replayHostResults.length) effectful++;
        const out = await this.evalCode(String(c.src || ""));
        const parsed = JSON.parse(out);
        if (parsed.ok === false) failed++; else replayed++;
      } catch (e) { const err = e as { message?: string }; failed++; errors.push(String((err && err.message) || e)); }
    }
    this._replayHostResults = null;
    return JSON.stringify({ replayed, failed, effectfulCells: effectful, errors });
  }

  _writeScratch(bytes: Uint8Array): void {
    const ex = this._ex();
    new Uint8Array(ex.memory.buffer).set(bytes, ex.scratch_ptr());
  }
  _readResult(): string {
    const ex = this._ex();
    const ptr = ex.result_ptr();
    const len = ex.result_len();
    return TEXT_DEC.decode(new Uint8Array(ex.memory.buffer, ptr, len).slice());
  }
  _readHostCall(): HostCall {
    const ex = this._ex();
    const ptr = ex.pending_host_call_ptr();
    const len = ex.pending_host_call_len();
    return JSON.parse(TEXT_DEC.decode(new Uint8Array(ex.memory.buffer, ptr, len).slice()));
  }

  drop(): void {
    this.inst = null;
    this.wasiCtl = null;
  }
}

// ---- gzip/gunzip via the platform CompressionStream (workerd-native) ----
async function gzip(u8: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(u8);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function gunzip(u8: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(u8);
  w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
