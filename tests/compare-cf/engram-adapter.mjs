// engram-adapter.mjs — raw-WS adapter to the live engram-kernel Worker.
//
// Protocol (from apps/kernel/src/lib.rs handle_with_ws):
//   client -> server frames: {t:"create",config}, {t:"eval",src,[config]}, {t:"evict"},
//                            {t:"reset"}, {t:"gen"}, {t:"ping"}, {t:"health"},
//                            {t:"hostcall-result",...} (reply to a host callback)
//   server -> client replies carry {t, ok, ...}. The eval reply exposes:
//       value, valuePreview, valueType, logs, error, cell, generation,
//       inMemoryBefore, restoreSource, restoreTimings, checkpoint{store,mode,sizeGz,sizeRaw,usedHeap,...}
//   Out-of-band the server may push {t:"hostcall", id, name, args} when a cell calls a
//   non-fetch host.<name>(...). We demux those and answer with {t:"hostcall-result"}.
//
// host.fetch is serviced DO-side (never surfaces as a hostcall frame), so the only
// hostcall frames we see come from user-registered host tools. A default echo handler
// is provided; override via opts.hostHandlers[name] = async (args) => value.

import WebSocket from "ws";

const DEFAULT_BASE = process.env.ENGRAM_BASE || "engram-kernel.umg-bhalla88.workers.dev";

export function makeEngramAdapter(opts = {}) {
  const base = opts.base || DEFAULT_BASE;
  const scheme = opts.scheme || "wss";
  const defaultTimeout = opts.timeoutMs || 60000;

  return {
    kind: "engram",
    base,

    // Open a WS to ?id=<sid>. Returns a session handle bound to that socket.
    async connect(sid) {
      const ws = await openSocket(`${scheme}://${base}/?id=${encodeURIComponent(sid)}`);
      return makeSession(ws, sid, { defaultTimeout, hostHandlers: opts.hostHandlers || {} });
    },

    // Reconnect = open a fresh socket to the SAME id (DO is keyed by id; survives socket close).
    async reconnect(sid) {
      return this.connect(sid);
    },
  };
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const onErr = (e) => { cleanup(); reject(e instanceof Error ? e : new Error(String(e?.message || e))); };
    const onOpen = () => { cleanup(); resolve(ws); };
    function cleanup() { ws.off("open", onOpen); ws.off("error", onErr); }
    ws.on("open", onOpen);
    ws.on("error", onErr);
  });
}

function makeSession(ws, sid, cfg) {
  const hostHandlers = cfg.hostHandlers || {};

  // Single in-flight RPC at a time (the DO serializes evals via a mutex anyway, and the
  // client drives one request per turn). We demux hostcall frames inline so a cell that
  // calls host.<tool>() does not deadlock the pending eval reply.
  function rpc(msg, timeoutMs = cfg.defaultTimeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { detach(); reject(new Error(`timeout waiting for ${msg.t}`)); }, timeoutMs);

      const onMsg = async (data) => {
        let p;
        try { p = JSON.parse(data.toString()); } catch { return; }
        if (!p || typeof p !== "object") return;

        // Out-of-band host callback: answer it, keep waiting for the real reply.
        if (p.t === "hostcall") {
          await answerHostcall(ws, p, hostHandlers);
          return;
        }
        // hostcall-result frames are ours; ignore any echo.
        if (p.t === "hostcall-result") return;

        detach();
        resolve(p);
      };
      const onClose = (code, reasonBuf) => {
        detach();
        const reason = reasonBuf ? reasonBuf.toString() : "";
        reject(new Error(`ws closed during ${msg.t} (code=${code}${reason ? " " + reason : ""})`));
      };
      const onErr = (e) => { detach(); reject(e instanceof Error ? e : new Error(String(e?.message || e))); };

      function detach() {
        clearTimeout(timer);
        ws.off("message", onMsg);
        ws.off("close", onClose);
        ws.off("error", onErr);
      }

      ws.on("message", onMsg);
      ws.on("close", onClose);
      ws.on("error", onErr);
      ws.send(JSON.stringify(msg));
    });
  }

  return {
    sid,
    ws,

    async create(config = {}, timeoutMs) {
      return rpc({ t: "create", config }, timeoutMs);
    },

    // eval returns the full reply; callers read .value / .inMemoryBefore /
    // .restoreSource / .checkpoint.{sizeGz,mode,store,usedHeap}.
    async eval(src, extra = {}, timeoutMs) {
      return rpc({ t: "eval", src, ...extra }, timeoutMs);
    },

    async gen(timeoutMs) { return rpc({ t: "gen" }, timeoutMs); },
    async ping(timeoutMs) { return rpc({ t: "ping" }, timeoutMs); },
    async reset(timeoutMs) { return rpc({ t: "reset" }, timeoutMs); },

    // Drop the in-memory glue/kernel on the DO (simulated/forced eviction of live heap;
    // SQLite snapshot remains, so the next eval cold-restores). The genuine-idle-eviction
    // path is exercised by close()+wait+reconnect; evict() forces it deterministically.
    async evict(timeoutMs) { return rpc({ t: "evict" }, timeoutMs); },

    close() {
      return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        try { ws.close(); } catch { resolve(); }
      });
    },
  };
}

async function answerHostcall(ws, frame, hostHandlers) {
  const { id, name, args } = frame;
  let value, error = null;
  try {
    const h = hostHandlers[name];
    value = h ? await h(args) : { echoed: args ?? null, tool: name };
  } catch (e) {
    error = { name: e?.name || "Error", message: e?.message || String(e) };
  }
  const reply = error
    ? { t: "hostcall-result", id, error }
    : { t: "hostcall-result", id, value };
  try { ws.send(JSON.stringify(reply)); } catch { /* socket may have closed */ }
}
