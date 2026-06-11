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
//!   {t:create,config} {t:eval,src} {t:artifact,handle,offset,len}
//!   {t:ping} {t:gen} {t:reset} {t:evict} + /health

mod store;

use js_sys::{Reflect, Uint8Array};
use serde_json::json;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::rc::Rc;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use store::{DoSqlStore, KernelStore};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use worker::{
    durable_object, event, wasm_bindgen, wasm_bindgen_futures, Delay, DurableObject, Env, Method,
    Request, Response, Result, State, WebSocket, WebSocketIncomingMessage, WebSocketPair,
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
        base_codec: &str,
    ) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = restoreW4)]
    fn restore_w4(
        this: &GlueKernel,
        base_gz: Uint8Array,
        delta_list: &JsValue,
        engine_hash: &str,
        clock_calls: f64,
        rng_calls: f64,
        config_json: &str,
        label: &str,
        kv_json: &str,
        used_heap: f64,
        expect_crc: f64,
        expect_len: f64,
        base_codec: &str,
    ) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = lastRestoreTimings)]
    fn last_restore_timings(this: &GlueKernel) -> String;
    #[wasm_bindgen(method, js_name = evalCode)]
    fn eval_code(this: &GlueKernel, src: &str) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = resultArtifactChunk)]
    fn result_artifact_chunk(this: &GlueKernel, id: &str, offset: f64, len: f64) -> String;
    #[wasm_bindgen(method, js_name = setHostSender)]
    fn set_host_sender(this: &GlueKernel, send: &JsValue, timeout_ms: f64);
    #[wasm_bindgen(method, js_name = setFsHandler)]
    fn set_fs_handler(this: &GlueKernel, handler: &JsValue);
    #[wasm_bindgen(method, js_name = setFenceContext)]
    fn set_fence_context(this: &GlueKernel, do_id: &str, cell: f64);
    #[wasm_bindgen(method, js_name = setExtAeSink)]
    fn set_ext_ae_sink(this: &GlueKernel, sink: &JsValue);
    #[wasm_bindgen(method, js_name = dump)]
    fn dump(this: &GlueKernel) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = dumpW4)]
    fn dump_w4(this: &GlueKernel, force_full: bool) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = commitDump)]
    fn commit_dump(this: &GlueKernel);
    #[wasm_bindgen(method, js_name = lastCellHostResults)]
    fn last_cell_host_results(this: &GlueKernel) -> String;
    #[wasm_bindgen(method, js_name = replayJournal)]
    fn replay_journal(
        this: &GlueKernel,
        journal: &JsValue,
        config_json: &str,
        kv_json: &str,
    ) -> js_sys::Promise;
    #[wasm_bindgen(method, js_name = drop)]
    fn drop_kernel(this: &GlueKernel);

    #[wasm_bindgen(js_name = getEngineHash)]
    fn get_engine_hash() -> String;

    // host-callback bridge: resolve a parked VM host call from a {t:hostcall-result}
    // frame. Called from websocket_message OUTSIDE the eval mutex (see DEADLOCK note).
    #[wasm_bindgen(js_name = resolveHostCall)]
    fn resolve_host_call(id: &str, ok: bool, value_json: &str, error: &str);

    type Mutex;
    #[wasm_bindgen(js_name = newMutex)]
    fn new_mutex() -> Mutex;
    #[wasm_bindgen(method, js_name = acquire)]
    fn acquire(this: &Mutex) -> js_sys::Promise;
}

// ---- AUTH (Phase 1: shared bearer key) ----
// Per-connection auth state lives ONLY in the hibernatable socket attachment (serialize_attachment).
// It is NEVER written to meta/manifest/oplog/kv/config — so it cannot enter the heap snapshot and
// cannot perturb seeded determinism / byte-identical restore.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Default)]
struct AuthState {
    authed: bool,
}

/// Constant-time byte compare (folds all bytes; only length leaks).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// Is `token` a valid key against any of the comma-split keys?
fn token_valid(token: &str, keys: &[String]) -> bool {
    if token.is_empty() {
        return false;
    }
    keys.iter().any(|k| ct_eq(token.as_bytes(), k.as_bytes()))
}

/// Extract a presented bearer token: `Authorization: Bearer <t>`, `x-api-key`, `?apiKey=<t>`,
/// or `Sec-WebSocket-Protocol: engram.v1, engram-token.<t>`. Returns (token, via_subprotocol).
fn extract_token(req: &Request) -> (String, bool) {
    if let Ok(Some(auth)) = req.headers().get("Authorization") {
        if let Some(rest) = auth.strip_prefix("Bearer ") {
            let t = rest.trim();
            if !t.is_empty() {
                return (t.to_string(), false);
            }
        }
    }
    if let Ok(Some(xak)) = req.headers().get("x-api-key") {
        let t = xak.trim();
        if !t.is_empty() {
            return (t.to_string(), false);
        }
    }
    if let Ok(url) = req.url() {
        if let Some((_, v)) = url.query_pairs().find(|(k, _)| k == "apiKey") {
            let t = v.to_string();
            if !t.is_empty() {
                return (t, false);
            }
        }
    }
    if let Ok(Some(proto)) = req.headers().get("Sec-WebSocket-Protocol") {
        for part in proto.split(',') {
            let p = part.trim();
            if let Some(tok) = p.strip_prefix("engram-token.") {
                if !tok.is_empty() {
                    return (tok.to_string(), true);
                }
            }
        }
    }
    (String::new(), false)
}

const CHUNK_BYTES: usize = 64 * 1024;
// R2TAIL HOT-TIER: keep the restore-critical base image in DO SQLite (64KB chunked rows) up to
// this ceiling, spilling to R2 ONLY for genuinely large images. Raised 2MB -> 8MB so the vast
// majority of sessions never touch R2 on the hot restore path (removes the transient-R2 data-loss
// exposure for them entirely). DO SQLite total is generous; per-value cap is satisfied by 64KB
// chunking. Symmetric on write (checkpoint) and read (ensure_glue) — both key off `m.store`.
const SQLITE_HOT_MAX: usize = 8 * 1024 * 1024;
/// DO SQLite caps a single bound value at ~2MB. Any TEXT/BLOB we bind in a checkpoint txn must
/// stay below this or the INSERT throws SQLITE_TOOBIG mid-commit (aborting the staged transaction
/// and risking a torn manifest). The E6 oplog `src` is the only unbounded text we bind; clamp it.
const SQLITE_MAX_VALUE_BYTES: usize = 1_500_000;
const TEXT_ARTIFACT_CHUNK_MAX_CHARS: i64 = 128 * 1024;

#[durable_object]
/// A single staged host.fs mutation for the in-flight cell. Staged ops are buffered in DO memory
/// (never durable) until the cell's checkpoint flushes them to R2 + the committed `fs_files` meta
/// table IN THE SAME COMMIT as the heap dump — honoring the SANDBOX-API staged-commit coherence
/// invariant (a cold restore can never see a file written by a cell whose checkpoint did not commit,
/// nor a heap that references a file not yet durable). A crash before checkpoint drops the staged
/// set with the rolled-back heap (both revert together). `Write` carries the bytes; `Delete` is a
/// tombstone. The per-cell ordering is preserved (last write to a path wins at flush).
enum FsStageOp {
    Write(Vec<u8>),
    Delete,
}

struct FsStage {
    path: String,
    op: FsStageOp,
}

/// Shared per-DO staging buffer for the R2 fs provider. `Rc<RefCell<..>>` so the per-eval fs handler
/// closure (which is `forget()`-leaked) and the `checkpoint`/`handle_eval` methods share ONE buffer.
type StagedFs = Rc<RefCell<Vec<FsStage>>>;

pub struct KernelDO {
    state: State,
    env: Env,
    generation: i64,
    do_id: String,
    glue: RefCell<Option<GlueKernel>>,
    mutex: Mutex,
    // AUTH (resolved once from env; NEVER snapshotted). keys = comma-split ENGRAM_KERNEL_KEY.
    auth_keys: Vec<String>,
    auth_enforce: bool,
    // host.fs (config.fs.provider=="r2") staged mutations for the in-flight cell; flushed at
    // checkpoint, dropped on crash. In-memory only — NEVER snapshotted (the durable authority is
    // R2 + the `fs_files` SQLite table).
    staged_fs: StagedFs,
}

/// Semantic snapshot layout epoch (bump on quickjs-ng/rustc/feature/static-layout change). Recorded
/// in meta as groundwork; compatibility is proven by the build artifacts + the post-restore sanity
/// probe, never declared — a bump may only force replay, never a hot restore.
const SNAPSHOT_FORMAT_VERSION: &str = "1";

impl DurableObject for KernelDO {
    fn new(state: State, env: Env) -> Self {
        let store = DoSqlStore::new(state.storage().sql());
        store
            .exec(
                "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);",
                None,
            )
            .expect("create meta");
        store
            .exec(
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
        store
            .exec(
                "CREATE TABLE IF NOT EXISTS snap_chunks (seq INTEGER PRIMARY KEY, data BLOB);",
                None,
            )
            .expect("create snap_chunks");
        // W4 byte-delta: the committed snapshot is a full (W5-compacted) BASE plus a chain of
        // per-cell byte-deltas. Manifest gains base_seq/delta_seq/snap_mode + ctx columns.
        store.exec_ignore(
            "ALTER TABLE snap_manifest ADD COLUMN base_seq INTEGER;",
            None,
        );
        store.exec_ignore(
            "ALTER TABLE snap_manifest ADD COLUMN delta_seq INTEGER;",
            None,
        );
        store.exec_ignore("ALTER TABLE snap_manifest ADD COLUMN snap_mode TEXT;", None);
        // Snapshot-format groundwork: a semantic layout epoch alongside engine_hash (fable design —
        // a manual salt may only FORCE replay, never force a hot restore). Recorded for future
        // layout-compatible hot-restore gating; the post-restore sanity probe is the live safety net.
        store.exec_ignore(
            "ALTER TABLE snap_manifest ADD COLUMN layout_version TEXT;",
            None,
        );
        // W4 reconstruction checksum: CRC32 of the FULL image the committed chain reconstructs to
        // (base+deltas incl. the manifest's tail row). restoreW4 recomputes + rejects a mismatch =>
        // oplog replay fallback. Nullable for pre-CRC snapshots (the glue skips the check then).
        store.exec_ignore(
            "ALTER TABLE snap_manifest ADD COLUMN final_crc INTEGER;",
            None,
        );
        // Issue #9: codec for the BASE image blob ("gzip" | "zstd"). NULL/absent => "gzip" so any
        // snapshot written before this deploy still restores. New full bases write "zstd".
        store.exec_ignore("ALTER TABLE snap_manifest ADD COLUMN snap_codec TEXT;", None);
        write_meta(&store, "snapFormat", SNAPSHOT_FORMAT_VERSION);
        store
            .exec(
                "CREATE TABLE IF NOT EXISTS delta_chunks (
                seq INTEGER PRIMARY KEY, payload BLOB, indices BLOB, grain INTEGER
            );",
                None,
            )
            .expect("create delta_chunks");
        // Issue #9: per-delta codec ("gzip" | "zstd"). NULL/absent => "gzip". A chain can straddle a
        // deploy boundary, so each delta row records its OWN codec and restore decodes per-chunk.
        store.exec_ignore("ALTER TABLE delta_chunks ADD COLUMN codec TEXT;", None);
        // E6 oplog: per-cell {src, hostResults} appended for the crash tail + engine-migration
        // replay. Bounded to the cells since the last full base (cleared on base reset).
        store
            .exec(
                "CREATE TABLE IF NOT EXISTS oplog (seq INTEGER PRIMARY KEY, cell INTEGER, src TEXT, host_results TEXT);",
                None,
            )
            .expect("create oplog");
        // host.fs (config.fs.provider=="r2") committed path namespace. The AUTHORITY for which
        // paths exist under THIS session: `r2_key` is the content body key in the bound bucket
        // (always prefixed `fs/<doId>/` — see r2_fs_op key derivation, NOT user-overridable). A row
        // here is committed ATOMICALLY with the heap manifest at checkpoint, so a cold restore sees
        // the file namespace at the exact same version as the heap (staged-commit coherence).
        store
            .exec(
                "CREATE TABLE IF NOT EXISTS fs_files (path TEXT PRIMARY KEY, r2_key TEXT, size INTEGER, cell INTEGER, created_ms INTEGER);",
                None,
            )
            .expect("create fs_files");

        let cur = read_int(&store, "generation", 0);
        let generation = cur + 1;
        write_meta(&store, "generation", &generation.to_string());
        let do_id = state.id().to_string();

        // AUTH: resolve the shared key(s) + enforce flag ONCE from env. Read here only — the value
        // is held in plain struct fields and never persisted (not in meta/manifest/oplog/heap).
        let auth_keys: Vec<String> = env
            .secret("ENGRAM_KERNEL_KEY")
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        // FAIL-CLOSED: once a key is configured, ENFORCE by default. The env var can only
        // explicitly DISABLE it via "0" — an absent/unset var (e.g. a deploy that forgot to
        // export it) must NOT silently open the kernel. With NO key configured, enforcement is
        // meaningless (nothing to check against), so it stays off regardless of the var.
        let auth_enforce = if auth_keys.is_empty() {
            false
        } else {
            env.var("ENGRAM_AUTH_ENFORCE")
                .ok()
                .map(|v| v.to_string())
                .map(|s| s.trim() != "0")
                .unwrap_or(true)
        };

        Self {
            state,
            env,
            generation,
            do_id,
            glue: RefCell::new(None),
            mutex: new_mutex(),
            auth_keys,
            auth_enforce,
            staged_fs: Rc::new(RefCell::new(Vec::new())),
        }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        if req.headers().get("Upgrade")?.as_deref() == Some("websocket") {
            // AUTH at upgrade time. Token present+invalid -> 401 WITHOUT accepting (cheapest
            // rejection; no actor work, no SSRF surface). Token present+valid -> accept + mark
            // authed in the hibernation-safe attachment. Token absent -> accept but authed:false
            // (the credential-less browser path completes via the first-message {t:auth} gate).
            let (token, via_subproto) = extract_token(&req);
            let token_present = !token.is_empty();
            let valid = token_valid(&token, &self.auth_keys);
            if self.auth_enforce && token_present && !valid {
                self.emit_unauth("ws-upgrade");
                return Response::error("unauthorized", 401);
            }
            if token_present && !valid {
                // log-only mode: note it but still serve.
                self.emit_unauth("ws-upgrade");
            }
            let pair = WebSocketPair::new()?;
            let server = pair.server;
            self.state.accept_web_socket(&server);
            // authed iff a valid token was presented at upgrade; otherwise pending first-message auth.
            let _ = server.serialize_attachment(AuthState { authed: valid });
            if let Ok(rp) = WebSocketRequestResponsePair::new("ping", "pong") {
                self.state.set_websocket_auto_response(&rp);
            }
            let mut resp = Response::from_websocket(pair.client)?;
            if via_subproto && valid {
                // Echo only the app subprotocol; NEVER echo the token entry back.
                let _ = resp
                    .headers_mut()
                    .set("Sec-WebSocket-Protocol", "engram.v1");
            }
            return Ok(resp);
        }
        // FACET RPC seam: a POST /frame with a JSON {t:...} body runs one protocol frame and
        // returns the reply JSON. This is the proxy-model entry the supervisor uses when the
        // kernel runs as a DO FACET (a facet-held client WebSocket does not work, so the
        // supervisor holds the socket and RPCs each frame in via stub.fetch). Same dispatch as
        // websocket_message -> handle(). Harmless to the standalone WS path.
        let mut req = req;
        if req.method() == Method::Post && req.path().ends_with("/frame") {
            {
                {
                    // POST /frame requires a valid key header (Authorization: Bearer / x-api-key).
                    let (token, _) = extract_token(&req);
                    let valid = token_valid(&token, &self.auth_keys);
                    if !valid {
                        self.emit_unauth("frame");
                        if self.auth_enforce {
                            return Response::error("unauthorized", 401);
                        }
                    }
                    let body = req.text().await.unwrap_or_else(|_| "{}".into());
                    let reply = match serde_json::from_str::<serde_json::Value>(&body) {
                        Ok(msg) => self
                            .handle(msg)
                            .await
                            .unwrap_or_else(|e| json!({"ok": false, "error": format!("{e}")})),
                        Err(_) => json!({"ok": false, "error": "bad json"}),
                    };
                    return Response::from_json(&reply);
                }
            }
        }
        Response::ok(
            "engram-rust kernel: connect a websocket; {t:create|eval|reset|gen|ping|evict}\n",
        )
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
        let msg = match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(m) => m,
            Err(_) => {
                ws.send_with_str("{\"ok\":false,\"error\":\"bad json\"}")?;
                return Ok(());
            }
        };
        let t = msg.get("t").and_then(|v| v.as_str()).unwrap_or("");

        // AUTH GATE (before ANY dispatch, incl. hostcall-result). Auth lives in the hibernatable
        // socket attachment (survives eviction; never in the heap snapshot). If not authed, the
        // ONLY honored frame is {t:"auth",token}; anything else closes the socket 1008.
        let authed = ws
            .deserialize_attachment::<AuthState>()
            .ok()
            .flatten()
            .map(|a| a.authed)
            .unwrap_or(false);
        if !authed {
            if t == "auth" {
                let token = msg.get("token").and_then(|v| v.as_str()).unwrap_or("");
                if token_valid(token, &self.auth_keys) {
                    let _ = ws.serialize_attachment(AuthState { authed: true });
                    ws.send_with_str("{\"ok\":true,\"t\":\"auth\"}")?;
                    return Ok(());
                }
                // invalid token presented to the auth frame.
                self.emit_unauth("ws-auth");
                if self.auth_enforce {
                    ws.close(Some(1008u16), Some("unauthorized"))?;
                    return Ok(());
                }
                // log-only: accept the auth attempt as a no-op so the client proceeds.
                ws.send_with_str("{\"ok\":true,\"t\":\"auth\"}")?;
                return Ok(());
            }
            // not authed and frame is not {t:auth}.
            self.emit_unauth(t);
            if self.auth_enforce {
                ws.close(Some(1008u16), Some("unauthorized"))?;
                return Ok(());
            }
            // log-only: fall through and serve the frame as before (nothing breaks).
        }

        // HOST-CALLBACK RESULT: a client's reply to a mid-eval {t:hostcall}. It MUST be
        // resolved WITHOUT acquiring self.mutex — the mutex is held by the suspended eval
        // that is awaiting this very reply (re-entrant deadlock otherwise; mirrors BUG-1).
        // No eval reply is sent for this frame; the parked VM promise resumes and the
        // original {t:eval} reply (sent later by eval_critical) carries the result.
        if t == "hostcall-result" {
            let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let ok = msg.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let value_json = msg
                .get("value")
                .map(|v| serde_json::to_string(v).unwrap_or_default())
                .unwrap_or_default();
            let error = msg.get("error").and_then(|v| v.as_str()).unwrap_or("");
            resolve_host_call(id, ok, &value_json, error);
            return Ok(());
        }

        let reply = self
            .handle_with_ws(msg, Some(&ws))
            .await
            .unwrap_or_else(|e| json!({"ok": false, "error": format!("{e}")}));
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

/// V0.5 OBSERVABILITY parity: one Analytics Engine datapoint per op. Mirrors the JS
/// kernel (apps/kernel/src/lib.rs): blobs op/restoreSource/store/errorName/valueType/label,
/// doubles totalServerMs/readMs/sizeRaw/sizeGz/usedHeap/cell/generation/ok. Fire-and-forget.
#[derive(Default)]
struct Datapoint {
    op: String,
    restore_source: String,
    store: String,
    error_name: String,
    value_type: String,
    label: String,
    total_server_ms: f64,
    read_ms: f64,
    size_raw: i64,
    size_gz: i64,
    used_heap: i64,
    cell: i64,
    ok: bool,
}
impl Datapoint {
    fn new(op: &str) -> Self {
        Datapoint {
            op: op.into(),
            ok: true,
            cell: -1,
            ..Default::default()
        }
    }
}

impl KernelDO {
    /// Emit a structured Workers-Logs line + a best-effort AE datapoint. Never perturbs the op.
    fn emit(&self, dp: &Datapoint) {
        let log = json!({
            "ev": "op", "op": dp.op, "doId": self.do_id,
            "restoreSource": dp.restore_source, "store": dp.store,
            "errorName": dp.error_name, "valueType": dp.value_type, "label": dp.label,
            "totalServerMs": dp.total_server_ms, "readMs": dp.read_ms,
            "sizeRaw": dp.size_raw, "sizeGz": dp.size_gz, "usedHeap": dp.used_heap,
            "cell": dp.cell, "generation": self.generation, "ok": dp.ok,
        });
        console_log(&log.to_string());
        let _ = self.write_ae(dp);
    }

    /// AUTH observability: emit an AE datapoint + log line with errorName=unauthorized.
    /// `op` carries the rejected context (ws-upgrade / ws-auth / frame / the frame `t`).
    fn emit_unauth(&self, op: &str) {
        let mut dp = Datapoint::new(op);
        dp.error_name = "unauthorized".into();
        dp.ok = false;
        dp.label = if self.auth_enforce {
            "enforce".into()
        } else {
            "log-only".into()
        };
        self.emit(&dp);
    }

    fn write_ae(&self, dp: &Datapoint) -> std::result::Result<(), JsValue> {
        let env: &JsValue = self.env.as_ref();
        let ae = Reflect::get(env, &JsValue::from_str("AE"))?;
        if ae.is_undefined() || ae.is_null() {
            return Ok(()); // binding absent (local dev) — no-op.
        }
        let write_fn: js_sys::Function =
            Reflect::get(&ae, &JsValue::from_str("writeDataPoint"))?.dyn_into()?;

        let indexes = js_sys::Array::new();
        indexes.push(&JsValue::from_str(&self.do_id));

        let blobs = js_sys::Array::new();
        blobs.push(&JsValue::from_str(&dp.op));
        blobs.push(&JsValue::from_str(&dp.restore_source));
        blobs.push(&JsValue::from_str(&dp.store));
        blobs.push(&JsValue::from_str(&dp.error_name));
        blobs.push(&JsValue::from_str(&dp.value_type));
        blobs.push(&JsValue::from_str(&dp.label));

        let doubles = js_sys::Array::new();
        doubles.push(&JsValue::from_f64(dp.total_server_ms));
        doubles.push(&JsValue::from_f64(dp.read_ms));
        doubles.push(&JsValue::from_f64(dp.size_raw as f64));
        doubles.push(&JsValue::from_f64(dp.size_gz as f64));
        doubles.push(&JsValue::from_f64(dp.used_heap as f64));
        doubles.push(&JsValue::from_f64(dp.cell as f64));
        doubles.push(&JsValue::from_f64(self.generation as f64));
        doubles.push(&JsValue::from_f64(if dp.ok { 1.0 } else { 0.0 }));

        let point = js_sys::Object::new();
        Reflect::set(&point, &JsValue::from_str("indexes"), &indexes)?;
        Reflect::set(&point, &JsValue::from_str("blobs"), &blobs)?;
        Reflect::set(&point, &JsValue::from_str("doubles"), &doubles)?;
        write_fn.call1(&ae, &point)?;
        Ok(())
    }

    /// The kernel's durable store, behind the `KernelStore` seam. Today this is the CF DO SQLite
    /// backend (`DoSqlStore`); swapping to Rivet/Postgres/test means returning a different impl
    /// here — no call site changes. This is the single point that names the CF-proprietary handle.
    fn store(&self) -> DoSqlStore {
        DoSqlStore::new(self.state.storage().sql())
    }

    fn r2_key_for(&self, cell: i64, epoch: i64) -> String {
        format!("benchrustf/{}/e{}-c{}.qjs.gz", self.do_id, epoch, cell)
    }

    /// Circuit-breaker: is R2 currently considered degraded (skip it, go straight to oplog replay)?
    /// State persists across DO requests in `meta`; cooldown uses wall-clock (advances between turns).
    fn r2_breaker_open(&self) -> bool {
        let store = self.store();
        let open_until = read_int(&store, R2_BREAKER_OPEN_UNTIL_KEY, 0);
        open_until > 0 && (now_ms() as i64) < open_until
    }

    fn r2_breaker_record_failure(&self) {
        let store = self.store();
        let fails = read_int(&store, R2_BREAKER_FAILS_KEY, 0) + 1;
        write_meta(&store, R2_BREAKER_FAILS_KEY, &fails.to_string());
        if fails >= R2_BREAKER_TRIP_AT {
            let open_until = (now_ms() + R2_BREAKER_COOLDOWN_MS) as i64;
            write_meta(&store, R2_BREAKER_OPEN_UNTIL_KEY, &open_until.to_string());
            console_log(&format!(
                "[r2-breaker] OPEN after {fails} consecutive failures; cooldown {}ms",
                R2_BREAKER_COOLDOWN_MS as i64
            ));
        }
    }

    fn r2_breaker_record_success(&self) {
        let store = self.store();
        if read_int(&store, R2_BREAKER_FAILS_KEY, 0) != 0
            || read_int(&store, R2_BREAKER_OPEN_UNTIL_KEY, 0) != 0
        {
            write_meta(&store, R2_BREAKER_FAILS_KEY, "0");
            write_meta(&store, R2_BREAKER_OPEN_UNTIL_KEY, "0");
        }
    }

    /// Resilient R2 GET for the snapshot overflow image: retry-with-(deterministic)-backoff +
    /// per-attempt timeout, distinguishing a transient failure (→ retry, then `Exhausted` keeping the
    /// session intact) from a durable miss (404-class → `Missing`). Never bubbles a 500 that the
    /// client would read as "no session, create fresh". Determinism preserved (fixed backoffs, R2
    /// reads add no entropy). The image body is read whole (range/streamed read deferred — see #10
    /// notes; SQLITE_HOT_MAX=8MB keeps most images off this path entirely).
    async fn r2_get_resilient(&self, key: &str) -> R2Read {
        for attempt in 0..R2_GET_ATTEMPTS {
            if attempt > 0 {
                let backoff = R2_GET_BACKOFF_MS
                    .get(attempt - 1)
                    .copied()
                    .unwrap_or(*R2_GET_BACKOFF_MS.last().unwrap());
                Delay::from(Duration::from_millis(backoff)).await;
            }
            let bucket = match self.env.bucket("SNAPSHOTS") {
                Ok(b) => b,
                Err(e) => {
                    console_log(&format!(
                        "[r2-get] bucket bind failed (attempt {attempt}): {e:?}"
                    ));
                    continue;
                }
            };
            // Race the GET (head + body read) against a per-attempt timeout.
            let fut = async {
                let obj = bucket.get(key).execute().await?;
                let obj = match obj {
                    Some(o) => o,
                    None => return Ok::<Option<Uint8Array>, worker::Error>(None), // durable miss
                };
                let body = match obj.body() {
                    Some(b) => b,
                    None => return Ok(None),
                };
                let bytes = body.bytes().await?;
                let arr = Uint8Array::new_with_length(bytes.len() as u32);
                arr.copy_from(&bytes);
                Ok(Some(arr))
            };
            match race_timeout(fut, R2_GET_TIMEOUT_MS).await {
                Some(Ok(Some(arr))) => {
                    self.r2_breaker_record_success();
                    return R2Read::Got(arr);
                }
                Some(Ok(None)) => {
                    // Durable miss: NOT transient. Don't burn retries; recover via oplog replay.
                    console_log(&format!("[r2-get] durable miss for key {key}"));
                    self.r2_breaker_record_success();
                    return R2Read::Missing;
                }
                Some(Err(e)) => {
                    console_log(&format!(
                        "[r2-get] transient error attempt {attempt}: {e:?}"
                    ));
                }
                None => {
                    console_log(&format!(
                        "[r2-get] timeout (>{}ms) attempt {attempt}",
                        R2_GET_TIMEOUT_MS
                    ));
                }
            }
        }
        self.r2_breaker_record_failure();
        console_log(&format!(
            "[r2-get] EXHAUSTED {R2_GET_ATTEMPTS} attempts for key {key}"
        ));
        R2Read::Exhausted
    }

    /// No-ws entry (HTTP /frame / facet proxy path). Host callbacks are unavailable
    /// here (no held client socket), so a non-fetch host.<name> call rejects cleanly.
    async fn handle(&self, msg: serde_json::Value) -> Result<serde_json::Value> {
        self.handle_with_ws(msg, None).await
    }

    async fn handle_with_ws(
        &self,
        msg: serde_json::Value,
        ws: Option<&WebSocket>,
    ) -> Result<serde_json::Value> {
        let t = msg.get("t").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "gen" => {
                let store = self.store();
                Ok(json!({
                    "ok": true, "t": "gen",
                    "generation": self.generation,
                    "inMemory": self.glue.borrow().is_some(),
                    "epoch": read_int(&store, "epoch", 0),
                    "committedCell": read_int(&store, "committedCell", -1),
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
                let res = self.eval_critical(&msg, ws).await;
                let _ = js_sys::Function::from(release).call0(&JsValue::NULL);
                res
            }
            "artifact" => {
                let release = JsFuture::from(self.mutex.acquire()).await.map_err(to_err)?;
                let res = self.artifact_critical(&msg).await;
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
            "_forceEngineMismatch" => {
                // TEST-ONLY (E6 engine-migration): rewrite the committed manifest's engine_hash to
                // a bogus value + drop the in-memory glue, so the next eval cold-restores via the
                // OPLOG-REPLAY path (the byte-blit image is "from a different engine"). Proves the
                // engine-migration journal replay works without a real redeploy.
                let taken = self.glue.borrow_mut().take();
                if let Some(g) = taken {
                    g.drop_kernel();
                }
                self.store().exec_ignore(
                    "UPDATE snap_manifest SET engine_hash='STALE-ENGINE-HASH' WHERE id=1;",
                    None,
                );
                Ok(json!({"ok": true, "t": "_forceEngineMismatch", "generation": self.generation}))
            }
            "health" => Ok(json!({"ok": true, "t": "health", "generation": self.generation})),
            other => Ok(json!({"ok": false, "error": format!("unknown msg type {other}")})),
        }
    }

    async fn create_critical(&self, msg: &serde_json::Value) -> Result<serde_json::Value> {
        let cfg = msg.get("config").cloned().unwrap_or_else(|| json!({}));
        // EXTENSIBILITY API — REDUCED Phase 1 (#32): validate config.extensions BEFORE persisting.
        // CLIENT backend only (http/worker rejected); reject __-prefixed / built-in-shadowing names;
        // cap manifest size. A failure returns a typed {ok:false} create reply (socket stays alive),
        // never persists a bad manifest. Zero engine change (discoverability is glue-seeded).
        if let Some(err) = validate_extensions(&cfg) {
            return Ok(json!({
                "ok": false, "t": "create",
                "valueType": "error",
                "error": err,
                "generation": self.generation,
            }));
        }
        let cfg_str = serde_json::to_string(&cfg).unwrap_or_else(|_| "{}".into());
        if let Some(err) = persist_config(&self.store(), &cfg_str) {
            return Ok(json!({
                "ok": false, "t": "create",
                "valueType": "error",
                "error": err,
                "generation": self.generation,
            }));
        }
        let info = self.ensure_glue().await?;
        let mut dp = Datapoint::new("create");
        dp.restore_source = info.source.clone();
        dp.read_ms = info.read_ms;
        dp.total_server_ms = info.total_server_ms;
        self.emit(&dp);
        Ok(json!({
            "ok": true, "t": "create",
            "config": cfg,
            "generation": self.generation,
            "restoreSource": info.source,
            "restoreTimings": restore_timings_value(&info),
        }))
    }

    async fn eval_critical(
        &self,
        msg: &serde_json::Value,
        ws: Option<&WebSocket>,
    ) -> Result<serde_json::Value> {
        let src = msg.get("src").and_then(|v| v.as_str()).unwrap_or("");
        let before = self.glue.borrow().is_some();

        // first-eval config (only if none yet). Apply the SAME validation as create_critical so an
        // eval-first `{t:eval,config:{...}}` frame cannot bypass the extension name-shadow / __-prefix
        // / manifest-size guards, and reject an oversize config BEFORE write_meta (which would
        // otherwise panic on SQLITE_TOOBIG -> DoS). A validation/size failure returns a typed
        // {ok:false} eval reply (socket stays alive), never persists a bad config.
        if !before {
            if let Some(cfg) = msg.get("config") {
                if read_str(&self.store(), "config").is_none() {
                    if let Some(err) = validate_extensions(cfg) {
                        return Ok(json!({
                            "ok": false, "t": "eval",
                            "valueType": "error",
                            "error": err,
                            "generation": self.generation,
                        }));
                    }
                    let cfg_str = serde_json::to_string(cfg).unwrap_or_else(|_| "{}".into());
                    if let Some(err) = persist_config(&self.store(), &cfg_str) {
                        return Ok(json!({
                            "ok": false, "t": "eval",
                            "valueType": "error",
                            "error": err,
                            "generation": self.generation,
                        }));
                    }
                }
            }
        }

        let info = self.ensure_glue().await?;

        // HOST-CALLBACK BRIDGE: install a per-eval sender on the glue so a non-fetch
        // host.<name>(...) call round-trips to the connected client over THIS ws. The
        // sender is a JS closure that ws.send's the {t:hostcall} frame out-of-band; the
        // client's {t:hostcall-result} reply is demuxed in websocket_message (no mutex)
        // and resolves the parked VM call. When ws is None (HTTP /frame / facet path) we
        // clear the sender, so non-fetch host calls reject cleanly (no held client socket).
        {
            let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
            if let Some(ws) = ws {
                let ws_for_send: WebSocket = ws.clone();
                let sender = Closure::wrap(Box::new(move |frame: JsValue| -> JsValue {
                    let s = frame.as_string().unwrap_or_default();
                    let ok = ws_for_send.send_with_str(&s).is_ok();
                    JsValue::from_bool(ok)
                })
                    as Box<dyn FnMut(JsValue) -> JsValue>);
                glue.set_host_sender(sender.as_ref().unchecked_ref(), 60000.0);
                // Leak the closure for the lifetime of this eval; it is replaced/cleared on
                // the next eval. (One small closure per eval; bounded by serialized evals.)
                sender.forget();
            } else {
                glue.set_host_sender(&JsValue::NULL, 0.0);
            }
        }

        // FS PROVIDER: when config.fs.provider == "r2", install a DO-side handler for the
        // engine's `host.__fs` effect. R2 is a DO binding (env), NOT a glue global, so it must
        // be serviced here (unlike host.fetch). The handler is an async JS closure returning a
        // Promise; the glue awaits it from the eval pump. provider == vfs (default) clears the
        // handler (in-heap fs). COHERENCE: writes/deletes are STAGED in DO memory (self.staged_fs)
        // and flushed to R2 + the committed `fs_files` table only at checkpoint, in the SAME commit
        // as the heap dump (SANDBOX-API staged-commit invariant). Reads within a cell see the
        // committed namespace (captured below) OVERLAID with this cell's staged ops.
        // ISOLATION: the R2 key prefix is ALWAYS `fs/<doId>/` — derived from the DO id, NEVER from
        // user config — so a session can never address another session's fs namespace.
        {
            let cfg: serde_json::Value = serde_json::from_str(
                &read_str(&self.store(), "config").unwrap_or_else(|| "{}".into()),
            )
            .unwrap_or_else(|_| json!({}));
            let fsv = cfg
                .get("fs")
                .and_then(|f| f.get("provider"))
                .and_then(|v| v.as_str())
                .unwrap_or("vfs");
            let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
            if fsv == "r2" {
                // Bucket binding is user-selectable (which R2 bucket), but the KEY PREFIX is not.
                let binding = cfg
                    .get("fs")
                    .and_then(|f| f.get("binding"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("SNAPSHOTS")
                    .to_string();
                // Per-session prefix is hard-bound to the DO id (isolation invariant); any user
                // `config.fs.prefix` is intentionally IGNORED.
                let prefix = format!("fs/{}/", self.do_id);
                // Snapshot the committed path namespace so in-cell reads/list/stat see prior cells'
                // files overlaid with this cell's staged ops. Cheap (paths + sizes, no bodies).
                let committed = self.read_fs_committed();
                let env = self.env.clone();
                let staged = self.staged_fs.clone();
                // Fresh cell => discard any leftover staged ops from a prior (failed/rolled-back) cell.
                staged.borrow_mut().clear();
                let handler = Closure::wrap(Box::new(move |payload: JsValue| -> js_sys::Promise {
                    let env = env.clone();
                    let binding = binding.clone();
                    let prefix = prefix.clone();
                    let staged = staged.clone();
                    let committed = committed.clone();
                    wasm_bindgen_futures::future_to_promise(async move {
                        r2_fs_op(&env, &binding, &prefix, &staged, &committed, payload).await
                    })
                })
                    as Box<dyn FnMut(JsValue) -> js_sys::Promise>);
                glue.set_fs_handler(handler.as_ref().unchecked_ref());
                handler.forget();
            } else {
                glue.set_fs_handler(&JsValue::NULL);
            }
        }

        // EXTENSIBILITY API — REDUCED Phase 1 (#32): install a per-eval AE sink so the glue can emit
        // ONE datapoint per ext call (op="ext:<name>"). Mirrors the host-sender install (a 'static
        // closure capturing env+do_id+generation). Cleared to NULL on the no-ws path.
        {
            let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
            if ws.is_some() {
                let env = self.env.clone();
                let do_id = self.do_id.clone();
                let generation = self.generation;
                let sink = Closure::wrap(Box::new(move |op: JsValue| {
                    let op = op.as_string().unwrap_or_default();
                    write_ext_ae(&env, &do_id, generation, &op);
                }) as Box<dyn FnMut(JsValue)>);
                glue.set_ext_ae_sink(sink.as_ref().unchecked_ref());
                sink.forget();
            } else {
                glue.set_ext_ae_sink(&JsValue::NULL);
            }
        }

        // FETCH FENCE: install the deterministic (doId, cell) identity so host.fetch can derive a
        // stable Idempotency-Key per (session, cell, in-cell fetch ordinal); replay reproduces it.
        {
            let cell_now = read_int(&self.store(), "committedCell", -1) + 1;
            let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
            glue.set_fence_context(&self.do_id, cell_now as f64);
        }

        // eval (async; cell may await host.fetch OR a client host-callback). Returns rich
        // JSON; never throws.
        let eval_promise = {
            let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
            glue.eval_code(src)
        };
        let eval_json = JsFuture::from(eval_promise)
            .await
            .map_err(to_err)?
            .as_string()
            .unwrap_or_else(|| "{\"ok\":true,\"value\":null}".to_string());
        let mut parsed: serde_json::Value = match serde_json::from_str(&eval_json) {
            Ok(v) => v,
            Err(e) => json!({
                "ok": false,
                "valueType": "error",
                "error": {
                    "name": "ProtocolSizeError",
                    "message": format!("eval result JSON was invalid or truncated ({} bytes): {e}", eval_json.len()),
                },
            }),
        };

        // allocate the next cell inside the critical section, then checkpoint.
        let store = self.store();
        let cell = read_int(&store, "committedCell", -1) + 1;
        let epoch = read_int(&store, "epoch", 0);
        let has_artifacts = stamp_artifact_handles(&mut parsed, cell);
        let ckpt = match self.checkpoint(cell, epoch, src).await {
            Ok(v) => v,
            Err(e) => json!({ "ok": false, "error": format!("{e}") }),
        };
        let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(true);
        if ckpt.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            let artifact_cell = if has_artifacts {
                cell.to_string()
            } else {
                "-1".to_string()
            };
            write_meta(&store, "lastArtifactCell", &artifact_cell);
        }

        // V0.5: per-eval AE datapoint (op/restoreSource/store/sizeGz/usedHeap/cell/ok + valueType).
        let mut dp = Datapoint::new("eval");
        dp.cell = cell;
        dp.ok = ok;
        dp.restore_source = info.source.clone();
        dp.read_ms = info.read_ms;
        dp.total_server_ms = info.total_server_ms;
        dp.value_type = parsed
            .get("valueType")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        dp.error_name = parsed
            .get("error")
            .and_then(|e| e.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        dp.store = ckpt
            .get("store")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        dp.size_raw = ckpt.get("sizeRaw").and_then(|v| v.as_i64()).unwrap_or(0);
        dp.size_gz = ckpt.get("sizeGz").and_then(|v| v.as_i64()).unwrap_or(0);
        dp.used_heap = ckpt.get("usedHeap").and_then(|v| v.as_i64()).unwrap_or(0);
        self.emit(&dp);

        Ok(json!({
            "ok": ok, "t": "eval",
            "value": parsed.get("value").cloned().unwrap_or(serde_json::Value::Null),
            "valuePreview": parsed.get("valuePreview").cloned().unwrap_or(serde_json::Value::Null),
            "valueType": parsed.get("valueType").cloned().unwrap_or(serde_json::Value::Null),
            "mimeBundle": parsed.get("mimeBundle").cloned().unwrap_or(serde_json::Value::Null),
            "outputs": parsed.get("outputs").cloned().unwrap_or_else(|| json!([])),
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

    async fn artifact_critical(&self, msg: &serde_json::Value) -> Result<serde_json::Value> {
        let handle = msg.get("handle").and_then(|v| v.as_str()).unwrap_or("");
        let Some((cell, artifact_id)) = parse_artifact_handle(handle) else {
            return Ok(json!({
                "ok": false,
                "t": "artifact",
                "error": { "name": "ArtifactError", "message": "malformed artifact handle" },
            }));
        };

        let committed = read_int(&self.store(), "committedCell", -1);
        let artifact_cell = read_int(&self.store(), "lastArtifactCell", -1);
        if cell != committed || cell != artifact_cell {
            return Ok(json!({
                "ok": false,
                "t": "artifact",
                "handle": handle,
                "error": {
                    "name": "ArtifactError",
                    "message": format!("stale or unknown artifact handle for cell {cell}; committed cell is {committed}"),
                },
            }));
        }

        let offset = msg
            .get("offset")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            .max(0);
        let len = msg
            .get("len")
            .and_then(|v| v.as_i64())
            .unwrap_or(TEXT_ARTIFACT_CHUNK_MAX_CHARS)
            .clamp(0, TEXT_ARTIFACT_CHUNK_MAX_CHARS);

        let _ = self.ensure_glue().await?;
        let chunk_json = {
            let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
            glue.result_artifact_chunk(&artifact_id, offset as f64, len as f64)
        };
        let mut parsed: serde_json::Value = match serde_json::from_str(&chunk_json) {
            Ok(v) => v,
            Err(e) => json!({
                "ok": false,
                "t": "artifact",
                "handle": handle,
                "error": {
                    "name": "ArtifactError",
                    "message": format!("artifact chunk JSON was invalid or truncated ({} bytes): {e}", chunk_json.len()),
                },
            }),
        };
        if let Some(obj) = parsed.as_object_mut() {
            obj.insert("handle".to_string(), json!(handle));
        }
        Ok(parsed)
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
        let store = self.store();
        store.exec_ignore("DELETE FROM snap_chunks;", None);
        store.exec_ignore("DELETE FROM delta_chunks;", None);
        store.exec_ignore("DELETE FROM oplog;", None);
        store.exec_ignore("DELETE FROM snap_manifest;", None);
        if let Ok(bucket) = self.env.bucket("SNAPSHOTS") {
            if let Some(k) = r2_key {
                let _ = bucket.delete(&k).await;
            }
        }
        let epoch = read_int(&store, "epoch", 0) + 1;
        write_meta(&store, "epoch", &epoch.to_string());
        write_meta(&store, "committedCell", "-1");
        write_meta(&store, "lastArtifactCell", "-1");
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
        let cfg_str = read_str(&self.store(), "config").unwrap_or_else(|| "{}".into());
        let mut read_ms = 0.0_f64;
        let mut timings_json = String::from("{}");

        let manifest = self.read_manifest();
        let source = if let Some(m) = manifest {
            let is_r2 = m.store == "r2";
            // R2 OVERFLOW RESTORE (issue #10): a transient R2 hiccup MUST NOT bubble a 500 that the
            // client reads as "no session" and answers with a state-wiping {t:create}. Read R2 with
            // retry/backoff/timeout + circuit-breaker; on a durable miss OR exhausted retries OR an
            // open breaker, keep the session INTACT and recover via the oplog-replay path below
            // (never create-fresh). `gz=None` signals "could not load the byte image — replay".
            let mut r2_replay_reason: Option<&'static str> = None;
            let gz: Option<Uint8Array> = if is_r2 {
                if self.r2_breaker_open() {
                    console_log("[r2-get] breaker OPEN — skipping R2, routing to oplog replay");
                    r2_replay_reason = Some("r2-breaker-open-replay");
                    None
                } else {
                    match self.r2_get_resilient(&m.r2_key).await {
                        R2Read::Got(arr) => Some(arr),
                        R2Read::Missing => {
                            r2_replay_reason = Some("r2-missing-replay");
                            None
                        }
                        R2Read::Exhausted => {
                            r2_replay_reason = Some("r2-unavailable-replay");
                            None
                        }
                    }
                }
            } else {
                Some(self.read_chunks(m.n_chunks)?)
            };
            read_ms = now_ms() - t0;

            // R2-UNAVAILABLE FALLBACK: byte image unreadable but the session is durable — recover by
            // replaying the committed oplog tail into a fresh instance (no re-fire of host effects).
            // This is the data-loss fix: failure mode is "temporarily recovered via replay", NOT "gone".
            if is_r2 && gz.is_none() {
                let journal = self.read_oplog();
                let _ = JsFuture::from(glue.replay_journal(journal.as_ref(), &cfg_str, &m.kv_json))
                    .await
                    .map_err(to_err)?;
                timings_json = glue.last_restore_timings();
                r2_replay_reason
                    .unwrap_or("r2-unavailable-replay")
                    .to_string()
            }
            // E6 ENGINE-MIGRATION: if the committed snapshot was written by a DIFFERENT engine
            // build, the byte-blit image is invalid (different layout). Replay the oplog tail into
            // a FRESH instance under the same config instead of wedging. Pure cells re-run; host
            // effects are fed back from the recorded oplog (no re-fire).
            else if !m.engine_hash.is_empty() && m.engine_hash != get_engine_hash() {
                let journal = self.read_oplog();
                let _ = JsFuture::from(glue.replay_journal(journal.as_ref(), &cfg_str, &m.kv_json))
                    .await
                    .map_err(to_err)?;
                timings_json = glue.last_restore_timings();
                "engine-migration-replay".to_string()
            } else {
                let label = if is_r2 {
                    "r2-restore"
                } else {
                    "sqlite-restore"
                };
                let delta_list = self.read_delta_chain(m.delta_seq)?;
                match JsFuture::from(glue.restore_w4(
                    gz.expect("gz image present on the non-replay restore path"),
                    delta_list.as_ref(),
                    &m.engine_hash,
                    m.clock_calls as f64,
                    m.rng_calls as f64,
                    &cfg_str,
                    label,
                    &m.kv_json,
                    m.used_heap as f64,
                    m.final_crc as f64,
                    m.size_raw as f64,
                    &m.snap_codec,
                ))
                .await
                {
                    Ok(src) => {
                        timings_json = glue.last_restore_timings();
                        src.as_string().unwrap_or_else(|| label.into())
                    }
                    Err(_) => {
                        // SANITY-PROBE FALLBACK: the hot byte-blit failed its post-restore canary/GC
                        // probe (possible image corruption) — discard and replay the oplog tail into
                        // a fresh instance. Always correct; pure cells re-run, host effects fed back.
                        let journal = self.read_oplog();
                        let _ = JsFuture::from(glue.replay_journal(
                            journal.as_ref(),
                            &cfg_str,
                            &m.kv_json,
                        ))
                        .await
                        .map_err(to_err)?;
                        timings_json = glue.last_restore_timings();
                        "sanity-fallback-replay".to_string()
                    }
                }
            }
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

    /// W4 BYTE-DELTA checkpoint (docs/W4-BYTEDELTA-PLAN.md). The committed snapshot is a full
    /// (W5-compacted) BASE plus a chain of per-cell byte-deltas. A full base is forced when there
    /// is no prior snapshot OR the chain would reach BASE_EVERY (caps the restore chain length);
    /// glue.dumpW4 may ALSO downgrade to a full base (length change / dense mutation). Crash-atomic
    /// via DO synchronous write-coalescing; R2 swap-then-delete for the base overflow.
    /// `src` is the cell source (for the E6 oplog tail).
    async fn checkpoint(&self, cell: i64, epoch: i64, src: &str) -> Result<serde_json::Value> {
        const BASE_EVERY: i64 = 20;
        let prev = self.read_manifest();
        let force_full = match &prev {
            None => true,
            Some(m) => m.delta_seq + 1 >= BASE_EVERY,
        };

        let glue = clone_glue(self.glue.borrow().as_ref().unwrap());
        let dump = JsFuture::from(glue.dump_w4(force_full))
            .await
            .map_err(to_err)?;
        let mode = str_field(&dump, "mode").unwrap_or_else(|| "full".to_string());
        let gz: Uint8Array = Reflect::get(&dump, &JsValue::from_str("gz"))
            .map_err(to_err)?
            .into();
        let size_raw = num_field(&dump, "sizeRaw").unwrap_or(0.0) as i64;
        let size_gz = num_field(&dump, "sizeGz").unwrap_or(0.0) as i64;
        let used_heap = num_field(&dump, "usedHeap").unwrap_or(0.0) as i64;
        let scrubbed = Reflect::get(&dump, &JsValue::from_str("scrubbed"))
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let clock_calls = num_field(&dump, "clockCalls").unwrap_or(0.0) as i64;
        let rng_calls = num_field(&dump, "rngCalls").unwrap_or(0.0) as i64;
        let grain = num_field(&dump, "grain").unwrap_or(256.0) as i64;
        let n_changed = num_field(&dump, "nChanged").unwrap_or(0.0) as i64;
        let image_crc = num_field(&dump, "imageCrc").unwrap_or(0.0) as i64;
        let snap_codec = str_field(&dump, "snapCodec").unwrap_or_else(|| "gzip".to_string());
        let kv_json = str_field(&dump, "kvJson").unwrap_or_else(|| "{}".to_string());

        let mut bytes = vec![0u8; gz.length() as usize];
        gz.copy_to(&mut bytes);

        // E6 oplog row for this cell (host results captured during eval).
        let host_results = glue.last_cell_host_results();

        // (b) CHECKPOINT size: clamp every value we will BIND in the staged txn below SQLite's
        // ~2MB single-value cap, so the INSERT can never throw SQLITE_TOOBIG mid-commit. The oplog
        // `src` is the only unbounded text; an oversized cell is recorded as a non-replayable marker
        // (the byte-blit image stays the primary restore path; only engine-migration replay of THIS
        // cell would no-op). host_results is bounded by the engine HOSTCALL buffer, but clamp it too
        // as a belt-and-suspenders guard.
        let src: String = if src.len() > SQLITE_MAX_VALUE_BYTES {
            format!(
                "/* engram: cell source {}B omitted from oplog (exceeds SQLite value cap) */",
                src.len()
            )
        } else {
            src.to_string()
        };
        let src = src.as_str();
        let host_results = if host_results.len() > SQLITE_MAX_VALUE_BYTES {
            "[]".to_string()
        } else {
            host_results
        };

        let is_delta = mode == "delta" && prev.is_some();

        if is_delta {
            // ---- DELTA PATH: keep the base intact; append ONE delta row + bump delta_seq + oplog.
            let pm = prev.as_ref().unwrap();
            let idx_arr: Uint8Array = Reflect::get(&dump, &JsValue::from_str("indicesGz"))
                .map_err(to_err)?
                .into();
            let mut idx_bytes = vec![0u8; idx_arr.length() as usize];
            idx_arr.copy_to(&mut idx_bytes);
            let delta_seq_new = pm.delta_seq; // 0-based row seq == prior chain length
            let base_store = pm.store.clone();
            let base_r2_key = pm.r2_key.clone();
            let base_engine = pm.engine_hash.clone();
            let base_n_chunks = pm.n_chunks;
            let _base_size_raw = pm.size_raw; // superseded: delta tail stores its own reconstructed size_raw
            let base_size_gz = pm.size_gz;
            let base_codec = pm.snap_codec.clone(); // base blob's codec is unchanged by a delta append
            let oplog_seq = delta_seq_new + 1;
            let store = self.store();
            let txn = || -> Result<()> {
                store.exec(
                    "INSERT INTO delta_chunks(seq, payload, indices, grain, codec) VALUES (?,?,?,?,?);",
                    Some(vec![
                        delta_seq_new.into(),
                        bytes.clone().into(),
                        idx_bytes.clone().into(),
                        grain.into(),
                        snap_codec.clone().into(),
                    ]),
                )?;
                // append oplog tail row.
                store.exec(
                    "INSERT INTO oplog(seq,cell,src,host_results) VALUES (?,?,?,?);",
                    Some(vec![
                        oplog_seq.into(),
                        cell.into(),
                        src.into(),
                        host_results.clone().into(),
                    ]),
                )?;
                store.exec("DELETE FROM snap_manifest;", None)?;
                store.exec(
                    "INSERT INTO snap_manifest
                        (id,cell,epoch,n_chunks,size_raw,size_gz,engine_hash,clock_calls,rng_calls,
                         store,r2_key,created_ms,kv_json,used_heap,delta_seq,snap_mode,final_crc,snap_codec)
                     VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);",
                    Some(vec![
                        cell.into(),
                        epoch.into(),
                        base_n_chunks.into(),
                        // size_raw is the FULL reconstructed image length of THIS delta tail (the
                        // glue's imageLen), NOT the base length — restoreW4's CRC is over size_raw.
                        size_raw.into(),
                        base_size_gz.into(),
                        base_engine.clone().into(),
                        clock_calls.into(),
                        rng_calls.into(),
                        base_store.clone().into(),
                        base_r2_key.clone().into(),
                        now_ms().into(),
                        kv_json.clone().into(),
                        used_heap.into(),
                        (delta_seq_new + 1).into(),
                        "delta".to_string().into(),
                        image_crc.into(),
                        base_codec.clone().into(),
                    ]),
                )?;
                store.exec("INSERT INTO meta(k,v) VALUES('committedCell',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
                    Some(vec![cell.to_string().into()]))?;
                Ok(())
            };
            txn()?;
            // W4 commit-ordering: the delta row is now the committed chain tail — promote the staged
            // candidate to the live delta base so the NEXT diff is against exactly this image.
            glue.commit_dump();
            return Ok(json!({
                "ok": true, "cell": cell, "store": base_store, "mode": "delta",
                "nChunks": base_n_chunks, "deltaSeq": delta_seq_new + 1, "nChanged": n_changed,
                "grain": grain, "sizeRaw": size_raw, "sizeGz": size_gz, "usedHeap": used_heap,
                "scrubbed": scrubbed, "clockCalls": clock_calls, "rngCalls": rng_calls,
            }));
        }

        // ---- FULL BASE PATH (W5-compacted base; resets the delta chain + oplog) ----
        let old_r2_key: Option<String> = prev.as_ref().and_then(|m| {
            if m.store == "r2" && !m.r2_key.is_empty() {
                Some(m.r2_key.clone())
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

        let kstore = self.store();
        let r2_key_for_manifest = new_r2_key.clone();
        let txn = || -> Result<i64> {
            kstore.exec("DELETE FROM snap_chunks;", None)?;
            kstore.exec("DELETE FROM delta_chunks;", None)?;
            kstore.exec("DELETE FROM oplog;", None)?;
            kstore.exec("DELETE FROM snap_manifest;", None)?;
            let n_chunks = if to_r2 {
                0i64
            } else {
                let mut seq = 0i64;
                for chunk in bytes.chunks(CHUNK_BYTES) {
                    kstore.exec(
                        "INSERT INTO snap_chunks(seq,data) VALUES (?,?);",
                        Some(vec![seq.into(), chunk.to_vec().into()]),
                    )?;
                    seq += 1;
                }
                seq
            };
            // oplog: a full base is a fresh recovery point — seed the tail with THIS cell.
            kstore.exec(
                "INSERT INTO oplog(seq,cell,src,host_results) VALUES (0,?,?,?);",
                Some(vec![cell.into(), src.into(), host_results.clone().into()]),
            )?;
            kstore.exec(
                "INSERT INTO snap_manifest
                    (id,cell,epoch,n_chunks,size_raw,size_gz,engine_hash,clock_calls,rng_calls,
                     store,r2_key,created_ms,kv_json,used_heap,delta_seq,snap_mode,final_crc,snap_codec)
                 VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);",
                Some(vec![
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
                    0i64.into(),
                    "full".to_string().into(),
                    image_crc.into(),
                    snap_codec.clone().into(),
                ]),
            )?;
            kstore.exec("INSERT INTO meta(k,v) VALUES('committedCell',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
                Some(vec![cell.to_string().into()]))?;
            Ok(n_chunks)
        };
        let n_chunks = txn()?;
        // W4 commit-ordering: the full base is committed — promote the staged image to the live base.
        glue.commit_dump();

        if let Some(old) = old_r2_key {
            if old != new_r2_key {
                if let Ok(bucket) = self.env.bucket("SNAPSHOTS") {
                    let _ = bucket.delete(&old).await;
                }
            }
        }

        Ok(json!({
            "ok": true, "cell": cell, "store": store, "mode": "full", "nChunks": n_chunks,
            "deltaSeq": 0, "sizeRaw": size_raw, "sizeGz": size_gz, "usedHeap": used_heap,
            "scrubbed": scrubbed, "clockCalls": clock_calls, "rngCalls": rng_calls, "r2Key": new_r2_key,
        }))
    }

    fn read_manifest(&self) -> Option<Manifest> {
        let store = self.store();
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
            delta_seq: Option<i64>,
            #[serde(default)]
            size_raw: Option<i64>,
            #[serde(default)]
            size_gz: Option<i64>,
            #[serde(default)]
            final_crc: Option<i64>,
            #[serde(default)]
            snap_codec: Option<String>,
        }
        let rows: Vec<Row> = store
            .query_typed(
                "SELECT cell,epoch,n_chunks,engine_hash,clock_calls,rng_calls,store,r2_key,kv_json,used_heap,delta_seq,size_raw,size_gz,final_crc,snap_codec
                 FROM snap_manifest WHERE id=1 LIMIT 1;",
                None,
            )
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
            delta_seq: r.delta_seq.unwrap_or(0),
            size_raw: r.size_raw.unwrap_or(0),
            size_gz: r.size_gz.unwrap_or(0),
            final_crc: r.final_crc.unwrap_or(0),
            // back-compat: NULL/absent => "gzip" (pre-issue-#9 bases were gzip).
            snap_codec: r.snap_codec.filter(|c| !c.is_empty()).unwrap_or_else(|| "gzip".into()),
        })
    }

    // W4: read the committed delta chain as a JS Array of {gz, indicesGz, grain}.
    fn read_delta_chain(&self, delta_seq: i64) -> Result<js_sys::Array> {
        let out = js_sys::Array::new();
        if delta_seq <= 0 {
            return Ok(out);
        }
        let rows = self
            .store()
            .query_raw(
                "SELECT payload, indices, grain, codec FROM delta_chunks ORDER BY seq ASC;",
                None,
            )
            .map_err(|e| worker::Error::RustError(format!("read deltas: {e:?}")))?;
        let mut count = 0i64;
        for row in rows {
            let mut payload: Option<Vec<u8>> = None;
            let mut indices: Option<Vec<u8>> = None;
            let mut grain: i64 = 256;
            // issue #9: per-delta codec; NULL/absent => "gzip" (back-compat).
            let mut codec: String = "gzip".to_string();
            for (i, val) in row.into_iter().enumerate() {
                match (i, val) {
                    (0, store::StoreValue::Blob(b)) => payload = Some(b),
                    (1, store::StoreValue::Blob(b)) => indices = Some(b),
                    (2, store::StoreValue::Integer(n)) => grain = n,
                    (3, store::StoreValue::String(t)) => { if !t.is_empty() { codec = t; } }
                    _ => {}
                }
            }
            let p = payload.unwrap_or_default();
            let idx = indices.unwrap_or_default();
            let p_arr = Uint8Array::new_with_length(p.len() as u32);
            p_arr.copy_from(&p);
            let i_arr = Uint8Array::new_with_length(idx.len() as u32);
            i_arr.copy_from(&idx);
            let obj = js_sys::Object::new();
            Reflect::set(&obj, &JsValue::from_str("gz"), &p_arr).ok();
            Reflect::set(&obj, &JsValue::from_str("indicesGz"), &i_arr).ok();
            Reflect::set(
                &obj,
                &JsValue::from_str("grain"),
                &JsValue::from_f64(grain as f64),
            )
            .ok();
            Reflect::set(&obj, &JsValue::from_str("codec"), &JsValue::from_str(&codec)).ok();
            out.push(&obj);
            count += 1;
        }
        if count != delta_seq {
            return Err(worker::Error::RustError(format!(
                "CorruptDeltaError: delta count mismatch (manifest delta_seq={delta_seq}, read {count})"
            )));
        }
        Ok(out)
    }

    // E6: read the committed oplog tail (cells since the last full base) as a JS Array of
    // {src, hostResults}. Used for engine-migration replay on an engine-hash mismatch.
    fn read_oplog(&self) -> js_sys::Array {
        let out = js_sys::Array::new();
        #[derive(serde::Deserialize)]
        struct Row {
            src: String,
            host_results: String,
        }
        let rows: Vec<Row> = self
            .store()
            .query_typed(
                "SELECT src, host_results FROM oplog ORDER BY seq ASC;",
                None,
            )
            .unwrap_or_default();
        for r in rows {
            let obj = js_sys::Object::new();
            Reflect::set(&obj, &JsValue::from_str("src"), &JsValue::from_str(&r.src)).ok();
            let hr: JsValue = js_sys::JSON::parse(&r.host_results).unwrap_or(JsValue::NULL);
            Reflect::set(&obj, &JsValue::from_str("hostResults"), &hr).ok();
            out.push(&obj);
        }
        out
    }

    fn read_chunks(&self, n_chunks: i64) -> Result<Uint8Array> {
        let rows = self
            .store()
            .query_raw("SELECT data FROM snap_chunks ORDER BY seq ASC;", None)
            .map_err(|e| worker::Error::RustError(format!("read chunks: {e:?}")))?;
        let mut blobs: Vec<Vec<u8>> = Vec::new();
        for row in rows {
            for val in row {
                if let store::StoreValue::Blob(b) = val {
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
    epoch: i64,
    n_chunks: i64,
    engine_hash: String,
    clock_calls: i64,
    rng_calls: i64,
    store: String,
    r2_key: String,
    kv_json: String,
    used_heap: i64,
    delta_seq: i64,
    size_raw: i64,
    size_gz: i64,
    final_crc: i64,
    snap_codec: String,
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    let url = req.url()?;
    if url.path() == "/health" {
        return Response::ok("ok");
    }
    // Cheap pre-DO auth fast-path: if a credential IS present and invalid, 401 before spinning a
    // DO (garbage never mints a session). A credential-LESS request must still reach the DO so the
    // browser first-message {t:auth} path works. Only enforces when ENGRAM_AUTH_ENFORCE=1.
    {
        let keys: Vec<String> = env
            .secret("ENGRAM_KERNEL_KEY")
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        // FAIL-CLOSED: enforce whenever a key is configured unless ENGRAM_AUTH_ENFORCE=="0".
        let enforce = !keys.is_empty()
            && env
                .var("ENGRAM_AUTH_ENFORCE")
                .ok()
                .map(|v| v.to_string())
                .map(|s| s.trim() != "0")
                .unwrap_or(true);
        if enforce {
            let (token, _) = extract_token(&req);
            if !token.is_empty() && !token_valid(&token, &keys) {
                return Response::error("unauthorized", 401);
            }
        }
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

/// EXTENSIBILITY API — REDUCED Phase 1 (#32): validate config.extensions at create. Returns
/// Some(typed-error-json) on the FIRST violation, else None. Enforces: client-backend only
/// (http/worker rejected); each ext.name is a non-empty string, NOT __-prefixed, and does NOT
/// shadow a built-in host effect / namespace (fetch/ws/stream/__fs/host/...); manifest total size
/// capped. CUT (rejected): http/worker backends, binding:NAME credential injection.
fn validate_extensions(cfg: &serde_json::Value) -> Option<serde_json::Value> {
    const MAX_MANIFEST_BYTES: usize = 64 * 1024; // 64KB total manifest cap
    const MAX_EXTENSIONS: usize = 32;
    const RESERVED: &[&str] = &[
        "fetch",
        "fetchStream",
        "ws",
        "stream",
        "streamRead",
        "streamWrite",
        "streamCancel",
        "__fs",
        "fs",
        "host",
        "subLM",
        "ctx",
        "final",
        "kv",
    ];
    let exts = match cfg.get("extensions") {
        None => return None,
        Some(serde_json::Value::Null) => return None,
        Some(serde_json::Value::Array(a)) => a,
        Some(_) => {
            return Some(json!({
                "name": "ExtConfigError",
                "message": "config.extensions must be an array of manifests"
            }))
        }
    };
    // total manifest size cap (defends the persisted config + snapshot).
    let sz = serde_json::to_string(&serde_json::Value::Array(exts.clone()))
        .map(|s| s.len())
        .unwrap_or(usize::MAX);
    if sz > MAX_MANIFEST_BYTES {
        return Some(json!({
            "name": "ExtConfigError",
            "message": format!("config.extensions manifest {}B exceeds cap {}B", sz, MAX_MANIFEST_BYTES)
        }));
    }
    if exts.len() > MAX_EXTENSIONS {
        return Some(json!({
            "name": "ExtConfigError",
            "message": format!("too many extensions ({} > {})", exts.len(), MAX_EXTENSIONS)
        }));
    }
    let mut seen: Vec<String> = Vec::new();
    for e in exts {
        let obj = match e.as_object() {
            Some(o) => o,
            None => {
                return Some(json!({
                    "name": "ExtConfigError",
                    "message": "each extension must be an object {name, backend, tools, limits}"
                }))
            }
        };
        let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            return Some(json!({
                "name": "ExtConfigError",
                "message": "extension.name must be a non-empty string"
            }));
        }
        if name.starts_with("__") {
            return Some(json!({
                "name": "ExtConfigError",
                "message": format!("extension.name '{}' may not be __-prefixed (reserved)", name)
            }));
        }
        if RESERVED.contains(&name) {
            return Some(json!({
                "name": "ExtConfigError",
                "message": format!("extension.name '{}' shadows a built-in host effect/namespace", name)
            }));
        }
        // valid identifier-ish (so host.<name>.<fn> is reachable and cannot inject arbitrary JS).
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
        {
            return Some(json!({
                "name": "ExtConfigError",
                "message": format!("extension.name '{}' must be alphanumeric/_/$ only", name)
            }));
        }
        if seen.iter().any(|n| n == name) {
            return Some(json!({
                "name": "ExtConfigError",
                "message": format!("duplicate extension.name '{}'", name)
            }));
        }
        seen.push(name.to_string());
        // backend.kind MUST be "client" (default). http/worker are CUT in this phase.
        let kind = obj
            .get("backend")
            .and_then(|b| b.get("kind"))
            .and_then(|v| v.as_str())
            .unwrap_or("client");
        if kind != "client" {
            return Some(json!({
                "name": "ExtBackendError",
                "message": format!("backend.kind '{}' is not supported (only 'client' in this phase; http/worker are cut)", kind)
            }));
        }
        // tools[].fn must be valid identifiers (reachable as host.<name>.<fn>).
        if let Some(tools) = obj.get("tools").and_then(|t| t.as_array()) {
            for t in tools {
                let fnname = t.get("fn").and_then(|v| v.as_str()).unwrap_or("");
                if fnname.is_empty()
                    || !fnname
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
                {
                    return Some(json!({
                        "name": "ExtConfigError",
                        "message": format!("extension '{}' tool.fn '{}' must be a non-empty alphanumeric/_/$ identifier", name, fnname)
                    }));
                }
            }
        }
        // limits caps (defense-in-depth; glue also clamps).
        if let Some(limits) = obj.get("limits").and_then(|l| l.as_object()) {
            if let Some(cpc) = limits.get("callsPerCell").and_then(|v| v.as_i64()) {
                if cpc < 1 || cpc > 64 {
                    return Some(json!({
                        "name": "ExtConfigError",
                        "message": format!("extension '{}' limits.callsPerCell {} out of range [1,64]", name, cpc)
                    }));
                }
            }
            if let Some(mrb) = limits.get("maxResultBytes").and_then(|v| v.as_i64()) {
                if mrb < 1 || mrb > 65536 {
                    return Some(json!({
                        "name": "ExtConfigError",
                        "message": format!("extension '{}' limits.maxResultBytes {} out of range [1,65536]", name, mrb)
                    }));
                }
            }
        }
    }
    None
}

/// EXTENSIBILITY API — REDUCED Phase 1 (#32): emit ONE AE datapoint per ext call (op="ext:<name>")
/// from the glue-installed sink. Standalone (the sink closure is 'static, can't borrow &self), so it
/// captures env+do_id+generation and mirrors KernelDO::write_ae's blob/double layout. Best-effort.
fn write_ext_ae(env: &Env, do_id: &str, generation: i64, op: &str) {
    let envj: &JsValue = env.as_ref();
    let ae = match Reflect::get(envj, &JsValue::from_str("AE")) {
        Ok(v) => v,
        Err(_) => return,
    };
    if ae.is_undefined() || ae.is_null() {
        return;
    }
    let write_fn: js_sys::Function =
        match Reflect::get(&ae, &JsValue::from_str("writeDataPoint")).and_then(|f| f.dyn_into()) {
            Ok(f) => f,
            Err(_) => return,
        };
    let indexes = js_sys::Array::new();
    indexes.push(&JsValue::from_str(do_id));
    let blobs = js_sys::Array::new();
    blobs.push(&JsValue::from_str(op));
    blobs.push(&JsValue::from_str("")); // restore_source
    blobs.push(&JsValue::from_str("")); // store
    blobs.push(&JsValue::from_str("")); // error_name
    blobs.push(&JsValue::from_str("ext")); // value_type
    blobs.push(&JsValue::from_str("")); // label
    let doubles = js_sys::Array::new();
    for _ in 0..6 {
        doubles.push(&JsValue::from_f64(0.0));
    }
    doubles.push(&JsValue::from_f64(generation as f64));
    doubles.push(&JsValue::from_f64(1.0)); // ok
    let point = js_sys::Object::new();
    let _ = Reflect::set(&point, &JsValue::from_str("indexes"), &indexes);
    let _ = Reflect::set(&point, &JsValue::from_str("blobs"), &blobs);
    let _ = Reflect::set(&point, &JsValue::from_str("doubles"), &doubles);
    let _ = write_fn.call1(&ae, &point);
    let log = json!({ "ev": "op", "op": op, "doId": do_id, "valueType": "ext",
        "generation": generation, "ok": true });
    console_log(&log.to_string());
}

fn read_int<S: KernelStore>(store: &S, k: &str, dflt: i64) -> i64 {
    #[derive(serde::Deserialize)]
    struct Row {
        v: String,
    }
    let rows: Vec<Row> = store
        .query_typed(
            "SELECT v FROM meta WHERE k=? LIMIT 1;",
            Some(vec![k.into()]),
        )
        .unwrap_or_default();
    rows.first().and_then(|r| r.v.parse().ok()).unwrap_or(dflt)
}

fn read_str<S: KernelStore>(store: &S, k: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Row {
        v: String,
    }
    let rows: Vec<Row> = store
        .query_typed(
            "SELECT v FROM meta WHERE k=? LIMIT 1;",
            Some(vec![k.into()]),
        )
        .unwrap_or_default();
    rows.into_iter().next().map(|r| r.v)
}

fn parse_artifact_handle(handle: &str) -> Option<(i64, String)> {
    let rest = handle.strip_prefix("cell:")?;
    if let Some(cell) = rest.strip_suffix(":text") {
        return Some((cell.parse().ok()?, "text".to_string()));
    }
    let (cell, id) = rest.split_once(":artifact:")?;
    if id.is_empty() || id.len() > 64 {
        return None;
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    Some((cell.parse().ok()?, id.to_string()))
}

fn stamp_artifact_handles(v: &mut serde_json::Value, cell: i64) -> bool {
    match v {
        serde_json::Value::Array(items) => {
            let mut any = false;
            for item in items {
                any |= stamp_artifact_handles(item, cell);
            }
            any
        }
        serde_json::Value::Object(obj) => {
            let mut any = false;
            let is_artifact = obj
                .get("kind")
                .and_then(|v| v.as_str())
                .map(|s| s == "artifact")
                .unwrap_or(false);
            if is_artifact {
                if let Some(handle) = obj.get("handle").and_then(|v| v.as_str()) {
                    if let Some(id) = handle.strip_prefix("pending:") {
                        let stamped = if id == "text" {
                            format!("cell:{cell}:text")
                        } else {
                            format!("cell:{cell}:artifact:{id}")
                        };
                        obj.insert("handle".to_string(), json!(stamped));
                        any = true;
                    }
                }
            }
            for value in obj.values_mut() {
                any |= stamp_artifact_handles(value, cell);
            }
            any
        }
        _ => false,
    }
}

/// Persist the session config to meta WITHOUT panicking on an oversize value. SQLite's row/blob
/// ceiling (SQLITE_TOOBIG, ~1GB but workerd caps far lower) would make the raw `write_meta` `.expect`
/// panic -> WS-1006 DoS. We pre-reject any config above a generous ceiling with a typed error so the
/// socket stays alive. Returns Some(error-json) on rejection, None on success.
fn persist_config<S: KernelStore>(store: &S, cfg_str: &str) -> Option<serde_json::Value> {
    // 512KB ceiling — far above any legitimate config (the extensions manifest alone caps at 64KB),
    // far below SQLite's hard limit, so this only catches abusive/oversize payloads.
    const MAX_CONFIG_BYTES: usize = 512 * 1024;
    if cfg_str.len() > MAX_CONFIG_BYTES {
        return Some(json!({
            "name": "ConfigTooBigError",
            "message": format!("config {}B exceeds cap {}B", cfg_str.len(), MAX_CONFIG_BYTES)
        }));
    }
    if store
        .exec(
            "INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
            Some(vec!["config".into(), cfg_str.into()]),
        )
        .is_err()
    {
        return Some(json!({
            "name": "ConfigPersistError",
            "message": "failed to persist config (storage rejected the write)"
        }));
    }
    None
}

fn write_meta<S: KernelStore>(store: &S, k: &str, v: &str) {
    store
        .exec(
            "INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v;",
            Some(vec![k.into(), v.into()]),
        )
        .expect("write meta");
}

// ── R2 RESTORE RESILIENCE (issue #10: transient R2 hiccup on the >SQLITE_HOT_MAX overflow
//    restore path used to bubble a 500 → client reconnect+{t:create} → fresh-over-durable WIPE).
//    Constants govern the retry/timeout/circuit-breaker wrapped around the single R2 GET. ───────
const R2_GET_ATTEMPTS: usize = 4;
// Deterministic (jitter-free — determinism invariant) exponential-ish backoff between attempts.
const R2_GET_BACKOFF_MS: [u64; 3] = [50, 150, 400];
// Per-attempt wall-clock ceiling: a single hung GET must not eat the whole DO request budget.
const R2_GET_TIMEOUT_MS: u64 = 4000;
// Circuit breaker: after this many CONSECUTIVE exhausted R2 reads, skip R2 entirely (go straight to
// oplog-replay) until the cooldown elapses — avoids stacking multi-second timeouts on a degraded R2.
const R2_BREAKER_TRIP_AT: i64 = 3;
const R2_BREAKER_COOLDOWN_MS: f64 = 30_000.0;
const R2_BREAKER_FAILS_KEY: &str = "r2BreakerFails";
const R2_BREAKER_OPEN_UNTIL_KEY: &str = "r2BreakerOpenUntil";

/// Outcome of a resilient R2 read attempt set.
enum R2Read {
    /// Body bytes obtained.
    Got(Uint8Array),
    /// The key is durably absent (404-class) — NOT a transient failure; recover via oplog replay.
    Missing,
    /// All retries exhausted on transient errors/timeouts — session is INTACT (do NOT wipe);
    /// caller must route to oplog-replay / typed-retryable, never to create-fresh.
    Exhausted,
}

/// A 2-future select: resolves with the first branch to complete. Used to race an R2 GET against a
/// `Delay` timeout without pulling in the `futures` crate. Left = the work, Right = the timeout.
struct Select2<A, B> {
    a: Pin<Box<A>>,
    b: Pin<Box<B>>,
}
enum Either<TA, TB> {
    Left(TA),
    Right(TB),
}
impl<A: Future, B: Future> Future for Select2<A, B> {
    type Output = Either<A::Output, B::Output>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if let Poll::Ready(v) = self.a.as_mut().poll(cx) {
            return Poll::Ready(Either::Left(v));
        }
        if let Poll::Ready(v) = self.b.as_mut().poll(cx) {
            return Poll::Ready(Either::Right(v));
        }
        Poll::Pending
    }
}
async fn race_timeout<F: Future>(work: F, timeout_ms: u64) -> Option<F::Output> {
    let sel = Select2 {
        a: Box::pin(work),
        b: Box::pin(Delay::from(Duration::from_millis(timeout_ms))),
    };
    match sel.await {
        Either::Left(v) => Some(v),
        Either::Right(_) => None,
    }
}

fn now_ms() -> f64 {
    js_sys::Date::now()
}

/// console.log one line via the global console (no web-sys dependency). Best-effort.
fn console_log(s: &str) {
    if let Some(global) = js_sys::global().dyn_ref::<js_sys::Object>() {
        if let Ok(console) = Reflect::get(global, &JsValue::from_str("console")) {
            if let Ok(log) = Reflect::get(&console, &JsValue::from_str("log")) {
                if let Ok(f) = log.dyn_into::<js_sys::Function>() {
                    let _ = f.call1(&console, &JsValue::from_str(s));
                }
            }
        }
    }
}

fn clone_glue(g: &GlueKernel) -> GlueKernel {
    let v: &JsValue = g.as_ref();
    v.clone().unchecked_into()
}

fn to_err(e: JsValue) -> worker::Error {
    worker::Error::RustError(format!("{:?}", e))
}

/// DO-side R2 servicer for the in-VM `fs` host-backed provider (config.fs.provider == "r2").
/// `payload` is the JS object the glue forwards: { op, path, bytes?:Uint8Array }. Returns a JS
/// object the glue marshals back to the engine: { ok, bytes?:Uint8Array, names?, size?, isFile?,
/// isDirectory?, error? }. Binary crosses as Uint8Array (glue does the base64 at the engine edge).
async fn r2_fs_op(
    env: &Env,
    binding: &str,
    prefix: &str,
    payload: JsValue,
) -> std::result::Result<JsValue, JsValue> {
    let getp = |k: &str| Reflect::get(&payload, &JsValue::from_str(k)).ok();
    let op = getp("op").and_then(|v| v.as_string()).unwrap_or_default();
    let path = getp("path").and_then(|v| v.as_string()).unwrap_or_default();
    let key = format!("{}{}", prefix, path.trim_start_matches('/'));
    let bucket = env
        .bucket(binding)
        .map_err(|e| JsValue::from_str(&format!("FsError: bucket '{}' — {e}", binding)))?;
    let out = js_sys::Object::new();
    let set = |k: &str, v: &JsValue| {
        let _ = Reflect::set(&out, &JsValue::from_str(k), v);
    };
    let enoent = |p: &str| format!("ENOENT: no such file or directory, '{}'", p);
    match op.as_str() {
        "read" => match bucket.get(&key).execute().await {
            Ok(Some(obj)) => {
                let body = obj
                    .body()
                    .ok_or_else(|| JsValue::from_str("FsError: empty body"))?;
                let bytes = body
                    .bytes()
                    .await
                    .map_err(|e| JsValue::from_str(&format!("{e}")))?;
                let arr = Uint8Array::new_with_length(bytes.len() as u32);
                arr.copy_from(&bytes);
                set("ok", &JsValue::TRUE);
                set("bytes", &arr.into());
            }
            _ => set("error", &JsValue::from_str(&enoent(&path))),
        },
        "write" => {
            let bytes_val = getp("bytes").unwrap_or(JsValue::NULL);
            let arr: Uint8Array = bytes_val
                .dyn_into()
                .map_err(|_| JsValue::from_str("FsError: write bytes missing"))?;
            bucket
                .put(&key, arr.to_vec())
                .execute()
                .await
                .map_err(|e| JsValue::from_str(&format!("FsError: {e}")))?;
            set("ok", &JsValue::TRUE);
        }
        "delete" => {
            let _ = bucket.delete(&key).await;
            set("ok", &JsValue::TRUE);
        }
        "stat" => match bucket.get(&key).execute().await {
            Ok(Some(obj)) => {
                set("ok", &JsValue::TRUE);
                set("isFile", &JsValue::TRUE);
                set("isDirectory", &JsValue::FALSE);
                set("size", &JsValue::from_f64(obj.size() as f64));
            }
            _ => set("error", &JsValue::from_str(&enoent(&path))),
        },
        "list" => {
            let lpfx = format!("{}{}", prefix, path.trim_start_matches('/'));
            let listing = bucket
                .list()
                .prefix(lpfx.clone())
                .execute()
                .await
                .map_err(|e| JsValue::from_str(&format!("FsError: {e}")))?;
            let names = js_sys::Array::new();
            let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            for o in listing.objects() {
                let k = o.key();
                let rest = k.strip_prefix(&lpfx).unwrap_or(&k);
                let name = rest.trim_start_matches('/').split('/').next().unwrap_or("");
                if !name.is_empty() && seen.insert(name.to_string()) {
                    names.push(&JsValue::from_str(name));
                }
            }
            set("ok", &JsValue::TRUE);
            set("names", &names.into());
        }
        other => set(
            "error",
            &JsValue::from_str(&format!("FsError: unknown op '{}'", other)),
        ),
    }
    Ok(out.into())
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
