import WebSocket from "ws";
const BASE = process.argv[2] || "wss://engram-kernel.umg-bhalla88.workers.dev";
const ID = "trackA-" + Date.now();
function connect(id) {
  const u = `${BASE}/ws?id=${id}`;
  return new Promise((res, rej) => {
    const ws = new WebSocket(u);
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}
function rpc(ws, msg, t = 20000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("TIMEOUT " + JSON.stringify(msg))), t);
    ws.once("message", (d) => { clearTimeout(to); res(JSON.parse(d.toString())); });
    ws.send(JSON.stringify(msg));
  });
}
const out = [];
function check(name, cond, detail) { out.push({ name, pass: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`); }

let ws = await connect(ID);
await rpc(ws, { t: "create", config: { clock: "seeded", rngSeed: 7, capture: true } });

// (1) IN-CELL function hoisting: call above declaration in same cell
let r = await rpc(ws, { t: "eval", src: "const r = f(); function f(){return 7}; r" });
check("in-cell hoisting (call above decl) === 7", r.ok && r.value === 7, `ok=${r.ok} value=${JSON.stringify(r.value)} err=${JSON.stringify(r.error)}`);

// (2) cross-cell function persist
r = await rpc(ws, { t: "eval", src: "function add(a,b){return a+b}" });
check("define fn cell ok", r.ok, JSON.stringify(r.error));
r = await rpc(ws, { t: "eval", src: "add(20,22)" });
check("cross-cell function persist add(20,22)===42", r.ok && r.value === 42, `value=${JSON.stringify(r.value)}`);

// (3) let/const/class persist across cells
r = await rpc(ws, { t: "eval", src: "const K = 99; let L = 8; class C { m(){return 5} }" });
check("define let/const/class cell ok", r.ok, JSON.stringify(r.error));
r = await rpc(ws, { t: "eval", src: "K + L + new C().m()" });
check("let/const/class persist (99+8+5===112)", r.ok && r.value === 112, `value=${JSON.stringify(r.value)}`);

// (4) for(let i) not leaked to global
r = await rpc(ws, { t: "eval", src: "for(let i=0;i<3;i++){}; 'done'" });
check("for(let i) cell ok", r.ok && r.value === "done", JSON.stringify(r.value));
r = await rpc(ws, { t: "eval", src: "typeof i" });
check("for(let i) NOT leaked (typeof i==='undefined')", r.ok && r.value === "undefined", `typeof i = ${JSON.stringify(r.value)}`);

// (5) determinism: seeded clock/rng stable value to compare after restore
r = await rpc(ws, { t: "eval", src: "globalThis.detTs = Date.now(); globalThis.detRnd = Math.random(); [detTs, detRnd]" });
const detBefore = r.value;
check("seeded det values produced", r.ok && Array.isArray(detBefore), JSON.stringify(detBefore));

// set a marker state to verify survival
await rpc(ws, { t: "eval", src: "globalThis.survivor = 'alive-' + (40+2)" });

// (6) evict -> cold restore: close socket, reconnect same id
ws.close();
await new Promise((r2) => setTimeout(r2, 1500));
// force eviction signal if supported, else rely on reconnect reconstruction
ws = await connect(ID);
r = await rpc(ws, { t: "eval", src: "survivor" });
check("evict->cold-restore: state survived", r.ok && r.value === "alive-42", `value=${JSON.stringify(r.value)}`);
r = await rpc(ws, { t: "eval", src: "add(1,2)" });
check("evict->cold-restore: function survived", r.ok && r.value === 3, `value=${JSON.stringify(r.value)}`);
r = await rpc(ws, { t: "eval", src: "K + L + new C().m()" });
check("evict->cold-restore: let/const/class survived", r.ok && r.value === 112, `value=${JSON.stringify(r.value)}`);

// determinism after restore: replay seeded reads should be reproducible relative to recorded
r = await rpc(ws, { t: "eval", src: "[detTs, detRnd]" });
check("determinism: seeded values persisted across restore", r.ok && JSON.stringify(r.value) === JSON.stringify(detBefore), `after=${JSON.stringify(r.value)} before=${JSON.stringify(detBefore)}`);

ws.close();
const fails = out.filter((o) => !o.pass);
console.log(`\n${out.length - fails.length}/${out.length} PASS`);
process.exit(fails.length ? 1 : 0);
