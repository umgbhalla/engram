// LOCAL E2E for REPL completion-value semantics, especially TOP-LEVEL-AWAIT cells.
//
// REGRESSION GUARD for the "await loop returns undefined" bug: the engine runs an await-using
// multi-statement cell as an async function BODY (no completion value), so a trailing expression
// after a loop/block was silently DISCARDED -> the cell returned undefined and an agent/await
// loop looked like it "didn't converge". The host-side wrapAsyncCompletion transform
// (apps/kernel/src/repl-transform.ts) rewrites that trailing expression into `return ( … )`.
//
// Boots wrangler dev with the no-rebuild dev config (build once, then reuse), connects a WS
// client that binds a host.subLM stub, and asserts the completion value of a range of cell
// shapes — await/no-await, trailing-expr/trailing-semicolon, loop/if/template, declarations.
//
// Run: node tests/kernel-rust/completion-local.mjs   (ENGRAM_SKIP_BUILD=1 to reuse artifacts)
import { spawn, execSync } from "node:child_process";
import { WebSocket } from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const kernelDir = resolve(here, "../../apps/kernel");
const PORT = 8801;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "  got=" + JSON.stringify(extra)); }
}

// WS client with the persistent hostcall demux (mirrors @engram/sdk WsTransport).
function makeClient(url, hostFns) {
  const ws = new WebSocket(url);
  let inflight = null;
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg && msg.t === "hostcall") {
      const fn = hostFns[msg.name];
      Promise.resolve()
        .then(() => (fn ? fn(...(msg.args || [])) : Promise.reject(new Error("no host fn " + msg.name))))
        .then(
          (value) => ws.send(JSON.stringify({ t: "hostcall-result", id: msg.id, ok: true, value })),
          (err) => ws.send(JSON.stringify({ t: "hostcall-result", id: msg.id, ok: false, error: String(err && err.message || err) })),
        );
      return;
    }
    if (inflight) { clearTimeout(inflight.timer); const { resolve } = inflight; inflight = null; resolve(msg); }
  });
  return {
    ws,
    open: () => new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); }),
    rpc: (frame, timeoutMs = 20000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => { inflight = null; reject(new Error("rpc timeout")); }, timeoutMs);
        inflight = { resolve, reject, timer };
        ws.send(JSON.stringify(frame));
      }),
    close: () => ws.close(),
  };
}

// ---- build once, then boot dev with the no-rebuild config ----
if (!process.env.ENGRAM_SKIP_BUILD) {
  console.log("[completion-local] building kernel once (skip with ENGRAM_SKIP_BUILD=1) ...");
  execSync(
    "bun x tsc -p tsconfig.json && node scripts/build-ts.ts && node scripts/build-engine.ts && node scripts/engine-hash.ts && worker-build --release",
    { cwd: kernelDir, stdio: "inherit" },
  );
}
console.log("[completion-local] starting wrangler dev (no-rebuild) on :" + PORT + " ...");
const dev = spawn(
  "bun",
  ["x", "wrangler@^4", "dev", "-c", "wrangler.dev.jsonc", "--port", String(PORT), "--local", "--ip", "127.0.0.1"],
  { cwd: kernelDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
);
let devLog = "";
dev.stdout.on("data", (d) => { devLog += d.toString(); });
dev.stderr.on("data", (d) => { devLog += d.toString(); });

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return true; } catch { /* not up */ }
    await delay(500);
  }
  return false;
}

let exitCode = 1;
try {
  const ready = await waitReady(120000);
  if (!ready) { console.log("FAIL  wrangler dev did not become ready\n" + devLog.slice(-2000)); throw new Error("no-ready"); }
  console.log("[completion-local] ready.");

  const c = makeClient(`ws://127.0.0.1:${PORT}/ws?id=cv-${Date.now()}`, {
    subLM: async (p) => "LM<" + p + ">",
  });
  await c.open();
  let r = await c.rpc({ t: "create", config: { rngSeed: 7 } });
  ok("create ok", r.ok && r.t === "create", r);

  const evalVal = async (src) => (await c.rpc({ t: "eval", src })).value;
  const evalRes = async (src) => c.rpc({ t: "eval", src });

  // The core regression: an await loop with a trailing expression returns that expression.
  {
    const v = await evalVal("let m='s',p=null,i=0; while(m!==p&&i<3){p=m;m=await host.subLM(m);i++;} ({m,i})");
    ok("await loop trailing expr converges", v && v.i === 3 && v.m === "LM<LM<LM<s>>>", v);
  }

  // No-regression matrix.
  ok("no-await trailing expr", (await evalVal("let q=5; q*2")) === 10);
  ok("await single expr", (await evalVal("await Promise.resolve(7)")) === 7);
  ok("await assign no trailing -> assigned value", (await evalVal("globalThis.r2 = await host.subLM('q')")) === "LM<q>");
  {
    const v = await evalVal("let v=await host.subLM('x'); if(v){} ({v})");
    ok("await if trailing object expr", v && v.v === "LM<x>", v);
  }
  ok("await for-loop trailing identifier",
    (await evalVal("globalThis.acc=0; for(let k=0;k<3;k++){acc+=await Promise.resolve(k);} acc")) === 3);
  ok("await template trailing expr", (await evalVal("let nm=await host.subLM('z'); `got:${nm}`")) === "got:LM<z>");

  // Trailing SEMICOLON after an await statement => intentional statement => undefined (NOT wrapped).
  r = await evalRes("let z=await host.subLM('a'); z.length;");
  ok("await trailing-semicolon is undefined (not mis-wrapped)", r.ok === true && r.valueType === "undefined", r);

  // Declarations still persist across cells (transformCell unaffected by the new pass).
  await evalVal("let keep=99");
  ok("let declaration persists across cells", (await evalVal("keep")) === 99);
  ok("async global write persists", (await evalVal("acc")) === 3);

  c.close();
  exitCode = fail ? 1 : 0;
} catch (e) {
  console.log("ERROR " + (e && e.stack || e));
  exitCode = 1;
} finally {
  dev.kill("SIGTERM");
  await delay(500);
  try { dev.kill("SIGKILL"); } catch { /* ignore */ }
}

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(exitCode);
