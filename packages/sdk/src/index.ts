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
  /** Coarse tag: `"number" | "string" | "object" | "array" | "error" | ...`. */
  valueType?: string;
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

const ERROR_CLASSES: Record<string, typeof EngramError> = {
  TimeoutError,
  MemoryLimitError,
  FetchBlockedError,
  SizeAdmissionError,
};

/** Build the right typed error from a kernel error payload. */
function toTypedError(info: EvalErrorInfo, result?: EvalResult): EngramError {
  const Cls = ERROR_CLASSES[info.name] || EngramError;
  const err = new Cls(info.message || info.name || "eval failed", { stack: info.stack, result });
  if (Cls === EngramError && info.name) err.name = info.name;
  return err;
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
      default:
        return this.call("/status", { method: "GET" });
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
      console,
      error: reply?.error || undefined,
      checkpoint: reply?.checkpoint || undefined,
      cell: typeof reply?.cell === "number" ? reply.cell : undefined,
      // Populated by eval() after the rpc returns (the captured final is per-eval).
      finalSet: false,
    };
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
