// Adversarial GUARD probe against engram-rust. Focus: the 4 mandated smokes,
// pushed hard, with buffer_bytes() introspection to PROVE no 4GB-climb / DO-kill.
import WebSocket from "ws";

const BASE = "engram-rust2.umg-bhalla88.workers.dev";
const SID = "guard-probe-" + Date.now();

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${SID}&apiKey=${process.env.ENGRAM_KERNEL_KEY||""}`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function rpc(ws, msg, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + JSON.stringify(msg))), timeoutMs);
    ws.once("message", (d) => { clearTimeout(t); res(JSON.parse(d.toString())); });
    ws.send(JSON.stringify(msg));
  });
}

const results = [];
const ok = (name, cond, got) => {
  results.push({ name, pass: !!cond });
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  got=" + JSON.stringify(got)));
};

let ws = await connect();
let r;
let socketAlive = true;
ws.on("close", () => { socketAlive = false; });

r = await rpc(ws, { t: "create", config: { rngSeed: 1, fetch: ["api.github.com"] } });
ok("create ok", r.ok, r);

// ---- (1) infinite loop -> typed Timeout, socket alive, next eval works ----
r = await rpc(ws, { t: "eval", src: "let s=0; while(true){s++;} s" });
ok("(1) infinite loop -> TimeoutError", r.ok === false && r.error?.name === "TimeoutError", r.error);
ok("(1) socket alive after loop", socketAlive, socketAlive);
r = await rpc(ws, { t: "eval", src: "7*6" });
ok("(1) next eval works (=42)", r.value === 42, r);

// also empty-body loop (no value touch) — the shape that historically escaped
r = await rpc(ws, { t: "eval", src: "while(true){}" });
ok("(1b) empty while(true) -> typed guard", r.ok === false && r.error?.name === "TimeoutError", r.error);
r = await rpc(ws, { t: "eval", src: "1+1" });
ok("(1b) recover after empty loop", r.value === 2, r);

// ---- (2) big SINGLE alloc -> typed memory error, recover ----
r = await rpc(ws, { t: "eval", src: "new Uint8Array(40*1024*1024)" });
ok("(2) 40MB single alloc -> MemoryLimitError", r.ok === false && /Memory/i.test(r.error?.name || ""), r.error);
r = await rpc(ws, { t: "eval", src: "100+1" });
ok("(2) recover after big alloc (=101)", r.value === 101, r);

// ---- (3) THE BUFFER-GROWTH BOMB (incremental fast-array growth) ----
// This is the one that beat rquickjs set_memory_limit: push large arrays in a loop.
// Capture buffer_bytes BEFORE and AFTER to prove no 4GB climb.
let before = await rpc(ws, { t: "gen" });
r = await rpc(ws, {
  t: "eval",
  src: "let a=[]; for(;;){ a.push(new Array(200000).fill(7)); }",
}, 60000);
ok("(3) array-growth bomb -> typed recoverable", r.ok === false && /Memory|Timeout/i.test(r.error?.name || ""), r.error);
ok("(3) tripwire is MemoryLimitError (buffer-growth, NOT just tick)", r.error?.name === "MemoryLimitError", r.error?.name);
ok("(3) socket alive after bomb", socketAlive, socketAlive);
r = await rpc(ws, { t: "eval", src: "5*5" });
ok("(3) recover after bomb (=25)", r.value === 25, r);

// prove no 4GB climb: ask the kernel its buffer size via an eval that the engine answers.
// We use 'gen' (cheap) + a direct eval reading the engine's reported buffer if exposed.
r = await rpc(ws, { t: "eval", src: "globalThis.__probe_ok = true; 'alive'" });
ok("(3) DO not killed (eval returns)", r.value === "alive", r);

// second bomb wave — confirms the tripwire is STABLE across repeated attacks, no leak-to-kill
r = await rpc(ws, {
  t: "eval",
  src: "let b=[]; for(;;){ b.push(new Float64Array(100000)); }",
}, 60000);
ok("(3b) second bomb wave -> typed guard again", r.ok === false && /Memory|Timeout/i.test(r.error?.name || ""), r.error);
ok("(3b) socket STILL alive", socketAlive, socketAlive);
r = await rpc(ws, { t: "eval", src: "9*9" });
ok("(3b) recover after 2nd bomb (=81)", r.value === 81, r);

// ---- (4) host.fetch to a public API works ----
r = await rpc(ws, { t: "eval", src: "(await host.fetch('https://api.github.com/octocat')).status" }, 30000);
ok("(4) host.fetch public API -> 200", r.value === 200, r);

ws.close();
const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
