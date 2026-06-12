// engram stdlib shim: a Node-shaped `net` CLIENT module for the QuickJS sandbox.
//
// The real TCP socket lives in the DO (cloudflare:sockets / connect()); the VM holds ONLY an
// integer handleId token. All I/O crosses the host boundary via globalThis.host['socket.*']
// (mirrors 'ws.open'/'streamRead'): JSON payloads, binary as base64 over the 64KB boundary.
//
// ⚠ KEEP-ALIVE / NO INACTIVITY TIMER: this substrate has NO inactivity timeout — the host
// `socket.read` BLOCKS until a chunk arrives or the peer closes. There is no way for the shim to
// un-block a host call it `await`s. Therefore a request that holds the connection open with no
// further bytes (HTTP keep-alive without `Connection: close`, an idle long-poll, etc.) will park
// the read loop forever. CALLERS MUST send `Connection: close` (or otherwise cause the peer to
// half-close) so the host read returns `{done:true}` and the pump can stop. (Tracked separately as
// a host-sockets item: make the host read time-bounded / non-blocking so an idle poll returns.)
//
// CONCURRENCY MODEL (the durable fix): every host `socket.*` call for a given socket runs STRICTLY
// SEQUENTIALLY through a single per-socket command loop (`_runLoop`). At most ONE host call is in
// flight for a socket at any instant, and it is fully `await`ed before the next is issued — this
// exactly mimics the proven raw sequential path (open -> write -> read -> close) and can NEVER race
// the engine's single-slot global __settleHost resolver. Writes issued from a cell are enqueued and
// drained by the loop between reads; the loop is the ONLY thing that calls socket.read/write/close
// after connect. No fire-and-forget read pump, no overlapping in-flight calls.
//
//   host['socket.open'](addrOrUrl, opts)        -> { handleId } | { error }
//       opts: { secureTransport:'off'|'on'|'starttls', allowHalfOpen, port, host }
//   host['socket.write'](handleId, b64, isBin)  -> { ok } | { error }
//   host['socket.read'](handleId)               -> { dataB64, done } | { error }   (pulls ONE chunk)
//   host['socket.startTls'](handleId)           -> { handleId } | { error }        (NEW handle; old closes)
//   host['socket.close'](handleId)              -> { ok } | { error }
//
// DURABILITY: live sockets DIE on DO eviction (the host Map is in-memory, like _ws/_streams).
// After a cold restore the heap still holds the stale handleId — any read/write on it surfaces
// a typed 'ECONNRESET'-coded error (handle not found), NEVER a hang. Sockets are NOT snapshotted.
//
// LIMITS: cloudflare:sockets caps ~6 outbound connections per invocation awaiting response —
// the 7th surfaces as a typed EMFILE error (local guard + host-error mapping), it does not hang.
// INBOUND IS IMPOSSIBLE on this substrate: net.Server/createServer/listen throw a typed
// NotSupportedError (code 'EPERM') immediately.
//
// DETERMINISM: socket I/O is a host-mediated effect (exactly like host.fetch / ws.*) — it adds
// zero entropy to the seeded clock/RNG; timestamps still come from the seeded Date.now.
//
// Self-installs into globalThis.__mods under 'net' AND 'node:net' so require('net') resolves
// AHEAD of the __nodeCompat excluded-module throw (require checks __mods before excluded).

(function () {
  'use strict';
  var G = globalThis;

  // ---- plumbing from BOOTSTRAP (always installed before stdlib injection) ----
  var B64 = G.__fetchB64; // { enc: Uint8Array -> b64, dec: b64 -> Uint8Array }
  var stream = G.require('stream');
  var Duplex = stream.Duplex;

  function toU8(data, enc) {
    if (data instanceof Uint8Array) return data; // includes Buffer (Uint8Array-based in this VM)
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new TextEncoder().encode(String(data)); // enc beyond utf8 not supported; utf8 default
  }
  function asBuf(u8) { return (G.Buffer && typeof G.Buffer.from === 'function') ? G.Buffer.from(u8) : u8; }

  // ---- host-call serialization gate (THE root-cause fix, hardened) ----
  // The engine host boundary uses a SINGLE global __settleHost slot: the host Proxy's promise
  // executor synchronously installs globalThis.__settleHost, and the engine resolves exactly that
  // one slot on resume. If two host calls have their executors run before the first parks+resolves,
  // the second clobbers the first's settler and the earlier promise hangs forever (proven LIVE:
  // two overlapping socket.open => first pending, second resolved). The earlier shim ran a
  // fire-and-forget socket.read loop CONCURRENTLY with cell-issued socket.write/close, relying on a
  // FIFO gate to stop them orphaning each other — but a chained read loop could still keep the slot
  // busy in a way that depended on resolver timing.
  //
  // NEW MODEL: there is no concurrent read pump at all. Every socket runs a single per-socket
  // command loop (Socket.prototype._runLoop) that `await`s each host call before issuing the next,
  // so at most ONE host call is ever in flight per socket and it never overlaps another. As a
  // belt-and-suspenders measure across DIFFERENT sockets (a cell can open two), `_hostCall` also
  // chains every socket.* call onto one global promise tail so the WHOLE VM issues socket host
  // calls strictly sequentially — exactly like the raw single-cell path. host.fetch/git use their
  // own awaited call sites and are unaffected.
  var _hostTail = Promise.resolve(); // global sequential chain for ALL socket.* host calls
  function _hostCall(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var run = function () { return Promise.resolve(G.host[name].apply(null, args)); };
    // append to the global tail; the call only STARTS after the prior one settles.
    var p = _hostTail.then(run, run);
    // keep the tail alive even if this call rejects, so a failure never wedges the chain.
    _hostTail = p.then(function () {}, function () {});
    return p;
  }

  // ---- typed error helpers ----
  function mkErr(name, code, message, syscall) {
    var e = new Error(message);
    e.name = name; e.code = code;
    if (syscall) e.syscall = syscall;
    return e;
  }
  function notSupported() {
    return mkErr('NotSupportedError', 'EPERM',
      'inbound TCP is not available on this substrate (no listen); outbound only');
  }
  // Map a host-side error string to a Node-shaped socket error. Stale handles (post-restore:
  // the DO's socket Map died with the old instance) MUST read as ECONNRESET.
  function mapHostErr(msg, syscall) {
    msg = String(msg || 'socket error');
    if (/too many|limit|EMFILE|concurren/i.test(msg)) {
      return mkErr('Error', 'EMFILE',
        'socket connect failed: ' + msg +
        ' (cloudflare:sockets allows max 6 concurrent outbound connections per invocation)', syscall);
    }
    if (/handle|not found|unknown|stale|no such|closed|reset/i.test(msg)) {
      return mkErr('Error', 'ECONNRESET',
        'socket ' + (syscall || 'io') + ' failed: ' + msg +
        ' (handle is stale — live sockets do not survive hibernation/cold-restore)', syscall);
    }
    if (syscall === 'connect') return mkErr('Error', 'ECONNREFUSED', 'connect failed: ' + msg, syscall);
    return mkErr('Error', 'ECONNRESET', 'socket ' + (syscall || 'io') + ' failed: ' + msg, syscall);
  }

  // ---- pure helpers ----
  function isIPv4(s) {
    if (typeof s !== 'string') return false;
    var p = s.split('.');
    if (p.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(p[i])) return false;
      if (p[i].length > 1 && p[i][0] === '0') return false;
      var n = parseInt(p[i], 10);
      if (n > 255) return false;
    }
    return true;
  }
  function isIPv6(s) {
    if (typeof s !== 'string' || s.indexOf(':') < 0) return false;
    // strip zone id
    var zi = s.indexOf('%'); if (zi >= 0) s = s.slice(0, zi);
    var dbl = s.indexOf('::');
    if (dbl >= 0 && s.indexOf('::', dbl + 1) >= 0) return false; // only one '::'
    var halves = dbl >= 0 ? [s.slice(0, dbl), s.slice(dbl + 2)] : [s];
    var groups = 0;
    for (var h = 0; h < halves.length; h++) {
      if (halves[h] === '') continue;
      var parts = halves[h].split(':');
      for (var i = 0; i < parts.length; i++) {
        var g = parts[i];
        if (g === '') return false;
        // trailing embedded IPv4 (e.g. ::ffff:1.2.3.4) — only allowed as the LAST group
        if (g.indexOf('.') >= 0) {
          if (h !== halves.length - 1 || i !== parts.length - 1) return false;
          if (!isIPv4(g)) return false;
          groups += 2; continue;
        }
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
        groups += 1;
      }
    }
    if (dbl < 0) return groups === 8;
    return groups < 8;
  }
  function isIP(s) { return isIPv4(s) ? 4 : (isIPv6(s) ? 6 : 0); }

  // ---- connection-cap local guard (defense in depth; host also enforces) ----
  var MAX_SOCKETS = 6;
  var _openCount = 0;

  // ---- normalize connect() args: (options[,cb]) | (port[,host][,cb]) ----
  function normalizeConnectArgs(args) {
    var options = {}, cb = null;
    if (args.length && typeof args[args.length - 1] === 'function') { cb = args[args.length - 1]; args = Array.prototype.slice.call(args, 0, -1); }
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      options = args[0];
    } else {
      options = { port: args[0] };
      if (typeof args[1] === 'string') options.host = args[1];
    }
    return { options: options, cb: cb };
  }

  // =====================================================================
  // net.Socket — a Duplex over the host socket.* pull/push primitive.
  // =====================================================================
  function Socket(options) {
    if (!(this instanceof Socket)) return new Socket(options);
    options = options || {};
    Duplex.call(this, {});
    this._handleId = null;
    this._secureTransport = options._secureTransport || 'off'; // 'off' | 'on' | 'starttls' (tls.js sets this)
    this._allowHalfOpen = !!options.allowHalfOpen;
    this._preQ = [];          // writes queued before connect resolves
    this._writeQ = [];         // post-connect writes the command loop drains between reads: {u8,cb}
    this._loopRunning = false; // is the per-socket command loop active
    this._wantClose = false;   // a close was requested; loop closes the handle then stops
    this._closed = false;
    this._counted = false;    // did this socket take a slot in _openCount
    this.connecting = false;
    this.pending = true;
    this.destroyed = false;
    this.encrypted = false;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
    this.remoteFamily = undefined;
    this.localAddress = undefined;
    this.localPort = undefined;
    this.timeout = 0;
  }
  Object.setPrototypeOf(Socket.prototype, Duplex.prototype);
  Object.setPrototypeOf(Socket, Duplex);

  Object.defineProperty(Socket.prototype, 'readyState', {
    get: function () {
      if (this.connecting) return 'opening';
      if (this._handleId != null && !this._closed) return 'open';
      return 'closed';
    }
  });

  Socket.prototype.connect = function () {
    var n = normalizeConnectArgs(arguments);
    var options = n.options, cb = n.cb;
    var self = this;
    if (self.connecting || self._handleId != null) {
      throw mkErr('Error', 'EISCONN', 'socket is already connecting/connected');
    }
    var port = options.port, host = options.host || 'localhost';
    if (options.path) { // unix domain sockets do not exist here
      queueMicrotask(function () { self._fail(mkErr('Error', 'ENOTSUP', 'unix-domain sockets (options.path) are not supported on this substrate'), 'connect'); });
      return self;
    }
    if (port == null || !(parseInt(port, 10) >= 0 && parseInt(port, 10) <= 65535)) {
      throw mkErr('RangeError', 'ERR_SOCKET_BAD_PORT', '"port" must be 0-65535, got ' + port);
    }
    port = parseInt(port, 10);
    if (cb) self.once('connect', cb);
    if (options.allowHalfOpen !== undefined) self._allowHalfOpen = !!options.allowHalfOpen;

    // local 6-connection guard — surface the 7th as a typed error, never hang.
    if (_openCount >= MAX_SOCKETS) {
      queueMicrotask(function () {
        self._fail(mkErr('Error', 'EMFILE',
          'connect ' + host + ':' + port + ' refused: max ' + MAX_SOCKETS +
          ' concurrent outbound sockets per invocation (cloudflare:sockets cap) — close one first'), 'connect');
      });
      return self;
    }

    self.connecting = true;
    self.pending = true;
    var addr = host + ':' + port;
    var openOpts = {
      secureTransport: self._secureTransport,
      allowHalfOpen: self._allowHalfOpen,
      port: port,
      host: host
    };
    _openCount++; self._counted = true;
    // STRICT SEQUENTIAL: await the open fully (it is the first link of this socket's host-call
    // chain), then hand control to the single per-socket command loop. No call overlaps the open.
    _hostCall('socket.open', addr, openOpts).then(function (r) {
      if (!r || r.error || r.handleId == null) {
        self._uncount();
        self._fail(mapHostErr((r && r.error) || 'open failed', 'connect'), 'connect');
        return;
      }
      if (self.destroyed) { // destroyed while connecting — close the fresh handle
        self._uncount();
        _hostCall('socket.close', r.handleId).catch(function () {});
        return;
      }
      self._handleId = r.handleId;
      self.connecting = false;
      self.pending = false;
      self.remoteAddress = host;
      self.remotePort = port;
      self.remoteFamily = isIPv6(host) ? 'IPv6' : 'IPv4';
      if (self._secureTransport === 'on') self.encrypted = true;
      // move any pre-connect writes into the loop's write queue (drained in order before reads)
      var q = self._preQ; self._preQ = [];
      for (var i = 0; i < q.length; i++) self._writeQ.push(q[i]);
      self.emit('connect');
      self.emit('ready');
      if (self.encrypted) self.emit('secureConnect');
      if (self._endAfterFlush) self._wantClose = true;
      self._startLoop();
    }).catch(function (e) {
      self._uncount();
      self._fail(mapHostErr(e && e.message, 'connect'), 'connect');
    });
    return self;
  };

  Socket.prototype._uncount = function () {
    if (this._counted) { this._counted = false; _openCount = Math.max(0, _openCount - 1); }
  };

  Socket.prototype._fail = function (err, syscall) {
    this.connecting = false;
    this._closed = true;
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('error', err);
      this.emit('close', true);
    }
  };

  // The single per-socket command loop. This is the ONE place that issues socket.write/read/close
  // after connect, and it ALWAYS `await`s the current host call before issuing the next — so there
  // is never more than one in-flight host call for this socket, and it can never overlap another
  // (no concurrent read pump). Ordering each turn: drain ALL queued writes first (await each), then
  // honor a pending close, then do exactly ONE read and recurse. This mirrors the proven raw
  // sequential path (write* -> read -> ...). startTls swaps _handleId; the old loop notices the
  // mismatch on its next turn and exits silently — _startLoop is re-invoked for the new handle.
  Socket.prototype._startLoop = function () {
    var self = this;
    if (self._loopRunning) return;          // exactly one loop per socket
    if (self._handleId == null || self.destroyed || self._closed) return;
    self._loopRunning = true;
    var id = self._handleId;

    function stop() { self._loopRunning = false; }

    function turn() {
      // bail if torn down or the handle was swapped (startTls) out from under us.
      if (self.destroyed || self._closed || self._handleId !== id) return stop();

      // 1) drain ONE queued write, fully awaited, then re-enter (writes go before reads).
      if (self._writeQ.length) {
        var job = self._writeQ.shift();
        return _hostCall('socket.write', id, B64.enc(job.u8), true).then(function (r) {
          if (self._handleId !== id || self.destroyed) return stop();
          if (r && r.error) {
            var werr = mapHostErr(r.error, 'write');
            if (job.cb) job.cb(werr);
            self.emit('error', werr);
          } else if (job.cb) {
            job.cb();
          }
          return turn();
        }, function (e) {
          if (self._handleId !== id || self.destroyed) return stop();
          var werr = mapHostErr(e && e.message, 'write');
          if (job.cb) job.cb(werr);
          self.emit('error', werr);
          return turn();
        });
      }

      // 2) a close was requested and all writes flushed — close the handle, then stop.
      if (self._wantClose) { stop(); self._doClose(); return; }

      // 3) exactly ONE read, fully awaited, then recurse. The read is the only in-flight host
      // call now; nothing can clobber the __settleHost slot.
      return _hostCall('socket.read', id).then(function (r) {
        if (self._handleId !== id || self.destroyed) return stop();
        if (r && r.error) { stop(); self._teardown(mapHostErr(r.error, 'read')); return; }
        if (r && r.dataB64) {
          var u8 = B64.dec(r.dataB64);
          self.bytesRead += u8.length;
          self._deliver(asBuf(u8));
        }
        if (r && r.done) {
          stop();
          self.push(null); // -> 'end' (+ 'close' via Readable end path)
          self._remoteEnded = true;
          if (!self._allowHalfOpen) self._doClose();
          return;
        }
        return turn(); // idle/empty chunk OR data: loop again (host mediates backpressure)
      }, function (e) {
        if (self._handleId !== id || self.destroyed) return stop();
        stop();
        self._teardown(mapHostErr(e && e.message, 'read'));
      });
    }

    Promise.resolve().then(turn);
  };

  // Deliver one inbound chunk. The BOOTSTRAP Readable flow (push()->'data') only fires when the
  // stream is in flowing mode; for a fire-and-forget 'data' listener on this Duplex subclass that
  // is normally true (Readable.prototype.on flips flowing on 'data'), but we do NOT want the live
  // socket to silently buffer if a consumer never flips flow. So: if anyone is listening for 'data'
  // and the stream is flowing (or has no explicit pause), emit synchronously here; otherwise push()
  // into the Readable buffer so .read()/.resume()/for-await still work. Never double-deliver.
  Socket.prototype._deliver = function (buf) {
    var st = this._readableState;
    var flowing = !st || st.flowing !== false; // null (unset) or true => flowing; only explicit pause holds
    if (flowing && this.listenerCount && this.listenerCount('data') > 0) {
      // direct emit — robust against any subclass flow-state edge; keeps state consistent.
      if (st) { st.flowing = true; }
      this.emit('data', buf);
      return;
    }
    // paused or no listener yet: buffer it; Readable.read()/resume()/'data'-listener flushes later.
    this.push(buf);
  };

  // _teardown(err): end the read side and surface a terminal error on the socket. Called by the
  // read pump on a host read error / rejected read (mid-stream RST/ECONNRESET). Without this the
  // pump's .then/.catch threw "self._teardown is not a function", killing the socket silently with
  // NO 'error'/'close'. Idempotent; closes the host handle, ends the readable, emits error+close.
  Socket.prototype._teardown = function (err) {
    var self = this;
    if (self.destroyed) return;
    self._loopRunning = false;
    self._closed = true;
    self._uncount();
    var id = self._handleId; self._handleId = null;
    if (id != null) _hostCall('socket.close', id).catch(function () {});
    self.destroyed = true;
    try { self.push(null); } catch (e) {} // end the readable side -> 'end'
    if (err) self.emit('error', err);
    self.emit('close', !!err);
  };

  // write(): NEVER issues a host call directly. It enqueues the chunk on the per-socket write queue
  // (or the pre-connect queue) and ensures the command loop is running. The loop drains writes
  // sequentially between reads, so a write can never overlap the in-flight read on the host slot.
  Socket.prototype.write = function (data, enc, cb) {
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (this.destroyed || this._closed) {
      var err = mkErr('Error', 'ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed');
      if (cb) { cb(err); return false; }
      throw err;
    }
    var u8 = toU8(data, enc);
    this.bytesWritten += u8.length;
    if (this._handleId == null) { this._preQ.push({ u8: u8, cb: cb }); return true; } // queued pre-connect
    this._writeQ.push({ u8: u8, cb: cb });
    this._startLoop(); // no-op if already running; otherwise picks up the queued write next turn
    return true;
  };

  Socket.prototype._doClose = function () {
    var self = this;
    if (self._closed) return Promise.resolve();
    self._loopRunning = false;
    self._closed = true;
    var id = self._handleId;
    self._uncount();
    if (id == null) {
      if (!self.destroyed) { self.destroyed = true; queueMicrotask(function () { self.emit('close', false); }); }
      return Promise.resolve();
    }
    return _hostCall('socket.close', id).catch(function () {}).then(function () {
      if (!self.destroyed) { self.destroyed = true; self.emit('close', false); }
    });
  };

  Socket.prototype.end = function (data, enc, cb) {
    if (typeof data === 'function') { cb = data; data = undefined; }
    else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    var self = this;
    if (cb) self.once('close', function () { cb(); });
    var fin = function () {
      if (self.connecting) { self._endAfterFlush = true; return; } // close once connect settles
      // ask the command loop to close AFTER it flushes all queued writes; if no loop is running
      // (e.g. nothing left to do), close directly.
      if (self._loopRunning) { self._wantClose = true; }
      else self._doClose();
    };
    if (data !== undefined && data !== null && !self.destroyed && !self._closed) {
      // final write, then close — enqueue the write, mark close-after-flush; the loop drains the
      // write then honors _wantClose. (write ordering is the single per-socket loop.)
      var u8 = toU8(data, enc);
      self.bytesWritten += u8.length;
      if (self._handleId == null) { self._preQ.push({ u8: u8 }); self._endAfterFlush = true; return self; }
      self._writeQ.push({ u8: u8 });
      self._wantClose = true;
      self._startLoop();
      return self;
    }
    fin();
    return self;
  };

  Socket.prototype.destroy = function (err) {
    var self = this;
    if (self.destroyed) return self;
    self.destroyed = true;
    self.connecting = false;
    self._loopRunning = false;
    var id = self._handleId;
    self._closed = true;
    self._uncount();
    if (id != null) _hostCall('socket.close', id).catch(function () {});
    queueMicrotask(function () {
      if (err) self.emit('error', err);
      self.emit('close', !!err);
    });
    return self;
  };
  Socket.prototype.destroySoon = function () { return this.destroy(); };
  Socket.prototype.resetAndDestroy = function () { return this.destroy(mkErr('Error', 'ECONNRESET', 'socket reset')); };

  // _startTls(): swap this socket's handle for a TLS-upgraded one (STARTTLS). Used by tls.js.
  // The host closes the old handle and returns a NEW handleId (mirrors cloudflare:sockets
  // startTls()); the old read pump exits on the handle-mismatch check, a new pump starts.
  Socket.prototype._startTls = function () {
    var self = this;
    if (self._handleId == null) return Promise.reject(mkErr('Error', 'ENOTCONN', 'cannot startTls: socket is not connected'));
    if (self.encrypted) return Promise.reject(mkErr('Error', 'ERR_TLS_ALREADY', 'socket is already TLS'));
    var oldId = self._handleId;
    return _hostCall('socket.startTls', oldId).then(function (r) {
      if (!r || r.error || r.handleId == null) throw mapHostErr((r && r.error) || 'startTls failed', 'startTls');
      // The old command loop sees _handleId !== its captured id on its next turn and exits. Reset
      // the loop flag so _startLoop spins up a fresh loop bound to the new (TLS) handle.
      self._handleId = r.handleId;
      self._loopRunning = false;
      self.encrypted = true;
      self._startLoop();
      self.emit('secureConnect');
      return self;
    });
  };

  // Node-shape no-ops (no kernel-level TCP knobs / no inactivity timers in this substrate;
  // timers are immediate-fire so a real inactivity timeout is not expressible).
  Socket.prototype.setNoDelay = function () { return this; };
  Socket.prototype.setKeepAlive = function () { return this; };
  Socket.prototype.setTimeout = function (ms, cb) { this.timeout = ms; if (cb) this.once('timeout', cb); return this; };
  Socket.prototype.ref = function () { return this; };
  Socket.prototype.unref = function () { return this; };
  Socket.prototype.address = function () { return {}; };

  // inbound is impossible on this substrate (DO has no listening sockets)
  Socket.prototype.listen = function () { throw notSupported(); };

  // =====================================================================
  // factory + module surface
  // =====================================================================
  function createConnection() {
    var n = normalizeConnectArgs(arguments);
    var sock = new Socket(n.options);
    var args = [n.options];
    if (n.cb) args.push(n.cb);
    return sock.connect.apply(sock, args);
  }

  function Server() { throw notSupported(); }
  Server.prototype.listen = function () { throw notSupported(); };
  function createServer() { throw notSupported(); }

  var api = {
    Socket: Socket,
    Stream: Socket, // legacy alias
    connect: createConnection,
    createConnection: createConnection,
    Server: Server,
    createServer: createServer,
    listen: function () { throw notSupported(); },
    isIP: isIP,
    isIPv4: isIPv4,
    isIPv6: isIPv6,
    _normalizeConnectArgs: normalizeConnectArgs, // shared with tls.js
    _mkErr: mkErr,                                // shared with tls.js
  };
  api.default = api;

  G.__mods = G.__mods || {};
  G.__mods['net'] = api;
  G.__mods['node:net'] = api;
})();
