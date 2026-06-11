// EXTENSIBILITY API — REDUCED Phase 1 (#32) live verify against engram-kernel.
// Auth-aware (?apiKey). Client handler answers {t:hostcall} frames for client-backend tools.
import WebSocket from "ws";
const BASE = process.env.ENGRAM_BASE || "engram-kernel.umg-bhalla88.workers.dev";
const KEY = process.env.ENGRAM_KERNEL_KEY || "";
let passed = 0, failed = 0;
const ok = (n, c, got) => { console.log((c?"PASS":"FAIL")+"  "+n+(c?"":"  got="+JSON.stringify(got).slice(0,500))); c?passed++:failed++; };

// Connect with an embedded {t:hostcall} client handler. `onHostcall(name,args)->value`.
function connectClient(id, onHostcall) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${id}&apiKey=${KEY}`);
    ws._hcLog = [];
    ws.on("message", (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.t === "hostcall") {
        ws._hcLog.push({ name: m.name, args: m.args });
        Promise.resolve().then(() => onHostcall(m.name, m.args)).then(
          (value) => ws.send(JSON.stringify({ t: "hostcall-result", id: m.id, ok: true, value })),
          (e) => ws.send(JSON.stringify({ t: "hostcall-result", id: m.id, ok: false, error: String(e && e.message || e) }))
        );
        return;
      }
      // non-hostcall: deliver to the pending rpc resolver
      if (ws._rpc) { const r = ws._rpc; ws._rpc = null; clearTimeout(r.t); r.res(m); }
    });
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function rpc(ws, msg, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { ws._rpc = null; rej(new Error("timeout " + msg.t)); }, timeoutMs);
    ws._rpc = { res, t };
    ws.send(JSON.stringify(msg));
  });
}

const SID = "extp1-" + Date.now();

// client handler: echo args back for mytool.echo; for any other name throw.
const handler = (name, args) => {
  if (name === "mytool.echo") return { echoedName: name, echoedArgs: args };
  throw new Error("no handler for " + name);
};

let ws = await connectClient(SID, handler);
let r;

// --- create with a client-backend extension ---
const cfg = {
  rngSeed: 7,
  extensions: [{
    name: "mytool",
    version: "1.0.0",
    backend: { kind: "client" },
    tools: [{ fn: "echo", description: "echoes its args", params: { hi: "number" }, example: { hi: 1 } }],
    limits: { callsPerCell: 8, maxResultBytes: 1024 },
  }],
};
r = await rpc(ws, { t: "create", config: cfg });
ok("create ok with client ext", r.ok === true && r.t === "create", r);

// --- 1. host.mytool.echo({hi:42}) routes to client + VM gets echoed result ---
ws._hcLog.length = 0;
r = await rpc(ws, { t: "eval", src: `await host.mytool.echo({hi:42})` }, 30000);
const v = r.value || {};
ok("ext client tool invoked: client saw name 'mytool.echo'", ws._hcLog.length === 1 && ws._hcLog[0].name === "mytool.echo", ws._hcLog);
ok("ext client tool: client saw args [{hi:42}]", JSON.stringify(ws._hcLog[0] && ws._hcLog[0].args) === JSON.stringify([{hi:42}]), ws._hcLog[0]);
ok("ext client tool: VM got echoed result", r.ok === true && v.echoedName === "mytool.echo" && JSON.stringify(v.echoedArgs) === JSON.stringify([{hi:42}]), r);
console.log("    -> echoed value =", JSON.stringify(v));

// --- 2. __extMeta present + correct ---
r = await rpc(ws, { t: "eval", src: `JSON.stringify(globalThis.__extMeta)` });
let meta = null; try { meta = JSON.parse(r.value); } catch {}
ok("__extMeta present, lists mytool/echo+description", r.ok && Array.isArray(meta) && meta[0] && meta[0].name === "mytool" && meta[0].tools[0].fn === "echo" && meta[0].tools[0].description === "echoes its args", r.value);
console.log("    -> __extMeta =", JSON.stringify(meta));

// --- callsPerCell enforcement (limit 8): 9 calls in one cell -> typed error ---
ws._hcLog.length = 0;
r = await rpc(ws, { t: "eval", src: `let last; for (let i=0;i<9;i++){ last = await host.mytool.echo({i}); } last`, }, 30000);
ok("callsPerCell exceeded -> rejected (typed)", r.ok === false && /ExtCallLimit|callsPerCell/i.test(JSON.stringify(r.error||r.value||r)), r);
console.log("    -> 9-call err =", JSON.stringify(r.error||r.value));

// --- maxResultBytes clamp (limit 1024): echo a 3KB arg -> clamped marker ---
ws._hcLog.length = 0;
r = await rpc(ws, { t: "eval", src: `const big = 'x'.repeat(3000); const out = await host.mytool.echo({big}); ({clamped: out && out.__extResultClamped===true, marker: out})`, }, 30000);
ok("oversized result clamped (>maxResultBytes 1024)", r.ok === true && r.value && r.value.clamped === true, r);
console.log("    -> clamp marker =", JSON.stringify(r.value && r.value.marker));

// --- deny-by-default: unregistered host.nope.x -> rejected (no handler) ---
r = await rpc(ws, { t: "eval", src: `try { await host['nope.x'](); 'NOREJECT' } catch(e){ 'REJECTED:'+e.message }`, }, 30000);
ok("unregistered host.nope.x rejected", r.ok === true && typeof r.value === "string" && r.value.startsWith("REJECTED"), r);
console.log("    -> nope.x =", JSON.stringify(r.value));

ws.close();

// --- 3. COLD RESTORE: evict, reconnect, __extMeta + namespace survive ---
r = await (async () => {
  const w2 = await connectClient(SID, handler);
  const ev = await rpc(w2, { t: "evict" });
  w2.close();
  return ev;
})();
ok("evict dropped in-memory", r.ok === true, r);

let ws3 = await connectClient(SID, handler);
// gen to confirm cold (inMemory false)
r = await rpc(ws3, { t: "gen" });
const coldGen = r.generation;
ok("post-evict gen reports cold (inMemory false)", r.ok && r.inMemory === false, r);
// __extMeta survives cold restore
r = await rpc(ws3, { t: "eval", src: `JSON.stringify(globalThis.__extMeta)` }, 30000);
let meta3 = null; try { meta3 = JSON.parse(r.value); } catch {}
ok("__extMeta survives cold restore", r.ok && Array.isArray(meta3) && meta3[0] && meta3[0].name === "mytool" && meta3[0].tools[0].fn === "echo", r.value);
console.log("    -> __extMeta(cold) =", JSON.stringify(meta3));
// host.mytool.echo still callable post-restore
ws3._hcLog.length = 0;
r = await rpc(ws3, { t: "eval", src: `await host.mytool.echo({after:'restore'})` }, 30000);
ok("host.mytool.echo callable post cold restore", r.ok === true && r.value && r.value.echoedName === "mytool.echo" && JSON.stringify(r.value.echoedArgs)===JSON.stringify([{after:'restore'}]), r);
console.log("    -> post-restore echo =", JSON.stringify(r.value));
ws3.close();

// --- 4. http backend rejected at create ---
{
  const w = await connectClient("extp1-http-" + Date.now(), handler);
  const rr = await rpc(w, { t: "create", config: { extensions: [{ name: "evil", backend: { kind: "http", url: "https://x" }, tools: [{ fn: "go" }] }] } });
  ok("http backend rejected at create (typed)", rr.ok === false && /ExtBackendError|not supported|http/i.test(JSON.stringify(rr.error||rr)), rr);
  console.log("    -> http reject =", JSON.stringify(rr.error||rr));
  w.close();
}
// --- shadowing built-in name 'fetch' rejected ---
{
  const w = await connectClient("extp1-fetch-" + Date.now(), handler);
  const rr = await rpc(w, { t: "create", config: { extensions: [{ name: "fetch", backend: { kind: "client" }, tools: [{ fn: "x" }] }] } });
  ok("name 'fetch' (built-in shadow) rejected", rr.ok === false && /shadow|ExtConfigError/i.test(JSON.stringify(rr.error||rr)), rr);
  console.log("    -> fetch reject =", JSON.stringify(rr.error||rr));
  w.close();
}
// --- __-prefixed name rejected ---
{
  const w = await connectClient("extp1-dunder-" + Date.now(), handler);
  const rr = await rpc(w, { t: "create", config: { extensions: [{ name: "__x", backend: { kind: "client" }, tools: [{ fn: "y" }] }] } });
  ok("name '__x' (__-prefixed) rejected", rr.ok === false && /__-prefixed|ExtConfigError/i.test(JSON.stringify(rr.error||rr)), rr);
  console.log("    -> __x reject =", JSON.stringify(rr.error||rr));
  w.close();
}

console.log(`\nEXT-P1: ${passed}/${passed+failed} PASS`);
process.exit(failed ? 1 : 0);
