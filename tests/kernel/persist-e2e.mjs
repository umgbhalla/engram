import WebSocket from "../../packages/sdk/node_modules/ws/wrapper.mjs";

const SUB = process.env.SUB || "umg-bhalla88";
const BASE = `wss://engram-kernel.${SUB}.workers.dev`;

function connect(session) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(session)}`);
  return new Promise((res, rej) => {
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}
function req(ws, frame, timeout = 20000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + JSON.stringify(frame).slice(0, 60))), timeout);
    ws.once("message", (d) => { clearTimeout(t); try { res(JSON.parse(d.toString())); } catch (e) { rej(e); } });
    ws.once("close", () => { clearTimeout(t); rej(new Error("ws closed")); });
    ws.send(JSON.stringify(frame));
  });
}
const evalC = (ws, src) => req(ws, { t: "eval", src });

function v(r) { return r && r.value; }
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ::  ${detail}`);
}

async function main() {
  const session = "persist-e2e-" + Date.now();
  let ws = await connect(session);
  await req(ws, { t: "create", config: { clock: { mode: "seeded", epochMs: 1000 }, rngSeed: 7 } });

  // 1 let z=9 -> z
  await evalC(ws, "let z=9");
  let r = await evalC(ws, "z");
  check("1 let z=9 persists", v(r) === 9, `z -> ${JSON.stringify(v(r))} (ok=${r.ok})`);

  // 2 const k=3 -> k
  await evalC(ws, "const k=3");
  r = await evalC(ws, "k");
  check("2 const k=3 persists", v(r) === 3, `k -> ${JSON.stringify(v(r))}`);

  // 3 function f -> f()
  await evalC(ws, "function f(){return 7}");
  r = await evalC(ws, "f()");
  check("3 function decl persists", v(r) === 7, `f() -> ${JSON.stringify(v(r))}`);

  // 4 class C -> new C().x
  await evalC(ws, "class C{constructor(){this.x=1}}");
  r = await evalC(ws, "new C().x");
  check("4 class decl persists", v(r) === 1, `new C().x -> ${JSON.stringify(v(r))}`);

  // 5 const {a,b}={a:1,b:2} -> a+b
  await evalC(ws, "const {a,b}={a:1,b:2}");
  r = await evalC(ws, "a+b");
  check("5 object destructuring persists", v(r) === 3, `a+b -> ${JSON.stringify(v(r))}`);

  // 6 let m=1,n=2 -> m+n
  await evalC(ws, "let m=1,n=2");
  r = await evalC(ws, "m+n");
  check("6 multi-decl persists", v(r) === 3, `m+n -> ${JSON.stringify(v(r))}`);

  // 7 loop var NOT leaked
  await evalC(ws, "for(let i=0;i<3;i++){}");
  r = await evalC(ws, "typeof i");
  check("7 loop var stays scoped", v(r) === "undefined", `typeof i -> ${JSON.stringify(v(r))}`);

  // 8 string "let x = 5" not transformed
  r = await evalC(ws, '"let x = 5"');
  const r8b = await evalC(ws, "typeof x");
  check("8 string literal untouched", v(r) === "let x = 5" && v(r8b) === "undefined",
    `value -> ${JSON.stringify(v(r))} ; typeof x -> ${JSON.stringify(v(r8b))}`);

  // 9 nested block let q NOT leaked
  await evalC(ws, "{ let q=1 }");
  r = await evalC(ws, "typeof q");
  check("9 nested block scope contained", v(r) === "undefined", `typeof q -> ${JSON.stringify(v(r))}`);

  // 10 completion value returned
  r = await evalC(ws, "1+1");
  check("10 completion value returned", v(r) === 2, `1+1 -> ${JSON.stringify(v(r))}`);

  // REGRESSION: stateful var + implicit global persist
  await evalC(ws, "var sv = 100; gg = 200;");
  const rsv = await evalC(ws, "sv");
  const rgg = await evalC(ws, "gg");
  check("R1 var + implicit global persist", v(rsv) === 100 && v(rgg) === 200,
    `sv -> ${JSON.stringify(v(rsv))} ; gg -> ${JSON.stringify(v(rgg))}`);

  // REGRESSION: determinism (seeded)
  const rnd1 = await evalC(ws, "Math.random()");
  check("R2 seeded determinism alive", typeof v(rnd1) === "number", `Math.random() -> ${JSON.stringify(v(rnd1))}`);

  // Mutate a value we'll verify after cold restore
  await evalC(ws, "z = 4242");
  await evalC(ws, "globalThis.survivor = { closure: (()=>{let c=0; return ()=>++c})() }");
  await evalC(ws, "survivor.closure(); survivor.closure();"); // c=2

  // EVICT -> cold restore. evict drops the in-memory glue kernel; the FIRST eval
  // afterward must reconstruct it from the durable SQLite snapshot (inMemoryBefore=false,
  // restoreSource sqlite/r2). Do NOT send a create frame first (that would re-instantiate).
  const ev = await req(ws, { t: "evict" });
  const gen = await req(ws, { t: "gen" });

  const rz = await evalC(ws, "z");
  const rk = await evalC(ws, "k");
  const rf = await evalC(ws, "f()");
  const rcl = await evalC(ws, "survivor.closure()"); // c was 2 -> 3
  const cold =
    v(rz) === 4242 && v(rk) === 3 && v(rf) === 7 && v(rcl) === 3 &&
    rz.inMemoryBefore === false;
  check("R3 evict->restore intact (no replay)", cold,
    `evictDropped=${ev.droppedInMemory} genInMem=${gen.inMemory} inMemoryBefore=${rz.inMemoryBefore} restore=${rz.restoreSource} | z=${v(rz)} k=${v(rk)} f()=${v(rf)} closure->${v(rcl)}`);

  // GUARD smoke: infinite loop trips typed error, socket alive
  const guard = await evalC(ws, "while(true){x=1}", 15000).catch((e) => ({ ok: false, error: { message: e.message } }));
  const alive = await evalC(ws, "1+1");
  check("R4 guard: infinite loop trips, socket alive", guard.ok === false && v(alive) === 2,
    `loop ok=${guard.ok} err=${JSON.stringify(guard.error && (guard.error.name || guard.error.message))} ; post 1+1 -> ${v(alive)}`);

  ws.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) { console.log("FAILURES:", failed.map((f) => f.name)); process.exit(1); }
}
main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
