// IN-VM Node-compat WAVE 2 test (engine-harness WASI pattern) + the crypto-SHADOW regression.
//
// Exercises the BOOTSTRAP additions made for Node-compat Wave 2 INSIDE the real rquickjs
// wasm32-wasip1 engine (the single realm that ships to prod), PLUS the REPL-transform fix for the
// `const crypto = require('crypto')` shadow trap:
//
//   crypto-SHADOW : a MULTI-STATEMENT cell `const crypto = require('crypto'); crypto.randomBytes(16)`
//                   used to trap (RuntimeError: unreachable — a stack overflow: the transform
//                   globalized `crypto`, clobbering the host crypto whose getRandomValues then
//                   recursed into itself). This test runs the SHADOW cells through the SAME
//                   transform pipeline the glue uses (transformCell -> wrapAsyncCompletion, bundled
//                   here from src/repl-transform.ts) and asserts they CONVERGE for crypto, fetch,
//                   AND a normal module across cells.
//   crypto WAVE2  : createHash(sha256|sha1|md5) known vectors, createHmac (RFC 4231), randomInt,
//                   randomUUID, scryptSync, timingSafeEqual; randomBytes (the trap path) no-recurse.
//   zlib          : gzipSync->gunzipSync + deflate/inflate + raw + binary round-trip; async; brotli throws.
//   url (legacy)  : parse/format/resolve + re-exported URL/URLSearchParams globals.
//   http/https    : CLIENT get/request over a MOCKED host.fetch (no net in-harness): {statusCode,
//                   headers} + 'data'/'end' body; createServer throws.
//
// Run: node tests/kernel-rust/node-compat-wave2.mjs
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import zlibNode from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, "../../apps/kernel/engine/target/wasm32-wasip1/release/engine.wasm");
const REPL_TRANSFORM = resolve(here, "../../apps/kernel/src/repl-transform.ts");

// Bundle src/repl-transform.ts (the authored TS, inlined into kernel-glue.mjs in prod) to memory so
// this test exercises the SAME transform code the glue ships — not a copy.
const bundled = await build({
  entryPoints: [REPL_TRANSFORM],
  bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false,
});
const dataUrl = "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64");
const { transformCell, wrapAsyncCompletion } = await import(dataUrl);

const mod = await WebAssembly.compile(readFileSync(WASM));
function newInst() {
  const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens: {} });
  const i = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  try { wasi.initialize(i); } catch {}
  return i;
}

const HOST_CALL = 1;
function writeScratch(ex, s) {
  const enc = new TextEncoder().encode(s);
  ex.scratch_reserve(enc.length);
  new Uint8Array(ex.memory.buffer).set(enc, ex.scratch_ptr());
  return enc.length;
}
function readResult(ex) {
  const ptr = ex.result_ptr(), len = ex.result_len();
  return JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len).slice()));
}
function readHostCall(ex) {
  const ptr = ex.pending_host_call_ptr(), len = ex.pending_host_call_len();
  return JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len).slice()));
}
// evalCell: optionally applies the glue transform pipeline (for the shadow regression), and
// services host.fetch via a supplied mock (envelope {ok,value} — matches glue _doFetch).
function evalCell(ex, src, { transform = false, fetchMock = null, budget = 20_000_000, growCapPages = 1024 } = {}) {
  let s = src;
  if (transform) {
    try { s = transformCell(s); } catch {}
    try { s = wrapAsyncCompletion(s); } catch {}
  }
  let n, status;
  try {
    n = writeScratch(ex, s);
    status = ex.eval_begin(ex.scratch_ptr(), n, BigInt(budget), growCapPages);
  } catch (e) { ex.scratch_release?.(); return { ok: false, error: { name: "Trap", message: String(e) } }; }
  let guard = 0;
  while (status === HOST_CALL && guard++ < 50) {
    const req = readHostCall(ex);
    let res;
    if (req.name === "fetch" && fetchMock) res = fetchMock(req.args);
    else res = { ok: false, error: "no host fn in wave2 test: " + req.name };
    const rn = writeScratch(ex, JSON.stringify(res));
    try { status = ex.eval_resume(ex.scratch_ptr(), rn); }
    catch (e) { ex.scratch_release?.(); return { ok: false, error: { name: "Trap", message: String(e) } }; }
  }
  ex.scratch_release?.();
  return readResult(ex);
}
function val(ex, src, opts) { const r = evalCell(ex, src, opts); return r.ok ? r.value : { __err: r.error }; }

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "  got=" + JSON.stringify(extra)); }
}

// ============================================================================
// (A) crypto-SHADOW regression — run THROUGH the transform pipeline (the bug's home).
// ============================================================================
{
  // multi-statement: const crypto = require('crypto'); use it in the SAME cell.
  const ex = newInst().exports; ex.create(0n, 42n);
  const r = evalCell(ex, `const crypto = require('crypto'); crypto.randomBytes(16).length`, { transform: true });
  ok("SHADOW: const crypto=require + randomBytes converges (no unreachable/overflow)", r.ok && r.value === 16, r);
}
{
  // the host crypto global must NOT be clobbered by the cell-local const.
  const ex = newInst().exports; ex.create(0n, 42n);
  const r = evalCell(ex, `const crypto = require('crypto'); JSON.stringify(Object.keys(globalThis.crypto).sort())`, { transform: true });
  ok("SHADOW: host globalThis.crypto NOT clobbered (still has subtle)", r.ok && /subtle/.test(r.value) && /getRandomValues/.test(r.value), r);
}
{
  // const fetch = require('http') shadow: fetch is a host global too. Bind it cell-local; host fetch survives.
  const ex = newInst().exports; ex.create(0n, 42n);
  const r = evalCell(ex, `const fetch = require('http'); typeof fetch.request === 'function' && typeof globalThis.fetch === 'function'`, { transform: true });
  ok("SHADOW: const fetch=require(...) cell-local + host fetch survives", r.ok && r.value === true, r);
}
{
  // a NORMAL module name (not reserved) STILL persists across cells (transform globalizes it).
  const ex = newInst().exports; ex.create(0n, 42n);
  const r1 = evalCell(ex, `const myStream = require('stream')`, { transform: true });
  const r2 = evalCell(ex, `typeof myStream.Readable`, { transform: true });
  ok("SHADOW: a non-reserved const (myStream) STILL persists across cells", r1.ok && r2.ok && r2.value === "function", { r1, r2 });
}
{
  // all three in ONE multi-cell sequence: crypto (reserved), fetch (reserved), lodash-ish normal.
  const ex = newInst().exports; ex.create(0n, 42n);
  const c1 = evalCell(ex, `const crypto = require('crypto'); const url = require('url'); const ev = require('events'); [typeof crypto.createHash, typeof url.parse, typeof ev.EventEmitter].join(',')`, { transform: true });
  ok("SHADOW: const crypto + const url + const events together in one cell", c1.ok && c1.value === "function,function,function", c1);
  // and globalThis host primitives all still intact afterward
  const c2 = evalCell(ex, `[typeof globalThis.crypto.subtle, typeof globalThis.fetch, typeof globalThis.process].join(',')`, { transform: true });
  ok("SHADOW: globalThis crypto.subtle / fetch / process intact after the shadow cell", c2.ok && c2.value === "object,function,object", c2);
}

// ============================================================================
// (B) crypto WAVE 2 — known vectors (no transform needed; plain expression cells).
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  ok("createHash sha256('abc') == ba7816bf...",
    val(ex, `require('crypto').createHash('sha256').update('abc').digest('hex')`) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  ok("createHash sha1('abc') == a9993e36...",
    val(ex, `require('crypto').createHash('sha1').update('abc').digest('hex')`) === "a9993e364706816aba3e25717850c26c9cd0d89d");
  ok("createHash md5('abc') == 900150983cd24fb0...",
    val(ex, `require('crypto').createHash('md5').update('abc').digest('hex')`) === "900150983cd24fb0d6963f7d28e17f72");
  ok("createHash empty-input sha256 == e3b0c442...",
    val(ex, `require('crypto').createHash('sha256').update('').digest('hex')`) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  ok("createHash multi-update equals single-shot",
    val(ex, `(function(){var c=require('crypto');return c.createHash('sha256').update('a').update('bc').digest('hex')===c.createHash('sha256').update('abc').digest('hex');})()`) === true);
  // RFC 4231 HMAC-SHA256 test case 2.
  ok("createHmac sha256 (RFC 4231 case 2)",
    val(ex, `require('crypto').createHmac('sha256','Jefe').update('what do ya want for nothing?').digest('hex')`) === "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  ok("randomBytes(16).length === 16 (the original trap path, direct)", val(ex, `require('crypto').randomBytes(16).length`) === 16);
  ok("randomUUID is v4-shaped", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(val(ex, `require('crypto').randomUUID()`)));
  ok("randomInt(5,10) in [5,10)", (() => { const v = val(ex, `require('crypto').randomInt(5,10)`); return typeof v === "number" && v >= 5 && v < 10; })());
  ok("timingSafeEqual equal=true / unequal=false",
    val(ex, `(function(){var c=require('crypto'),B=globalThis.Buffer;return c.timingSafeEqual(B.from('abc'),B.from('abc'))===true && c.timingSafeEqual(B.from('abc'),B.from('abd'))===false;})()`) === true);
  ok("scryptSync small N yields the requested key length (deterministic)",
    val(ex, `require('crypto').scryptSync('pw','salt',16,{N:16,r:1,p:1}).length`) === 16);
  ok("crypto.subtle.digest SHA-256 still works (reuses __hashes)",
    val(ex, `(async function(){return globalThis.Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'))).toString('hex');})()`) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

// ============================================================================
// (C) zlib — gzip/deflate round-trips + interop with real node zlib.
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  ok("zlib gzipSync->gunzipSync round-trip",
    val(ex, `(function(){var z=require('zlib');var s='The quick brown fox. '.repeat(30);return z.gunzipSync(z.gzipSync(s)).toString('utf8')===s;})()`) === true);
  ok("zlib gzip compresses repetitive data",
    val(ex, `(function(){var z=require('zlib');var s='abc'.repeat(2000);return z.gzipSync(s).length < s.length;})()`) === true);
  ok("zlib deflateSync->inflateSync round-trip",
    val(ex, `(function(){var z=require('zlib');var s='zlib deflate '.repeat(20);return z.inflateSync(z.deflateSync(s)).toString('utf8')===s;})()`) === true);
  ok("zlib deflateRaw->inflateRaw round-trip",
    val(ex, `(function(){var z=require('zlib');var s='raw '.repeat(40);return z.inflateRawSync(z.deflateRawSync(s)).toString('utf8')===s;})()`) === true);
  ok("zlib round-trips all 256 byte values",
    val(ex, `(function(){var z=require('zlib');var b=new Uint8Array(256);for(var i=0;i<256;i++)b[i]=i;var o=z.gunzipSync(z.gzipSync(b));for(var i=0;i<256;i++)if(o[i]!==i)return false;return o.length===256;})()`) === true);
  ok("zlib async gzip/gunzip (callback) round-trip",
    val(ex, `(async function(){var z=require('zlib');var gz=await new Promise(function(r,j){z.gzip('async data',function(e,v){e?j(e):r(v);});});return (await new Promise(function(r,j){z.gunzip(gz,function(e,v){e?j(e):r(v);});})).toString('utf8');})()`) === "async data");
  ok("zlib brotliCompressSync throws NotSupported",
    typeof val(ex, `(function(){try{require('zlib').brotliCompressSync('x');return null;}catch(e){return e.message;}})()`) === "string");
  // interop: gunzip a REAL node-zlib gzip stream (dynamic Huffman) -> unblocks content-encoding:gzip / tar.gz.
  const nodeGzB64 = Buffer.from(zlibNode.gzipSync(Buffer.from("real node gzip, inflated in-VM"))).toString("base64");
  ok("zlib gunzipSync reads a REAL node-zlib gzip stream",
    val(ex, `(function(){var z=require('zlib');var b=Uint8Array.from(atob(${JSON.stringify(nodeGzB64)}),function(c){return c.charCodeAt(0);});return z.gunzipSync(b).toString('utf8');})()`) === "real node gzip, inflated in-VM");
  // interop: node-zlib reads OUR gzip output.
  const ourB64 = val(ex, `require('zlib').gzipSync('our gzip read by node').toString('base64')`);
  let nodeReads = false; try { nodeReads = zlibNode.gunzipSync(Buffer.from(ourB64, "base64")).toString("utf8") === "our gzip read by node"; } catch (e) { nodeReads = String(e); }
  ok("node-zlib gunzips OUR in-VM gzip output", nodeReads === true, nodeReads);
}

// ============================================================================
// (D) url (legacy module) + re-exported URL/URLSearchParams.
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  const u = val(ex, `(function(){var p=require('url').parse('https://user:pw@example.com:8080/a/b?x=1&y=2#h', true);return [p.protocol,p.hostname,p.port,p.pathname,p.search,p.hash,p.auth,JSON.stringify(p.query)].join('|');})()`);
  ok("url.parse fields", u === "https:|example.com|8080|/a/b|?x=1&y=2|#h|user:pw|" + JSON.stringify({ x: "1", y: "2" }), u);
  ok("url.format round-trips", val(ex, `(function(){var u=require('url');return u.format(u.parse('http://example.com/a?b=c'));})()`) === "http://example.com/a?b=c");
  ok("url.resolve relative", val(ex, `require('url').resolve('http://example.com/a/b','c')`) === "http://example.com/a/c");
  ok("require('url').URL === globalThis.URL", val(ex, `require('url').URL === globalThis.URL`) === true);
  ok("require('url').URLSearchParams works", val(ex, `(function(){var p=new (require('url').URLSearchParams)('a=1&b=2');return p.get('a')+p.get('b');})()`) === "12");
}

// ============================================================================
// (E) http / https CLIENT over a MOCKED host.fetch (no net in-harness).
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  const fetchMock = (args) => ({ ok: true, value: { status: 200, ok: true, statusText: "OK", headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, url: args[0] }), bodyTruncated: false } });
  const r = val(ex, `(async function(){
    var https=require('https');
    return await new Promise(function(resolve,reject){
      var req=https.get('https://api.example.com/data', function(res){
        var chunks=[]; res.on('data', function(c){ chunks.push(typeof c==='string'?c:new TextDecoder().decode(c)); });
        res.on('end', function(){ resolve({status:res.statusCode, ct:res.headers['content-type'], body:chunks.join('')}); });
      });
      req.on('error', reject);
    });
  })()`, { fetchMock });
  ok("https.get -> {statusCode, headers} + data/end body", r && r.status === 200 && r.ct === "application/json" && /"url":"https:\/\/api.example.com\/data"/.test(r.body), r);

  const p = val(ex, `(async function(){
    var http=require('http');
    return await new Promise(function(resolve,reject){
      var req=http.request({hostname:'h.example.com', path:'/echo', method:'POST', headers:{'content-type':'text/plain'}}, function(res){
        var d=''; res.setEncoding('utf8'); res.on('data', function(c){ d+=c; }); res.on('end', function(){ resolve({status:res.statusCode, body:d}); });
      });
      req.on('error', reject); req.write('payload'); req.end();
    });
  })()`, { fetchMock: (args) => ({ ok: true, value: { status: 201, ok: true, statusText: "Created", headers: {}, body: "echo:" + args[0], bodyTruncated: false } }) });
  ok("http.request POST (write+end) -> response body", p && p.status === 201 && /echo:http:\/\/h.example.com\/echo/.test(p.body), p);

  ok("http.createServer throws (servers excluded)", typeof val(ex, `(function(){try{require('http').createServer();return null;}catch(e){return e.message;}})()`) === "string");
}

// ============================================================================
// (F) node: aliases + __nodeCompat discoverability.
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  ok("require('node:zlib')===require('zlib')", val(ex, `require('node:zlib')===require('zlib')`) === true);
  ok("require('node:url')===require('url')", val(ex, `require('node:url')===require('url')`) === true);
  ok("require('node:http')===require('http')", val(ex, `require('node:http')===require('http')`) === true);
  ok("__nodeCompat.builtins lists zlib/url/http/https/crypto",
    val(ex, `(function(){var b=globalThis.__nodeCompat.builtins;return ['zlib','url','http','https','crypto'].every(function(x){return b.indexOf(x)>=0;});})()`) === true);
}

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
