// engram stdlib entry: a git-smart-HTTP client for isomorphic-git that rides engram's
// BINARY-SAFE host fetch (ADR-0012). isomorphic-git's http contract:
//   request({url, method, headers, body, onProgress}) ->
//     { url, method, headers, statusCode, statusMessage, body }
// where the REQUEST `body` is an (async-)iterable of Uint8Array (the git-upload-pack request),
// and the RESPONSE `body` MUST be an async-iterable of Uint8Array (the packfile). Git transfers
// are BINARY, so we send/receive exact bytes via the binary fetch path (Uint8Array request body
// -> base64 over the host boundary; response.arrayBuffer() -> exact bytes).
//
// Self-installs into globalThis.__mods under 'isomorphic-git-http' AND 'isomorphic-git/http'
// so require() resolves it (no CDN, no relative-require, no ESM dep-tree — the spike's fragility).

(function () {
  async function collectBody(body) {
    // body may be: undefined, a Uint8Array, an array of Uint8Array, or an (async-)iterable.
    if (body == null) return undefined;
    if (body instanceof Uint8Array) return body;
    var chunks = [];
    if (typeof body[Symbol.asyncIterator] === 'function' || typeof body[Symbol.iterator] === 'function') {
      for await (var chunk of body) {
        chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      }
    } else if (Array.isArray(body)) {
      for (var i = 0; i < body.length; i++) chunks.push(body[i] instanceof Uint8Array ? body[i] : new Uint8Array(body[i]));
    } else {
      return undefined;
    }
    var len = 0;
    for (var j = 0; j < chunks.length; j++) len += chunks[j].length;
    var out = new Uint8Array(len), off = 0;
    for (var k = 0; k < chunks.length; k++) { out.set(chunks[k], off); off += chunks[k].length; }
    return out;
  }

  async function request(opts) {
    var url = opts.url;
    var method = opts.method || 'GET';
    var headers = opts.headers || {};
    var reqBytes = await collectBody(opts.body);

    var init = { method: method, headers: headers };
    if (reqBytes !== undefined) init.body = reqBytes; // Uint8Array -> binary fetch (base64 boundary)

    var res = await fetch(url, init);
    var ab = await res.arrayBuffer();
    var respBytes = new Uint8Array(ab);

    // collect response headers into a plain object (isomorphic-git reads content-type etc.)
    var resHeaders = {};
    if (res.headers && typeof res.headers.forEach === 'function') {
      res.headers.forEach(function (v, k) { resHeaders[k] = v; });
    } else if (res.headers) {
      for (var hk in res.headers) resHeaders[hk] = res.headers[hk];
    }

    // RESPONSE body MUST be an async-iterable of Uint8Array.
    var bodyIter = {
      next: (function () {
        var done = false;
        return function () {
          if (done) return Promise.resolve({ done: true, value: undefined });
          done = true;
          return Promise.resolve({ done: false, value: respBytes });
        };
      })(),
    };
    bodyIter[Symbol.asyncIterator] = function () { return this; };

    return {
      url: url,
      method: method,
      headers: resHeaders,
      statusCode: res.status,
      statusMessage: res.statusText || '',
      body: bodyIter,
    };
  }

  var http = { request: request };
  http.default = http;
  globalThis.__mods = globalThis.__mods || {};
  globalThis.__mods['isomorphic-git-http'] = http;
  globalThis.__mods['isomorphic-git/http'] = http;
  globalThis.__mods['isomorphic-git/http/web'] = http;
  globalThis.gitHttp = http;
})();
