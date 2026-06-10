// Raw-WS sanity for the DEPLOYED engram-kernel-ouru: the Wave-2 Node shims
// (crypto.createHash, zlib gzip round-trip, url.parse) must work on the LIVE
// kernel exactly as they do in-VM. Mirrors git-clone-live.mjs's WS protocol.
import WebSocket from "ws";

const BASE = process.env.ENGRAM_BASE || "engram-kernel-ouru.umg-bhalla88.workers.dev";
const SID = "wave2-live-" + Date.now();

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${SID}&apiKey=${process.env.ENGRAM_KERNEL_KEY||""}`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function rpc(ws, msg, timeoutMs = 60000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + msg.t)), timeoutMs);
    ws.once("message", (d) => { clearTimeout(t); res(JSON.parse(d.toString())); });
    ws.send(JSON.stringify(msg));
  });
}
let passed = 0, failed = 0;
const ok = (name, cond, got) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  got=" + JSON.stringify(got).slice(0, 600)));
  cond ? passed++ : failed++;
};

const ws = await connect();
let r;

r = await rpc(ws, { t: "create", config: { rngSeed: 7 } });
ok("create ok", r.ok && r.t === "create", r);

// 1. const crypto=require('crypto'); crypto.createHash('sha256') of 'abc'.
//    THE shadow-bug regression: a top-level `const crypto = require('crypto')`
//    must NOT shadow the host crypto into infinite recursion, and the digest
//    must equal the known SHA-256 vector for 'abc'.
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const cryptoSrc = `
const crypto = require('crypto');
const h = crypto.createHash('sha256').update('abc').digest('hex');
h;`;
r = await rpc(ws, { t: "eval", src: cryptoSrc });
ok("const crypto=require('crypto') sha256('abc') === known vector", r.ok && r.value === SHA_ABC, r.ok ? r.value : r);

// 1b. randomBytes after a top-level const crypto = require('crypto') must not recurse.
const rbSrc = `
const crypto = require('crypto');
const b = crypto.randomBytes(16);
({ len: b.length, isBuf: Buffer.isBuffer(b) });`;
r = await rpc(ws, { t: "eval", src: rbSrc });
ok("crypto.randomBytes(16) -> 16-byte Buffer (no shadow recursion)", r.ok && r.value && r.value.len === 16 && r.value.isBuf === true, r.ok ? r.value : r);

// 2. require('zlib') gzip -> gunzip round-trip.
const zlibSrc = `
const zlib = require('zlib');
const input = 'the quick brown fox '.repeat(50);
const gz = zlib.gzipSync(Buffer.from(input));
const backBuf = zlib.gunzipSync(gz);
const back = Buffer.from(backBuf).toString('utf8');
({ ok: back === input, gzLen: gz.length, inLen: input.length, backLen: back.length, roundTrip: back.slice(0,20) });`;
r = await rpc(ws, { t: "eval", src: zlibSrc });
ok("zlib gzipSync->gunzipSync round-trip", r.ok && r.value && r.value.ok === true, r.ok ? r.value : r);
ok("zlib actually compressed (gzLen < inLen)", r.ok && r.value && r.value.gzLen < r.value.inLen, r.ok ? r.value : r);

// 3. require('url').parse fields.
const urlSrc = `
const url = require('url');
const u = url.parse('https://example.com:8443/a/b?x=1&y=2#frag');
({ host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, query: u.query, hash: u.hash });`;
r = await rpc(ws, { t: "eval", src: urlSrc });
const uv = r.value || {};
ok("url.parse host/hostname/port", r.ok && uv.host === "example.com:8443" && uv.hostname === "example.com" && uv.port === "8443", r.ok ? uv : r);
ok("url.parse pathname/query", r.ok && uv.pathname === "/a/b" && uv.query === "x=1&y=2", r.ok ? uv : r);

ws.close();
console.log(`\n${passed}/${passed + failed} PASS`);
process.exit(failed ? 1 : 0);
