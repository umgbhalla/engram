// engram stdlib shim: a Node-shaped `tls` CLIENT module for the QuickJS sandbox.
//
// Layers on the `net` shim (stdlib-src/shims/net.js — must be injected FIRST; resolved via
// globalThis.__mods['net']). Two paths to a secured socket, both ending in 'secureConnect':
//
//   1. TLS-from-start: tls.connect(opts) with no opts.socket — opens the host socket with
//      { secureTransport: 'on' } (host['socket.open'] does the handshake in the DO).
//   2. STARTTLS upgrade: tls.connect({ socket }) with an existing plain net.Socket — calls
//      host['socket.startTls'](handleId), which returns a NEW handleId (the old handle closes,
//      mirroring cloudflare:sockets startTls()); the net.Socket swaps handles in place
//      (net.Socket.prototype._startTls), its read pump restarts on the new handle.
//
// The "TLSSocket" here IS the secured net.Socket (same object, .encrypted=true) — there is no
// separate wrapper class; tls.TLSSocket is a constructor-shaped alias that upgrades/creates one.
// Cert/key/ca options are accepted but IGNORED: TLS terminates host-side in cloudflare:sockets,
// the VM never sees key material. authorized is reported true on any successful handshake.
//
// Inbound TLS (tls.Server/createServer) is impossible on this substrate — typed NotSupportedError
// (code 'EPERM'), same as net. Determinism: host-mediated effect, zero added entropy.
//
// Self-installs into globalThis.__mods under 'tls' AND 'node:tls'.

(function () {
  'use strict';
  var G = globalThis;
  var net = (G.__mods && G.__mods['net']) || G.require('net');
  var mkErr = net._mkErr;

  function notSupported() {
    return mkErr('NotSupportedError', 'EPERM',
      'inbound TLS is not available on this substrate (no listen); outbound only');
  }

  // normalize: (options[,cb]) | (port[,host][,options][,cb])
  function normalizeTlsArgs(args) {
    var options = {}, cb = null;
    args = Array.prototype.slice.call(args);
    if (args.length && typeof args[args.length - 1] === 'function') cb = args.pop();
    if (typeof args[0] === 'object' && args[0] !== null) {
      options = Object.assign({}, args[0]);
    } else {
      options = { port: args[0] };
      if (typeof args[1] === 'string') { options.host = args[1]; if (typeof args[2] === 'object' && args[2] !== null) Object.assign(options, args[2]); }
      else if (typeof args[1] === 'object' && args[1] !== null) Object.assign(options, args[1]);
    }
    return { options: options, cb: cb };
  }

  function markSecure(sock, options) {
    sock.encrypted = true;
    sock.authorized = true; // host-side handshake succeeded; the VM never sees cert chains
    sock.authorizationError = null;
    sock.servername = options.servername || options.host;
    sock.getPeerCertificate = function () { return {}; };       // terminated host-side
    sock.getProtocol = function () { return 'TLSv1.3'; };       // nominal; host negotiates
    sock.getCipher = function () { return { name: null, standardName: null, version: null }; };
    sock.getSession = function () { return undefined; };
    sock.isSessionReused = function () { return false; };
    sock.exportKeyingMaterial = function () { throw mkErr('NotSupportedError', 'EPERM', 'keying material is not exposed (TLS terminates host-side)'); };
    sock.alpnProtocol = false;
    return sock;
  }

  // tls.connect(options[, cb]) | tls.connect(port[, host][, options][, cb])
  // Returns the secured net.Socket; emits 'secureConnect' once the handshake path completes.
  function connect() {
    var n = normalizeTlsArgs(arguments);
    var options = n.options, cb = n.cb;

    // ---- STARTTLS upgrade path: secure an EXISTING plain socket ----
    if (options.socket) {
      var plain = options.socket;
      if (cb) plain.once('secureConnect', cb);
      markSecure(plain, options);
      plain.encrypted = false; // not secure until the swap lands; _startTls flips it + emits
      var doUpgrade = function () {
        plain._startTls().catch(function (e) {
          plain.emit('error', e && e.code ? e : mkErr('Error', (e && e.code) || 'ECONNRESET', 'TLS upgrade failed: ' + (e && e.message || e)));
          plain.destroy();
        });
      };
      if (plain._handleId != null) doUpgrade();
      else if (plain.connecting) plain.once('connect', doUpgrade);
      else queueMicrotask(function () {
        plain.emit('error', mkErr('Error', 'ENOTCONN', 'tls.connect({socket}): socket is not connected'));
      });
      // re-apply secure metadata after the swap (handshake done)
      plain.once('secureConnect', function () { markSecure(plain, options); });
      return plain;
    }

    // ---- TLS-from-start path: open the host socket with secureTransport:'on' ----
    var sock = new net.Socket({ _secureTransport: 'on', allowHalfOpen: options.allowHalfOpen });
    markSecure(sock, options);
    sock.encrypted = false; // net.Socket sets encrypted + emits 'secureConnect' on open
    sock.once('secureConnect', function () { markSecure(sock, options); });
    if (cb) sock.once('secureConnect', cb);
    sock.connect({ port: options.port, host: options.host || 'localhost', allowHalfOpen: options.allowHalfOpen });
    return sock;
  }

  // TLSSocket(socket[, options]) — constructor-shaped alias of the secured socket:
  //   new tls.TLSSocket(plainSocket) upgrades that socket via STARTTLS and returns IT
  //   (the same net.Socket instance, now encrypted) — not a wrapper.
  //   new tls.TLSSocket() (no socket) returns a fresh unconnected secure-on-connect socket.
  function TLSSocket(socket, options) {
    options = options || {};
    if (socket) {
      return connect(Object.assign({}, options, { socket: socket }));
    }
    var s = new net.Socket({ _secureTransport: 'on', allowHalfOpen: options.allowHalfOpen });
    markSecure(s, options);
    s.encrypted = false;
    s.once('secureConnect', function () { markSecure(s, options); });
    return s;
  }

  function Server() { throw notSupported(); }
  Server.prototype.listen = function () { throw notSupported(); };
  function createServer() { throw notSupported(); }

  function checkServerIdentity() { return undefined; } // host validates; never fails VM-side

  var api = {
    connect: connect,
    TLSSocket: TLSSocket,
    Server: Server,
    createServer: createServer,
    checkServerIdentity: checkServerIdentity,
    getCiphers: function () { return []; }, // negotiated host-side; not enumerable from the VM
    rootCertificates: [],
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
    DEFAULT_ECDH_CURVE: 'auto',
    CLIENT_RENEG_LIMIT: 0,
    CLIENT_RENEG_WINDOW: 0,
  };
  api.default = api;

  G.__mods = G.__mods || {};
  G.__mods['tls'] = api;
  G.__mods['node:tls'] = api;
})();
