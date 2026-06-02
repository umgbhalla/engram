// Rust-driven QuickJS (rquickjs) live-heap snapshot probe.
// Reactor model: host calls setup(), then later calls poke()/read_global() on a
// FRESH instance whose linear memory was blitted from the snapshot of the first.
//
// We keep the Runtime+Context in thread-locals. The crux: a restored instance has
// the SAME linear-memory bytes, so the QuickJS heap (closures, the pending promise,
// globals) is byte-identical. But the Rust-side Runtime/Context structs (which hold
// raw pointers into that heap) ALSO live in linear memory via our thread_local, so
// they must come back valid too -- IF thread_local storage is in linear memory and
// we re-enter without re-running setup.

use rquickjs::{Context, Runtime};
use std::cell::RefCell;

thread_local! {
    static CTX: RefCell<Option<(Runtime, Context)>> = RefCell::new(None);
}

const SETUP_JS: &str = r#"
    // global var
    globalThis.x = 42;
    // closure capturing private state
    let _n = 100;
    globalThis.inc = function() { _n += 1; return _n; };
    // pending promise that resolves to 7 (never awaited yet)
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

// Returns 1 on success.
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

// Re-attach to the existing heap WITHOUT re-running setup. This is what a restored
// instance calls: the Runtime/Context must already exist in the blitted memory.
// If the thread_local survived the blit, this is a no-op ensure.
#[no_mangle]
pub extern "C" fn reattach() -> i32 {
    CTX.with(|c| if c.borrow().is_some() { 1 } else { 0 })
}

// Call globalThis.inc() and return its value (proves closure private state survived).
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

// Read globalThis.x (proves global var survived).
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

// Resolve the pending promise, run the job queue, read pResult (proves pending
// promise survived and can still resolve after restore).
#[no_mangle]
pub extern "C" fn resolve_promise() -> i32 {
    CTX.with(|c| {
        let b = c.borrow();
        let (rt, ctx) = match b.as_ref() { Some(v) => v, None => return -999 };
        let val = ctx.with(|ctx| {
            let _: rquickjs::Result<rquickjs::Value> = ctx.eval("globalThis._resolveP()");
        });
        let _ = val;
        // drain microtasks
        while rt.is_job_pending() { let _ = rt.execute_pending_job(); }
        ctx.with(|ctx| {
            let r: rquickjs::Result<i32> = ctx.eval("globalThis.pResult");
            r.unwrap_or(-998)
        })
    })
}
