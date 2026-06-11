// Engram browser kernel client — speaks the kernel WS protocol directly.
//   /ws?id=<session>  ;  {t:"create",config} {t:"eval",src} {t:"gen"} {t:"evict"} {t:"reset"}
// For engram-cloud the WS path is /connect?session=<id>&apiKey=<key>; auto-detected.
// Replies are JSON; this client keeps a serialized queue so evals never interleave.

export type ClockMode = "seeded" | "real";

export interface EngramConfig {
  clock: ClockMode;
  rngSeed: number;
  modules: boolean | string[];
  fetch: boolean | string[];
  cellBudgetTicks?: number;
  [k: string]: unknown;
}

export type ConsoleLine = string | { level?: string; text?: string; msg?: string };

export interface Checkpoint {
  ok?: boolean;
  sizeGz?: number;
  sizeRaw?: number;
  scrubbed?: boolean;
  store?: string;
  [k: string]: unknown;
}

export interface EvalErrorInfo {
  name?: string;
  message?: string;
  stack?: string;
}

export interface FinalInfo {
  kind?: string;
  value?: unknown;
}

export interface ArtifactValue {
  kind: "artifact";
  handle: string;
  mime?: string;
  chars?: number;
  encoding?: string;
  chunkMaxChars?: number;
}

export type MimeBundle = Record<string, unknown | ArtifactValue>;

export interface MimeOutput {
  output_type: string;
  data?: MimeBundle;
  metadata?: Record<string, unknown>;
  transient?: Record<string, unknown>;
  execution_count?: number | null;
  wait?: boolean;
  name?: string;
  text?: string;
}

/** A frame sent to the kernel. `t` is the discriminator. */
export interface KernelFrame {
  t: "create" | "eval" | "gen" | "evict" | "reset" | "ping" | string;
  config?: EngramConfig;
  src?: string;
  [k: string]: unknown;
}

/** A reply frame from the kernel. All fields optional — depends on `t`. */
export interface KernelReply {
  ok?: boolean;
  value?: unknown;
  valuePreview?: unknown;
  valueType?: string;
  mimeBundle?: MimeBundle;
  outputs?: MimeOutput[];
  logs?: ConsoleLine[];
  error?: EvalErrorInfo;
  cell?: number;
  generation?: number;
  committedCell?: number;
  inMemory?: boolean;
  inMemoryBefore?: boolean;
  checkpoint?: Checkpoint;
  restoreSource?: string;
  final?: FinalInfo;
  [k: string]: unknown;
}

export type KernelState = "connecting" | "disconnected";

/**
 * Auto-detect the WS URL.
 *  - engram-cloud (multi-tenant): /connect?session=&apiKey=  (selected by a `-v1x` / `connect` endpoint).
 *  - bare engram-kernel: /ws?id=&apiKey=  — the shared bearer key (auth enforced) is passed as a
 *    query param AND re-sent as a {t:auth,token} first frame (see Kernel.open). Same key field.
 */
export function kernelUrl(endpoint: string, sessionId: string, apiKey: string): string {
  const ep = endpoint.replace(/\/+$/, "");
  const id = sessionId;
  const key = apiKey.trim();
  // Cloud endpoint: /connect (apiKey is the per-tenant cloud key).
  if (/-v1\d?\b/.test(ep) || /connect/.test(ep)) {
    const u = `${ep}/connect?session=${encodeURIComponent(id)}`;
    return key ? `${u}&apiKey=${encodeURIComponent(key)}` : u;
  }
  // Bare kernel: /ws (apiKey is the shared bearer key; also re-sent as {t:auth}).
  const base = `${ep}/ws?id=${encodeURIComponent(id)}`;
  return key ? `${base}&apiKey=${encodeURIComponent(key)}` : base;
}

export interface KernelEndpoint {
  endpoint: string;
  sessionId: string;
  apiKey: string;
}

/** A host function the VM can invoke as `host.<name>(...args)` mid-eval (the bridge). */
export type HostFn = (...args: unknown[]) => unknown | Promise<unknown>;

export class Kernel {
  private ws: WebSocket | null = null;
  private queue: Promise<void> = Promise.resolve();
  private config: EngramConfig | undefined;
  /** Host functions callable from the VM as `host.<name>` (bridge). */
  private hostFns = new Map<string, HostFn>();
  /** The single in-flight rpc on the current socket. */
  private pending: { resolve: (v: KernelReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Resolves the live connection coordinates. */
  resolve: () => KernelEndpoint;
  onState: (s: KernelState) => void = () => {};
  /** Fired when the socket closes with an auth-rejection code (1008 policy / 4001 / 401). */
  onAuthError: (code: number, reason: string) => void = () => {};
  /** Last close code seen — lets callers distinguish an auth reject from a normal drop. */
  lastCloseCode = 0;

  constructor(resolve: () => KernelEndpoint) {
    this.resolve = resolve;
  }

  setConfig(c: EngramConfig): void {
    this.config = c;
  }

  /**
   * Register a host function callable from a cell as `host.<name>(...args)`. The kernel
   * parks the VM eval, sends an out-of-band `{t:'hostcall'}` frame; we await `fn(...args)`
   * and reply with `{t:'hostcall-result'}` so the parked call resumes. `fetch` is NOT a
   * client host fn — it is serviced kernel-side.
   */
  setHost(name: string, fn: HostFn): void {
    this.hostFns.set(name, fn);
  }

  private url(): string {
    const { endpoint, sessionId, apiKey } = this.resolve();
    return kernelUrl(endpoint, sessionId, apiKey);
  }

  /**
   * Persistent message demux (mirrors @engram/sdk WsTransport). An out-of-band
   * `{t:'hostcall'}` frame is dispatched to a registered host fn and answered WITHOUT
   * touching the in-flight rpc resolver; every other frame is the reply to the single
   * in-flight rpc. The old per-call `{once:true}` listener resolved on the FIRST frame,
   * so a mid-eval hostcall would mis-resolve the eval — this fixes that.
   */
  private onMessage = (ev: MessageEvent): void => {
    let msg: KernelReply & { t?: string; id?: string; name?: string; args?: unknown[] };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      const p = this.pending;
      if (p) { this.pending = null; clearTimeout(p.timer); p.reject(new Error("malformed kernel reply")); }
      return;
    }
    if (msg && msg.t === "hostcall") {
      const fn = this.hostFns.get(String(msg.name));
      const id = msg.id;
      Promise.resolve()
        .then(() => (fn ? fn(...((msg.args as unknown[]) || [])) : Promise.reject(new Error("no host fn " + msg.name))))
        .then(
          (value) => this.sendRaw({ t: "hostcall-result", id, ok: true, value }),
          (err) => this.sendRaw({ t: "hostcall-result", id, ok: false, error: String((err && err.message) || err) }),
        );
      return;
    }
    const p = this.pending;
    if (p) { this.pending = null; clearTimeout(p.timer); p.resolve(msg as KernelReply); }
  };

  private onClose = (ev?: CloseEvent): void => {
    const code = ev?.code ?? 0;
    const reason = ev?.reason ?? "";
    this.lastCloseCode = code;
    this.onState("disconnected");
    // 1008 = policy violation (the kernel rejects a missing/bad bearer key); 4001/4401 custom; 401 mirror.
    if (code === 1008 || code === 4001 || code === 4401 || code === 401) this.onAuthError(code, reason);
    const p = this.pending;
    if (p) { this.pending = null; clearTimeout(p.timer); p.reject(new Error(reason || (code === 1008 ? "auth rejected" : "ws closed before reply"))); }
  };

  private sendRaw(obj: unknown): void {
    try { this.ws?.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  }

  async open(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.onState("connecting");
    await new Promise<void>((res, rej) => {
      const ws = new WebSocket(this.url());
      this.ws = ws;
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
      // ONE persistent message/close handler for the lifetime of this socket.
      ws.addEventListener("message", this.onMessage);
      ws.addEventListener("close", this.onClose as (ev: Event) => void);
    });
    // AUTH FIRST: the bare engram-kernel enforces bearer auth — send {t:auth,token} before
    // {t:create}/eval so a credential-less upgrade re-auths (mirrors @engram/sdk). Idempotent.
    const { apiKey } = this.resolve();
    const key = (apiKey || "").trim();
    if (key) await this.raw({ t: "auth", token: key }).catch(() => {});
    if (this.config) await this.raw({ t: "create", config: this.config });
  }

  private raw(msg: KernelFrame, timeoutMs = 120000): Promise<KernelReply> {
    return new Promise<KernelReply>((resolve, reject) => {
      const ws = this.ws;
      if (!ws) { reject(new Error("ws not open")); return; }
      const timer = setTimeout(() => {
        if (this.pending && this.pending.timer === timer) this.pending = null;
        reject(new Error("rpc timeout"));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        if (this.pending && this.pending.timer === timer) this.pending = null;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Serialized send: opens the socket if needed, then queues behind prior calls. */
  send(msg: KernelFrame, timeoutMs?: number): Promise<KernelReply> {
    const run = async (): Promise<KernelReply> => {
      await this.open();
      return this.raw(msg, timeoutMs);
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  eval(src: string, timeoutMs?: number): Promise<KernelReply> {
    return this.send({ t: "eval", src }, timeoutMs);
  }
  async readArtifact(artifact: ArtifactValue | string, timeoutMs?: number): Promise<string> {
    const handle = typeof artifact === "string" ? artifact : artifact.handle;
    const len = typeof artifact === "string" ? 128 * 1024 : artifact.chunkMaxChars || 128 * 1024;
    let offset = 0;
    let out = "";
    for (;;) {
      const r = await this.send({ t: "artifact", handle, offset, len }, timeoutMs);
      if (r.ok === false) throw new Error(r.error?.message || "artifact read failed");
      const data = typeof (r as { data?: unknown }).data === "string" ? (r as { data: string }).data : "";
      out += data;
      offset += data.length;
      if ((r as { done?: boolean }).done || data.length === 0) break;
    }
    return out;
  }
  gen(): Promise<KernelReply> {
    return this.send({ t: "gen" });
  }
  evict(): Promise<KernelReply> {
    return this.send({ t: "evict" });
  }
  reset(): Promise<KernelReply> {
    return this.send({ t: "reset" });
  }
  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }
}
