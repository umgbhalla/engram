//! engram RUST KERNEL — durable hibernating rquickjs REPL on a Rust DurableObject.
//!
//! Architecture (chosen): Rust DurableObject shell (workers-rs, wasm32-unknown-unknown)
//! + the rquickjs ENGINE compiled to wasm32-wasip1, imported as CompiledWasm and driven
//! through a THIN JS WASI shim (src/kernel-glue.mjs). ALL kernel business logic lives in
//! Rust: the engine wasm (eval/preview/guards/determinism/host-boundary) + this DO shell
//! (protocol/SQL/snapshot store). The JS shim has NO business logic — only WASI imports,
//! the memory.buffer blit (snapshot substrate), gzip, and the host.fetch implementation.
//!
//! This mirrors how the JS kernel imports quickjs.wasm, except the "glue logic" is now
//! Rust-in-wasm instead of 2000 lines of hand-written glue.js.
//!
//! Protocol over WS/HTTP (JSON), parity with engram-kernel:
//!   {t:create,config} {t:eval,src} {t:ping} {t:gen} {t:reset} {t:evict} + /health

use js_sys::{Reflect, Uint8Array};
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

#[wasm_bindgen(module = "/src/kernel-glue.mjs")]
extern "C" {
    type GlueKernel;
    #[wasm_bindgen(js_name = newGlueKernel)]
    fn new_glue_kernel() -> GlueKernel;
    #[wasm_bindgen(method, js_name = createFresh)]
    fn create_fresh(this: &GlueKernel, config_json: &str) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = restore)]
    fn restore(
        this: &GlueKernel,
        gz: Uint8Array,
        engine_hash: &str,
        clock_calls: f64,
        rng_calls: f64,
        config_json: &str,
        label: &str,
        kv_json: &str,
        used_heap: f64,
        ctx_json: &str,
    ) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = lastRestoreTimings)]
    fn last_restore_timings(this: &GlueKernel) -> String;
    #[wasm_bindgen(method, js_name = evalCode)]
    fn eval_code(this: &GlueKernel, src: &str) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = dump)]
    fn dump(this: &GlueKernel) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = drop)]
    fn drop_kernel(this: &GlueKernel);

    #[wasm_bindgen(js_name = getEngineHash)]
    fn get_engine_hash() -> String;

    type Mutex;
    #[wasm_bindgen(js_name = newMutex)]
    fn new_mutex() -> Mutex;
    #[wasm_bindgen(method, js_name = acquire)]
    fn acquire(this: &Mutex) -> js_sys::Promise;
}

const CHUNK_BYTES: usize = 64 * 1024;
const SQLITE_HOT_MAX: usize = 2 * 1024 * 1024;

#[durable_object]
pub struct KernelDO {
    state: State,
    env: Env,
    generation: i64,
    do_id: String,
    glue: RefCell<Option<GlueKernel>>,
    mutex: Mutex,
}

impl DurableObject for KernelDO {
    fn new(state: State, env: Env) -> Self {
        let sql = state.storage().sql();
        sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);", None)
            .expect("create meta");
        sql.exec(
            "CREATE TABLE IF NOT EXISTS snap_manifest (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                cell INTEGER, epoch INTEGER, n_chunks INTEGER,
                size_raw INTEGER, size_gz INTEGER, engine_hash TEXT,
                clock_calls INTEGER, rng_calls INTEGER,
                store TEXT, r2_key TEXT, created_ms INTEGER,
                kv_json TEXT, used_heap INTEGER
            );",
            None,
        )
        .expect("create snap_manifest");
        sql.exec(
            "CREATE TABLE IF NOT EXISTS snap_chunks (seq INTEGER PRIMARY KEY, data BLOB);",
            None,
        )
        .expect("create snap_chunks");

        let cur = read_int(&sql, "generation", 0);
        let generation = cur + 1;
        write_meta(&sql, "generation", &generation.to_string());
        let do_id = state.id().to_string();

        Self {
            state,
            env,
            generation,
            do_id,
            glue: RefCell::new(None),
            mutex: new_mutex(),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        if req.headers().get("Upgrade")?.as_deref() == Some("websocket") {
            let pair = WebSocketPair::new()?;
            let server = pair.server;
            self.state.accept_web_socket(&server);
            if let Ok(rp) = WebSocketRequestResponsePair::new("ping", "pong") {
                self.state.set_websocket_auto_response(&rp);
            }
            return Response::from_websocket(pair.client);
        }
        Response::ok("engram-rust kernel: connect a websocket; {t:create|eval|reset|gen|ping|evict}\n")
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
    fn r2_key_for(&self, cell: i64, epoch: i64) -> String {
        format!("benchrust/{}/e{}-c{}.qjs.gz", self.do_id, epoch, cell)
    }

    async fn handle(&self, msg: serde_json::Value) -> Result<serde_json::Value> {
        let t = msg.get("t").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "gen" => {
                let sql = self.state.storage().sql();
                Ok(json!({
                    "ok": true, "t": "gen",
                    "generation": self.generation,
                    "inMemory": self.glue.borrow().is_some(),
                    "epoch": read_int(&sql, "epoch", 0),
                    "committedCell": read_int(&sql, "committedCell", -1),
                    "engineHash": get_engine_hash(),
                    "version": "rust-v0.9.3",
                }))
            }
            "ping" => Ok(json!({
                "ok": true, "t": "ping",
                "inMemory": self.glue.borrow().is_some(),
                "generation": self.generation,
            })),
            "create" => {
                let release = JsFuture::from(self.mutex.acquire()).await.map_err(to_err)?;
                let res = self.create_critical(&msg).await;
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                res
            }
            "eval" => {
                let release = JsFuture::from(self.mutex.acquire()).await.map_err(to_err)?;
                let res = self.eval_critical(&msg).await;
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                res
            }
            "reset" => {
                let release = JsFuture::from(self.mutex.acquire()).await.map_err(to_err)?;
                let res = self.reset_critical().await;
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                res
            }
            "evict" => {
                let taken = self.glue.borrow_mut().take();
                let had = taken.is_some();
                if let Some(g) = taken {
                    g.drop_kernel();
                }
                Ok(json!({"ok": true, "t": "evict", "droppedInMemory": had,
                    "generation": self.generation}))
            }
            "health" => Ok(json!({"ok": true, "t": "health", "generation": self.generation})),
            other => Ok(json!({"ok": false, "error": format!("unknown msg type {other}")})),
        }
    }

    async fn create_critical(&self, msg: &serde_json::Value) -> Result<serde_json::Value> {
        let cfg = msg.get("config").cloned().unwrap_or_else(|| json!({}));
        let cfg_str = serde_json::to_string(&cfg).unwrap_or_else(|_| "{}".into());
        let sql = self.state.storage().sql();
        write_meta(&sql, "config", &cfg_str);
        let info = self.ensure_glue().await?;
        Ok(json!({
            "ok": true, "t": "create",
            "config": cfg,
            "generation": self.generation,
            "restoreSource": info.source,
            "restoreTimings": restore_timings_value(&info),
        }))
    }

    async fn eval_critical(&self, msg: &serde_json::Value) -> Result<serde_json::Value> {
        let src = msg.get("src").and_then(|v| v.as_str()).unwrap_or("");
        let before = self.glue.borrow().is_some();

        // first-eval config (only if none yet)
        if !before {
            if let Some(cfg) = msg.get("config") {
                if read_str(&self.state.storage().sql(), "config").is_none() {
                    let cfg_str = serde_json::to_string(cfg).unwrap_or_else(|_| "{}".into());
                    write_meta(&self.state.storage().sql(), "config", &cfg_str);
                }
            }
        }

        let info = self.ensure_glue().await?;

        // eval (async; cell may await host.fetch). Returns rich JSON; never throws.
        let eval_promise = {
            let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
            glue.eval_code(src)
        };
        let eval_json = JsFuture::from(eval_promise)
            .await
            .map_err(to_err)?
            .as_string()
            .unwrap_or_else(|| "{\"ok\":true,\"value\":null}".to_string());
        let parsed: serde_json::Value =
            serde_json::from_str(&eval_json).unwrap_or_else(|_| json!({"ok": true, "value": eval_json}));

        // allocate the next cell inside the critical section, then checkpoint.
        let sql = self.state.storage().sql();
        let cell = read_int(&sql, "committedCell", -1) + 1;
        let epoch = read_int(&sql, "epoch", 0);
        let ckpt = match self.checkpoint(cell, epoch).await {
            Ok(v) => v,
            Err(e) => json!({ "ok": false, "error": format!("{e}") }),
        };
        let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);

        Ok(json!({
            "ok": ok, "t": "eval",
            "value": parsed.get("value").cloned().unwrap_or(serde_json::Value::Null),
            "valuePreview": parsed.get("valuePreview").cloned().unwrap_or(serde_json::Value::Null),
            "valueType": parsed.get("valueType").cloned().unwrap_or(serde_json::Value::Null),
            "logs": parsed.get("logs").cloned().unwrap_or_else(|| json!([])),
            "error": parsed.get("error").cloned().unwrap_or(serde_json::Value::Null),
            "cell": cell,
            "generation": self.generation,
            "inMemoryBefore": before,
            "restoreSource": info.source,
            "restoreTimings": restore_timings_value(&info),
            "checkpoint": ckpt,
        }))
    }

    async fn reset_critical(&self) -> Result<serde_json::Value> {
        let taken = self.glue.borrow_mut().take();
        if let Some(g) = taken {
            g.drop_kernel();
        }
        let r2_key = self.read_manifest().and_then(|m| {
            if m.store == "r2" && !m.r2_key.is_empty() {
                Some(m.r2_key)
            } else {
                None
            }
        });
        let sql = self.state.storage().sql();
        sql.exec("DELETE FROM snap_chunks;", None).ok();
        sql.exec("DELETE FROM snap_manifest;", None).ok();
        if let Ok(bucket) = self.env.bucket("SNAPSHOTS") {
            if let Some(k) = r2_key {
                let _ = bucket.delete(&k).await;
            }
        }
        let epoch = read_int(&sql, "epoch", 0) + 1;
        write_meta(&sql, "epoch", &epoch.to_string());
        write_meta(&sql, "committedCell", "-1");
        Ok(json!({"ok": true, "t": "reset", "epoch": epoch, "generation": self.generation}))
    }

    /// Ensure a live kernel. On a cold wake, restore from the committed checkpoint; else
    /// create a fresh seeded kernel under the persisted config.
    async fn ensure_glue(&self) -> Result<RestoreInfo> {
        if self.glue.borrow().is_some() {
            return Ok(RestoreInfo::warm());
        }
        let t0 = now_ms();
        let glue = new_glue_kernel();
        let cfg_str = read_str(&self.state.storage().sql(), "config").unwrap_or_else(|| "{}".into());
        let mut read_ms = 0.0_f64;
        let mut timings_json = String::from("{}");

        let manifest = self.read_manifest();
        let source = if let Some(m) = manifest {
            let is_r2 = m.store == "r2";
            let gz = if is_r2 {
                let bucket = self.env.bucket("SNAPSHOTS")?;
                let obj = bucket
                    .get(&m.r2_key)
                    .execute()
                    .await?
                    .ok_or_else(|| worker::Error::RustError("r2 overflow missing".into()))?;
                let body = obj
                    .body()
                    .ok_or_else(|| worker::Error::RustError("r2 body missing".into()))?;
                let bytes = body.bytes().await?;
                let arr = Uint8Array::new_with_length(bytes.len() as u32);
                arr.copy_from(&bytes);
                arr
            } else {
                self.read_chunks(m.n_chunks)?
            };
            read_ms = now_ms() - t0;
            let label = if is_r2 { "r2-restore" } else { "sqlite-restore" };
            let src = JsFuture::from(glue.restore(
                gz,
                &m.engine_hash,
                m.clock_calls as f64,
                m.rng_calls as f64,
                &cfg_str,
                label,
                &m.kv_json,
                m.used_heap as f64,
                "{}",
            ))
            .await
            .map_err(to_err)?;
            timings_json = glue.last_restore_timings();
            src.as_string().unwrap_or_else(|| label.into())
        } else {
            let src = JsFuture::from(glue.create_fresh(&cfg_str))
                .await
                .map_err(to_err)?;
            src.as_string().unwrap_or_else(|| "fresh".into())
        };

        let total_server_ms = now_ms() - t0;
        *self.glue.borrow_mut() = Some(glue);
        Ok(RestoreInfo {
            source,
            read_ms,
            total_server_ms,
            timings_json,
        })
    }

    /// Dump the live kernel and persist as the single committed snapshot (crash-atomic
    /// via DO synchronous write-coalescing; R2 swap-then-delete for overflow).
    async fn checkpoint(&self, cell: i64, epoch: i64) -> Result<serde_json::Value> {
        let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
        let dump = JsFuture::from(glue.dump()).await.map_err(to_err)?;
        let gz: Uint8Array = Reflect::get(&dump, &JsValue::from_str("gz")).map_err(to_err)?.into();
        let size_raw = num_field(&dump, "sizeRaw").unwrap_or(0.0) as i64;
        let size_gz = num_field(&dump, "sizeGz").unwrap_or(0.0) as i64;
        let used_heap = num_field(&dump, "usedHeap").unwrap_or(0.0) as i64;
        let clock_calls = num_field(&dump, "clockCalls").unwrap_or(0.0) as i64;
        let rng_calls = num_field(&dump, "rngCalls").unwrap_or(0.0) as i64;
        let kv_json = str_field(&dump, "kvJson").unwrap_or_else(|| "{}".to_string());

        let mut bytes = vec![0u8; gz.length() as usize];
        gz.copy_to(&mut bytes);

        let old_r2_key: Option<String> = self.read_manifest().and_then(|m| {
            if m.store == "r2" && !m.r2_key.is_empty() {
                Some(m.r2_key)
            } else {
                None
            }
        });

        let to_r2 = bytes.len() > SQLITE_HOT_MAX;
        let (store, new_r2_key) = if to_r2 {
            let new_key = self.r2_key_for(cell, epoch);
            let bucket = self.env.bucket("SNAPSHOTS")?;
            bucket.put(&new_key, bytes.clone()).execute().await?;
            ("r2".to_string(), new_key)
        } else {
            ("sqlite".to_string(), String::new())
        };

        // ATOMIC SQL REPLACE — no .await inside (DO write-coalescing => all-or-nothing).
        let sql = self.state.storage().sql();
        let r2_key_for_manifest = new_r2_key.clone();
        let txn = || -> Result<i64> {
            sql.exec("DELETE FROM snap_chunks;", None)?;
            sql.exec("DELETE FROM snap_manifest;", None)?;
            let n_chunks = if to_r2 {
                0i64
            } else {
                let mut seq = 0i64;
                for chunk in bytes.chunks(CHUNK_BYTES) {
                    sql.exec(
                        "INSERT INTO snap_chunks(seq, data) VALUES (?, ?);",
                        vec![seq.into(), chunk.to_vec().into()],
                    )
                    .map_err(|e| worker::Error::RustError(format!("chunk insert: {e:?}")))?;
                    seq += 1;
                }
                seq
            };
            sql.exec(
                "INSERT INTO snap_manifest
                    (id, cell, epoch, n_chunks, size_raw, size_gz, engine_hash,
                     clock_calls, rng_calls, store, r2_key, created_ms, kv_json, used_heap)
                 VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?);",
                vec![
                    cell.into(),
                    epoch.into(),
                    n_chunks.into(),
                    size_raw.into(),
                    size_gz.into(),
                    get_engine_hash().into(),
                    clock_calls.into(),
                    rng_calls.into(),
                    store.clone().into(),
                    r2_key_for_manifest.clone().into(),
                    now_ms().into(),
                    kv_json.clone().into(),
                    used_heap.into(),
                ],
            )
            .map_err(|e| worker::Error::RustError(format!("manifest insert: {e:?}")))?;
            sql.exec(
                "INSERT INTO meta(k,v) VALUES('committedCell',?)
                 ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
                vec![cell.to_string().into()],
            )?;
            Ok(n_chunks)
        };
        let n_chunks = txn()?;

        if let Some(old) = old_r2_key {
            if old != new_r2_key {
                if let Ok(bucket) = self.env.bucket("SNAPSHOTS") {
                    let _ = bucket.delete(&old).await;
                }
            }
        }

        Ok(json!({
            "ok": true, "cell": cell, "store": store, "nChunks": n_chunks,
            "sizeRaw": size_raw, "sizeGz": size_gz, "usedHeap": used_heap,
            "clockCalls": clock_calls, "rngCalls": rng_calls, "r2Key": new_r2_key,
        }))
    }

    fn read_manifest(&self) -> Option<Manifest> {
        let sql = self.state.storage().sql();
        #[derive(serde::Deserialize)]
        struct Row {
            cell: i64,
            epoch: i64,
            n_chunks: i64,
            engine_hash: String,
            clock_calls: i64,
            rng_calls: i64,
            store: String,
            r2_key: String,
            #[serde(default)]
            kv_json: Option<String>,
            #[serde(default)]
            used_heap: Option<i64>,
        }
        let rows: Vec<Row> = sql
            .exec(
                "SELECT cell,epoch,n_chunks,engine_hash,clock_calls,rng_calls,store,r2_key,kv_json,used_heap
                 FROM snap_manifest WHERE id=1 LIMIT 1;",
                None,
            )
            .ok()?
            .to_array()
            .ok()?;
        rows.into_iter().next().map(|r| Manifest {
            cell: r.cell,
            epoch: r.epoch,
            n_chunks: r.n_chunks,
            engine_hash: r.engine_hash,
            clock_calls: r.clock_calls,
            rng_calls: r.rng_calls,
            store: r.store,
            r2_key: r.r2_key,
            kv_json: r.kv_json.unwrap_or_else(|| "{}".into()),
            used_heap: r.used_heap.unwrap_or(0),
        })
    }

    fn read_chunks(&self, n_chunks: i64) -> Result<Uint8Array> {
        let sql = self.state.storage().sql();
        let cursor = sql
            .exec("SELECT data FROM snap_chunks ORDER BY seq ASC;", None)
            .map_err(|e| worker::Error::RustError(format!("read chunks: {e:?}")))?;
        let mut blobs: Vec<Vec<u8>> = Vec::new();
        for row in cursor.raw() {
            let row = row.map_err(|e| worker::Error::RustError(format!("chunk row: {e:?}")))?;
            for val in row {
                if let worker::SqlStorageValue::Blob(b) = val {
                    blobs.push(b);
                }
            }
        }
        if blobs.len() as i64 != n_chunks {
            return Err(worker::Error::RustError(format!(
                "CorruptSnapshotError: chunk count mismatch (manifest={n_chunks}, read {})",
                blobs.len()
            )));
        }
        let total: usize = blobs.iter().map(|b| b.len()).sum();
        let out = Uint8Array::new_with_length(total as u32);
        let mut off = 0u32;
        for b in &blobs {
            let arr = Uint8Array::new_with_length(b.len() as u32);
            arr.copy_from(b);
            out.set(&arr, off);
            off += b.len() as u32;
        }
        Ok(out)
    }
}

struct RestoreInfo {
    source: String,
    read_ms: f64,
    total_server_ms: f64,
    timings_json: String,
}
impl RestoreInfo {
    fn warm() -> Self {
        RestoreInfo {
            source: "warm".into(),
            read_ms: 0.0,
            total_server_ms: 0.0,
            timings_json: "{}".into(),
        }
    }
}

struct Manifest {
    #[allow(dead_code)]
    cell: i64,
    #[allow(dead_code)]
    epoch: i64,
    n_chunks: i64,
    engine_hash: String,
    clock_calls: i64,
    rng_calls: i64,
    store: String,
    r2_key: String,
    kv_json: String,
    used_heap: i64,
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    let url = req.url()?;
    if url.path() == "/health" {
        return Response::ok("ok");
    }
    let session = url
        .query_pairs()
        .find(|(k, _)| k == "id")
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| "default".into());
    let ns = env.durable_object("KERNEL_DO")?;
    let stub = ns.id_from_name(&session)?.get_stub()?;
    stub.fetch_with_request(req).await
}

// ---- helpers ----
fn restore_timings_value(info: &RestoreInfo) -> serde_json::Value {
    let glue: serde_json::Value =
        serde_json::from_str(&info.timings_json).unwrap_or_else(|_| json!({}));
    json!({ "readMs": info.read_ms, "totalServerMs": info.total_server_ms, "glue": glue })
}

fn read_int(sql: &worker::SqlStorage, k: &str, dflt: i64) -> i64 {
    #[derive(serde::Deserialize)]
    struct Row {
        v: String,
    }
    let rows: Vec<Row> = sql
        .exec("SELECT v FROM meta WHERE k=? LIMIT 1;", vec![k.into()])
        .ok()
        .and_then(|r| r.to_array().ok())
        .unwrap_or_default();
    rows.first().and_then(|r| r.v.parse().ok()).unwrap_or(dflt)
}

fn read_str(sql: &worker::SqlStorage, k: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Row {
        v: String,
    }
    let rows: Vec<Row> = sql
        .exec("SELECT v FROM meta WHERE k=? LIMIT 1;", vec![k.into()])
        .ok()
        .and_then(|r| r.to_array().ok())
        .unwrap_or_default();
    rows.into_iter().next().map(|r| r.v)
}

fn write_meta(sql: &worker::SqlStorage, k: &str, v: &str) {
    sql.exec(
        "INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
        vec![k.into(), v.into()],
    )
    .expect("write meta");
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}

fn clone_glue(g: &GlueKernel) -> GlueKernel {
    let v: &JsValue = g.as_ref();
    v.clone().unchecked_into()
}

fn to_err(e: JsValue) -> worker::Error {
    worker::Error::RustError(format!("{:?}", e))
}

fn num_field(obj: &JsValue, k: &str) -> Option<f64> {
    Reflect::get(obj, &JsValue::from_str(k)).ok().and_then(|v| v.as_f64())
}

fn str_field(obj: &JsValue, k: &str) -> Option<String> {
    Reflect::get(obj, &JsValue::from_str(k)).ok().and_then(|v| v.as_string())
}
