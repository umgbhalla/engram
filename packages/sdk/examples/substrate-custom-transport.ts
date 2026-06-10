/**
 * Using @engram/sdk as a SUBSTRATE inside your own Cloudflare Worker.
 *
 * Your worker owns the URL scheme and the id->session mapping; Engram is just a library you
 * drive over a CUSTOM transport. Here the transport is a Cloudflare service binding (or
 * DO-to-DO RPC stub) to a worker that speaks the Engram frame protocol — no public WebSocket,
 * no api key, zero network hop. Swap the body of `request` for whatever channel you own.
 *
 * Demonstrates the v2 extensibility seams:
 *   - ConnectOptions.transport      — bind any channel, not just WS/HTTP
 *   - EvalInterceptor (onEval)       — central tracing/timing/transform
 *   - session.supportsHostCalls      — fail loud if host tools won't work
 *   - onConnect / onReconnect        — re-register dynamic host tools after a cold reconnect
 */
import { Engram, type Transport, type Frame, type HostFn } from "@engram/sdk";

/** Minimal example env: a service binding to a worker that accepts POST'd Engram frames. */
interface Env {
  ENGRAM_KERNEL: { fetch(req: Request): Promise<Response> };
}

/**
 * A custom transport over a Cloudflare service binding. The bound worker is expected to accept
 * a POST whose JSON body is an Engram {@link Frame} and reply with the frame's JSON result —
 * exactly the contract the kernel's `/frame` seam already implements. Host callbacks need a
 * push channel (WS / DO-to-DO socket); this request/reply binding reports them unsupported.
 */
function serviceBindingTransport(binding: Env["ENGRAM_KERNEL"], session: string): Transport {
  return {
    supportsHostCalls: false, // request/reply only — no VM->host push path
    async request(frame: Frame): Promise<unknown> {
      const res = await binding.fetch(
        new Request("https://kernel/frame", {
          method: "POST",
          headers: { "content-type": "application/json", "x-engram-session": session },
          body: JSON.stringify(frame),
        }),
      );
      if (!res.ok) throw new Error(`engram ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
    setHost(_name: string, _fn: HostFn): void {
      /* no-op: request/reply binding cannot deliver hostcalls */
    },
    close(): void {
      /* stateless binding */
    },
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // YOUR routing: map a URI like /run/:projectId to a durable Engram session id.
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/run\/([\w-]+)$/);
    if (!m) return new Response("not found", { status: 404 });
    const sessionId = `proj:${m[1]}`; // bring-your-own id; conditional/mapped however you like

    const s = await Engram.connect({
      session: sessionId,
      transport: (session) => serviceBindingTransport(env.ENGRAM_KERNEL, session),
      config: { clock: "seeded", rngSeed: 42, cellBudgetTicks: 1500 },
      // Central observability for every cell across the whole substrate.
      onEval: async (code, _opts, next) => {
        const r = await next(code);
        console.log(JSON.stringify({ session: sessionId, ok: r.ok, cell: r.cell }));
        return r;
      },
    });

    const code = await req.text();
    const r = await s.eval(code, { throwOnError: false });
    s.close();
    return Response.json({ ok: r.ok, value: r.value, error: r.error });
  },
};
