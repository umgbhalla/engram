import { afterEach, describe, expect, test } from "bun:test";
import { Engram } from "../src/index";

type Handler = (...args: any[]) => void;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static failOpenCount = 0;

  readyState = 0;
  sent: any[] = [];
  private handlers = new Map<string, Handler[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    const ctor = this.constructor as typeof FakeWebSocket;
    if (ctor.failOpenCount > 0) {
      ctor.failOpenCount--;
      setTimeout(() => {
        this.readyState = 3;
        this.emit("error", new Error("synthetic open failure"));
        this.emit("close");
      }, 0);
      return;
    }
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open");
    }, 0);
  }

  once(event: string, handler: Handler): void {
    const wrapped: Handler = (...args) => {
      this.off(event, wrapped);
      handler(...args);
    };
    this.on(event, wrapped);
  }

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: Handler): void {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((h) => h !== handler),
    );
  }

  removeListener(event: string, handler: Handler): void {
    this.off(event, handler);
  }

  send(data: string): void {
    if (data === "ping") {
      this.sent.push("ping");
      setTimeout(() => this.emit("message", "pong"), 0);
      return;
    }
    const frame = JSON.parse(data);
    this.sent.push(frame);
    setTimeout(() => this.emit("message", JSON.stringify(this.reply(frame))), 0);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  protected emit(event: string, ...args: any[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  protected reply(frame: any): any {
    if (frame.t === "auth") return { ok: true, t: "auth" };
    if (frame.t === "create") return { ok: true, t: "create" };
    if (frame.t === "ping") return { ok: true, t: "ping", generation: 1, inMemory: true, keepAlive: frame.keepAlive === true };
    if (frame.t === "eval") {
      return {
        ok: true,
        value: 42,
        valueType: "number",
        logs: [],
        outputs: [],
        cell: this.sent.filter((f) => f.t === "eval").length,
      };
    }
    return { ok: true, t: frame.t };
  }
}

class FlakyEvalWebSocket extends FakeWebSocket {
  static committedReqIds = new Set<string>();
  static droppedOnce = false;

  override send(data: string): void {
    if (data === "ping") return super.send(data);
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (frame.t === "eval" && typeof frame.reqId === "string") {
      FlakyEvalWebSocket.committedReqIds.add(frame.reqId);
      const reply = {
        ok: true,
        value: FlakyEvalWebSocket.committedReqIds.size,
        valueType: "number",
        logs: [],
        outputs: [],
        cell: FlakyEvalWebSocket.committedReqIds.size,
      };
      if (!FlakyEvalWebSocket.droppedOnce) {
        FlakyEvalWebSocket.droppedOnce = true;
        setTimeout(() => this.close(), 0);
      } else {
        setTimeout(() => this.emit("message", JSON.stringify(reply)), 0);
      }
      return;
    }
    setTimeout(() => this.emit("message", JSON.stringify(this.reply(frame))), 0);
  }
}

class FlakyOpenWebSocket extends FakeWebSocket {
  static override failOpenCount = 0;
}

class SlowEvalWebSocket extends FakeWebSocket {
  override send(data: string): void {
    if (data === "ping") return super.send(data);
    const frame = JSON.parse(data);
    this.sent.push(frame);
    const delay = frame.t === "eval" ? 260 : 0;
    setTimeout(() => this.emit("message", JSON.stringify(this.reply(frame))), delay);
  }
}

afterEach(() => {
  for (const ws of FakeWebSocket.instances) ws.close();
  FakeWebSocket.instances = [];
  FakeWebSocket.failOpenCount = 0;
  FlakyOpenWebSocket.failOpenCount = 0;
  FlakyEvalWebSocket.committedReqIds = new Set();
  FlakyEvalWebSocket.droppedOnce = false;
});

describe("bare-kernel keepalive", () => {
  test("keeps one socket open inside the configured warm window", async () => {
    let closes = 0;
    let reconnects = 0;
    const session = await Engram.connect({
      url: "wss://kernel.example",
      session: "keepalive-single-turn",
      kernelKey: "test-key",
      WebSocket: FakeWebSocket,
      keepAliveAfterActivityMs: 400,
      onClose: () => { closes++; },
      onReconnect: () => { reconnects++; },
    });

    await session.eval("21 * 2");
    await sleep(260);
    await session.eval("21 * 2");

    expect(FakeWebSocket.instances.length).toBe(1);
    expect(closes).toBe(0);
    expect(reconnects).toBe(0);

    session.close();
  });

  test("multi-turn activity inside the warm window has no visible reconnect", async () => {
    let closes = 0;
    let reconnects = 0;
    const session = await Engram.connect({
      url: "wss://kernel.example",
      session: "keepalive-multi-turn",
      kernelKey: "test-key",
      WebSocket: FakeWebSocket,
      keepAliveAfterActivityMs: 220,
      onClose: () => { closes++; },
      onReconnect: () => { reconnects++; },
    });

    await session.eval("1");
    await sleep(60);
    await session.eval("2");
    await sleep(60);
    await session.eval("3");
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(closes).toBe(0);
    expect(reconnects).toBe(0);

    session.close();
  });

  test("heartbeat replies do not resolve an in-flight eval", async () => {
    const session = await Engram.connect({
      url: "wss://kernel.example",
      session: "keepalive-heartbeat-pending",
      kernelKey: "test-key",
      WebSocket: SlowEvalWebSocket,
      keepAliveAfterActivityMs: 500,
    });

    await session.eval("prime()");
    const result = await session.eval("slow()");
    expect(result.value).toBe(42);

    const sent = FakeWebSocket.instances.flatMap((ws) => ws.sent);
    expect(sent.some((frame) => frame && frame.t === "ping" && frame.keepAlive === true)).toBe(true);
    expect(sent.filter((frame) => frame && frame.t === "eval").length).toBeGreaterThanOrEqual(2);

    session.close();
  });

  test("retries eval only through the reqId replay guard after a post-commit socket drop", async () => {
    const session = await Engram.connect({
      url: "wss://kernel.example",
      session: "keepalive-eval-no-retry",
      kernelKey: "test-key",
      WebSocket: FlakyEvalWebSocket,
      keepAliveAfterActivityMs: 0,
    });

    const result = await session.eval("sideEffect()");
    expect(result.value).toBe(1);
    expect(FlakyEvalWebSocket.committedReqIds.size).toBe(1);

    const evalFrames = FakeWebSocket.instances
      .flatMap((ws) => ws.sent)
      .filter((frame) => frame && frame.t === "eval" && typeof frame.reqId === "string");
    expect(evalFrames).toHaveLength(2);
    expect(evalFrames[0].reqId).toBe(evalFrames[1].reqId);

    session.close();
  });

  test("retries a reqId eval after a transient socket-open failure", async () => {
    const session = await Engram.connect({
      url: "wss://kernel.example",
      session: "keepalive-open-failure",
      kernelKey: "test-key",
      WebSocket: FlakyOpenWebSocket,
      keepAliveAfterActivityMs: 400,
    });

    FlakyOpenWebSocket.failOpenCount = 1;
    FakeWebSocket.instances[0]?.close();
    const result = await session.eval("21 * 2");
    expect(result.value).toBe(42);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(3);

    session.close();
  });
});
