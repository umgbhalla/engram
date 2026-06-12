// host-sockets.mjs — HOST-SIDE outbound TCP/TLS socket provider for the Engram kernel.
//
// This is the DO-side (host) half of the VM<->DO `socket.*` host-call family. It mirrors the
// existing _ws / _streams plumbing in kernel-glue.mjs:
//
//   - Live Socket objects (from `cloudflare:sockets` connect()) are held in an instance Map keyed
//     by an integer handleId. They live ONLY in DO memory — they DIE on eviction/hibernation.
//     The VM heap holds only the integer handleId token. After a cold restore, socket.read/write
//     on a stale handle returns a typed ECONNRESET-shaped error ("handle not found"). We NEVER
//     try to snapshot a live socket (it is not part of the WASM linear-memory image).
//
//   - Binary crosses the 64KB engine boundary as base64 (same convention as ws.send / streamRead;
//     reuses the bytesToB64 / b64ToBytes shape from kernel-glue / lib.rs).
//
//   - Errors are returned as { ok:false, error, code } envelopes consistent with kernel-glue
//     ({ ok:false, error } for hard failures). Backpressure on read mirrors _doStreamRead: one
//     reader.read() per `socket.read` call, {done:true} at EOF/close.
//
//   - cloudflare:sockets cap: at most 6 concurrent connections awaiting a response per invocation.
//     The 7th open() surfaces a typed error immediately — it does NOT hang.
//
//   - Determinism: socket I/O is a host-mediated effect (like fetch / ws). It adds NO entropy to
//     the seeded clock/RNG.
//
//   - Inbound/listen is IMPOSSIBLE on this substrate. net.createServer/listen must throw a typed
//     EPERM immediately (the VM-side shim calls socket.listen → we reject here too as a backstop).

import { connect } from "cloudflare:sockets";

// ---- base64 <-> bytes (same chunked-charCode convention as kernel-glue bytesToB64/b64ToBytes) ----
function bytesToB64(u8) {
  let s = "";
  const CH = 32768;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.prototype.slice.call(u8.subarray(i, i + CH)));
  }
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// cloudflare:sockets allows at most 6 connections per invocation awaiting a response.
var SOCKET_MAX_CONCURRENT = 6;
// One socket.read pulls at most this many raw bytes back across the boundary (chunked like streams).
var SOCKET_READ_CHUNK_BYTES = 1024 * 1024;

// Parse an address that can be either a "host:port" string, a URL string, or an
// { hostname/host, port } address object. cloudflare:sockets connect() accepts either a
// "host:port" string or a SocketAddress { hostname, port }. We normalize to the object form and
// always derive an explicit { hostname, port } so opts can override.
function parseAddr(addrOrUrl, opts) {
  opts = opts || {};
  let hostname = opts.host || opts.hostname || "";
  let port = opts.port;
  if (addrOrUrl && typeof addrOrUrl === "object") {
    hostname = hostname || addrOrUrl.hostname || addrOrUrl.host || "";
    if (port == null) port = addrOrUrl.port;
  } else if (typeof addrOrUrl === "string" && addrOrUrl.length) {
    const s = addrOrUrl;
    // Try URL form first (tcp://host:port, https://host:port, etc).
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
      try {
        const u = new URL(s);
        hostname = hostname || u.hostname;
        if (port == null && u.port) port = parseInt(u.port, 10);
        if (port == null) {
          if (u.protocol === "https:" || u.protocol === "wss:") port = 443;
          else if (u.protocol === "http:" || u.protocol === "ws:") port = 80;
        }
      } catch {
        // fall through to host:port parsing
      }
    }
    if (!hostname || port == null) {
      // host:port — split on the LAST colon (so bracketed IPv6 "[::1]:443" still parses).
      const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(s);
      if (m) {
        if (!hostname) hostname = m[1].replace(/^\[|\]$/g, "");
        if (port == null) port = parseInt(m[2], 10);
      } else if (!hostname) {
        hostname = s.replace(/^\[|\]$/g, "");
      }
    }
  }
  if (typeof port === "string") port = parseInt(port, 10);
  return { hostname, port };
}

export function makeSocketHost() {
  // handleId -> { socket, reader, writer, closed, tls }
  const map = new Map();
  let nextId = 1;

  function liveCount() {
    let n = 0;
    for (const st of map.values()) if (st && !st.closed) n++;
    return n;
  }

  function err(error, code) {
    return { ok: false, error, code };
  }

  function getState(handleId) {
    return map.get(handleId);
  }

  // Establish a socket from an already-parsed address. Shared by open() and startTls().
  function newSocket(hostname, port, secureTransport, allowHalfOpen) {
    const addr = { hostname, port };
    const sockOpts = {};
    if (secureTransport) sockOpts.secureTransport = secureTransport;
    if (allowHalfOpen != null) sockOpts.allowHalfOpen = !!allowHalfOpen;
    return connect(addr, sockOpts);
  }

  function register(socket, meta) {
    const handleId = nextId++;
    const st = {
      socket,
      reader: null,
      writer: null,
      closed: false,
      hostname: meta && meta.hostname,
      port: meta && meta.port,
      secureTransport: meta && meta.secureTransport,
      allowHalfOpen: meta && meta.allowHalfOpen,
    };
    map.set(handleId, st);
    return { handleId, st };
  }

  function lazyReader(st) {
    if (!st.reader) st.reader = st.socket.readable.getReader();
    return st.reader;
  }
  function lazyWriter(st) {
    if (!st.writer) st.writer = st.socket.writable.getWriter();
    return st.writer;
  }

  async function destroy(handleId, st) {
    if (!st) return;
    st.closed = true;
    map.delete(handleId);
    try { st.reader && (await st.reader.cancel()); } catch {}
    try { st.reader && st.reader.releaseLock && st.reader.releaseLock(); } catch {}
    try {
      if (st.writer) { await st.writer.close().catch(() => {}); }
    } catch {}
    try { st.writer && st.writer.releaseLock && st.writer.releaseLock(); } catch {}
    try { st.socket.close && (await st.socket.close()); } catch {}
  }

  return {
    // socket.open(addrOrUrl, opts) -> { ok:true, value:{ handleId } }
    // opts: { secureTransport:'off'|'on'|'starttls', allowHalfOpen, port, host }
    async open(addrOrUrl, opts) {
      opts = opts || {};
      if (liveCount() >= SOCKET_MAX_CONCURRENT) {
        return err(
          "SocketLimitError: cloudflare:sockets allows at most " + SOCKET_MAX_CONCURRENT +
            " concurrent connections per invocation; close one before opening another",
          "EMFILE"
        );
      }
      const { hostname, port } = parseAddr(addrOrUrl, opts);
      if (!hostname || port == null || Number.isNaN(port)) {
        return err("SocketAddrError: could not resolve host:port from " + JSON.stringify(addrOrUrl), "EINVAL");
      }
      const secureTransport = opts.secureTransport; // 'off' | 'on' | 'starttls' | undefined
      const allowHalfOpen = opts.allowHalfOpen;
      let socket;
      try {
        socket = newSocket(hostname, port, secureTransport, allowHalfOpen);
      } catch (e) {
        return err("SocketOpenError: " + String((e && e.message) || e), "ECONNREFUSED");
      }
      const { handleId } = register(socket, { hostname, port, secureTransport, allowHalfOpen });
      return { ok: true, value: { handleId } };
    },

    // socket.write(handleId, dataB64, isBinary) -> { ok:true, value:{ ok:true } }
    // Bytes arrive base64-encoded over the 64KB boundary (like ws.send). isBinary is accepted for
    // boundary symmetry; payload is always decoded from base64 to raw bytes for the wire.
    async write(handleId, dataB64, isBinary) {
      const st = getState(handleId);
      if (!st || st.closed) {
        return { ok: true, value: { ok: false, error: "ECONNRESET: socket handle " + handleId + " not found (severed by hibernation?)", code: "ECONNRESET" } };
      }
      let bytes;
      try {
        bytes = dataB64 == null ? new Uint8Array(0) : b64ToBytes(String(dataB64));
      } catch {
        return { ok: true, value: { ok: false, error: "SocketWriteError: bad base64 write payload", code: "EINVAL" } };
      }
      try {
        const w = lazyWriter(st);
        await w.write(bytes);
        return { ok: true, value: { ok: true } };
      } catch (e) {
        return { ok: true, value: { ok: false, error: "SocketWriteError: " + String((e && e.message) || e), code: "ECONNRESET" } };
      }
    },

    // socket.read(handleId) -> { ok:true, value:{ dataB64, done } }
    // Pulls exactly ONE chunk (this single reader.read() IS the backpressure, like _doStreamRead).
    // {done:true} at EOF/close. Unknown/stale handle -> typed ECONNRESET-shaped error (cold wake).
    async read(handleId) {
      const st = getState(handleId);
      if (!st || st.closed) {
        return { ok: true, value: { done: true, error: "ECONNRESET: socket handle " + handleId + " not found (severed by hibernation?)", code: "ECONNRESET" } };
      }
      try {
        const r = lazyReader(st);
        if (st.pending && st.pending.length) {
          let chunk = st.pending;
          st.pending = void 0;
          if (chunk.length > SOCKET_READ_CHUNK_BYTES) {
            st.pending = chunk.subarray(SOCKET_READ_CHUNK_BYTES);
            chunk = chunk.subarray(0, SOCKET_READ_CHUNK_BYTES);
          }
          return { ok: true, value: { dataB64: bytesToB64(chunk), done: false } };
        }
        const { value, done } = await r.read();
        if (done) {
          await destroy(handleId, st);
          return { ok: true, value: { done: true } };
        }
        let chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (chunk.length > SOCKET_READ_CHUNK_BYTES) {
          st.pending = chunk.subarray(SOCKET_READ_CHUNK_BYTES);
          chunk = chunk.subarray(0, SOCKET_READ_CHUNK_BYTES);
        }
        return { ok: true, value: { dataB64: bytesToB64(chunk), done: false } };
      } catch (e) {
        await destroy(handleId, st);
        return { ok: true, value: { done: true, error: "SocketReadError: " + String((e && e.message) || e), code: "ECONNRESET" } };
      }
    },

    // socket.startTls(handleId) -> { ok:true, value:{ handleId } }
    // Mirrors cloudflare:sockets startTls(): the plaintext socket must have been opened with
    // secureTransport:'starttls'. startTls() returns a NEW secured Socket; we register it under a
    // FRESH handleId and RETIRE the old handle (the old token is now stale -> ECONNRESET on use).
    async startTls(handleId) {
      const st = getState(handleId);
      if (!st || st.closed) {
        return err("ECONNRESET: socket handle " + handleId + " not found (severed by hibernation?)", "ECONNRESET");
      }
      if (st.secureTransport !== "starttls") {
        return err("SocketTlsError: startTls requires the socket to be opened with secureTransport:'starttls'", "EINVAL");
      }
      let tlsSocket;
      try {
        // Release any reader/writer locks before upgrading; startTls consumes the underlying socket.
        try { st.reader && st.reader.releaseLock && st.reader.releaseLock(); } catch {}
        try { st.writer && st.writer.releaseLock && st.writer.releaseLock(); } catch {}
        tlsSocket = st.socket.startTls();
      } catch (e) {
        return err("SocketTlsError: " + String((e && e.message) || e), "ECONNRESET");
      }
      // Retire the old handle WITHOUT closing the underlying socket (startTls reuses it).
      st.closed = true;
      map.delete(handleId);
      const { handleId: newId } = register(tlsSocket, {
        hostname: st.hostname,
        port: st.port,
        secureTransport: "on",
        allowHalfOpen: st.allowHalfOpen,
      });
      return { ok: true, value: { handleId: newId } };
    },

    // socket.close(handleId) -> { ok:true, value:{ ok:true } }
    async close(handleId) {
      const st = getState(handleId);
      if (!st) {
        // Idempotent: closing an unknown/already-gone handle is a no-op success.
        return { ok: true, value: { ok: true } };
      }
      await destroy(handleId, st);
      return { ok: true, value: { ok: true } };
    },

    // socket.listen / inbound is IMPOSSIBLE on this substrate. The VM-side net.createServer/listen
    // shim throws EPERM synchronously; this is the host backstop if a listen route is ever dispatched.
    async listen() {
      return err("EPERM: inbound/listen sockets are not supported on the Engram kernel (outbound only)", "EPERM");
    },
  };
}
