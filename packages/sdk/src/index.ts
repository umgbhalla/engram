/**
 * @engram/sdk v2 — a clean, ergonomic TypeScript client for the durable Engram kernel.
 *
 * One entry point: {@link Engram.connect}. It auto-detects whether you're talking to a
 * bare kernel (WebSocket) or the multi-tenant cloud (HTTP + API key), keeps a durable
 * session alive across hibernation, auto-reconnects with backoff, and gives you a tiny,
 * well-typed surface:
 *
 * ```ts
 * const s = await Engram.connect({ url: "wss://engram-kernel.example.workers.dev", session: "demo" });
 * const r = await s.eval("globalThis.x = 41; x + 1");   // r.value === 42
 * await s.set("note", "hi");                              // durable sugar over eval
 * console.log(await s.get("note"));                       // "hi", survives hibernation
 * await s.hibernateThenResume();                          // evict + cold-restore, state intact
 * s.close();
 * ```
 *
 * Cloud (multi-tenant) is identical, just add an apiKey:
 * ```ts
 * const s = await Engram.connect({ url: "https://engram-cloud.example.workers.dev", apiKey: "ek_..." });
 * ```
 *
 * Errors: by default a failed cell throws a typed {@link EngramError} subclass
 * ({@link TimeoutError} / {@link MemoryLimitError} / {@link FetchBlockedError} / ...).
 * Pass `{ throwOnError: false }` to {@link connect} (or `eval`) to get a plain result instead.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A `console.*` line captured while a cell ran. */
export interface ConsoleLine {
  /** `"log" | "warn" | "error" | "info" | "debug"`. */
  level: string;
  /** The already-formatted text of the line. */
  text: string;
}

/** What a checkpoint (durable snapshot of the heap after a cell) recorded. */
export interface Checkpoint {
  ok: boolean;
  /** Monotonic cell index this checkpoint committed at. */
  cell?: number;
  /** Where the image landed: `"sqlite"` (hot, <2MB gz) or `"r2"` (overflow). */
  store?: "sqlite" | "r2" | string;
  /** Compressed snapshot size in bytes. */
  sizeGz?: number;
  /** Raw linear-memory image size in bytes. */
  sizeRaw?: number;
  /** QuickJS used-heap bytes (the figure the size-admission guard checks). */
  usedHeap?: number;
}

/** A directory entry returned by {@link EngramSession.ls} (host.fs R2 store). */
export interface VfsEntry {
  /** The immediate child name (not the full path). */
  name: string;
  /** File size in bytes (0 for directories). */
  size: number;
  /** `true` if this entry is a directory. */
  isDir: boolean;
}

/** File metadata returned by {@link EngramSession.stat} (host.fs R2 store). */
export interface VfsStat {
  /** File size in bytes. */
  size: number;
  /** `true` if this is a regular file. */
  isFile: boolean;
  /** `true` if this is a directory. */
  isDir: boolean;
  /** Last-modified time in epoch milliseconds (host.fs `created_ms`). */
  mtime: number;
}

/** Result of {@link EngramSession.registerWorker} — the content hash of a registered worker source. */
export interface WorkerRegistration {
  /** Lowercase hex sha256 of the registered source (immutable; same source = same hash). */
  hash: string;
  /** Size of the registered source in bytes. */
  bytes: number;
  /** `true` if this session had already registered this hash (idempotent no-op). */
  cached: boolean;
}

/** A row in the per-session worker registry index, returned by {@link EngramSession.listWorkers}. */
export interface WorkerRecord {
  /** Lowercase hex sha256 of the source. */
  hash: string;
  /** Size of the source in bytes. */
  bytes: number;
  /** Registration time in epoch milliseconds. */
  createdMs: number;
}

/** Per-invoke options for {@link EngramSession.invokeWorker}. */
export interface InvokeWorkerOptions {
  /** Wall-clock timeout in ms (default 30000, cap 120000). */
  timeoutMs?: number;
  /** Per-invoke CPU budget in ms (default 5000). */
  cpuMs?: number;
}

/** The structured error a failed cell carries (before it is thrown / surfaced). */
export interface EvalErrorInfo {
  name: string;
  message: string;
  stack?: string;
}

/**
 * A typed runtime environment applied at connect (and re-applied on every reconnect,
 * exactly like {@link ConnectOptions.bootstrap}). It composes with — and runs after —
 * any explicit `bootstrap`.
 *
 * - `globals`: host-side functions serialised by `.toString()` into an idempotent
 *   in-VM bootstrap (`g.<name> ||= <fn>`), so a cell can call them directly by name.
 *   These are PURE in-VM functions (no host round-trip) — they are stringified and
 *   re-created inside the VM.
 * - `prelude`: extra JS appended to the generated bootstrap (idempotent — runs on every reconnect).
 * - `modules`: forwarded into `config.modules` (load the in-VM stdlib bundle).
 *
 * The SDK always injects a tiny built-in prelude that wires `host.final(x)` / `FINAL(x)`
 * over the reserved `__engram_final` host channel, so faithful-final works for free
 * (see {@link EvalResult.final}).
 */
export interface RuntimeEnv {
  /** In-VM helper functions, serialised by `.toString()` into an idempotent bootstrap. */
  globals?: Record<string, (...a: any[]) => any>;
  /** Extra idempotent JS appended to the generated bootstrap (runs on every reconnect). */
  prelude?: string;
  /** Forwarded into `config.modules` (in-VM stdlib bundle: `true` or a name list). */
  modules?: boolean | string[];
}

/** A namespaced bundle of host functions registered together via {@link EngramSession.defineHostModule}. */
export type HostModule = Record<string, (...args: any[]) => unknown | Promise<unknown>>;

/**
 * An eval interceptor (middleware) — see {@link ConnectOptions.onEval}. Wraps every
 * {@link EngramSession.eval}: receives the cell `code` and resolved `opts`, and a `next`
 * continuation that runs the actual eval (or the next interceptor). Return the result of
 * `next(...)` to proceed, optionally transforming the code passed in or the result returned.
 * Throwing skips the eval. Use for tracing, timing, redaction, retries, or result rewriting
 * without wrapping every call site.
 *
 * ```ts
 * const onEval: EvalInterceptor = async (code, opts, next) => {
 *   const t = Date.now();
 *   try { return await next(code); } finally { console.log(`cell ${Date.now() - t}ms`); }
 * };
 * ```
 */
export type EvalInterceptor = (
  code: string,
  opts: { throwOnError?: boolean; timeoutMs?: number },
  next: (code: string) => Promise<EvalResult>,
) => Promise<EvalResult>;

/** Descriptor for a large MIME/value payload stored server-side and read in chunks. */
export interface ArtifactValue {
  kind: "artifact";
  handle: string;
  mime?: string;
  chars?: number;
  bytes?: number;
  encoding?: string;
  chunkMaxChars?: number;
}

/** Jupyter-compatible MIME bundle: MIME type -> JSON/string/artifact payload. */
export type MimeBundle = Record<string, unknown | ArtifactValue>;

/** Jupyter-style output event emitted by a cell. */
export interface MimeOutput {
  output_type: "execute_result" | "display_data" | "update_display_data" | "clear_output" | "stream" | "error" | string;
  data?: MimeBundle;
  metadata?: Record<string, unknown>;
  transient?: Record<string, unknown>;
  execution_count?: number | null;
  name?: string;
  text?: string;
  wait?: boolean;
  [k: string]: unknown;
}

/** The typed result of {@link EngramSession.eval}. */
export interface EvalResult<T = unknown, F = unknown> {
  /** `true` if the cell completed without throwing. */
  ok: boolean;
  /**
   * The cell's completion value. Primitives come back as-is; objects/arrays are
   * parsed from the kernel's JSON preview when possible (so you get a real value,
   * not a string). Use {@link EvalResult.valuePreview} for the human-readable form.
   */
  value: T;
  /** A util.inspect-style preview string (always present for non-primitives). */
  valuePreview?: string;
  /** Coarse tag for the completion value. */
  valueType?: string;
  /** MIME bundle for the completion value, suitable for Jupyter-style renderers. */
  mimeBundle?: MimeBundle;
  /** Jupyter-style display/update/clear/execute_result outputs emitted by the cell. */
  outputs: MimeOutput[];
  /** `console.*` lines captured during the cell. */
  console: ConsoleLine[];
  /** Present (and `ok === false`) when the cell threw. */
  error?: EvalErrorInfo;
  /** The durable checkpoint committed after this cell, if any. */
  checkpoint?: Checkpoint;
  /** Monotonic cell index. */
  cell?: number;
  /**
   * `true` if `host.final(x)` (the reserved `__engram_final` channel) fired during this
   * cell. Lets you distinguish "a final was set to `undefined`" from "no final".
   */
  finalSet: boolean;
  /**
   * The argument of the LAST `host.final(x)` / `FINAL(x)` call that fired during this
   * cell — surfaced as FAITHFUL JSON (it crossed the wire as hostcall args, NOT through
   * the value-preview path), so async-IIFE object completions round-trip intact instead
   * of mis-previewing as `{}`.
   */
  final?: F;
}

/** In-VM kernel configuration, applied at session create and persisted across hibernation. */
export interface EngramConfig {
  /** `"seeded"` for deterministic Date/Math (byte-identical snapshots), or `"real"`. */
  clock?: "seeded" | "real";
  /** Seed for the deterministic RNG when `clock: "seeded"`. */
  rngSeed?: number;
  /** Per-cell instruction budget (interrupt invocations). Raise for heavy legit cells. */
  cellBudgetTicks?: number;
  /** Outbound fetch policy: `false` blocks all, `true` allows all, `string[]` = allowed hostnames. */
  fetch?: boolean | string[];
  /** Load the in-VM stdlib bundle: `true` for the default set, or pick modules by name. */
  modules?: boolean | string[];
  /** Capture `console.*` output per cell (default true). */
  capture?: boolean;
  /**
   * Enable the Tier-2 sandbox bridge: opt this session into the engram-sandbox container worker
   * over the SHARED R2 VFS (the container mounts this session's `fs/<doId>/` prefix as `/workspace`).
   * When `true`, the `s.sandbox.*` SDK surface (and the in-cell `host.sandbox.*` effect) become
   * available; without it every sandbox call returns `SandboxUnavailable`. The Bearer key is added
   * DO-side from the kernel env — it never crosses into the VM or any client frame.
   */
  sandbox?: boolean;
  /** Any other kernel-recognised config keys. */
  [k: string]: unknown;
}

/**
 * The minimal WebSocket surface the SDK needs to drive a session over an injected,
 * pre-opened socket (e.g. a Cloudflare DO->DO socket from `res.webSocket` after
 * `.accept()`). Both the browser-style (`addEventListener`/`removeEventListener`) and
 * the Node `ws`-style (`on`/`off`) event APIs are accepted — the SDK feature-detects.
 * The socket is assumed already OPEN/accepted; the SDK does NOT wait for an `open` event
 * on injected sockets.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  addEventListener?(type: string, listener: (ev: any) => void, opts?: any): void;
  removeEventListener?(type: string, listener: (ev: any) => void): void;
  on?(type: string, listener: (...args: any[]) => void): void;
  off?(type: string, listener: (...args: any[]) => void): void;
  once?(type: string, listener: (...args: any[]) => void): void;
  removeListener?(type: string, listener: (...args: any[]) => void): void;
}

/** Options for {@link Engram.connect}. */
export interface ConnectOptions {
  /**
   * The kernel or cloud endpoint. Accepts `ws://`/`wss://` (kernel WS), or
   * `http(s)://` (auto-upgraded to WS for the kernel, or HTTP for the cloud when
   * an `apiKey` is given). Trailing slashes are fine.
   *
   * OPTIONAL when {@link ConnectOptions.socket} or {@link ConnectOptions.openSocket}
   * is provided (the SDK then drives the injected socket instead of opening one).
   */
  url?: string;
  /**
   * A single, PRE-OPENED (already-accepted) WebSocket the SDK should drive instead of
   * opening one from {@link ConnectOptions.url}. Use this for a DO->DO socket
   * (`const { 0: client, 1: server } = new WebSocketPair()` / `res.webSocket` after
   * `.accept()`). One-shot: if it drops, the SDK CANNOT reopen it — the in-flight rpc
   * rejects with a clear closed error and there is no reconnect. For reconnect-capable
   * injected transport, use {@link ConnectOptions.openSocket} instead.
   */
  socket?: WebSocketLike;
  /**
   * A factory the transport calls on every (re)connect to obtain a fresh, already-open
   * WebSocket for the given session id (e.g. mint a new DO->DO socket per session). When
   * set, `autoReconnect` re-invokes this factory rather than opening from `url`. The
   * returned socket is assumed already OPEN/accepted.
   */
  openSocket?: (session: string) => WebSocketLike | Promise<WebSocketLike>;
  /** Durable session id. The same id reattaches to the same hibernated heap. Default `"default"`. */
  session?: string;
  /** Cloud API key (`x-api-key`). Presence flips the transport to the cloud HTTP/WS path. */
  apiKey?: string;
  /**
   * Bare-kernel shared bearer key (engram-kernel auth, additive — does NOT change `apiKey`
   * cloud semantics). When set, the bare-kernel WS URL gains `&apiKey=<kernelKey>` AND a
   * `{t:"auth",token}` frame is sent first on every (re)connect so reconnect re-auths transparently.
   */
  kernelKey?: string;
  /** In-VM kernel config, applied once at connect. */
  config?: EngramConfig;
  /** JS evaluated once after create to seed VM globals; runs on every reconnect, so keep it idempotent. */
  bootstrap?: string;
  /** Throw a typed {@link EngramError} on a failed cell (default true). */
  throwOnError?: boolean;
  /** Auto-reconnect with backoff on transport drop (default true). */
  autoReconnect?: boolean;
  /** Per-request timeout in ms (default 60000). */
  timeoutMs?: number;
  /** Override the WebSocket implementation (Node: pass `(await import('ws')).default`). */
  WebSocket?: unknown;
  /** Callback for every captured `console.*` line, across all cells. */
  onConsole?: (line: ConsoleLine) => void;
  /**
   * Drive a CUSTOM {@link Transport} instead of opening a WebSocket / HTTP channel from
   * `url`. Pass a transport instance, or a factory `(session) => Transport` invoked once at
   * connect. Use this to bind Engram into your own substrate — a Cloudflare service-binding
   * or DO-to-DO RPC stub, an in-process kernel, a signed/audited channel. When set, `url`,
   * `apiKey`, `socket`, and `openSocket` are ignored. The transport owns its own reconnect
   * lifecycle; the SDK applies config/bootstrap once via {@link EngramSession._applyConfig}.
   */
  transport?: Transport | ((session: string) => Transport | Promise<Transport>);
  /** Fired once after the FIRST connect (config/bootstrap applied). WS/openSocket transports only. */
  onConnect?: () => void;
  /**
   * Fired after each RECONNECT once config/bootstrap is re-applied (WS/openSocket transports
   * only). The hook to re-register dynamic host tools (`bindHost`/`defineHostModule`) that a
   * substrate added after connect — these live only in memory and are cleared by a fresh socket.
   */
  onReconnect?: () => void;
  /**
   * Fired on an UNEXPECTED socket drop (the remote/network closed it). Not fired by an
   * explicit {@link EngramSession.close} or the internal reconnect teardown — both detach the
   * close listener first. On an auto-reconnecting session a genuine drop fires `onClose` then,
   * after the channel is back, {@link onReconnect}.
   */
  onClose?: () => void;
  /**
   * An eval interceptor (or a chain of them, applied left-to-right — the first wraps the
   * outermost). See {@link EvalInterceptor}. Lets a substrate trace/time/transform every cell
   * centrally instead of wrapping each `session.eval()` call.
   */
  onEval?: EvalInterceptor | EvalInterceptor[];
  /**
   * Host functions the VM can invoke as `host.<name>(...args)` mid-eval (the VM->client
   * bridge). Each is bound via {@link EngramSession.bindHost} before connect returns.
   * Requires the WebSocket transport (no-op over the cloud HTTP path).
   */
  host?: Record<string, (...a: unknown[]) => unknown | Promise<unknown>>;
  /**
   * A typed runtime environment ({@link RuntimeEnv}): in-VM `globals`, a `prelude`, and
   * `modules`. Applied (and re-applied on reconnect) the same way as {@link ConnectOptions.bootstrap},
   * composing after it. Always also wires `host.final` / `FINAL` over the reserved channel.
   */
  env?: RuntimeEnv;
  /**
   * Seed the first-class durable context map (`globalThis.__engram_ctx`), readable in-VM
   * via the injected `host.ctx` getter and from the SDK via {@link EngramSession.ctx}.
   * Survives hibernation (persisted global).
   */
  ctx?: Record<string, unknown>;
  /**
   * Namespaced host modules: each fn is registered under the literal name `<ns>.<fn>`
   * (the kernel dispatches any name) and a namespacing shim makes the VM see
   * `host.<ns>.<fn>(...)`. See {@link EngramSession.defineHostModule}.
   * Requires the WebSocket transport (no-op over the cloud HTTP path).
   */
  hostModules?: Record<string, HostModule>;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Base class for every error the SDK throws from a failed cell or transport fault. */
export class EngramError extends Error {
  /** The kernel-reported error name (`"TimeoutError"`, etc.) or `"EngramError"`. */
  override name = "EngramError";
  /** The kernel stack, when present. */
  kernelStack?: string;
  /** The full eval result that produced this error (for inspection). */
  result?: EvalResult;
  constructor(message: string, info?: { stack?: string; result?: EvalResult }) {
    super(message);
    this.kernelStack = info?.stack;
    this.result = info?.result;
  }
}

/** A cell exceeded its instruction/time budget (infinite loop guard). */
export class TimeoutError extends EngramError {
  override name = "TimeoutError";
}
/** A cell grew the WASM linear memory past the per-cell or absolute cap. */
export class MemoryLimitError extends EngramError {
  override name = "MemoryLimitError";
}
/** A `host.fetch` to a host not on the allowlist was blocked. */
export class FetchBlockedError extends EngramError {
  override name = "FetchBlockedError";
}
/** The heap is too large to snapshot (over the dump ceiling). */
export class SizeAdmissionError extends EngramError {
  override name = "SizeAdmissionError";
}
/** `s.sandbox.*` was called on a session without `config.sandbox: true`. */
export class SandboxDisabledError extends EngramError {
  override name = "SandboxDisabledError";
}

const ERROR_CLASSES: Record<string, typeof EngramError> = {
  TimeoutError,
  MemoryLimitError,
  FetchBlockedError,
  SizeAdmissionError,
  SandboxDisabledError,
};

/** Build the right typed error from a kernel error payload. */
function toTypedError(info: EvalErrorInfo, result?: EvalResult): EngramError {
  const Cls = ERROR_CLASSES[info.name] || EngramError;
  const err = new Cls(info.message || info.name || "eval failed", { stack: info.stack, result });
  if (Cls === EngramError && info.name) err.name = info.name;
  return err;
}

// ---------------------------------------------------------------------------
// base64 (runtime-agnostic: Node Buffer or browser btoa/atob)
// ---------------------------------------------------------------------------

type Bufferish = { from(s: string, enc: string): { toString(enc: string): string } };
const _Buffer: Bufferish | undefined = (globalThis as { Buffer?: Bufferish }).Buffer;

/** Encode raw bytes to a standard base64 string. */
function bytesToB64(bytes: Uint8Array): string {
  if (_Buffer) {
    // Node fast path.
    return (_Buffer.from as unknown as (b: Uint8Array) => { toString(enc: string): string })(bytes).toString("base64");
  }
  let bin = "";
  const CHUNK = 0x8000; // avoid call-stack blowups on large inputs
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/** Decode a standard base64 string to raw bytes. */
function b64ToBytes(b64: string): Uint8Array {
  if (_Buffer) {
    const s = _Buffer.from(b64, "base64").toString("binary");
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

const _utf8Enc = new TextEncoder();

/** Coerce a writeFile input value to raw bytes (string -> utf8). */
function toBytes(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof data === "string") return _utf8Enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // ArrayBufferView (e.g. Buffer / typed array) — view its underlying bytes.
  const v = data as ArrayBufferView;
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * A frame sent to the kernel. `t` is the verb; `src` carries eval source.
 * Exported so a custom {@link Transport} (see {@link ConnectOptions.transport}) can speak
 * the same wire protocol the built-in WS/HTTP transports use.
 */
export interface Frame {
  t: string;
  src?: string;
  config?: EngramConfig;
  [k: string]: unknown;
}

/** A host function the VM can invoke via `host.<name>(...args)` during an eval. */
export type HostFn = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * The transport seam the SDK drives. Implement this to bind Engram into your own
 * substrate — e.g. a Cloudflare service-binding / DO-to-DO RPC stub, an in-process kernel,
 * a signed/audited HTTP channel — and pass it via {@link ConnectOptions.transport} (or
 * {@link EngramSession.fromTransport}). The built-in {@link WsTransport}/{@link HttpTransport}
 * are just two implementations of this interface.
 *
 * A transport is responsible for its own (re)connect lifecycle. If it can lose and reopen its
 * underlying channel, it should re-apply config/bootstrap on reconnect by invoking the
 * `onReady` callback the SDK passes at construction (the WS transport does this); the SDK
 * calls {@link EngramSession._applyConfig} once at connect for transports without an onReady.
 */
export interface Transport {
  /** Send one frame, await its single reply. */
  request(frame: Frame, timeoutMs: number): Promise<any>;
  /** Register a host function callable from the VM as `host.<name>`. */
  setHost(name: string, fn: HostFn): void;
  /** Tear down. */
  close(): void;
  /**
   * `true` if this transport can deliver VM->host calls (`host.<name>()`) back to registered
   * host fns. The WS transport is `true`; the cloud HTTP transport is `false` (host binds are
   * silent no-ops there). Surfaced on {@link EngramSession.supportsHostCalls}. Defaults to
   * `false` when omitted.
   */
  readonly supportsHostCalls?: boolean;
}

function resolveWebSocket(explicit: unknown): any {
  if (explicit) return explicit;
  if (typeof (globalThis as any).WebSocket !== "undefined") return (globalThis as any).WebSocket;
  throw new EngramError(
    "No WebSocket available. In Node, pass { WebSocket: (await import('ws')).default } to connect().",
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * WebSocket transport (bare kernel, or cloud `/connect`). Serialises requests on a
 * single socket, reconnects with exponential backoff, and re-applies config on reconnect.
 */
class WsTransport implements Transport {
  /** WS can deliver VM->host calls. */
  readonly supportsHostCalls = true;
  private ws: any = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private reconnects = 0;
  /** Flips true after the first successful onReady so subsequent ones are reconnects. */
  private hasConnected = false;
  /** Host functions callable from the VM as `host.<name>`. */
  private hostFns = new Map<string, HostFn>();
  /** The resolver/rejecter for the single in-flight rpc on this socket, if any. */
  private pending: { resolve: (v: any) => void; reject: (e: any) => void; timer: any } | null = null;

  /**
   * True once a one-shot injected `socket` has been consumed. A one-shot socket cannot be
   * reopened, so a second open() (e.g. after a drop) surfaces a clear closed error.
   */
  private oneShotConsumed = false;

  constructor(
    private WS: any,
    private wsUrl: string,
    private opts: {
      autoReconnect: boolean;
      onReady?: (raw: (f: Frame, t: number) => Promise<any>) => Promise<void>;
      /** Durable session id, passed to the openSocket factory. */
      session?: string;
      /** A single pre-opened socket to drive once (one-shot, no reconnect). */
      socket?: WebSocketLike;
      /** A factory invoked on each (re)connect to mint a fresh, already-open socket. */
      openSocket?: (session: string) => WebSocketLike | Promise<WebSocketLike>;
      /** Fired after config/bootstrap re-applied on the FIRST connect. */
      onConnect?: () => void;
      /** Fired after config/bootstrap re-applied on each RECONNECT (not the first connect). */
      onReconnect?: () => void;
      /** Fired on an unexpected socket drop (listeners are detached before deliberate closes). */
      onClose?: () => void;
    },
  ) {}

  setHost(name: string, fn: HostFn): void {
    this.hostFns.set(name, fn);
  }

  /** Send a frame back to the kernel over the live socket (used for hostcall results). */
  private sendRaw(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      /* socket gone; ignore — the in-flight rpc (if any) will reject via onClose */
    }
  }

  /**
   * Persistent message demux (mirrors the reference makeClient). An out-of-band
   * `{t:'hostcall'}` frame is dispatched to a registered host fn and answered with a
   * `{t:'hostcall-result'}` frame WITHOUT touching the in-flight rpc resolver. Every other
   * frame is the reply to the single in-flight rpc.
   */
  private onMessage = (ev: any): void => {
    const data = ev && ev.data !== undefined ? ev.data : ev;
    let msg: any;
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      // Malformed frame. If it was meant to be the rpc reply, surface a typed error.
      const p = this.pending;
      if (p) {
        this.pending = null;
        clearTimeout(p.timer);
        p.reject(new EngramError("malformed kernel reply"));
      }
      return;
    }
    if (msg && msg.t === "hostcall") {
      const fn = this.hostFns.get(msg.name);
      Promise.resolve()
        .then(() => (fn ? fn(...((msg.args as unknown[]) || [])) : Promise.reject(new Error("no host fn " + msg.name))))
        .then(
          (value) => this.sendRaw({ t: "hostcall-result", id: msg.id, ok: true, value }),
          (err) => this.sendRaw({ t: "hostcall-result", id: msg.id, ok: false, error: String((err && err.message) || err) }),
        );
      return;
    }
    // Any other frame is the reply to the in-flight rpc.
    const p = this.pending;
    if (p) {
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  };

  private onClose = (): void => {
    const p = this.pending;
    if (p) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new EngramError("__ws_closed__"));
    }
    try {
      this.opts.onClose?.();
    } catch {
      /* ignore */
    }
  };

  /**
   * Detach the persistent listeners from the current socket, close it, and forget it.
   * Used both on rpc timeout (so a late, orphaned reply lands on a dead socket and is
   * dropped instead of mis-resolving the NEXT in-flight rpc) and when we replace the
   * socket on reconnect (so the old socket's handlers can't fire into the new state).
   * Does NOT reject `pending` — the caller owns that.
   */
  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (ws.removeEventListener) {
        ws.removeEventListener("message", this.onMessage);
        ws.removeEventListener("close", this.onClose);
      } else if (ws.off) {
        ws.off("message", this.onMessage);
        ws.off("close", this.onClose);
      } else if (ws.removeListener) {
        ws.removeListener("message", this.onMessage);
        ws.removeListener("close", this.onClose);
      }
    } catch {
      /* ignore */
    }
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  /** Attach the persistent message/close listeners to `ws` (browser- or node-ws-style). */
  private attachListeners(ws: any): void {
    if (ws.addEventListener) {
      // ONE persistent handler for the lifetime of this socket.
      ws.addEventListener("message", this.onMessage);
      ws.addEventListener("close", this.onClose);
    } else {
      ws.on("message", this.onMessage);
      ws.on("close", this.onClose);
    }
  }

  private async open(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return;
    if (this.opts.openSocket) {
      // Injected factory: mint a fresh, already-open socket for this session on every
      // (re)connect. Skip the 'open' wait — the socket is assumed accepted/open.
      const ws = await this.opts.openSocket(this.opts.session ?? "default");
      this.ws = ws;
      this.attachListeners(ws);
    } else if (this.opts.socket) {
      // One-shot injected socket: use it once. It cannot be reopened, so a second open()
      // (after a drop) surfaces a clear closed error instead of silently failing.
      if (this.oneShotConsumed) {
        throw new EngramError("injected socket closed and cannot be reopened (use openSocket for reconnect)");
      }
      const ws = this.opts.socket;
      this.ws = ws;
      this.oneShotConsumed = true;
      // Assumed already OPEN/accepted — skip the 'open' event wait.
      this.attachListeners(ws);
    } else {
      await new Promise<void>((resolve, reject) => {
        const ws = new this.WS(this.wsUrl);
        this.ws = ws;
        const ok = () => resolve();
        const fail = (e: any) => reject(e instanceof Error ? e : new EngramError("ws connect failed"));
        if (ws.addEventListener) {
          ws.addEventListener("open", ok, { once: true });
          ws.addEventListener("error", fail, { once: true });
          // ONE persistent handler for the lifetime of this socket.
          ws.addEventListener("message", this.onMessage);
          ws.addEventListener("close", this.onClose);
        } else {
          ws.once("open", ok);
          ws.once("error", fail);
          ws.on("message", this.onMessage);
          ws.on("close", this.onClose);
        }
      });
    }
    this.reconnects = 0;
    // Pass rawRequest so onReady can talk to the just-opened socket WITHOUT re-entering the
    // queue (which is currently held by the request that triggered this open() — that would
    // deadlock).
    if (this.opts.onReady) await this.opts.onReady((f, t) => this.rawRequest(f, t));
    // Lifecycle: first ready -> onConnect; every subsequent ready -> onReconnect. Fired after
    // config/bootstrap is back in place so a substrate can safely re-register dynamic state.
    if (!this.hasConnected) {
      this.hasConnected = true;
      try {
        this.opts.onConnect?.();
      } catch {
        /* user callback must not break the connect path */
      }
    } else {
      try {
        this.opts.onReconnect?.();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Send one frame and await its rpc reply. Does NOT install its own message listener —
   * it just parks `pending`; the persistent {@link onMessage} handler resolves it.
   */
  private rawRequest(frame: Frame, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      const timer = setTimeout(() => {
        // The frame is already on the wire and the kernel is still mid-eval; its late
        // reply would otherwise mis-resolve the NEXT in-flight rpc on this socket
        // (cross-talk). Tear the socket down so the orphaned reply lands on a dead
        // socket and is dropped; the next queued request reconnects fresh (onReady
        // re-applies config).
        if (this.pending && this.pending.timer === timer) this.pending = null;
        this.dropSocket();
        reject(new EngramError("request timed out"));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      try {
        ws.send(JSON.stringify(frame));
      } catch (e) {
        if (this.pending && this.pending.timer === timer) this.pending = null;
        clearTimeout(timer);
        reject(new EngramError("__ws_closed__"));
      }
    });
  }

  request(frame: Frame, timeoutMs: number): Promise<any> {
    const run = async (): Promise<any> => {
      try {
        await this.open();
        return await this.rawRequest(frame, timeoutMs);
      } catch (e: any) {
        const dropped = e instanceof EngramError && e.message === "__ws_closed__";
        // A one-shot injected socket cannot be reopened — never attempt reconnect for it.
        const reconnectable = !this.opts.socket || !!this.opts.openSocket;
        if (this.opts.autoReconnect && reconnectable && !this.closed && dropped) {
          // Detach + close the old socket before replacing it, so its persistent
          // message/close handlers can't fire into the new socket's state.
          this.dropSocket();
          const backoff = Math.min(2000, 100 * 2 ** this.reconnects++);
          await sleep(backoff);
          await this.open();
          return await this.rawRequest(frame, timeoutMs);
        }
        if (dropped) {
          if (this.opts.socket && !this.opts.openSocket) {
            throw new EngramError("injected socket closed and cannot be reopened (use openSocket for reconnect)");
          }
          throw new EngramError("connection closed before reply");
        }
        throw e;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  close(): void {
    this.closed = true;
    this.dropSocket();
  }
}

/**
 * HTTP transport (cloud, with API key). Maps the same `{t,...}` frames onto the
 * supervisor's REST routes so the rest of the SDK is transport-agnostic.
 */
class HttpTransport implements Transport {
  /** Host callbacks require the WS bridge; the cloud HTTP path cannot push hostcalls. */
  readonly supportsHostCalls = false;
  constructor(
    private base: string,
    private apiKey: string,
    private session: string,
  ) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const u = new URL(this.base + path);
    u.searchParams.set("session", this.session);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async call(path: string, init: RequestInit, params?: Record<string, string>): Promise<any> {
    const res = await fetch(this.url(path, params), {
      ...init,
      headers: { ...(init.headers || {}), "x-api-key": this.apiKey },
    });
    const text = await res.text();
    if (!res.ok) throw new EngramError(`cloud ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, raw: text };
    }
  }

  async request(frame: Frame): Promise<any> {
    switch (frame.t) {
      case "create":
        return this.call("/configure", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(frame.config || {}),
        });
      case "eval":
        return this.call("/eval", { method: "GET" }, { src: String(frame.src ?? "") });
      case "ping":
      case "gen":
        return this.call("/status", { method: "GET" });
      case "reset":
        // No first-class reset over HTTP; evict drops the live kernel (snapshot kept).
        return this.call("/evict", { method: "GET" });
      case "evict":
        return this.call("/evict", { method: "GET" });
      case "artifact":
        return this.call("/frame", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(frame),
        });
      default:
        return this.call("/frame", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(frame),
        });
    }
  }

  setHost(): void {
    /* host callbacks require the WS bridge; no-op over HTTP */
  }

  close(): void {
    /* stateless */
  }
}

// ---------------------------------------------------------------------------
// Env / bootstrap composition (SDK-only extension points)
// ---------------------------------------------------------------------------

/**
 * The reserved host channel that records a cell's faithful final value. Calling
 * `host.final(x)` or `host.__engram_final(x)` in-VM round-trips `x` to the SDK as a
 * hostcall whose args cross as FAITHFUL JSON (not the buggy value-preview path).
 */
const FINAL_HOST = "__engram_final";
/** The public in-VM alias for the reserved final channel. Both are registered as host fns. */
const FINAL_ALIAS = "final";
/** The reserved durable context global, persisted across hibernation. */
const CTX_GLOBAL = "__engram_ctx";
/** A reserved global recording the active host-module namespaces (for the wrapping proxy). */
const NS_REGISTRY = "__engram_host_ns";

/**
 * The tiny built-in default prelude. Idempotent (safe to re-run on every reconnect).
 *
 * In-VM, `host` is a recursive Proxy whose `get` trap returns a hostcall-forwarder for
 * EVERY property name — so we cannot override `host.final` / `host.ctx` by assignment
 * (the trap ignores own props). Instead:
 *  - FAITHFUL FINAL is achieved purely SDK-side: the SDK registers host fns named
 *    `"final"` and `"__engram_final"`, so the proxy forwards `host.final(x)` straight to
 *    the SDK with faithful JSON args. We only need to define the `FINAL(x)` global alias
 *    here. (No `host.final` override is needed or possible.)
 *  - `host.ctx` and host-module namespaces (`host.<ns>.<fn>`) are exposed by WRAPPING the
 *    real host proxy in a thin outer proxy: its `get` returns the persisted ctx object for
 *    `'ctx'`, a namespace forwarder object for any registered namespace, and otherwise
 *    falls through to the real proxy (so `host.final`, `host.subLM`, flat names still work).
 */
function defaultEnvPrelude(): string {
  return [
    `(globalThis.${CTX_GLOBAL} ||= {});`,
    `(globalThis.${NS_REGISTRY} ||= {});`,
    // FINAL(x) global alias -> faithful reserved channel (host.final is intercepted SDK-side).
    `globalThis.FINAL = function(x){ globalThis.host.${FINAL_ALIAS}(x); return x; };`,
    // Install the wrapping proxy once. It is idempotent: re-running just rewraps the (already
    // wrapped) host, and the inner real proxy is preserved via the saved __engram_host_real.
    `(function(){`,
    `  if (!globalThis.__engram_host_real) globalThis.__engram_host_real = globalThis.host;`,
    `  var real = globalThis.__engram_host_real;`,
    `  globalThis.host = new Proxy(real, {`,
    `    get: function(t, p, r){`,
    `      if (p === 'ctx') return (globalThis.${CTX_GLOBAL} ||= {});`,
    `      var ns = globalThis.${NS_REGISTRY};`,
    `      if (ns && typeof p === 'string' && ns[p]) {`,
    `        var fns = ns[p], mod = {};`,
    `        for (var i=0;i<fns.length;i++){ (function(fn){ mod[fn] = function(){ return real[p+'.'+fn].apply(null, arguments); }; })(fns[i]); }`,
    `        return mod;`,
    `      }`,
    `      return Reflect.get(t, p, r);`,
    `    }`,
    `  });`,
    `})();`,
  ].join("\n");
}

/** Serialise a {@link RuntimeEnv}'s globals into an idempotent in-VM bootstrap (`g.<name> ||= <fn>`). */
function serialiseEnvGlobals(globals?: Record<string, (...a: any[]) => any>): string {
  if (!globals) return "";
  const lines: string[] = [];
  for (const [name, fn] of Object.entries(globals)) {
    lines.push(`globalThis[${JSON.stringify(name)}] ||= (${fn.toString()});`);
  }
  return lines.join("\n");
}

/**
 * Register a host-module namespace in the in-VM {@link NS_REGISTRY} so the wrapping proxy
 * (see {@link defaultEnvPrelude}) exposes it as `host.<ns>.<fn>`, forwarding to the flat
 * reserved name `<ns>.<fn>`. Idempotent.
 */
function hostModuleShim(namespace: string, fnNames: string[]): string {
  return [
    `(globalThis.${NS_REGISTRY} ||= {});`,
    `globalThis.${NS_REGISTRY}[${JSON.stringify(namespace)}] = ${JSON.stringify(fnNames)};`,
  ].join("\n");
}

/** Compose explicit bootstrap + default env prelude + env.globals + env.prelude + host-module shims. */
function composeBootstrap(parts: {
  bootstrap?: string;
  env?: RuntimeEnv;
  hostModules?: Record<string, HostModule>;
}): string | undefined {
  const segments: string[] = [];
  // Built-in default prelude first (wires host.final / FINAL / host.ctx).
  segments.push(defaultEnvPrelude());
  if (parts.env) {
    const g = serialiseEnvGlobals(parts.env.globals);
    if (g) segments.push(g);
    if (typeof parts.env.prelude === "string" && parts.env.prelude.length) segments.push(parts.env.prelude);
  }
  if (parts.hostModules) {
    for (const [ns, mod] of Object.entries(parts.hostModules)) {
      segments.push(hostModuleShim(ns, Object.keys(mod)));
    }
  }
  // Explicit user bootstrap runs LAST so it can override/extend env-provided globals.
  if (typeof parts.bootstrap === "string" && parts.bootstrap.length) segments.push(parts.bootstrap);
  return segments.length ? segments.join("\n") : undefined;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** A live, durable Engram session. Create one with {@link Engram.connect}. */
export class EngramSession {
  /** The session id (durable across hibernation). */
  readonly session: string;

  private throwOnError: boolean;
  private timeoutMs: number;
  private config: EngramConfig;
  private bootstrap?: string;
  private onConsole?: (line: ConsoleLine) => void;
  /** Eval interceptor chain (outermost first). Empty = no wrapping. */
  private interceptors: EvalInterceptor[];

  /** Monotonic correlation id for vfs-* frames (cosmetic — WS matches positionally, the DO echoes it back). */
  private _vfsId = 0;

  /**
   * Per-eval capture of the LAST `host.__engram_final(value)` hostcall. `WsTransport`
   * serialises one rpc at a time, so attribution to the in-flight eval is unambiguous.
   * Reset before each eval (see {@link EngramSession.eval}).
   */
  private capturedFinal: { set: boolean; value: unknown } = { set: false, value: undefined };

  /** First-class durable context accessor (`session.ctx.set/get`), backed by the persisted ctx global. */
  readonly ctx: {
    /** Persist `value` under `key` in the durable ctx map (survives hibernation). */
    set: (key: string, value: unknown) => Promise<void>;
    /** Read a value previously stored in the durable ctx map. */
    get: <T = unknown>(key: string) => Promise<T | undefined>;
  };

  /**
   * Tier-2 sandbox bridge (`session.sandbox.*`). Drives the engram-sandbox Linux container worker
   * over the SHARED R2 VFS: the container mounts THIS session's `fs/<doId>/` prefix as `/workspace`,
   * so files written by a cell (`host.fs.writeFile('/x')`) are visible at `/workspace/x` inside the
   * container, and container outputs under `/workspace` land back in R2 readable by a later cell.
   *
   * Serviced entirely DO-side (NO eval mutex, never touches the VM heap) by a kernel->sandbox fetch
   * that adds the Bearer key from the kernel env — the key never crosses the wire to the client.
   * Requires `config.sandbox: true` (else every call throws `SandboxUnavailable`) and the WebSocket
   * kernel transport (these frames are unavailable over the HTTP/cloud transport).
   */
  readonly sandbox: {
    /** Run a shell command in the container (cwd defaults to `/workspace`, the R2-backed root). */
    exec: (
      cmd: string,
      opts?: { cwd?: string; timeoutMs?: number },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }>;
    /** Git op in the container (default `checkout`); clones into the R2-backed workspace. */
    git: (
      args: { op?: string; repo?: string; branch?: string; dir?: string },
      opts?: { timeoutMs?: number },
    ) => Promise<{ ok: boolean }>;
    /** Write a file into the container workspace (lands in R2 at `fs/<doId>/<path>`). */
    writeFile: (path: string, content: string, opts?: { timeoutMs?: number }) => Promise<{ ok: boolean }>;
    /** Read a file from the container workspace. */
    readFile: (path: string, opts?: { timeoutMs?: number }) => Promise<{ content: string }>;
    /** List a directory in the container workspace. */
    list: (path: string, opts?: { timeoutMs?: number }) => Promise<unknown>;
    /** Expose a container port and get a public preview URL. */
    expose: (port: number, opts?: { timeoutMs?: number }) => Promise<{ url?: string } & Record<string, unknown>>;
  };

  /** @internal */
  constructor(
    private transport: Transport,
    opts: {
      session: string;
      throwOnError: boolean;
      timeoutMs: number;
      config: EngramConfig;
      bootstrap?: string;
      onConsole?: (l: ConsoleLine) => void;
      onEval?: EvalInterceptor | EvalInterceptor[];
    },
  ) {
    this.session = opts.session;
    this.throwOnError = opts.throwOnError;
    this.timeoutMs = opts.timeoutMs;
    this.config = opts.config;
    this.bootstrap = opts.bootstrap;
    this.onConsole = opts.onConsole;
    this.interceptors = opts.onEval ? (Array.isArray(opts.onEval) ? opts.onEval.slice() : [opts.onEval]) : [];
    // Reserved final channel: record the LAST arg of each host.final / host.__engram_final
    // call this eval. Both names are registered so the in-VM host proxy forwards them here
    // with FAITHFUL JSON args (the kernel dispatches client-registered names to the client).
    const captureFinal = (...args: unknown[]): unknown => {
      this.capturedFinal = { set: true, value: args.length ? args[0] : undefined };
      return args.length ? args[0] : undefined;
    };
    this.transport.setHost(FINAL_HOST, captureFinal);
    this.transport.setHost(FINAL_ALIAS, captureFinal);
    // First-class ctx accessor over the persisted ctx global (reserved hostfn marshals values).
    this.ctx = {
      set: async (key: string, value: unknown): Promise<void> => {
        await this.transport.request(
          {
            t: "eval",
            src: `(globalThis.${CTX_GLOBAL} ||= {})[${JSON.stringify(key)}] = ${JSON.stringify(value)}; void 0`,
          },
          this.timeoutMs,
        );
      },
      get: async <T = unknown>(key: string): Promise<T | undefined> => {
        const reply = await this.transport.request(
          { t: "eval", src: `(globalThis.${CTX_GLOBAL} ||= {})[${JSON.stringify(key)}]` },
          this.timeoutMs,
        );
        const r = this.normalize<T>(reply);
        return (r.value as T) ?? undefined;
      },
    };
    // Tier-2 sandbox bridge. Each call is a WS-only, DO-side `{t:"sandbox"}` frame (id-correlated,
    // bearer-auth inherited); the kernel adds the sandbox key from env. exec/git use a longer wire
    // timeout (container cold-start can take ~30-60s); throws toTypedError on reply.ok===false.
    const sandboxRequest = async (frame: Frame, timeoutMs: number): Promise<any> => {
      this._requireVfsTransport("sandbox." + String(frame.op ?? "call"));
      const reply = await this.transport.request(frame, timeoutMs);
      if (reply?.ok === false) {
        // The kernel reports sandbox errors as a STRING (e.g. "SandboxUnavailable: config.sandbox
        // not enabled"). Normalize to the typed-error shape; the capability-off case maps to the
        // typed SandboxDisabledError so callers can `instanceof`-check a disabled sandbox.
        const raw = reply.error;
        let info: EvalErrorInfo;
        if (typeof raw === "string") {
          const disabled = /SandboxUnavailable|config\.sandbox\s+not\s+enabled/i.test(raw);
          info = { name: disabled ? "SandboxDisabledError" : "SandboxError", message: raw };
        } else {
          info = raw || { name: "SandboxError", message: "sandbox call failed" };
        }
        throw toTypedError(info);
      }
      return reply;
    };
    // Container cold-start clamp (mirrors invokeWorker's wireTimeout): a generous default for the
    // heavy ops, plus slack, capped so a wedged container can't hang the rpc forever.
    const sandboxWire = (timeoutMs: number | undefined, dflt: number) =>
      Math.min(timeoutMs ?? dflt, 120000) + 5000;
    this.sandbox = {
      exec: async (cmd, opts = {}) => {
        const id = this._nextVfsId();
        const reply = await sandboxRequest(
          { t: "sandbox", id, op: "exec", cmd, cwd: opts.cwd },
          sandboxWire(opts.timeoutMs, 60000),
        );
        const v = (reply?.value ?? {}) as Record<string, unknown>;
        return {
          stdout: String(v.stdout ?? ""),
          stderr: String(v.stderr ?? ""),
          exitCode: typeof v.exitCode === "number" ? v.exitCode : Number(v.exitCode ?? 0),
          success: v.success === true || v.exitCode === 0,
        };
      },
      git: async (args, opts = {}) => {
        const id = this._nextVfsId();
        const reply = await sandboxRequest(
          { t: "sandbox", id, op: "git", gitOp: args.op ?? "checkout", repo: args.repo, branch: args.branch, dir: args.dir },
          sandboxWire(opts.timeoutMs, 60000),
        );
        const v = (reply?.value ?? {}) as Record<string, unknown>;
        return { ok: v.ok === true };
      },
      writeFile: async (path, content, opts = {}) => {
        const id = this._nextVfsId();
        const reply = await sandboxRequest(
          { t: "sandbox", id, op: "write", path, content },
          opts.timeoutMs ?? this.timeoutMs,
        );
        const v = (reply?.value ?? {}) as Record<string, unknown>;
        return { ok: v.ok === true };
      },
      readFile: async (path, opts = {}) => {
        const id = this._nextVfsId();
        const reply = await sandboxRequest(
          { t: "sandbox", id, op: "read", path },
          opts.timeoutMs ?? this.timeoutMs,
        );
        const v = (reply?.value ?? {}) as Record<string, unknown>;
        return { content: String(v.content ?? "") };
      },
      list: async (path, opts = {}) => {
        const id = this._nextVfsId();
        const reply = await sandboxRequest(
          { t: "sandbox", id, op: "list", path },
          opts.timeoutMs ?? this.timeoutMs,
        );
        return reply?.value;
      },
      expose: async (port, opts = {}) => {
        const id = this._nextVfsId();
        const reply = await sandboxRequest(
          { t: "sandbox", id, op: "expose", port },
          opts.timeoutMs ?? this.timeoutMs,
        );
        return (reply?.value ?? {}) as { url?: string } & Record<string, unknown>;
      },
    };
  }

  /**
   * `true` if the underlying transport can deliver VM->host calls (`host.<name>()`). The WS
   * transport is `true`; the cloud HTTP transport is `false`, where {@link bindHost} /
   * {@link defineHostModule} are silent no-ops. Check this before relying on host tools so a
   * misconfigured substrate fails loud instead of silently dropping callbacks.
   */
  get supportsHostCalls(): boolean {
    return this.transport.supportsHostCalls === true;
  }

  /**
   * Append an {@link EvalInterceptor} at runtime (composes after any from
   * {@link ConnectOptions.onEval}). The newly-added interceptor becomes the innermost wrapper.
   * Returns `this` for chaining.
   */
  use(interceptor: EvalInterceptor): this {
    this.interceptors.push(interceptor);
    return this;
  }

  /**
   * Build a session over a CUSTOM {@link Transport} you already constructed. The lower-level
   * counterpart to {@link Engram.connect} for substrates that own their own channel (service
   * binding, DO-to-DO RPC, in-process). You are responsible for applying config: call
   * {@link EngramSession._applyConfig} (or send the `{t:'create'}` frame yourself) after this.
   * `connect({ transport })` does that wiring for you.
   */
  static fromTransport(
    transport: Transport,
    opts: {
      session?: string;
      throwOnError?: boolean;
      timeoutMs?: number;
      config?: EngramConfig;
      bootstrap?: string;
      onConsole?: (l: ConsoleLine) => void;
      onEval?: EvalInterceptor | EvalInterceptor[];
    } = {},
  ): EngramSession {
    return new EngramSession(transport, {
      session: opts.session ?? "default",
      throwOnError: opts.throwOnError !== false,
      timeoutMs: opts.timeoutMs ?? 60000,
      config: { ...(opts.config || {}) },
      bootstrap: opts.bootstrap,
      onConsole: opts.onConsole,
      onEval: opts.onEval,
    });
  }

  /** @internal applied once when the transport first connects. */
  async _applyConfig(): Promise<void> {
    if (this.config && Object.keys(this.config).length) {
      await this.transport.request({ t: "create", config: this.config }, this.timeoutMs);
    }
    // Seed VM globals once after create, before any user eval (runs on every reconnect).
    if (this.bootstrap) {
      await this.transport.request({ t: "eval", src: this.bootstrap }, this.timeoutMs);
    }
  }

  /**
   * Evaluate one cell against the persisted namespace. The same global scope is shared
   * across calls and survives hibernation, so `eval("x=1")` then `eval("x")` returns 1.
   *
   * @param code JavaScript source. The cell's last expression is its value; `await` is allowed.
   * @param opts `throwOnError` overrides the session default for this call; `timeoutMs` overrides the timeout.
   * @returns a typed {@link EvalResult}. Throws a typed {@link EngramError} on failure unless `throwOnError` is false.
   */
  async eval<T = unknown, F = unknown>(code: string, opts: { throwOnError?: boolean; timeoutMs?: number } = {}): Promise<EvalResult<T, F>> {
    // No interceptors: straight to the core (the common, zero-overhead path).
    if (!this.interceptors.length) return this._evalCore<T, F>(code, opts);
    // Build the chain inside-out: the core is the innermost `next`; each interceptor wraps it.
    let next: (c: string) => Promise<EvalResult> = (c) => this._evalCore(c, opts) as Promise<EvalResult>;
    for (let i = this.interceptors.length - 1; i >= 0; i--) {
      const mw = this.interceptors[i]!;
      const inner = next;
      next = (c) => mw(c, opts, inner);
    }
    return next(code) as Promise<EvalResult<T, F>>;
  }

  /** The actual eval rpc + result normalisation, wrapped by any {@link EvalInterceptor}s. */
  private async _evalCore<T = unknown, F = unknown>(code: string, opts: { throwOnError?: boolean; timeoutMs?: number }): Promise<EvalResult<T, F>> {
    // Reset the captured final before each eval; the reserved __engram_final hostfn
    // records the LAST value during this (serialised) rpc.
    this.capturedFinal = { set: false, value: undefined };
    const reply = await this.transport.request({ t: "eval", src: code }, opts.timeoutMs ?? this.timeoutMs);
    const result = this.normalize<T, F>(reply);
    // Surface the faithful final (crossed as hostcall args, not the value-preview path).
    result.finalSet = this.capturedFinal.set;
    if (this.capturedFinal.set) result.final = this.capturedFinal.value as F;
    for (const line of result.console) this.onConsole?.(line);
    const shouldThrow = opts.throwOnError ?? this.throwOnError;
    if (!result.ok && shouldThrow) {
      throw toTypedError(result.error || { name: "EngramError", message: "eval failed" }, result as EvalResult);
    }
    return result;
  }

  /** Normalise a raw kernel/cloud reply into a typed {@link EvalResult}. */
  private normalize<T, F = unknown>(reply: any): EvalResult<T, F> {
    const console: ConsoleLine[] = Array.isArray(reply?.logs)
      ? reply.logs.map((l: any) =>
          typeof l === "string"
            ? { level: "log", text: l }
            : { level: l.level || "log", text: l.text ?? l.msg ?? String(l) },
        )
      : [];
    let value: any = reply?.value;
    const vt = reply?.valueType;
    // Objects/arrays arrive as a JSON preview string — parse back to a real value when possible.
    if ((vt === "object" || vt === "array") && typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        /* keep the string preview */
      }
    }
    return {
      ok: reply?.ok !== false,
      value,
      valuePreview: typeof reply?.valuePreview === "string" ? reply.valuePreview : undefined,
      valueType: vt,
      mimeBundle: reply?.mimeBundle && typeof reply.mimeBundle === "object" ? reply.mimeBundle : undefined,
      outputs: Array.isArray(reply?.outputs) ? reply.outputs : [],
      console,
      error: reply?.error || undefined,
      checkpoint: reply?.checkpoint || undefined,
      cell: typeof reply?.cell === "number" ? reply.cell : undefined,
      // Populated by eval() after the rpc returns (the captured final is per-eval).
      finalSet: false,
    };
  }

  /** Read a server-side artifact descriptor or handle into a string. */
  async readArtifact(artifact: ArtifactValue | string, opts: { timeoutMs?: number; chunkChars?: number } = {}): Promise<string> {
    let out = "";
    for await (const chunk of this.streamArtifact(artifact, opts)) out += chunk;
    return out;
  }

  /** Stream a server-side text artifact in protocol chunks. */
  async *streamArtifact(artifact: ArtifactValue | string, opts: { timeoutMs?: number; chunkChars?: number } = {}): AsyncIterable<string> {
    const handle = typeof artifact === "string" ? artifact : artifact.handle;
    if (!handle) throw new EngramError("artifact handle is required");
    let offset = 0;
    const fallbackLen = typeof artifact === "string" ? 128 * 1024 : artifact.chunkMaxChars || 128 * 1024;
    const len = Math.max(1, Math.min(opts.chunkChars || fallbackLen, 128 * 1024));
    for (;;) {
      const reply = await this.transport.request({ t: "artifact", handle, offset, len }, opts.timeoutMs ?? this.timeoutMs);
      if (reply?.ok === false) {
        throw toTypedError(reply.error || { name: "ArtifactError", message: "artifact read failed" });
      }
      if (typeof reply?.data !== "string") throw new EngramError("artifact chunk missing string data");
      yield reply.data;
      offset += reply.data.length;
      if (reply.done || reply.data.length === 0) break;
    }
  }

  // ---- vfs (host.fs R2 store, serviced DO-side, off-VM) ----
  //
  // These talk to the host.fs **R2** file store (config.fs.provider:'r2') — bodies live
  // off-heap in R2, keyed under the same session-scoped `fs/<doId>/` prefix host.fs uses.
  // A file written here is visible to a later cell via `host.fs.*` always, and via the bare
  // `fs.*` builtin when the session was created with `config.fs.provider:'r2'`. It does NOT
  // touch the default in-heap VFS (the mem-capped `fs` builtin living in WASM linear memory).
  //
  // Serviced entirely DO-side against R2 — never through the VM eval — so it bypasses the
  // per-cell instruction budget AND the WASM heap/mem cap. Bytes cross the wire as base64;
  // reads stream in chunks, writes support an absolute `offset` for chunked/append upload.
  //
  // WS-only: these frames need the bidirectional kernel socket. Over the HTTP (cloud)
  // transport they throw a clear error (mirrors {@link supportsHostCalls}).

  /** Throw a clear error if the active transport can't service vfs frames (HTTP/cloud). */
  private _requireVfsTransport(op: string): void {
    if (this.transport.supportsHostCalls !== true) {
      throw new EngramError(
        `${op}() requires the WebSocket kernel transport; it is not available over the HTTP (cloud) transport`,
      );
    }
  }

  private _nextVfsId(): number {
    this._vfsId = (this._vfsId + 1) & 0x7fffffff;
    return this._vfsId;
  }

  /**
   * Stream a file from the host.fs R2 store in raw byte chunks. Resumes from the tracked
   * offset across reconnects (each chunk is an independent ranged frame).
   *
   * @param path session-scoped vfs path (normalised + isolated DO-side).
   */
  async *streamReadFile(
    path: string,
    opts: { timeoutMs?: number; chunkBytes?: number; offset?: number; cwd?: string } = {},
  ): AsyncIterable<Uint8Array> {
    this._requireVfsTransport("readFile");
    let offset = Math.max(0, opts.offset || 0);
    // base64 inflates ~33%; keep raw chunk conservative (default 256KB, hard-cap 1MB).
    const len = Math.max(1, Math.min(opts.chunkBytes || 256 * 1024, 1024 * 1024));
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    // Relative paths resolve DO-side against this cwd (default /workspace, the ONE fs root).
    const cwd = opts.cwd ?? "/workspace";
    for (;;) {
      const id = this._nextVfsId();
      const reply = await this.transport.request({ t: "vfs-read", id, path, cwd, offset, len }, timeout);
      if (reply?.ok === false) {
        throw toTypedError(reply.error || { name: "VfsError", message: `vfs read failed: ${path}` });
      }
      const b64 = typeof reply?.dataB64 === "string" ? reply.dataB64 : "";
      const bytes = b64 ? b64ToBytes(b64) : new Uint8Array(0);
      if (bytes.length) {
        yield bytes;
        offset += bytes.length;
      }
      if (reply?.eof || bytes.length === 0) break;
    }
  }

  /** Read an entire file from the host.fs R2 store into a single byte buffer. */
  async readFile(path: string, opts: { timeoutMs?: number; chunkBytes?: number; cwd?: string } = {}): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.streamReadFile(path, opts)) {
      parts.push(chunk);
      total += chunk.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  /**
   * Sugar over {@link readFile} for small files. The SDK is always async over the wire — the
   * `Sync` name is the Node-fs naming convention, not a synchronous call.
   */
  readFileSync(path: string, opts: { timeoutMs?: number; chunkBytes?: number } = {}): Promise<Uint8Array> {
    return this.readFile(path, opts);
  }

  /**
   * Write a file (or stream) to the host.fs R2 store. Bytes are chunked; each chunk carries an
   * absolute `offset` so a retried/reconnected chunk overwrites its range idempotently rather
   * than double-appending. The first frame carries `truncate` (default `true` → replace the
   * file); subsequent frames append at the advancing offset.
   *
   * Accepts a `Uint8Array` / `ArrayBuffer` / string (utf8) or an `AsyncIterable` of byte chunks
   * for streaming uploads. Returns the total bytes written.
   *
   * Note: random-offset writes into an existing file rewrite the whole object DO-side (R2 has
   * no partial update); chunked append (monotonic offset) is the efficient path.
   */
  async writeFile(
    path: string,
    data: Uint8Array | ArrayBuffer | string | AsyncIterable<Uint8Array | ArrayBuffer | string> | Iterable<Uint8Array | ArrayBuffer | string>,
    opts: { timeoutMs?: number; chunkBytes?: number; offset?: number; truncate?: boolean; cwd?: string } = {},
  ): Promise<number> {
    this._requireVfsTransport("writeFile");
    const chunkBytes = Math.max(1, Math.min(opts.chunkBytes || 256 * 1024, 1024 * 1024));
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    // Relative paths resolve DO-side against this cwd (default /workspace, the ONE fs root).
    const cwd = opts.cwd ?? "/workspace";
    let offset = Math.max(0, opts.offset || 0);
    let written = 0;
    let first = true;

    const sendChunk = async (bytes: Uint8Array): Promise<void> => {
      // Slice large inputs into <=chunkBytes frames so a single WS frame stays bounded.
      for (let i = 0; i < bytes.length || (first && bytes.length === 0); i += chunkBytes) {
        const slice = bytes.subarray(i, i + chunkBytes);
        const id = this._nextVfsId();
        const reply = await this.transport.request(
          {
            t: "vfs-write",
            id,
            path,
            cwd,
            dataB64: bytesToB64(slice),
            offset,
            // First frame honours `truncate` (default replace); later frames append.
            truncate: first ? opts.truncate !== false : false,
          },
          timeout,
        );
        if (reply?.ok === false) {
          throw toTypedError(reply.error || { name: "VfsError", message: `vfs write failed: ${path}` });
        }
        offset += slice.length;
        written += slice.length;
        first = false;
        if (bytes.length === 0) break; // empty-file truncate frame
      }
    };

    // AsyncIterable / Iterable (streaming upload) vs a single value.
    const obj = data as unknown as Record<symbol, unknown>;
    const asyncIt = typeof obj[Symbol.asyncIterator] === "function";
    const syncIt = typeof obj[Symbol.iterator] === "function";
    if (typeof data !== "string" && !(data instanceof Uint8Array) && !(data instanceof ArrayBuffer) && (asyncIt || syncIt)) {
      if (asyncIt) {
        for await (const part of data as AsyncIterable<Uint8Array | ArrayBuffer | string>) {
          await sendChunk(toBytes(part));
        }
      } else {
        for (const part of data as Iterable<Uint8Array | ArrayBuffer | string>) {
          await sendChunk(toBytes(part));
        }
      }
      // A stream that yielded nothing still needs to truncate the target to empty.
      if (first) await sendChunk(new Uint8Array(0));
    } else {
      await sendChunk(toBytes(data as Uint8Array | ArrayBuffer | string));
    }
    return written;
  }

  /** Sugar over {@link writeFile} (Node-fs naming; still async over the wire). */
  writeFileSync(
    path: string,
    data: Uint8Array | ArrayBuffer | string,
    opts: { timeoutMs?: number; chunkBytes?: number; offset?: number; truncate?: boolean; cwd?: string } = {},
  ): Promise<number> {
    return this.writeFile(path, data, opts);
  }

  /** List the immediate children of a directory in the host.fs R2 store. */
  async ls(path: string, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<VfsEntry[]> {
    this._requireVfsTransport("ls");
    const id = this._nextVfsId();
    const cwd = opts.cwd ?? "/workspace";
    const reply = await this.transport.request({ t: "vfs-ls", id, path, cwd }, opts.timeoutMs ?? this.timeoutMs);
    if (reply?.ok === false) {
      throw toTypedError(reply.error || { name: "VfsError", message: `vfs ls failed: ${path}` });
    }
    return Array.isArray(reply?.entries) ? (reply.entries as VfsEntry[]) : [];
  }

  /**
   * Reconcile the host.fs file namespace from the live R2 prefix `fs/<doId>/`.
   *
   * The Tier-2 sandbox container writes file bodies DIRECTLY to R2 (via its s3fs mount), so a file
   * it creates has no kernel `fs_files` row and is INVISIBLE to `host.fs` / `s.readFile` / `ls`
   * until this runs. Call `syncFs()` after a container write to make those files readable from the
   * cell / SDK (the container->cell half of the shared-VFS round-trip). Returns the reconciled file
   * list. Cell-written files (host.fs / `s.writeFile`) are already durable + visible without this.
   */
  async syncFs(opts: { timeoutMs?: number } = {}): Promise<{ path: string; size: number }[]> {
    this._requireVfsTransport("syncFs");
    const id = this._nextVfsId();
    const reply = await this.transport.request({ t: "vfs-sync", id }, opts.timeoutMs ?? this.timeoutMs);
    if (reply?.ok === false) {
      throw toTypedError(reply.error || { name: "VfsError", message: "vfs sync failed" });
    }
    return Array.isArray(reply?.files) ? (reply.files as { path: string; size: number }[]) : [];
  }

  /** Stat a file/directory in the host.fs R2 store. Throws if absent (ENOENT). */
  async stat(path: string, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<VfsStat> {
    this._requireVfsTransport("stat");
    const id = this._nextVfsId();
    const cwd = opts.cwd ?? "/workspace";
    const reply = await this.transport.request({ t: "vfs-stat", id, path, cwd }, opts.timeoutMs ?? this.timeoutMs);
    if (reply?.ok === false) {
      throw toTypedError(reply.error || { name: "VfsError", message: `vfs stat failed: ${path}` });
    }
    return reply.stat as VfsStat;
  }

  // ---- worker registry (content-addressed Dynamic-Worker-Loader isolates) ----
  //
  // A registered worker is a STATIC, hash-identified JS source block, stored durably in R2,
  // invokable many times in a FRESH Worker-Loader isolate that shares the SAME session-scoped
  // R2 VFS (`fs/<doId>/`) the kernel + vfs-* frames see. This is the "muscle" tier: stateless
  // heavy/parallel compute decoupled from the single-threaded durable kernel DO; durable results
  // land in shared R2 (via the worker's `env.VFS`), and the kernel orchestrates.
  //
  // Frames are serviced entirely DO-side — they never touch the VM heap (no eval mutex) — and
  // inherit the session's bearer auth. Correlation mirrors the vfs-* frames: a client `id` is
  // echoed back by the DO.
  //
  // WS-only: these frames need the bidirectional kernel socket. Over the HTTP (cloud) transport
  // they throw a clear error (mirrors the vfs-* methods).

  /**
   * Register a worker source. Content-addressed + idempotent: the returned `hash` is the lowercase
   * hex sha256 of `source`, so the same source always yields the same hash. The source is stored
   * durably in R2 under a global registry prefix; a per-session registry row gates invocation.
   *
   * @param source UTF-8 JS (ESM) source. Must `export async function run(input, env)` (or
   *   `export default { run }`), or `export default { async fetch(req, env) }` as an escape hatch.
   *   Capped at 512KB.
   * @returns the content hash plus whether this session had already registered it.
   */
  async registerWorker(source: string, opts: { timeoutMs?: number } = {}): Promise<WorkerRegistration> {
    this._requireVfsTransport("registerWorker");
    const id = this._nextVfsId();
    const reply = await this.transport.request({ t: "worker-register", id, source }, opts.timeoutMs ?? this.timeoutMs);
    if (reply?.ok === false) {
      throw toTypedError(reply.error || { name: "RegistryError", message: "worker register failed" });
    }
    return {
      hash: String(reply?.hash ?? ""),
      bytes: typeof reply?.bytes === "number" ? reply.bytes : 0,
      cached: reply?.cached === true,
    };
  }

  /**
   * Invoke a previously-registered worker in a fresh (warm-cached-by-hash) isolate. The `input` is
   * passed as a JSON value to the worker's `run(input, env)`; its JSON-serialisable return value is
   * resolved here. The worker runs with NO egress and only the shared session VFS as its I/O channel.
   *
   * @param hash the content hash returned by {@link registerWorker} (`^[0-9a-f]{64}$`).
   * @param input any JSON-serialisable value (capped ~1MB; larger data flows through the shared VFS).
   * @param opts per-invoke wall timeout / CPU budget.
   * @throws a typed error on `NotRegisteredError` / `ContractError` / `WorkerCpuError` /
   *   `WorkerTimeoutError` / `WorkerRuntimeError` / `OutputTooLargeError`.
   */
  async invokeWorker<T = unknown>(hash: string, input?: unknown, opts: InvokeWorkerOptions = {}): Promise<T> {
    this._requireVfsTransport("invokeWorker");
    const id = this._nextVfsId();
    const frame: Frame = { t: "worker-invoke", id, hash, input };
    if (typeof opts.timeoutMs === "number") frame.timeoutMs = opts.timeoutMs;
    if (typeof opts.cpuMs === "number") frame.cpuMs = opts.cpuMs;
    // Bound the await on the timeout the DO honours (default 30s, cap 120s) plus slack.
    const wireTimeout = Math.min(opts.timeoutMs ?? 30000, 120000) + 5000;
    const reply = await this.transport.request(frame, wireTimeout);
    if (reply?.ok === false) {
      throw toTypedError(reply.error || { name: "WorkerRuntimeError", message: `worker invoke failed: ${hash}` });
    }
    return reply?.output as T;
  }

  /** List this session's registered workers (the per-session registry index). */
  async listWorkers(opts: { timeoutMs?: number } = {}): Promise<WorkerRecord[]> {
    this._requireVfsTransport("listWorkers");
    const id = this._nextVfsId();
    const reply = await this.transport.request({ t: "worker-list", id }, opts.timeoutMs ?? this.timeoutMs);
    if (reply?.ok === false) {
      throw toTypedError(reply.error || { name: "RegistryError", message: "worker list failed" });
    }
    return Array.isArray(reply?.workers) ? (reply.workers as WorkerRecord[]) : [];
  }

  // ---- durable key/value sugar (over the persisted namespace) ----

  /** Store a JSON-serialisable value under `key` in the durable namespace (survives hibernation). */
  async set(key: string, value: unknown): Promise<void> {
    await this.eval(
      `(globalThis.__kv ||= {})[${JSON.stringify(key)}] = ${JSON.stringify(value)}; void 0`,
    );
  }

  /** Read a value previously stored with {@link set}. Returns `undefined` if absent. */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.eval<T>(`(globalThis.__kv ||= {})[${JSON.stringify(key)}]`);
    return r.value ?? undefined;
  }

  // ---- lifecycle / durability ----

  /** Clear the namespace and start a fresh epoch (drops the snapshot). */
  async reset(): Promise<void> {
    await this.transport.request({ t: "reset" }, this.timeoutMs);
  }

  /** Liveness + generation/state probe. */
  async status(): Promise<{ generation?: number; inMemory?: boolean; [k: string]: unknown }> {
    return this.transport.request({ t: "gen" }, this.timeoutMs);
  }

  /** Force-evict the in-memory kernel. The durable snapshot is kept; the next op cold-restores. */
  async evict(): Promise<void> {
    await this.transport.request({ t: "evict" }, this.timeoutMs);
  }

  /**
   * Round-trip durability check: evict the live kernel, then touch it to force a cold
   * restore from the snapshot. Returns the restore source the kernel reported
   * (`"sqlite-restore"` / `"r2-restore"`), proving state came back without replay.
   */
  async hibernateThenResume(): Promise<{ restoreSource?: string; generation?: number }> {
    await this.evict();
    // Touch the kernel so it actually restores (the eval reply carries the restore source).
    const reply = await this.transport.request({ t: "eval", src: "1" }, this.timeoutMs);
    return { restoreSource: reply?.restoreSource, generation: reply?.generation };
  }

  /**
   * Register a host function the VM can invoke as `host.<name>(...args)` mid-eval. The
   * kernel sends an out-of-band hostcall frame; the SDK awaits `fn(...args)` and replies
   * with the result so the parked VM call resumes. No-op over the HTTP (cloud) transport.
   */
  bindHost(name: string, fn: (...args: unknown[]) => unknown | Promise<unknown>): void {
    this.transport.setHost(name, fn);
  }

  /**
   * Typed overload of {@link bindHost}: register a host fn with explicit arg/return types.
   * The VM still calls it flat as `host.<name>(...args)`. No-op over the HTTP (cloud) transport.
   */
  defineHost<A extends unknown[] = unknown[], R = unknown>(
    name: string,
    fn: (...args: A) => R | Promise<R>,
  ): void {
    this.transport.setHost(name, fn as HostFn);
  }

  /**
   * Register a namespaced bundle of host fns. Each fn is bound flat under the literal
   * name `<namespace>.<fn>` (the kernel dispatches any name), and a namespacing shim is
   * installed in-VM (idempotently, surviving reconnect) so the VM calls
   * `host.<namespace>.<fn>(...)`. No-op for the dispatch part is impossible over HTTP
   * (the cloud transport ignores host binds), but the shim eval is still applied.
   */
  defineHostModule(namespace: string, mod: HostModule): void {
    for (const [fnName, fn] of Object.entries(mod)) {
      this.transport.setHost(`${namespace}.${fnName}`, fn as HostFn);
    }
    // Install the namespacing shim now (best-effort) and make it part of the durable
    // bootstrap so it is re-applied on every reconnect / cold restore.
    const shim = hostModuleShim(namespace, Object.keys(mod));
    this.bootstrap = this.bootstrap ? `${this.bootstrap}\n${shim}` : shim;
    void this.transport.request({ t: "eval", src: shim }, this.timeoutMs).catch(() => {});
  }

  /** Close the transport. The durable session persists server-side and can be reconnected. */
  close(): void {
    this.transport.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The SDK entry point. */
export const Engram = {
  /**
   * Connect (or reattach) to a durable Engram session. Auto-detects the transport:
   * an `apiKey` (or an `http(s)://...cloud...` url) selects the multi-tenant cloud
   * (HTTP); otherwise it opens a WebSocket to the bare kernel.
   *
   * @example
   * const s = await Engram.connect({ url: "wss://engram-kernel.example.workers.dev", session: "demo" });
   * const r = await s.eval("2 + 2");   // r.value === 4
   */
  async connect(opts: ConnectOptions): Promise<EngramSession> {
    const custom = !!(opts && opts.transport);
    const injected = !!(opts && (opts.socket || opts.openSocket));
    if (!opts || (!opts.url && !injected && !custom)) {
      throw new EngramError("connect({ url }) is required (or pass { socket } / { openSocket } / { transport })");
    }
    const session = opts.session || "default";
    const throwOnError = opts.throwOnError !== false;
    const autoReconnect = opts.autoReconnect !== false;
    const timeoutMs = opts.timeoutMs ?? 60000;
    const config = { ...(opts.config || {}) };
    // env.modules feeds config.modules (explicit config.modules wins if both given).
    if (opts.env && opts.env.modules !== undefined && config.modules === undefined) {
      config.modules = opts.env.modules;
    }
    // Compose: built-in final/ctx prelude + env.globals + env.prelude + host-module shims + explicit bootstrap.
    const bootstrap = composeBootstrap({
      bootstrap: typeof opts.bootstrap === "string" && opts.bootstrap.length ? opts.bootstrap : undefined,
      env: opts.env,
      hostModules: opts.hostModules,
    });
    const base = opts.url ? String(opts.url).replace(/\/+$/, "") : "";

    // Cloud HTTP path: an API key + an http(s) endpoint. Never for injected sockets.
    const isHttp = !injected && /^https?:\/\//i.test(base);
    const applyHost = (s: EngramSession) => {
      if (opts.host) for (const [name, fn] of Object.entries(opts.host)) s.bindHost(name, fn);
      // Namespaced host modules: bind flat dotted names (shims are in the composed bootstrap).
      if (opts.hostModules) {
        for (const [ns, mod] of Object.entries(opts.hostModules)) {
          for (const [fnName, fn] of Object.entries(mod)) s.bindHost(`${ns}.${fnName}`, fn as HostFn);
        }
      }
    };
    // Seed the initial ctx map. Idempotent + reconnect-safe: only fills keys that are
    // ABSENT, so a value later changed via session.ctx.set survives a cold restore (the
    // persisted global is restored first, then this seed is a no-op for existing keys).
    const ctxSeed =
      opts.ctx && Object.keys(opts.ctx).length
        ? `{ const __c = (globalThis.${CTX_GLOBAL} ||= {}), __s = ${JSON.stringify(opts.ctx)}; for (const __k in __s) if (!(__k in __c)) __c[__k] = __s[__k]; }`
        : undefined;
    const fullBootstrap = ctxSeed ? (bootstrap ? `${bootstrap}\n${ctxSeed}` : ctxSeed) : bootstrap;

    // Custom transport path: the substrate owns the channel (service binding, DO-to-DO RPC,
    // in-process). The SDK just drives the provided transport and applies config once.
    if (custom) {
      const tx = opts.transport!;
      const t = typeof tx === "function" ? await tx(session) : tx;
      const s = new EngramSession(t, { session, throwOnError, timeoutMs, config, bootstrap: fullBootstrap, onConsole: opts.onConsole, onEval: opts.onEval });
      applyHost(s);
      await s._applyConfig();
      opts.onConnect?.();
      return s;
    }

    if (opts.apiKey && isHttp) {
      const transport = new HttpTransport(base, opts.apiKey, session);
      const s = new EngramSession(transport, { session, throwOnError, timeoutMs, config, bootstrap: fullBootstrap, onConsole: opts.onConsole, onEval: opts.onEval });
      applyHost(s);
      await s._applyConfig();
      opts.onConnect?.();
      return s;
    }

    // WebSocket path (bare kernel, cloud /connect, or an INJECTED pre-opened socket).
    // For injected sockets there is no WS ctor / url to resolve — the transport drives the
    // provided socket (or factory) directly.
    const WS = injected ? null : resolveWebSocket(opts.WebSocket);
    const wsBase = base.replace(/^http/i, "ws");
    // Cloud /connect uses ?session=&apiKey=; the bare kernel uses /ws?id=.
    const wsUrl = injected
      ? ""
      : opts.apiKey
        ? `${wsBase}/connect?session=${encodeURIComponent(session)}&apiKey=${encodeURIComponent(opts.apiKey)}`
        : opts.kernelKey
          ? `${wsBase}/ws?id=${encodeURIComponent(session)}&apiKey=${encodeURIComponent(opts.kernelKey)}`
          : `${wsBase}/ws?id=${encodeURIComponent(session)}`;

    let s!: EngramSession;
    const transport = new WsTransport(WS, wsUrl, {
      autoReconnect,
      session,
      socket: opts.socket,
      openSocket: opts.openSocket,
      onConnect: opts.onConnect,
      onReconnect: opts.onReconnect,
      onClose: opts.onClose,
      onReady: async (raw) => {
        // AUTH FIRST: send {t:"auth",token} before anything else so a credential-less upgrade (and
        // every reconnect-after-hibernation) re-auths transparently. Idempotent on an already-authed
        // socket. Must precede {t:create}, the bootstrap eval, and the initial {t:ping} probe.
        if (opts.kernelKey) {
          await raw({ t: "auth", token: opts.kernelKey }, timeoutMs).catch(() => {});
        }
        // Re-apply config on every (re)connect so a cold session is configured identically.
        if (config && Object.keys(config).length) {
          await raw({ t: "create", config }, timeoutMs);
        }
        // Seed VM globals once after create, before any user eval (runs on every reconnect).
        if (fullBootstrap) {
          await raw({ t: "eval", src: fullBootstrap }, timeoutMs);
        }
      },
    });
    s = new EngramSession(transport, { session, throwOnError, timeoutMs, config, bootstrap: fullBootstrap, onConsole: opts.onConsole, onEval: opts.onEval });
    applyHost(s);
    // Force the first connect (onReady applies config; onConnect fires inside the transport).
    await transport.request({ t: "ping" }, timeoutMs).catch(() => {});
    return s;
  },
};

export default Engram;

/** Convenience: bare {@link Engram.connect}. */
export const connect = Engram.connect;

// ---------------------------------------------------------------------------
// Config presets + builder (substrate config sugar)
// ---------------------------------------------------------------------------

/**
 * Identity helper that validates an {@link EngramConfig} at the call site (so a typo in a
 * numeric field fails fast in your substrate instead of silently passing through the kernel's
 * open `[k: string]: unknown` map). Returns the same object. Throws {@link EngramError} on a
 * structurally invalid field.
 */
export function defineConfig(config: EngramConfig): EngramConfig {
  if (config.rngSeed !== undefined && (!Number.isInteger(config.rngSeed) || config.rngSeed < 0)) {
    throw new EngramError(`defineConfig: rngSeed must be a non-negative integer (got ${config.rngSeed})`);
  }
  if (config.cellBudgetTicks !== undefined && (!Number.isInteger(config.cellBudgetTicks) || config.cellBudgetTicks <= 0)) {
    throw new EngramError(`defineConfig: cellBudgetTicks must be a positive integer (got ${config.cellBudgetTicks})`);
  }
  if (config.clock !== undefined && config.clock !== "seeded" && config.clock !== "real") {
    throw new EngramError(`defineConfig: clock must be "seeded" | "real" (got ${String(config.clock)})`);
  }
  if (config.fetch !== undefined && typeof config.fetch !== "boolean" && !Array.isArray(config.fetch)) {
    throw new EngramError(`defineConfig: fetch must be boolean | string[] (got ${typeof config.fetch})`);
  }
  if (config.modules !== undefined && typeof config.modules !== "boolean" && !Array.isArray(config.modules)) {
    throw new EngramError(`defineConfig: modules must be boolean | string[] (got ${typeof config.modules})`);
  }
  return config;
}

/**
 * Ready-made {@link EngramConfig} presets for common substrate postures. Each returns a fresh
 * object you can spread + override: `{ ...presets.deterministic(), cellBudgetTicks: 1500 }`.
 */
export const presets = {
  /** Byte-identical replay: seeded clock + RNG (+ seeded crypto in-VM). The default for RLM/trajectory work. */
  deterministic: (rngSeed = 1): EngramConfig => ({ clock: "seeded", rngSeed, capture: true }),
  /** Real wall-clock Date/Math (non-reproducible snapshots). Use for human-facing REPLs. */
  realtime: (): EngramConfig => ({ clock: "real", capture: true }),
  /** Full Node-shaped sandbox: in-VM stdlib bundle + open egress, seeded for reproducibility. */
  nodeFull: (rngSeed = 1): EngramConfig => ({ clock: "seeded", rngSeed, modules: true, fetch: true, capture: true }),
  /** Locked down: no egress (or an explicit hostname allowlist), seeded, console captured. */
  sandboxed: (allow: string[] | false = false): EngramConfig => ({ clock: "seeded", rngSeed: 1, fetch: allow, capture: true }),
} as const;

// ---------------------------------------------------------------------------
// EngramClient — instance management (a pool/registry of durable sessions)
// ---------------------------------------------------------------------------

/** Defaults applied to every session an {@link EngramClient} mints. Per-session overrides win. */
export interface EngramClientOptions {
  /** Kernel/cloud endpoint shared by all sessions (omit when every session injects its own transport). */
  url?: string;
  /** Cloud API key (flips all sessions to the HTTP path). */
  apiKey?: string;
  /** Bare-kernel shared bearer key for every session (engram-kernel auth; additive). */
  kernelKey?: string;
  /** WebSocket implementation (Node: `(await import("ws")).default`). */
  WebSocket?: unknown;
  /** Default in-VM config for every session (deep-overridable per session). */
  config?: EngramConfig;
  /** Default bootstrap appended for every session. */
  bootstrap?: string;
  /** Default runtime env (globals/prelude/modules) for every session. */
  env?: RuntimeEnv;
  /** Default flat host fns for every session. */
  host?: Record<string, (...a: unknown[]) => unknown | Promise<unknown>>;
  /** Default namespaced host modules for every session. */
  hostModules?: Record<string, HostModule>;
  /** Default throw-on-error (default true). */
  throwOnError?: boolean;
  /** Default auto-reconnect (default true). */
  autoReconnect?: boolean;
  /** Default per-request timeout in ms. */
  timeoutMs?: number;
  /** Default console sink for every session. */
  onConsole?: (line: ConsoleLine) => void;
  /** Default eval interceptor(s) for every session. */
  onEval?: EvalInterceptor | EvalInterceptor[];
  /**
   * Default custom-transport factory: called per session id to mint a {@link Transport}
   * (service binding / DO-to-DO RPC / in-process). When set, `url`/`apiKey` are ignored.
   */
  transport?: (session: string) => Transport | Promise<Transport>;
}

/**
 * A manager for many durable Engram sessions behind one set of connection defaults — the
 * substrate-facing handle when your service owns a fleet of sessions (one per user / project /
 * conversation). It reuses a live {@link EngramSession} per id (so two requests for the same id
 * share one socket), dedupes concurrent connects, and gives you fleet-wide lifecycle ops.
 *
 * ```ts
 * const client = new EngramClient({ url, WebSocket, config: presets.deterministic() });
 * const a = await client.session(`proj:${id}`);        // connect-or-reuse by id
 * const b = await client.session(`proj:${id}`);        // same instance as `a`
 * await client.eval(`proj:${id}`, "globalThis.x = 1"); // shorthand
 * await client.closeAll();                              // tear down the whole fleet
 * ```
 */
export class EngramClient {
  private sessions = new Map<string, EngramSession>();
  /** In-flight connects, so two concurrent session(id) calls share one connect. */
  private pending = new Map<string, Promise<EngramSession>>();

  constructor(private opts: EngramClientOptions = {}) {}

  /** Number of live (cached) sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** The ids of all live (cached) sessions. */
  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** The cached session for `id`, or `undefined` if none is open (does NOT connect). */
  get(id: string): EngramSession | undefined {
    return this.sessions.get(id);
  }

  /** `true` if a session for `id` is currently open. */
  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** All live sessions as `{ id, session }` pairs. */
  list(): { id: string; session: EngramSession }[] {
    return [...this.sessions.entries()].map(([id, session]) => ({ id, session }));
  }

  /**
   * Connect-or-reuse a durable session by id. A cached live session is returned as-is;
   * otherwise one is connected with the client defaults merged with any per-call `overrides`
   * (overrides win; `config`/`host`/`hostModules`/`env` are shallow-merged). Concurrent calls
   * for the same id share a single connect.
   */
  async session(id: string, overrides: Partial<ConnectOptions> = {}): Promise<EngramSession> {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight;

    const o = this.opts;
    const connectOpts: ConnectOptions = {
      url: o.url,
      apiKey: o.apiKey,
      kernelKey: o.kernelKey,
      WebSocket: o.WebSocket,
      throwOnError: o.throwOnError,
      autoReconnect: o.autoReconnect,
      timeoutMs: o.timeoutMs,
      onConsole: o.onConsole,
      onEval: o.onEval,
      bootstrap: o.bootstrap,
      ...overrides,
      session: id,
      config: { ...(o.config || {}), ...(overrides.config || {}) },
      env: o.env || overrides.env ? { ...(o.env || {}), ...(overrides.env || {}) } : undefined,
      host: o.host || overrides.host ? { ...(o.host || {}), ...(overrides.host || {}) } : undefined,
      hostModules:
        o.hostModules || overrides.hostModules ? { ...(o.hostModules || {}), ...(overrides.hostModules || {}) } : undefined,
      transport: overrides.transport ?? (o.transport ? (s) => o.transport!(s) : undefined),
    };

    const p = Engram.connect(connectOpts).then(
      (s) => {
        this.sessions.set(id, s);
        this.pending.delete(id);
        return s;
      },
      (e) => {
        this.pending.delete(id);
        throw e;
      },
    );
    this.pending.set(id, p);
    return p;
  }

  /** Shorthand: connect-or-reuse `id`, then eval one cell against it. */
  async eval<T = unknown, F = unknown>(id: string, code: string, opts?: { throwOnError?: boolean; timeoutMs?: number }): Promise<EvalResult<T, F>> {
    const s = await this.session(id);
    return s.eval<T, F>(code, opts);
  }

  /** Liveness/generation probe for every live session, keyed by id. */
  async statusAll(): Promise<Record<string, { generation?: number; inMemory?: boolean; [k: string]: unknown }>> {
    const out: Record<string, { generation?: number; inMemory?: boolean }> = {};
    await Promise.all(this.list().map(async ({ id, session }) => { out[id] = await session.status().catch(() => ({})); }));
    return out;
  }

  /** Force-evict every live session's in-memory kernel (snapshots kept). Sessions stay registered. */
  async evictAll(): Promise<void> {
    await Promise.all(this.list().map(({ session }) => session.evict().catch(() => {})));
  }

  /** Close + forget one session. The durable heap persists server-side and can be reattached later. */
  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.close();
  }

  /** Close + forget every session. Durable heaps persist server-side. */
  async closeAll(): Promise<void> {
    for (const { session } of this.list()) session.close();
    this.sessions.clear();
    this.pending.clear();
  }
}
