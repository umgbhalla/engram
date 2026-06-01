//! montydyn v0 — durable hibernating QuickJS REPL kernel.
//!
//! Architecture = PATH (b) (proven by EXP-4b): Rust DurableObject shell +
//! thin JS glue boundary (entry.mjs imports quickjs.wasm as CompiledWasm) doing
//! eval + memory dump/restore.
//!
//! What this DO owns:
//!   * Identity, lifecycle, generation counter (cold-wake evidence), epoch (reset).
//!   * A hibernatable WebSocket (state.acceptWebSocket + ping/pong auto-response).
//!   * The SNAPSHOT STORE = DO SQLite (single logical snapshot, chunked across
//!     rows; ~64KB BLOB chunks to stay under the 2MB value / 100KB statement caps).
//!     R2 is OPTIONAL overflow only (gz image > SQLITE_HOT_MAX).
//!   * The in-DO async mutex (JS promise-chain) serializing eval/reset; cell-number
//!     allocated inside the critical section.
//!   * Per-cell move-forward checkpoint with COMMIT ORDERING: committedCell advances
//!     only AFTER the snapshot write resolves.
//!
//! What the JS glue (src/glue.js) owns: seeded clock/RNG/crypto determinism +
//! persisted entropy counter, streaming gzip dump, engine-hash guard, size guard.
//!
//! REPL protocol over WS (JSON):
//!   {t:"eval", src}  -> eval against persisted namespace, per-cell checkpoint to SQLite.
//!   {t:"reset"}      -> drop kernel, clear snapshot, bump epoch.
//!   {t:"gen"}        -> {generation, inMemory, epoch, committedCell}.
//!   {t:"evict"}      -> (test) drop in-memory kernel, keep durable snapshot.

use js_sys::{Array, Reflect, Uint8Array};
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
    // V0.9: store a big context blob HOST-SIDE (outside the VM heap) -> returns stored len.
    #[wasm_bindgen(method, js_name = setContext)]
    fn set_context(this: &GlueKernel, name: &str, blob: &str) -> f64;
    // V0.9.3 GAP 2: engine-migration journal REPLAY. Creates a FRESH engine under the persisted
    // config, then re-evals each journaled cell source (JSON array of {cell,src,effectful,ok}) in
    // order. Returns a JSON result string {replayed,failed,effectfulCells,errors}. Used when the
    // snapshot's engine hash != the current engine hash (a heap restore would corrupt state).
    #[wasm_bindgen(method, js_name = replayJournal)]
    fn replay_journal(
        this: &GlueKernel,
        journal_json: &str,
        config_json: &str,
        kv_json: &str,
        ctx_json: &str,
    ) -> js_sys::Promise;
    // V0.9: read back the recorded RLM final answer (JSON string).
    #[wasm_bindgen(method, js_name = finalInfo)]
    fn final_info(this: &GlueKernel) -> String;
    // BUG-1: evalCode returns a JSON STRING {ok,value,valuePreview,valueType,logs,error?}
    // and NEVER throws across the boundary, so the eval mutex is always released.
    // P3: eval is ASYNC (returns Promise<String>) so a cell can `await host.fetch()`.
    // V0.4: per-restore phase timings (JSON string) from the last restore().
    #[wasm_bindgen(method, js_name = lastRestoreTimings)]
    fn last_restore_timings(this: &GlueKernel) -> String;
    // V0.6: stdlib injection result + bundle catalog (JSON string).
    #[wasm_bindgen(method, js_name = stdlibInfo)]
    fn stdlib_info(this: &GlueKernel) -> String;
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

// ~64KB per SQLite BLOB chunk: well under the 2MB value cap and 100KB statement cap.
const CHUNK_BYTES: usize = 64 * 1024;
// gz image above this goes to R2 overflow instead of SQLite chunks (~2MB).
const SQLITE_HOT_MAX: usize = 2 * 1024 * 1024;

#[durable_object]
pub struct KernelDO {
    state: State,
    env: Env,
    generation: i64,
    do_id: String,
    // Interior mutability: DurableObject trait methods take &self. Never hold a
    // borrow across .await.
    glue: RefCell<Option<GlueKernel>>,
    mutex: Mutex,
}

impl DurableObject for KernelDO {
    fn new(state: State, env: Env) -> Self {
        let sql = state.storage().sql();
        sql.exec(
            "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);",
            None,
        )
        .expect("create meta");
        // Snapshot manifest: one committed logical snapshot at a time.
        sql.exec(
            "CREATE TABLE IF NOT EXISTS snap_manifest (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                cell INTEGER, epoch INTEGER, n_chunks INTEGER,
                size_raw INTEGER, size_gz INTEGER, engine_hash TEXT,
                clock_calls INTEGER, rng_calls INTEGER,
                store TEXT, r2_key TEXT, created_ms INTEGER,
                kv_json TEXT, used_heap INTEGER, ctx_json TEXT
            );",
            None,
        )
        .expect("create snap_manifest");
        // P0: best-effort migration for DOs created before `used_heap` existed. ALTER fails
        // harmlessly (duplicate column) on fresh tables; ignore the error.
        let _ = sql.exec("ALTER TABLE snap_manifest ADD COLUMN used_heap INTEGER;", None);
        // V0.9: best-effort migration for the host-side context store column. (v0.9.1: the
        // ctx_json column is now LEGACY — read back for v0.9-era snapshots, but the primary
        // store is the chunked ctx_chunks table below.)
        let _ = sql.exec("ALTER TABLE snap_manifest ADD COLUMN ctx_json TEXT;", None);
        // V0.9.1 HIGH-bug FIX: number of ctx_chunks rows for the committed snapshot. The
        // host-side context store can be multi-MB, which overflows the SQLite value/statement
        // cap (SQLITE_TOOBIG) if bound as a single ctx_json TEXT value — and was therefore LOST
        // on cold restore (warm path was fine because the store lives in a host-side Map). We now
        // CHUNK the serialized context store across ctx_chunks rows (~64KB each, same pattern as
        // snap_chunks) and record the row count here.
        let _ = sql.exec("ALTER TABLE snap_manifest ADD COLUMN ctx_n_chunks INTEGER;", None);
        sql.exec(
            "CREATE TABLE IF NOT EXISTS snap_chunks (
                seq INTEGER PRIMARY KEY, data BLOB
            );",
            None,
        )
        .expect("create snap_chunks");
        // V0.9.1: chunked host-side context store (the RLM context handle). The serialized
        // context JSON is split into ~64KB BLOB rows so a multi-MB context survives
        // evict/cold-restore (no SQLITE_TOOBIG). One committed logical snapshot's worth at a
        // time, replaced atomically alongside snap_chunks/snap_manifest in the same synchronous
        // DO turn (workerd write-coalescing => all-or-nothing).
        sql.exec(
            "CREATE TABLE IF NOT EXISTS ctx_chunks (
                seq INTEGER PRIMARY KEY, data BLOB
            );",
            None,
        )
        .expect("create ctx_chunks");

        // V0.9.3 GAP 2 — ENGINE-MIGRATION JOURNAL (ADR-0002). Snapshots are byte-coupled to the
        // engine build: the heap image is only restorable into the SAME quickjs.wasm hash. When the
        // engine hash changes (an engine upgrade), a heap restore MUST NOT silently fail. Alongside
        // the heap snapshot we append EACH committed cell's SOURCE to this per-cell journal. On an
        // engine-hash MISMATCH at restore, instead of throwing EngineHashMismatchError, we REPLAY
        // the journal into a FRESH engine (best-effort): pure cells reproduce their namespace
        // exactly; effectful cells (host.fetch/subLM/kv/random/Date — flagged at append time) cannot
        // be faithfully reproduced and are recorded with `effectful=1` so the recovery is honest
        // about the no-replay caveat. The journal is cleared only on reset (alongside the snapshot).
        sql.exec(
            "CREATE TABLE IF NOT EXISTS cell_journal (
                cell INTEGER PRIMARY KEY, epoch INTEGER, src TEXT,
                effectful INTEGER, ok INTEGER, created_ms INTEGER
            );",
            None,
        )
        .expect("create cell_journal");

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
            // Auto ping/pong so idle pings don't wake user code (hibernation).
            if let Ok(rp) = WebSocketRequestResponsePair::new("ping", "pong") {
                self.state.set_websocket_auto_response(&rp);
            }
            return Response::from_websocket(pair.client);
        }
        Response::ok("montydyn-v0: connect a websocket; {t:eval|reset|gen}\n")
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
        format!("v093/{}.qjs.gz", self.do_id)
    }

    /// Fresh, cell/epoch-scoped R2 key for the swap-then-delete overflow write.
    /// Each replace writes to a NEW key so the prior committed object survives until
    /// the new manifest commits (then the old key is deleted post-commit).
    fn r2_key_for(&self, cell: i64, epoch: i64) -> String {
        format!("v093/{}/e{}-c{}.qjs.gz", self.do_id, epoch, cell)
    }

    /// V0.5 OBSERVABILITY: emit one Analytics Engine datapoint for an op, and a
    /// structured JSON console line (Workers Logs queryable).
    ///
    /// SCHEMA (stable — documented in docs/results/v0.5-observability.md):
    ///   indexes = [ doId ]                          (sampling/partition key; <=1, <=96 bytes)
    ///   blobs   = [ op, restoreSource, store, errorName, configClock,
    ///               valueType, label ]              (<=20 blobs, <=5120 bytes total)
    ///   doubles = [ totalServerMs, readMs, sizeRaw, sizeGz, usedHeap, cell,
    ///               generation, gunzipMs, instantiateMs, growCount, nChunks, ok ]
    ///
    /// `writeDataPoint` is fire-and-forget (workerd flushes async); we never await it
    /// and never let an emit failure perturb the op result.
    #[allow(clippy::too_many_arguments)]
    fn emit(&self, dp: &Datapoint) {
        // structured per-op JSON log line -> Workers Logs (observability.enabled).
        let log = json!({
            "ev": "op",
            "op": dp.op,
            "doId": self.do_id,
            "restoreSource": dp.restore_source,
            "store": dp.store,
            "errorName": dp.error_name,
            "configClock": dp.config_clock,
            "valueType": dp.value_type,
            "label": dp.label,
            "totalServerMs": dp.total_server_ms,
            "readMs": dp.read_ms,
            "sizeRaw": dp.size_raw,
            "sizeGz": dp.size_gz,
            "usedHeap": dp.used_heap,
            "cell": dp.cell,
            "generation": self.generation,
            "gunzipMs": dp.gunzip_ms,
            "instantiateMs": dp.instantiate_ms,
            "growCount": dp.grow_count,
            "nChunks": dp.n_chunks,
            "ok": dp.ok,
        });
        // console.log a single JSON line; serde_json::to_string never fails on this.
        web_sys_console_log(&log.to_string());

        // Analytics Engine datapoint (best-effort; swallow any binding/interop error).
        let _ = self.write_ae(dp);
    }

    fn write_ae(&self, dp: &Datapoint) -> std::result::Result<(), JsValue> {
        let env: &JsValue = self.env.as_ref();
        let ae = Reflect::get(env, &JsValue::from_str("AE"))?;
        if ae.is_undefined() || ae.is_null() {
            return Ok(()); // binding absent (e.g. local dev) — no-op.
        }
        let write_fn = Reflect::get(&ae, &JsValue::from_str("writeDataPoint"))?;
        let write_fn: js_sys::Function = write_fn.dyn_into()?;

        let indexes = Array::new();
        indexes.push(&JsValue::from_str(&self.do_id));

        let blobs = Array::new();
        blobs.push(&JsValue::from_str(dp.op));
        blobs.push(&JsValue::from_str(&dp.restore_source));
        blobs.push(&JsValue::from_str(&dp.store));
        blobs.push(&JsValue::from_str(&dp.error_name));
        blobs.push(&JsValue::from_str(&dp.config_clock));
        blobs.push(&JsValue::from_str(&dp.value_type));
        blobs.push(&JsValue::from_str(&dp.label));

        let doubles = Array::new();
        doubles.push(&JsValue::from_f64(dp.total_server_ms));
        doubles.push(&JsValue::from_f64(dp.read_ms));
        doubles.push(&JsValue::from_f64(dp.size_raw as f64));
        doubles.push(&JsValue::from_f64(dp.size_gz as f64));
        doubles.push(&JsValue::from_f64(dp.used_heap as f64));
        doubles.push(&JsValue::from_f64(dp.cell as f64));
        doubles.push(&JsValue::from_f64(self.generation as f64));
        doubles.push(&JsValue::from_f64(dp.gunzip_ms));
        doubles.push(&JsValue::from_f64(dp.instantiate_ms));
        doubles.push(&JsValue::from_f64(dp.grow_count as f64));
        doubles.push(&JsValue::from_f64(dp.n_chunks as f64));
        doubles.push(&JsValue::from_f64(if dp.ok { 1.0 } else { 0.0 }));

        let point = js_sys::Object::new();
        Reflect::set(&point, &JsValue::from_str("indexes"), &indexes)?;
        Reflect::set(&point, &JsValue::from_str("blobs"), &blobs)?;
        Reflect::set(&point, &JsValue::from_str("doubles"), &doubles)?;

        write_fn.call1(&ae, &point)?;
        Ok(())
    }

    async fn handle(&self, msg: serde_json::Value) -> Result<serde_json::Value> {
        let t = msg.get("t").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            // B2 (lazy instantiate): gen reports liveness WITHOUT ever creating/restoring a
            // QuickJS instance. It only reads SQLite meta + the in-memory glue Option. So a
            // gen against a cold/hibernated DO stays cold (inMemory:false) — no instantiate.
            "gen" => {
                let sql = self.state.storage().sql();
                let mut dp = Datapoint::new("gen");
                dp.cell = read_int(&sql, "committedCell", -1);
                self.emit(&dp);
                // V0.9.3 GAP 2: read the committed snapshot's engine hash (if any) so a caller can
                // see whether the durable snapshot is byte-compatible with the CURRENT engine, and
                // the journal length backing the engine-migration replay fallback.
                let snap_engine = self.read_manifest().map(|m| m.engine_hash).unwrap_or_default();
                let cur_engine = get_engine_hash();
                Ok(json!({
                    "ok": true, "t": "gen",
                    "generation": self.generation,
                    "inMemory": self.glue.borrow().is_some(),
                    "epoch": read_int(&sql, "epoch", 0),
                    "committedCell": read_int(&sql, "committedCell", -1),
                    "engineHash": cur_engine,
                    // V0.9.3 GAP 2: version/migration introspection.
                    "version": "v0.9.3",
                    "snapshotEngineHash": snap_engine,
                    "journalLen": self.journal_len(),
                }))
            }

            // B2 (lazy instantiate): an explicit cheap liveness ping. Like gen/evict it MUST
            // NOT establish a QuickJS instance — only the first eval/create does that.
            "ping" => {
                self.emit(&Datapoint::new("ping"));
                Ok(json!({
                    "ok": true, "t": "ping",
                    "inMemory": self.glue.borrow().is_some(),
                    "generation": self.generation,
                }))
            }

            // V0.1: dynamic session config. Persisted to meta so cold-wake restore
            // re-establishes the identical environment + re-registers host tools.
            // Idempotent: re-sending create with the same config is a no-op; sending
            // a different config before the first eval re-shapes a fresh env.
            "create" => {
                let release = JsFuture::from(self.mutex.acquire())
                    .await
                    .map_err(to_err)?;
                let res = self.create_critical(&msg).await;
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                res
            }

            "eval" => {
                // Serialize the whole eval through the in-DO mutex. cell-number is
                // allocated inside the critical section.
                let release = JsFuture::from(self.mutex.acquire())
                    .await
                    .map_err(to_err)?;
                let res = self.eval_critical(&msg).await;
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                res
            }

            "reset" => {
                let release = JsFuture::from(self.mutex.acquire())
                    .await
                    .map_err(to_err)?;
                let res = self.reset_critical().await;
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                res
            }

            // Test hook: drop in-memory kernel WITHOUT clearing the durable snapshot,
            // to force the lazy cold-restore path deterministically.
            "evict" => {
                let taken = self.glue.borrow_mut().take();
                let had = taken.is_some();
                if let Some(g) = taken {
                    g.drop_kernel();
                }
                let mut dp = Datapoint::new("evict");
                dp.value_type = if had { "dropped".into() } else { "noop".into() };
                self.emit(&dp);
                Ok(json!({"ok": true, "t": "evict", "droppedInMemory": had,
                    "generation": self.generation}))
            }

            // V0.6: stdlib introspection. Reports the shipped bundle catalog (available
            // modules + sizes + versions) and, if a kernel is in memory, what loaded at
            // create. Establishes a kernel under the mutex (like create) so the catalog
            // and any cold-restore-carried libs are reported from the live VM.
            "stdlib" => {
                let release = JsFuture::from(self.mutex.acquire())
                    .await
                    .map_err(to_err)?;
                let res = self.stdlib_critical().await;
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                res
            }

            // V0.9: store a big context blob HOST-SIDE behind a handle. Goes through the mutex
            // (establishes the kernel if needed) and checkpoints so the context survives evict.
            "setContext" => {
                let release = JsFuture::from(self.mutex.acquire()).await.map_err(to_err)?;
                let res = self.set_context_critical(&msg).await;
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                res
            }

            // V0.9: read back the recorded RLM final answer (host.final / host.finalVar).
            // V0.9.1 (trace-after-reconnect FIX): the trajectory final is persisted to SQLite
            // meta when a cell records it, so `trace` shows the final answer even after the
            // in-memory glue has been evicted/cold-restored. We read the LIVE glue's final_info
            // (authoritative when warm and for FINAL_VAR, which resolves against the live VM
            // heap), and if that has no recorded final we fall back to the persisted meta blob.
            "final" => {
                let release = JsFuture::from(self.mutex.acquire()).await.map_err(to_err)?;
                let _ = self.ensure_glue().await?;
                let live = self
                    .glue
                    .borrow()
                    .as_ref()
                    .map(|g| serde_json::from_str::<serde_json::Value>(&g.final_info()).unwrap_or_else(|_| json!({})))
                    .unwrap_or_else(|| json!({}));
                // If the live glue reports a recorded final (kind present), persist it (so a
                // later cold `final`/`trace` still sees it) and use it. Otherwise fall back to
                // the persisted meta blob captured at the time the cell recorded the final.
                let info = if live.get("kind").is_some() {
                    let sql = self.state.storage().sql();
                    write_meta(&sql, "finalInfo", &serde_json::to_string(&live).unwrap_or_else(|_| "{}".into()));
                    live
                } else {
                    match read_str(&self.state.storage().sql(), "finalInfo") {
                        Some(s) => serde_json::from_str::<serde_json::Value>(&s).unwrap_or(live),
                        None => live,
                    }
                };
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                self.emit(&Datapoint::new("final"));
                Ok(json!({ "ok": true, "t": "final", "final": info, "generation": self.generation }))
            }

            // V0.9.3 GAP 2 (TEST HOOK): simulate an ENGINE-HASH BUMP without rebuilding the wasm.
            // Rewrites the committed snapshot manifest's engine_hash to a bogus value so the NEXT
            // cold restore sees snap.engine_hash != current and routes through the journal-replay
            // fallback (instead of the old EngineHashMismatchError). Test-only; gated behind a msg
            // type so it never fires in normal operation.
            "engineBump" => {
                let release = JsFuture::from(self.mutex.acquire()).await.map_err(to_err)?;
                let fake = msg
                    .get("hash")
                    .and_then(|v| v.as_str())
                    .unwrap_or("BUMPED-ENGINE-HASH-v0.9.3-test");
                let sql = self.state.storage().sql();
                sql.exec(
                    "UPDATE snap_manifest SET engine_hash=? WHERE id=1;",
                    vec![fake.into()],
                )
                .ok();
                let had = self.read_manifest().is_some();
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                Ok(json!({"ok": true, "t": "engineBump", "manifestEngineHash": fake,
                    "hadManifest": had, "generation": self.generation}))
            }

            other => Ok(json!({"ok": false, "error": format!("unknown msg type {other}")})),
        }
    }

    /// V0.1: apply + persist session config. Allows first-eval-style config too via a
    /// dedicated message; if a kernel does not yet exist it is created with this config,
    /// otherwise config is just persisted (takes effect for budget/capture immediately,
    /// and fully on next restore).
    async fn create_critical(&self, msg: &serde_json::Value) -> Result<serde_json::Value> {
        let cfg = msg.get("config").cloned().unwrap_or_else(|| json!({}));
        let cfg_str = serde_json::to_string(&cfg).unwrap_or_else(|_| "{}".into());
        let sql = self.state.storage().sql();
        write_meta(&sql, "config", &cfg_str);
        // Lazily establish (or restore) the kernel under this config.
        let restore_info = self.ensure_glue().await?;
        // V0.5: a create that triggered a cold restore is also a "restore" op; otherwise
        // it is a "create" op. Either way emit the restore phase marks.
        let op: &'static str = if restore_info.source.contains("restore") {
            "restore"
        } else {
            "create"
        };
        let mut dp = Datapoint::new(op);
        dp.restore_source = restore_info.source.clone();
        dp.config_clock = cfg.get("clock").and_then(|v| v.as_str()).unwrap_or("seeded").to_string();
        dp.read_ms = restore_info.read_ms;
        dp.total_server_ms = restore_info.total_server_ms;
        dp.gunzip_ms = timings_num(&restore_info.timings_json, "gunzipMs");
        dp.instantiate_ms = timings_num(&restore_info.timings_json, "instantiateMs");
        dp.grow_count = timings_num(&restore_info.timings_json, "growCount") as i64;
        self.emit(&dp);
        // V0.6: report the configurable in-VM stdlib injection (what loaded at create,
        // what's available in the shipped bundle). On a cold-restore-triggered create the
        // libs came back IN THE HEAP (no re-inject), so loaded[] is empty but `available`
        // still lists the bundle catalog.
        let stdlib = self
            .glue
            .borrow()
            .as_ref()
            .map(|g| {
                serde_json::from_str::<serde_json::Value>(&g.stdlib_info())
                    .unwrap_or_else(|_| json!({}))
            })
            .unwrap_or_else(|| json!({}));
        Ok(json!({
            "ok": true, "t": "create",
            "config": cfg,
            "generation": self.generation,
            "restoreSource": restore_info.source,
            "restoreTimings": restore_timings_value(&restore_info),
            "stdlib": stdlib,
        }))
    }

    /// V0.6: report the configurable in-VM stdlib state (bundle catalog + what loaded).
    async fn stdlib_critical(&self) -> Result<serde_json::Value> {
        let _ = self.ensure_glue().await?;
        let stdlib = self
            .glue
            .borrow()
            .as_ref()
            .map(|g| {
                serde_json::from_str::<serde_json::Value>(&g.stdlib_info())
                    .unwrap_or_else(|_| json!({}))
            })
            .unwrap_or_else(|| json!({}));
        self.emit(&Datapoint::new("stdlib"));
        Ok(json!({
            "ok": true, "t": "stdlib",
            "generation": self.generation,
            "stdlib": stdlib,
        }))
    }

    /// V0.9: set a host-side context blob (the RLM context handle). Stored OUTSIDE the VM heap,
    /// then checkpointed so it travels in the snapshot meta and survives evict/cold-restore.
    async fn set_context_critical(&self, msg: &serde_json::Value) -> Result<serde_json::Value> {
        let name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("context");
        let blob = msg.get("blob").and_then(|v| v.as_str()).unwrap_or("");
        let restore_info = self.ensure_glue().await?;
        let len = self
            .glue
            .borrow()
            .as_ref()
            .map(|g| g.set_context(name, blob))
            .unwrap_or(0.0) as i64;

        // Checkpoint so the host-side context store persists (durability differentiator).
        let sql = self.state.storage().sql();
        let cell = read_int(&sql, "committedCell", -1) + 1;
        let epoch = read_int(&sql, "epoch", 0);
        let ckpt = self.checkpoint(cell, epoch).await.unwrap_or_else(|e| json!({"ok": false, "error": format!("{e}")}));

        let mut dp = Datapoint::new("setContext");
        dp.cell = cell;
        dp.size_raw = len;
        dp.restore_source = restore_info.source.clone();
        self.emit(&dp);

        Ok(json!({
            "ok": true, "t": "setContext",
            "name": name, "len": len, "cell": cell,
            "generation": self.generation,
            "restoreSource": restore_info.source,
            "checkpoint": ckpt,
        }))
    }

    /// eval against the persisted namespace, then per-cell checkpoint to SQLite.
    async fn eval_critical(&self, msg: &serde_json::Value) -> Result<serde_json::Value> {
        let src = msg.get("src").and_then(|v| v.as_str()).unwrap_or("");
        let before = self.glue.borrow().is_some();

        // First-eval config: {t:"eval", src, config:{...}} persists config before the
        // kernel is established (only honored if no kernel/config yet).
        if !before {
            if let Some(cfg) = msg.get("config") {
                let cur = read_str(&self.state.storage().sql(), "config");
                if cur.is_none() {
                    let cfg_str = serde_json::to_string(cfg).unwrap_or_else(|_| "{}".into());
                    write_meta(&self.state.storage().sql(), "config", &cfg_str);
                }
            }
        }

        // Lazy cold restore if no in-memory kernel.
        let restore_info = self.ensure_glue().await?;

        // V0.5: a cold restore that fed this eval is its own observable op.
        if restore_info.source.contains("restore") {
            let mut rdp = Datapoint::new("restore");
            rdp.restore_source = restore_info.source.clone();
            rdp.read_ms = restore_info.read_ms;
            rdp.total_server_ms = restore_info.total_server_ms;
            rdp.gunzip_ms = timings_num(&restore_info.timings_json, "gunzipMs");
            rdp.instantiate_ms = timings_num(&restore_info.timings_json, "instantiateMs");
            rdp.grow_count = timings_num(&restore_info.timings_json, "growCount") as i64;
            rdp.cell = read_int(&self.state.storage().sql(), "committedCell", -1);
            self.emit(&rdp);
        }

        // eval. BUG-1: eval_code returns a JSON string and NEVER throws/rejects.
        // P3: eval is now async (a cell may `await host.fetch()`), so we await the
        // returned Promise. No borrow is held across the await.
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

        // allocate the next cell index inside the critical section
        let sql = self.state.storage().sql();
        let cell = read_int(&sql, "committedCell", -1) + 1;
        let epoch = read_int(&sql, "epoch", 0);

        // dump + checkpoint (commit ordering: committedCell advances AFTER write).
        // A thrown-error cell still checkpoints (the VM is usable; namespace may have
        // partial mutations) so move-forward semantics hold.
        // V0.5: capture a checkpoint failure (e.g. SizeAdmissionError from dump) so we can
        // emit a "size-reject"/"checkpoint" datapoint instead of dropping it as a bare Err.
        let ckpt_res = self.checkpoint(cell, epoch).await;
        let ckpt = match ckpt_res {
            Ok(v) => v,
            Err(e) => {
                let emsg = format!("{e}");
                let is_size = emsg.contains("SizeAdmission") || emsg.contains("MAX_DUMP");
                let mut cdp = Datapoint::new(if is_size { "size-reject" } else { "checkpoint" });
                cdp.ok = false;
                cdp.error_name = if is_size { "SizeAdmissionError".into() } else { "CheckpointError".into() };
                cdp.cell = cell;
                self.emit(&cdp);
                json!({ "ok": false, "error": emsg })
            }
        };

        let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);

        // V0.9.3 GAP 2: append this cell's SOURCE to the engine-migration journal, in the SAME
        // synchronous turn as (just after) the checkpoint commit so the journal and the committed
        // snapshot advance together (workerd write-coalescing). Flag the cell as `effectful` if its
        // source references a host effect or non-deterministic source (host.fetch/subLM/kv/tools,
        // Math.random/Date/crypto) — those cannot be faithfully reproduced by a pure replay, so the
        // recovery is honest about the no-replay caveat. Only journal a cell whose checkpoint
        // succeeded (ckpt.ok != false) so the journal stays in lock-step with the durable snapshot.
        let ckpt_ok = ckpt.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
        if ckpt_ok {
            let effectful = cell_is_effectful(src);
            sql.exec(
                "INSERT INTO cell_journal(cell, epoch, src, effectful, ok, created_ms)
                 VALUES (?,?,?,?,?,?)
                 ON CONFLICT(cell) DO UPDATE SET
                   epoch=excluded.epoch, src=excluded.src, effectful=excluded.effectful,
                   ok=excluded.ok, created_ms=excluded.created_ms;",
                vec![
                    cell.into(),
                    epoch.into(),
                    src.into(),
                    (if effectful { 1i64 } else { 0i64 }).into(),
                    (if ok { 1i64 } else { 0i64 }).into(),
                    now_ms().into(),
                ],
            )
            .ok();
        }

        // V0.5: the eval op datapoint. error/timeout are surfaced via the error name.
        let err_name = parsed
            .get("error")
            .and_then(|e| e.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let value_type = parsed
            .get("valueType")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // A TimeoutError is its own op (loop preemption) per the schema's op enum.
        let op: &'static str = if err_name == "TimeoutError" {
            "timeout"
        } else if !ok {
            "error"
        } else {
            "eval"
        };
        let mut dp = Datapoint::new(op);
        dp.ok = ok;
        dp.error_name = err_name;
        dp.value_type = value_type;
        dp.cell = cell;
        dp.restore_source = restore_info.source.clone();
        dp.read_ms = restore_info.read_ms;
        dp.total_server_ms = restore_info.total_server_ms;
        dp.gunzip_ms = timings_num(&restore_info.timings_json, "gunzipMs");
        dp.instantiate_ms = timings_num(&restore_info.timings_json, "instantiateMs");
        dp.grow_count = timings_num(&restore_info.timings_json, "growCount") as i64;
        dp.size_raw = ckpt.get("sizeRaw").and_then(|v| v.as_i64()).unwrap_or(0);
        dp.size_gz = ckpt.get("sizeGz").and_then(|v| v.as_i64()).unwrap_or(0);
        dp.used_heap = ckpt.get("usedHeap").and_then(|v| v.as_i64()).unwrap_or(0);
        dp.n_chunks = ckpt.get("nChunks").and_then(|v| v.as_i64()).unwrap_or(0);
        dp.store = ckpt.get("store").and_then(|v| v.as_str()).unwrap_or("").to_string();
        self.emit(&dp);

        // V0.5: a cell that performed outbound egress is also a "fetch" op (best-effort,
        // detected from the cell source referencing host.fetch). errorName carries a
        // FetchBlockedError/FetchError when the cell's error came from the fetch boundary.
        if src.contains("host.fetch") {
            let mut fdp = Datapoint::new("fetch");
            fdp.ok = ok;
            fdp.error_name = parsed
                .get("error")
                .and_then(|e| e.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            fdp.cell = cell;
            self.emit(&fdp);
        }

        // V0.9: surface any RLM termination sentinel set during this cell (host.final /
        // host.finalVar) so the SDK's RLM loop can detect FINAL without a separate round-trip.
        let final_info = self
            .glue
            .borrow()
            .as_ref()
            .map(|g| serde_json::from_str::<serde_json::Value>(&g.final_info()).unwrap_or_else(|_| json!({})))
            .unwrap_or_else(|| json!({}));

        // V0.9.1 (trace-after-reconnect FIX): persist the trajectory final to SQLite meta the
        // moment a cell records it, so `trace`/`final` show the answer even after the in-memory
        // glue is evicted/cold-restored. The in-memory ctx.final does NOT travel in the heap
        // snapshot, so without this a FINAL-literal answer was lost on reconnect. (FINAL_VAR
        // resolves against the restored VM heap, but persisting its snapshotted value keeps
        // `trace` correct without re-evaluating the namespace.)
        if final_info.get("kind").is_some() {
            let sql = self.state.storage().sql();
            write_meta(&sql, "finalInfo", &serde_json::to_string(&final_info).unwrap_or_else(|_| "{}".into()));
        }

        Ok(json!({
            "ok": ok, "t": "eval",
            "final": final_info,
            "value": parsed.get("value").cloned().unwrap_or(serde_json::Value::Null),
            "valuePreview": parsed.get("valuePreview").cloned().unwrap_or(serde_json::Value::Null),
            "valueType": parsed.get("valueType").cloned().unwrap_or(serde_json::Value::Null),
            "logs": parsed.get("logs").cloned().unwrap_or_else(|| json!([])),
            "error": parsed.get("error").cloned().unwrap_or(serde_json::Value::Null),
            "cell": cell,
            "generation": self.generation,
            "inMemoryBefore": before,
            "restoreSource": restore_info.source,
            "restoreLatencyMs": restore_info.latency_ms,
            // V0.4: per-restore phase marks. readMs (byte fetch) + glue marks
            // (gunzipMs, instantiateMs, growCount, neededPages, ...) + server total.
            "restoreTimings": restore_timings_value(&restore_info),
            "checkpoint": ckpt,
        }))
    }

    async fn reset_critical(&self) -> Result<serde_json::Value> {
        // drop in-memory kernel
        let taken = self.glue.borrow_mut().take();
        if let Some(g) = taken {
            g.drop_kernel();
        }
        // Capture the committed R2 overflow key (if any) BEFORE clearing the manifest.
        let r2_key = self.read_manifest().and_then(|m| {
            if m.store == "r2" && !m.r2_key.is_empty() {
                Some(m.r2_key)
            } else {
                None
            }
        });
        // clear durable snapshot
        let sql = self.state.storage().sql();
        sql.exec("DELETE FROM snap_chunks;", None).ok();
        sql.exec("DELETE FROM ctx_chunks;", None).ok();
        sql.exec("DELETE FROM snap_manifest;", None).ok();
        // V0.9.3 GAP 2: a reset starts a clean namespace, so the engine-migration journal is dropped too.
        sql.exec("DELETE FROM cell_journal;", None).ok();
        // V0.9.1: drop the persisted trajectory final so a reset session starts clean.
        sql.exec("DELETE FROM meta WHERE k='finalInfo';", None).ok();
        // best-effort R2 overflow cleanup: delete the actual committed key plus the
        // legacy fixed key (for snapshots written before the cell/epoch-scoped scheme).
        if let Ok(bucket) = self.env.bucket("SNAPSHOTS") {
            if let Some(k) = r2_key {
                let _ = bucket.delete(&k).await;
            }
            let _ = bucket.delete(&self.r2_key()).await;
        }
        let epoch = read_int(&sql, "epoch", 0) + 1;
        write_meta(&sql, "epoch", &epoch.to_string());
        write_meta(&sql, "committedCell", "-1");
        self.emit(&Datapoint::new("reset"));
        Ok(json!({"ok": true, "t": "reset", "epoch": epoch,
            "generation": self.generation}))
    }

    /// Ensure a live kernel. On a cold/abrupt wake, restore from the last committed
    /// SQLite (or R2-overflow) checkpoint; else create a fresh seeded kernel.
    async fn ensure_glue(&self) -> Result<RestoreInfo> {
        if self.glue.borrow().is_some() {
            return Ok(RestoreInfo {
                source: "warm".into(),
                latency_ms: 0.0,
                read_ms: 0.0,
                total_server_ms: 0.0,
                timings_json: "{}".into(),
            });
        }
        let t0 = now_ms();
        let glue = new_glue_kernel();
        // V0.4: server-side phase marks. now_ms() (Date.now) is FROZEN within a sync turn on
        // workerd, so these deltas are only meaningful ACROSS the awaits below (the byte
        // fetch await, then the restore await). We stamp t0/t_read/t_end at those boundaries.
        let mut read_ms = 0.0_f64;
        let mut timings_json = String::from("{}");

        // V0.1: the persisted session config travels with restore so the cold-wake
        // environment (clock mode, seed, budget, tools, capture) is identical.
        let cfg_str = read_str(&self.state.storage().sql(), "config").unwrap_or_else(|| "{}".into());

        let manifest = self.read_manifest();
        let source = if let Some(m) = manifest {
            // V0.9.3 GAP 2 — ENGINE-MIGRATION JOURNAL FALLBACK (ADR-0002). The heap snapshot is
            // byte-coupled to the engine build; if the committed snapshot's engine hash != the
            // CURRENT engine hash (an engine upgrade), a heap blit would corrupt state. Instead of
            // failing the restore (the old EngineHashMismatchError), we REPLAY the per-cell source
            // journal into a FRESH engine: pure cells reproduce the namespace; effectful cells are
            // flagged (best-effort, no-replay caveat). We branch here BEFORE fetching the heap bytes.
            let cur_engine = get_engine_hash();
            if !m.engine_hash.is_empty() && m.engine_hash != cur_engine {
                let journal = self.read_journal();
                let kv_json = m.kv_json.clone();
                let ctx_json = if m.ctx_n_chunks > 0 {
                    self.read_ctx_chunks(m.ctx_n_chunks).unwrap_or_else(|_| "{}".into())
                } else {
                    m.ctx_json.clone()
                };
                let replay_res = JsFuture::from(glue.replay_journal(
                    &journal, &cfg_str, &kv_json, &ctx_json,
                ))
                .await
                .map_err(to_err)?
                .as_string()
                .unwrap_or_else(|| "{}".into());
                read_ms = now_ms() - t0;
                let replay: serde_json::Value =
                    serde_json::from_str(&replay_res).unwrap_or_else(|_| json!({}));
                timings_json = serde_json::to_string(&json!({
                    "engineMismatch": true,
                    "snapEngineHash": m.engine_hash,
                    "curEngineHash": cur_engine,
                    "replay": replay,
                }))
                .unwrap_or_else(|_| "{}".into());
                let mut rdp = Datapoint::new("journal-replay");
                rdp.restore_source = "journal-replay".into();
                rdp.error_name = "EngineHashMismatch".into();
                rdp.cell = replay.get("replayed").and_then(|v| v.as_i64()).unwrap_or(0);
                self.emit(&rdp);
                let total_server_ms = now_ms() - t0;
                *self.glue.borrow_mut() = Some(glue);
                return Ok(RestoreInfo {
                    source: "journal-replay".into(),
                    latency_ms: total_server_ms,
                    read_ms,
                    total_server_ms,
                    timings_json,
                });
            }
            // BUG-6: emit the correct restore label from the branch that fetched bytes.
            let is_r2 = m.store == "r2";
            let gz = if is_r2 {
                let bucket = self.env.bucket("SNAPSHOTS")?;
                let obj = bucket.get(&m.r2_key).execute().await?;
                let obj = obj.ok_or_else(|| worker::Error::RustError("r2 overflow missing".into()))?;
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
            // read_ms: time to fetch the snapshot bytes. For R2 this spans the get await
            // (meaningful); for the SQLite hot path read_chunks is synchronous so the clock
            // is frozen and this reads ~0 (honest: sub-ms, as prior benchmarks found).
            read_ms = now_ms() - t0;
            let label = if is_r2 { "r2-restore" } else { "sqlite-restore" };
            // V0.9.1 HIGH-bug FIX: reassemble the host-side context store from its chunked rows
            // (ctx_chunks). A multi-MB context that previously overflowed the single ctx_json
            // value now round-trips intact. Legacy v0.9 snapshots (ctx_n_chunks == 0) still carry
            // the small context in the manifest ctx_json column, so fall back to it.
            let ctx_json = if m.ctx_n_chunks > 0 {
                self.read_ctx_chunks(m.ctx_n_chunks)?
            } else {
                m.ctx_json.clone()
            };
            let src = JsFuture::from(glue.restore(
                gz,
                &m.engine_hash,
                m.clock_calls as f64,
                m.rng_calls as f64,
                &cfg_str,
                label,
                &m.kv_json,
                m.used_heap as f64,
                &ctx_json,
            ))
            .await
            .map_err(to_err)?;
            // Pull the glue's per-phase marks (recorded across its internal awaits).
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
            latency_ms: total_server_ms,
            read_ms,
            total_server_ms,
            timings_json,
        })
    }

    /// Dump the live kernel and persist it as the single committed snapshot.
    ///
    /// ATOMICITY (HIGH-severity fix): the snapshot REPLACE is crash-safe.
    ///   * SQLite path: the DELETE-old + INSERT-chunks + INSERT-manifest +
    ///     advance-committedCell all run in a SINGLE synchronous DO turn with NO
    ///     `.await` between them, so workerd's automatic write coalescing commits
    ///     them ATOMICALLY (all-or-nothing) at the end of the turn. An uncatchable
    ///     OOM/1102 or any error mid-loop discards the buffered writes → the prior
    ///     committed snapshot survives — never a torn or missing set. (Raw
    ///     BEGIN/COMMIT is rejected by DO SQLite, which is why we rely on the output
    ///     gate; this is the documented-correct mechanism.)
    ///   * R2 overflow path: SWAP-THEN-DELETE. The new object is written under a
    ///     FRESH key (cell/epoch-scoped) BEFORE the manifest is committed; the OLD
    ///     R2 object is deleted only AFTER the new manifest is durable. A crash in
    ///     the window between the put and the commit leaves the prior committed
    ///     snapshot (old key + old manifest) fully intact.
    /// Commit ordering is preserved: committedCell advances inside the same commit
    /// as the manifest, so it is never visible without a durable replacement.
    async fn checkpoint(&self, cell: i64, epoch: i64) -> Result<serde_json::Value> {
        let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
        let dump = JsFuture::from(glue.dump()).await.map_err(to_err)?;
        let gz: Uint8Array = Reflect::get(&dump, &JsValue::from_str("gz"))
            .map_err(to_err)?
            .into();
        let size_raw = num_field(&dump, "sizeRaw").unwrap_or(0.0) as i64;
        let size_gz = num_field(&dump, "sizeGz").unwrap_or(0.0) as i64;
        let used_heap = num_field(&dump, "usedHeap").unwrap_or(0.0) as i64;
        let buffer_bytes = num_field(&dump, "bufferBytes").unwrap_or(0.0) as i64;
        let scrubbed = Reflect::get(&dump, &JsValue::from_str("scrubbed"))
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let stack_pointer = num_field(&dump, "stackPointer");
        let clock_calls = num_field(&dump, "clockCalls").unwrap_or(0.0) as i64;
        let rng_calls = num_field(&dump, "rngCalls").unwrap_or(0.0) as i64;
        // P2: host-tool (kv) state, serialized in the glue, persisted alongside the snapshot.
        let kv_json = str_field(&dump, "kvJson").unwrap_or_else(|| "{}".to_string());
        // V0.9: host-side context store, serialized in the glue, persisted alongside the snapshot.
        let ctx_json = str_field(&dump, "ctxJson").unwrap_or_else(|| "{}".to_string());

        let mut bytes = vec![0u8; gz.length() as usize];
        gz.copy_to(&mut bytes);

        // The OLD committed R2 key (if any) — needed for post-commit cleanup.
        // Read BEFORE we touch anything; this is the key the prior manifest points at.
        let old_r2_key: Option<String> = self.read_manifest().and_then(|m| {
            if m.store == "r2" && !m.r2_key.is_empty() {
                Some(m.r2_key)
            } else {
                None
            }
        });

        // R2 OVERFLOW PATH: write the new object under a FRESH key FIRST (the only
        // .await before the SQL commit). Old object is untouched here.
        let to_r2 = bytes.len() > SQLITE_HOT_MAX;
        let (store, new_r2_key) = if to_r2 {
            let new_key = self.r2_key_for(cell, epoch);
            let bucket = self.env.bucket("SNAPSHOTS")?;
            bucket.put(&new_key, bytes.clone()).execute().await?;
            ("r2".to_string(), new_key)
        } else {
            ("sqlite".to_string(), String::new())
        };

        // ---- ATOMIC SQL REPLACE (no .await inside) ----
        let sql = self.state.storage().sql();
        let r2_key_for_manifest = new_r2_key.clone();
        // ATOMICITY via DO synchronous WRITE COALESCING. workerd does NOT allow raw
        // `BEGIN`/`COMMIT`/SAVEPOINT against DO SQLite — it errors and tells you to use
        // the transaction APIs, because every storage write performed within a SINGLE
        // synchronous turn (no `.await` yielding to the event loop) is buffered and
        // flushed ATOMICALLY by the DO output gate at the end of the turn. If the turn
        // throws, the buffered writes are discarded → the prior committed snapshot is
        // preserved. We therefore run the entire replace (DELETE + INSERTs + manifest +
        // committedCell) with NO `.await` inside, getting all-or-nothing for free.
        // (The only `.await` — the R2 put — happens BEFORE this block.)
        // V0.9.1 HIGH-bug FIX: chunk the serialized host-side context store across ctx_chunks
        // rows. A multi-MB context bound as a single ctx_json TEXT value hits SQLITE_TOOBIG (the
        // statement/value cap) and the write fails — silently losing the context on cold restore
        // (warm was fine, since the store lives in a host-side Map). Splitting into ~64KB BLOB
        // rows (UTF-8 bytes) mirrors the snapshot chunking and persists multi-MB contexts.
        let ctx_bytes = ctx_json.as_bytes();

        let txn = || -> Result<(i64, i64)> {
            // replace previous snapshot
            sql.exec("DELETE FROM snap_chunks;", None)?;
            sql.exec("DELETE FROM ctx_chunks;", None)?;
            sql.exec("DELETE FROM snap_manifest;", None)?;

            let n_chunks = if to_r2 {
                0i64
            } else {
                // SQLite chunked store (the default hot path).
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

            // V0.9.1: chunk the context store (always SQLite — it never goes to R2). A 0-length
            // context yields 0 rows (the empty "{}" still chunks to 1 tiny row, which is fine).
            let mut ctx_seq = 0i64;
            for chunk in ctx_bytes.chunks(CHUNK_BYTES) {
                sql.exec(
                    "INSERT INTO ctx_chunks(seq, data) VALUES (?, ?);",
                    vec![ctx_seq.into(), chunk.to_vec().into()],
                )
                .map_err(|e| worker::Error::RustError(format!("ctx chunk insert: {e:?}")))?;
                ctx_seq += 1;
            }

            sql.exec(
                "INSERT INTO snap_manifest
                    (id, cell, epoch, n_chunks, size_raw, size_gz, engine_hash,
                     clock_calls, rng_calls, store, r2_key, created_ms, kv_json, used_heap, ctx_json, ctx_n_chunks)
                 VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);",
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
                    // ctx_json column is now LEGACY: the context lives in ctx_chunks. Store an
                    // empty JSON object so a stray reader never mistakes a stale value for live.
                    "{}".to_string().into(),
                    ctx_seq.into(),
                ],
            )
            .map_err(|e| worker::Error::RustError(format!("manifest insert: {e:?}")))?;

            // COMMIT ORDERING: advance committedCell in the SAME synchronous turn as
            // the manifest, so it is never durable without a matching snapshot.
            sql.exec(
                "INSERT INTO meta(k,v) VALUES('committedCell',?)
                 ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
                vec![cell.to_string().into()],
            )?;
            Ok((n_chunks, ctx_seq))
        };

        // Execute the whole replace synchronously. On any error we return Err WITHOUT
        // awaiting, so the DO turn fails and the buffered writes are dropped — leaving
        // the prior committed snapshot (and, on the R2 path, the prior R2 object, which
        // we never deleted) fully intact. No torn/missing set is ever made durable.
        let (n_chunks, _ctx_n_chunks) = txn()?;

        // POST-COMMIT: the new snapshot is now durable. Safe to delete the OLD R2
        // object (swap-then-delete). Skip if the key is unchanged (shouldn't happen
        // because keys are cell/epoch-scoped, but guard anyway). Best-effort.
        if let Some(old) = old_r2_key {
            if old != new_r2_key {
                if let Ok(bucket) = self.env.bucket("SNAPSHOTS") {
                    let _ = bucket.delete(&old).await;
                }
            }
        }

        Ok(json!({
            "cell": cell, "store": store, "nChunks": n_chunks,
            "sizeRaw": size_raw, "sizeGz": size_gz,
            "usedHeap": used_heap, "bufferBytes": buffer_bytes, "scrubbed": scrubbed,
            "stackPointer": stack_pointer,
            "clockCalls": clock_calls, "rngCalls": rng_calls,
            "r2Key": new_r2_key,
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
            #[serde(default)]
            ctx_json: Option<String>,
            #[serde(default)]
            ctx_n_chunks: Option<i64>,
        }
        let rows: Vec<Row> = sql
            .exec(
                "SELECT cell,epoch,n_chunks,engine_hash,clock_calls,rng_calls,store,r2_key,kv_json,used_heap,ctx_json,ctx_n_chunks
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
            kv_json: r.kv_json.unwrap_or_else(|| "{}".to_string()),
            used_heap: r.used_heap.unwrap_or(0),
            ctx_json: r.ctx_json.unwrap_or_else(|| "{}".to_string()),
            ctx_n_chunks: r.ctx_n_chunks.unwrap_or(0),
        })
    }

    /// V0.9.3 GAP 2: read the engine-migration journal as a JSON array of
    /// {cell, epoch, effectful, ok, src} ordered by cell. Passed to glue.replayJournal on an
    /// engine-hash mismatch. Returns "[]" if the journal is empty (no recoverable namespace).
    fn read_journal(&self) -> String {
        let sql = self.state.storage().sql();
        #[derive(serde::Deserialize)]
        struct Row {
            cell: i64,
            epoch: i64,
            src: String,
            effectful: i64,
            ok: i64,
        }
        let rows: Vec<Row> = sql
            .exec(
                "SELECT cell, epoch, src, effectful, ok FROM cell_journal ORDER BY cell ASC;",
                None,
            )
            .ok()
            .and_then(|r| r.to_array().ok())
            .unwrap_or_default();
        let arr: Vec<serde_json::Value> = rows
            .into_iter()
            .map(|r| {
                json!({
                    "cell": r.cell, "epoch": r.epoch, "src": r.src,
                    "effectful": r.effectful != 0, "ok": r.ok != 0,
                })
            })
            .collect();
        serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into())
    }

    /// V0.9.3 GAP 2: count of journaled cells (exposed in {t:gen}/version as journalLen).
    fn journal_len(&self) -> i64 {
        let sql = self.state.storage().sql();
        #[derive(serde::Deserialize)]
        struct Row {
            n: i64,
        }
        let rows: Vec<Row> = sql
            .exec("SELECT COUNT(*) AS n FROM cell_journal;", None)
            .ok()
            .and_then(|r| r.to_array().ok())
            .unwrap_or_default();
        rows.first().map(|r| r.n).unwrap_or(0)
    }

    /// V0.9.1: reassemble the host-side context store JSON from its chunked BLOB rows
    /// (ctx_chunks, ordered by seq). Mirrors read_chunks but yields a UTF-8 String (the
    /// serialized context store). A multi-MB context round-trips here without ever being bound
    /// as a single oversized SQLite value (no SQLITE_TOOBIG).
    fn read_ctx_chunks(&self, ctx_n_chunks: i64) -> Result<String> {
        let sql = self.state.storage().sql();
        let cursor = sql
            .exec("SELECT data FROM ctx_chunks ORDER BY seq ASC;", None)
            .map_err(|e| worker::Error::RustError(format!("read ctx chunks: {e:?}")))?;
        let mut blobs: Vec<Vec<u8>> = Vec::new();
        for row in cursor.raw() {
            let row = row.map_err(|e| worker::Error::RustError(format!("ctx chunk row: {e:?}")))?;
            for val in row {
                if let worker::SqlStorageValue::Blob(b) = val {
                    blobs.push(b);
                }
            }
        }
        if blobs.len() as i64 != ctx_n_chunks {
            return Err(worker::Error::RustError(format!(
                "CorruptContextError: ctx chunk count mismatch (manifest ctx_n_chunks={ctx_n_chunks}, \
                 read {} chunks); refusing to restore from a torn context store",
                blobs.len()
            )));
        }
        let mut bytes: Vec<u8> = Vec::with_capacity(blobs.iter().map(|b| b.len()).sum());
        for b in &blobs {
            bytes.extend_from_slice(b);
        }
        // The serialized context store is JSON (valid UTF-8); from_utf8_lossy is a safe fallback.
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Reassemble the gz image from SQLite chunks (ordered by seq) into a Uint8Array.
    /// BLOB columns come back as JS Uint8Arrays; serde can't map those to Vec<u8>
    /// ("invalid type: byte array, expected a sequence"), so we read raw JsValue rows
    /// and pull each `data` field as a Uint8Array via Reflect.
    fn read_chunks(&self, n_chunks: i64) -> Result<Uint8Array> {
        let sql = self.state.storage().sql();
        let cursor = sql
            .exec("SELECT data FROM snap_chunks ORDER BY seq ASC;", None)
            .map_err(|e| worker::Error::RustError(format!("read chunks: {e:?}")))?;
        // cursor.raw() yields one Vec<SqlStorageValue> per row; the BLOB column comes
        // back as SqlStorageValue::Blob(Vec<u8>) — no serde mismatch.
        let mut blobs: Vec<Vec<u8>> = Vec::new();
        for row in cursor.raw() {
            let row = row.map_err(|e| worker::Error::RustError(format!("chunk row: {e:?}")))?;
            for val in row {
                if let worker::SqlStorageValue::Blob(b) = val {
                    blobs.push(b);
                }
            }
        }
        // RUNTIME corruption guard (was debug_assert, which compiles out in release
        // wasm — a truncated chunk set would otherwise feed garbage to gunzip).
        if blobs.len() as i64 != n_chunks {
            return Err(worker::Error::RustError(format!(
                "CorruptSnapshotError: chunk count mismatch (manifest n_chunks={n_chunks}, \
                 read {} chunks); refusing to restore from a torn snapshot",
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

/// V0.5: one Analytics Engine datapoint per op. Fields map 1:1 onto the AE
/// blobs/doubles schema documented in `emit()`.
struct Datapoint {
    op: &'static str,
    restore_source: String,
    store: String,
    error_name: String,
    config_clock: String,
    value_type: String,
    label: String,
    total_server_ms: f64,
    read_ms: f64,
    size_raw: i64,
    size_gz: i64,
    used_heap: i64,
    cell: i64,
    gunzip_ms: f64,
    instantiate_ms: f64,
    grow_count: i64,
    n_chunks: i64,
    ok: bool,
}

impl Datapoint {
    fn new(op: &'static str) -> Self {
        Datapoint {
            op,
            restore_source: String::new(),
            store: String::new(),
            error_name: String::new(),
            config_clock: String::new(),
            value_type: String::new(),
            label: String::new(),
            total_server_ms: 0.0,
            read_ms: 0.0,
            size_raw: 0,
            size_gz: 0,
            used_heap: 0,
            cell: -1,
            gunzip_ms: 0.0,
            instantiate_ms: 0.0,
            grow_count: 0,
            n_chunks: 0,
            ok: true,
        }
    }
}

/// Parse a numeric field out of the glue's restoreTimings.glue JSON (the per-phase marks).
fn timings_num(timings_json: &str, key: &str) -> f64 {
    serde_json::from_str::<serde_json::Value>(timings_json)
        .ok()
        .and_then(|v| v.get(key).and_then(|x| x.as_f64()))
        .unwrap_or(0.0)
}

struct RestoreInfo {
    source: String,
    latency_ms: f64,
    // V0.4 instrumentation. read_ms = server-side time to fetch the snapshot bytes
    // (SQLite chunk read or R2 get) across the byte-fetch await; total_server_ms = the
    // whole ensure_glue() span (read + gunzip + instantiate + blit + re-register), stamped
    // ACROSS awaits where the workerd clock is unfrozen. timings_json = the glue's
    // per-phase marks (gunzipMs, instantiateMs, growCount, neededPages, ...) or "{}".
    read_ms: f64,
    total_server_ms: f64,
    timings_json: String,
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
    // Legacy v0.9 small-context column (ctx_n_chunks==0 snapshots only).
    ctx_json: String,
    // V0.9.1: number of ctx_chunks rows holding the chunked host-side context store.
    ctx_n_chunks: i64,
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

// ---- small helpers ----

/// Build the restoreTimings object folded into eval/create replies. Merges the server-side
/// marks (readMs across the byte-fetch await, totalServerMs across ensure_glue) with the
/// glue's per-phase marks (gunzipMs/instantiateMs/growCount/neededPages, parsed from JSON).
fn restore_timings_value(info: &RestoreInfo) -> serde_json::Value {
    let glue: serde_json::Value =
        serde_json::from_str(&info.timings_json).unwrap_or_else(|_| json!({}));
    json!({
        "readMs": info.read_ms,
        "totalServerMs": info.total_server_ms,
        // inferredOtherMs = server total minus the measurable awaited phases. On the SQLite
        // hot path readMs reads ~0 (sync, frozen clock), so this captures the sub-ms
        // deserialize + any unmeasurable in-turn work, differenced honestly.
        "glue": glue,
    })
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
        "INSERT INTO meta(k,v) VALUES(?,?)
         ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
        vec![k.into(), v.into()],
    )
    .expect("write meta");
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}

/// V0.9.3 GAP 2: heuristic — does a cell SOURCE reference a host effect or a non-deterministic
/// source? Such cells cannot be faithfully reproduced by a pure journal replay (host.fetch /
/// host.subLM hit the network; host.kv / host.<tool> mutate host state; Math.random / Date.now /
/// crypto are entropy-dependent — though seeded, a replay re-advances the counters differently).
/// They are FLAGGED so the recovery is honest about the no-replay caveat; the source is still
/// replayed best-effort. Conservative substring scan (no JS parse available host-side).
fn cell_is_effectful(src: &str) -> bool {
    const MARKERS: &[&str] = &[
        "host.fetch",
        "host.subLM",
        "host.kv",
        "host.final",
        "host.search",
        "host_call",
        "host.add",
        "host.echo",
        "host.now",
        "Math.random",
        "Date.now",
        "new Date(",
        "crypto.getRandomValues",
        "crypto.randomUUID",
        "performance.now",
    ];
    MARKERS.iter().any(|m| src.contains(m))
}

// V0.5: structured JSON console line -> Workers Logs. Bind console.log directly
// (web-sys not a dep). Single string arg = one queryable JSON log line.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn console_log_str(s: &str);
}
fn web_sys_console_log(s: &str) {
    console_log_str(s);
}

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

fn str_field(obj: &JsValue, k: &str) -> Option<String> {
    Reflect::get(obj, &JsValue::from_str(k))
        .ok()
        .and_then(|v| v.as_string())
}
