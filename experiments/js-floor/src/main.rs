// TRACK 3 proof: shrink the irreducible hand-written-JS floor toward ZERO by doing
// the seeded clock/RNG override and the host boundary from RUST via rquickjs global
// injection (Rust closures bound as JS globals), instead of an eval-ed REBIND_SRC string.
//
// Claims under test:
//  (a) Rust closure bound as a JS global is callable from JS.
//  (b) Date.now / Math.random can be OVERRIDDEN to call Rust closures WITHOUT eval-ing
//      a JS string (use the Object/Function reflection API from Rust: get globalThis.Date,
//      set its `now` property to a Rust Function).
//  (c) A host function (e.g. host.kv.get) can be bound as a Rust closure.
//
// Entropy state (clock/rng counters) lives in Rust (Rc<Cell>) -> OUTSIDE the wasm JS heap,
// exactly like the current design keeps counters outside wasm.

use rquickjs::{Context, Function, Object, Runtime, Value};
use std::cell::Cell;
use std::rc::Rc;

const EPOCH_MS: f64 = 1_700_000_000_000.0;

fn main() {
    let rt = Runtime::new().unwrap();
    let ctx = Context::full(&rt).unwrap();

    // Seeded entropy state in RUST, outside the JS heap.
    let clock_calls = Rc::new(Cell::new(0u64));
    let rng_state = Rc::new(Cell::new(0x12345678u32));

    let mut all_ok = true;

    ctx.with(|ctx| {
        let g = ctx.globals();

        // --- (a) bind a plain Rust closure as a global function ---
        let cc = clock_calls.clone();
        let host_now = Function::new(ctx.clone(), move || -> f64 {
            let n = cc.get();
            cc.set(n + 1);
            EPOCH_MS + n as f64
        })
        .unwrap();
        g.set("__hostNowMs", host_now).unwrap();

        let rs = rng_state.clone();
        let host_rand = Function::new(ctx.clone(), move || -> f64 {
            // mulberry32, state in Rust
            let mut s = rs.get();
            s = s.wrapping_add(0x6d2b79f5);
            rs.set(s);
            let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
            t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
            ((t ^ (t >> 14)) as f64) / 4294967296.0
        })
        .unwrap();
        g.set("__hostRandom", host_rand).unwrap();

        // --- (b) OVERRIDE Date.now and Math.random FROM RUST, no eval string ---
        // Reach globalThis.Date / globalThis.Math as Objects, set .now / .random to the
        // Rust-backed globals we just bound. Pure reflection, zero hand-written JS.
        let date_obj: Object = g.get("Date").unwrap();
        let host_now2: Function = g.get("__hostNowMs").unwrap();
        date_obj.set("now", host_now2).unwrap();

        let math_obj: Object = g.get("Math").unwrap();
        let host_rand2: Function = g.get("__hostRandom").unwrap();
        math_obj.set("random", host_rand2).unwrap();

        // --- (c) bind a host function (host.kv.get) as a Rust closure ---
        // Build the `host` namespace object entirely from Rust (no proxy JS string).
        let host = Object::new(ctx.clone()).unwrap();
        let kv = Object::new(ctx.clone()).unwrap();
        let kv_get = Function::new(ctx.clone(), move |key: String| -> String {
            format!("value-for:{}", key) // stand-in for a real __hostCall dispatch
        })
        .unwrap();
        kv.set("get", kv_get).unwrap();
        host.set("kv", kv).unwrap();
        g.set("host", host).unwrap();

        // ---- VERIFY purely via JS evaluation of USER-style expressions ----
        // These eval strings are USER code analogues, NOT kernel glue.
        let now1: f64 = ctx.eval("Date.now()").unwrap();
        let now2: f64 = ctx.eval("Date.now()").unwrap();
        println!("(b) Date.now() override -> {} then {} (delta {})", now1, now2, now2 - now1);
        if !((now1 - EPOCH_MS).abs() < 0.5 && (now2 - now1 - 1.0).abs() < 0.5) {
            all_ok = false;
            println!("   FAIL: Date.now not seeded/monotonic from Rust");
        }

        let r1: f64 = ctx.eval("Math.random()").unwrap();
        let r2: f64 = ctx.eval("Math.random()").unwrap();
        println!("(b) Math.random override -> {} then {}", r1, r2);
        // determinism: re-seed Rust state and confirm reproducible
        rng_state.set(0x12345678u32);
        let r1b: f64 = ctx.eval("Math.random()").unwrap();
        println!("(b) Math.random re-seeded -> {} (matches first? {})", r1b, (r1b - r1).abs() < 1e-12);
        if (r1b - r1).abs() >= 1e-12 || r1 == r2 {
            all_ok = false;
            println!("   FAIL: Math.random not deterministic/seeded from Rust");
        }

        let kvres: String = ctx.eval("host.kv.get('alpha')").unwrap();
        println!("(c) host.kv.get('alpha') -> {}", kvres);
        if kvres != "value-for:alpha" {
            all_ok = false;
            println!("   FAIL: host.kv.get not bound from Rust");
        }

        // (a) direct global call
        let direct: f64 = ctx.eval("__hostRandom()").unwrap();
        let _ = direct;

        // Confirm there is NO eval-ed kernel JS string: every binding above was created
        // with Function::new / Object::new + .set() from Rust. The only eval()s are the
        // USER-style verification expressions.
        let typ: String = ctx.eval("typeof host.kv.get").unwrap();
        let typ2: String = ctx.eval("typeof Date.now").unwrap();
        let _: Value = ctx.eval("undefined").unwrap();
        println!("typeof host.kv.get={}, typeof Date.now={}", typ, typ2);
    });

    println!("\nALL_OK={}", all_ok);
    std::process::exit(if all_ok { 0 } else { 1 });
}
