//! EXP-4b — Rust DO + nested-WASM memory access spike.
//!
//! Question (feasibility risk #3 / open Q #1): can a workers-rs RUST Durable
//! Object host read/write a nested QuickJS wasm instance's linear memory + exported
//! globals to snapshot it? Spike BOTH paths and report which works:
//!
//!   (a) PURE RUST host: Rust instantiates the nested QuickJS wasm via js-sys
//!       (driving the JS `WebAssembly` API — the only wasm host available on
//!       workerd; there is no wasmtime/wasmer there) and reaches its
//!       `memory.buffer` + `__stack_pointer` Global *from Rust*. We write a
//!       sentinel into the nested linear memory from Rust, dump memory+global,
//!       drop the instance, restore into a FRESH instance, and read the sentinel
//!       back — proving all-Rust read / write / snapshot / restore of nested wasm
//!       state across a (simulated) eviction.
//!
//!   (b) RUST DO shell + thin JS glue (quickjs-wasi, the EXP-5a approach) doing
//!       the actual QuickJS eval + memory dump. Real `x=42` + closure namespace.
//!
//! Both paths share ONE Rust DO that persists a SQLite generation counter, holds
//! a hibernatable WebSocket, and stores snapshots in R2.

use js_sys::{Function, Object, Reflect, Uint8Array, WebAssembly};
use serde_json::json;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use worker::{
    durable_object, event, wasm_bindgen, wasm_bindgen_futures, DurableObject, Env, Request,
    Response, Result, State, WebSocket, WebSocketIncomingMessage, WebSocketPair,
    WebSocketRequestResponsePair,
};

// ---- bindings into src/glue.js ----
#[wasm_bindgen(module = "/src/glue.js")]
extern "C" {
    // Path (a): the precompiled QuickJS WebAssembly.Module (CompiledWasm import).
    #[wasm_bindgen(js_name = getQuickjsModule)]
    fn get_quickjs_module() -> WebAssembly::Module;

    // Path (b): JS-glue quickjs-wasi driver.
    type GlueKernel;
    #[wasm_bindgen(js_name = newGlueKernel)]
    fn new_glue_kernel() -> GlueKernel;
    #[wasm_bindgen(method, js_name = ensure)]
    fn ensure(this: &GlueKernel, gz_or_null: JsValue) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = evalCode)]
    fn eval_code(this: &GlueKernel, src: &str) -> JsValue;
    #[wasm_bindgen(method, js_name = dump)]
    fn dump(this: &GlueKernel) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = drop)]
    fn drop_kernel(this: &GlueKernel);
}

// =====================================================================
// PATH (a) — pure-Rust nested-wasm instantiation + memory/global access.
// =====================================================================

/// A nested QuickJS instance instantiated and driven entirely from Rust.
struct RustNested {
    memory: WebAssembly::Memory,
    stack_pointer: WebAssembly::Global,
}

/// Build the 12 imports the QuickJS wasm needs, as Rust closures. We are NOT
/// driving a full JS_Eval here (that needs the whole C-ABI marshalling shim — the
/// real cost of "all-Rust"); we only need the module to instantiate and run
/// `_initialize`, then prove Rust can read+write its memory + globals. So the host
/// imports are minimal stubs (they are not called during pure init / our sentinel
/// poke). They exist only to satisfy the import object so instantiation succeeds.
fn build_imports() -> std::result::Result<Object, JsValue> {
    let noop = Closure::<dyn Fn() -> i32>::new(|| 0i32);
    let noop_fn: &Function = noop.as_ref().unchecked_ref();

    let env_ns = Object::new();
    for name in [
        "host_get_timezone_offset",
        "host_interrupt",
        "host_promise_rejection",
        "host_module_normalize",
        "host_module_load",
        "host_call",
    ] {
        Reflect::set(&env_ns, &JsValue::from_str(name), noop_fn)?;
    }

    let wasi_ns = Object::new();
    for name in [
        "clock_time_get",
        "fd_close",
        "fd_fdstat_get",
        "fd_seek",
        "fd_write",
        "random_get",
    ] {
        Reflect::set(&wasi_ns, &JsValue::from_str(name), noop_fn)?;
    }

    let imports = Object::new();
    Reflect::set(&imports, &JsValue::from_str("env"), &env_ns)?;
    Reflect::set(
        &imports,
        &JsValue::from_str("wasi_snapshot_preview1"),
        &wasi_ns,
    )?;

    // Leak the closure so it stays alive for the instance lifetime (spike-scope).
    noop.forget();
    Ok(imports)
}

impl RustNested {
    /// Instantiate the precompiled QuickJS module from Rust and grab its exported
    /// Memory + __stack_pointer Global. All via js-sys.
    fn instantiate() -> std::result::Result<Self, JsValue> {
        let module = get_quickjs_module();
        let imports = build_imports()?;
        let instance = WebAssembly::Instance::new(&module, &imports)?;
        let exports = instance.exports();

        let memory: WebAssembly::Memory = Reflect::get(&exports, &JsValue::from_str("memory"))?
            .dyn_into()
            .map_err(|_| JsValue::from_str("export `memory` is not a WebAssembly.Memory"))?;
        let stack_pointer: WebAssembly::Global =
            Reflect::get(&exports, &JsValue::from_str("__stack_pointer"))?
                .dyn_into()
                .map_err(|_| {
                    JsValue::from_str("export `__stack_pointer` is not a WebAssembly.Global")
                })?;

        // Run _initialize so the QuickJS runtime sets itself up in linear memory.
        if let Ok(init) = Reflect::get(&exports, &JsValue::from_str("_initialize")) {
            if let Ok(f) = init.dyn_into::<Function>() {
                let _ = f.call0(&JsValue::NULL);
            }
        }

        Ok(Self {
            memory,
            stack_pointer,
        })
    }

    fn mem_len(&self) -> u32 {
        Uint8Array::new(&self.memory.buffer()).length()
    }

    /// Read the entire nested linear memory into a Rust Vec<u8> — proves Rust can
    /// READ nested wasm memory.
    fn read_memory(&self) -> Vec<u8> {
        let view = Uint8Array::new(&self.memory.buffer());
        let mut out = vec![0u8; view.length() as usize];
        view.copy_to(&mut out);
        out
    }

    /// Write a sentinel into nested linear memory at `offset` — proves Rust can
    /// WRITE nested wasm memory. We pick a high offset well inside the initial
    /// memory but away from the active stack/heap to avoid corrupting init state.
    fn poke(&self, offset: u32, bytes: &[u8]) {
        let view = Uint8Array::new(&self.memory.buffer());
        view.subarray(offset, offset + bytes.len() as u32)
            .copy_from(bytes);
    }

    fn peek(&self, offset: u32, len: u32) -> Vec<u8> {
        let view = Uint8Array::new(&self.memory.buffer());
        let mut out = vec![0u8; len as usize];
        view.subarray(offset, offset + len).copy_to(&mut out);
        out
    }

    /// Read the mutable __stack_pointer global — proves Rust can read exported globals.
    fn read_stack_pointer(&self) -> i32 {
        self.stack_pointer.value().as_f64().unwrap_or(f64::NAN) as i32
    }

    /// Write the __stack_pointer global — proves Rust can write exported globals.
    fn write_stack_pointer(&self, v: i32) {
        self.stack_pointer.set_value(&JsValue::from_f64(v as f64));
    }

    /// Blit a full memory image back into a (fresh) instance's linear memory.
    fn restore_memory(&self, bytes: &[u8]) {
        let view = Uint8Array::new(&self.memory.buffer());
        // image must match current memory size (same module => same initial pages)
        let n = view.length().min(bytes.len() as u32);
        view.subarray(0, n).copy_from(&bytes[..n as usize]);
    }
}

/// PATH (a) end-to-end, entirely from Rust:
///   instantiate -> poke sentinel + set stack_pointer -> read full memory image ->
///   DROP instance (simulated eviction) -> instantiate FRESH -> blit image back +
///   restore stack_pointer -> read sentinel + stack_pointer back.
/// Returns a JSON value describing each step + the verdict.
fn run_path_a() -> std::result::Result<serde_json::Value, JsValue> {
    const SENTINEL_OFFSET: u32 = 900_000; // well inside the >1MB initial memory
    let sentinel: [u8; 16] = *b"MONTYDYN-EXP4B-A";
    let sp_marker: i32 = 0x0042_4242;

    // --- live instance ---
    let a = RustNested::instantiate()?;
    let mem_len = a.mem_len();
    let sp_initial = a.read_stack_pointer();

    a.poke(SENTINEL_OFFSET, &sentinel);
    a.write_stack_pointer(sp_marker);

    let sp_after_write = a.read_stack_pointer();
    let sentinel_live = a.peek(SENTINEL_OFFSET, 16);

    // Snapshot = full memory image + the mutable global (read from Rust).
    let image = a.read_memory();
    let image_len = image.len();
    let saved_sp = a.read_stack_pointer();

    // --- simulated eviction: drop the instance entirely ---
    drop(a);

    // --- fresh instance + restore from the Rust-held image ---
    let b = RustNested::instantiate()?;
    b.restore_memory(&image);
    b.write_stack_pointer(saved_sp);

    let sentinel_restored = b.peek(SENTINEL_OFFSET, 16);
    let sp_restored = b.read_stack_pointer();

    let sentinel_ok = sentinel_restored == sentinel.to_vec();
    let sp_ok = sp_restored == sp_marker;
    let pass = sentinel_live == sentinel.to_vec() && sentinel_ok && sp_ok;

    Ok(json!({
        "path": "a-pure-rust",
        "memBytes": mem_len,
        "imageBytes": image_len,
        "spInitial": sp_initial,
        "spAfterWrite": sp_after_write,
        "spMarkerWanted": sp_marker,
        "spRestored": sp_restored,
        "sentinelLiveOk": sentinel_live == sentinel.to_vec(),
        "sentinelRestoredOk": sentinel_ok,
        "stackPointerRestoredOk": sp_ok,
        "pass": pass,
        "note": "Rust instantiated nested QuickJS wasm via js-sys, read+wrote its \
                 linear memory and __stack_pointer global, dumped a full image, \
                 dropped the instance, restored into a fresh instance, and read \
                 the sentinel + global back — all from Rust."
    }))
}

// =====================================================================
// Durable Object — shared shell for both paths.
// =====================================================================

#[durable_object]
pub struct KernelDO {
    state: State,
    env: Env,
    generation: i64,
    do_id: String,
    // Interior mutability: the workers-rs DurableObject trait methods take &self.
    glue: RefCell<Option<GlueKernel>>,
}

impl DurableObject for KernelDO {
    fn new(state: State, env: Env) -> Self {
        let sql = state.storage().sql();
        sql.exec(
            "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);",
            None,
        )
        .expect("create meta");

        // Bump the generation counter on every (re)hydration — hard evidence of
        // how many times this DO was constructed (i.e. evictions/cold wakes).
        #[derive(serde::Deserialize)]
        struct Row {
            v: String,
        }
        let rows: Vec<Row> = sql
            .exec("SELECT v FROM meta WHERE k='generation' LIMIT 1;", None)
            .expect("read gen")
            .to_array()
            .expect("rows");
        let cur: i64 = rows.first().and_then(|r| r.v.parse().ok()).unwrap_or(0);
        let generation = cur + 1;
        sql.exec("DELETE FROM meta WHERE k='generation';", None).ok();
        sql.exec(
            "INSERT INTO meta(k,v) VALUES('generation',?);",
            vec![generation.to_string().into()],
        )
        .expect("write gen");

        let do_id = state.id().to_string();

        Self {
            state,
            env,
            generation,
            do_id,
            glue: RefCell::new(None),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        // HTTP path-a probe (no websocket needed) — runs the pure-Rust spike.
        if url.path().ends_with("/path-a") {
            return match run_path_a() {
                Ok(v) => Response::from_json(&json!({"ok": true, "result": v,
                    "generation": self.generation})),
                Err(e) => Response::from_json(&json!({"ok": false,
                    "error": format!("{:?}", e), "generation": self.generation})),
            };
        }

        // WebSocket upgrade for the interactive (path-b + path-a) client.
        if req.headers().get("Upgrade")?.as_deref() == Some("websocket") {
            let pair = WebSocketPair::new()?;
            let server = pair.server;
            self.state.accept_web_socket(&server);
            // Auto ping/pong so idle pings don't wake user code (hibernation).
            if let Ok(rp) = WebSocketRequestResponsePair::new("ping", "pong") {
                self.state.set_websocket_auto_response(&rp);
            }
            return Response::from_websocket(pair.client);
        }

        Response::ok("montydyn-exp4b: /path-a (pure-Rust) or websocket\n")
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        let raw = match message {
            WebSocketIncomingMessage::String(s) => s,
            WebSocketIncomingMessage::Binary(_) => {
                ws.send_with_str("{\"ok\":false,\"error\":\"binary unsupported\"}")?;
                return Ok(());
            }
        };
        let reply = match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(msg) => self
                .handle(msg)
                .await
                .unwrap_or_else(|e| json!({"ok": false, "error": format!("{e}")})),
            Err(_) => json!({"ok": false, "error": "bad json"}),
        };
        ws.send_with_str(&serde_json::to_string(&reply).unwrap())?;
        Ok(())
    }

    async fn websocket_close(
        &self,
        _ws: WebSocket,
        _code: usize,
        _reason: String,
        _clean: bool,
    ) -> Result<()> {
        Ok(())
    }
}

impl KernelDO {
    fn r2_key(&self) -> String {
        format!("exp4b/{}.qjs.gz", self.do_id)
    }

    async fn handle(&self, msg: serde_json::Value) -> Result<serde_json::Value> {
        let t = msg.get("t").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "gen" => Ok(json!({
                "ok": true, "t": "gen",
                "generation": self.generation,
                "glueKernelPresent": self.glue.borrow().is_some(),
            })),

            // ---- PATH (a): pure-Rust nested memory access ----
            "path-a" => match run_path_a() {
                Ok(v) => Ok(json!({"ok": true, "t": "path-a", "result": v,
                    "generation": self.generation})),
                Err(e) => Ok(json!({"ok": false, "t": "path-a",
                    "error": format!("{:?}", e), "generation": self.generation})),
            },

            // ---- PATH (b): Rust shell + JS glue does the eval ----
            "eval" => {
                let before = self.glue.borrow().is_some();
                let src = msg.get("src").and_then(|v| v.as_str()).unwrap_or("");
                let source = self.ensure_glue().await?;
                let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
                let val = glue.eval_code(src);
                let val_json = jsvalue_to_json(&val);
                Ok(json!({
                    "ok": true, "t": "eval", "value": val_json,
                    "generation": self.generation,
                    "glueKernelPresentBefore": before,
                    "restoreSource": source,
                }))
            }

            "snapshot" => {
                self.ensure_glue().await?;
                let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
                let dump = JsFuture::from(glue.dump()).await.map_err(to_err)?;
                let gz: Uint8Array =
                    Reflect::get(&dump, &JsValue::from_str("gz")).map_err(to_err)?.into();
                let size_raw = num_field(&dump, "sizeRaw");
                let size_gz = num_field(&dump, "sizeGz");
                let stack_pointer = num_field(&dump, "stackPointer");

                let mut bytes = vec![0u8; gz.length() as usize];
                gz.copy_to(&mut bytes);
                let bucket = self.env.bucket("SNAPSHOTS")?;
                bucket.put(&self.r2_key(), bytes).execute().await?;

                Ok(json!({
                    "ok": true, "t": "snapshot",
                    "key": self.r2_key(),
                    "sizeRaw": size_raw, "sizeGz": size_gz,
                    "stackPointer": stack_pointer,
                    "generation": self.generation,
                }))
            }

            // Drop the in-memory glue kernel to simulate eviction deterministically.
            "evict" => {
                let taken = self.glue.borrow_mut().take();
                let had = taken.is_some();
                if let Some(g) = taken {
                    g.drop_kernel();
                }
                Ok(json!({
                    "ok": true, "t": "evict",
                    "droppedGlueKernel": had,
                    "generation": self.generation,
                }))
            }

            other => Ok(json!({"ok": false, "error": format!("unknown msg type {other}")})),
        }
    }

    /// Ensure a path-(b) JS-glue kernel exists; restore from R2 if a snapshot exists.
    async fn ensure_glue(&self) -> Result<String> {
        if self.glue.borrow().is_some() {
            return Ok("warm".into());
        }
        let bucket = self.env.bucket("SNAPSHOTS")?;
        let obj = bucket.get(&self.r2_key()).execute().await?;
        let gz_arg: JsValue = if let Some(o) = obj {
            if let Some(body) = o.body() {
                let bytes = body.bytes().await?;
                let arr = Uint8Array::new_with_length(bytes.len() as u32);
                arr.copy_from(&bytes);
                arr.into()
            } else {
                JsValue::NULL
            }
        } else {
            JsValue::NULL
        };

        let glue = new_glue_kernel();
        let src = JsFuture::from(glue.ensure(gz_arg)).await.map_err(to_err)?;
        *self.glue.borrow_mut() = Some(glue);
        Ok(src.as_string().unwrap_or_else(|| "?".into()))
    }
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    let url = req.url()?;
    if url.path() == "/health" {
        return Response::ok("ok");
    }
    // Route everything else to a named DO instance (session id via ?id=).
    let session = url
        .query_pairs()
        .find(|(k, _)| k == "id")
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| "default".into());
    let ns = env.durable_object("KERNEL_DO")?;
    let stub = ns.id_from_name(&session)?.get_stub()?;
    stub.fetch_with_request(req).await
}

// ---- small helpers ----
/// GlueKernel (a wasm-bindgen extern type) is just a JS handle; clone by cloning
/// the underlying JsValue and re-casting. Cheap (a reference, not a deep copy).
fn clone_glue(g: &GlueKernel) -> GlueKernel {
    let v: &JsValue = g.as_ref();
    v.clone().unchecked_into()
}

fn to_err(e: JsValue) -> worker::Error {
    worker::Error::RustError(format!("{:?}", e))
}

fn num_field(obj: &JsValue, k: &str) -> Option<f64> {
    Reflect::get(obj, &JsValue::from_str(k))
        .ok()
        .and_then(|v| v.as_f64())
}

fn jsvalue_to_json(v: &JsValue) -> serde_json::Value {
    if let Some(n) = v.as_f64() {
        return json!(n);
    }
    if let Some(s) = v.as_string() {
        return json!(s);
    }
    if v.is_null() || v.is_undefined() {
        return serde_json::Value::Null;
    }
    json!(format!("{:?}", v))
}
