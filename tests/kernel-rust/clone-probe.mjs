// Raw-WS clone probe: reproduces ouru's clone workload WITHOUT the LLM.
// Tests git.clone -> readdir -> readFile -> full-tree-walk -> 1+1 under varied create-configs.
// Usage: ENGRAM_BASE=<host> CONFIG=<name> node clone-probe.mjs
import WebSocket from "ws";

const BASE = process.env.ENGRAM_BASE || "engram-kernel-ouru.umg-bhalla88.workers.dev";

// Target repo: snoopysecurity/Vulnerable-Code-Snippets (the ouru workload repo).
const REPO_URL = "https://github.com/snoopysecurity/Vulnerable-Code-Snippets.git";
const DIR = "/workspace/repo";

// Config matrix.
const CONFIGS = {
  // baseline that already works in git-clone-live.mjs
  "modules+allowlist": { rngSeed: 7, fetch: ["github.com", "codeload.github.com"], modules: ["isomorphic-git-http", "isomorphic-git"] },
  // fetch=true (allow all) instead of explicit allowlist
  "modules+fetchTrue": { rngSeed: 7, fetch: true, modules: ["isomorphic-git-http", "isomorphic-git"] },
  // explicit allowlist WITH githubusercontent + codeload extras
  "modules+allowlistFull": { rngSeed: 7, fetch: ["github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"], modules: ["isomorphic-git-http", "isomorphic-git"] },
  // fetch=false (should block clone)
  "modules+fetchFalse": { rngSeed: 7, fetch: false, modules: ["isomorphic-git-http", "isomorphic-git"] },
  // NO modules (should fail: require('isomorphic-git') missing)
  "noModules+allowlist": { rngSeed: 7, fetch: ["github.com", "codeload.github.com"] },
  // bare minimum: just modules, default fetch (undefined => true)
  "modulesOnly": { rngSeed: 7, modules: ["isomorphic-git-http", "isomorphic-git"] },
};

function connect(sid) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${sid}&apiKey=${process.env.ENGRAM_KERNEL_KEY||""}`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
// rpc that demuxes hostcall frames (ignores them; the DO services fetch itself for host.fetch,
// but client host-callbacks would arrive as {t:hostcall} — clone uses host.fetch (DO-side) so
// none expected, but we demux defensively and only resolve on the matching reply type).
function rpc(ws, msg, timeoutMs = 180000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + msg.t)), timeoutMs);
    const onMsg = (d) => {
      let p;
      try { p = JSON.parse(d.toString()); } catch { return; }
      if (p && p.t === "hostcall") return; // ignore; DO handles fetch
      clearTimeout(t);
      ws.off("message", onMsg);
      res(p);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify(msg));
  });
}

const cfgName = process.env.CONFIG || "modules+allowlist";
const config = CONFIGS[cfgName];
if (!config) { console.error("unknown CONFIG:", cfgName, "options:", Object.keys(CONFIGS)); process.exit(2); }

const sid = `clone-probe-${cfgName.replace(/[^a-z0-9]/gi, "")}-${Date.now()}`;
console.log(`\n=== CONFIG '${cfgName}' on ${BASE} (sid=${sid}) ===`);
console.log("config:", JSON.stringify(config));

const ws = await connect(sid);
let r;

r = await rpc(ws, { t: "create", config }, 60000);
console.log(`create: ok=${r.ok} t=${r.t}` + (r.ok ? "" : " err=" + JSON.stringify(r).slice(0, 300)));

const cells = [
  {
    name: "cell1 git.clone depth1 singleBranch",
    src: `(async()=>{
      const fs = require('fs');
      const git = require('isomorphic-git');
      const http = require('isomorphic-git-http');
      await git.clone({ fs, http, dir: ${JSON.stringify(DIR)}, url: ${JSON.stringify(REPO_URL)}, singleBranch: true, depth: 1 });
      return { cloned: true };
    })()`,
    timeout: 180000,
  },
  {
    name: "cell2 readdirSync(repo)",
    src: `require('fs').readdirSync(${JSON.stringify(DIR)})`,
  },
  {
    name: "cell3 readFileSync(README or first file)",
    src: `(()=>{
      const fs = require('fs');
      const entries = fs.readdirSync(${JSON.stringify(DIR)});
      // pick README* if present else first non-.git entry
      let pick = entries.find(e => /^readme/i.test(e)) || entries.find(e => e !== '.git') || entries[0];
      const path = ${JSON.stringify(DIR)} + '/' + pick;
      const st = fs.statSync(path);
      if (st.isDirectory()) return { pick, isDir: true, len: 0 };
      const data = fs.readFileSync(path, 'utf8');
      return { pick, len: data.length, head: data.slice(0, 80) };
    })()`,
  },
  {
    name: "cell4 walk whole tree, read every .js",
    src: `(()=>{
      const fs = require('fs');
      function walk(dir) {
        let out = [];
        for (const e of fs.readdirSync(dir)) {
          if (e === '.git') continue;
          const p = dir + '/' + e;
          const st = fs.statSync(p);
          if (st.isDirectory()) out = out.concat(walk(p));
          else out.push(p);
        }
        return out;
      }
      const all = walk(${JSON.stringify(DIR)});
      const js = all.filter(p => p.endsWith('.js'));
      let totalBytes = 0;
      for (const p of js) { totalBytes += fs.readFileSync(p, 'utf8').length; }
      return { totalFiles: all.length, jsFiles: js.length, jsBytes: totalBytes };
    })()`,
    timeout: 120000,
  },
  {
    name: "cell5 trivial 1+1",
    src: `1+1`,
  },
];

const results = [];
for (const c of cells) {
  const start = Date.now();
  let rr;
  try {
    rr = await rpc(ws, { t: "eval", src: c.src }, c.timeout || 60000);
  } catch (e) {
    rr = { ok: false, error: { message: String(e.message || e) }, _wsError: true };
  }
  const ms = Date.now() - start;
  const errStr = rr.ok ? null : (typeof rr.error === "string" ? rr.error : JSON.stringify(rr.error || rr).slice(0, 400));
  const logs = (rr.logs || []).map(l => l.msg).filter(Boolean);
  results.push({ name: c.name, ok: !!rr.ok, evalMs: rr.evalMs ?? ms, wallMs: ms, error: errStr, value: rr.value, logs });
  console.log(`  ${rr.ok ? "PASS" : "FAIL"}  ${c.name}  (${ms}ms)` +
    (rr.ok ? "  value=" + JSON.stringify(rr.value).slice(0, 200)
           : "  ERR=" + errStr) +
    (logs.length ? "  logs=" + JSON.stringify(logs).slice(0, 200) : ""));
}

const allOk = results.every(r => r.ok);
console.log(`\nRESULT[${cfgName}]: ${allOk ? "ALL PASS (clone->walk->read->1+1, zero traps)" : "FAIL"}`);

ws.close();
process.exit(allOk ? 0 : 1);
