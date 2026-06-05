// Live: git.clone of a public repo over engram-native fs (VFS) on engram-kernel-ouru.
// ADR-0012 — binary-safe host.fetch unblocks isomorphic-git's packfile transfer.
import WebSocket from "ws";

const BASE = process.env.ENGRAM_BASE || "engram-kernel-ouru.umg-bhalla88.workers.dev";
const SID = "git-live-" + Date.now();

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${SID}`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function rpc(ws, msg, timeoutMs = 120000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + (msg.t))), timeoutMs);
    ws.once("message", (d) => { clearTimeout(t); res(JSON.parse(d.toString())); });
    ws.send(JSON.stringify(msg));
  });
}
const ok = (name, cond, got) =>
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  got=" + JSON.stringify(got).slice(0, 600)));

const ws = await connect();
let r;

// Allowlist GitHub smart-HTTP hosts; load the git stdlib modules (opt-in).
r = await rpc(ws, {
  t: "create",
  config: {
    rngSeed: 7,
    fetch: ["github.com", "codeload.github.com"],
    modules: ["isomorphic-git-http", "isomorphic-git"],
  },
});
ok("create ok", r.ok && r.t === "create", r);

// 1. BINARY-FIDELITY GATE: github.com/favicon.ico is EXACTLY 6518 bytes, no U+FFFD.
const fav = `(async()=>{
  const r = await fetch('https://github.com/favicon.ico');
  const u = new Uint8Array(await r.arrayBuffer());
  // count U+FFFD if we (wrongly) decoded as utf8 — here we read bytes, so report byte length + a checksum.
  let sum = 0; for (let k=0;k<u.length;k++) sum = (sum + u[k]) % 1000000007;
  return { status: r.status, byteLength: u.length, first4: [u[0],u[1],u[2],u[3]], checksum: sum };
})()`;
r = await rpc(ws, { t: "eval", src: fav }, 60000);
const fv = r.value || {};
ok("favicon binary fidelity: exactly 6518 bytes", fv.byteLength === 6518, r.ok ? fv : r);

// 2. git.clone over engram VFS.
const cloneSrc = `(async()=>{
  const fs = require('fs');
  const git = require('isomorphic-git');
  const http = require('isomorphic-git-http');
  await git.clone({ fs, http, dir: '/repo', url: 'https://github.com/octocat/Hello-World.git', singleBranch: true, depth: 1 });
  return { dir: fs.readdirSync('/repo'), readme: fs.readFileSync('/repo/README', 'utf8') };
})()`;
r = await rpc(ws, { t: "eval", src: cloneSrc }, 180000);
console.log("clone result:", JSON.stringify(r).slice(0, 800));
const cv = r.value || {};
ok("clone wrote /repo files", r.ok && Array.isArray(cv.dir) && cv.dir.length > 0, r.ok ? cv.dir : r);
ok("README content === 'Hello World!'", typeof cv.readme === "string" && cv.readme.trim() === "Hello World!", r.ok ? cv.readme : r);

ws.close();
process.exit(0);
