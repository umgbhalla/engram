// engram — JS glue boundary. Driven by the Rust Durable Object shell (lib.rs).
// Snapshot-perturbing state lives in the wasm heap; everything else (entropy counters,
// config, console buffer, deadline) lives OUTSIDE it and is reconstructed on restore.
// Full version/BUG/GUARD/FEATURE narrative: see docs/glue-changelog.md.

import { QuickJS, EvalFlags } from "quickjs-wasi";

function engineHashValue() {
  return globalThis.__ENGINE_HASH || "unset-engine-hash";
}

// ---- size-admission guards (bytes). OOM is uncatchable => guard by size. ----
// Rationale + sizing history for every constant below: see docs/glue-changelog.md.
const MAX_USED_BYTES = 50 * 1024 * 1024; // refuse snapshot above ~50MB *live used* heap
const MAX_RESTORE_USED_BYTES = 50 * 1024 * 1024; // refuse restore above ~50MB *recorded used* heap
// W5 UN-WEDGE: safe-to-instantiate raw ceiling, in LOCKSTEP with the dump SAFE_SERIALIZE_BUFFER_BYTES.
// A spiked-then-freed image is stored scrubbed (freed pages zeroed) so its gz is tiny, but it
// gunzips back to the full raw (zeroed) buffer extent (18..45MB). The genuine fence is the RECORDED
// used heap (MAX_RESTORE_USED_BYTES); this raw ceiling only fails images too big to safely
// instantiate. Was 18MB (which re-wedged a freed-spike session ON RESTORE). docs/W5-COMPACTION-PLAN.md.
const MAX_RESTORE_RAW_BYTES = 45 * 1024 * 1024; // safe-to-instantiate raw ceiling (lockstep w/ dump)
const SCRUB_SLACK_BYTES = 4 * 1024 * 1024; // scrub freed arena when buffer-usedHeap exceeds this
const SCRUB_MAX_BUFFER_BYTES = 44 * 1024 * 1024; // only scrub below this (must stay < hard ceiling)
const MAX_DUMP_BUFFER_BYTES = 18 * 1024 * 1024; // soft dump ceiling on the monotonic linear buffer
// W5 UN-WEDGE: hard safe-to-serialize ceiling on the monotonic linear buffer. A spiked-then-freed
// session keeps a large buffer but a tiny USED heap; the old code hard-rejected on the 18MB buffer
// BEFORE any scrub, permanently wedging it (SizeAdmissionError forever). REALCF-VALIDATION sized the
// real OOM cliff at ~48MB full-spike dump; 45MB sits safely below it. Above 18MB but below this, we
// admit a session IF its USED heap is in-envelope and its freed slack scrubs/gz away. The genuine
// OOM fence is the USED-heap admission (MAX_USED_BYTES), not the monotonic buffer. docs/W5-COMPACTION-PLAN.md.
const SAFE_SERIALIZE_BUFFER_BYTES = 45 * 1024 * 1024;
// W5 cell-boundary scrub trigger (plan §3(c)): scrub when the buffer is bloated AND the live used
// heap is < this fraction of it (>= 60% slack = a freed spike), so the STORED gz image shrinks.
const COMPACT_TRIGGER_BYTES = 12 * 1024 * 1024;
const COMPACT_USED_RATIO = 0.4;

const MAX_CELL_USED_BYTES = 16 * 1024 * 1024; // V0.8 FEATURE A: mid-cell tripwire absolute backstop
const CELL_GROWTH_LIMIT_BYTES = 8 * 1024 * 1024; // V0.8 FEATURE A: per-cell linear-memory growth limit

const NATIVE_MALLOC_LIMIT_BYTES = 16 * 1024 * 1024; // V0.9.3 GAP 1: native-C giant-alloc backstop
const HOST_ARG_MAX_BYTES = 8 * 1024 * 1024; // V0.9.3 GAP 1: host-bridged arg/result fence

const MAX_STDLIB_SOURCE_BYTES = 500 * 1024; // V0.7 GUARD 1: combined injected stdlib source cap
const MAX_INLINE_STDLIB_BYTES = 2 * 1024 * 1024; // V0.7 GUARD 1: inline config.stdlib blob fence

function quickjsModuleRef() {
  const m = globalThis.__QJS_MODULE;
  if (!m) throw new Error("globalThis.__QJS_MODULE (CompiledWasm) not set by entry");
  return m;
}

export function getEngineHash() {
  return engineHashValue();
}

// ---- v0.6 configurable in-VM stdlib ----------------------------------------
// The build-time bundle is a JSON string {moduleName: iifeString} set on globalThis
// by entry.mjs (a wrangler Text module). Parse it once, lazily, and cache.
let __stdlibBundleCache = null;
function stdlibBundle() {
  if (__stdlibBundleCache) return __stdlibBundleCache;
  const raw = globalThis.__STDLIB_BUNDLE;
  if (typeof raw === "string" && raw.length) {
    try {
      __stdlibBundleCache = JSON.parse(raw);
    } catch (_) {
      __stdlibBundleCache = {};
    }
  } else {
    __stdlibBundleCache = {};
  }
  return __stdlibBundleCache;
}
function stdlibDefaultModules() {
  const m = globalThis.__STDLIB_META;
  if (m && Array.isArray(m.modules)) return m.modules.slice();
  return Object.keys(stdlibBundle());
}
// V0.7 GUARD 2: the OPT-IN-ONLY module set (mathjs etc.). These ship in the bundle but are
// NEVER selected by config.modules:true; they load ONLY when explicitly named in an array.
function stdlibOptInModules() {
  const m = globalThis.__STDLIB_META;
  if (m && Array.isArray(m.optIn)) return m.optIn.slice();
  return [];
}

// ---- v0.8 Tier-0 extensions --------------------------------------------------
// ORDERING (load-bearing, do NOT reorder): the snapshot records loaded extensions in THIS order,
// and restore MUST supply the SAME descriptors in the SAME order (quickjs-wasi re-instantiates
// them at fixed memory/table bases before blitting the heap back). See docs/glue-changelog.md.
const EXTENSION_ORDER = ["crypto", "encoding", "url", "structured-clone", "headers"];

// Build ExtensionDescriptor[] from globalThis.__QJS_EXT_MODULES (precompiled Modules; workerd
// forbids runtime WebAssembly.compile). Absent registry -> [] so the kernel still creates.
// initFn defaults to qjs_ext_<name _>_init (matches all 5 .so). See docs/glue-changelog.md.
function buildExtensionDescriptors() {
  const reg = globalThis.__QJS_EXT_MODULES;
  if (!reg || typeof reg !== "object") return [];
  const out = [];
  for (const name of EXTENSION_ORDER) {
    const mod = reg[name];
    if (mod) out.push({ name, wasm: mod });
  }
  return out;
}

// Normalize config.modules -> concrete module-name list. true=all defaults (opt-in EXCLUDED,
// V0.7 GUARD 2); [names]=subset (opt-in allowed only when explicitly named); else [].
// See docs/glue-changelog.md.
function resolveModules(modulesCfg) {
  const bundle = stdlibBundle();
  const available = new Set(Object.keys(bundle));
  if (modulesCfg === true) {
    const optIn = new Set(stdlibOptInModules());
    return stdlibDefaultModules().filter((n) => available.has(n) && !optIn.has(n));
  }
  if (Array.isArray(modulesCfg)) {
    return modulesCfg.map(String).filter((n) => available.has(n));
  }
  return [];
}

// V0.7 GUARD 1: reject (typed SizeAdmissionError) if combined iife source exceeds the safe
// envelope, BEFORE any eval-into-heap. Returns total bytes. See docs/glue-changelog.md.
function enforceStdlibSourceCap(modules) {
  const bundle = stdlibBundle();
  let total = 0;
  for (const name of modules) {
    const iife = bundle[name];
    if (typeof iife === "string") total += iife.length;
  }
  if (total > MAX_STDLIB_SOURCE_BYTES) {
    throw new SizeAdmissionError(
      `selected stdlib source ${total} bytes > MAX_STDLIB_SOURCE_BYTES ${MAX_STDLIB_SOURCE_BYTES} ` +
        `(modules: ${modules.join(", ")}); refusing to inject (would risk the snapshot OOM cliff). ` +
        `select fewer/smaller modules or omit heavy opt-in libs (e.g. mathjs).`,
    );
  }
  return total;
}

// Eval selected stdlib IIFEs into the live VM AFTER REBIND_SRC (so seeded crypto exists for
// nanoid/uuid). A failed module is reported+skipped, never fatal. See docs/glue-changelog.md.
function injectStdlib(vm, modules) {
  const bundle = stdlibBundle();
  const loaded = [];
  const failed = {};
  for (const name of modules) {
    const iife = bundle[name];
    if (typeof iife !== "string") {
      failed[name] = "module not in bundle";
      continue;
    }
    try {
      vm.evalCode(iife, `<stdlib:${name}>`).dispose?.();
      loaded.push(name);
    } catch (e) {
      failed[name] = String(e && e.message ? e.message : e);
    }
  }
  return { loaded, failed };
}

// ---------------------------------------------------------------------------
// V0.9 CODEMODE / RLM host-side context store + handle tools. The RLM context lives HOST-SIDE
// (ctx.contextStore, OUTSIDE wasm, chunked across SQLite rows since v0.9.1) and the VM reads it
// via coarse boundary-crossing tools (host.ctx.len/slice/grep/chunk/get/names). Bytes never
// enter the snapshot envelope; only pulled slices do. Full design: see docs/glue-changelog.md.
const CTX_MAX_SLICE = 1024 * 1024; // cap a single boundary copy (raised in v0.9.1; <8MB cell-growth tripwire)
const CTX_GREP_MAX = 200; // default cap on grep matches returned
const DEFAULT_CTX_NAME = "context";

// ---- gzip helpers (workerd CompressionStream) ----
async function gzip(u8) {
  const cs = new CompressionStream("gzip");
  const stream = new Response(u8).body.pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(u8) {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(u8).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function QJS() {
  return QuickJS;
}

export function getQuickjsModule() {
  return quickjsModuleRef();
}

class EngineHashMismatchError extends Error {
  constructor(expected, actual) {
    super(
      `engine hash mismatch: snapshot engine ${expected} != current ${actual}; ` +
        `refusing to restore (would corrupt state)`,
    );
    this.name = "EngineHashMismatchError";
    this.code = "ENGINE_HASH_MISMATCH";
  }
}
class SizeAdmissionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "SizeAdmissionError";
    this.code = "SIZE_ADMISSION";
  }
}
// V0.8 FEATURE A: mid-cell used-heap tripwire error (distinct from SizeAdmissionError, the
// post-cell dump guard). See docs/glue-changelog.md.
class MemoryLimitError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "MemoryLimitError";
    this.code = "MEMORY_LIMIT";
  }
}
// V0.9.3 GAP 1: native-C giant-alloc / oversized host-arg error (distinct from MemoryLimitError,
// the bytecode-interrupt tripwire). See docs/glue-changelog.md.
class NativeAllocLimitError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "NativeAllocLimitError";
    this.code = "NATIVE_ALLOC_LIMIT";
  }
}
// P3: typed error for blocked outbound fetch (allowlist / fetch:false / bad url).
class FetchBlockedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "FetchBlockedError";
    this.code = "FETCH_BLOCKED";
  }
}

// P3: enforce config.fetch allowlist (false=block all, true=allow all, [hostnames]=allowlist).
// Returns parsed URL or throws FetchBlockedError. See docs/glue-changelog.md.
function enforceFetchAllow(urlStr, fetchCfg) {
  let u;
  try {
    u = new URL(String(urlStr));
  } catch (_) {
    throw new FetchBlockedError(`invalid fetch url: ${String(urlStr)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new FetchBlockedError(`fetch protocol not allowed: ${u.protocol} (http/https only)`);
  }
  if (fetchCfg === true) return u;
  if (fetchCfg === false || fetchCfg == null) {
    throw new FetchBlockedError(
      "outbound fetch is disabled for this session (config.fetch === false)",
    );
  }
  if (Array.isArray(fetchCfg)) {
    const host = u.hostname.toLowerCase();
    const ok = fetchCfg.some((h) => String(h).toLowerCase() === host);
    if (!ok) {
      throw new FetchBlockedError(
        `host '${host}' not in fetch allowlist [${fetchCfg.join(", ")}]`,
      );
    }
    return u;
  }
  throw new FetchBlockedError("outbound fetch is disabled for this session");
}

// Body caps so a giant response can't blow the heap / snapshot envelope.
const FETCH_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB text body cap
const FETCH_MAX_HEADERS = 64;

// ---------------------------------------------------------------------------
// Deterministic host clock + seeded PRNG (entropy counters live OUTSIDE wasm).
// See docs/glue-changelog.md.
// ---------------------------------------------------------------------------
const CLOCK_EPOCH_MS = 1_700_000_000_000;
const CLOCK_TICK_MS = 1;
const DEFAULT_RNG_SEED = 0x12345678;

function mulberry32State(seed) {
  return seed >>> 0;
}
function mulberry32Next(stateBox) {
  let state = stateBox.s | 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  stateBox.s = state;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Entropy source. seeded=false routes to real wall-clock/Math.random; counter state still
// tracked so restore is well-defined. See docs/glue-changelog.md.
function makeEntropy(clockCalls = 0, rngCalls = 0, opts = {}) {
  const seeded = opts.seeded !== false; // default seeded
  const rngSeed = (opts.rngSeed >>> 0) || DEFAULT_RNG_SEED;
  const e = {
    clockCalls,
    rngCalls,
    seeded,
    rngSeed,
    nowMs() {
      if (!seeded) return Date.now();
      const t = CLOCK_EPOCH_MS + e.clockCalls * CLOCK_TICK_MS;
      e.clockCalls++;
      return t;
    },
    // BUG-5: performance.now() seeded off the SAME clock counter (monotonic, ms).
    perfNow() {
      if (!seeded) return 0; // real mode: see perf rebind below
      return e.clockCalls * CLOCK_TICK_MS;
    },
    _rngState() {
      const box = { s: mulberry32State(rngSeed) };
      for (let i = 0; i < e.rngCalls; i++) mulberry32Next(box);
      return box;
    },
    nextFloat() {
      if (!seeded) return Math.random();
      const box = e._rngState();
      const v = mulberry32Next(box);
      e.rngCalls++;
      return v;
    },
    nextByte() {
      return Math.floor(e.nextFloat() * 256) & 0xff;
    },
  };
  return e;
}

function buildWasiFactory(entropy) {
  return (memoryProxy) => ({
    clock_time_get(_clockId, _precision, resultPtr) {
      const view = new DataView(memoryProxy.buffer);
      const ns = BigInt(Math.floor(entropy.nowMs())) * 1_000_000n;
      view.setBigUint64(resultPtr, ns, true);
      return 0;
    },
    random_get(bufPtr, bufLen) {
      const bytes = new Uint8Array(memoryProxy.buffer, bufPtr, bufLen);
      for (let i = 0; i < bufLen; i++) bytes[i] = entropy.nextByte();
      return 0;
    },
  });
}

// In-VM rebind: Date.now / Math.random / crypto / performance.now and console +
// host tool boundary. All host-backed; re-registered by name after restore.
const REBIND_SRC = `
  globalThis.Date.now = function () { return __hostNowMs(); };
  const __OrigDate = globalThis.Date;
  globalThis.Date = new Proxy(__OrigDate, {
    construct(target, args) {
      if (args.length === 0) return new target(__hostNowMs());
      return new target(...args);
    },
    apply(target, thisArg, args) { return target.apply(thisArg, args); },
  });
  globalThis.Date.now = function () { return __hostNowMs(); };
  globalThis.Math.random = function () { return __hostRandom(); };
  // V0.8 FEATURE B + determinism gate: install a seeded JS getRandomValues shim over native
  // crypto; keep native subtle + randomUUID (already routed through seeded WASI random_get).
  // Determinism is gated on config (real mode -> __hostRandom = Math.random). See docs/glue-changelog.md.
  {
    const gv = function (arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = (__hostRandom() * 256) & 0xff;
      return arr;
    };
    if (!globalThis.crypto) {
      try {
        Object.defineProperty(globalThis, 'crypto', {
          value: { getRandomValues: gv }, writable: true, configurable: true, enumerable: false,
        });
      } catch (e) { try { globalThis.crypto = { getRandomValues: gv }; } catch (e2) {} }
    } else {
      // Native crypto present: override getRandomValues with seeded shim, leave subtle/randomUUID.
      try { globalThis.crypto.getRandomValues = gv; } catch (e) {}
    }
  }
  // BUG-5: seeded performance.now(). Native descriptor may be non-writable -> replace the object.
  try {
    Object.defineProperty(globalThis, 'performance', {
      value: { now: function () { return __hostPerfNow(); } },
      writable: true, configurable: true, enumerable: false,
    });
  } catch (e) {
    globalThis.performance = { now: function () { return __hostPerfNow(); } };
  }

  // Output capture: console.* routed to host buffer.
  globalThis.console = {
    log:   function (...a) { __hostConsole('log', a); },
    info:  function (...a) { __hostConsole('info', a); },
    warn:  function (...a) { __hostConsole('warn', a); },
    error: function (...a) { __hostConsole('error', a); },
    debug: function (...a) { __hostConsole('debug', a); },
  };

  // Host tool boundary: host.<name>/<ns>.<name>(...args) -> __hostCall (JSON args) via a
  // recursive proxy. host.fetch + host.subLM are special async cases. See docs/glue-changelog.md.
  function __mkHostProxy(prefix) {
    const callable = function () {};
    return new Proxy(callable, {
      get(_t, name) {
        if (typeof name !== 'string') return undefined;
        // P3: host.fetch(url, init) -> real async outbound fetch (top-level name only).
        if (!prefix && name === 'fetch') {
          return function (url, init) {
            const p = __hostFetch(String(url), JSON.stringify(init === undefined ? null : init));
            // __hostFetch resolves with a JSON STRING; parse to {status,ok,headers,body}.
            return Promise.resolve(p).then(function (s) {
              return typeof s === 'string' ? JSON.parse(s) : s;
            });
          };
        }
        // V0.9 RLM leaf-oracle boundary: host.subLM(prompt, opts) -> async sub-LM call.
        if (!prefix && name === 'subLM') {
          return function (prompt, opts) {
            const p = __hostSubLM(String(prompt), JSON.stringify(opts === undefined ? null : opts));
            return Promise.resolve(p).then(function (s) {
              return typeof s === 'string' ? s : String(s);
            });
          };
        }
        return __mkHostProxy(prefix ? prefix + '.' + name : name);
      },
      apply(_t, _thisArg, args) {
        const out = __hostCall(prefix, JSON.stringify(args === undefined ? [] : args));
        return out === undefined ? undefined : JSON.parse(out);
      },
    });
  }
  globalThis.host = __mkHostProxy('');
  'rebound';
`;

// Stringify a captured console arg the way console would (objects -> JSON-ish).
function fmtArg(h) {
  // h is a JSValueHandle
  try {
    const t = h.typeof;
    if (t === "string") return h.toString();
    if (t === "number" || t === "boolean" || t === "bigint") return String(h.toString());
    if (h.isNull) return "null";
    if (h.isUndefined) return "undefined";
    // object/array/function: structured dump, fall back to string
    if (typeof h.vm.dump === "function") {
      try {
        return JSON.stringify(h.vm.dump(h));
      } catch (_) {}
    }
    return h.toString();
  } catch (e) {
    return `<unprintable: ${String(e)}>`;
  }
}

// Install all host-backed functions (fresh kernel). ctx carries entropy / console buffer /
// host-tool dispatcher.
function installHostFns(vm, ctx) {
  const defs = hostFnDefs(ctx);
  for (const [name, fn] of Object.entries(defs)) {
    const f = vm.newFunction(name, fn);
    vm.setProp(vm.global, name, f);
    f.dispose();
  }
}
function reRegisterHostFns(vm, ctx) {
  const defs = hostFnDefs(ctx);
  for (const [name, fn] of Object.entries(defs)) {
    vm.registerHostCallback(name, fn);
  }
}

// The host callback table. Closures capture `ctx` (mutable holder) so post-restore
// re-registration binds the SAME live entropy/console/tools. (load-bearing: keep ctx capture)
function hostFnDefs(ctx) {
  return {
    __hostNowMs() {
      return this.vm.newNumber(ctx.entropy.nowMs());
    },
    __hostRandom() {
      return this.vm.newNumber(ctx.entropy.nextFloat());
    },
    __hostPerfNow() {
      return this.vm.newNumber(ctx.entropy.perfNow());
    },
    __hostConsole(...args) {
      const level = args[0] ? args[0].toString() : "log";
      const parts = [];
      for (let i = 1; i < args.length; i++) parts.push(fmtArg(args[i]));
      ctx.logs.push({ level, text: parts.join(" ") });
      return this.vm.undefined;
    },
    // P3: REAL outbound fetch. Creates a VM Promise, starts host-side fetch, returns the handle;
    // the eval pump awaits the settle. Does NOT touch ctx.entropy (determinism safe).
    // See docs/glue-changelog.md.
    __hostFetch(...args) {
      const vm = this.vm;
      const urlStr = args[0] ? args[0].toString() : "";
      const initJson = args[1] ? args[1].toString() : "null";
      // Allowlist enforcement surfaced as a REJECTED VM promise (socket stays alive).
      let urlObj, init;
      try {
        // ctx.config.fetch already resolved by normalizeConfig (honors denyFetchByDefault).
        urlObj = enforceFetchAllow(
          urlStr,
          ctx.config && ctx.config.fetch !== undefined ? ctx.config.fetch : true,
        );
      } catch (e) {
        const d = vm.newPromise();
        const errH = vm.newError(e instanceof Error ? e : new Error(String(e)));
        try { errH.setProp("name", vm.newString(e.name || "FetchBlockedError")); } catch (_) {}
        d.reject(errH);
        try { errH.dispose && errH.dispose(); } catch (_) {}
        // Already-rejected: just yield a microtask so the pump drains the rejection.
        ctx.pendingFetches.push(Promise.resolve());
        return d.handle;
      }
      try { init = JSON.parse(initJson); } catch (_) { init = null; }

      const deferred = vm.newPromise();
      const work = (async () => {
        try {
          const reqInit = {};
          const hdrs = {};
          if (init && typeof init === "object") {
            if (init.method) reqInit.method = String(init.method);
            if (init.headers && typeof init.headers === "object") Object.assign(hdrs, init.headers);
            if (init.body != null) reqInit.body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
          }
          // Default User-Agent so UA-strict hosts (e.g. GitHub) don't 403; caller can override.
          if (!Object.keys(hdrs).some((k) => k.toLowerCase() === "user-agent")) {
            hdrs["User-Agent"] = "engram/0.9 (+https://github.com/umgbhalla/montydyn)";
          }
          reqInit.headers = hdrs;
          const resp = await fetch(urlObj.toString(), reqInit);
          const headers = {};
          let n = 0;
          for (const [k, v] of resp.headers.entries()) {
            if (n++ >= FETCH_MAX_HEADERS) break;
            headers[k] = v;
          }
          let body = await resp.text();
          let truncated = false;
          if (body.length > FETCH_MAX_BODY_BYTES) {
            body = body.slice(0, FETCH_MAX_BODY_BYTES);
            truncated = true;
          }
          const out = { status: resp.status, ok: resp.ok, headers, body };
          if (truncated) out.truncated = true;
          // Resolve with a STRING (round-trips cleanly; object handles are fragile).
          const valH = vm.newString(JSON.stringify(out));
          deferred.resolve(valH);
          try { valH.dispose && valH.dispose(); } catch (_) {}
        } catch (e) {
          const errH = vm.newError(e instanceof Error ? e : new Error(String(e)));
          try { errH.setProp("name", vm.newString("FetchError")); } catch (_) {}
          deferred.reject(errH);
          try { errH.dispose && errH.dispose(); } catch (_) {}
        }
      })();
      // Only await `work` (the host fetch + deferred.resolve). Do NOT await
      // deferred.settled here: it resolves only after executePendingJobs runs, which the
      // pump does AFTER awaiting this — awaiting settled here would deadlock.
      ctx.pendingFetches.push(work);
      return deferred.handle;
    },
    // V0.9 RLM sub-LM bridge: POST {prompt,opts} to config.subLMEndpoint, resolve with the
    // completion STRING via the host.fetch pump. Does NOT touch ctx.entropy. See docs/glue-changelog.md.
    __hostSubLM(...args) {
      const vm = this.vm;
      const prompt = args[0] ? args[0].toString() : "";
      const optsJson = args[1] ? args[1].toString() : "null";
      let opts;
      try { opts = JSON.parse(optsJson); } catch (_) { opts = null; }
      const endpoint = ctx.config && ctx.config.subLMEndpoint ? String(ctx.config.subLMEndpoint) : "";
      ctx.subLMCalls = (ctx.subLMCalls | 0) + 1;
      const deferred = vm.newPromise();
      if (!endpoint) {
        const errH = vm.newError(new Error(
          "host.subLM unavailable: config.subLMEndpoint is not set (the SDK client must supply a model backend endpoint)",
        ));
        try { errH.setProp("name", vm.newString("SubLMError")); } catch (_) {}
        deferred.reject(errH);
        try { errH.dispose && errH.dispose(); } catch (_) {}
        ctx.pendingFetches.push(Promise.resolve());
        return deferred.handle;
      }
      const work = (async () => {
        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt, opts: opts || {} }),
          });
          let body = await resp.text();
          if (body.length > FETCH_MAX_BODY_BYTES) body = body.slice(0, FETCH_MAX_BODY_BYTES);
          // The endpoint may return raw text or {completion|text|value}. Normalize to a string.
          let out = body;
          try {
            const j = JSON.parse(body);
            if (j && typeof j === "object") {
              out = j.completion != null ? String(j.completion)
                : j.text != null ? String(j.text)
                : j.value != null ? String(j.value)
                : body;
            }
          } catch (_) {}
          const valH = vm.newString(out);
          deferred.resolve(valH);
          try { valH.dispose && valH.dispose(); } catch (_) {}
        } catch (e) {
          const errH = vm.newError(e instanceof Error ? e : new Error(String(e)));
          try { errH.setProp("name", vm.newString("SubLMError")); } catch (_) {}
          deferred.reject(errH);
          try { errH.dispose && errH.dispose(); } catch (_) {}
        }
      })();
      ctx.pendingFetches.push(work);
      return deferred.handle;
    },
    __hostCall(...args) {
      const name = args[0] ? args[0].toString() : "";
      const argJson = args[1] ? args[1].toString() : "[]";
      // V0.9.3 GAP 1: pre-flight size check on the inbound arg blob. See docs/glue-changelog.md.
      if (argJson.length > HOST_ARG_MAX_BYTES) {
        return this.vm.newError(
          new NativeAllocLimitError(
            `host tool '${name}' arg blob ${argJson.length} bytes > HOST_ARG_MAX_BYTES ${HOST_ARG_MAX_BYTES}; refused`,
          ),
        );
      }
      let parsed;
      try {
        parsed = JSON.parse(argJson);
      } catch (_) {
        parsed = [];
      }
      const tool = ctx.tools[name];
      if (typeof tool !== "function") {
        // surface as a thrown error inside the VM
        return this.vm.newError(new Error(`unknown host tool: ${name}`));
      }
      let result;
      try {
        result = tool(...parsed);
      } catch (e) {
        return this.vm.newError(e instanceof Error ? e : new Error(String(e)));
      }
      if (result === undefined) return this.vm.undefined;
      const resJson = JSON.stringify(result);
      // V0.9.3 GAP 1: pre-flight size check on the tool result. See docs/glue-changelog.md.
      if (resJson != null && resJson.length > HOST_ARG_MAX_BYTES) {
        return this.vm.newError(
          new NativeAllocLimitError(
            `host tool '${name}' result ${resJson.length} bytes > HOST_ARG_MAX_BYTES ${HOST_ARG_MAX_BYTES}; refused`,
          ),
        );
      }
      return this.vm.newString(resJson);
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in / demo host tools (kv/echo/add + V0.9 host.ctx.* + RLM final sentinels). A real
// deployment registers more via config.tools. See docs/glue-changelog.md.
// ---------------------------------------------------------------------------
function buildToolRegistry(ctx, toolNames) {
  // V0.9: resolve the host-side context blob for a (possibly omitted) name.
  const ctxGet = (name) => {
    const n = name == null ? DEFAULT_CTX_NAME : String(name);
    const v = ctx.contextStore.get(n);
    return typeof v === "string" ? v : "";
  };
  const all = {
    "kv.put": (k, v) => {
      ctx.kv.set(String(k), v);
      return true;
    },
    "kv.get": (k) => {
      const v = ctx.kv.get(String(k));
      return v === undefined ? null : v;
    },
    "kv.keys": () => Array.from(ctx.kv.keys()),
    echo: (...args) => ({ echoed: args }),
    add: (a, b) => Number(a) + Number(b),
    now: () => ctx.entropy.nowMs(),

    // ---- V0.9 host-side context handle tools (host.ctx.*) ----
    "ctx.names": () => Array.from(ctx.contextStore.keys()),
    "ctx.len": (name) => ctxGet(name).length,
    "ctx.slice": (a, b, name) => {
      const s = ctxGet(name);
      let start = a == null ? 0 : a | 0;
      let end = b == null ? s.length : b | 0;
      if (start < 0) start = Math.max(0, s.length + start);
      if (end < 0) end = Math.max(0, s.length + end);
      if (end - start > CTX_MAX_SLICE) end = start + CTX_MAX_SLICE;
      return s.slice(start, end);
    },
    "ctx.grep": (re, opts, name) => {
      const s = ctxGet(name);
      opts = opts && typeof opts === "object" ? opts : {};
      const flags = typeof opts.flags === "string" ? opts.flags : "i";
      const max = Number.isFinite(opts.max) ? Math.min(opts.max | 0, 5000) : CTX_GREP_MAX;
      let rx;
      try {
        rx = new RegExp(String(re), flags.includes("g") ? flags : flags + "g");
      } catch (e) {
        return { error: "bad regexp: " + String(e && e.message ? e.message : e) };
      }
      const out = [];
      let m;
      let guard = 0;
      while ((m = rx.exec(s)) !== null) {
        if (++guard > 200000) break;
        // line context around the match index
        const idx = m.index;
        let ls = s.lastIndexOf("\n", idx);
        ls = ls < 0 ? 0 : ls + 1;
        let le = s.indexOf("\n", idx);
        if (le < 0) le = s.length;
        let line = s.slice(ls, le);
        if (line.length > 2048) line = line.slice(0, 2048) + "…";
        out.push({ i: idx, match: m[0].slice(0, 256), line });
        if (out.length >= max) break;
        if (m.index === rx.lastIndex) rx.lastIndex++; // avoid zero-width infinite loop
      }
      return out;
    },
    "ctx.chunk": (size, name) => {
      const s = ctxGet(name);
      const n = Math.max(1, size == null ? 4000 : size | 0);
      const out = [];
      for (let start = 0, i = 0; start < s.length; start += n, i++) {
        const end = Math.min(s.length, start + n);
        out.push({ i, start, end, len: end - start });
        if (out.length > 100000) break;
      }
      // a 0-length context still reports "no chunks"; callers should check ctx.len first.
      return out;
    },
    "ctx.get": (i, size, name) => {
      const s = ctxGet(name);
      const n = Math.max(1, size == null ? 4000 : size | 0);
      const idx = Math.max(0, i | 0);
      let start = idx * n;
      let end = Math.min(s.length, start + Math.min(n, CTX_MAX_SLICE));
      return s.slice(start, end);
    },

    // ---- V0.9 RLM termination sentinels (host.final / host.finalVar) ----
    // See docs/glue-changelog.md.
    final: (value) => {
      ctx.final = { kind: "FINAL", value: value === undefined ? null : value };
      return true;
    },
    finalVar: (name) => {
      ctx.final = { kind: "FINAL_VAR", var: String(name) };
      return true;
    },
  };
  const enabled = {};
  // V0.9: ctx.* / final family is ALWAYS enabled (config.tools gates only echo/add/kv).
  const ALWAYS = new Set([
    "ctx.names", "ctx.len", "ctx.slice", "ctx.grep", "ctx.chunk", "ctx.get", "final", "finalVar",
  ]);
  const names = Array.isArray(toolNames) && toolNames.length
    ? toolNames.concat(Array.from(ALWAYS))
    : Object.keys(all);
  for (const n of names) {
    if (all[n]) enabled[n] = all[n];
  }
  return enabled;
}

// Default config.
function normalizeConfig(cfg) {
  cfg = cfg && typeof cfg === "object" ? cfg : {};
  return {
    clock: cfg.clock === "real" ? "real" : "seeded",
    rngSeed: Number.isFinite(cfg.rngSeed) ? cfg.rngSeed >>> 0 : DEFAULT_RNG_SEED,
    capture: cfg.capture !== false,
    cellBudgetMs: Number.isFinite(cfg.cellBudgetMs) && cfg.cellBudgetMs > 0
      ? Math.min(cfg.cellBudgetMs | 0, 60000)
      : 5000,
    // Fetch policy: denyFetchByDefault flips the default for an UNSET cfg.fetch (single-tenant
    // allow-all vs multi-tenant deny-all). Explicit false/true/array always win. docs/glue-changelog.md.
    denyFetchByDefault: cfg.denyFetchByDefault === true,
    fetch:
      cfg.fetch === true
        ? true
        : cfg.fetch === false
          ? false
          : Array.isArray(cfg.fetch)
            ? cfg.fetch
            : cfg.denyFetchByDefault === true
              ? false
              : true,
    // V0.9: sub-LM bridge endpoint (SDK client stands it up). docs/glue-changelog.md.
    subLMEndpoint: typeof cfg.subLMEndpoint === "string" ? cfg.subLMEndpoint : null,
    tools: Array.isArray(cfg.tools) ? cfg.tools : null,
    // V0.6: in-VM stdlib selection (true=defaults, [names]=subset, else none); record-only,
    // not re-evaluated on restore (libs travel in the heap). docs/glue-changelog.md.
    modules: cfg.modules === true ? true : Array.isArray(cfg.modules) ? cfg.modules.map(String) : null,
    // V0.7: optional inline stdlib blob, fenced at MAX_INLINE_STDLIB_BYTES. docs/glue-changelog.md.
    stdlib: typeof cfg.stdlib === "string" ? cfg.stdlib : null,
    // P1 (BUG-3): execution budget as interrupt ticks (PRIMARY preemption; workerd freezes
    // Date.now() so wall-clock can't trip). BISECTED default 1200 / cap 2000 — safety (every
    // infinite-loop shape trips clean, socket alive) over 10M-loop completion. cellBudgetInstr
    // is an accepted alias. Full bisection story: see docs/glue-changelog.md.
    cellBudgetTicks: (() => {
      const v = Number.isFinite(cfg.cellBudgetTicks)
        ? cfg.cellBudgetTicks
        : Number.isFinite(cfg.cellBudgetInstr)
        ? cfg.cellBudgetInstr
        : NaN;
      return Number.isFinite(v) && v > 0 ? Math.min(v | 0, 2_000) : 1_200;
    })(),
  };
}

// =====================================================================
// GlueKernel — one live QuickJS REPL per instance, configurable.
// =====================================================================
export class GlueKernel {
  constructor() {
    this.kernel = null;
    this.config = normalizeConfig({});
    // mutable ctx holder shared with host callbacks (so re-register rebinds live state)
    this.ctx = {
      entropy: makeEntropy(0, 0, {}),
      logs: [],
      tools: {},
      kv: new Map(),
      // P3: the live config (carries the fetch allowlist) + in-flight fetch settles.
      config: this.config,
      pendingFetches: [],
      // V0.9: host-side context store (Map<name,string>, OUTSIDE wasm linear memory; persisted
      // in the snapshot meta like kv). The RLM context lives here, never in the VM heap.
      contextStore: new Map(),
      // V0.9: the recorded RLM answer ({kind:"FINAL",value} | {kind:"FINAL_VAR",var}) or null.
      final: null,
      // V0.9: count of host.subLM calls this session (telemetry / trajectory).
      subLMCalls: 0,
    };
    this.deadline = Infinity; // wall-clock budget (BUG-3, secondary)
    this.instrLeft = Infinity; // interrupt-tick budget (BUG-3, primary on Workers)
    // V0.8 FEATURE A: mid-cell used-heap tripwire state (armed only during a user eval).
    // _memTripped carries the offending byte count for _formatError. docs/glue-changelog.md.
    this._memWatch = false;
    this._memTripped = 0;
    this._memBufBase = 0; // linear-memory buffer byteLength captured at cell entry (Feature A)
    // V0.6: result of the last stdlib injection at createFresh ({loaded, failed}).
    this.lastStdlib = { loaded: [], failed: {} };
  }

  // V0.6: report what the configurable in-VM stdlib injection did at create time, plus
  // the catalog of modules available in the shipped bundle. Read by lib.rs for the
  // {t:create} reply + {t:stdlib} introspection. JSON string (boundary-safe).
  stdlibInfo() {
    const meta = globalThis.__STDLIB_META || {};
    return JSON.stringify({
      loaded: (this.lastStdlib && this.lastStdlib.loaded) || [],
      failed: (this.lastStdlib && this.lastStdlib.failed) || {},
      available: Object.keys(stdlibBundle()),
      defaults: stdlibDefaultModules(),
      // V0.7 GUARD 2: surface the opt-in set + the source caps so callers can introspect.
      optIn: stdlibOptInModules(),
      sizes: meta.sizes || {},
      versions: meta.versions || {},
      totalBytes: meta.totalBytes || 0,
      sourceBytes: (this.lastStdlib && this.lastStdlib.sourceBytes) || 0,
      maxSourceBytes: MAX_STDLIB_SOURCE_BYTES,
      maxInlineBytes: MAX_INLINE_STDLIB_BYTES,
      maxDumpBufferBytes: MAX_DUMP_BUFFER_BYTES,
      // V0.8: Tier-0 native extensions wired into the VM (crypto/encoding/url/structured-clone/
      // headers), plus the mid-cell used-heap tripwire threshold.
      extensions: buildExtensionDescriptors().map((d) => d.name),
      maxCellUsedBytes: MAX_CELL_USED_BYTES,
      // V0.9.3 GAP 1: the native-C giant-alloc backstop (QuickJS memoryLimit) + host-arg fence.
      nativeMallocLimitBytes: NATIVE_MALLOC_LIMIT_BYTES,
      hostArgMaxBytes: HOST_ARG_MAX_BYTES,
    });
  }

  isPresent() {
    return this.kernel !== null;
  }

  // P2: serialize/hydrate the host-tool kv Map (lives outside wasm memory).
  _serializeKv() {
    try {
      const obj = {};
      for (const [k, v] of this.ctx.kv.entries()) obj[k] = v;
      return JSON.stringify(obj);
    } catch (_) {
      return "{}";
    }
  }
  _hydrateKv(kvJson) {
    this.ctx.kv = this.ctx.kv || new Map();
    if (!kvJson) return;
    try {
      const obj = JSON.parse(kvJson);
      if (obj && typeof obj === "object") {
        for (const k of Object.keys(obj)) this.ctx.kv.set(k, obj[k]);
      }
    } catch (_) {}
  }

  _applyConfig(cfg) {
    this.config = normalizeConfig(cfg);
    this.ctx.kv = this.ctx.kv || new Map();
    this.ctx.contextStore = this.ctx.contextStore || new Map();
    // P3: expose the live config (fetch allowlist + V0.9 subLMEndpoint) to host callbacks.
    this.ctx.config = this.config;
    this.ctx.pendingFetches = this.ctx.pendingFetches || [];
    this.ctx.tools = buildToolRegistry(this.ctx, this.config.tools);
  }

  // V0.9: set a host-side context blob (the RLM context handle). Stored OUTSIDE the VM heap.
  // Returns the stored length. Called by lib.rs on {t:"setContext"}.
  setContext(name, blob) {
    const n = name ? String(name) : DEFAULT_CTX_NAME;
    const s = typeof blob === "string" ? blob : String(blob == null ? "" : blob);
    this.ctx.contextStore = this.ctx.contextStore || new Map();
    this.ctx.contextStore.set(n, s);
    return s.length;
  }

  // V0.9: read back the recorded RLM final answer (resolving FINAL_VAR against the live VM
  // namespace at collection time). Returns a JSON string {kind,value} | {final:null}.
  finalInfo() {
    const f = this.ctx.final;
    if (!f) return JSON.stringify({ final: null, subLMCalls: this.ctx.subLMCalls | 0 });
    if (f.kind === "FINAL_VAR") {
      let value = null;
      try {
        const h = this.kernel.evalCode("globalThis[" + JSON.stringify(f.var) + "]");
        const p = this._preview(h);
        value = p.valueType === "string" || p.valueType === "number" ? p.value : p.valuePreview;
        try { h.dispose?.(); } catch (_) {}
      } catch (_) {}
      return JSON.stringify({ kind: "FINAL_VAR", var: f.var, value, subLMCalls: this.ctx.subLMCalls | 0 });
    }
    return JSON.stringify({ kind: f.kind, value: f.value, subLMCalls: this.ctx.subLMCalls | 0 });
  }

  // V0.9: serialize/hydrate the host-side context store (lives outside wasm; travels in meta).
  _serializeContext() {
    try {
      const obj = {};
      for (const [k, v] of this.ctx.contextStore.entries()) obj[k] = v;
      return JSON.stringify(obj);
    } catch (_) {
      return "{}";
    }
  }
  _hydrateContext(json) {
    this.ctx.contextStore = this.ctx.contextStore || new Map();
    if (!json) return;
    try {
      const obj = JSON.parse(json);
      if (obj && typeof obj === "object") {
        for (const k of Object.keys(obj)) this.ctx.contextStore.set(k, obj[k]);
      }
    } catch (_) {}
  }

  _interruptHandler() {
    // P1 (BUG-3): PRIMARY = hard interrupt-tick budget; wall-clock is SECONDARY (frozen on
    // workerd). docs/glue-changelog.md.
    const self = this;
    return () => {
      // HARD primary: decrement on EVERY invocation (no value/touch gate) so every loop shape
      // trips. Budget MUST stay below the ~1.6k/turn workerd interrupt-throttle floor (see
      // normalizeConfig). Keep this handler maximally cheap. docs/glue-changelog.md.
      if (--self.instrLeft <= 0) return true;
      // V0.8 FEATURE A: mid-cell tripwire, probed on EVERY invocation while a cell is in flight
      // (ungated — a 1MB/iter loop crosses 16MB in ~16 invocations). docs/glue-changelog.md.
      if (self._memWatch) {
        // Read buffer.byteLength (safe re-entrantly), NOT getMemoryUsage() (returns 0 re-entrant).
        let buf = 0;
        try {
          buf = self.kernel._getMemory().buffer.byteLength;
        } catch (_) {
          buf = 0;
        }
        // Trip on per-cell GROWTH past the limit OR the absolute backstop (whichever first).
        const grewTooFast = buf - (self._memBufBase | 0) > CELL_GROWTH_LIMIT_BYTES;
        if (buf > 0 && (grewTooFast || buf > MAX_CELL_USED_BYTES)) {
          self._memTripped = buf;
          return true;
        }
      }
      // SECONDARY (best-effort): wall-clock, checked sparsely (frozen on workerd, never trips).
      if ((self.instrLeft & 0x1ff) === 0 && self.deadline !== Infinity && Date.now() > self.deadline) {
        return true;
      }
      return false;
    };
  }

  // Create a FRESH seeded kernel with the given config. Returns "fresh".
  async createFresh(configJson) {
    const QuickJS = await QJS();
    let cfg = {};
    if (configJson) {
      try {
        cfg = JSON.parse(configJson);
      } catch (_) {}
    }
    this._applyConfig(cfg);
    this.ctx.entropy = makeEntropy(0, 0, {
      seeded: this.config.clock !== "real",
      rngSeed: this.config.rngSeed,
    });
    this.ctx.logs = [];
    // V0.8 FEATURE B: wire the 5 Tier-0 extensions at create. docs/glue-changelog.md.
    this.kernel = await QuickJS.create({
      wasm: quickjsModuleRef(),
      wasi: buildWasiFactory(this.ctx.entropy),
      interruptHandler: this._interruptHandler(),
      extensions: buildExtensionDescriptors(),
      // V0.9.3 GAP 1: hard native dlmalloc malloc-limit. docs/glue-changelog.md.
      memoryLimit: NATIVE_MALLOC_LIMIT_BYTES,
    });
    installHostFns(this.kernel, this.ctx);
    // ORDERING (load-bearing): REBIND_SRC first, THEN stdlib (nanoid/uuid need seeded crypto).
    this.kernel.evalCode(REBIND_SRC).dispose?.();
    // V0.6 + V0.7 GUARDS 1+2: resolve modules (opt-in excluded from `true`), enforce source cap
    // BEFORE any eval-into-heap; injected globals travel in the snapshot. docs/glue-changelog.md.
    const mods = resolveModules(this.config.modules);
    // GUARD 1: bundle-module source cap. mathjs alone (~746 KB) trips this.
    const stdlibSourceBytes = enforceStdlibSourceCap(mods);
    // GUARD 1 (inline blob fence): an inline config.stdlib blob has its own 2 MB cliff.
    const inlineBlob = this.config.stdlib;
    if (typeof inlineBlob === "string" && inlineBlob.length > MAX_INLINE_STDLIB_BYTES) {
      throw new SizeAdmissionError(
        `inline config.stdlib blob ${inlineBlob.length} bytes > MAX_INLINE_STDLIB_BYTES ` +
          `${MAX_INLINE_STDLIB_BYTES}; refusing to compile (one-shot multi-MB compile risks WS 1006). ` +
          `use the per-module config.modules path or split the blob.`,
      );
    }
    this.lastStdlib = mods.length ? injectStdlib(this.kernel, mods) : { loaded: [], failed: {} };
    this.lastStdlib.sourceBytes = stdlibSourceBytes;
    // V0.7: inline stdlib blob injected AFTER bundle modules; per-blob throw captured (non-fatal).
    if (typeof inlineBlob === "string" && inlineBlob.length) {
      try {
        this.kernel.evalCode(inlineBlob, "<stdlib:inline>").dispose?.();
        this.lastStdlib.loaded = this.lastStdlib.loaded.concat(["<inline>"]);
      } catch (e) {
        this.lastStdlib.failed = this.lastStdlib.failed || {};
        this.lastStdlib.failed["<inline>"] = String(e && e.message ? e.message : e);
      }
      this.lastStdlib.inlineBytes = inlineBlob.length;
    }
    return "fresh";
  }

  // V0.4: per-restore phase timings from the LAST restore() (folded into the eval reply by
  // lib.rs). Workerd freezes the clock in-turn, so sub-await phases read 0 (honest). growCount/
  // neededPages are exact counts. docs/glue-changelog.md.
  lastRestoreTimings() {
    const t = this._restoreTimings || {};
    return JSON.stringify(t);
  }

  // V0.9.3 GAP 2 — ENGINE-MIGRATION JOURNAL REPLAY (ADR-0002). Called by lib.rs on engine-hash
  // mismatch: rebuild a FRESH engine and REPLAY each committed cell. Pure cells reproduce exactly;
  // effectful cells are best-effort (the no-replay caveat). docs/glue-changelog.md.
  async replayJournal(journalJson, configJson, kvJson, ctxJson) {
    // Fresh engine under persisted config (re-injects stdlib too); then re-hydrate host-side state.
    await this.createFresh(configJson);
    // Re-hydrate host-side state captured at the last checkpoint.
    this._hydrateKv(kvJson);
    this._hydrateContext(ctxJson);

    let journal = [];
    try {
      journal = JSON.parse(journalJson) || [];
    } catch (_) {
      journal = [];
    }

    let replayed = 0;
    let failed = 0;
    let effectfulCells = 0;
    const errors = [];
    for (const entry of journal) {
      const src = entry && typeof entry.src === "string" ? entry.src : "";
      if (!src) continue;
      if (entry.effectful) effectfulCells++;
      // Replay through the SAME async eval path; a single bad cell is recorded, not fatal.
      try {
        const r = await this.evalCode(src);
        let ok = true;
        try { ok = JSON.parse(r).ok !== false; } catch (_) {}
        if (ok) {
          replayed++;
        } else {
          failed++;
          if (errors.length < 20) errors.push({ cell: entry.cell, effectful: !!entry.effectful });
        }
      } catch (e) {
        failed++;
        if (errors.length < 20) errors.push({ cell: entry.cell, error: String(e && e.message ? e.message : e) });
      }
    }
    return JSON.stringify({
      replayed,
      failed,
      total: journal.length,
      effectfulCells,
      // No-replay caveat: faithful only if no effectful cell and no failure. docs/glue-changelog.md.
      faithful: effectfulCells === 0 && failed === 0,
      errors,
    });
  }

  // Restore from a gzip'd snapshot + persisted entropy counters + persisted config.
  async restore(gzU8, engineHashOfSnap, clockCalls, rngCalls, configJson, label, kvJson, usedHeap, ctxJson) {
    const tEnter = Date.now();
    const CUR = engineHashValue();
    if (engineHashOfSnap && engineHashOfSnap !== CUR) {
      throw new EngineHashMismatchError(engineHashOfSnap, CUR);
    }
    const QuickJS = await QJS();
    const serialized = await gunzip(gzU8);
    // Clock unfreezes across the gunzip await: this delta is meaningful.
    const tAfterGunzip = Date.now();
    // P0 (cold-restore wedge FIX): admit on the RECORDED used heap, NOT raw image bytes.
    // docs/glue-changelog.md.
    const recordedUsed = Number.isFinite(usedHeap) && usedHeap > 0 ? usedHeap | 0 : 0;
    if (recordedUsed > MAX_RESTORE_USED_BYTES) {
      throw new SizeAdmissionError(
        `recorded used heap ${recordedUsed} > MAX_RESTORE_USED_BYTES ${MAX_RESTORE_USED_BYTES}; refusing restore`,
      );
    }
    // SAFE-TO-INSTANTIATE fail-safe only (NOT the live-state gate). docs/glue-changelog.md.
    if (serialized.byteLength > MAX_RESTORE_RAW_BYTES) {
      throw new SizeAdmissionError(
        `raw image ${serialized.byteLength} > MAX_RESTORE_RAW_BYTES ${MAX_RESTORE_RAW_BYTES} ` +
          `(safe-to-instantiate ceiling); refusing restore`,
      );
    }
    let cfg = {};
    if (configJson) {
      try {
        cfg = JSON.parse(configJson);
      } catch (_) {}
    }
    this._applyConfig(cfg);
    // P2: re-hydrate host-tool kv state captured at dump time (kv lives outside wasm).
    this._hydrateKv(kvJson);
    // V0.9: re-hydrate the host-side context store (the RLM context handle survives cold wake).
    this._hydrateContext(ctxJson);
    const snap = QuickJS.deserializeSnapshot(serialized);
    // B1 (pre-size): instrument WebAssembly.Memory.grow() to verify restore grows ONCE up front
    // (no incremental grow churn during the blit). docs/glue-changelog.md.
    const neededPages = Math.ceil(snap.memory.byteLength / 65536);
    let growCount = 0;
    let growDeltaPages = 0;
    const MemProto = WebAssembly.Memory.prototype;
    const origGrow = MemProto.grow;
    MemProto.grow = function (delta) {
      growCount++;
      growDeltaPages += delta | 0;
      return origGrow.call(this, delta);
    };
    this.ctx.entropy = makeEntropy(clockCalls | 0, rngCalls | 0, {
      seeded: this.config.clock !== "real",
      rngSeed: this.config.rngSeed,
    });
    this.ctx.logs = [];
    const tBeforeInstantiate = Date.now();
    let presizedPages = 0;
    try {
      // V0.8 FEATURE B (CRITICAL, load-bearing): restore re-supplies the SAME extension
      // descriptors in the SAME order as create (re-instantiated at fixed bases before the heap
      // blit). Omitting/reordering leaves the heap referencing missing natives. docs/glue-changelog.md.
      this.kernel = await QuickJS.restore(snap, {
        wasm: quickjsModuleRef(),
        wasi: buildWasiFactory(this.ctx.entropy),
        interruptHandler: this._interruptHandler(),
        extensions: buildExtensionDescriptors(),
        // V0.9.3 GAP 1: re-apply the native malloc-limit backstop across cold-wake.
        memoryLimit: NATIVE_MALLOC_LIMIT_BYTES,
      });
    } finally {
      MemProto.grow = origGrow;
    }
    // Clock unfreezes across the QuickJS.restore await: this delta covers
    // instantiate + the single pre-size grow + the byte blit + extension re-init.
    const tAfterInstantiate = Date.now();
    try {
      presizedPages = this.kernel._getMemory().buffer.byteLength / 65536;
    } catch (_) {}
    reRegisterHostFns(this.kernel, this.ctx);
    this.kernel.executePendingJobs();
    this._restoreTimings = {
      gunzipMs: tAfterGunzip - tEnter,
      instantiateMs: tAfterInstantiate - tBeforeInstantiate,
      totalGlueMs: Date.now() - tEnter,
      rawBytes: serialized.byteLength,
      neededPages,
      presizedPages,
      growCount,
      growDeltaPages,
    };
    return label || "sqlite-restore";
  }

  // Eval a cell. ALWAYS resolves to a JSON string (never throws across the boundary; BUG-1:
  // mutex always released). P3: ASYNC eval pumps pending jobs + host-fetch settles. fetch never
  // touches ctx.entropy (determinism safe). docs/glue-changelog.md.
  async evalCode(src) {
    this.ctx.logs = [];
    this.ctx.pendingFetches = [];
    const budget = this.config.cellBudgetMs;
    this.deadline = budget > 0 ? Date.now() + budget : Infinity;
    this.instrLeft = this.config.cellBudgetTicks > 0 ? this.config.cellBudgetTicks : Infinity;
    // V0.8 FEATURE A: arm the mid-cell tripwire; capture buffer base for per-cell GROWTH check.
    this._memWatch = true;
    this._memTripped = 0;
    this._memBufBase = this._bufferBytes();
    try {
      // ASYNC eval: store the top-level promise to a global (__cellP) so a fresh read after the
      // drain yields the SETTLED value cleanly (reading the pre-drain handle races). docs/glue-changelog.md.
      const h0 = this.kernel.evalCode(String(src), "<cell>", EvalFlags.ASYNC);
      try {
        this.kernel.setProp(this.kernel.global, "__cellP", h0);
      } finally {
        try { h0.dispose?.(); } catch (_) {}
      }
    } catch (e) {
      this.deadline = Infinity;
      this.instrLeft = Infinity;
      this._memWatch = false;
      return JSON.stringify(this._formatError(e, budget));
    }
    // Sync portion done — drop the tick budget so awaited host fetches aren't preempted; the
    // mid-cell tripwire stays armed through _drivePromise (re-arms per round). docs/glue-changelog.md.
    this.deadline = Infinity;
    this.instrLeft = Infinity;

    let settledHandle;
    try {
      settledHandle = await this._drivePromise(budget);
    } catch (e) {
      this._memWatch = false;
      return JSON.stringify(this._formatError(e, budget));
    }

    // Cell fully settled — disarm the mid-cell tripwire (preview/dump have their own guards).
    this._memWatch = false;

    if (settledHandle && settledHandle.error) {
      // The cell's promise REJECTED — surface as an error value; kernel stays usable.
      const errObj = this._formatError(this._handleToError(settledHandle.error), budget);
      try { settledHandle.error.dispose?.(); } catch (_) {}
      return JSON.stringify(errObj);
    }

    // ASYNC-eval convention (quickjs-wasi): a FULFILLED top-level promise resolves to a wrapper
    // {value: <completion>}. Unwrap one level. docs/glue-changelog.md.
    const wrapH = settledHandle.value;
    let valueH = wrapH;
    let unwrapped = false;
    try {
      const inner = wrapH.getProp("value");
      if (inner) { valueH = inner; unwrapped = true; }
    } catch (_) {}
    try {
      const preview = this._preview(valueH);
      const value = preview.value;
      const out = {
        ok: true,
        // P3: a RETURNED Error carries structured {name,message,stack} in `value`. docs/glue-changelog.md.
        value:
          preview.valueType === "error"
            ? value
            : typeof value === "string" || typeof value === "number"
            ? value
            : preview.valuePreview,
        valuePreview: preview.valuePreview,
        valueType: preview.valueType,
        logs: this.ctx.logs.slice(),
      };
      if (unwrapped) { try { valueH.dispose?.(); } catch (_) {} }
      try { wrapH.dispose?.(); } catch (_) {}
      return JSON.stringify(out);
    } catch (e) {
      if (unwrapped) { try { valueH.dispose?.(); } catch (_) {} }
      try { wrapH.dispose?.(); } catch (_) {}
      return JSON.stringify({
        ok: true,
        value: null,
        valuePreview: `<unconvertible: ${String(e)}>`,
        logs: this.ctx.logs.slice(),
      });
    }
  }

  // P3: drive __cellP (ASYNC-eval top-level Promise) to settlement, interleaving microtask
  // drains with in-flight host.fetch settles. docs/glue-changelog.md.
  async _drivePromise(budget) {
    const MAX_ROUNDS = 20000;
    // Re-arm the tick budget per drain so a runaway post-await continuation is still preempted.
    const reArm = () => {
      this.instrLeft = this.config.cellBudgetTicks > 0 ? this.config.cellBudgetTicks : Infinity;
    };
    const pstate = () => {
      const cp = this.kernel.evalCode("__cellP");
      let ps = 0;
      try { ps = cp.promiseState; } catch (_) { ps = 1; }
      try { cp.dispose?.(); } catch (_) {}
      return ps;
    };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      reArm();
      try { this.kernel.executePendingJobs(); } catch (_) {}
      this.instrLeft = Infinity;
      const inflight = this.ctx.pendingFetches;
      if (inflight.length) {
        this.ctx.pendingFetches = [];
        await Promise.all(inflight);
        reArm();
        try { this.kernel.executePendingJobs(); } catch (_) {}
        this.instrLeft = Infinity;
        continue;
      }
      if (pstate() !== 0) break;
      // No fetches in flight, still pending: yield once, then re-check.
      await Promise.resolve();
      if (!this.ctx.pendingFetches.length && pstate() !== 0) break;
    }
    try { this.kernel.executePendingJobs(); } catch (_) {}
    const cp = this.kernel.evalCode("__cellP");
    return await this.kernel.resolvePromise(cp);
  }

  // Turn a JSValueHandle holding an Error (a rejected promise reason) into a JS-side
  // error-like object for _formatError.
  _handleToError(handle) {
    const e = { name: "Error", message: "", stack: undefined };
    try {
      if (handle.isError || (handle.typeof === "object")) {
        try { e.name = handle.getProp("name").consume((x) => x.toString()) || "Error"; } catch (_) {}
        try { e.message = handle.getProp("message").consume((x) => x.toString()); } catch (_) {}
        try { e.stack = handle.getProp("stack").consume((x) => x.toString()); } catch (_) {}
      } else {
        e.message = handle.toString();
      }
    } catch (_) {
      try { e.message = handle.toString(); } catch (_) {}
    }
    return e;
  }

  _formatError(e, budget) {
    // JSException carries name/message/stack. An interrupt -> InternalError.
    let name = e && e.name ? String(e.name) : "Error";
    let message = e && e.message != null ? String(e.message) : String(e);
    let stack = e && e.stack ? String(e.stack) : undefined;
    // V0.8 FEATURE A: a mid-cell tripwire interrupt is a MemoryLimitError, not a TimeoutError;
    // _memTripped (set in the interrupt handler) distinguishes it. Check FIRST. docs/glue-changelog.md.
    const memTripped = this._memTripped | 0;
    this._memWatch = false;
    this._memTripped = 0;
    if (memTripped > 0 && (/interrupt/i.test(message) || /interrupt/i.test(name))) {
      name = "MemoryLimitError";
      message =
        `cell aborted mid-execution: WASM linear-memory buffer ${memTripped} bytes crossed ` +
        `MAX_CELL_USED_BYTES ${MAX_CELL_USED_BYTES} (in-cell allocation tripwire, below the ` +
        `18MB undumpable dump ceiling). the namespace is intact and usable; allocate less or ` +
        `chunk the work across cells.`;
    } else if (/interrupt/i.test(message) || /interrupt/i.test(name)) {
      name = "TimeoutError";
      message = `cell exceeded execution budget (${this.config.cellBudgetTicks} ticks / ${budget}ms wall)`;
    } else if (/out of memory/i.test(message) || /out of memory/i.test(name)) {
      // V0.9.3 GAP 1: native dlmalloc malloc-limit tripped — re-label NativeAllocLimitError.
      // docs/glue-changelog.md.
      name = "NativeAllocLimitError";
      message =
        `native allocation refused: a single allocation crossed the QuickJS memory limit ` +
        `(${NATIVE_MALLOC_LIMIT_BYTES} bytes). a giant typed-array / structuredClone / oversized ` +
        `host arg cannot grow the WASM heap toward an uncatchable OOM. the namespace is intact and ` +
        `usable; allocate less or chunk the work.`;
    }
    try {
      e && e.dispose && e.dispose();
    } catch (_) {}
    return {
      ok: false,
      error: { name, message, stack },
      logs: this.ctx.logs.slice(),
    };
  }

  // Structured-ish value preview (not bare stringify).
  _preview(h) {
    if (h == null) return { value: null, valuePreview: "undefined", valueType: "undefined" };
    let t;
    try {
      t = h.typeof;
    } catch (_) {
      t = "unknown";
    }
    if (h.isUndefined) return { value: null, valuePreview: "undefined", valueType: "undefined" };
    if (h.isNull) return { value: null, valuePreview: "null", valueType: "null" };
    if (t === "number") {
      const n = h.toNumber();
      return { value: n, valuePreview: String(n), valueType: "number" };
    }
    if (t === "boolean") {
      const s = h.toString();
      return { value: s === "true", valuePreview: s, valueType: "boolean" };
    }
    if (t === "string") {
      const s = h.toString();
      return { value: s, valuePreview: JSON.stringify(s), valueType: "string" };
    }
    if (t === "bigint") {
      const s = h.toString();
      return { value: s, valuePreview: s + "n", valueType: "bigint" };
    }
    if (t === "function") {
      let nm = "";
      try {
        nm = h.getProp("name").consume
          ? h.getProp("name").consume((x) => x.toString())
          : "";
      } catch (_) {}
      return { value: null, valuePreview: `[Function${nm ? ": " + nm : " (anonymous)"}]`, valueType: "function" };
    }
    // P3 (error-as-VALUE): a RETURNED Error previews as "{}" (non-enumerable fields); detect it
    // and surface name+message(+short stack). docs/glue-changelog.md.
    try {
      if (h.isError || (t === "object" && /Error$/.test(h.constructorName || ""))) {
        let name = "";
        let message = "";
        let stack = "";
        try { name = h.getProp("name").consume((x) => x.toString()); } catch (_) {}
        try { message = h.getProp("message").consume((x) => x.toString()); } catch (_) {}
        try { stack = h.getProp("stack").consume((x) => x.toString()); } catch (_) {}
        if (!name) name = h.constructorName || "Error";
        const shortStack = stack ? String(stack).split("\n").slice(0, 4).join("\n") : "";
        const value = { name, message };
        if (shortStack) value.stack = shortStack;
        const head = message ? `${name}: ${message}` : name;
        let preview = shortStack ? `${head}\n${shortStack}` : head;
        if (preview.length > 4096) preview = preview.slice(0, 4096) + "…";
        return { value, valuePreview: preview, valueType: "error" };
      }
    } catch (_) {}
    // object / array: structured dump
    try {
      const dumped = this.kernel.dump(h);
      let preview = JSON.stringify(dumped);
      if (preview && preview.length > 4096) preview = preview.slice(0, 4096) + "…";
      return { value: dumped, valuePreview: preview, valueType: Array.isArray(dumped) ? "array" : "object" };
    } catch (_) {
      try {
        return { value: null, valuePreview: h.toString(), valueType: t };
      } catch (e2) {
        return { value: null, valuePreview: `<unconvertible: ${String(e2)}>`, valueType: t };
      }
    }
  }

  // W5 TEST HOOK: report the monotonic linear-buffer byteLength + the live used heap (after a GC)
  // as a JSON string, so the wedge test can observe that the buffer stays bloated while used drops.
  memInfo() {
    try {
      this.kernel.runGC();
    } catch (_) {}
    return JSON.stringify({
      bufferBytes: this._bufferBytes(),
      usedHeap: this._usedHeapBytes(),
    });
  }

  // P0: used-heap measurement (shrinks after free+GC unlike the monotonic buffer). docs/glue-changelog.md.
  _usedHeapBytes() {
    try {
      const m = this.kernel.getMemoryUsage();
      // Use the larger of memoryUsedSize / mallocSize as the admission figure (defensive).
      return Math.max(m.memoryUsedSize | 0, m.mallocSize | 0);
    } catch (_) {
      // Fallback to the (monotonic) buffer length if the API is unavailable.
      try {
        return this.kernel._getMemory().buffer.byteLength;
      } catch (_) {
        return 0;
      }
    }
  }

  _bufferBytes() {
    try {
      return this.kernel._getMemory().buffer.byteLength;
    } catch (_) {
      return 0;
    }
  }

  // P0 (BUG-2/4) snapshot shrink: re-serve freed dlmalloc slack with zero-init ArrayBuffers so
  // gzip collapses it (buffer can't shrink in place). MUST NOT grow linear memory: allocate
  // strictly less than the slack, only below a safe ceiling. docs/glue-changelog.md.
  _scrubArena(slackBytes) {
    const MB = 1024 * 1024;
    // Stay well under the freed slack (no memory.grow); cap the absolute scrub.
    const budgetMB = Math.max(0, Math.min(Math.floor((slackBytes / MB) * 0.6), 24));
    if (budgetMB < 1) return;
    // 1MB chunks, fresh (zero) ArrayBuffers, drop refs, GC; single eval for low boundary cost.
    const src =
      "{let __s=[];try{for(let __i=0;__i<" +
      budgetMB +
      ";__i++){__s.push(new Uint8Array(1048576));}}catch(__e){}__s.length=0;}0";
    try {
      const savedLeft = this.instrLeft;
      const savedDeadline = this.deadline;
      this.instrLeft = Infinity;
      this.deadline = Infinity;
      try {
        this.kernel.evalCode(src).dispose?.();
      } finally {
        this.instrLeft = savedLeft;
        this.deadline = savedDeadline;
      }
      this.kernel.runGC();
    } catch (_) {}
  }

  // Dump memory+globals -> serialize -> STREAM gzip. P0 (BUG-2/4): GC, guard on USED heap (not
  // the monotonic buffer), then SCRUB the freed arena to shrink the gz image. docs/glue-changelog.md.
  async dump() {
    const QuickJS = await QJS();

    // W5 UN-WEDGE: HARD safe-to-serialize ceiling FIRST — before runGC/any full-buffer touch
    // (snapshot+serialize is ~2-3x; uncatchable OOM near the real ~48MB cliff). Only a buffer
    // genuinely above the safe-serialize ceiling fails here. A spiked-then-freed buffer (18..45MB,
    // tiny used heap) is NO LONGER hard-rejected here — it falls through to the used-heap fence +
    // scrub below, so the session can checkpoint again. docs/W5-COMPACTION-PLAN.md.
    const bufBytes = this._bufferBytes();
    if (bufBytes > SAFE_SERIALIZE_BUFFER_BYTES) {
      throw new SizeAdmissionError(
        `linear-memory buffer ${bufBytes} > SAFE_SERIALIZE_BUFFER_BYTES ${SAFE_SERIALIZE_BUFFER_BYTES}; ` +
          `refusing snapshot (WASM memory cannot shrink in place and serializing a buffer this ` +
          `large risks an uncatchable OOM). reset to recover.`,
      );
    }

    try {
      this.kernel.runGC();
    } catch (_) {}

    // W5 (a): admission on the ACTUAL used heap, NOT the monotonic buffer. This is the genuine OOM
    // fence: serialize/gz cost scales with LIVE data, and freed slack is about to be zero-scrubbed
    // (so it gzips to ~nothing). A spiked-then-freed session whose used heap is in-envelope is
    // ADMITTED even when its raw buffer is well above the 18MB soft ceiling. docs/W5-COMPACTION-PLAN.md.
    const usedAfterGc = this._usedHeapBytes();
    if (usedAfterGc > MAX_USED_BYTES) {
      throw new SizeAdmissionError(
        `live used heap ${usedAfterGc} > MAX_USED_BYTES ${MAX_USED_BYTES}; refusing snapshot`,
      );
    }

    // W5 (b)+(c): shrink the STORED gz image after a free — scrub freed pages to zero so the
    // monotonic buffer (which cannot shrink in place) gzips down below the dump ceiling. Trigger on
    // EITHER the absolute slack (legacy) OR the cell-boundary bloat ratio (plan §3: buffer bloated
    // AND used/buffer < 0.4 = a freed spike). Scrub stays below the safe-serialize ceiling so the
    // bounded, non-growing scrub itself can't OOM. docs/W5-COMPACTION-PLAN.md.
    let scrubbed = false;
    const slack = bufBytes - usedAfterGc;
    const wedgedRatio =
      bufBytes > COMPACT_TRIGGER_BYTES &&
      usedAfterGc / bufBytes < COMPACT_USED_RATIO;
    if (
      (slack > SCRUB_SLACK_BYTES || wedgedRatio) &&
      bufBytes <= SCRUB_MAX_BUFFER_BYTES
    ) {
      this._scrubArena(slack);
      scrubbed = true;
    }

    const snap = this.kernel.snapshot();
    const serialized = QuickJS.serializeSnapshot(snap);
    const gz = await gzip(serialized);
    return {
      gz,
      sizeRaw: serialized.byteLength,
      sizeGz: gz.byteLength,
      usedHeap: usedAfterGc,
      bufferBytes: bufBytes,
      scrubbed,
      // P2: kv state (outside wasm) travels with the snapshot meta + re-hydrated on restore.
      kvJson: this._serializeKv(),
      // V0.9: host-side context store likewise travels in the meta (survives cold-restore).
      ctxJson: this._serializeContext(),
      stackPointer: snap.stackPointer ?? null,
      clockCalls: this.ctx.entropy.clockCalls,
      rngCalls: this.ctx.entropy.rngCalls,
    };
  }

  drop() {
    if (this.kernel) {
      try {
        this.kernel.dispose();
      } catch (_) {}
    }
    this.kernel = null;
  }
}

export function newGlueKernel() {
  return new GlueKernel();
}

// ---------------------------------------------------------------------------
// In-DO async mutex (promise-chain).
// ---------------------------------------------------------------------------
export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }
  acquire() {
    let release;
    const next = new Promise((res) => {
      release = res;
    });
    const prev = this.tail;
    this.tail = this.tail.then(() => next);
    return prev.then(() => release);
  }
}
export function newMutex() {
  return new Mutex();
}
