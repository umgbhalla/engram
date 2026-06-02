// kernel-glue.mjs — the THIN JS shim that the Rust DO (lib.rs) binds to.
//
// IMPORTANT: this file contains NO kernel business logic. All eval / value-preview /
// guards / determinism / host-boundary logic lives in the Rust ENGINE wasm
// (src/engine.wasm). This shim only provides:
//   * the WASI host imports the engine needs (wasm32-wasip1),
//   * the literal memory.buffer BLIT (snapshot substrate) + gzip,
//   * the engine instantiate + the host-effect IMPLEMENTATION the engine can't do
//     from inside wasip1 (host.fetch -> DO-side fetch with allowlist).
//
// The engine ABI (C exports) is documented in engine/src/lib.rs.

// The precompiled engine WebAssembly.Module, exposed on globalThis by entry.mjs
// (CompiledWasm import — workerd forbids runtime WebAssembly.compile of bytes).
const ENGINE_MODULE = () => globalThis.__ENGINE_MODULE;
const ENGINE_HASH = () => globalThis.__ENGINE_HASH || "rust-engine-unknown";

export function getEngineHash() {
  return ENGINE_HASH();
}

// ---- in-DO async mutex (JS promise-chain) — same shape lib.rs expects ----
export function newMutex() {
  return new Mutex();
}
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }
  acquire() {
    let release;
    const next = new Promise((res) => (release = res));
    const prev = this._tail;
    this._tail = next;
    return prev.then(() => release);
  }
}

// ---- minimal WASI preview1 shim sufficient for the engine ----
// The engine only needs: clock (seeded — we override via the Rust clock anyway),
// random_get (seeded), fd_write (stderr/stdout no-op-ish), proc_exit, args/env stubs,
// and the handful of fns rquickjs/std touch. Determinism: random_get is SEEDED so a
// seeded session is byte-reproducible across restore.
function makeWasi(rngSeed) {
  let mem = null;
  const setMem = (m) => (mem = m);
  // seeded mulberry32 for random_get (entropy externalized + deterministic).
  let s = (rngSeed >>> 0) || 0x9e3779b9;
  const rnd = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const view = () => new DataView(mem.buffer);
  const u8 = () => new Uint8Array(mem.buffer);
  const wasi = {
    args_get: () => 0,
    args_sizes_get: (argc, argvBuf) => {
      view().setUint32(argc, 0, true);
      view().setUint32(argvBuf, 0, true);
      return 0;
    },
    environ_get: () => 0,
    environ_sizes_get: (c, b) => {
      view().setUint32(c, 0, true);
      view().setUint32(b, 0, true);
      return 0;
    },
    clock_res_get: (_id, out) => {
      view().setBigUint64(out, 1000n, true);
      return 0;
    },
    clock_time_get: (_id, _prec, out) => {
      // frozen deterministic clock; the engine uses its OWN seeded Date.now anyway.
      view().setBigUint64(out, 0n, true);
      return 0;
    },
    fd_write: (fd, iovs, iovsLen, nwritten) => {
      // count bytes; route stderr(2) to console for engine panics; drop stdout.
      let total = 0;
      const dv = view();
      let chunks = [];
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
        } catch {}
      }
      dv.setUint32(nwritten, total, true);
      return 0;
    },
    fd_read: (_fd, _iovs, _iovsLen, nread) => {
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
    random_get: (ptr, len) => {
      const a = u8();
      for (let i = 0; i < len; i++) a[ptr + i] = (rnd() * 256) & 0xff;
      return 0;
    },
    poll_oneoff: () => 0,
    sched_yield: () => 0,
    proc_exit: (code) => {
      throw new Error("engine proc_exit(" + code + ")");
    },
  };
  return { wasi, setMem };
}

// ---- the GlueKernel the Rust DO drives ----
export function newGlueKernel() {
  return new GlueKernel();
}

const TEXT_ENC = new TextEncoder();
const TEXT_DEC = new TextDecoder();
const STATUS_HOST_CALL = 1;

class GlueKernel {
  constructor() {
    this.inst = null;
    this.wasiCtl = null;
    this.config = {};
    this.clockSeed = 0;
    this.rngSeed = 42;
    this.lastTimings = {};
    this._fetchAllow = true; // resolved from config at create/restore
  }

  _newInstance(rngSeed) {
    const { wasi, setMem } = makeWasi(rngSeed);
    const inst = new WebAssembly.Instance(ENGINE_MODULE(), {
      wasi_snapshot_preview1: wasi,
    });
    setMem(inst.exports.memory);
    // WASI reactor init: call _initialize if present (no _start for reactors).
    if (typeof inst.exports._initialize === "function") {
      try {
        inst.exports._initialize();
      } catch {}
    }
    this.wasiCtl = { wasi, setMem };
    return inst;
  }

  _ex() {
    return this.inst.exports;
  }

  // seed scalars from config (clock mode + rngSeed) — parity with JS kernel.
  _applyConfig(configJson) {
    let cfg = {};
    try {
      cfg = JSON.parse(configJson || "{}");
    } catch {}
    this.config = cfg;
    this.rngSeed = (cfg.rngSeed >>> 0) || 42;
    // clock seed: seeded sessions start at 0 tick (engine adds the 1.7e12 epoch).
    this.clockSeed = 0;
    // fetch allowlist: true=all, false=none, [hosts]=hostnames.
    this._fetchAllow = cfg.fetch === undefined ? true : cfg.fetch;
    return cfg;
  }

  async createFresh(configJson) {
    const cfg = this._applyConfig(configJson);
    this.inst = this._newInstance(this.rngSeed);
    this._ex().create(BigInt(this.clockSeed), BigInt(this.rngSeed));
    this.lastTimings = { instantiateMs: 0, growCount: 0 };
    return "fresh";
  }

  // restore: blit the gz image into a fresh instance, then re-seed counters + kv.
  async restore(
    gz,
    engineHash,
    clockCalls,
    rngCalls,
    configJson,
    label,
    kvJson,
    usedHeap,
    ctxJson
  ) {
    this._applyConfig(configJson);
    const t0 = Date.now();
    // gunzip the snapshot image.
    const raw = await gunzip(gz);
    const gunzipMs = Date.now() - t0;
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
    this.lastTimings = { gunzipMs, instantiateMs: 0, growCount, neededPages: needPages };
    return label || "sqlite-restore";
  }

  lastRestoreTimings() {
    return JSON.stringify(this.lastTimings || {});
  }

  // evalCode: ASYNC. Drives the engine eval_begin/eval_resume loop, servicing host
  // effects (host.fetch -> DO-side fetch). Returns the rich JSON result STRING and
  // NEVER throws across the boundary (so the eval mutex is always released).
  async evalCode(src) {
    try {
      const ex = this._ex();
      const srcBytes = TEXT_ENC.encode(src);
      this._writeScratch(srcBytes);
      // per-cell guards: interrupt-tick budget + per-cell buffer-growth cap (pages).
      // The budget counts INTERRUPT-HANDLER invocations (QuickJS fires the handler
      // every ~Nk bytecodes), so the certified value is ~1200 (parity with the JS
      // kernel's default 1200 / cap 2000), NOT millions.
      const budget = BigInt((this.config.cellBudgetTicks | 0) || 1200);
      const growCapPages = (this.config.cellGrowCapPages | 0) || 128; // ~8MB per cell
      let status = ex.eval_begin(ex.scratch_ptr(), srcBytes.length, budget, growCapPages);
      let guard = 0;
      while (status === STATUS_HOST_CALL && guard++ < 64) {
        const req = this._readHostCall();
        const res = await this._serviceHostCall(req);
        const resBytes = TEXT_ENC.encode(JSON.stringify(res));
        this._writeScratch(resBytes);
        status = ex.eval_resume(ex.scratch_ptr(), resBytes.length);
      }
      return this._readResult();
    } catch (e) {
      return JSON.stringify({
        ok: false,
        valueType: "error",
        logs: [],
        error: { name: "GlueError", message: String(e && e.message || e), stack: "" },
      });
    }
  }

  // host effects the ENGINE cannot do from wasip1. Today: fetch (allowlisted).
  // host.kv is handled INSIDE the engine (small + persisted), so it never reaches here.
  async _serviceHostCall(req) {
    const name = req.name;
    const args = req.args || [];
    if (name === "fetch") {
      return this._doFetch(args[0], args[1]);
    }
    // unknown host fn -> typed reject (engine turns this into a rejected VM promise).
    return { ok: false, error: "UnknownHostFn: host." + name };
  }

  async _doFetch(url, init) {
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
      const headers = {};
      r.headers.forEach((v, k) => (headers[k] = v));
      return {
        ok: true,
        value: { status: r.status, ok: r.ok, headers, body: body.slice(0, 1 << 20) },
      };
    } catch (e) {
      return { ok: false, error: "FetchError: " + String(e && e.message || e) };
    }
  }

  // dump: read the live linear memory + counters + kv, gzip, return the image + meta.
  // (the size-admission GUARD lives here: a too-big buffer fails with a typed error
  // BEFORE we attempt to store it — socket alive, next eval works.)
  async dump() {
    const ex = this._ex();
    const usedHeap = Number(ex.used_heap());
    const bufferBytes = Number(ex.buffer_bytes());
    // GUARD: dump ceiling on the raw linear buffer (parity: 18MB clean-reject).
    const MAX_DUMP_BUFFER_BYTES = 18 * 1024 * 1024;
    if (bufferBytes > MAX_DUMP_BUFFER_BYTES) {
      throw new Error(
        "SizeAdmissionError: linear buffer " +
          bufferBytes +
          "B exceeds MAX_DUMP_BUFFER_BYTES " +
          MAX_DUMP_BUFFER_BYTES
      );
    }
    const raw = new Uint8Array(ex.memory.buffer.slice(0));
    const gz = await gzip(raw);
    const clockCalls = Number(ex.clock_calls());
    const rngCalls = Number(ex.rng_calls());
    const kvJson = this._exportKv();
    return {
      gz,
      sizeRaw: raw.length,
      sizeGz: gz.length,
      usedHeap,
      bufferBytes,
      scrubbed: false,
      stackPointer: 0,
      clockCalls,
      rngCalls,
      kvJson,
      ctxJson: "{}",
    };
  }

  _exportKv() {
    const ex = this._ex();
    const ptr = ex.kv_export_ptr();
    const len = ex.kv_export_len();
    return TEXT_DEC.decode(new Uint8Array(ex.memory.buffer, ptr, len).slice());
  }
  _importKv(json) {
    const ex = this._ex();
    const bytes = TEXT_ENC.encode(json);
    this._writeScratch(bytes);
    ex.kv_import(ex.scratch_ptr(), bytes.length);
  }

  // V0.9 host-side context + RLM final are DEFERRED (stubs for ABI parity).
  setContext(_name, blob) {
    return blob ? blob.length : 0;
  }
  finalInfo() {
    return "{}";
  }
  stdlibInfo() {
    return JSON.stringify({ loaded: [], available: [], note: "stdlib deferred to 1b" });
  }
  async replayJournal(_journalJson, configJson, _kvJson, _ctxJson) {
    // engine-migration replay DEFERRED to 1b — create fresh under config so the DO
    // does not wedge on an engine-hash mismatch.
    await this.createFresh(configJson);
    return JSON.stringify({ replayed: 0, failed: 0, effectfulCells: 0, errors: ["replay deferred to 1b"] });
  }

  _writeScratch(bytes) {
    const ex = this._ex();
    new Uint8Array(ex.memory.buffer).set(bytes, ex.scratch_ptr());
  }
  _readResult() {
    const ex = this._ex();
    const ptr = ex.result_ptr();
    const len = ex.result_len();
    return TEXT_DEC.decode(new Uint8Array(ex.memory.buffer, ptr, len).slice());
  }
  _readHostCall() {
    const ex = this._ex();
    const ptr = ex.pending_host_call_ptr();
    const len = ex.pending_host_call_len();
    return JSON.parse(TEXT_DEC.decode(new Uint8Array(ex.memory.buffer, ptr, len).slice()));
  }

  drop() {
    this.inst = null;
    this.wasiCtl = null;
  }
}

// ---- gzip/gunzip via the platform CompressionStream (workerd-native) ----
async function gzip(u8) {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(u8);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function gunzip(u8) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter();
  w.write(u8);
  w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
