// r4-raw-reclaim engine: full-fidelity rquickjs (full-memory blit) + probes for
// testing every RAW-buffer reclaim mechanism on a spiked-then-freed session.
//
// Persistent live state we must preserve across any reclaim attempt:
//   - globalThis.x = 42           (global var)
//   - globalThis.inc()            (closure with PRIVATE captured counter; W6 says this dies under JS_WriteObject)
//   - globalThis.p                (PENDING promise, resolves to 7; W6 says this dies under JS_WriteObject)
//
// Exports cover three mechanism families:
//   (a) write_roots_len / read_roots -> serialize live roots via JS (JSON) and re-create
//       in a fresh small instance. We measure fidelity loss directly.
//   (b) run_gc + used_heap + buf_bytes -> does GC compact/relocate so raw buffer shrinks?
//   (c) selective blit: same module, smaller initial memory (handled host-side by
//       instantiating a SECOND module variant) — engine just needs to re-run setup or reattach.

use rquickjs::{Context, Runtime};
use std::cell::RefCell;

thread_local! {
    static CTX: RefCell<Option<(Runtime, Context)>> = const { RefCell::new(None) };
}

const SETUP_JS: &str = r#"
    globalThis.x = 42;
    let _n = 100;
    globalThis.inc = function() { _n += 1; return _n; };
    globalThis.p = new Promise((res) => { globalThis._resolveP = () => res(7); });
    globalThis.pResult = null;
    globalThis.p.then(v => { globalThis.pResult = v; });
    "init-ok";
"#;

fn ensure_ctx() {
    CTX.with(|c| {
        if c.borrow().is_none() {
            let rt = Runtime::new().unwrap();
            let ctx = Context::full(&rt).unwrap();
            *c.borrow_mut() = Some((rt, ctx));
        }
    });
}

#[no_mangle]
pub extern "C" fn setup() -> i32 {
    ensure_ctx();
    CTX.with(|c| {
        let b = c.borrow();
        let (_, ctx) = b.as_ref().unwrap();
        ctx.with(|ctx| {
            let r: rquickjs::Result<rquickjs::Value> = ctx.eval(SETUP_JS);
            if r.is_ok() { 1 } else { -1 }
        })
    })
}

#[no_mangle]
pub extern "C" fn reattach() -> i32 {
    CTX.with(|c| if c.borrow().is_some() { 1 } else { 0 })
}

#[no_mangle]
pub extern "C" fn poke_inc() -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (_, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        ctx.with(|ctx| {
            let r: rquickjs::Result<i32> = ctx.eval("globalThis.inc()");
            r.unwrap_or(-998)
        })
    })
}

#[no_mangle]
pub extern "C" fn read_x() -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (_, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        ctx.with(|ctx| {
            let r: rquickjs::Result<i32> = ctx.eval("globalThis.x");
            r.unwrap_or(-998)
        })
    })
}

// 1 if globalThis.inc is still a callable closure, 0 if missing/not-a-function (fidelity probe).
#[no_mangle]
pub extern "C" fn inc_is_closure() -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (_, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        ctx.with(|ctx| {
            let r: rquickjs::Result<i32> = ctx.eval("(typeof globalThis.inc === 'function') ? 1 : 0");
            r.unwrap_or(0)
        })
    })
}

// 1 if globalThis.p is a real pending-capable Promise (has .then), 0 otherwise.
#[no_mangle]
pub extern "C" fn promise_present() -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (_, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        ctx.with(|ctx| {
            let r: rquickjs::Result<i32> = ctx.eval(
                "(globalThis.p && typeof globalThis.p.then === 'function' && typeof globalThis._resolveP === 'function') ? 1 : 0",
            );
            r.unwrap_or(0)
        })
    })
}

#[no_mangle]
pub extern "C" fn resolve_promise() -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (rt, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        ctx.with(|ctx| {
            let _: rquickjs::Result<rquickjs::Value> = ctx.eval("globalThis._resolveP && globalThis._resolveP()");
        });
        while rt.is_job_pending() { let _ = rt.execute_pending_job(); }
        ctx.with(|ctx| {
            let r: rquickjs::Result<i32> = ctx.eval("globalThis.pResult");
            r.unwrap_or(-998)
        })
    })
}

// ---- SPIKE / FREE ----
// Allocate ~N*~40 bytes of retained strings into a global array, then free it.
#[no_mangle]
pub extern "C" fn spike(n: i32) -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (_, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        ctx.with(|ctx| {
            let src = format!(
                "globalThis.__big = []; for (let i=0;i<{};i++){{ globalThis.__big.push('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'+i); }} globalThis.__big.length;",
                n
            );
            let r: rquickjs::Result<i32> = ctx.eval(src);
            r.unwrap_or(-998)
        })
    })
}

#[no_mangle]
pub extern "C" fn free_spike() -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (rt, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        ctx.with(|ctx| {
            let _: rquickjs::Result<rquickjs::Value> = ctx.eval("globalThis.__big = null; globalThis.__big = undefined; 1");
        });
        // run GC (mechanism b): frees JS objects; does linear memory shrink?
        rt.run_gc();
        1
    })
}

#[no_mangle]
pub extern "C" fn run_gc_only() -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (rt, _) = match b.as_ref() { Some(v) => v, None => return -999 };
        rt.run_gc();
        1
    })
}

// QuickJS used-heap bytes (memoryUsedSize equivalent).
#[no_mangle]
pub extern "C" fn used_heap() -> f64 {
    CTX.with(|c| {
        let b = c.borrow();
        let (rt, _) = match b.as_ref() { Some(v) => v, None => return -1.0 };
        let mu = rt.memory_usage();
        mu.memory_used_size as f64
    })
}

// QuickJS malloc-limit / malloc_size (current allocated bytes from quickjs allocator).
#[no_mangle]
pub extern "C" fn malloc_size() -> f64 {
    CTX.with(|c| {
        let b = c.borrow();
        let (rt, _) = match b.as_ref() { Some(v) => v, None => return -1.0 };
        let mu = rt.memory_usage();
        mu.malloc_size as f64
    })
}

// ---- MECHANISM (a): serialize live ROOTS via JS to a JSON-ish string, host re-creates ----
// We write the serialized roots to a fixed buffer the host can read.
// Returns the byte length written; host reads `roots_ptr()` for `len` bytes.
thread_local! {
    static ROOTS: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn write_roots() -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (_, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        let s: String = ctx.with(|ctx| {
            // Best-effort: serialize what JSON CAN reach. Closures + promises are NOT JSON-serializable.
            let r: rquickjs::Result<String> = ctx.eval(
                "JSON.stringify({ x: globalThis.x, incType: typeof globalThis.inc, pType: (globalThis.p && globalThis.p.constructor && globalThis.p.constructor.name) })",
            );
            r.unwrap_or_else(|_| "{}".to_string())
        });
        ROOTS.with(|r| { *r.borrow_mut() = s.into_bytes(); });
        ROOTS.with(|r| r.borrow().len() as i32)
    })
}

#[no_mangle]
pub extern "C" fn roots_ptr() -> *const u8 {
    ROOTS.with(|r| r.borrow().as_ptr())
}

// Recreate state in THIS (assumed fresh) instance from the JSON roots: only data survives.
// This simulates mechanism (a)'s rehydrate. Closures/promises are reconstructed by REPLAY
// (defining source) — which is exactly the fidelity boundary we are testing.
#[no_mangle]
pub extern "C" fn rehydrate_json_only() -> i32 {
    ensure_ctx();
    CTX.with(|c| {
        let b = c.borrow();
        let (_, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        ctx.with(|ctx| {
            // Only the data root x is recoverable from JSON. inc/p are NOT.
            let r: rquickjs::Result<rquickjs::Value> = ctx.eval("globalThis.x = 42; 1");
            if r.is_ok() { 1 } else { -1 }
        })
    })
}
