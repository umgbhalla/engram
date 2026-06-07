// IN-VM Node-compat WAVE 4 test (engine-harness WASI pattern) + the cell-RETURN regression.
//
// Exercises the BOOTSTRAP additions made for Node-compat Wave 4 INSIDE the real rquickjs
// wasm32-wasip1 engine (the single realm that ships to prod):
//
//   FETCH/Response : (await fetch(dataUrl)).json()/.text()/.ok/.status/.statusText/.url/.redirected/
//                    .headers.get/.arrayBuffer/.bytes/.blob/.clone over a MOCKED host.fetch — and the
//                    BACKWARD-COMPAT shape `await (await fetch(u)).arrayBuffer()`/`.json()`.
//   web types      : new Request/Response/Headers/Blob/File/FormData (+ Response.json/.error/.redirect).
//   abort          : AbortController aborts an in-flight fetch (rejects AbortError); AbortSignal.timeout/
//                    .any; signal.aborted/reason + the 'abort' event; throwIfAborted.
//   process        : env / platform=linux / arch=x64 / version v20 / versions.node / nextTick (microtask) /
//                    hrtime + hrtime.bigint / uptime / exit throws a catchable ProcessExit (no kernel kill) /
//                    chdir+cwd / stdout.write -> console.
//   fs streams     : createReadStream reads a vfs file through to 'data'/'end' (incl. start/end + encoding);
//                    createWriteStream writes into the vfs (w + a); readdirSync withFileTypes -> Dirent
//                    (isFile/isDirectory/name); realpathSync; fs.promises completeness.
//   use() harden   : an ESM-syntax bundle surfaces an ACTIONABLE error (no opaque SyntaxError).
//   cell RETURN    : a top-level `return 42` cell yields 42 (was a SyntaxError) — run THROUGH the same
//                    transform pipeline the glue uses; trailing-expression completion still works.
//
// Run: node tests/kernel-rust/node-compat-wave4.mjs
import { readFileSync } from "node:fs";
import { WASI } from "node:wasi";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, "../../apps/kernel/engine/target/wasm32-wasip1/release/engine.wasm");
const REPL_TRANSFORM = resolve(here, "../../apps/kernel/src/repl-transform.ts");

// Bundle src/repl-transform.ts (the authored TS inlined into kernel-glue.mjs in prod) so the
// cell-RETURN test exercises the SAME transform code the glue ships, not a copy.
const bundled = await build({
  entryPoints: [REPL_TRANSFORM],
  bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false,
});
const transformUrl = "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64");
const { transformCell, wrapAsyncCompletion } = await import(transformUrl);

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
// evalCell: optionally applies the glue transform pipeline; services host.fetch via a supplied mock
// (envelope {ok,value} — matches glue _doFetch). guard high enough for multi-fetch cells.
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
  while (status === HOST_CALL && guard++ < 64) {
    const req = readHostCall(ex);
    let res;
    if (req.name === "fetch" && fetchMock) res = fetchMock(req.args);
    else res = { ok: false, error: "no host fn in wave4 test: " + req.name };
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

// A host.fetch mock returning a JSON body (the shape glue _doFetch produces: {ok,value:{...}}).
function jsonFetch(bodyObj, extra = {}) {
  return () => ({
    ok: true,
    value: {
      status: 200, ok: true, statusText: "OK", url: "https://api.example.com/x", redirected: false,
      headers: { "content-type": "application/json", "x-custom": "hello" },
      body: JSON.stringify(bodyObj), bodyTruncated: false,
      bodyB64: Buffer.from(JSON.stringify(bodyObj)).toString("base64"),
      ...extra,
    },
  });
}

// ============================================================================
// (A) fetch() -> REAL Response (the fetch idiom).
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  const fm = jsonFetch({ hello: "world", n: 7 });
  ok("(await fetch).json() parses the body",
    JSON.stringify(val(ex, `(async()=>{const r=await fetch('https://api.example.com/x');return await r.json();})()`, { fetchMock: fm })) === JSON.stringify({ hello: "world", n: 7 }));
  ok("response.ok / .status / .statusText",
    val(ex, `(async()=>{const r=await fetch('u');return [r.ok, r.status, r.statusText].join('|');})()`, { fetchMock: fm }) === "true|200|OK");
  ok("response.url / .redirected / .bodyUsed-before-read",
    val(ex, `(async()=>{const r=await fetch('u');return [r.url, r.redirected, r.bodyUsed].join('|');})()`, { fetchMock: fm }) === "https://api.example.com/x|false|false");
  ok("response.headers is a Headers (get, case-insensitive)",
    val(ex, `(async()=>{const r=await fetch('u');return [r.headers.get('Content-Type'), r.headers.get('X-CUSTOM'), r.headers.has('nope')].join('|');})()`, { fetchMock: fm }) === "application/json|hello|false");
  ok("response instanceof Response",
    val(ex, `(async()=>{const r=await fetch('u');return r instanceof Response;})()`, { fetchMock: fm }) === true);
  ok("response.text() returns the raw body",
    val(ex, `(async()=>{const r=await fetch('u');return await r.text();})()`, { fetchMock: fm }) === JSON.stringify({ hello: "world", n: 7 }));
  ok("response.arrayBuffer() -> exact bytes (BACKWARD-COMPAT idiom)",
    val(ex, `(async()=>{const ab=await (await fetch('u')).arrayBuffer();return new Uint8Array(ab).length;})()`, { fetchMock: fm }) === Buffer.from(JSON.stringify({ hello: "world", n: 7 })).length);
  ok("response.bytes() -> Uint8Array",
    val(ex, `(async()=>{const b=await (await fetch('u')).bytes();return (b instanceof Uint8Array) && b.length>0;})()`, { fetchMock: fm }) === true);
  ok("response.blob() -> Blob with size+type",
    val(ex, `(async()=>{const bl=await (await fetch('u')).blob();return [bl instanceof Blob, bl.size>0, bl.type].join('|');})()`, { fetchMock: fm }) === "true|true|application/json");
  ok("response.clone() reads body twice",
    val(ex, `(async()=>{const r=await fetch('u');const c=r.clone();const a=await r.json();const b=await c.json();return a.n===b.n && a.n===7;})()`, { fetchMock: fm }) === true);
  // binary body via bodyB64 path (truncated preview): .arrayBuffer must decode the EXACT bytes.
  {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x80]); // %PDF + non-utf8
    const b64 = Buffer.from(bytes).toString("base64");
    const fmBin = () => ({ ok: true, value: { status: 200, ok: true, statusText: "OK", headers: { "content-type": "application/pdf" }, body: "%PDF", bodyTruncated: true, bodyB64: b64, url: "u" } });
    ok("response.arrayBuffer() decodes exact binary bytes (bodyB64, truncated preview)",
      val(ex, `(async()=>{const ab=await (await fetch('u')).arrayBuffer();const u=new Uint8Array(ab);return Array.from(u).join(',');})()`, { fetchMock: fmBin }) === "37,80,68,70,255,0,128");
  }
  // bodyUsed after consuming.
  ok("response.bodyUsed true after .text(); second read rejects",
    val(ex, `(async()=>{const r=await fetch('u');await r.text();let threw=false;try{await r.text();}catch(e){threw=true;}return r.bodyUsed===true && threw;})()`, { fetchMock: fm }) === true);
}

// ============================================================================
// (B) web types: Request / Response / Headers / Blob / File / FormData (no host call).
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  ok("new Headers append/get/has/delete/forEach (case-insensitive)",
    val(ex, `(function(){var h=new Headers({'Content-Type':'text/plain'});h.append('X-A','1');h.append('X-A','2');h.set('x-b','9');var seen=[];h.forEach(function(v,k){seen.push(k+'='+v);});h.delete('content-type');return [h.get('x-a'), h.get('X-B'), h.has('content-type'), seen.length].join('|');})()`) === "1, 2|9|false|3");
  ok("new Request(url,{method,headers,body}) + .text()",
    val(ex, `(async()=>{var req=new Request('https://h/x',{method:'POST',headers:{'x-y':'z'},body:'payload'});return [req.url, req.method, req.headers.get('x-y'), await req.text()].join('|');})()`) === "https://h/x|POST|z|payload");
  ok("new Request infers content-type for string body",
    val(ex, `(function(){var req=new Request('u',{method:'POST',body:'hi'});return req.headers.get('content-type');})()`).startsWith("text/plain"));
  ok("Request.clone() preserves body",
    val(ex, `(async()=>{var a=new Request('u',{method:'PUT',body:'data'});var b=a.clone();return [await a.text(), await b.text()].join('|');})()`) === "data|data");
  ok("new Response(body,{status,headers}) + .json() (201 is ok per WHATWG)",
    val(ex, `(async()=>{var r=new Response(JSON.stringify({a:1}),{status:201,statusText:'Created',headers:{'content-type':'application/json'}});return [r.status,r.statusText,r.ok,(await r.json()).a].join('|');})()`) === "201|Created|true|1");
  ok("new Response status 404 -> ok=false",
    val(ex, `(function(){var r=new Response('nope',{status:404});return r.ok;})()`) === false);
  ok("Response.json() static helper sets content-type",
    val(ex, `(async()=>{var r=Response.json({ok:true},{status:200});return [r.headers.get('content-type'), (await r.json()).ok].join('|');})()`) === "application/json|true");
  ok("Response.error() type=error ok=false",
    val(ex, `(function(){var r=Response.error();return r.type==='error' && r.ok===false && r.status===0;})()`) === true);
  ok("Response.redirect() sets location + status",
    val(ex, `(function(){var r=Response.redirect('https://x/',301);return r.status===301 && r.headers.get('location')==='https://x/';})()`) === true);
  ok("Blob size/type/.text()/.arrayBuffer()/.slice()",
    val(ex, `(async()=>{var b=new Blob(['hello ',' world'],{type:'text/plain'});var t=await b.text();var s=b.slice(0,5);return [b.size, b.type, t, await s.text()].join('|');})()`) === "12|text/plain|hello  world|hello");
  ok("new File extends Blob with name",
    val(ex, `(async()=>{var f=new File(['abc'],'a.txt',{type:'text/plain'});return [f.name, f.size, f instanceof Blob, await f.text()].join('|');})()`) === "a.txt|3|true|abc");
  ok("FormData append/get/getAll/has/delete/entries",
    val(ex, `(function(){var fd=new FormData();fd.append('a','1');fd.append('a','2');fd.append('b','3');fd.delete('b');var e=[];for(var p of fd.entries())e.push(p[0]+'='+p[1]);return [fd.get('a'), fd.getAll('a').join(','), fd.has('b'), e.join('&')].join('|');})()`) === "1|1,2|false|a=1&a=2");
}

// ============================================================================
// (C) AbortController / AbortSignal.
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  ok("AbortController.abort() sets aborted+reason and fires 'abort'",
    val(ex, `(function(){var ac=new AbortController();var fired=false;ac.signal.addEventListener('abort',function(){fired=true;});ac.abort();return ac.signal.aborted===true && fired===true && ac.signal.reason instanceof Error;})()`) === true);
  ok("AbortController.abort(reason) carries custom reason",
    val(ex, `(function(){var ac=new AbortController();ac.abort('stop');return ac.signal.reason==='stop';})()`) === true);
  ok("signal.throwIfAborted throws after abort",
    val(ex, `(function(){var ac=new AbortController();ac.abort();try{ac.signal.throwIfAborted();return 'no-throw';}catch(e){return 'threw';}})()`) === "threw");
  ok("AbortSignal.abort() is pre-aborted",
    val(ex, `(function(){var s=AbortSignal.abort();return s.aborted===true;})()`) === true);
  ok("AbortSignal.timeout() aborts (microtask) with TimeoutError",
    val(ex, `(async()=>{var s=AbortSignal.timeout(1000);await Promise.resolve();await Promise.resolve();return s.aborted===true && s.reason && s.reason.name==='TimeoutError';})()`) === true);
  ok("AbortSignal.any aborts when one input aborts",
    val(ex, `(function(){var a=new AbortController();var any=AbortSignal.any([a.signal]);a.abort('x');return any.aborted===true && any.reason==='x';})()`) === true);
  // fetch({signal}) rejects when the signal is ALREADY aborted (no host call made).
  {
    const ex2 = newInst().exports; ex2.create(0n, 42n);
    ok("fetch with pre-aborted signal rejects AbortError (no host call)",
      val(ex2, `(async()=>{var ac=new AbortController();ac.abort();try{await fetch('https://api.example.com/x',{signal:ac.signal});return 'resolved';}catch(e){return e.name;}})()`, { fetchMock: jsonFetch({}) }) === "AbortError");
  }
}

// ============================================================================
// (D) process completion.
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  ok("process.platform=linux / arch=x64", val(ex, `[process.platform, process.arch].join('|')`) === "linux|x64");
  ok("process.version v20 + versions.node", val(ex, `[/^v20\\./.test(process.version), /^20\\./.test(process.versions.node)].join('|')`) === "true|true");
  ok("process.argv = ['node','repl']", val(ex, `process.argv.join(',')`) === "node,repl");
  ok("process.env is a plain object", val(ex, `typeof process.env === 'object' && process.env !== null`) === true);
  ok("process.env round-trips a write", val(ex, `(function(){process.env.FOO='bar';return process.env.FOO;})()`) === "bar");
  ok("process.pid is a number; cwd()='/'", val(ex, `[typeof process.pid, process.cwd()].join('|')`) === "number|/");
  ok("process.chdir + cwd", val(ex, `(function(){process.chdir('/tmp');return process.cwd();})()`) === "/tmp");
  ok("process.nextTick runs on the microtask queue (before a resolved-promise then? at least runs)",
    val(ex, `(async()=>{var hits=[];await new Promise(function(res){process.nextTick(function(a){hits.push('nt'+a);res();},9);});return hits.join(',');})()`) === "nt9");
  ok("process.hrtime() -> [s,ns] array", val(ex, `(function(){var h=process.hrtime();return Array.isArray(h) && h.length===2 && typeof h[0]==='number';})()`) === true);
  ok("process.hrtime.bigint() -> bigint", val(ex, `typeof process.hrtime.bigint()`) === "bigint");
  ok("process.uptime() -> number", val(ex, `typeof process.uptime()`) === "number");
  ok("process.exit(2) throws a catchable ProcessExit (kernel survives)",
    val(ex, `(function(){try{process.exit(2);return 'no-throw';}catch(e){return e.name+':'+e.code;}})()`) === "ProcessExit:2");
  // kernel still works after a caught exit:
  ok("kernel alive after process.exit caught", val(ex, `1+1`) === 2);
  ok("process.stdout.write -> console (captured log)",
    (() => { const r = evalCell(ex, `process.stdout.write('via-stdout\\n'); 'done'`); return r.ok && r.logs.some((l) => l.msg.includes("via-stdout")); })());
  ok("process.on('exit') is a no-op-ish registrar (returns process)",
    val(ex, `(function(){var p=process.on('exit',function(){});return p===process && process.listenerCount('exit')===1;})()`) === true);
}

// ============================================================================
// (E) fs streams + readdir Dirent + realpath + promises.
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  ok("fs.createReadStream reads a vfs file through 'data'/'end'",
    val(ex, `(async()=>{var fs=require('fs');fs.writeFileSync('/r.txt','hello stream');var got=[];return await new Promise(function(resolve,reject){var rs=fs.createReadStream('/r.txt');rs.on('data',function(c){got.push(typeof c==='string'?c:new TextDecoder().decode(c));});rs.on('end',function(){resolve(got.join(''));});rs.on('error',reject);});})()`) === "hello stream");
  ok("createReadStream {encoding:'utf8'} yields a string chunk",
    val(ex, `(async()=>{var fs=require('fs');fs.writeFileSync('/e.txt','abc');return await new Promise(function(res,rej){var rs=fs.createReadStream('/e.txt',{encoding:'utf8'});rs.on('data',function(c){res(typeof c);});rs.on('error',rej);});})()`) === "string");
  ok("createReadStream {start,end} slices (end inclusive)",
    val(ex, `(async()=>{var fs=require('fs');fs.writeFileSync('/s.txt','0123456789');return await new Promise(function(res,rej){var out=[];var rs=fs.createReadStream('/s.txt',{start:2,end:5});rs.on('data',function(c){out.push(new TextDecoder().decode(c));});rs.on('end',function(){res(out.join(''));});rs.on('error',rej);});})()`) === "2345");
  ok("createReadStream on missing file emits 'error' ENOENT",
    val(ex, `(async()=>{var fs=require('fs');return await new Promise(function(res){var rs=fs.createReadStream('/nope.txt');rs.on('error',function(e){res(e.code);});rs.on('data',function(){});});})()`) === "ENOENT");
  ok("fs.createWriteStream writes into the vfs (then readFileSync)",
    val(ex, `(async()=>{var fs=require('fs');await new Promise(function(res,rej){var ws=fs.createWriteStream('/w.txt');ws.on('finish',res);ws.on('error',rej);ws.write('part1 ');ws.write('part2');ws.end();});return fs.readFileSync('/w.txt','utf8');})()`) === "part1 part2");
  ok("createWriteStream flags:'a' appends",
    val(ex, `(async()=>{var fs=require('fs');fs.writeFileSync('/a.txt','base');await new Promise(function(res,rej){var ws=fs.createWriteStream('/a.txt',{flags:'a'});ws.on('finish',res);ws.on('error',rej);ws.end('+more');});return fs.readFileSync('/a.txt','utf8');})()`) === "base+more");
  ok("pipe a createReadStream into a createWriteStream",
    val(ex, `(async()=>{var fs=require('fs');fs.writeFileSync('/src.bin','copy-me');await new Promise(function(res,rej){var ws=fs.createWriteStream('/dst.bin');ws.on('finish',res);ws.on('error',rej);fs.createReadStream('/src.bin').pipe(ws);});return fs.readFileSync('/dst.bin','utf8');})()`) === "copy-me");
  ok("readdirSync({withFileTypes:true}) -> Dirent[] (isFile/isDirectory/name)",
    val(ex, `(function(){var fs=require('fs');fs.mkdirSync('/d',{recursive:true});fs.writeFileSync('/d/f.txt','x');fs.mkdirSync('/d/sub');var ents=fs.readdirSync('/d',{withFileTypes:true}).sort(function(a,b){return a.name<b.name?-1:1;});return ents.map(function(e){return e.name+':'+(e.isDirectory()?'dir':e.isFile()?'file':'?');}).join(',');})()`) === "f.txt:file,sub:dir");
  ok("readdirSync(dir) (no opts) still returns string names",
    val(ex, `(function(){var fs=require('fs');fs.mkdirSync('/d2',{recursive:true});fs.writeFileSync('/d2/a','1');return fs.readdirSync('/d2').join(',');})()`) === "a");
  ok("fs.Dirent instanceof check",
    val(ex, `(function(){var fs=require('fs');fs.mkdirSync('/d3',{recursive:true});fs.writeFileSync('/d3/z','1');return fs.readdirSync('/d3',{withFileTypes:true})[0] instanceof fs.Dirent;})()`) === true);
  ok("fs.realpathSync returns the normalized existing path; throws ENOENT for missing",
    val(ex, `(function(){var fs=require('fs');fs.writeFileSync('/rp.txt','x');var a=fs.realpathSync('/./rp.txt');var b;try{fs.realpathSync('/missing');b='no-throw';}catch(e){b=e.code;}return a+'|'+b;})()`) === "/rp.txt|ENOENT");
  ok("fs.existsSync true/false", val(ex, `(function(){var fs=require('fs');fs.writeFileSync('/ex.txt','1');return [fs.existsSync('/ex.txt'),fs.existsSync('/nope')].join('|');})()`) === "true|false");
  ok("fs.promises readFile/writeFile/readdir/stat/mkdir/rm/access",
    val(ex, `(async()=>{var fsp=require('fs').promises;await fsp.mkdir('/p',{recursive:true});await fsp.writeFile('/p/x.txt','hi');var t=await fsp.readFile('/p/x.txt','utf8');var st=await fsp.stat('/p/x.txt');var dir=await fsp.readdir('/p');await fsp.access('/p/x.txt');await fsp.rm('/p/x.txt');var gone=require('fs').existsSync('/p/x.txt');return [t, st.size, st.isFile(), dir.join(','), gone].join('|');})()`) === "hi|2|true|x.txt|false");
  ok("fs.promises.readdir({withFileTypes:true}) -> Dirent[]",
    val(ex, `(async()=>{var fsp=require('fs').promises;await fsp.mkdir('/pd',{recursive:true});await fsp.writeFile('/pd/f','1');var ents=await fsp.readdir('/pd',{withFileTypes:true});return ents[0].name+':'+ents[0].isFile();})()`) === "f:true");
}

// ============================================================================
// (F) use() hardening — an ESM bundle surfaces an actionable error (no opaque SyntaxError).
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  // Mock host.fetch to return ESM-syntax source for the use() call.
  const esmSrc = "export const hello = 42;\nexport default function(){ return hello; }\n";
  const fmEsm = () => ({ ok: true, value: { status: 200, ok: true, statusText: "OK", headers: {}, body: esmSrc, bodyTruncated: false, bodyB64: Buffer.from(esmSrc).toString("base64") } });
  const r = evalCell(ex, `(async()=>{ try { await use('some-esm-pkg'); return 'loaded'; } catch(e){ return e.message; } })()`, { fetchMock: fmEsm });
  ok("use() on an ESM bundle throws an ACTIONABLE error (mentions ES MODULE + esm.sh cjs)",
    r.ok && typeof r.value === "string" && /ES MODULE/.test(r.value) && /\?bundle&cjs/.test(r.value), r);
  // A CJS bundle loads fine via the same path (reads full bytes from bodyB64, not truncated body).
  const cjsSrc = "module.exports = { add: function(a,b){ return a+b; } };";
  const fmCjs = () => ({ ok: true, value: { status: 200, ok: true, statusText: "OK", headers: {}, body: "TRUNCATED-PREVIEW", bodyTruncated: true, bodyB64: Buffer.from(cjsSrc).toString("base64") } });
  ok("use() reads the FULL bundle bytes (bodyB64), not the capped preview",
    val(ex, `(async()=>{ var m = await use('some-cjs-pkg'); return m.add(2,3); })()`, { fetchMock: fmCjs }) === 5);
}

// ============================================================================
// (G) cell RETURN robustness — run THROUGH the glue transform pipeline.
// ============================================================================
{
  const ex = newInst().exports; ex.create(0n, 42n);
  ok("top-level `return 42` cell yields 42 (was SyntaxError)", evalCell(ex, `return 42`, { transform: true }).value === 42);
  ok("top-level `return` of an expression", evalCell(ex, `const x = 20; return x + 1`, { transform: true }).value === 21);
  ok("top-level `return` of an object literal", JSON.stringify(evalCell(ex, `return { a: 1, b: 2 }`, { transform: true }).value) === JSON.stringify({ a: 1, b: 2 }));
  ok("top-level return with preceding statements + await", val(ex, `let n = await Promise.resolve(5); return n * 2`, { transform: true }) === 10);
  ok("early top-level return short-circuits", evalCell(ex, `if (true) { return 'early'; } return 'late'`, { transform: true }).value === "early");
  // NO-REGRESSION: a nested return inside a function must NOT mis-trigger; the trailing expr is the value.
  ok("nested return inside a fn does NOT change completion (trailing expr wins)",
    evalCell(ex, `function f(){ return 99; } f()`, { transform: true }).value === 99);
  ok("trailing-expression completion still works (no return)", evalCell(ex, `const q = 5; q * 3`, { transform: true }).value === 15);
  ok("await trailing-expression completion still works", val(ex, `let m = await Promise.resolve(3); m + 4`, { transform: true }) === 7);
  // return undefined / bare return -> undefined completion (valueType undefined).
  {
    const r = evalCell(ex, `return;`, { transform: true });
    ok("bare top-level `return;` yields undefined", r.ok && r.valueType === "undefined", r);
  }
  ok("__hasTopLevelReturn ignores return in a string", val(ex, `const s = "return 1"; s.length`, { transform: true }) === 8);
}

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
