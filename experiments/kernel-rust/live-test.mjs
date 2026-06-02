// Live functional test against the deployed engram-rust worker over WebSocket.
import WebSocket from "ws";

const BASE = "engram-rust.umg-bhalla88.workers.dev";
const SID = "rust-live-" + Date.now();

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${SID}`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function rpc(ws, msg) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + JSON.stringify(msg))), 30000);
    ws.once("message", (d) => {
      clearTimeout(t);
      res(JSON.parse(d.toString()));
    });
    ws.send(JSON.stringify(msg));
  });
}

const results = [];
const ok = (name, cond, got) => {
  results.push({ name, pass: !!cond, got });
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  got=" + JSON.stringify(got)));
};

let ws = await connect();
let r;

r = await rpc(ws, { t: "create", config: { rngSeed: 7, fetch: ["example.com"] } });
ok("create ok", r.ok && r.t === "create", r);

r = await rpc(ws, { t: "eval", src: "1+2*3" });
ok("arith value=7", r.value === 7 && r.valueType === "number", r);

r = await rpc(ws, { t: "eval", src: "new Map([['a',1],['b',2]])" });
ok("map preview", r.valuePreview && r.valuePreview.includes("Map(2)") && r.valuePreview.includes("=>"), r.valuePreview);

r = await rpc(ws, { t: "eval", src: "new Set([1,2,3])" });
ok("set preview", r.valuePreview && r.valuePreview.includes("Set(3)"), r.valuePreview);

r = await rpc(ws, { t: "eval", src: "new Date(1700000000000)" });
ok("date preview", r.valuePreview && r.valuePreview.includes("2023"), r.valuePreview);

r = await rpc(ws, { t: "eval", src: "/ab+c/gi" });
ok("regex preview", r.valuePreview === "/ab+c/gi", r.valuePreview);

r = await rpc(ws, { t: "eval", src: "throw new TypeError('boom')" });
ok("error frame", r.ok === false && r.error && r.error.name === "TypeError", r.error);

r = await rpc(ws, { t: "eval", src: "console.log('hi', {a:1}); 42" });
ok("console capture + value", r.value === 42 && r.logs && r.logs.length === 1, { logs: r.logs, value: r.value });

// determinism (seeded)
const a1 = (await rpc(ws, { t: "eval", src: "Math.random()" })).value;
const d1 = (await rpc(ws, { t: "eval", src: "Date.now()" })).value;
ok("clock seeded epoch", typeof d1 === "number" && d1 >= 1700000000000, d1);

// stateful multi-cell
await rpc(ws, { t: "eval", src: "globalThis.x = 42;" });
await rpc(ws, { t: "eval", src: "let _n=100; globalThis.inc=function(){_n+=1;return _n;};" });
r = await rpc(ws, { t: "eval", src: "globalThis.inc()" });
ok("stateful inc=101", r.value === 101, r);
r = await rpc(ws, { t: "eval", src: "globalThis.inc()" });
ok("stateful inc=102", r.value === 102, r);

// pending promise across the cells
await rpc(ws, { t: "eval", src: "globalThis.pr=null; globalThis.p=new Promise(rs=>{globalThis._res=()=>rs(7);}); globalThis.p.then(v=>{globalThis.pr=v;});" });

// host.kv (in-engine, persisted)
await rpc(ws, { t: "eval", src: "await host.kv('set','k1','v1')" });
r = await rpc(ws, { t: "eval", src: "await host.kv('get','k1')" });
ok("host.kv roundtrip", r.value === "v1", r);

// host.fetch allowlist BLOCK (example.org not in list)
r = await rpc(ws, { t: "eval", src: "await host.fetch('https://example.org/')" });
ok("fetch blocked typed", r.ok === false && r.error && /FetchBlocked/i.test(r.error.message || ""), r.error);

// host.fetch allowlist ALLOW (example.com in list)
r = await rpc(ws, { t: "eval", src: "(await host.fetch('https://example.com/')).status" });
ok("fetch allowed -> status", r.value === 200 || r.value === 301 || r.value === 302, r);

// GUARD: infinite loop -> TimeoutError, socket alive
r = await rpc(ws, { t: "eval", src: "var s=0; while(true){s++;} s", });
ok("loop -> TimeoutError", r.ok === false && r.error && r.error.name === "TimeoutError", r.error);
r = await rpc(ws, { t: "eval", src: "1+1" });
ok("recover after loop", r.value === 2, r);

// GUARD: buffer-growth bomb -> MemoryLimitError, socket alive
r = await rpc(ws, { t: "eval", src: "let a=[]; while(true){a.push(new Array(100000).fill(7));}" });
ok("array bomb -> guard tripped", r.ok === false && r.error && (r.error.name === "MemoryLimitError" || r.error.name === "TimeoutError"), r.error);
r = await rpc(ws, { t: "eval", src: "40+2" });
ok("recover after bomb", r.value === 42, r);

// gen before evict
r = await rpc(ws, { t: "gen" });
const gen1 = r.generation;
ok("gen inMemory", r.inMemory === true, r);

// EVICT -> cold restore (the thesis)
await rpc(ws, { t: "evict" });
r = await rpc(ws, { t: "gen" });
ok("evicted inMemory=false", r.inMemory === false, r);

// reconnect (force a fresh DO context isn't possible without real eviction, but evict drops the in-memory glue)
r = await rpc(ws, { t: "eval", src: "globalThis.inc()" });
ok("cold-restore inc=103", r.value === 103 && r.restoreSource && r.restoreSource.includes("restore"), { v: r.value, src: r.restoreSource });
r = await rpc(ws, { t: "eval", src: "globalThis.x" });
ok("cold-restore x=42", r.value === 42, r);

// pending promise survived restore + resolves
await rpc(ws, { t: "eval", src: "globalThis._res();" });
r = await rpc(ws, { t: "eval", src: "globalThis.pr" });
ok("pending promise survived restore", r.value === 7, r);

// host.kv survived restore
r = await rpc(ws, { t: "eval", src: "await host.kv('get','k1')" });
ok("host.kv survived restore", r.value === "v1", r);

ws.close();

const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
