//! engram Rust kernel ENGINE (rquickjs on wasm32-wasip1).
//!
//! ALL kernel logic lives here in Rust — eval, value-preview, guards, determinism,
//! host-boundary. The host (a thin JS WASI shim) only provides: WASI imports, the
//! literal `memory.buffer` blit (snapshot substrate), and the implementation of two
//! host effects (fetch / kv) that the engine cannot do from inside wasip1.
//!
//! ABI (C exports the shim calls):
//!   scratch_ptr() / result_ptr() / result_len()    — IO buffers (no host marshalling)
//!   create(clock_seed, rng_seed)                    — seed + build runtime
//!   reattach()                                      — re-validate blitted runtime
//!   eval_begin(src_ptr, src_len, budget, grow_cap)  — start eval; returns status (see below)
//!   eval_resume(...)                                — feed a host-effect result, continue
//!   pending_host_call_ptr()/len()                   — read the host-call request JSON
//!   used_heap() / buffer_bytes()                    — size-admission introspection
//!   clock_calls() / rng_calls()                     — entropy counters (persist in manifest)
//!   set_counters(clock, rng)                        — restore entropy counters
//!   kv_export_ptr()/len() / kv_import(ptr,len)      — host.kv state serialize/restore
//!
//! eval_begin / eval_resume return an i32 status:
//!   0 = DONE  (result JSON is in RESULT)
//!   1 = HOST_CALL pending (request JSON in HOSTCALL; shim must call eval_resume)

use rquickjs::{Context, Ctx, Function, Runtime, Value};
use std::cell::{Cell, RefCell};

thread_local! {
    static CTX: RefCell<Option<(Runtime, Context)>> = RefCell::new(None);
    static CLOCK: Cell<u64> = Cell::new(0);
    static RNG: Cell<u64> = Cell::new(0);
    static CLOCK_CALLS: Cell<u64> = Cell::new(0);
    static RNG_CALLS: Cell<u64> = Cell::new(0);
    // interrupt-budget guard
    static BUDGET: Cell<i64> = Cell::new(0);
    static TRIPPED: Cell<bool> = Cell::new(false);
    static WIRED: Cell<bool> = Cell::new(false);
    // BUFFER-GROWTH TRIPWIRE: pages at eval-begin + per-cell grow cap (in pages).
    static START_PAGES: Cell<u32> = Cell::new(0);
    static GROW_CAP_PAGES: Cell<u32> = Cell::new(0);
    static GROW_TRIPPED: Cell<bool> = Cell::new(false);
    // host-call rendezvous: when a host effect (fetch/kv) is invoked from JS, the
    // request is parked here and control returns to the shim; the resolved value is
    // injected on resume.
    static HOSTCALL_REQ: RefCell<Option<String>> = RefCell::new(None);
    static HOSTCALL_RES: RefCell<Option<String>> = RefCell::new(None);
    // kv store (host.kv) — small, persisted across restore via export/import.
    static KV: RefCell<std::collections::BTreeMap<String, String>> = RefCell::new(std::collections::BTreeMap::new());
}

// ---- IO buffers -----------------------------------------------------------
static mut RESULT: [u8; 1 << 20] = [0; 1 << 20]; // 1MB result (value previews + logs)
static mut RESULT_LEN: usize = 0;
static mut HOSTCALL: [u8; 1 << 16] = [0; 1 << 16];
static mut HOSTCALL_LEN: usize = 0;
static mut SCRATCH: [u8; 1 << 20] = [0; 1 << 20]; // 1MB cell source / resume payload
static mut KV_OUT: [u8; 1 << 18] = [0; 1 << 18];
static mut KV_OUT_LEN: usize = 0;
static mut BOOT_ERR: [u8; 4096] = [0; 4096];
static mut BOOT_ERR_LEN: usize = 0;

#[no_mangle]
pub extern "C" fn boot_err_ptr() -> *const u8 {
    core::ptr::addr_of!(BOOT_ERR) as *const u8
}
#[no_mangle]
pub extern "C" fn boot_err_len() -> usize {
    unsafe { BOOT_ERR_LEN }
}

fn set_result(s: &str) {
    let b = s.as_bytes();
    let n = b.len().min(1 << 20);
    unsafe {
        let p = core::ptr::addr_of_mut!(RESULT) as *mut u8;
        core::ptr::copy_nonoverlapping(b.as_ptr(), p, n);
        RESULT_LEN = n;
    }
}
fn set_hostcall(s: &str) {
    let b = s.as_bytes();
    let n = b.len().min(1 << 16);
    unsafe {
        let p = core::ptr::addr_of_mut!(HOSTCALL) as *mut u8;
        core::ptr::copy_nonoverlapping(b.as_ptr(), p, n);
        HOSTCALL_LEN = n;
    }
}

#[no_mangle]
pub extern "C" fn scratch_ptr() -> *const u8 {
    core::ptr::addr_of!(SCRATCH) as *const u8
}
#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    core::ptr::addr_of!(RESULT) as *const u8
}
#[no_mangle]
pub extern "C" fn result_len() -> usize {
    unsafe { RESULT_LEN }
}
#[no_mangle]
pub extern "C" fn pending_host_call_ptr() -> *const u8 {
    core::ptr::addr_of!(HOSTCALL) as *const u8
}
#[no_mangle]
pub extern "C" fn pending_host_call_len() -> usize {
    unsafe { HOSTCALL_LEN }
}

// ---- determinism ----------------------------------------------------------
fn lcg(state: u64) -> u64 {
    state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407)
}

fn cur_pages() -> u32 {
    core::arch::wasm32::memory_size(0) as u32
}

// In-VM JS bootstrap (the irreducible floor): seeded Date/Math traps + the
// util.inspect-style preview formatter + the `host` Proxy that marshals host
// effects out to Rust via __hostCall.
const BOOTSTRAP: &str = r#"
try { Object.defineProperty(Date, 'now', { value: globalThis.__now, writable: true, configurable: true }); } catch(e){ try { Date.now = globalThis.__now; } catch(e2){} }
try { Object.defineProperty(Math, 'random', { value: globalThis.__rand, writable: true, configurable: true }); } catch(e){ try { Math.random = globalThis.__rand; } catch(e2){} }
// seeded performance.now (monotone, ms) reuses the clock tick
try { if (typeof performance === 'undefined') { globalThis.performance = {}; } performance.now = function(){ return globalThis.__now(); }; } catch(e){}

// seeded crypto shim: nanoid/uuid call crypto.getRandomValues. Route through the seeded
// __rand so seeded sessions stay byte-reproducible across restore. randomUUID is v4-shaped.
try {
  if (typeof globalThis.crypto === 'undefined') { globalThis.crypto = {}; }
  globalThis.crypto.getRandomValues = function(arr){
    for (var i=0;i<arr.length;i++){ arr[i] = (globalThis.__rand()*256) & 0xff; }
    return arr;
  };
  globalThis.crypto.randomUUID = function(){
    var b = new Uint8Array(16); globalThis.crypto.getRandomValues(b);
    b[6]=(b[6]&0x0f)|0x40; b[8]=(b[8]&0x3f)|0x80;
    var h=[]; for(var i=0;i<16;i++){ h.push((b[i]+0x100).toString(16).slice(1)); }
    return h[0]+h[1]+h[2]+h[3]+'-'+h[4]+h[5]+'-'+h[6]+h[7]+'-'+h[8]+h[9]+'-'+h[10]+h[11]+h[12]+h[13]+h[14]+h[15];
  };
} catch(e){}

// console capture -> __logs (drained per cell by Rust via __drainLogs)
globalThis.__logs = [];
const __fmt = (a) => (typeof a === 'string' ? a : globalThis.__preview(a, 2));
globalThis.console = {
  log:   (...a)=>{ globalThis.__logs.push({level:'log',   msg:a.map(__fmt).join(' ')}); },
  error: (...a)=>{ globalThis.__logs.push({level:'error', msg:a.map(__fmt).join(' ')}); },
  warn:  (...a)=>{ globalThis.__logs.push({level:'warn',  msg:a.map(__fmt).join(' ')}); },
  info:  (...a)=>{ globalThis.__logs.push({level:'info',  msg:a.map(__fmt).join(' ')}); },
  debug: (...a)=>{ globalThis.__logs.push({level:'debug', msg:a.map(__fmt).join(' ')}); },
};
globalThis.__drainLogs = function(){ const l = globalThis.__logs; globalThis.__logs = []; return JSON.stringify(l); };

// host Proxy: every host.<name>(...args) becomes a host-effect call dispatched to
// Rust (__hostCall), which parks the request and returns a Promise resolved by the
// shim on resume. fetch + kv are the wired effects.
globalThis.host = new Proxy({}, {
  get(_t, name){
    if (typeof name !== 'string') return undefined;
    return function(...args){
      // park the request in Rust, then hand back a promise the shim settles on resume.
      globalThis.__hostCall(name, JSON.stringify(args));
      return new Promise((res,rej)=>{
        globalThis.__settleHost = (ok, val) => { ok ? res(val) : rej(new Error(val)); };
      });
    };
  }
});

// util.inspect-style preview. Renders Map/Set/Date/RegExp/Symbol/Promise/Error/
// typed arrays/Array/Object correctly — NOT JSON.stringify(x)=>"{}" (the FAFO bug).
globalThis.__preview = function(v, depth){
  depth = (depth === undefined) ? 2 : depth;
  const seen = new WeakSet();
  function q(s){ return '"' + String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n') + '"'; }
  function go(v, d){
    const t = typeof v;
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return String(v)+'n';
    if (t === 'string') return q(v);
    if (t === 'symbol') return v.toString();
    if (t === 'function') return (v.name ? '[Function: '+v.name+']' : '[Function (anonymous)]');
    if (typeof v === 'object'){
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      try {
        if (v instanceof Date) return v.toISOString();
        if (v instanceof RegExp) return v.toString();
        if (v instanceof Error) return (v.name||'Error')+': '+(v.message||'');
        if (typeof Promise !== 'undefined' && v instanceof Promise) return 'Promise { <pending> }';
        if (typeof Map !== 'undefined' && v instanceof Map){
          if (d < 0) return 'Map('+v.size+')';
          const parts=[]; let i=0; for (const [k,val] of v){ if(i++>=100){parts.push('...');break;} parts.push(go(k,d-1)+' => '+go(val,d-1)); }
          return 'Map('+v.size+') {'+(parts.length?' '+parts.join(', ')+' ':'')+'}';
        }
        if (typeof Set !== 'undefined' && v instanceof Set){
          if (d < 0) return 'Set('+v.size+')';
          const parts=[]; let i=0; for (const val of v){ if(i++>=100){parts.push('...');break;} parts.push(go(val,d-1)); }
          return 'Set('+v.size+') {'+(parts.length?' '+parts.join(', ')+' ':'')+'}';
        }
        if (ArrayBuffer.isView(v) && !(v instanceof DataView)){
          const a=Array.prototype.slice.call(v,0,100).map(String);
          return v[Symbol.toStringTag]+'('+v.length+') ['+a.join(', ')+(v.length>100?', ...':'')+']';
        }
        if (Array.isArray(v)){
          if (d < 0) return '[Array]';
          const parts=v.slice(0,100).map(x=>go(x,d-1)); if(v.length>100)parts.push('...'+(v.length-100)+' more');
          return '['+parts.join(', ')+']';
        }
        if (d < 0) return '[Object]';
        const ctor = (v.constructor && v.constructor.name && v.constructor.name!=='Object') ? v.constructor.name+' ' : '';
        const keys=Object.keys(v).slice(0,100);
        const parts=keys.map(k=>k+': '+go(v[k],d-1)); if(Object.keys(v).length>100)parts.push('...');
        return ctor+'{'+(parts.length?' '+parts.join(', ')+' ':'')+'}';
      } catch(e){ return '[unserializable]'; }
    }
    return String(v);
  }
  try { return go(v, depth); } catch(e){ return '[preview-error]'; }
};

// classify a value into a coarse valueType tag (for the eval-result frame).
globalThis.__valueType = function(v){
  if (v === null) return 'null';
  const t = typeof v;
  if (t !== 'object' && t !== 'function') return t;
  if (t === 'function') return 'function';
  if (v instanceof Error) return 'error';
  if (v instanceof Date) return 'date';
  if (v instanceof RegExp) return 'regexp';
  if (typeof Map!=='undefined' && v instanceof Map) return 'map';
  if (typeof Set!=='undefined' && v instanceof Set) return 'set';
  if (typeof Promise!=='undefined' && v instanceof Promise) return 'promise';
  if (Array.isArray(v)) return 'array';
  return 'object';
};
"#;

fn inject_host_fns(ctx: &Ctx) {
    let g = ctx.globals();
    let now = Function::new(ctx.clone(), || -> f64 {
        CLOCK.with(|c| {
            let t = c.get();
            c.set(t + 1);
            CLOCK_CALLS.with(|n| n.set(n.get() + 1));
            // seeded epoch base 1.7e12 + 1ms tick (parity with JS kernel determinism)
            1_700_000_000_000.0 + t as f64
        })
    })
    .unwrap();
    g.set("__now", now).unwrap();

    let rand = Function::new(ctx.clone(), || -> f64 {
        RNG.with(|r| {
            let n = lcg(r.get());
            r.set(n);
            RNG_CALLS.with(|c| c.set(c.get() + 1));
            ((n >> 11) as f64) / ((1u64 << 53) as f64)
        })
    })
    .unwrap();
    g.set("__rand", rand).unwrap();

    // __hostCall(name, argsJson): park the request for the shim. Returns nothing; the
    // host Proxy (in BOOTSTRAP) builds the Promise the shim settles on resume.
    let hostcall = Function::new(ctx.clone(), |name: String, args_json: String| {
        HOSTCALL_REQ.with(|h| {
            *h.borrow_mut() = Some(format!(
                "{{\"name\":{},\"args\":{}}}",
                json_str(&name),
                args_json
            ))
        });
    })
    .unwrap();
    g.set("__hostCall", hostcall).unwrap();
}

fn build_runtime() -> (Runtime, Context) {
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();
    rt.set_memory_limit(64 * 1024 * 1024);
    rt.set_max_stack_size(512 * 1024);
    rt.set_interrupt_handler(Some(Box::new(|| {
        // GUARD 1: instruction budget
        let over_budget = BUDGET.with(|b| {
            let left = b.get() - 1;
            b.set(left);
            left <= 0
        });
        if over_budget {
            TRIPPED.with(|t| t.set(true));
            return true;
        }
        // GUARD 3: BUFFER-GROWTH TRIPWIRE. If the linear memory has grown more than the
        // per-cell cap since eval-begin, abort. This catches the fast-array bomb that beats
        // rquickjs set_memory_limit (native alloc growth with few bytecode interrupts still
        // hits *some* interrupts; the buffer byteLength is the source of truth).
        let cap = GROW_CAP_PAGES.with(|c| c.get());
        if cap > 0 {
            let start = START_PAGES.with(|s| s.get());
            if cur_pages().saturating_sub(start) > cap {
                GROW_TRIPPED.with(|g| g.set(true));
                return true;
            }
        }
        false
    })));
    ctx.with(|ctx| inject_host_fns(&ctx));
    (rt, ctx)
}

fn ensure_ctx() {
    CTX.with(|c| {
        if c.borrow().is_none() {
            *c.borrow_mut() = Some(build_runtime());
        }
    });
}

#[no_mangle]
pub extern "C" fn create(clock_seed: u64, rng_seed: u64) -> i32 {
    CLOCK.with(|c| c.set(clock_seed));
    RNG.with(|r| r.set(if rng_seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { rng_seed }));
    ensure_ctx();
    1
}

#[no_mangle]
pub extern "C" fn reattach() -> i32 {
    CTX.with(|c| if c.borrow().is_some() { 1 } else { 0 })
}

#[no_mangle]
pub extern "C" fn clock_calls() -> i64 {
    CLOCK_CALLS.with(|c| c.get() as i64)
}
#[no_mangle]
pub extern "C" fn rng_calls() -> i64 {
    RNG_CALLS.with(|c| c.get() as i64)
}
#[no_mangle]
pub extern "C" fn set_counters(clock: i64, rng: i64) {
    CLOCK_CALLS.with(|c| c.set(clock as u64));
    RNG_CALLS.with(|c| c.set(rng as u64));
}

#[no_mangle]
pub extern "C" fn used_heap() -> i64 {
    CTX.with(|c| match c.borrow().as_ref() {
        Some((rt, _)) => rt.memory_usage().memory_used_size as i64,
        None => -1,
    })
}
#[no_mangle]
pub extern "C" fn buffer_bytes() -> i64 {
    (cur_pages() as i64) * 65536
}

// W5 (docs/W5-COMPACTION-PLAN.md): run GC, then SCRUB freed dlmalloc slack by allocating
// zero-filled buffers across the freed arena and dropping them, so the monotonic linear
// buffer (which cannot shrink in place) gzips down toward ~nothing on the freed pages.
// `budget_mb` is computed host-side from (bufferBytes - usedHeap) slack, capped so the
// bounded, non-growing scrub itself cannot OOM. Returns the post-scrub used-heap bytes.
#[no_mangle]
pub extern "C" fn scrub_arena(budget_mb: u32) -> i64 {
    ensure_ctx();
    // First GC so freed objects are actually reclaimable as slack.
    CTX.with(|c| {
        if let Some((rt, _)) = c.borrow().as_ref() {
            rt.run_gc();
        }
    });
    if budget_mb >= 1 {
        // Allocate `budget_mb` 1MB zero buffers, drop refs, GC. Disarm the interrupt guard
        // during the scrub (it is host-driven, not a user cell).
        let saved_budget = BUDGET.with(|b| b.get());
        let saved_cap = GROW_CAP_PAGES.with(|c| c.get());
        BUDGET.with(|b| b.set(i64::MAX));
        GROW_CAP_PAGES.with(|c| c.set(0));
        let src = format!(
            "{{let __s=[];try{{for(let __i=0;__i<{};__i++){{__s.push(new Uint8Array(1048576));}}}}catch(__e){{}}__s.length=0;}}0",
            budget_mb
        );
        CTX.with(|c| {
            if let Some((rt, ctx)) = c.borrow().as_ref() {
                ctx.with(|ctx| {
                    let _: rquickjs::Result<Value> = ctx.eval(src.as_str());
                });
                rt.run_gc();
            }
        });
        BUDGET.with(|b| b.set(saved_budget));
        GROW_CAP_PAGES.with(|c| c.set(saved_cap));
    }
    used_heap()
}

// ---- host.kv state export/import (persisted in the snapshot manifest) ------
#[no_mangle]
pub extern "C" fn kv_export_ptr() -> *const u8 {
    let json = KV.with(|kv| {
        let mut o = String::from("{");
        for (i, (k, v)) in kv.borrow().iter().enumerate() {
            if i > 0 {
                o.push(',');
            }
            o.push_str(&json_str(k));
            o.push(':');
            o.push_str(v); // stored value is already raw JSON
        }
        o.push('}');
        o
    });
    let b = json.as_bytes();
    let n = b.len().min(1 << 18);
    unsafe {
        let p = core::ptr::addr_of_mut!(KV_OUT) as *mut u8;
        core::ptr::copy_nonoverlapping(b.as_ptr(), p, n);
        KV_OUT_LEN = n;
        core::ptr::addr_of!(KV_OUT) as *const u8
    }
}
#[no_mangle]
pub extern "C" fn kv_export_len() -> usize {
    unsafe { KV_OUT_LEN }
}
#[no_mangle]
pub extern "C" fn kv_import(ptr: *const u8, len: usize) {
    let s = unsafe { std::slice::from_raw_parts(ptr, len) };
    if let Ok(txt) = std::str::from_utf8(s) {
        // minimal flat {string:string} parse via rquickjs JSON (reuse the VM).
        ensure_ctx();
        CTX.with(|c| {
            if let Some((_, ctx)) = c.borrow().as_ref() {
                ctx.with(|ctx| {
                    let code = format!(
                        "(function(){{var o=JSON.parse({}); var out=[]; for(var k in o){{out.push(k); out.push(JSON.stringify(o[k]));}} return out.join('\\u0000');}})()",
                        json_str(txt)
                    );
                    if let Ok(v) = ctx.eval::<Value, _>(code.as_str()) {
                        if let Some(js) = v.as_string() {
                            if let Ok(flat) = js.to_string() {
                                let parts: Vec<&str> = flat.split('\u{0}').collect();
                                KV.with(|kv| {
                                    let mut m = kv.borrow_mut();
                                    let mut i = 0;
                                    while i + 1 < parts.len() {
                                        m.insert(parts[i].to_string(), parts[i + 1].to_string());
                                        i += 2;
                                    }
                                });
                            }
                        }
                    }
                });
            }
        });
    }
}

const STATUS_DONE: i32 = 0;
const STATUS_HOST_CALL: i32 = 1;

// Apply the bootstrap once, lazily.
fn ensure_wired() {
    if !WIRED.with(|w| w.get()) {
        CTX.with(|c| {
            if let Some((_, ctx)) = c.borrow().as_ref() {
                ctx.with(|ctx| {
                    let r: rquickjs::Result<Value> = ctx.eval(BOOTSTRAP);
                    if r.is_err() {
                        let msg = ctx.catch().as_exception().and_then(|e| e.message()).unwrap_or_else(|| "no-exc".into());
                        let b = msg.as_bytes();
                        let n = b.len().min(4096);
                        unsafe {
                            let p = core::ptr::addr_of_mut!(BOOT_ERR) as *mut u8;
                            core::ptr::copy_nonoverlapping(b.as_ptr(), p, n);
                            BOOT_ERR_LEN = n;
                        }
                    }
                });
            }
        });
        WIRED.with(|w| w.set(true));
    }
}

// Drive microtasks until the cell settles or a host call parks.
// Returns true if a host call got parked (status HOST_CALL).
fn pump_jobs(rt: &Runtime) -> bool {
    let mut guard = 0;
    loop {
        // A host effect may have parked synchronously (before any job ran) or during a job.
        if HOSTCALL_REQ.with(|h| h.borrow().is_some()) {
            return true;
        }
        if !rt.is_job_pending() || guard >= 2_000_000 {
            return false;
        }
        let _ = rt.execute_pending_job();
        guard += 1;
    }
}

// Finalize: build the result JSON from the settled cell globals. All value/preview/
// type/error extraction is done in-VM (one JSON blob) to handle Map/Set/Date/Error
// correctly and avoid host-side marshalling.
fn finalize_cell(ctx: &Ctx) {
    let tripped = TRIPPED.with(|t| t.get());
    // POST-CELL buffer-growth check: a SINGLE huge native alloc (e.g. new Uint8Array(40MB))
    // grows the linear buffer past the per-cell cap WITHOUT looping, so no interrupt fires
    // mid-cell and the interrupt tripwire misses it. Catch it here by comparing the final
    // page count to start+cap. (The buffer is monotonic so it stays grown, but we report a
    // typed recoverable MemoryLimitError, socket alive, next eval works — and the dump-ceiling
    // guard additionally clean-rejects the oversized image at checkpoint.)
    let post_grow = {
        let cap = GROW_CAP_PAGES.with(|c| c.get());
        let start = START_PAGES.with(|s| s.get());
        cap > 0 && cur_pages().saturating_sub(start) > cap
    };
    let grow_tripped = GROW_TRIPPED.with(|g| g.get()) || post_grow;

    if tripped || grow_tripped {
        let logs = drain_logs(ctx);
        let (name, msg) = if grow_tripped {
            ("MemoryLimitError", "cell grew linear memory past the per-cell cap")
        } else {
            ("TimeoutError", "cell exceeded the instruction budget")
        };
        set_result(&format!(
            "{{\"ok\":false,\"valueType\":\"error\",\"logs\":{},\"error\":{{\"name\":{},\"message\":{},\"stack\":\"\"}}}}",
            logs, json_str(name), json_str(msg)
        ));
        return;
    }

    // Build the whole result frame inside the VM, returning a JSON string.
    let frame_js = r#"
      (function(){
        var ok = globalThis.__cellOk;
        var logs = globalThis.__drainLogs();
        if (ok) {
          var v = globalThis.__cellResult;
          var preview = globalThis.__preview(v, 2);
          var vtype = globalThis.__valueType(v);
          var value;
          try { value = (v===undefined) ? null : JSON.parse(JSON.stringify(v)); }
          catch(e){ value = null; }
          return JSON.stringify({ok:true, value:value, valuePreview:preview, valueType:vtype, logs:JSON.parse(logs)});
        } else {
          var e = globalThis.__cellError;
          var name='Error', message=String(e), stack='';
          if (e && typeof e === 'object'){ name = e.name||'Error'; message = e.message!==undefined?String(e.message):String(e); stack = e.stack||''; }
          return JSON.stringify({ok:false, valueType:'error', logs:JSON.parse(logs), error:{name:name, message:message, stack:stack}});
        }
      })()
    "#;
    let res = ctx.eval::<Value, _>(frame_js);
    let frame = match res {
        Ok(v) => v
            .as_string()
            .and_then(|s| s.to_string().ok())
            .unwrap_or_else(|| {
                format!("{{\"FRAME_NOT_STRING\":true,\"isPromise\":{}}}", v.is_promise())
            }),
        Err(_) => {
            let m = ctx
                .catch()
                .as_exception()
                .and_then(|e| e.message())
                .unwrap_or_else(|| "no-exc".into());
            format!("{{\"FRAME_ERR\":{}}}", json_str(&m))
        }
    };
    set_result(&frame);
}

fn drain_logs(ctx: &Ctx) -> String {
    ctx.eval::<Value, _>("globalThis.__drainLogs()")
        .ok()
        .and_then(|v| v.as_string().and_then(|s| s.to_string().ok()))
        .unwrap_or_else(|| "[]".into())
}

// Re-arm the per-cell guard counters at (re)entry into JS execution.
fn arm_guards(budget: i64, grow_cap_pages: u32) {
    BUDGET.with(|b| b.set(budget));
    TRIPPED.with(|t| t.set(false));
    GROW_TRIPPED.with(|g| g.set(false));
    START_PAGES.with(|s| s.set(cur_pages()));
    GROW_CAP_PAGES.with(|c| c.set(grow_cap_pages));
}

#[no_mangle]
pub extern "C" fn eval_begin(src_ptr: *const u8, src_len: usize, budget: i64, grow_cap_pages: u32) -> i32 {
    ensure_ctx();
    arm_guards(budget, grow_cap_pages);
    ensure_wired();
    HOSTCALL_REQ.with(|h| *h.borrow_mut() = None);
    HOSTCALL_RES.with(|h| *h.borrow_mut() = None);

    let src = unsafe { std::slice::from_raw_parts(src_ptr, src_len) };
    let src = match std::str::from_utf8(src) {
        Ok(s) => s.to_string(),
        Err(_) => {
            set_result(r#"{"ok":false,"valueType":"error","logs":[],"error":{"name":"Error","message":"invalid-utf8","stack":""}}"#);
            return STATUS_DONE;
        }
    };
    // Wrap the cell so its completion value is captured into __cellResult and any
    // throw into __cellError, regardless of sync/async. We eval the wrapped form,
    // then drive the resulting promise to settlement (pumping host calls along the
    // way). This makes `await host.fetch()` cells work with one value-capture path.
    install_cell(&src);
    run(false)
}

#[no_mangle]
pub extern "C" fn eval_resume(res_ptr: *const u8, res_len: usize) -> i32 {
    let s = unsafe { std::slice::from_raw_parts(res_ptr, res_len) };
    let payload = std::str::from_utf8(s).unwrap_or("{}").to_string();
    HOSTCALL_RES.with(|h| *h.borrow_mut() = Some(payload));
    // re-arm budget for the continuation but keep counting buffer growth from start.
    BUDGET.with(|b| b.set(b.get().max(100_000)));
    run(true)
}

// Wrap the cell source so its completion settles into __cellDone with a captured
// value/error. An async function lets `await host.fetch()` work uniformly: a sync
// cell's last-expression value is returned; a thrown error rejects.
fn install_cell(src: &str) {
    CTX.with(|c| {
        if let Some((_, ctx)) = c.borrow().as_ref() {
            ctx.with(|ctx| {
                // The cell body is appended as the function body; we transform it so the
                // LAST expression's value is the return value (REPL semantics). We do the
                // simplest robust thing: eval the source via indirect eval inside an async
                // fn, capturing its completion value (works for expression cells); for
                // statement cells the completion value is undefined, which is correct.
                g_set(&ctx, "__cellSrc", src);
                // REPL semantics with async support: try to compile the source as the
                // RETURN of an async function (expression cell, supports top-level await);
                // if that fails to compile (statement/declaration cell), fall back to using
                // it as the async function BODY (declarations land in the cell's scope; but
                // we want them GLOBAL, so the body form runs via indirect global eval which
                // does NOT allow await — covered by the expression form for await cells).
                // `__mkCell` returns the async fn or null on compile failure.
                let driver = r#"
                  globalThis.__cellDone = false;
                  globalThis.__cellOk = true;
                  globalThis.__cellResult = undefined;
                  globalThis.__cellError = null;
                  (function(){
                    var AsyncFn = (async function(){}).constructor;
                    var fn = null, mode = 'global';
                    // (1) Expression form: `return (src)` — supports await, returns the value.
                    try { fn = new AsyncFn("return (\n" + globalThis.__cellSrc + "\n);"); mode = 'expr'; }
                    catch(e) { fn = null; }
                    // (2) Multi-statement cell that USES await: compile as an async function BODY
                    // (top-level await works inside it). Declarations are function-scoped, so the
                    // REPL persistence contract is `globalThis.x = ...` (matches the host surface).
                    if (!fn && /\bawait\b/.test(globalThis.__cellSrc)) {
                      try { fn = new AsyncFn(globalThis.__cellSrc); mode = 'asyncbody'; }
                      catch(e) { fn = null; }
                    }
                    (async function(){
                      try {
                        var r;
                        if (fn) {
                          r = await fn.call(globalThis);
                        } else {
                          // (3) Statement/declaration cell (no await): eval in GLOBAL scope so
                          // `let x`, `function f(){}`, `globalThis.x=` persist.
                          r = await (0, eval)(globalThis.__cellSrc);
                        }
                        globalThis.__cellResult = r;
                        globalThis.__cellOk = true;
                      } catch(e) {
                        globalThis.__cellError = e;
                        globalThis.__cellOk = false;
                      } finally {
                        globalThis.__cellDone = true;
                      }
                    })();
                  })();
                "#;
                let _: rquickjs::Result<Value> = ctx.eval(driver);
            });
        }
    });
}

fn g_set(ctx: &Ctx, key: &str, val: &str) {
    let g = ctx.globals();
    if let Ok(s) = rquickjs::String::from_str(ctx.clone(), val) {
        let _ = g.set(key, s);
    }
}

// Core driver shared by begin/resume. Pumps microtasks; if a host call parks, returns
// STATUS_HOST_CALL; when the cell promise settles (__cellDone), finalizes and returns DONE.
fn run(resume: bool) -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (rt, ctx) = b.as_ref().unwrap();

        if resume {
            // settle the parked host promise with the shim's result.
            let payload = HOSTCALL_RES.with(|h| h.borrow().clone().unwrap_or_else(|| "{}".into()));
            HOSTCALL_REQ.with(|h| *h.borrow_mut() = None);
            let code = format!(
                r#"(function(){{var p={}; if(globalThis.__settleHost){{var f=globalThis.__settleHost; globalThis.__settleHost=null; f(p.ok, p.ok?p.value:(p.error||'host error'));}}}})()"#,
                payload
            );
            ctx.with(|ctx| {
                let _: rquickjs::Result<Value> = ctx.eval(code.as_str());
            });
        }

        // drain microtasks; a parked host call interrupts the pump.
        let parked = pump_jobs(rt);
        if parked {
            return emit_hostcall();
        }

        // If a guard TRIPPED mid-cell, the async cell-driver's continuation (and any chained
        // reactions) may be left pending in the job queue. If they persist into the snapshot,
        // resuming them on cold-restore re-trips/loops (the bomb-then-restore hang). DISARM the
        // guards and bounded-drain the queue so the snapshot is clean. (Budget is huge during the
        // drain, so a freed/aborted continuation runs to completion and is discarded.)
        let tripped = TRIPPED.with(|t| t.get()) || GROW_TRIPPED.with(|g| g.get());
        if tripped {
            BUDGET.with(|b| b.set(i64::MAX));
            GROW_CAP_PAGES.with(|g| g.set(0));
            let mut guard = 0;
            while rt.is_job_pending() && guard < 200_000 {
                let _ = rt.execute_pending_job();
                guard += 1;
            }
        }

        // The cell promise should now be settled (no pending host call, jobs drained).
        // If for some reason it is not done and not parked, finalize as undefined.
        ctx.with(|ctx| finalize_cell(&ctx));
        STATUS_DONE
    })
}

fn emit_hostcall() -> i32 {
    let req = HOSTCALL_REQ.with(|h| h.borrow().clone().unwrap_or_else(|| "{}".into()));
    // intercept host.kv locally (no shim round-trip needed): handle get/set/keys/del.
    if let Some(local) = try_local_kv(&req) {
        HOSTCALL_RES.with(|h| *h.borrow_mut() = Some(local));
        HOSTCALL_REQ.with(|h| *h.borrow_mut() = None);
        return run(true);
    }
    set_hostcall(&req);
    STATUS_HOST_CALL
}

// host.kv is handled IN the engine (small, persisted). Returns Some(resultPayload) if
// the call was a kv op; None if it must go to the shim (e.g. fetch).
fn try_local_kv(req: &str) -> Option<String> {
    let v: serde_lite::Value = serde_lite::parse(req)?;
    let name = v.get_str("name")?;
    let args = v.get_arr("args")?;
    let op: &str = match name {
        "kv" => args.get(0).and_then(|x| x.as_str()).unwrap_or(""),
        // also support host.kvGet / host.kvSet ergonomic names
        n if n.starts_with("kv") => &n[2..],
        _ => return None,
    };
    let r = match op {
        "get" | "Get" => {
            let k = args.get(if name == "kv" { 1 } else { 0 }).and_then(|x| x.as_str()).unwrap_or("");
            // stored values are raw JSON; return them as-is (no double-encoding).
            KV.with(|kv| kv.borrow().get(k).cloned())
                .map(|v| format!("{{\"ok\":true,\"value\":{}}}", v))
                .unwrap_or_else(|| "{\"ok\":true,\"value\":null}".into())
        }
        "set" | "Set" => {
            let base = if name == "kv" { 1 } else { 0 };
            let k = args.get(base).and_then(|x| x.as_str()).unwrap_or("").to_string();
            let val = args.get(base + 1).map(|x| x.raw()).unwrap_or_else(|| "null".into());
            KV.with(|kv| kv.borrow_mut().insert(k, val));
            "{\"ok\":true,\"value\":true}".into()
        }
        "keys" | "Keys" => {
            let ks = KV.with(|kv| {
                kv.borrow().keys().map(|k| json_str(k)).collect::<Vec<_>>().join(",")
            });
            format!("{{\"ok\":true,\"value\":[{}]}}", ks)
        }
        "del" | "Del" | "delete" => {
            let k = args.get(if name == "kv" { 1 } else { 0 }).and_then(|x| x.as_str()).unwrap_or("");
            KV.with(|kv| kv.borrow_mut().remove(k));
            "{\"ok\":true,\"value\":true}".into()
        }
        _ => return None,
    };
    Some(r)
}

// ---- tiny helpers ----------------------------------------------------------
fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

// ---- ultra-minimal JSON value reader for host-call requests ----------------
// (avoids pulling serde_json into the wasip1 engine to keep size down)
mod serde_lite {
    pub struct Value {
        raw: String,
    }
    pub struct Arr {
        items: Vec<Item>,
    }
    pub struct Item {
        raw: String,
    }
    impl Item {
        pub fn as_str(&self) -> Option<&str> {
            let t = self.raw.trim();
            if t.starts_with('"') && t.ends_with('"') && t.len() >= 2 {
                Some(&t[1..t.len() - 1])
            } else {
                None
            }
        }
        pub fn raw(&self) -> String {
            self.raw.clone()
        }
    }
    impl Arr {
        pub fn get(&self, i: usize) -> Option<&Item> {
            self.items.get(i)
        }
    }
    impl Value {
        pub fn get_str(&self, key: &str) -> Option<&str> {
            let pat = format!("\"{}\":", key);
            let idx = self.raw.find(&pat)? + pat.len();
            let rest = self.raw[idx..].trim_start();
            if !rest.starts_with('"') {
                return None;
            }
            let rest = &rest[1..];
            let end = rest.find('"')?;
            Some(&rest[..end])
        }
        pub fn get_arr(&self, key: &str) -> Option<Arr> {
            let pat = format!("\"{}\":", key);
            let idx = self.raw.find(&pat)? + pat.len();
            let rest = self.raw[idx..].trim_start();
            if !rest.starts_with('[') {
                return None;
            }
            // split top-level array items (string-aware, depth-aware)
            let bytes = rest.as_bytes();
            let mut depth = 0i32;
            let mut in_str = false;
            let mut esc = false;
            let mut start = 1usize;
            let mut items = Vec::new();
            let mut i = 1usize;
            while i < bytes.len() {
                let c = bytes[i] as char;
                if in_str {
                    if esc {
                        esc = false;
                    } else if c == '\\' {
                        esc = true;
                    } else if c == '"' {
                        in_str = false;
                    }
                } else {
                    match c {
                        '"' => in_str = true,
                        '[' | '{' => depth += 1,
                        ']' | '}' => {
                            if c == ']' && depth == 0 {
                                let item = rest[start..i].trim();
                                if !item.is_empty() {
                                    items.push(Item { raw: item.to_string() });
                                }
                                return Some(Arr { items });
                            }
                            depth -= 1;
                        }
                        ',' if depth == 0 => {
                            let item = rest[start..i].trim();
                            if !item.is_empty() {
                                items.push(Item { raw: item.to_string() });
                            }
                            start = i + 1;
                        }
                        _ => {}
                    }
                }
                i += 1;
            }
            Some(Arr { items })
        }
    }
    pub fn parse(s: &str) -> Option<Value> {
        Some(Value { raw: s.to_string() })
    }
}
