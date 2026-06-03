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

/** Auto-detect: cloud uses /connect?session=&apiKey= ; kernel uses /ws?id= */
export function kernelUrl(endpoint: string, sessionId: string, apiKey: string): string {
  const ep = endpoint.replace(/\/+$/, "");
  const id = sessionId;
  const key = apiKey.trim();
  if (key || /-v1\d?\b/.test(ep) || /connect/.test(ep)) {
    const u = `${ep}/connect?session=${encodeURIComponent(id)}`;
    return key ? `${u}&apiKey=${encodeURIComponent(key)}` : u;
  }
  return `${ep}/ws?id=${encodeURIComponent(id)}`;
}

export interface KernelEndpoint {
  endpoint: string;
  sessionId: string;
  apiKey: string;
}

export class Kernel {
  private ws: WebSocket | null = null;
  private queue: Promise<void> = Promise.resolve();
  private config: EngramConfig | undefined;
  /** Resolves the live connection coordinates. */
  resolve: () => KernelEndpoint;
  onState: (s: KernelState) => void = () => {};

  constructor(resolve: () => KernelEndpoint) {
    this.resolve = resolve;
  }

  setConfig(c: EngramConfig): void {
    this.config = c;
  }

  private url(): string {
    const { endpoint, sessionId, apiKey } = this.resolve();
    return kernelUrl(endpoint, sessionId, apiKey);
  }

  async open(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.onState("connecting");
    await new Promise<void>((res, rej) => {
      const ws = new WebSocket(this.url());
      this.ws = ws;
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
      ws.addEventListener("close", () => this.onState("disconnected"), { once: true });
    });
    if (this.config) await this.raw({ t: "create", config: this.config });
  }

  private raw(msg: KernelFrame, timeoutMs = 120000): Promise<KernelReply> {
    return new Promise<KernelReply>((resolve, reject) => {
      const ws = this.ws;
      if (!ws) {
        reject(new Error("ws not open"));
        return;
      }
      const onMsg = (ev: MessageEvent): void => {
        cleanup();
        try {
          resolve(JSON.parse(String(ev.data)) as KernelReply);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("ws closed before reply"));
      };
      const t = setTimeout(() => {
        cleanup();
        reject(new Error("rpc timeout"));
      }, timeoutMs);
      function cleanup(): void {
        clearTimeout(t);
        ws!.removeEventListener("message", onMsg);
        ws!.removeEventListener("close", onClose);
      }
      ws.addEventListener("message", onMsg, { once: true });
      ws.addEventListener("close", onClose, { once: true });
      ws.send(JSON.stringify(msg));
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
