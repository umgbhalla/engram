// The 5 required PARITY tests vs JS-kernel behavior. Filters non-reply frames
// (checkpoint / async / log-only) and matches the reply by request type.
import WebSocket from "ws";

const BASE = "engram-rust.umg-bhalla88.workers.dev";
const SID = "parity5-" + Date.now();

function connect(id = SID) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${id}`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
// Send and wait for the matching reply, skipping checkpoint/unsolicited frames.
function rpc(ws, msg) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + JSON.stringify(msg))), 30000);
    const onMsg = (d) => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }
      // skip checkpoint / snapshot / progress frames
      if (m.t === "checkpoint" || m.t === "snapshot" || m.t === "progress") return;
      clearTimeout(t);
      ws.off("message", onMsg);
      res(m);
    };
    ws.on("message", onMsg);
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

// (1) create + eval set x=41; x+1 -> 42
r = await rpc(ws, { t: "create", config: { rngSeed: 11 } });
ok("1a create ok", r.ok && r.t === "create", r);
await rpc(ws, { t: "eval", src: "globalThis.x = 41;" });
r = await rpc(ws, { t: "eval", src: "x + 1" });
ok("1b x+1 === 42", r.value === 42, r);

// (2) stateful: define fn one cell, call next
await rpc(ws, { t: "eval", src: "globalThis.dbl = (n) => n*2;" });
r = await rpc(ws, { t: "eval", src: "dbl(21)" });
ok("2 stateful fn dbl(21)=42", r.value === 42, r);

// (3) evict -> cold-restore: x survived, restoreSource
await rpc(ws, { t: "evict" });
r = await rpc(ws, { t: "gen" });
ok("3a evicted inMemory=false", r.inMemory === false, r);
r = await rpc(ws, { t: "eval", src: "x" });
ok("3b cold-restore x===41 + restoreSource", r.value === 41 && !!r.restoreSource && /restore/.test(r.restoreSource), { v: r.value, src: r.restoreSource });

// (4) determinism: seeded, two evals stable (same seed via fresh session)
const seedA = (await rpc(ws, { t: "eval", src: "Math.random()" })).value;
const seedB = (await rpc(ws, { t: "eval", src: "Math.random()" })).value;
ok("4a seeded random returns numbers", typeof seedA === "number" && typeof seedB === "number", { seedA, seedB });
// reproducibility: new session, same seed, first draw matches
const ws2 = await connect("det-a-" + Date.now());
await rpc(ws2, { t: "create", config: { rngSeed: 999 } });
const dA = (await rpc(ws2, { t: "eval", src: "Math.random()" })).value;
const ws3 = await connect("det-b-" + Date.now() + "-x");
await rpc(ws3, { t: "create", config: { rngSeed: 999 } });
const dB = (await rpc(ws3, { t: "eval", src: "Math.random()" })).value;
ok("4b determinism: same seed -> same first draw", dA === dB, { dA, dB });
ws2.close(); ws3.close();

// (5) preview: Map(1){...} not "{}", Promise.resolve(7) settles to 7
r = await rpc(ws, { t: "eval", src: "new Map([['a',1]])" });
ok("5a Map preview not {}", r.valuePreview && /Map\(1\)/.test(r.valuePreview) && r.valuePreview !== "{}" && /a/.test(r.valuePreview), r.valuePreview);
r = await rpc(ws, { t: "eval", src: "Promise.resolve(7)" });
ok("5b Promise.resolve(7) settles to 7", r.value === 7 || (r.valuePreview && /7/.test(r.valuePreview)), { v: r.value, p: r.valuePreview });

ws.close();
const pass = results.filter((x) => x.pass).length;
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
