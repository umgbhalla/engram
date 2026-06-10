// cf-sandbox-adapter.mjs — adapter against the engram-compare-cfsandbox worker
// (./cf-sandbox), which fronts @cloudflare/sandbox (Container + DO).
//
// Exposes the SAME session interface as engram-adapter.mjs so probes.mjs is
// adapter-agnostic:
//     adapter.connect(sid)  -> session
//     adapter.reconnect(sid)-> session
//     session.create(config)
//     session.eval(src)     -> { ok, value, logs, error, inMemoryBefore, restoreSource, checkpoint }
//     session.evict()       -> tears down the container (genuine cold next eval)
//     session.gen()
//     session.close()
//
// It talks HTTP to the worker endpoints documented in cf-sandbox/README.md. Where the
// live CF API is not yet wired (snapshot/fork), the calls are marked TODO and degrade to
// a documented "unsupported" outcome rather than faking a result.
//
// If CF_SANDBOX_BASE is unset, the adapter is constructed but every call rejects with a
// clear "not configured" error — so `run.mjs --target cf` fails loud, not silently green.

const DEFAULT_BASE = process.env.CF_SANDBOX_BASE || "";

export function makeCfSandboxAdapter(opts = {}) {
  const base = (opts.base || DEFAULT_BASE).replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs || 120000;

  if (!base) {
    // Construct anyway so run.mjs can introspect, but make every op fail loudly.
    return notConfiguredAdapter();
  }

  async function post(path, body, t = timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), t);
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const j = await res.json().catch(() => ({ ok: false, error: `non-JSON ${res.status}` }));
      return j;
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(path, t = timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), t);
    try {
      const res = await fetch(`${base}${path}`, { signal: ctl.signal });
      return res.json().catch(() => ({ ok: false, error: `non-JSON ${res.status}` }));
    } finally {
      clearTimeout(timer);
    }
  }

  function session(sid) {
    // CF has no live-heap restore; restoreSource is reported as "cold-container" so probes
    // can distinguish it from engram's "sqlite-restore" / "r2-restore".
    return {
      sid,
      async create(config = {}, t) { return post("/create", { sid, config }, t); },
      async eval(src, _extra = {}, t) {
        const r = await post("/eval", { sid, src }, t);
        return { restoreSource: r.inMemoryBefore ? "warm" : "cold-container", ...r };
      },
      async evict(t) { return post("/evict", { sid }, t); },
      async snapshot(t) { return post("/snapshot", { sid }, t); }, // TODO: live snapshot/fork
      async gen(t) { return get(`/gen?sid=${encodeURIComponent(sid)}`, t); },
      async ping(t) { return get(`/gen?sid=${encodeURIComponent(sid)}`, t); },
      async reset() { return post("/evict", { sid }); },
      async close() { /* HTTP is stateless; nothing to close */ },
    };
  }

  return {
    kind: "cf",
    base,
    async connect(sid) { return session(sid); },
    async reconnect(sid) {
      await post("/reconnect", { sid }).catch(() => ({}));
      return session(sid);
    },
  };
}

function notConfiguredAdapter() {
  const fail = async () => { throw new Error("CF_SANDBOX_BASE not set — deploy cf-sandbox/ and export its URL (see cf-sandbox/README.md)"); };
  const session = (sid) => ({
    sid,
    create: fail, eval: fail, evict: fail, snapshot: fail,
    gen: fail, ping: fail, reset: fail, close: async () => {},
  });
  return {
    kind: "cf",
    base: "",
    configured: false,
    async connect(sid) { return session(sid); },
    async reconnect(sid) { return session(sid); },
  };
}
