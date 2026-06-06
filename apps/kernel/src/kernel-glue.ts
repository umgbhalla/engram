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

import { transformCell, wrapAsyncCompletion } from "./repl-transform.js";
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
  scratch_cap(): number;
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
  maxHostCallsPerCell?: number;
  // fs provider: undefined / {provider:"vfs"} = in-heap VFS (sync, durable in snapshot);
  // {provider:"r2",binding?,prefix?} = host-backed R2 (async-only; serviced DO-side in lib.rs).
  fs?: { provider?: string; binding?: string; prefix?: string };
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

// ---- host-callback bridge (VM -> client over the kernel WS) ------------------
//
// A cell that calls `host.<name>(...args)` for any name OTHER than the built-in
// `fetch` is a CLIENT host-callback: the kernel parks the VM eval, asks the connected
// client (over the same WS) to compute the result, and resumes the VM with it. The
// engine already suspends/resumes (host.fetch path) — we just route the request to the
// client instead of a local fetch.
//
// DEADLOCK CONSTRAINT (the single most important design point): the eval critical
// section in lib.rs holds `self.mutex` for the WHOLE eval. The client's
// {t:hostcall-result} reply arrives as a NEW websocket_message. That handler MUST NOT
// re-acquire the mutex (it is held by the suspended eval) — it must only resolve the
// pending resolver. So the pending-resolver registry lives HERE in the glue module
// (one DO isolate == one module instance), and lib.rs resolves it from
// websocket_message WITHOUT touching the mutex.
//
// `host.fetch` is unchanged (serviced locally, DO-side). Determinism + crash-replay are
// unaffected: the E6 oplog still records the host RESULT, so engine-migration replay
// feeds the recorded value back WITHOUT re-calling the client (see evalCode replay path).

interface HostCallSender {
  // send a frame string to the client; returns false if no socket is available.
  send: (frameJson: string) => boolean;
  timeoutMs: number;
}

// One registry per glue module instance (== per DO isolate). callId -> resolver.
const __pendingHostCalls = new Map<string, { resolve: (r: HostResult) => void; timer: ReturnType<typeof setTimeout> }>();
let __hostCallSeq = 0;

// Called by lib.rs from websocket_message on a {t:hostcall-result} frame, OUTSIDE the
// eval mutex. Resolves the parked VM host call. No-throw; unknown ids are ignored
// (late/duplicate replies).
export function resolveHostCall(id: string, ok: boolean, valueJson: string, error: string): void {
  const pend = __pendingHostCalls.get(id);
  if (!pend) return;
  __pendingHostCalls.delete(id);
  clearTimeout(pend.timer);
  if (ok) {
    let value: unknown = null;
    try { value = valueJson === undefined || valueJson === "" ? null : JSON.parse(valueJson); } catch { value = null; }
    pend.resolve({ ok: true, value });
  } else {
    pend.resolve({ ok: false, error: error || "host callback failed" });
  }
}

// ---- the GlueKernel the Rust DO drives ----
export function newGlueKernel(): GlueKernel {
  return new GlueKernel();
}

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();
const STATUS_HOST_CALL = 1;

// ---- ADR-0012 binary-safe host.fetch ----
// The host fetch effect carries RAW BYTES across the engine<->glue JSON boundary as base64
// (`bodyB64`), the SAME pattern the R2 fs op uses (ADR-0011). This is the structural unblocker
// for binary transfers (git packfiles), which the prior `await r.text()` path lossy-corrupted +
// truncated. We KEEP a utf8 `body` (capped) for back-compat with the existing string fetch shim.
// Cap raised 1MB -> 32MB (env-overridable via FETCH_MAX_BODY_BYTES). A request body may also be
// binary (git-upload-pack POSTs a packfile): the engine sends `init.bodyB64` (base64 bytes) which
// we decode to a Uint8Array before fetch.
const FETCH_MAX_BODY_BYTES = (() => {
  const v = (globalThis as { FETCH_MAX_BODY_BYTES?: unknown }).FETCH_MAX_BODY_BYTES;
  const n = typeof v === "number" ? v : (typeof v === "string" ? parseInt(v, 10) : NaN);
  return Number.isFinite(n) && n > 0 ? n : 32 * 1024 * 1024;
})();
// The back-compat utf8 `body` is a CAPPED PREVIEW only — the exact bytes always travel as `bodyB64`.
// Capping is REQUIRED for big binary payloads: a 6.6MB PDF would otherwise also ship a ~6.6MB utf8
// `body` string ALONGSIDE the ~8.9MB base64 in the SAME host-call result, and the engine would hold
// BOTH as UTF-16 strings (~2x) — ~30MB of redundant strings that blew the VM's linear memory past
// the per-cell grow cap. `.text()`/`.json()` on a body larger than this cap fall back to decoding
// the exact bytes from `bodyB64` (engine shim), so correctness is unaffected; only the convenience
// preview is truncated. 64KB is enough for the common text/JSON case while keeping binary cheap.
const FETCH_BODY_UTF8_PREVIEW_BYTES = 64 * 1024;
// base64 encode/decode over Uint8Array, chunked so a large packfile does not blow the call stack
// of String.fromCharCode(...spread). Mirrors the fs-op base64 boundary.
function bytesToB64(u8: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.prototype.slice.call(u8.subarray(i, i + CH)) as number[]);
  }
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- W5 compaction thresholds (docs/W5-COMPACTION-PLAN.md, REALCF-VALIDATION sized) ----
// The engine's static SCRATCH buffer was raised 1MB -> 32MB (lib.rs, to let big fetch bodies / fs
// writes cross the host boundary). That 32MB lives in the SAME linear memory that the W4 snapshot
// blits, so EVERY session's buffer_bytes() is now ~32MB higher (the zero-filled scratch gzips to
// ~nothing, so the STORED image barely grows — only the RAW image size does). The raw-image (buffer)
// caps below were therefore raised by the +31MB scratch delta so a session that also pulled in a big
// payload can still snapshot/restore. The USED-HEAP caps measure the rquickjs allocator tally
// (memory_used_size) only — the static scratch is NOT counted there — so they are unchanged (heap
// cap untouched, per the task). The W4 delta path is preserved for all buffer sizes (resetting it to
// full would also reset the engine-migration oplog tail — see lib.rs checkpoint full path).
const SCRATCH_DELTA_BYTES = 31 * 1024 * 1024;       // 32MB scratch - the old 1MB it replaced
const MAX_USED_BYTES = 50 * 1024 * 1024;            // refuse snapshot above ~50MB live used heap
const MAX_RESTORE_USED_BYTES = 50 * 1024 * 1024;    // refuse restore above ~50MB recorded used heap
const SAFE_SERIALIZE_BUFFER_BYTES = 45 * 1024 * 1024 + SCRATCH_DELTA_BYTES; // 76MB raw-image cap (+31MB resident scratch)
const MAX_RESTORE_RAW_BYTES = 45 * 1024 * 1024 + SCRATCH_DELTA_BYTES;       // 76MB safe-to-instantiate ceiling (lockstep w/ dump)
// Above this raw-image size, dumpW4 takes a 2-copy NO-RETAIN full path (it does NOT retain
// _lastImage and does NOT diff against prev) so peak DO memory during the dump is ~raw + gz, not
// the ~3x raw the delta/full-with-retain paths cost — which OOMs the DO once the buffer carries a
// big payload on top of the 32MB scratch (measured: a 2.2MB-PDF cell pushes the buffer to ~67MB;
// the 3-copy full retain at 67MB hung the DO, while a normal session tops out at ~59MB and is safe).
// The threshold sits ABOVE the normal-session ceiling (~59MB) so ordinary cells keep the delta path
// (which preserves the engine-migration oplog tail); only a genuinely large payload trips it. A
// large-payload cell that trips it forces a full base (resetting the oplog tail), so engine-migration
// REPLAY of that specific cell would no-op — an accepted edge: the byte-blit image stays the primary
// restore path, and 32MB-class payload cells are the rare exception, not the steady state.
const LARGE_BUFFER_NO_RETAIN_BYTES = 63 * 1024 * 1024;
const SCRUB_SLACK_BYTES = 4 * 1024 * 1024;          // scrub when freed slack exceeds this
const SCRUB_MAX_BUFFER_BYTES = 44 * 1024 * 1024 + SCRATCH_DELTA_BYTES;      // only scrub below this (stay under the absolute cap)
const COMPACT_TRIGGER_BYTES = 12 * 1024 * 1024;     // cell-boundary scrub trigger (bloated buffer)
const COMPACT_USED_RATIO = 0.4;                     // ...AND used/buffer < 0.4 (>=60% slack = freed spike)

// ---- W4 byte-delta thresholds (docs/W4-BYTEDELTA-PLAN.md, W4-proven) ----
const DELTA_GRAIN_BYTES = 256;   // W4-proven sweet spot (295KB gz delta vs ~1MB full)
const DELTA_FALLBACK_PCT = 0.5;  // delta >= 50% of full => store full base instead (dense-mutation fallback)
// A delta row is stored as a SINGLE SQLite blob per column (payload / indices). DO SQLite caps a
// single value at ~2MB, so a delta whose payload or indices gz exceeds this must NOT be emitted as
// a delta (it'd hit SQLITE_TOOBIG on the delta_chunks INSERT). Fall back to a full base, which is
// chunked (sqlite) or pushed to R2 — both side-step the single-value cap. Conservative ceiling.
const DELTA_MAX_BLOB_BYTES = 1_400_000;

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
  // host-callback bridge: a per-eval sender the DO installs (via setHostSender) so a
  // non-fetch host.<name> call can round-trip to the connected client over the WS.
  _hostSender?: HostCallSender | null;
  // fs provider handler: the DO (lib.rs) installs a JS async closure (R2/S3 servicer) per eval
  // when config.fs.provider != vfs; the engine's `host.__fs` effect routes here. null = in-heap VFS.
  _fsHandler?: ((payload: unknown) => Promise<unknown>) | null;

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
    this._hostSender = null;
  }

  // setHostSender: the DO installs (per eval) a sender that delivers a {t:hostcall} frame
  // to the connected client and a timeoutMs. Pass `null` to clear (e.g. facet/HTTP path
  // with no held client socket) so non-fetch host calls reject cleanly. `send` returns
  // false when no live socket is available.
  setHostSender(send: ((frameJson: string) => boolean) | null, timeoutMs: number): void {
    this._hostSender = send ? { send, timeoutMs: timeoutMs > 0 ? timeoutMs : 60000 } : null;
  }

  // setFsHandler: the DO installs (per eval) the R2/S3 fs servicer closure when
  // config.fs.provider != vfs. `null` clears it (in-heap VFS path; the engine never calls host.__fs).
  setFsHandler(handler: ((payload: unknown) => Promise<unknown>) | null): void {
    this._fsHandler = typeof handler === "function" ? handler : null;
  }

  // _applyFsProvider: tell the in-VM fs router which provider is active (it reads
  // globalThis.__fsProvider). Called after create/restore. 'vfs' = in-heap; else host-backed.
  _applyFsProvider(): void {
    const prov = (this.config.fs && this.config.fs.provider) || "vfs";
    try {
      const ex = this._ex();
      const src = "globalThis.__fsProvider=" + JSON.stringify(String(prov)) + ";0";
      const b = TEXT_ENC.encode(src);
      this._writeScratch(b);
      ex.eval_begin(ex.scratch_ptr(), b.length, BigInt(100000), 0);
    } catch { /* non-fatal: defaults to 'vfs' in the bootstrap */ }
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
    this._applyFsProvider();
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
    this._applyFsProvider();
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
    this._applyFsProvider();
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
      // REPL completion value for top-level-await cells: the engine runs an await-using
      // multi-statement cell as an async function BODY (no completion value), so a trailing
      // expression after a loop/block is otherwise lost. Rewrite it into an explicit `return`.
      // Bails to the input on any ambiguity (no regression for non-await / single-expr cells).
      try { transformed = wrapAsyncCompletion(transformed); } catch { /* keep transformed */ }
      const srcBytes = TEXT_ENC.encode(transformed);
      // (a) PROTOCOL/SOURCE size guard: reject an oversized cell source BEFORE writing it into the
      // fixed scratch buffer. Typed ProtocolSizeError, socket alive, mutex released, next eval works.
      const cap = ex.scratch_cap();
      if (srcBytes.length > cap) {
        return JSON.stringify({
          ok: false,
          valueType: "error",
          logs: [],
          error: {
            name: "ProtocolSizeError",
            message: "cell source " + srcBytes.length + "B exceeds max " + cap + "B",
            stack: "",
          },
        });
      }
      this._writeScratch(srcBytes);
      // per-cell guards: interrupt-tick budget + per-cell buffer-growth cap (pages). The budget
      // counts INTERRUPT-HANDLER invocations (QuickJS fires the handler every ~Nk bytecodes), so
      // the certified value is ~1200 (parity with the JS kernel's default 1200 / cap 2000).
      // Per-cell instruction budget (interrupt-handler ticks; the timeout fence). Default raised
      // 1200 -> 500000: decoding a large fetch body (base64 -> bytes) inside the VM burns far more
      // bytecode than a normal cell, and the old 1200 tripped a TimeoutError before a big-payload
      // cell (e.g. fetching + writing a 2.2MB PDF) could finish (~150k ticks observed for 2.2MB).
      // Memory bombs are still caught by the grow-cap tripwire + rquickjs heap limit; the platform
      // also bounds wall-clock CPU. Overridable per-session via config.cellBudgetTicks.
      const budget = BigInt((this.config.cellBudgetTicks ?? 0) || 500000);
      // Per-cell linear-memory growth cap (pages, 64KB each). Default raised 128p/8MB -> 1024p/64MB:
      // a single cell may legitimately pull in a fetch body up to FETCH_MAX_BODY_BYTES (32MB) and
      // then hold a working copy or two (decoded bytes, an fs write) while it runs — the old 8MB cap
      // tripped a MemoryLimitError before such a cell could finish (e.g. a 6.6MB PDF). The rquickjs
      // heap limit (set_memory_limit, 64MB in the engine) and the snapshot size-admission guard
      // remain the hard OOM fences; this tripwire just catches runaway per-cell growth.
      const growCapPages = (this.config.cellGrowCapPages ?? 0) || 1024;
      let status = ex.eval_begin(ex.scratch_ptr(), srcBytes.length, budget, growCapPages);
      let guard = 0;
      // host-call loop cap: bound the host calls a single cell may make (re-entrant cells
      // can chain many). Configurable via config.maxHostCallsPerCell; default 64.
      const maxHostCalls = (this.config.maxHostCallsPerCell ?? 0) || 64;
      // E6 oplog: capture host requests+results for the crash-tail journal (host-side).
      this._cellHostResults = [];
      while (status === STATUS_HOST_CALL && guard++ < maxHostCalls) {
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
      const err = e as { name?: string; message?: string };
      return JSON.stringify({
        ok: false,
        valueType: "error",
        logs: [],
        error: { name: (err && err.name) || "GlueError", message: String((err && err.message) || e), stack: "" },
      });
    }
  }

  // host effects the ENGINE cannot do from wasip1: fetch (allowlisted). The RLM surface
  // (host.subLM / host.ctx.* / host.final / host.finalVar) and host.kv were removed.
  async _serviceHostCall(req: HostCall): Promise<HostResult> {
    const name = req.name;
    const args = req.args || [];
    // `fetch` is the built-in DO-side host effect (allowlisted). Everything else is a
    // CLIENT host-callback: round-trip to the connected client over the WS.
    if (name === "fetch") return this._doFetch(args[0] as string, args[1] as RequestInit | undefined);
    // host-backed fs (config.fs.provider != vfs): serviced DO-side via the installed _fsHandler.
    if (name === "__fs") return this._serviceFs(args[0] as Record<string, unknown>);
    return this._clientHostCall(name, args);
  }

  // _serviceFs: bridge the engine's `host.__fs({op,path,data?})` to the DO-side R2/S3 handler.
  // Binary crosses the engine boundary as base64 (`data`); here we decode it to a Uint8Array for
  // the handler, and re-encode returned bytes to base64 for the engine. Errors are passed back as
  // a value `{error}` so the in-VM fs throws them (e.g. ENOENT), never crossing as a reject.
  async _serviceFs(req: Record<string, unknown>): Promise<HostResult> {
    const h = this._fsHandler;
    if (!h) {
      return { ok: true, value: { error: "FsError: no fs provider active (set config.fs.provider)" } };
    }
    const op = String(req && req.op);
    const payload: Record<string, unknown> = { op, path: req && req.path };
    if (op === "write" && typeof req.data === "string") {
      try {
        payload.bytes = Uint8Array.from(atob(req.data as string), (c) => c.charCodeAt(0));
      } catch {
        return { ok: true, value: { error: "FsError: bad base64 write payload" } };
      }
    }
    let res: Record<string, unknown>;
    try {
      res = (await h(payload)) as Record<string, unknown>;
    } catch (e) {
      const err = e as { message?: string };
      return { ok: true, value: { error: "FsError: " + String((err && err.message) || e) } };
    }
    if (res && res.error) return { ok: true, value: { error: res.error } };
    const value: Record<string, unknown> = { ok: true };
    if (res && res.bytes instanceof Uint8Array) {
      let s = "";
      const u8 = res.bytes as Uint8Array;
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      value.data = btoa(s);
    }
    if (res && Array.isArray(res.names)) value.names = res.names;
    if (res && typeof res.size === "number") {
      value.size = res.size;
      value.isFile = !!res.isFile;
      value.isDirectory = !!res.isDirectory;
    }
    return { ok: true, value };
  }

  // _clientHostCall: park the VM eval, send {t:hostcall,id,name,args} to the client, and
  // await the correlated {t:hostcall-result,id,...} reply (delivered out-of-band by lib.rs
  // -> resolveHostCall). Rejects cleanly (never throws across the boundary) when there is
  // no live socket, the payload is oversized, or the client never answers in time — the
  // engine turns {ok:false} into a rejected VM promise, the cell fails, and the eval mutex
  // is released.
  async _clientHostCall(name: string, args: unknown[]): Promise<HostResult> {
    const sender = this._hostSender;
    if (!sender) {
      return { ok: false, error: "HostCallUnavailable: no client socket for host." + name };
    }
    const id = "hc-" + (++__hostCallSeq).toString(36) + "-" + Date.now().toString(36);
    let argsJson: string;
    try {
      argsJson = JSON.stringify(args ?? []);
    } catch {
      return { ok: false, error: "HostCallArgsError: host." + name + " args not JSON-serialisable" };
    }
    const frame = JSON.stringify({ t: "hostcall", id, name, args: JSON.parse(argsJson) });
    // SIZE GUARD: mirror the engine HOSTCALL buffer (64KB) — refuse an oversized request.
    if (TEXT_ENC.encode(frame).length > (1 << 16)) {
      return { ok: false, error: "HostCallSizeError: host." + name + " request exceeds 64KB" };
    }
    return new Promise<HostResult>((resolve) => {
      const timer = setTimeout(() => {
        __pendingHostCalls.delete(id);
        resolve({ ok: false, error: "HostCallTimeout: client did not answer host." + name + " in time" });
      }, sender.timeoutMs);
      __pendingHostCalls.set(id, { resolve, timer });
      const sent = sender.send(frame);
      if (!sent) {
        __pendingHostCalls.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: "HostCallUnavailable: client socket send failed for host." + name });
      }
    });
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

      // BINARY-SAFE: a request body may be binary (git-upload-pack POSTs a packfile). The engine
      // sends it as base64 in `init.bodyB64`; decode to bytes before fetch. (A plain string `body`
      // still works for back-compat.)
      let fetchInit: RequestInit | undefined = init;
      if (init && typeof (init as { bodyB64?: unknown }).bodyB64 === "string") {
        const ri = { ...(init as Record<string, unknown>) } as RequestInit & { bodyB64?: string };
        const reqBytes = b64ToBytes((init as { bodyB64: string }).bodyB64);
        delete ri.bodyB64;
        ri.body = reqBytes as unknown as BodyInit;
        fetchInit = ri;
      }

      const r = await fetch(url, fetchInit || undefined);
      // BINARY-SAFE: read RAW BYTES (arrayBuffer), never lossy `.text()`. Cross the boundary as
      // base64 (`bodyB64`) — exact bytes both ways. Cap at FETCH_MAX_BODY_BYTES (was 1MB).
      const ab = await r.arrayBuffer();
      let bytes = new Uint8Array(ab);
      let truncated = false;
      if (bytes.length > FETCH_MAX_BODY_BYTES) {
        bytes = bytes.subarray(0, FETCH_MAX_BODY_BYTES);
        truncated = true;
      }
      const bodyB64 = bytesToB64(bytes);
      // back-compat utf8 view — CAPPED to a small preview (the exact bytes are in bodyB64). Decoding
      // the FULL body here for a large payload would double the host-call result size and OOM the VM
      // (see FETCH_BODY_UTF8_PREVIEW_BYTES). The engine's .text()/.json() fall back to bodyB64 when
      // the body is truncated, so this only shrinks the convenience preview, never correctness.
      const bodyTruncated = bytes.length > FETCH_BODY_UTF8_PREVIEW_BYTES;
      const body = TEXT_DEC.decode(bodyTruncated ? bytes.subarray(0, FETCH_BODY_UTF8_PREVIEW_BYTES) : bytes);
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => (headers[k] = v));
      return {
        ok: true,
        value: {
          status: r.status,
          ok: r.ok,
          headers,
          body,
          bodyTruncated,
          bodyB64,
          byteLength: bytes.length,
          truncated,
        },
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
    let prev = this._lastImage;
    // LARGE-BUFFER 2-COPY NO-RETAIN PATH (memory-safety fence; see LARGE_BUFFER_NO_RETAIN_BYTES).
    // Only trips when the buffer carries a big payload (well above the ~59MB normal-session ceiling),
    // so ordinary cells are unaffected and keep the delta path + oplog tail. RELEASE the retained
    // image FIRST (free prev), gzip raw to a single full base, and do NOT retain a new _lastImage —
    // peak memory is ~raw + gz. Emits mode:"full" (the DO full path resets the oplog tail).
    if (raw.byteLength > LARGE_BUFFER_NO_RETAIN_BYTES) {
      this._lastImage = null;
      prev = null;
      const gz = await gzip(raw);
      return { mode: "full", gz, indicesGz: null, nChanged: 0, grain: DELTA_GRAIN_BYTES,
        imageLen: raw.byteLength, sizeGz: gz.byteLength, ...common };
    }
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
      const deltaBlobsFit = payGz.byteLength <= DELTA_MAX_BLOB_BYTES && idxGz.byteLength <= DELTA_MAX_BLOB_BYTES;
      if (deltaBlobsFit && deltaStored < fullGz.byteLength * DELTA_FALLBACK_PCT) {
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

  // _writeScratch: copy `bytes` into the engine's FIXED 32MB SCRATCH buffer (raised from 1MB to
  // match FETCH_MAX_BODY_BYTES so large fetch bodies / fs writes can cross the boundary). The engine exposes
  // scratch_cap() = capacity; we bounds-check FIRST so an oversized payload throws a typed
  // ProtocolSizeError (caller turns it into {ok:false}) instead of a TypedArray.set RangeError
  // ("offset is out of bounds") that overruns linear memory. Universal backstop for every caller
  // (eval source, stdlib IIFE, resume payload, kv import).
  _writeScratch(bytes: Uint8Array): void {
    const ex = this._ex();
    const cap = ex.scratch_cap();
    if (bytes.length > cap) {
      const e = new Error(
        "ProtocolSizeError: payload " + bytes.length + "B exceeds scratch capacity " + cap +
          "B (max eval/source size)"
      );
      (e as Error & { name: string }).name = "ProtocolSizeError";
      throw e;
    }
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
