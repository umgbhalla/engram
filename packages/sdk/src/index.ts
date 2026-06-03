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

/** The typed result of {@link EngramSession.eval}. */
export interface EvalResult<T = unknown> {
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

/** Options for {@link Engram.connect}. */
export interface ConnectOptions {
  /**
   * The kernel or cloud endpoint. Accepts `ws://`/`wss://` (kernel WS), or
   * `http(s)://` (auto-upgraded to WS for the kernel, or HTTP for the cloud when
   * an `apiKey` is given). Trailing slashes are fine.
   */
  url: string;
  /** Durable session id. The same id reattaches to the same hibernated heap. Default `"default"`. */
  session?: string;
  /** Cloud API key (`x-api-key`). Presence flips the transport to the cloud HTTP/WS path. */
  apiKey?: string;
  /** In-VM kernel config, applied once at connect. */
  config?: EngramConfig;
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

/** A frame sent to the kernel. `t` is the verb; `src` carries eval source. */
interface Frame {
  t: string;
  src?: string;
  config?: EngramConfig;
  [k: string]: unknown;
}

interface Transport {
  /** Send one frame, await its single reply. */
  request(frame: Frame, timeoutMs: number): Promise<any>;
  /** Tear down. */
  close(): void;
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
  private ws: any = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private reconnects = 0;

  constructor(
    private WS: any,
    private wsUrl: string,
    private opts: { autoReconnect: boolean; onReady?: (raw: (f: Frame, t: number) => Promise<any>) => Promise<void> },
  ) {}

  private async open(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new this.WS(this.wsUrl);
      this.ws = ws;
      const ok = () => resolve();
      const fail = (e: any) => reject(e instanceof Error ? e : new EngramError("ws connect failed"));
      if (ws.addEventListener) {
        ws.addEventListener("open", ok, { once: true });
        ws.addEventListener("error", fail, { once: true });
      } else {
        ws.once("open", ok);
        ws.once("error", fail);
      }
    });
    this.reconnects = 0;
    // Pass rawRequest so onReady can talk to the just-opened socket WITHOUT re-entering the
    // queue (which is currently held by the request that triggered this open() — that would
    // deadlock).
    if (this.opts.onReady) await this.opts.onReady((f, t) => this.rawRequest(f, t));
  }

  private rawRequest(frame: Frame, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      const cleanup = () => {
        clearTimeout(timer);
        if (ws.removeEventListener) {
          ws.removeEventListener("message", onMsg);
          ws.removeEventListener("close", onClose);
        } else {
          ws.off("message", onMsg);
          ws.off("close", onClose);
        }
      };
      const onMsg = (ev: any) => {
        cleanup();
        const data = ev && ev.data !== undefined ? ev.data : ev;
        try {
          resolve(JSON.parse(typeof data === "string" ? data : data.toString()));
        } catch (e) {
          reject(new EngramError("malformed kernel reply"));
        }
      };
      const onClose = () => {
        cleanup();
        reject(new EngramError("__ws_closed__"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new EngramError("request timed out"));
      }, timeoutMs);
      if (ws.addEventListener) {
        ws.addEventListener("message", onMsg, { once: true });
        ws.addEventListener("close", onClose, { once: true });
      } else {
        ws.once("message", onMsg);
        ws.once("close", onClose);
      }
      ws.send(JSON.stringify(frame));
    });
  }

  request(frame: Frame, timeoutMs: number): Promise<any> {
    const run = async (): Promise<any> => {
      try {
        await this.open();
        return await this.rawRequest(frame, timeoutMs);
      } catch (e: any) {
        const dropped = e instanceof EngramError && e.message === "__ws_closed__";
        if (this.opts.autoReconnect && !this.closed && dropped) {
          this.ws = null;
          const backoff = Math.min(2000, 100 * 2 ** this.reconnects++);
          await sleep(backoff);
          await this.open();
          return await this.rawRequest(frame, timeoutMs);
        }
        if (dropped) throw new EngramError("connection closed before reply");
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
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * HTTP transport (cloud, with API key). Maps the same `{t,...}` frames onto the
 * supervisor's REST routes so the rest of the SDK is transport-agnostic.
 */
class HttpTransport implements Transport {
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

  close(): void {
    /* stateless */
  }
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
  private onConsole?: (line: ConsoleLine) => void;

  /** @internal */
  constructor(
    private transport: Transport,
    opts: { session: string; throwOnError: boolean; timeoutMs: number; config: EngramConfig; onConsole?: (l: ConsoleLine) => void },
  ) {
    this.session = opts.session;
    this.throwOnError = opts.throwOnError;
    this.timeoutMs = opts.timeoutMs;
    this.config = opts.config;
    this.onConsole = opts.onConsole;
  }

  /** @internal applied once when the transport first connects. */
  async _applyConfig(): Promise<void> {
    if (this.config && Object.keys(this.config).length) {
      await this.transport.request({ t: "create", config: this.config }, this.timeoutMs);
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
  async eval<T = unknown>(code: string, opts: { throwOnError?: boolean; timeoutMs?: number } = {}): Promise<EvalResult<T>> {
    const reply = await this.transport.request({ t: "eval", src: code }, opts.timeoutMs ?? this.timeoutMs);
    const result = this.normalize<T>(reply);
    for (const line of result.console) this.onConsole?.(line);
    const shouldThrow = opts.throwOnError ?? this.throwOnError;
    if (!result.ok && shouldThrow) {
      throw toTypedError(result.error || { name: "EngramError", message: "eval failed" }, result as EvalResult);
    }
    return result;
  }

  /** Normalise a raw kernel/cloud reply into a typed {@link EvalResult}. */
  private normalize<T>(reply: any): EvalResult<T> {
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
    if (!opts || !opts.url) throw new EngramError("connect({ url }) is required");
    const session = opts.session || "default";
    const throwOnError = opts.throwOnError !== false;
    const autoReconnect = opts.autoReconnect !== false;
    const timeoutMs = opts.timeoutMs ?? 60000;
    const config = { ...(opts.config || {}) };
    const base = String(opts.url).replace(/\/+$/, "");

    // Cloud HTTP path: an API key + an http(s) endpoint.
    const isHttp = /^https?:\/\//i.test(base);
    if (opts.apiKey && isHttp) {
      const transport = new HttpTransport(base, opts.apiKey, session);
      const s = new EngramSession(transport, { session, throwOnError, timeoutMs, config, onConsole: opts.onConsole });
      await s._applyConfig();
      return s;
    }

    // WebSocket path (bare kernel, or cloud /connect with a key).
    const WS = resolveWebSocket(opts.WebSocket);
    const wsBase = base.replace(/^http/i, "ws");
    // Cloud /connect uses ?session=&apiKey=; the bare kernel uses /ws?id=.
    const wsUrl = opts.apiKey
      ? `${wsBase}/connect?session=${encodeURIComponent(session)}&apiKey=${encodeURIComponent(opts.apiKey)}`
      : `${wsBase}/ws?id=${encodeURIComponent(session)}`;

    let s!: EngramSession;
    const transport = new WsTransport(WS, wsUrl, {
      autoReconnect,
      onReady: async (raw) => {
        // Re-apply config on every (re)connect so a cold session is configured identically.
        if (config && Object.keys(config).length) {
          await raw({ t: "create", config }, timeoutMs);
        }
      },
    });
    s = new EngramSession(transport, { session, throwOnError, timeoutMs, config, onConsole: opts.onConsole });
    // Force the first connect (onReady applies config).
    await transport.request({ t: "ping" }, timeoutMs).catch(() => {});
    return s;
  },
};

export default Engram;

/** Convenience: bare {@link Engram.connect}. */
export const connect = Engram.connect;
