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
const BASE_EVERY_CELLS = 20;     // full compacted base cadence; bounds the restore delta-chain length

const MAX_STDLIB_SOURCE_BYTES = 500 * 1024; // V0.7 GUARD 1: combined injected stdlib source cap

// ---- v0.6 configurable in-VM stdlib (esbuilt IIFE bundle, evaled at create) ----
let __stdlibBundleCache = null;
function stdlibBundle() {
  if (__stdlibBundleCache) return __stdlibBundleCache;
  const raw = globalThis.__STDLIB_BUNDLE;
  try { __stdlibBundleCache = raw ? JSON.parse(raw) : {}; } catch { __stdlibBundleCache = {}; }
  return __stdlibBundleCache;
}
const STDLIB_NAMES = (() => { const m = globalThis.__STDLIB_META; return (m && Array.isArray(m.modules)) ? m.modules : []; })();
const STDLIB_OPTIN = (() => { const m = globalThis.__STDLIB_META; return (m && Array.isArray(m.optIn)) ? m.optIn : []; })();
// Normalize config.modules -> concrete name list. true=all defaults (opt-in EXCLUDED);
// [names]=explicit subset (opt-in allowed if named); false/undefined=none.
function resolveStdlibModules(cfgModules) {
  const bundle = stdlibBundle();
  const available = new Set(Object.keys(bundle));
  const optIn = new Set(STDLIB_OPTIN);
  if (cfgModules === true) return STDLIB_NAMES.filter((n) => available.has(n) && !optIn.has(n));
  if (Array.isArray(cfgModules)) return cfgModules.filter((n) => available.has(n));
  return [];
}

class GlueKernel {
  constructor() {
    this.inst = null;
    this.wasiCtl = null;
    this.config = {};
    this.clockSeed = 0;
    this.rngSeed = 42;
    this.lastTimings = {};
    this._fetchAllow = true; // resolved from config at create/restore
    // W4: the previous committed image, retained host-side (NOT in the VM heap), so the next
    // checkpoint can byte-diff against it. Dropped on evict; re-derived on cold wake (base+deltas).
    this._lastImage = null;
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
    // stdlib injection: eval the selected esbuilt IIFEs into the live VM so they snapshot-
    // persist (survive hibernation, no re-inject). Subset chosen by config.modules.
    this._injectStdlib(cfg.modules);
    this.lastTimings = { instantiateMs: 0, growCount: 0 };
    return "fresh";
  }

  _injectStdlib(cfgModules) {
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
        if (res.ok !== false) this._stdlibLoaded.push(name);
      } catch { /* skip a failed module, never fatal */ }
    }
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
    usedHeap
  ) {
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
  async restoreW4(baseGz, deltaList, engineHash, clockCalls, rngCalls, configJson, label, kvJson, usedHeap) {
    this._applyConfig(configJson);
    const t0 = Date.now();
    const base = await gunzip(baseGz);
    let image = base; // grown + mutated by deltas
    const deltas = Array.isArray(deltaList) ? deltaList : [];
    // Pre-decode each delta so we can size the reconstructed image to the LARGEST grain target
    // across the chain (the buffer grows monotonically, so a later delta may extend past the base).
    const decoded = [];
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

  lastRestoreTimings() {
    return JSON.stringify(this.lastTimings || {});
  }

  // E6: the host requests+results serviced during the last eval (for the crash-tail oplog).
  lastCellHostResults() {
    try { return JSON.stringify(this._cellHostResults || []); } catch { return "[]"; }
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
      // E6 oplog: capture host requests+results for the crash-tail journal (host-side).
      this._cellHostResults = [];
      while (status === STATUS_HOST_CALL && guard++ < 64) {
        const req = this._readHostCall();
        let res;
        if (this._replayHostResults && this._replayHostResults.length) {
          // engine-migration replay: feed the recorded result, do NOT re-fire the effect.
          res = this._replayHostResults.shift();
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
      return JSON.stringify({
        ok: false,
        valueType: "error",
        logs: [],
        error: { name: "GlueError", message: String(e && e.message || e), stack: "" },
      });
    }
  }

  // host effects the ENGINE cannot do from wasip1: fetch (allowlisted). The RLM surface
  // (host.subLM / host.ctx.* / host.final / host.finalVar) and host.kv were removed.
  async _serviceHostCall(req) {
    const name = req.name;
    const args = req.args || [];
    if (name === "fetch") return this._doFetch(args[0], args[1]);
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
  //
  // W5 compaction (docs/W5-COMPACTION-PLAN.md). The size-admission GUARD lives here. WASM
  // linear memory is MONOTONIC — it never shrinks. A session that spikes then frees keeps a
  // high-water-mark buffer. So the admission is on the USED heap (the genuine OOM fence:
  // serialize/gz cost scales with LIVE data), NOT the monotonic buffer. We keep an ABSOLUTE
  // safe-serialize cap on the raw buffer to avoid the adversarial W4-ceiling regression
  // (docs/ADVERSARIAL.md breach #1) — a buffer genuinely too large to serialize without an
  // uncatchable OOM is hard-rejected. Between 18MB and that cap, a spiked-then-freed session
  // is ADMITTED: it is GC'd + SCRUBBED (freed pages zeroed) so the stored gz collapses.
  // Shared W5 admission + GC + scrub + raw-image extraction for both dump() and dumpW4().
  // Returns { raw, usedHeap, bufferBytes, scrubbed }. Throws SizeAdmissionError on a too-big
  // (or wedged) buffer/heap — socket alive, next eval works.
  _serializeForDump() {
    const ex = this._ex();
    const bufBytes0 = Number(ex.buffer_bytes());

    // ABSOLUTE cap FIRST (before any full-buffer touch): a buffer above the safe-serialize
    // ceiling risks an uncatchable OOM (snapshot+gz is ~2-3x). Hard-reject, socket alive.
    // This absolute cap is what prevents the adversarial W4-ceiling regression.
    if (bufBytes0 > SAFE_SERIALIZE_BUFFER_BYTES) {
      throw new Error(
        "SizeAdmissionError: linear buffer " + bufBytes0 +
          "B > SAFE_SERIALIZE_BUFFER_BYTES " + SAFE_SERIALIZE_BUFFER_BYTES +
          " (WASM memory cannot shrink in place; refusing snapshot — reset to recover)"
      );
    }

    // W5 (a): admit on the live used heap. We only GC/scrub when the buffer is actually
    // BLOATED (a freed spike) — running GC on every checkpoint is unnecessary and (critically)
    // a forced GC across a pending-promise reaction can disturb in-flight job state, so the
    // steady-state path leaves the heap untouched. used_heap() alone does not GC.
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

  _dumpCommon(usedHeap, bufferBytes, scrubbed, raw) {
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
  async dump() {
    const { raw, usedHeap, bufferBytes, scrubbed } = this._serializeForDump();
    const gz = await gzip(raw);
    this._lastImage = raw.slice();
    return { gz, sizeGz: gz.length, mode: "full", grain: DELTA_GRAIN_BYTES, imageLen: raw.length,
      nChanged: 0, indicesGz: null, ...this._dumpCommon(usedHeap, bufferBytes, scrubbed, raw) };
  }

  // W4 BYTE-DELTA dump (docs/W4-BYTEDELTA-PLAN.md). Diffs the current raw image vs the retained
  // `this._lastImage` at a 256B grain. If a prior image exists, !forceFull, equal length, AND the
  // delta is small (< DELTA_FALLBACK_PCT of full) => emit mode:"delta" carrying ONLY the changed
  // grains + indices (zero re-fire — exact bytes). Else => mode:"full" (W5-compacted base), reset
  // the chain. The host (lib.rs) sets forceFull on the base cadence / no prior base.
  async dumpW4(forceFull) {
    const { raw, usedHeap, bufferBytes, scrubbed } = this._serializeForDump();
    const common = this._dumpCommon(usedHeap, bufferBytes, scrubbed, raw);
    const prev = this._lastImage;
    // W4 (growth-tolerant): the WASM linear buffer is MONOTONIC — between cells it commonly grows
    // by whole 64KB pages, so the prior `prev.byteLength === raw.byteLength` gate fell through to a
    // FULL base on EVERY commit (the gate's "full-image-every-commit"). We now allow a delta when
    // the current buffer is the SAME size or LARGER than prev: diff the overlapping prefix grain-by-
    // grain, and mark every newly-grown grain (beyond prev.byteLength) as changed so its exact bytes
    // are carried. The delta records the target imageLen; restoreW4 extends the image to fit.
    const canDelta = !forceFull && prev && raw.byteLength >= prev.byteLength;

    if (canDelta) {
      const grain = DELTA_GRAIN_BYTES;
      const nGrains = Math.ceil(raw.byteLength / grain);
      const prevLen = prev.byteLength;
      const changed = [];
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

  // stdlib injection: report which modules were injected at create (the esbuilt bundle evaled
  // into the VM). The actual catalog is wired by lib.rs via the STDLIB bundle Text module.
  stdlibInfo() {
    return JSON.stringify({ loaded: this._stdlibLoaded || [], available: STDLIB_NAMES, optIn: STDLIB_OPTIN });
  }
  // E6 ENGINE-MIGRATION journal replay (docs E6). On an engine-hash mismatch at cold wake,
  // the byte-blit image is invalid (a different engine layout), so the DO replays the retained
  // cell oplog into a FRESH instance under the same config — no re-fire of pure cells, host
  // results fed back from the recorded oplog. journal = [{src, hostResults:[...]}].
  async replayJournal(journal, configJson, kvJson) {
    await this.createFresh(configJson);
    if (kvJson && kvJson !== "{}") this._importKv(kvJson);
    const cells = Array.isArray(journal) ? journal : [];
    let replayed = 0, failed = 0, effectful = 0;
    const errors = [];
    for (const c of cells) {
      try {
        // feed recorded host results back in order (no re-fire of effects).
        this._replayHostResults = Array.isArray(c.hostResults) ? c.hostResults.slice() : [];
        if (this._replayHostResults.length) effectful++;
        const out = await this.evalCode(String(c.src || ""));
        const parsed = JSON.parse(out);
        if (parsed.ok === false) failed++; else replayed++;
      } catch (e) { failed++; errors.push(String(e && e.message || e)); }
    }
    this._replayHostResults = null;
    return JSON.stringify({ replayed, failed, effectfulCells: effectful, errors });
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
