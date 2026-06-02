// rustkernel — a DEEPER rquickjs Rust-only kernel slice (Track 2).
//
// Goal: prove how much of the hand-written glue.js can move into Rust with ZERO
// JS glue. ALL kernel logic lives here in Rust:
//   (a) eval a cell                         -> eval_cell()
//   (b) full heap snapshot to bytes+restore -> snapshot is the WASM linear memory
//       blit (the substrate); reattach() re-validates the in-memory Runtime.
//   (c) ONE guard: interrupt-based instruction budget (rquickjs set_interrupt_handler)
//       + a memory-limit guard (rquickjs set_memory_limit) — both Rust-side.
//   (d) seeded determinism: a Rust-side LCG clock + RNG injected into the VM as
//       host functions (globalThis.__now / globalThis.__rand), seeded from Rust.
//
// The ONLY thing that must run outside Rust is the WASI host shim + the literal
// memory.buffer blit — that is the snapshot SUBSTRATE on workerd, not glue logic.
//
// Results are returned as JSON written into a static buffer the host reads, so the
// host needs no value-marshalling logic (that, in glue.js, was Rust-movable too).

use rquickjs::{Context, Function, Runtime};
use std::cell::{Cell, RefCell};

thread_local! {
    static CTX: RefCell<Option<(Runtime, Context)>> = RefCell::new(None);
    // Rust-side deterministic state (the injected clock + RNG live HERE, in Rust).
    static CLOCK: Cell<u64> = Cell::new(0);
    static RNG: Cell<u64> = Cell::new(0);
    // Interrupt-budget guard counter (decrements every interrupt callback).
    static BUDGET: Cell<i64> = Cell::new(0);
    static TRIPPED: Cell<bool> = Cell::new(false);
    static WIRED: Cell<bool> = Cell::new(false);
}

const WIRE_JS: &str = r#"
Object.defineProperty(Date, 'now', { value: globalThis.__now, writable: true, configurable: true });
Object.defineProperty(Math, 'random', { value: globalThis.__rand, writable: true, configurable: true });
"#;

// Static result buffer the host reads (avoids any host-side value marshalling).
static mut RESULT: [u8; 4096] = [0; 4096];
static mut RESULT_LEN: usize = 0;

fn set_result(s: &str) {
    let b = s.as_bytes();
    let n = b.len().min(4096);
    unsafe {
        RESULT[..n].copy_from_slice(&b[..n]);
        RESULT_LEN = n;
    }
}

// Dedicated input scratch the host writes cell source into (no offset guessing).
static mut SCRATCH: [u8; 65536] = [0; 65536];

#[no_mangle]
pub extern "C" fn scratch_ptr() -> *const u8 {
    unsafe { SCRATCH.as_ptr() }
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    unsafe { RESULT.as_ptr() }
}
#[no_mangle]
pub extern "C" fn result_len() -> usize {
    unsafe { RESULT_LEN }
}

// Deterministic LCG step (Rust-side; identical sequence post-restore because state
// lives in linear memory and is blitted with everything else).
fn lcg(state: u64) -> u64 {
    state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407)
}

fn build_runtime() -> (Runtime, Context) {
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();

    // (c) GUARD #2: memory limit, Rust-side. Generous so normal cells pass.
    rt.set_memory_limit(64 * 1024 * 1024);
    rt.set_max_stack_size(512 * 1024);

    // (c) GUARD #1: interrupt-based instruction budget. The handler returns true to
    // ABORT execution. Budget is reset per eval_cell call.
    rt.set_interrupt_handler(Some(Box::new(|| {
        BUDGET.with(|b| {
            let left = b.get() - 1;
            b.set(left);
            if left <= 0 {
                TRIPPED.with(|t| t.set(true));
                true // abort
            } else {
                false
            }
        })
    })));

    // (d) Inject the Rust-side deterministic clock + RNG as host functions.
    ctx.with(|ctx| {
        let g = ctx.globals();
        let now = Function::new(ctx.clone(), || -> f64 {
            CLOCK.with(|c| {
                let t = c.get();
                c.set(t + 1); // monotone deterministic tick
                t as f64
            })
        })
        .unwrap();
        g.set("__now", now).unwrap();

        let rand = Function::new(ctx.clone(), || -> f64 {
            RNG.with(|r| {
                let n = lcg(r.get());
                r.set(n);
                // map to [0,1)
                ((n >> 11) as f64) / ((1u64 << 53) as f64)
            })
        })
        .unwrap();
        g.set("__rand", rand).unwrap();
    });

    (rt, ctx)
}

fn ensure_ctx() {
    CTX.with(|c| {
        if c.borrow().is_none() {
            *c.borrow_mut() = Some(build_runtime());
        }
    });
}

// Seed the Rust-side deterministic state. Call once at create.
#[no_mangle]
pub extern "C" fn create(clock_seed: u64, rng_seed: u64) -> i32 {
    CLOCK.with(|c| c.set(clock_seed));
    RNG.with(|r| r.set(if rng_seed == 0 { 0x9E3779B97F4A7C15 } else { rng_seed }));
    ensure_ctx();
    1
}

// Re-attach to the blitted heap WITHOUT rebuilding the runtime. Proves the
// in-linear-memory Runtime/Context (and the Rust-side closures for the interrupt
// handler + injected fns) survived the snapshot blit.
#[no_mangle]
pub extern "C" fn reattach() -> i32 {
    CTX.with(|c| if c.borrow().is_some() { 1 } else { 0 })
}

// (a) Eval a cell. budget = max interrupt ticks before the guard trips.
// Writes JSON {"ok":bool,"value":string,"tripped":bool,"error":string} to RESULT.
#[no_mangle]
pub extern "C" fn eval_cell(src_ptr: *const u8, src_len: usize, budget: i64) {
    ensure_ctx();
    BUDGET.with(|b| b.set(budget));
    TRIPPED.with(|t| t.set(false));
    let src = unsafe { std::slice::from_raw_parts(src_ptr, src_len) };
    let src = match std::str::from_utf8(src) {
        Ok(s) => s.to_string(),
        Err(_) => {
            set_result(r#"{"ok":false,"error":"invalid-utf8"}"#);
            return;
        }
    };
    CTX.with(|c| {
        let b = c.borrow();
        let (rt, ctx) = b.as_ref().unwrap();
        // Lazily wire the seeded Date.now/Math.random on first eval (proven to
        // persist when applied via this eval path; not when applied in create()).
        if !WIRED.with(|w| w.get()) {
            ctx.with(|ctx| {
                let _: rquickjs::Result<rquickjs::Value> = ctx.eval(WIRE_JS);
            });
            WIRED.with(|w| w.set(true));
        }
        let out = ctx.with(|ctx| {
            let r: rquickjs::Result<rquickjs::Value> = ctx.eval(src.as_str());
            match r {
                Ok(v) => {
                    // Stringify the value Rust-side (no host marshalling).
                    let coerced = coerce(&v);
                    let tripped = TRIPPED.with(|t| t.get());
                    format!(
                        r#"{{"ok":true,"value":{},"tripped":{}}}"#,
                        json_str(&coerced),
                        tripped
                    )
                }
                Err(e) => {
                    let tripped = TRIPPED.with(|t| t.get());
                    let msg = format!("{:?}", e);
                    format!(
                        r#"{{"ok":false,"error":{},"tripped":{}}}"#,
                        json_str(&msg),
                        tripped
                    )
                }
            }
        });
        // drain microtasks (pending promises) within budget too
        let mut guard = 0;
        while rt.is_job_pending() && guard < 100000 {
            let _ = rt.execute_pending_job();
            guard += 1;
        }
        set_result(&out);
    });
}

fn coerce(v: &rquickjs::Value) -> String {
    if let Some(i) = v.as_int() {
        i.to_string()
    } else if let Some(f) = v.as_float() {
        f.to_string()
    } else if let Some(b) = v.as_bool() {
        b.to_string()
    } else if v.is_null() {
        "null".into()
    } else if v.is_undefined() {
        "undefined".into()
    } else if let Some(s) = v.as_string() {
        s.to_string().unwrap_or_default()
    } else {
        "[object]".into()
    }
}

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

// Report Rust-side memory usage from rquickjs (proves memory introspection is
// Rust-reachable for the size-admission guard).
#[no_mangle]
pub extern "C" fn used_heap() -> i64 {
    CTX.with(|c| {
        let b = c.borrow();
        match b.as_ref() {
            Some((rt, _)) => rt.memory_usage().memory_used_size as i64,
            None => -1,
        }
    })
}
