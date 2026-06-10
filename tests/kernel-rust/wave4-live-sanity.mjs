// Raw-WS sanity for the DEPLOYED engram-kernel-ouru (Wave 4):
//   1. (await fetch('https://api.github.com/repos/octocat/Hello-World')).json()
//      returns an object whose .description is the real repo description
//      (real WHATWG Response.json over the binary-safe host.fetch).
//   2. process.platform === 'linux' (process shim).
//   3. a top-level `return 1+1` cell completes to 2 (top-level-return support).
// Mirrors git-clone-live.mjs / wave2-live-sanity.mjs WS protocol.
import WebSocket from "ws";

const BASE = process.env.ENGRAM_BASE || "engram-kernel-ouru.umg-bhalla88.workers.dev";
const SID = "wave4-live-" + Date.now();

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

// Allowlist the GitHub API host so host.fetch can reach it.
r = await rpc(ws, { t: "create", config: { rngSeed: 7, fetch: ["api.github.com"] } });
ok("create ok", r.ok && r.t === "create", r);

// 1. REAL Response.json() over host.fetch -> .description.
//    NOTE: api.github.com 403s a User-Agent-less request with a NON-JSON body
//    ("Request forbidden ... User-Agent header"), so .json() would throw a
//    SyntaxError on GitHub's error page — set a UA so we exercise the happy path.
const fetchSrc = `(async()=>{
  const res = await fetch('https://api.github.com/repos/octocat/Hello-World', { headers: { 'User-Agent': 'engram-ouru', 'Accept': 'application/vnd.github+json' } });
  const isResp = res instanceof Response;
  const status = res.status;
  const body = await res.json();
  return { isResp, status, isObj: (body !== null && typeof body === 'object'), description: body.description, name: body.name };
})()`;
r = await rpc(ws, { t: "eval", src: fetchSrc }, 60000);
const fv = r.value || {};
ok("fetch().json() returns a Response then a plain object", r.ok && fv.isResp === true && fv.isObj === true, r.ok ? fv : r);
ok("Response.json().description is the real repo description",
  r.ok && typeof fv.description === "string" && fv.description.length > 0, r.ok ? fv : r);
console.log("    -> description =", JSON.stringify(fv.description), "| name =", JSON.stringify(fv.name), "| status =", fv.status);

// 2. process.platform === 'linux'.
r = await rpc(ws, { t: "eval", src: `({ platform: process.platform, version: process.version })` });
const pv = r.value || {};
ok("process.platform === 'linux'", r.ok && pv.platform === "linux", r.ok ? pv : r);
console.log("    -> process.version =", JSON.stringify(pv.version));

// 3. top-level `return 1+1` -> 2.
r = await rpc(ws, { t: "eval", src: `return 1+1` });
ok("top-level `return 1+1` completes to 2", r.ok && r.value === 2, r);

ws.close();
console.log(`\n${passed}/${passed + failed} PASS`);
process.exit(failed ? 1 : 0);
