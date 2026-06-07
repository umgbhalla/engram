// IN-VM Node-compat stdlib test (engine-harness WASI pattern).
//
// Exercises the BOOTSTRAP Node shims INSIDE the real rquickjs wasm32-wasip1 engine — the single
// realm that ships to production — so we catch realm/snapshot issues a Node `vm` smoke can't:
//   stream     : Readable -> Transform -> Writable .pipe() yields the expected output; pipeline + finished
//   path       : parse/relative/isAbsolute/normalize/join/resolve/format/posix
//   util       : format (printf), inspect honoring {depth}, util.types.*, isDeepStrictEqual, promisify
//   assert     : structural deepStrictEqual on a Map (key-order-insensitive), NaN, strict-type, throws
//   events     : on/once semantics + static EventEmitter.once() resolving the emitted args
//   Buffer     : readDoubleBE/writeDoubleBE + writeBigInt64BE/readBigInt64BE round-trip + swap32 + indexOf
//   querystring: stringify/parse (incl. repeated-key arrays)
//   string_decoder: StringDecoder buffers a split UTF-8 multibyte sequence across writes
//   __nodeCompat: builtins enumerates the new set; require() throw lists builtins + flags EXCLUDED modules
//   WAVE2      : crypto createHash(sha256/sha1/md5)+createHmac known vectors, zlib gzip/deflate round-trip,
//                url.parse, http/https client surface; crypto-shadow defense (manual globalThis.crypto
//                reassign does NOT recurse). The full transform-pipeline shadow regression is in
//                tests/kernel-rust/node-compat-wave2.mjs.
//
// All evals run as top-level-await cells (the engine wraps them); these shims make NO host call, so
// evalCell never parks — but we keep the host-park loop for parity with the harness.
//
// Run: node tests/kernel-rust/node-compat.mjs
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, "../../apps/kernel/engine/target/wasm32-wasip1/release/engine.wasm");
const mod = await WebAssembly.compile(readFileSync(WASM));

function newInst() {
  const wasi = new WASI({ version: "preview1", args: [], env: {}, preopens: {} });
  const i = new WebAssembly.Instance(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  try { wasi.initialize(i); } catch {}
  return i;
}

const HOST_CALL = 1;

// reserve-then-write (never cache ptr/buffer across the reserve — mirrors the dynamic-scratch glue).
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
function evalCell(ex, src, { budget = 5_000_000, growCapPages = 512 } = {}) {
  const n = writeScratch(ex, src);
  let status = ex.eval_begin(ex.scratch_ptr(), n, BigInt(budget), growCapPages);
  let guard = 0;
  while (status === HOST_CALL && guard++ < 50) {
    const req = readHostCall(ex);
    const res = { ok: false, error: "no host fn in node-compat test: " + req.name };
    const rn = writeScratch(ex, JSON.stringify(res));
    status = ex.eval_resume(ex.scratch_ptr(), rn);
  }
  ex.scratch_release();
  return readResult(ex);
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "  got=" + JSON.stringify(extra)); }
}
// eval a cell, assert ok, return its .value
function val(ex, src) { const r = evalCell(ex, src); if (!r.ok) { return { __err: r.error }; } return r.value; }

const i = newInst();
const ex = i.exports;
ex.create(0n, 42n);

// ===== stream — the keystone =====
{
  // Readable -> Transform (upcase) -> Writable; collect into a global the cell returns.
  const r = val(ex, `
    (async function(){
      var s = require('stream');
      var out = [];
      var rd = new s.Readable({ read(){} });
      var up = new s.Transform({ transform(ch, enc, cb){ cb(null, new TextEncoder().encode(new TextDecoder().decode(ch).toUpperCase())); } });
      var w  = new s.Writable({ write(ch, enc, cb){ out.push(new TextDecoder().decode(ch)); cb(); } });
      var done = new Promise(function(res){ w.on('finish', res); });
      rd.pipe(up).pipe(w);
      rd.push('ab'); rd.push('cd'); rd.push(null);
      await done;
      return out.join('');
    })()
  `);
  ok("stream Readable->Transform->Writable pipe upcases to ABCD", r === "ABCD", r);
}
{
  const r = val(ex, `
    (async function(){
      var s = require('stream');
      var got = [];
      var rd = s.Readable.from(['x','y','z']);
      var w  = new s.Writable({ objectMode:true, write(ch, enc, cb){ got.push(ch); cb(); } });
      await s.promises.pipeline(rd, w);
      return got.join('');
    })()
  `);
  ok("stream.pipeline + Readable.from + finished resolves", r === "xyz", r);
}
ok("require('stream') has Readable/Writable/Duplex/Transform/PassThrough",
  val(ex, `(function(){ var s=require('stream'); return ['Readable','Writable','Duplex','Transform','PassThrough'].every(k=>typeof s[k]==='function'); })()`) === true);
ok("require('node:stream') === require('stream')", val(ex, `require('node:stream') === require('stream')`) === true);
ok("require('stream/promises').pipeline is a function", val(ex, `typeof require('stream/promises').pipeline`) === "function");

// ===== path =====
{
  const p = val(ex, `(function(){ var p=require('path'); return {
    parse: p.parse('/foo/bar/baz.txt'),
    rel: p.relative('/a/b/c','/a/b/d/e'),
    abs1: p.isAbsolute('/x'), abs2: p.isAbsolute('x'),
    norm: p.normalize('/a/./b/../c//d'),
    join: p.join('a','b','..','c'),
    resolve: p.resolve('/a','b','c'),
    ext: p.extname('a.tar.gz'),
    fmt: p.format({dir:'/a/b',name:'c',ext:'.js'}),
    hasPosix: typeof p.posix
  }; })()`);
  ok("path.parse", p.parse && p.parse.root==='/' && p.parse.dir==='/foo/bar' && p.parse.base==='baz.txt' && p.parse.ext==='.txt' && p.parse.name==='baz', p.parse);
  ok("path.relative", p.rel === '../d/e', p.rel);
  ok("path.isAbsolute true/false", p.abs1 === true && p.abs2 === false, [p.abs1, p.abs2]);
  ok("path.normalize collapses . .. //", p.norm === '/a/c/d', p.norm);
  ok("path.join", p.join === 'a/c', p.join);
  ok("path.resolve", p.resolve === '/a/b/c', p.resolve);
  ok("path.extname multi-dot", p.ext === '.gz', p.ext);
  ok("path.format", p.fmt === '/a/b/c.js', p.fmt);
  ok("path.posix present", p.hasPosix === 'object', p.hasPosix);
}

// ===== util =====
{
  const u = val(ex, `(function(){ var util=require('util'); return {
    fmt: util.format('%s=%d json=%j', 'x', 5, {a:1}),
    fmtExtra: util.format('hello','world',{b:2}),
    inspectMap: util.inspect(new Map([['a',1]]), {depth:2}),
    isTA: util.types.isTypedArray(new Uint8Array(2)),
    isDate: util.types.isDate(new Date()),
    isMap: util.types.isMap(new Map()),
    isSet: util.types.isSet(new Set()),
    isPromise: util.types.isPromise(Promise.resolve()),
    isRegExp: util.types.isRegExp(/x/),
    dse1: util.isDeepStrictEqual({a:[1,2]},{a:[1,2]}),
    dse2: util.isDeepStrictEqual({a:1},{a:'1'})
  }; })()`);
  ok("util.format printf %s/%d/%j", u.fmt === 'x=5 json={"a":1}', u.fmt);
  ok("util.format trailing extra args", u.fmtExtra && u.fmtExtra.indexOf('hello world') === 0, u.fmtExtra);
  ok("util.inspect honors object (Map)", u.inspectMap && u.inspectMap.includes('Map(1)'), u.inspectMap);
  ok("util.types isTypedArray/isDate/isMap/isSet/isPromise/isRegExp",
    u.isTA && u.isDate && u.isMap && u.isSet && u.isPromise && u.isRegExp, u);
  ok("util.isDeepStrictEqual true / strict-type false", u.dse1 === true && u.dse2 === false, [u.dse1, u.dse2]);
  ok("util.promisify resolves",
    val(ex, `(async function(){ var u=require('util'); var pf=u.promisify(function(a,cb){ cb(null,a*2); }); return await pf(21); })()`) === 42);
}

// ===== assert (structural) =====
{
  const a = val(ex, `(function(){ var assert=require('assert'); var r={};
    try { assert.deepStrictEqual(new Map([['a',1],['b',2]]), new Map([['b',2],['a',1]])); r.mapEq=true; } catch(e){ r.mapEq=false; }
    try { assert.deepStrictEqual({a:1},{a:2}); r.neq=false; } catch(e){ r.neq=true; r.neqName=e.name; }
    try { assert.deepStrictEqual([NaN],[NaN]); r.nan=true; } catch(e){ r.nan=false; }
    try { assert.deepStrictEqual({a:1},{a:'1'}); r.strictType=false; } catch(e){ r.strictType=true; }
    try { assert.throws(function(){ throw new TypeError('boom'); }, TypeError); r.throws=true; } catch(e){ r.throws=false; }
    try { assert.strictEqual(NaN,NaN); r.nanStrict=true; } catch(e){ r.nanStrict=false; }
    return r;
  })()`);
  ok("assert.deepStrictEqual Map (key-order-insensitive)", a.mapEq === true, a);
  ok("assert.deepStrictEqual unequal -> AssertionError", a.neq === true && a.neqName === 'AssertionError', a);
  ok("assert.deepStrictEqual NaN === NaN", a.nan === true, a);
  ok("assert.deepStrictEqual strict type 1 vs '1'", a.strictType === true, a);
  ok("assert.throws matches ctor", a.throws === true, a);
  ok("assert.strictEqual NaN (Object.is)", a.nanStrict === true, a);
  ok("assert.rejects resolves on a rejecting promise",
    val(ex, `(async function(){ var assert=require('assert'); await assert.rejects(Promise.reject(new Error('x'))); return 'ok'; })()`) === 'ok');
}

// ===== events =====
{
  const e = val(ex, `(function(){ var EE=require('events'); var em=new EE(); var hits=[];
    em.on('x', function(v){ hits.push('on:'+v); });
    var f=function(v){ hits.push('once:'+v); }; em.once('x', f);
    em.emit('x',1); em.emit('x',2);
    return { hits: hits, count: em.listenerCount('x'), names: em.eventNames() };
  })()`);
  ok("events on + once fire correctly", e.hits && e.hits.join(',') === 'on:1,once:1,on:2', e.hits);
  ok("events listenerCount after once consumed", e.count === 1, e.count);
  ok("events eventNames", Array.isArray(e.names) && e.names.indexOf('x') >= 0, e.names);
  ok("static EventEmitter.once() resolves emitted args",
    (function(){ const r = val(ex, `(async function(){ var EE=require('events'); var em=new EE(); queueMicrotask(function(){ em.emit('ready','go',2); }); var args=await EE.once(em,'ready'); return args.join(','); })()`); return r === 'go,2'; })());
}

// ===== Buffer read/write matrix =====
{
  const b = val(ex, `(function(){ var b=Buffer.alloc(16);
    b.writeDoubleBE(3.14159,0); var d=b.readDoubleBE(0);
    b.writeBigInt64BE(123456789012345n,8); var bi=b.readBigInt64BE(8);
    var f=Buffer.alloc(4); f.writeFloatLE(1.5,0); var fr=f.readFloatLE(0);
    var u=Buffer.alloc(3); u.writeUIntBE(0x010203,0,3); var ur=u.readUIntBE(0,3);
    var sw=Buffer.from([1,2,3,4]); sw.swap32();
    return {
      d: Math.abs(d-3.14159)<1e-9,
      bi: bi===123456789012345n,
      fr: fr===1.5,
      ur: ur===0x010203,
      sw: Array.from(sw).join(','),
      bl: Buffer.byteLength('héllo'),
      cmp: Buffer.compare(Buffer.from([1,2]), Buffer.from([1,3])),
      idx: Buffer.from('hello world').indexOf('world'),
      inc: Buffer.from('hello').includes('ell'),
      toJSON: JSON.stringify(Buffer.from([1,2,3])),
      fill: new TextDecoder().decode((function(){ var x=Buffer.alloc(6); x.fill('ab'); return x; })())
    };
  })()`);
  ok("Buffer writeDoubleBE/readDoubleBE round-trip", b.d === true, b.d);
  ok("Buffer writeBigInt64BE/readBigInt64BE round-trip", b.bi === true, b.bi);
  ok("Buffer writeFloatLE/readFloatLE round-trip", b.fr === true, b.fr);
  ok("Buffer writeUIntBE/readUIntBE(off,len)", b.ur === true, b.ur);
  ok("Buffer swap32 reverses 4-byte groups", b.sw === '4,3,2,1', b.sw);
  ok("Buffer.byteLength utf8 (é counts 2)", b.bl === 6, b.bl);
  ok("Buffer.compare returns -1", b.cmp === -1, b.cmp);
  ok("Buffer.indexOf string needle", b.idx === 6, b.idx);
  ok("Buffer.includes string needle", b.inc === true, b.inc);
  ok("Buffer.toJSON { type:'Buffer', data }", b.toJSON === '{"type":"Buffer","data":[1,2,3]}', b.toJSON);
  ok("Buffer.fill('ab') pattern", b.fill === 'ababab', b.fill);
}

// ===== querystring =====
{
  const q = val(ex, `(function(){ var q=require('querystring'); return { s: q.stringify({a:1,b:'x y',c:[1,2]}), p: q.parse('a=1&b=x%20y&c=1&c=2') }; })()`);
  ok("querystring.stringify", q.s === 'a=1&b=x%20y&c=1&c=2', q.s);
  ok("querystring.parse repeated key -> array", q.p && q.p.a==='1' && q.p.b==='x y' && Array.isArray(q.p.c) && q.p.c.join(',')==='1,2', q.p);
}

// ===== string_decoder (multibyte boundary) =====
{
  const sd = val(ex, `(function(){ var SD=require('string_decoder').StringDecoder; var d=new SD('utf8');
    var full=new TextEncoder().encode('héllo€');
    var a=d.write(full.subarray(0,2)); // splits the 2-byte é
    var b=d.write(full.subarray(2));
    return (a+b) + '|' + d.end();
  })()`);
  ok("string_decoder buffers split UTF-8 multibyte across writes", sd === 'héllo€|', sd);
}

// ===== __nodeCompat discoverability + require throw quality =====
{
  const nc = val(ex, `globalThis.__nodeCompat`);
  ok("__nodeCompat.builtins includes the new keystone set",
    nc && Array.isArray(nc.builtins) && ['stream','querystring','string_decoder','assert','util','path','events','buffer','crypto'].every(x => nc.builtins.indexOf(x) >= 0), nc && nc.builtins);
  ok("__nodeCompat advertises use() + caveats + excluded(net)",
    nc && typeof nc.use === 'string' && Array.isArray(nc.caveats) && nc.caveats.length > 0 && nc.excluded.indexOf('net') >= 0, nc);

  const thrEx = val(ex, `(function(){ try { require('child_process'); return null; } catch(e){ return e.message; } })()`);
  ok("require(excluded) -> clear EXCLUDED message", typeof thrEx === 'string' && /EXCLUDED/.test(thrEx), thrEx);
  const thrUnk = val(ex, `(function(){ try { require('totally-made-up-pkg'); return null; } catch(e){ return e.message; } })()`);
  ok("require(unknown) -> lists builtins + suggests use()", typeof thrUnk === 'string' && /Available builtins/.test(thrUnk) && /use\(/.test(thrUnk), thrUnk);
}

// ===== regression: existing builtins/globals still work after the rewrite =====
ok("require('crypto').randomUUID still works", typeof val(ex, `require('crypto').randomUUID()`) === 'string');
ok("require('os').EOL", val(ex, `require('os').EOL`) === '\n');
ok("fs VFS still round-trips", val(ex, `(function(){ var fs=require('fs'); fs.writeFileSync('/t.txt','hi'); return fs.readFileSync('/t.txt','utf8'); })()`) === 'hi');
ok("util.inherits + EventEmitter subclass emits",
  val(ex, `(function(){ var util=require('util'); var EE=require('events'); function My(){ EE.call(this); } util.inherits(My, EE); var m=new My(); var got=null; m.on('e', function(v){ got=v; }); m.emit('e', 7); return got; })()`) === 7);

// ===== crypto-SHADOW defense-in-depth (engine-level; the transform-pipeline regression is in
// node-compat-wave2.mjs). require('crypto').getRandomValues captures the SEEDED primitive once, so
// even a MANUAL `globalThis.crypto = require('crypto')` can never recurse into itself (was a stack
// overflow -> RuntimeError: unreachable when the shim's getRandomValues resolved to itself). =====
ok("crypto randomBytes does NOT recurse after globalThis.crypto reassign",
  val(ex, `(function(){ globalThis.crypto = require('crypto'); return globalThis.crypto.randomBytes(8).length; })()`) === 8);

// ===== Node-compat WAVE 2 surface (crypto hashes/hmac, zlib, url, http) — known vectors. =====
ok("crypto.createHash('sha256') of 'abc' == ba7816bf...",
  val(ex, `require('crypto').createHash('sha256').update('abc').digest('hex')`) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
ok("crypto.createHash sha1/md5 known vectors",
  val(ex, `(function(){var c=require('crypto');return c.createHash('sha1').update('abc').digest('hex')==='a9993e364706816aba3e25717850c26c9cd0d89d' && c.createHash('md5').update('abc').digest('hex')==='900150983cd24fb0d6963f7d28e17f72';})()`) === true);
ok("crypto.createHmac sha256 (RFC 4231 case 2)",
  val(ex, `require('crypto').createHmac('sha256','Jefe').update('what do ya want for nothing?').digest('hex')`) === '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
ok("zlib gzipSync->gunzipSync round-trip",
  val(ex, `(function(){var z=require('zlib');var s='node-compat zlib '.repeat(20);return z.gunzipSync(z.gzipSync(s)).toString('utf8')===s;})()`) === true);
ok("zlib deflateSync->inflateSync round-trip",
  val(ex, `(function(){var z=require('zlib');var s='deflate '.repeat(16);return z.inflateSync(z.deflateSync(s)).toString('utf8')===s;})()`) === true);
ok("url.parse host/path/query",
  val(ex, `(function(){var p=require('url').parse('http://h.com:9/a?b=c', true);return p.hostname+'|'+p.port+'|'+p.pathname+'|'+JSON.stringify(p.query);})()`) === 'h.com|9|/a|{"b":"c"}');
ok("require('url').URL === globalThis.URL", val(ex, `require('url').URL === globalThis.URL`) === true);
ok("http/https client modules expose request/get",
  val(ex, `(function(){var h=require('http'),s=require('https');return [typeof h.request,typeof h.get,typeof s.request,typeof s.get].join(',');})()`) === 'function,function,function,function');
ok("http.createServer throws (servers excluded)",
  typeof val(ex, `(function(){try{require('http').createServer();return null;}catch(e){return e.message;}})()`) === 'string');

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
