// montydyn v0.6 — JS glue boundary. Driven by the Rust Durable Object shell (lib.rs).
//
// V0.6 — CONFIGURABLE IN-VM STDLIB:
//   A curated set of pure-JS, QuickJS-safe libraries (lodash-es, dayjs, nanoid, uuid,
//   zod) is esbuilt at BUILD TIME into ONE bundled JSON string {moduleName: iifeString}
//   and shipped as a wrangler Text module (entry.mjs sets globalThis.__STDLIB_BUNDLE).
//   At {t:create}, config.modules selects a subset; createFresh() evals ONLY those IIFEs
//   into the live QuickJS global namespace (globalThis._, globalThis.dayjs, ...). Because
//   the libs are evaluated INTO the live VM, they live in the WASM linear-memory heap and
//   are captured by the heap snapshot — so they PERSIST ACROSS HIBERNATION FOR FREE and
//   are NEVER re-injected on cold restore (restore() blits the heap that already contains
//   them). config.modules is persisted with the session config purely as a record of what
//   was loaded (and to power introspection); restore does not re-eval the bundle.
//
//   ORDERING (critical): stdlib injection runs AFTER REBIND_SRC, because nanoid/uuid call
//   crypto.getRandomValues — which REBIND_SRC installs (seeded). lodash/dayjs/zod need no
//   host. QuickJS has NO Node builtins (no require/fs/Buffer/process), so the bundle is
//   esbuilt platform=browser; a Node-builtin dependence FAILS THE BUILD, never ships.
//
// V0.2 HARDENING (on top of v0.1):
//   * P0 (BUG-2/4 — memory reclaim): the size-admission guard now measures QuickJS's
//     ACTUAL USED heap via getMemoryUsage().memoryUsedSize (NOT the monotonic
//     memory.buffer.byteLength). A session that allocates ~60MB then frees it now reports
//     a small used-heap and can checkpoint again — no permanent SizeAdmissionError.
//     To also SHRINK the snapshot/store after a free, dump() runs an arena SCRUB: the
//     freed dlmalloc region still holds stale (incompressible) bytes that bloat gzip; the
//     scrub allocates zero-initialized ArrayBuffers across the freed slack inside the VM
//     (forcing dlmalloc to re-serve those chunks, which we zero) then frees them + GC, so
//     gzip collapses the freed pages. WASM linear memory never shrinks IN PLACE
//     (memory.grow is monotonic; restore-into-fresh re-grows to the old size — proven),
//     so the raw image stays at the high-water mark, but the gz image + the stored bytes
//     shrink back toward baseline and the store returns from r2 to sqlite.
//   * P1 (BUG-3 — reliable preemption): on workerd Date.now() is FROZEN during sync
//     execution, so the wall-clock deadline can never trip. The interrupt-tick budget is
//     now the PRIMARY, hard preemption: ANY loop (empty while(true){} included) decrements
//     a hard tick budget and trips a typed TimeoutError. Default budget lowered + a hard
//     ceiling so an empty loop trips in a few seconds while a 10M-iteration legit loop
//     (~2000 ticks) still completes.
//
// V0.1 evolves the V0 kernel into a *dynamically-configured stateful JS env*:
//   * BUG-1 fix: uncaught JS errors (throw / syntax / Reference / Type) are caught,
//     formatted (name/message/stack) and returned as {ok:false,error} so the eval
//     mutex is ALWAYS released. The VM stays usable after any throw.
//   * BUG-2 + BUG-4 fix: runGC() before dump so freed memory shrinks the live image
//     (size-guard trip recoverable; R2 overflow drops back to SQLite after free).
//   * BUG-3 fix: per-cell wall-clock budget via interruptHandler -> typed TimeoutError
//     instead of riding to the DO wall-limit (WS 1006).
//   * BUG-5 fix: performance.now() seeded off the same clock counter as Date.now().
//   * BUG-6 fix: restore label emitted by lib.rs from the branch that fetched bytes.
//   * Dynamic config: a per-session config shapes the env (clock mode, rngSeed,
//     capture, cellBudgetMs, fetch allow-list, host tool names). Persisted with the
//     snapshot (lib.rs meta) and re-applied on cold restore so the env is identical.
//   * Host tools: host.<name>(args) -> host_call boundary; re-registered after restore.
//   * Output capture: console.log/warn/error buffered per cell, returned as logs[].
//   * Result quality: structured value preview (not bare stringify).
//
// State that must NOT perturb the snapshot lives OUTSIDE wasm linear memory (entropy
// counters, config, console buffer, deadline) and is reconstructed on restore.

import { QuickJS, EvalFlags } from "quickjs-wasi";

function engineHashValue() {
  return globalThis.__ENGINE_HASH || "unset-engine-hash";
}

// ---- size-admission guard (bytes). OOM is uncatchable => guard by size. ----
// P0: the guard is on QuickJS's ACTUAL USED heap (getMemoryUsage().memoryUsedSize),
// not the monotonic WASM linear-memory buffer. This is what un-wedges checkpointing
// after a free: a session that spikes to 60MB then frees it reports a tiny used heap
// and admits again.
const MAX_USED_BYTES = 50 * 1024 * 1024; // refuse snapshot above ~50MB *live used* heap
// P0 (cold-restore wedge FIX): admit RESTORE on the snapshot's RECORDED used heap, NOT on
// the raw image byte length. WASM linear memory is monotonic, so a session that ever spiked
// its buffer past ~18MB raw then freed + checkpointed (fine warm, small used heap) used to be
// PERMANENTLY un-restorable: the old guard threw SizeAdmissionError whenever the gunzip'd raw
// image exceeded MAX_RAW_BYTES (20MB), even though the live state was tiny. Now the admission
// figure is the recorded usedHeap; the raw image only has to be SAFE TO INSTANTIATE.
const MAX_RESTORE_USED_BYTES = 50 * 1024 * 1024; // refuse restore above ~50MB *recorded used* heap
// SAFE-TO-INSTANTIATE raw ceiling: this is NOT an admission gate on live state, only a
// fail-safe so a genuinely-too-big image (one the isolate cannot blit back without an
// uncatchable OOM) still fails safe. It is pinned to the same conservative ceiling the dump
// side enforces (MAX_DUMP_BUFFER_BYTES): if the image could be dumped, it can be restored.
// A freed-then-small session whose raw high-water is below this MUST restore.
// V0.7 GUARD 3: lowered 45 -> 18 MB in lockstep with MAX_DUMP_BUFFER_BYTES. The dump side
// now refuses any buffer >18 MB, so no snapshot bigger than that can ever be WRITTEN; pinning
// the restore raw ceiling to the same figure keeps the invariant "if it could be dumped, it
// can be restored" and never strands a legitimately-written snapshot.
const MAX_RESTORE_RAW_BYTES = 18 * 1024 * 1024;
// P0: if the linear-memory buffer exceeds the used heap by more than this slack, run the
// arena scrub before serializing so freed (incompressible) pages collapse under gzip.
const SCRUB_SLACK_BYTES = 4 * 1024 * 1024;
// Only scrub when the buffer is below this ceiling. Above it, the snapshot/serialize
// transient is already near the OOM edge; the (non-growing) scrub is skipped to avoid an
// uncatchable Error 1102 / WS 1006. The used-heap guard still un-wedges checkpointing.
// V0.7 GUARD 3: lowered 32 -> 16 MB so it stays BELOW the new 18 MB dump ceiling (a scrub
// must never run on a buffer the dump side would refuse).
const SCRUB_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
// HARD dump ceiling on the WASM linear-memory BUFFER (not the used heap). snapshot() +
// serialize incur a ~2-3x transient copy of the FULL buffer, and OOM (Error 1102 / WS
// 1006) is UNCATCHABLE — so we must refuse to even attempt a dump once the monotonic
// buffer has grown past a safe ceiling, returning a typed SizeAdmissionError with the
// socket alive and the prior committed snapshot intact. Because WASM memory never shrinks
// in place, a session whose buffer grew this large can no longer be durably checkpointed
// until it is reset; it keeps working in-memory. (EXP-6/7: dump caps ~57MB live, crash
// ~27-32MB raw; we keep the buffer ceiling conservative.)
//
// V0.7 GUARD 3 (THE KEY FIX): lowered 45 -> 18 MB. v0.6 found the REAL uncatchable OOM cliff
// at ~24-30 MB RAW incompressible heap — BELOW the old 45 MB ceiling — so a heavy injected
// stdlib (mathjs, big synthetic bundle, or a large in-VM allocation) was ADMITTED to dump and
// then OOMed the isolate during the ~2-3x snapshot+serialize transient (silent WS 1006 / DO
// kill). 18 MB sits comfortably BELOW the ~24-30 MB cliff, so any buffer approaching it is now
// CLEAN-REJECTED with a typed SizeAdmissionError (socket alive, prior snapshot intact) BEFORE
// the dump transient can run. This converts the dangerous uncatchable death into a safe typed
// rejection. The session keeps working in-memory; reset recovers durable checkpointing.
const MAX_DUMP_BUFFER_BYTES = 18 * 1024 * 1024;

// V0.8 FEATURE A: MID-CELL USED-HEAP TRIPWIRE. Closes the v0.7 Medium gap where an in-cell
// raw-allocation bomb (unbounded array push, a 258MB zod tree, a string-doubling bomb) grows
// the WASM linear buffer DURING a single synchronous eval and can lose the in-flight reply /
// hang BEFORE the post-cell dump guard ever runs. The interrupt handler already fires ~per 20k
// bytecode ops (alongside the 1200-tick budget); we now ALSO probe getMemoryUsage() there and
// throw a typed MemoryLimitError that unwinds the cell -> {ok:false,error} with the socket
// ALIVE and the namespace still usable.
//
// Threshold 16MB sits BELOW MAX_DUMP_BUFFER_BYTES (18MB) so the cell ABORTS before the buffer
// crosses the undumpable ceiling — the post-abort checkpoint can still dump the (pre-bomb)
// committed state. The probe is GATED behind a cheap bytecode-tick mask (every ~64th interrupt
// invocation) so the hot path stays a single decrement + mask test; getMemoryUsage() is a
// host-boundary crossing and must NOT run on every invocation (workerd throttles the callback
// after ~1.6k/turn — see the tick-budget note). It measures memoryUsedSize (QuickJS live
// malloc'd bytes) which a runaway allocation grows in lockstep with the linear buffer.
const MAX_CELL_USED_BYTES = 16 * 1024 * 1024;
// V0.8 FEATURE A: per-cell linear-memory GROWTH limit. The buffer is monotonic and does NOT
// shrink between cells, so an ABSOLUTE buffer threshold would wedge every cell after the first
// trip (and would false-trip a legitimately-large namespace built across cells). Instead the
// tripwire fires when THIS cell has grown the buffer by more than CELL_GROWTH_LIMIT_BYTES beyond
// its size at cell entry (captured in _memBufBase). A single eval that balloons the heap >12MB
// is the alloc-bomb signature; a benign cell on an already-large heap grows little and runs. A
// hard absolute backstop (MAX_CELL_USED_BYTES, ~16MB) still fires below the 18MB dump ceiling so
// the buffer can never cross the undumpable line mid-cell regardless of where the cell started.
const CELL_GROWTH_LIMIT_BYTES = 8 * 1024 * 1024;

// V0.9.3 GAP 1 — NATIVE-C GIANT-ALLOC BACKSTOP. The v0.8 mid-cell tripwire is
// bytecode-interrupt-bound: it only fires from the interrupt handler, which QuickJS invokes
// between bytecode ops. A SINGLE huge NATIVE-C allocation — a giant typed-array `.fill`, a
// 258MB `structuredClone`, an oversized host-bridged arg — completes entirely inside one C
// call with NO intervening bytecode interrupt, so the tripwire never runs and the dlmalloc
// `sbrk`/`memory.grow` can drive the WASM linear buffer straight into an UNCATCHABLE OOM
// (Error 1102 / WS 1006) that kills the whole DO.
//
// THE FIX: hand QuickJS a hard `memoryLimit` (its native dlmalloc malloc-limit). Once the
// runtime's tracked allocation would exceed it, EVERY allocation — bytecode-driven OR native-C
// (typed arrays, structuredClone, JSON, regexp) — FAILS as a catchable JS `InternalError: out
// of memory` BEFORE dlmalloc calls `memory.grow`. Proven locally: a 258MB typed-array fill / a
// 258MB structuredClone throw cleanly, the WASM buffer NEVER grows past its ~1.2MB baseline, the
// VM stays alive, and the next eval works. We re-label that OOM as a typed NativeAllocLimitError.
//
// SIZING: the limit MUST sit BELOW the 18MB undumpable dump ceiling so a session whose live heap
// approaches the limit is still dumpable, AND comfortably above the ~7MB safe stdlib envelope so
// legitimate sessions never false-trip. 16MB matches MAX_CELL_USED_BYTES (the bytecode tripwire
// backstop), so the two guards share one ceiling: whichever fires first, the cell aborts below
// the dump ceiling. quickjs-wasi re-applies the limit after QuickJS.restore(), so restored VMs
// get the identical backstop.
const NATIVE_MALLOC_LIMIT_BYTES = 16 * 1024 * 1024;
// V0.9.3 GAP 1: cap on a single host-bridged arg/result string crossing the __hostCall /
// host.ctx boundary. host.ctx.slice/get are already CTX_MAX_SLICE-capped (1MB); this is the
// general fence so an oversized boundary copy (a multi-hundred-MB tool result / set blob) is
// rejected with a typed NativeAllocLimitError before it is materialized in the VM heap.
const HOST_ARG_MAX_BYTES = 8 * 1024 * 1024;

// V0.7 GUARD 1: CONFIG CAP on total injected stdlib SOURCE bytes. The verified safe envelope
// is <=~500 KB combined module source (proxy for <=7 MB raw / <=5-7 MB used heap, all-SQLite).
// Selecting modules whose combined iife source exceeds this is rejected at create with a typed
// SizeAdmissionError (socket alive) BEFORE any eval-into-heap, so a heavy bundle can never grow
// the buffer toward the OOM cliff. mathjs (~746 KB src alone) trips this on its own.
const MAX_STDLIB_SOURCE_BYTES = 500 * 1024;
// V0.7 GUARD 1 (inline blob fence): an inline config.stdlib source blob has a SEPARATE, lower
// cliff — a one-shot compile transient of a multi-MB string WS-1006s at create around ~2.1 MB.
// Fence it at 2 MB with a typed SizeAdmissionError (socket alive) so the inline path can never
// cross that cliff. The production per-module path (config.modules) avoids it entirely.
const MAX_INLINE_STDLIB_BYTES = 2 * 1024 * 1024;

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
// Canonical load order. The snapshot records loaded extensions in THIS order, and restore MUST
// supply the SAME descriptors in the SAME order (quickjs-wasi re-instantiates them at fixed
// memory/table bases before blitting the heap back). Single source of truth on both paths.
const EXTENSION_ORDER = ["crypto", "encoding", "url", "structured-clone", "headers"];

// Build the ExtensionDescriptor[] for QuickJS.create/restore from the precompiled
// WebAssembly.Module registry entry.mjs put on globalThis.__QJS_EXT_MODULES. Each descriptor's
// `wasm` is a precompiled Module (loadExtension takes it directly — no WebAssembly.compile,
// which workerd forbids for arbitrary bytes). If the registry is absent (older entry, tests
// without the .so) we return [] so the kernel still creates — just without the new globals.
//
// initFn defaults to qjs_ext_<name with - -> _>_init inside loadExtension, which matches the
// exported init symbol for all 5 (.so verified: qjs_ext_crypto_init, qjs_ext_encoding_init,
// qjs_ext_url_init, qjs_ext_structured_clone_init, qjs_ext_headers_init).
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

// Normalize config.modules into the concrete list of module names to inject.
//   undefined / null / false / []   -> [] (no stdlib; v0.5-compatible default)
//   true                            -> all DEFAULT modules (V0.7 GUARD 2: opt-in libs EXCLUDED)
//   ["lodash","dayjs"]              -> that subset (unknown names dropped; opt-in libs allowed
//                                      ONLY because they are explicitly named here)
function resolveModules(modulesCfg) {
  const bundle = stdlibBundle();
  const available = new Set(Object.keys(bundle));
  if (modulesCfg === true) {
    // V0.7 GUARD 2: the default set is `meta.modules`, which already excludes opt-in libs.
    // Defensive: also subtract optIn in case a stale meta lists one.
    const optIn = new Set(stdlibOptInModules());
    return stdlibDefaultModules().filter((n) => available.has(n) && !optIn.has(n));
  }
  if (Array.isArray(modulesCfg)) {
    // Explicit selection: any bundled module (including opt-in mathjs) is permitted here,
    // because the caller named it on purpose. It still counts against the source cap.
    return modulesCfg.map(String).filter((n) => available.has(n));
  }
  return [];
}

// V0.7 GUARD 1: sum the iife source bytes of the resolved module list and reject (typed
// SizeAdmissionError, socket alive) if it exceeds the safe envelope. Run BEFORE any eval so a
// heavy bundle never grows the heap toward the OOM cliff. Returns the total bytes on success.
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

// Eval the selected stdlib IIFEs into the live VM AFTER REBIND_SRC (so crypto exists
// for nanoid/uuid). Returns {loaded:[...], failed:{name:err}}. A failed module never
// kills the kernel; it is reported and skipped. The injected globals live in the heap
// and are therefore captured by the snapshot (no re-inject on restore).
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
// V0.9 CODEMODE / RLM host-side context store + handle tools.
//
// The RLM premise is a context ~2 orders of magnitude beyond the model window. It CANNOT
// live in the 18MB QuickJS snapshot envelope, so it lives HOST-SIDE (ctx.contextStore, a
// Map<name,string> OUTSIDE the WASM linear memory, persisted alongside kv in the snapshot
// meta) and the VM reads it through coarse, boundary-crossing handle tools:
//   host.ctx.len([name])            -> length in chars
//   host.ctx.slice(a,b,[name])      -> substring (capped at CTX_MAX_SLICE so a single
//                                      oversized boundary copy can't WS-1006 the cell)
//   host.ctx.grep(re,[opts,name])   -> [{i,line}] matches (opts: {flags,max})
//   host.ctx.chunk(size,[name])     -> [{i,start,end,len}] chunk descriptors (NOT the bytes)
//   host.ctx.get(i,size,[name])     -> the i-th size-char chunk's text (capped)
//   host.ctx.names()                -> stored context names
// Bytes never enter the snapshot envelope; only the slices the model explicitly pulls do.
//
// V0.9.1: the host-side store is now CHUNKED across SQLite rows (lib.rs ctx_chunks ~64KB +
// ctx_n_chunks manifest count), so a multi-MB context survives evict/cold-restore (the v0.9
// HIGH bug: a single ctx_json TEXT value hit SQLITE_TOOBIG and was LOST on cold restore). The
// store still hydrates into ONE in-memory Map<name,string>, so len/slice/grep/chunk/get read
// across chunks transparently with no API change. Because the chunked store no longer constrains
// a single read, CTX_MAX_SLICE is raised 256KB -> 1MB: a 1MB slice result returned through the
// __hostCall JSON boundary lands comfortably under the per-cell growth tripwire (8MB) and the
// 18MB dump ceiling, so it can never WS-1006 the cell.
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
// V0.8 FEATURE A: typed error thrown by the interrupt handler when a cell's live used heap
// crosses MAX_CELL_USED_BYTES mid-execution. Unwinds the cell like any thrown error ->
// {ok:false,error:{name:"MemoryLimitError"}}, socket alive, VM usable. Distinct from
// SizeAdmissionError (post-cell dump guard) so callers can tell an in-cell alloc bomb (caught
// mid-cell, before the buffer becomes undumpable) from a dump-time refusal.
class MemoryLimitError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "MemoryLimitError";
    this.code = "MEMORY_LIMIT";
  }
}
// V0.9.3 GAP 1: typed error for a NATIVE-C giant allocation caught by the QuickJS memoryLimit
// (dlmalloc malloc-limit) backstop, OR an oversized host-bridged arg/result. Distinct from
// MemoryLimitError (the bytecode-interrupt mid-cell tripwire) so callers can tell a native-C
// alloc bomb (typed-array fill / structuredClone / big host arg) — which the interrupt tripwire
// CANNOT see — from a bytecode-driven one. Socket alive, VM usable, WASM buffer never grew.
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

// P3: enforce the config.fetch allowlist for an outbound URL.
//   config.fetch === false        -> block ALL (typed error)
//   config.fetch === true         -> allow ALL
//   config.fetch === [hostnames]  -> allow only those hostnames (typed error otherwise)
// Returns a parsed URL on success; throws FetchBlockedError otherwise.
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

// Entropy source. `seeded`=false routes to real wall-clock / Math.random (config
// "clock":"real"); but the observable counter state is still tracked so restore is
// well-defined. rngSeed is configurable.
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
  // V0.8 FEATURE B + determinism gate: the crypto Tier-0 extension now installs a NATIVE
  // globalThis.crypto with getRandomValues / randomUUID / subtle. The native getRandomValues
  // and randomUUID already route through the WASI random_get import, which the host WASI factory
  // SEEDS (mulberry32) — so they are deterministic and snapshot-reproducible WITHOUT any patch.
  // crypto.subtle is a pure function of its input (no entropy) so it is deterministic regardless
  // and we leave it REAL/native.
  //
  // We still install a seeded JS getRandomValues shim ON TOP as a determinism belt-and-suspenders
  // (it routes through __hostRandom -> the same seeded counter), and to keep crypto present even
  // if the extension failed to load (older entry / no .so). On a NON-seeded ('real') session the
  // shim's __hostRandom returns Math.random() (already the configured behavior), so determinism
  // is gated on config exactly as before. We do NOT touch subtle/randomUUID — those stay native.
  // V0.6 note retained: pre-v0.8 QuickJS-ng had NO globalThis.crypto, so the v0.5 conditional was
  // a no-op; now crypto exists (native), so the else-branch patch applies.
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
      // Native crypto present (extension). Override getRandomValues with the seeded shim so the
      // seeded byte sequence is guaranteed; keep native subtle + randomUUID intact. If the
      // property is non-writable the native (also-seeded-via-random_get) impl simply stays.
      try { globalThis.crypto.getRandomValues = gv; } catch (e) {}
    }
  }
  // BUG-5: seeded performance.now(). QuickJS-ng ships a native performance.now whose
  // descriptor may be non-writable, so REPLACE the whole object (define it writable).
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

  // Host tool boundary: host.<name>(...args) and host.<ns>.<name>(...args) ->
  // __hostCall("ns.name", args) (JSON args). A recursive proxy supports nested tool
  // names so both host.echo(...) and host.kv.put(...) resolve.
  function __mkHostProxy(prefix) {
    const callable = function () {};
    return new Proxy(callable, {
      get(_t, name) {
        if (typeof name !== 'string') return undefined;
        // P3: host.fetch(url, init) is a REAL async outbound fetch. __hostFetch returns
        // a host-created Promise; awaiting it yields {status, headers, body} or rejects
        // with a typed error (FetchBlockedError / FetchError). Only the top-level name.
        if (!prefix && name === 'fetch') {
          return function (url, init) {
            const p = __hostFetch(String(url), JSON.stringify(init === undefined ? null : init));
            // __hostFetch resolves with a JSON STRING (or rejects with a typed error);
            // parse it into a structured {status, ok, headers, body} object for the cell.
            return Promise.resolve(p).then(function (s) {
              return typeof s === 'string' ? JSON.parse(s) : s;
            });
          };
        }
        // V0.9 RLM leaf-oracle boundary: host.subLM(prompt, opts) is an ASYNC sub-LM call
        // bridged host-side to the model backend (config.subLMEndpoint, supplied by the SDK
        // client — the model lives client-side). __hostSubLM returns a VM Promise resolving to
        // a STRING completion (or rejecting with a typed error), driven by the same eval pump
        // as host.fetch. Isolated exactly like Code Mode's fns / rlms' marshaled sub-calls.
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

// Install all host-backed functions (fresh kernel). `ctx` carries entropy, the live
// console buffer ref, and the host-tool dispatcher.
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
// re-registration binds the SAME live entropy/console/tools.
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
    // P3: REAL outbound fetch. Synchronously creates a VM Promise (deferred), starts the
    // host-side fetch, and returns the promise handle to the VM. The async settle resolves
    // the deferred with {status, headers, body} (text) or rejects with a typed error. The
    // eval pump (evalCode) awaits the in-flight fetch settles + drains pending jobs.
    //
    // DETERMINISM: fetch is an EXPLICIT host effect. It does NOT call ctx.entropy, so the
    // seeded clock/RNG counters are untouched — a fetch can never desync determinism.
    __hostFetch(...args) {
      const vm = this.vm;
      const urlStr = args[0] ? args[0].toString() : "";
      const initJson = args[1] ? args[1].toString() : "null";
      // Allowlist enforcement (typed error) — surfaced as a REJECTED VM promise so the
      // socket stays alive and the kernel usable.
      let urlObj, init;
      try {
        // "full allow for now": when config.fetch is UNSET, default to true (allow all).
        // Set config.fetch:false (or an allowlist) to restrict. Multi-tenant (v1.2) keeps
        // its own per-tenant gateway + deny-by-default at the supervisor regardless.
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
            hdrs["User-Agent"] = "montydyn/0.9 (+https://github.com/umgbhalla/montydyn)";
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
          // Resolve with a STRING; the VM-side host.fetch wrapper JSON.parses it into a
          // structured object. (Resolving with a host-built object handle is fragile; a
          // string round-trips cleanly across the boundary.)
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
    // V0.9 RLM sub-LM bridge. Synchronously creates a VM Promise, fires the host-side sub-LM
    // call (an HTTP POST to config.subLMEndpoint — the SDK client stands up that endpoint and
    // owns the model backend), and resolves the deferred with the completion STRING. Reuses the
    // host.fetch eval pump via ctx.pendingFetches so the cell can `await host.subLM(...)`.
    // DETERMINISM: like fetch, this is an explicit host effect; it does NOT touch ctx.entropy.
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
      // V0.9.3 GAP 1: pre-flight SIZE CHECK on the inbound host-bridged arg blob. An oversized
      // single arg (a multi-hundred-MB JSON string) would have to be materialized in the VM heap
      // on the way out; refuse it as a typed NativeAllocLimitError (surfaced as a thrown VM error)
      // before it can drive an allocation toward the OOM edge.
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
      // V0.9.3 GAP 1: pre-flight SIZE CHECK on the tool RESULT before it crosses back into the VM
      // heap. A tool that returns a giant blob would force an oversized in-VM string allocation.
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
// Built-in / demo host tools. A real deployment registers more via config.tools.
// Tools are plain host JS functions: (…jsonArgs) -> json-serializable result.
// kv.* persists in an in-host Map keyed per kernel (survives snapshot via re-bind
// only within a warm session; across restore the namespace re-creates it — for V0.1
// we keep a demo echo + a kv backed by a Map that is rebuilt fresh on restore).
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

    // ---- V0.9 RLM termination sentinels ----
    // host.final(value) / host.finalVar(name): record the RLM answer host-side. The SDK reads
    // it back via the {t:"final"} message (or session.onFinal). final() takes a literal value;
    // finalVar(name) defers to a globalThis variable read at collection time (so a big answer
    // built up in the VM namespace need not cross the boundary until the SDK asks for it).
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
  // V0.9: the ctx.* / subLM / final family is ALWAYS enabled (codemode/RLM surface), regardless
  // of an explicit config.tools allowlist — those names gate only the demo tools (echo/add/kv).
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
    // "full allow for now" default: unset -> true (allow all). Explicit false blocks;
    // an array is a hostname allowlist. (Single-tenant v093; v1.2 supervisor still has its
    // own per-tenant gateway + deny default for untrusted multi-tenant.)
    fetch: cfg.fetch === false ? false : Array.isArray(cfg.fetch) ? cfg.fetch : true,
    // V0.9: the sub-LM bridge endpoint (the SDK client stands this up; the model backend lives
    // client-side). host.subLM(prompt,opts) POSTs {prompt,opts} here. A string, else null.
    subLMEndpoint: typeof cfg.subLMEndpoint === "string" ? cfg.subLMEndpoint : null,
    tools: Array.isArray(cfg.tools) ? cfg.tools : null,
    // V0.6: configurable in-VM stdlib selection. true=all default modules,
    // [names]=subset, else none (v0.5-compatible). Persisted with the session config
    // as the record of what was injected at create time (NOT re-evaluated on restore —
    // the libs travel in the heap snapshot).
    modules: cfg.modules === true ? true : Array.isArray(cfg.modules) ? cfg.modules.map(String) : null,
    // V0.7: optional INLINE stdlib source blob, evaled into the VM at create AFTER the
    // selected bundle modules. Fenced at MAX_INLINE_STDLIB_BYTES (GUARD 1) so a multi-MB
    // string can't cross the one-shot-compile WS-1006 cliff. A string, else null.
    stdlib: typeof cfg.stdlib === "string" ? cfg.stdlib : null,
    // P1 (BUG-3): execution budget as interrupt "ticks". QuickJS calls the interrupt
    // handler about once per ~20k bytecode ops (measured on this quickjs-wasi build),
    // NOT per instruction. On Cloudflare Workers Date.now() is FROZEN during synchronous
    // execution (spectre mitigation), so a pure wall-clock deadline NEVER trips in a tight
    // busy loop — therefore the tick budget is the PRIMARY hard preemption and the
    // handler decrements it on EVERY invocation, so an empty `while(true){}` (which never
    // touches a value) trips just the same as a value-touching loop.
    //
    // Calibration (local, ~20k ops/tick): a 10M-iteration legit loop consumes only ~2000
    // ticks; an empty `while(true){}` accrues ticks at ~20k iters/tick. v0.1's 30k default
    // was too high: on workerd 30k ticks can ride past the ~30s DO wall limit -> WS 1006.
    // v0.2 lowers the default to 8000 ticks so an empty loop trips in a few seconds on
    // workerd while a 10M-iteration loop still completes comfortably. Capped at 200k for
    // genuinely heavy work; configurable. (`cellBudgetTicks` preferred; `cellBudgetInstr`
    // accepted as an alias.)
    // P1 (gate-corrected, BISECTED on live montydyn-v02): the interrupt-handler tick budget
    // is the PRIMARY hard preemption (on workerd Date.now() is FROZEN during sync execution, so
    // a wall-clock deadline can never trip). The two gate requirements are in DIRECT TENSION on
    // this workerd/QuickJS-ng build and a single static budget cannot satisfy both 100%:
    //   * SAFETY (non-negotiable): every infinite-loop shape — empty `while(true){}`,
    //     `while(true){x=1}`, `while(true){globalThis.x=1}`, `let o={};while(true){o.a=1}` —
    //     MUST trip a typed TimeoutError with the socket ALIVE (no WS 1006). workerd throttles
    //     the host interrupt callback after a bounded, LOAD-SENSITIVE number of invocations per
    //     synchronous turn; the heavier per-iteration property-store shapes (`globalThis.x=1`,
    //     `o.a=1`) hit that throttle SOONER, so if the budget sits above the throttle floor the
    //     handler stops firing before the budget is reached and the loop rides to the DO wall ->
    //     WS 1006. Measured fresh-DO escape rates: budget 2500 -> property-store loops escape
    //     intermittently (~1 in 4 gate runs); 1800 -> ~1-2/6; 1500 -> ~1/6; **1200 -> 0
    //     escapes across 18/18 reps per shape**; 1000 -> 0. So the budget MUST be <=~1200.
    //   * 10M-LOOP COMPLETION (best-effort): a legit 10M tight loop needs ~2050-2150 interrupt
    //     ticks (the cadence itself jitters run-to-run). It only completes for budgets in a
    //     narrow ~2050-2150 band — which is ABOVE the safe ceiling. So at the safe default a 10M
    //     loop FALSELY (but safely — typed TimeoutError, socket alive, recoverable) trips.
    // RESOLUTION: prioritize the non-negotiable safety property. Default 1200 (every infinite
    // loop trips clean, socket alive, ~0.2-1s); cap 2000 so a caller who KNOWINGLY needs a heavy
    // ~10M-iteration burst can opt into the riskier 2050-band via explicit cellBudgetTicks while
    // accepting the rare property-store escape — but the safe default never WS-1006s. Chunking a
    // large burst across cells (each cell re-arms the budget) is the robust pattern. The handler
    // stays maximally cheap (single closure-local decrement) so trips land promptly.
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
    this.deadline = Infinity; // wall-clock budget for the current cell (BUG-3, secondary)
    this.instrLeft = Infinity; // instruction-count budget (BUG-3, primary on Workers)
    // V0.8 FEATURE A: when true the interrupt handler periodically probes the used heap and
    // trips a MemoryLimitError if it crosses MAX_CELL_USED_BYTES mid-cell. Armed only during a
    // user eval (not during internal evals like the scrub or __cellP reads). `_memTripped`
    // carries the offending used-byte count so _formatError can label the typed error.
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
    // P1 (BUG-3): PRIMARY = the hard interrupt-tick budget. QuickJS invokes this handler
    // about once per ~20k bytecode ops (its internal interrupt interval), NOT once per
    // instruction. We decrement `instrLeft` on EVERY invocation unconditionally, so ANY
    // loop — including a truly empty `while(true){}` that never touches a value — hits the
    // budget and trips a typed TimeoutError with the socket alive, well before the ~30s DO
    // wall limit (which would WS-1006 the whole object).
    //
    // Wall-clock is a SECONDARY guard only: on workerd Date.now() is FROZEN during sync
    // execution, so the deadline can never trip there; it is kept solely so that on a
    // host where time DOES advance (node/tests) a long-but-low-tick cell can still be
    // bounded. It can never make a workerd cell ride past the tick budget.
    const self = this;
    return () => {
      // HARD primary: decrement the tick budget on EVERY invocation, unconditionally, and
      // trip as soon as it is exhausted. This MUST cover per-iteration global/object
      // property-store loops (`while(true){x=1}`, `while(true){globalThis.x=1}`) — QuickJS-ng
      // invokes the interrupt callback on backward branches regardless of the loop body, so a
      // property-store loop accrues ticks exactly like an empty loop. We never gate the
      // decrement on a value/object touch, so no loop shape can escape it.
      //
      // CRITICAL workerd note: the host interrupt callback is EXPENSIVE (host-boundary
      // crossing) and workerd stops invoking it after a bounded number of calls within one
      // synchronous turn (empirically ~1.6k). So the budget MUST be kept BELOW that cap
      // (see normalizeConfig: default 1200, hard-capped at 1500) or a loop will ride past
      // the budget to the DO wall limit. We keep this handler as cheap as possible (a single
      // closure-local decrement; no Date.now()/property reads on the hot path) to maximize
      // how many invocations land before workerd throttles it.
      if (--self.instrLeft <= 0) return true;
      // V0.8 FEATURE A: MID-CELL USED-HEAP TRIPWIRE. Probe the live used heap on EVERY interrupt
      // invocation while a user cell is in flight. The interrupt fires only ~once per 20k
      // bytecode ops, and the tick budget caps invocations at <=1200/cell, so this is at most
      // ~1200 getMemoryUsage() host crossings/cell — well under the ~1.6k/turn throttle. We do
      // NOT gate it behind a coarse mask: a tight allocation loop (push 1MB/iter) crosses 16MB
      // in only ~16 interrupt invocations, so a 1-in-64 probe would miss it and the cell would
      // ride to QuickJS's own (catchable but mislabelled) `out of memory` instead of our typed
      // tripwire. Tripping here raises the interrupt -> a thrown InternalError that unwinds the
      // cell; _formatError sees self._memTripped and labels it a typed MemoryLimitError. Socket
      // stays alive, namespace usable, and the buffer aborts BELOW the 18MB undumpable ceiling.
      if (self._memWatch) {
        // Use the WASM linear-memory buffer byteLength, NOT getMemoryUsage(): the buffer length
        // is a plain ArrayBuffer property read that is always safe to touch re-entrantly from
        // inside the interrupt callback (the VM is mid-execution; calling the heavier QuickJS
        // memory-stats C function re-entrantly proved unreliable here — it returned 0, so the
        // tripwire never fired and the cell rode to QuickJS's own `out of memory`). The buffer
        // grows monotonically as the cell allocates and is exactly the quantity that approaches
        // the 18MB undumpable dump ceiling, so a 16MB buffer threshold aborts the cell with
        // ~2MB of head-room before the snapshot would become un-dumpable.
        let buf = 0;
        try {
          buf = self.kernel._getMemory().buffer.byteLength;
        } catch (_) {
          buf = 0;
        }
        // Trip on per-cell GROWTH past the limit OR the absolute backstop ceiling, whichever
        // comes first. _memBufBase is the buffer size at cell entry (set in evalCode).
        const grewTooFast = buf - (self._memBufBase | 0) > CELL_GROWTH_LIMIT_BYTES;
        if (buf > 0 && (grewTooFast || buf > MAX_CELL_USED_BYTES)) {
          self._memTripped = buf;
          return true;
        }
      }
      // SECONDARY (best-effort only): wall-clock. On workerd Date.now() is FROZEN during sync
      // execution so this never trips there; on hosts where time advances (node/tests) it
      // bounds a long-but-low-tick cell. Checked sparsely. Guarded so an Infinity budget can't
      // false-trip and so the frozen-clock workerd path pays at most a cheap mask test.
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
    // V0.8 FEATURE B: wire the 5 Tier-0 native extensions at create. They install
    // crypto/TextEncoder/TextDecoder/URL/URLSearchParams/structuredClone/Headers as VM globals.
    // Their state lives in the WASM linear memory, so it is captured by the snapshot; restore()
    // re-instantiates the SAME descriptors (same order) at fixed bases before the heap blit.
    this.kernel = await QuickJS.create({
      wasm: quickjsModuleRef(),
      wasi: buildWasiFactory(this.ctx.entropy),
      interruptHandler: this._interruptHandler(),
      extensions: buildExtensionDescriptors(),
      // V0.9.3 GAP 1: hard native dlmalloc malloc-limit. A giant native-C allocation (typed-array
      // fill, structuredClone, oversized host arg) now FAILS as a catchable OOM before it can grow
      // the WASM buffer toward an uncatchable Error 1102 / WS 1006.
      memoryLimit: NATIVE_MALLOC_LIMIT_BYTES,
    });
    installHostFns(this.kernel, this.ctx);
    this.kernel.evalCode(REBIND_SRC).dispose?.();
    // V0.6: inject the configured in-VM stdlib AFTER REBIND_SRC (crypto seeded for
    // nanoid/uuid). The injected globals live in the heap → captured by the snapshot →
    // persist across hibernation with NO re-inject on restore.
    //
    // V0.7 GUARDS 1+2: resolve modules (opt-in libs excluded from `true`), then enforce the
    // combined-source cap + the inline-blob fence BEFORE any eval-into-heap. A cap breach
    // throws SizeAdmissionError, which propagates out of createFresh → lib.rs surfaces it as a
    // typed error in the create reply with the SOCKET ALIVE (no WS 1006), and the VM is dropped
    // by the failed-create path so it never grows toward the OOM cliff.
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
    // V0.7: inline stdlib blob injected AFTER the bundle modules (so it can build on them).
    // A throw inside the blob is captured per-blob (kernel stays usable), like a module failure.
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

  // V0.4: per-restore phase timings from the LAST restore(). Read by lib.rs and folded
  // into the eval reply as restoreTimings:{gunzipMs, deserializeMs, instantiateMs,
  // growCount, neededPages, presizedPages, totalGlueMs}. HARD CONSTRAINT: on workerd the
  // wall/high-res clock is FROZEN during a synchronous turn (spectre mitigation), so we can
  // only read meaningful Date.now() deltas ACROSS the I/O await boundaries that unfreeze it
  // (after the gunzip await, after the QuickJS.restore await). Phases that are purely
  // synchronous inside one turn (e.g. deserializeSnapshot) read as 0 here and that 0 is
  // HONEST — they are sub-ms and unmeasurable in-isolate; we infer them by differencing the
  // server-stamped total (lib.rs) against the measurable awaited phases. growCount /
  // neededPages are exact (counted, not timed) so the pre-size win is verifiable directly.
  lastRestoreTimings() {
    const t = this._restoreTimings || {};
    return JSON.stringify(t);
  }

  // V0.9.3 GAP 2 — ENGINE-MIGRATION JOURNAL REPLAY (ADR-0002). Called by lib.rs when the committed
  // snapshot's engine hash != the current engine hash: the heap image is byte-coupled to the old
  // engine and CANNOT be blitted into the new one, so instead of a hard EngineHashMismatchError we
  // rebuild a FRESH engine and REPLAY each committed cell's source in order.
  //
  //   * PURE cells reproduce their namespace exactly (the whole point of the journal).
  //   * EFFECTFUL cells (flagged host-side: host.fetch/subLM/kv/tools, Math.random/Date/crypto) are
  //     STILL replayed best-effort, but flagged in the result — their side effects do NOT re-fire to
  //     the outside world faithfully (a fetch re-runs live; a kv mutation re-applies to the rebuilt
  //     host Map; seeded entropy re-advances from 0), so the recovery is honest about the no-replay
  //     caveat. This is the documented ADR-0002 tradeoff: heap-snapshot is the fast path, the
  //     source journal is the engine-migration safety net.
  //
  // kv + ctx host-side state (which live OUTSIDE the heap) are re-hydrated first so a replayed cell
  // that reads host.kv / host.ctx sees the committed values.
  async replayJournal(journalJson, configJson, kvJson, ctxJson) {
    // Build a fresh engine under the persisted config (this also re-injects the configured stdlib
    // into the fresh heap, so a replayed cell that uses lodash/dayjs/etc. still resolves them).
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
      // Replay through the SAME async eval path so an effectful cell's host.fetch/subLM pump still
      // works and a loop is still preempted. We do NOT propagate a replay failure: a single bad
      // cell (e.g. an effectful one that throws because its external dependency is gone) must not
      // abort the whole recovery — we record it and continue, best-effort.
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
      // The no-replay caveat: if any cell was effectful, the recovered namespace is best-effort
      // (pure cells exact; effectful ones may diverge). A pure-only journal recovers faithfully.
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
    // P0 (cold-restore wedge FIX): admit on the RECORDED used heap (persisted in the
    // manifest at dump time), NOT on the raw image bytes. A freed-then-small session whose
    // raw buffer is at a high water-mark but whose live used heap is tiny MUST restore.
    const recordedUsed = Number.isFinite(usedHeap) && usedHeap > 0 ? usedHeap | 0 : 0;
    if (recordedUsed > MAX_RESTORE_USED_BYTES) {
      throw new SizeAdmissionError(
        `recorded used heap ${recordedUsed} > MAX_RESTORE_USED_BYTES ${MAX_RESTORE_USED_BYTES}; refusing restore`,
      );
    }
    // SAFE-TO-INSTANTIATE fail-safe only: a genuinely-too-big image (cannot be blitted
    // back without an uncatchable OOM) still fails safe. This is NOT the live-state gate.
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
    // B1 (pre-size): the snapshot's raw memory image dictates the final WASM page count.
    // quickjs-wasi's restore() grows the fresh instance's memory ONCE up front (single
    // grow(needed-current)) BEFORE blitting bytes, so the blit (a single dst.set) never
    // triggers an incremental grow. We INSTRUMENT this directly: count every
    // WebAssembly.Memory.prototype.grow() invocation during the restore window and record
    // the needed/initial page counts. The win we assert is "grow happens exactly once (or
    // zero) and the blit causes NO further grow churn" — verifiable from growCount.
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
      // V0.8 FEATURE B (CRITICAL): restore() makes a NEW WASM instance + blits the heap back, so
      // the native extension bindings (function-table entries at fixed bases) MUST be re-supplied
      // — the SAME descriptors in the SAME order as create. quickjs-wasi re-instantiates each
      // extension at the memory/table base recorded in the snapshot BEFORE overwriting linear
      // memory, reconstructing crypto/URL/TextEncoder/structuredClone/Headers after a cold wake.
      // Omitting them would leave the restored heap referencing missing natives.
      this.kernel = await QuickJS.restore(snap, {
        wasm: quickjsModuleRef(),
        wasi: buildWasiFactory(this.ctx.entropy),
        interruptHandler: this._interruptHandler(),
        extensions: buildExtensionDescriptors(),
        // V0.9.3 GAP 1: re-apply the native malloc-limit backstop to the restored VM (quickjs-wasi
        // supports a different/identical limit post-restore). Keeps the giant-alloc guard live
        // across hibernation/cold-wake.
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

  // Eval a cell. ALWAYS resolves to a JSON string {ok, value, valuePreview, logs, error?}
  // and NEVER throws/rejects across the boundary (BUG-1: the lib.rs eval mutex is always
  // released). P3: eval is ASYNC so a cell may `await host.fetch(...)` — we run with
  // EvalFlags.ASYNC and pump pending jobs + in-flight host-fetch settles until the
  // top-level promise resolves.
  //
  // DETERMINISM: only host.fetch() crosses to the network, and it never touches
  // ctx.entropy, so the seeded clock/RNG counters are unaffected by any fetch.
  async evalCode(src) {
    this.ctx.logs = [];
    this.ctx.pendingFetches = [];
    const budget = this.config.cellBudgetMs;
    this.deadline = budget > 0 ? Date.now() + budget : Infinity;
    this.instrLeft = this.config.cellBudgetTicks > 0 ? this.config.cellBudgetTicks : Infinity;
    // V0.8 FEATURE A: arm the mid-cell used-heap tripwire for the duration of this user eval.
    // Capture the buffer size at cell entry so the tripwire fires on per-cell GROWTH (the
    // monotonic buffer never shrinks, so an absolute-only threshold would wedge every cell
    // after the first big one).
    this._memWatch = true;
    this._memTripped = 0;
    this._memBufBase = this._bufferBytes();
    try {
      // ASYNC eval: the synchronous portion runs under the interrupt-tick budget (a tight
      // loop still trips before any await). The returned handle is a Promise resolving to
      // the cell's completion value. We STORE it to a global so a fresh read after fully
      // draining microtasks + in-flight fetches yields the SETTLED value cleanly (reading
      // the original ASYNC handle pre-drain races and returns an empty value — proven).
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
    // Synchronous portion done — drop the tick budget so awaited host fetches (which run
    // on the host event loop, not VM bytecode) are not falsely preempted. The mid-cell
    // memory tripwire stays ARMED through _drivePromise: a post-await continuation (e.g. a
    // .then() that allocates) re-arms the tick budget per round, so the probe still fires.
    this.deadline = Infinity;
    this.instrLeft = Infinity;

    let settledHandle;
    try {
      settledHandle = await this._drivePromise(budget);
    } catch (e) {
      this._memWatch = false;
      return JSON.stringify(this._formatError(e, budget));
    }

    // Cell has fully settled — no more user VM bytecode runs below (only preview/dump), so
    // disarm the mid-cell tripwire (the preview/dump paths have their own guards).
    this._memWatch = false;

    if (settledHandle && settledHandle.error) {
      // The cell's promise REJECTED (e.g. an unawaited throw, or `await host.fetch` to a
      // blocked host). Surface as an error value; kernel stays usable.
      const errObj = this._formatError(this._handleToError(settledHandle.error), budget);
      try { settledHandle.error.dispose?.(); } catch (_) {}
      return JSON.stringify(errObj);
    }

    // ASYNC-eval convention (quickjs-wasi): a FULFILLED top-level promise resolves (via
    // resolvePromise) to a wrapper object {value: <completion value>}. Unwrap one level to
    // recover the real cell value handle.
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
        // P3: a RETURNED Error carries its structured {name,message,stack} in `value` (so
        // callers can read value.message), not just the preview string. Primitives pass
        // through; other complex types keep the preview-string `value` (existing contract).
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

  // P3: drive the global `__cellP` (an ASYNC-eval top-level Promise) to settlement,
  // interleaving VM microtask draining (executePendingJobs) with awaiting any in-flight
  // host.fetch settles. Once `__cellP.promiseState` is non-pending, resolvePromise on a
  // FRESH read returns {value} (fulfilled) or {error} (rejected) cleanly.
  async _drivePromise(budget) {
    const MAX_ROUNDS = 20000;
    // Re-arm the tick budget around each microtask drain so a runaway loop in a post-await
    // continuation is still preempted (loop-preemption invariant survives async cells).
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
      // No fetches in flight, still pending: yield once for any host microtask, then re-check.
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
    // V0.8 FEATURE A: an interrupt raised because the mid-cell used-heap tripwire fired is a
    // MemoryLimitError, NOT a TimeoutError. _memTripped (set in the interrupt handler) carries
    // the offending used-byte count; check it FIRST so a real alloc bomb is labelled correctly.
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
      // V0.9.3 GAP 1: the native dlmalloc malloc-limit (memoryLimit) tripped — a giant native-C
      // allocation (typed-array fill, structuredClone, big JSON/regexp) was REFUSED before it
      // could grow the WASM buffer toward an uncatchable OOM. Re-label as the typed
      // NativeAllocLimitError. Socket is alive, the namespace is intact, the buffer never grew.
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
    // P3 (error-as-VALUE): a cell that RETURNS (not throws) an Error object previously
    // previewed as "{}" because Error fields are non-enumerable, so JSON.stringify(dump)
    // dropped name/message/stack. Detect the Error and surface name+message(+short stack).
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

  // P0: used-heap measurement. memoryUsedSize is QuickJS's live malloc'd bytes; it
  // shrinks after a free+GC even though the WASM linear-memory buffer does not.
  _usedHeapBytes() {
    try {
      const m = this.kernel.getMemoryUsage();
      // memoryUsedSize is the total live used heap; mallocSize is malloc'd bytes. Use the
      // larger as the admission figure (defensive).
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

  // P0 (BUG-2/4) snapshot shrink: after a free the freed dlmalloc region still holds
  // stale, incompressible bytes that bloat the gzip image (the WASM buffer itself can't
  // shrink — memory.grow is monotonic). Re-allocating zero-initialized ArrayBuffers
  // across that freed slack forces dlmalloc to RE-SERVE those just-freed chunks, and
  // because a fresh ArrayBuffer is spec-zero-initialized the stale bytes are overwritten
  // with zeros; we then free them + GC, so the freed pages are now zero and gzip collapses
  // them. This does NOT touch any live object — the namespace is untouched.
  //
  // SAFETY (critical on workerd): the scrub MUST NOT grow linear memory, because the
  // snapshot/serialize transient is already ~2-3x and an uncatchable OOM (Error 1102 / WS
  // 1006) would kill the whole DO. So we (a) only scrub when the buffer is below a safe
  // ceiling, and (b) allocate STRICTLY LESS than the freed slack (and in modest chunks) so
  // dlmalloc reuses the freed region in place rather than calling sbrk to grow. We zero up
  // to a bounded budget; partial scrubbing still shrinks the image substantially.
  _scrubArena(slackBytes) {
    const MB = 1024 * 1024;
    // Stay well under the freed slack so dlmalloc reuses freed chunks (no memory.grow),
    // and cap the absolute scrub so the transient stays bounded.
    const budgetMB = Math.max(0, Math.min(Math.floor((slackBytes / MB) * 0.6), 24));
    if (budgetMB < 1) return;
    // Allocate in 1MB chunks one at a time, zero already (fresh ArrayBuffer), drop refs,
    // GC. Doing it in a single eval keeps host-boundary cost low.
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

  // Dump memory+globals -> serialize -> STREAM gzip.
  // P0 (BUG-2/4): GC, then guard on USED heap (not the monotonic buffer), then SCRUB the
  // freed arena so the gz image shrinks back toward baseline after a free.
  async dump() {
    const QuickJS = await QJS();

    // P0: HARD buffer ceiling FIRST — before runGC or any full-buffer touch. snapshot()
    // + serialize copy the FULL monotonic buffer ~2-3x and even runGC over a multi-tens-MB
    // arena can push the isolate to an UNCATCHABLE OOM (Error 1102 / WS 1006 / hang). So
    // once the buffer has grown past a safe ceiling we refuse to do ANY heavy work and
    // FAIL SAFE with a typed error, socket alive, prior snapshot intact. WASM linear memory
    // never shrinks in place, so this session can no longer durably checkpoint until reset.
    const bufBytes = this._bufferBytes();
    if (bufBytes > MAX_DUMP_BUFFER_BYTES) {
      throw new SizeAdmissionError(
        `linear-memory buffer ${bufBytes} > MAX_DUMP_BUFFER_BYTES ${MAX_DUMP_BUFFER_BYTES}; ` +
          `refusing snapshot (WASM memory cannot shrink in place and dumping/scanning the ` +
          `full buffer would risk an uncatchable OOM). reset to recover.`,
      );
    }

    try {
      this.kernel.runGC();
    } catch (_) {}

    // P0: admission on the ACTUAL used heap. This is THE fix that un-wedges checkpointing
    // after a free: a session that spiked then freed it reports a small used heap.
    const usedAfterGc = this._usedHeapBytes();
    if (usedAfterGc > MAX_USED_BYTES) {
      throw new SizeAdmissionError(
        `live used heap ${usedAfterGc} > MAX_USED_BYTES ${MAX_USED_BYTES}; refusing snapshot`,
      );
    }

    // P0: shrink the stored image after a free. If the linear-memory buffer is much
    // larger than the used heap (i.e. a big block was freed), scrub the freed pages to
    // zero so they compress away. SAFETY: only when the buffer is under a ceiling, so the
    // (bounded, non-growing) scrub can never push an already-large image into an
    // uncatchable OOM.
    let scrubbed = false;
    if (
      bufBytes - usedAfterGc > SCRUB_SLACK_BYTES &&
      bufBytes <= SCRUB_MAX_BUFFER_BYTES
    ) {
      this._scrubArena(bufBytes - usedAfterGc);
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
      // P2: host-tool (kv) state persisted across restore. ctx.kv lives OUTSIDE wasm
      // linear memory, so it must travel with the snapshot meta and be re-hydrated.
      kvJson: this._serializeKv(),
      // V0.9: host-side context store travels with the snapshot meta (kv-style) so the RLM
      // context handle survives evict/cold-restore — the durability differentiator.
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
