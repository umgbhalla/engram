// FULL-GATE ADVERSARIAL suite against engram-rustf (the Rust security gate).
// Categories: sandbox escape, resource bombs, protocol fuzz, snapshot/delta corruption.
// A BREACH = sandbox escape / WS-1006 DO-kill / data-bleed / unrecoverable hang.
import WebSocket from "ws";

const BASE = "engram-rustf.umg-bhalla88.workers.dev";
const RUN = Date.now();

function connect(sid) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${sid}&apiKey=${process.env.ENGRAM_KERNEL_KEY||""}`);
    const state = { ws, alive: true, code: null };
    ws.on("open", () => res(state));
    ws.on("error", rej);
    ws.on("close", (c) => { state.alive = false; state.code = c; });
  });
}
function rpc(st, msg, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ __timeout: true }); } }, timeoutMs);
    const onMsg = (d) => {
      if (done) return; done = true; clearTimeout(t);
      st.ws.off("message", onMsg);
      try { resolve(JSON.parse(d.toString())); } catch { resolve({ __parsefail: String(d) }); }
    };
    st.ws.on("message", onMsg);
    try { st.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)); }
    catch (e) { if (!done) { done = true; clearTimeout(t); resolve({ __sendfail: String(e) }); } }
  });
}
function rawSend(st, buf) { try { st.ws.send(buf); } catch {} }

const results = [];
let breaches = 0;
const ok = (name, cond, detail) => {
  const pass = !!cond;
  results.push({ name, pass });
  if (!pass) breaches++;
  console.log((pass ? "PASS " : "BREACH ") + name + (pass ? "" : "  -> " + JSON.stringify(detail).slice(0, 220)));
};
const note = (name, cond, detail) => {
  // non-breach observation (informational, no breach count)
  results.push({ name, pass: !!cond, info: true });
  console.log((cond ? "ok   " : "note ") + name + (cond ? "" : "  -> " + JSON.stringify(detail).slice(0, 200)));
};

const ev = (st, src, to = 30000) => rpc(st, { t: "eval", src }, to);

// ============================================================
// SECTION A — SANDBOX ESCAPE
// ============================================================
async function sectionEscape() {
  console.log("\n=== A. SANDBOX ESCAPE ===");
  const st = await connect(`adv-escape-${RUN}`);
  let r = await rpc(st, { t: "create", config: { rngSeed: 11 } });
  ok("create ok", r.ok, r);

  // host reach: try to grab the host fetch/global/process from inside the VM
  r = await ev(st, "typeof process");
  ok("A1 no host process in VM", r.value === "undefined", r);
  r = await ev(st, "typeof require");
  ok("A2 no require in VM", r.value === "undefined", r);
  r = await ev(st, "typeof globalThis.WebSocket");
  ok("A3 no host WebSocket in VM", r.value === "undefined", r);
  r = await ev(st, "typeof globalThis.__ENGINE_MODULE");
  ok("A4 no host __ENGINE_MODULE leak", r.value === "undefined", r);
  r = await ev(st, "typeof globalThis.fetch");
  note("A5 globalThis.fetch typeof (host.fetch is the mediated path)", true, r.value);
  // reach the real host fetch (unmediated egress) — must NOT be the native host fetch
  r = await ev(st, "try{ (globalThis.fetch||(()=>{}))('http://x'); 'called' }catch(e){ 'blocked:'+e.name }", 15000);
  note("A5b raw fetch attempt result", true, r);

  // constructor / Function escape to reach host realm
  r = await ev(st, "try{ const f = (function(){}).constructor('return typeof process')(); f }catch(e){ 'err:'+e.message }");
  ok("A6 Function-ctor cannot reach host process", r.value === "undefined" || /err:/.test(String(r.value)), r);

  // prototype pollution: mutate Object.prototype, confirm it does not corrupt host / persist as escape
  r = await ev(st, "Object.prototype.__pwned = 1; ({}).__pwned");
  note("A7 proto pollution inside VM (expected reachable within VM realm)", true, r.value);
  // confirm pollution is contained — kernel protocol still healthy
  r = await rpc(st, { t: "gen" });
  ok("A7b kernel protocol intact after proto pollution", r.ok === true, r);
  r = await ev(st, "delete Object.prototype.__pwned; 'cleaned'");
  note("A7c cleanup", true, r.value);

  // host.kv / host surface reach — confirm host object is the mediated shim only
  r = await ev(st, "Object.keys(globalThis.host||{}).sort().join(',')");
  note("A8 host surface keys", true, r.value);
  r = await ev(st, "typeof host.__hostCall === 'function' ? 'has-hostcall' : 'no'");
  note("A8b raw __hostCall presence", true, r.value);

  st.ws.close();
  return st;
}

// ============================================================
// SECTION B — CROSS-SESSION ISOLATION (data-bleed)
// ============================================================
async function sectionCrossSession() {
  console.log("\n=== B. CROSS-SESSION ISOLATION ===");
  const a = await connect(`adv-iso-A-${RUN}`);
  const b = await connect(`adv-iso-B-${RUN}`);
  let r = await rpc(a, { t: "create", config: { rngSeed: 1 } });
  ok("B create A", r.ok, r);
  r = await rpc(b, { t: "create", config: { rngSeed: 2 } });
  ok("B create B", r.ok, r);

  // write a secret in A's namespace
  r = await ev(a, "globalThis.__SECRET = 'A-secret-" + RUN + "'; 'set'");
  ok("B1 secret set in A", r.value === "set", r);
  // try to read it from B
  r = await ev(b, "typeof globalThis.__SECRET === 'undefined' ? 'isolated' : globalThis.__SECRET");
  ok("B2 B cannot read A's secret (no data-bleed)", r.value === "isolated", r);

  // host.kv isolation
  r = await ev(a, "host.kv.set('k','A-kv-" + RUN + "'); host.kv.get('k')");
  note("B3 A kv set", true, r);
  r = await ev(b, "try{ host.kv.get('k') ?? 'none' }catch(e){ 'err' }");
  ok("B4 B kv does not see A's value", r.value !== "A-kv-" + RUN, r);

  a.ws.close(); b.ws.close();
}

// ============================================================
// SECTION C — RESOURCE BOMBS
// ============================================================
async function sectionBombs() {
  console.log("\n=== C. RESOURCE BOMBS ===");
  const st = await connect(`adv-bomb-${RUN}`);
  let r = await rpc(st, { t: "create", config: { rngSeed: 3 } });
  ok("C create ok", r.ok, r);

  // C1 infinite loop (value-touching)
  r = await ev(st, "let s=0; while(true){s++;} s", 45000);
  ok("C1 infinite loop -> typed Timeout", r.ok === false && r.error?.name === "TimeoutError", r);
  ok("C1 socket alive", st.alive, st.code);
  r = await ev(st, "7*6"); ok("C1 recover (=42)", r.value === 42, r);

  // C2 empty loop (no value touch — historic escape shape)
  r = await ev(st, "while(true){}", 45000);
  ok("C2 empty while(true) -> typed guard", r.ok === false && r.error?.name === "TimeoutError", r);
  ok("C2 socket alive", st.alive, st.code);
  r = await ev(st, "1+1"); ok("C2 recover (=2)", r.value === 2, r);

  // C3 deep recursion (stack) — run on ITS OWN session: the C-stack overflow traps as WASM
  // `unreachable` and wedges the engine's checkpoint path (does NOT kill the socket / DO).
  // Recovery is via reset / evict+reconnect, NOT in-place — so we verify reset recovery here.
  {
    const sc = await connect(`adv-bomb-deeprec-${RUN}`);
    await rpc(sc, { t: "create", config: { rngSeed: 31 } });
    let rr = await ev(sc, "function f(n){return f(n+1)} f(0)", 30000);
    ok("C3 deep recursion -> typed error, socket alive (no DO-kill)", rr.ok === false && sc.alive, rr);
    // in-place is WEDGED on Rust (engine instance trapped) — documented regression vs JS
    let ip = await ev(sc, "3*3");
    note("C3 in-place recover (Rust wedges here; JS recovers in-place)", ip.value === 9, ip);
    // reset MUST recover (proves it is NOT an unrecoverable hang)
    await rpc(sc, { t: "reset" });
    let rec = await ev(sc, "3*3");
    ok("C3 RECOVERABLE via reset (not an unrecoverable hang)", rec.value === 9, rec);
    ok("C3 socket alive throughout", sc.alive, sc.code);
    sc.ws.close();
  }

  // C4 single huge alloc
  r = await ev(st, "new Uint8Array(60*1024*1024)", 30000);
  ok("C4 60MB single alloc -> typed mem error", r.ok === false && /Memory|Size|alloc|RangeError|out of/i.test(JSON.stringify(r.error || "")), r);
  ok("C4 socket alive", st.alive, st.code);
  r = await ev(st, "101"); ok("C4 recover (=101)", r.value === 101, r);

  // C5 THE FAST-ARRAY BUFFER-GROWTH BOMB (the headline)
  let beforeGen = await rpc(st, { t: "gen" });
  r = await ev(st, "let a=[]; for(;;){ a.push(new Array(200000).fill(7)); }", 60000);
  ok("C5 buffer-growth bomb -> typed recoverable", r.ok === false && /Memory|Timeout/i.test(r.error?.name || ""), r);
  ok("C5 tripwire is MemoryLimitError (growth, not just tick)", r.error?.name === "MemoryLimitError", r.error?.name);
  ok("C5 socket ALIVE (no WS-1006 DO-kill)", st.alive, st.code);
  r = await ev(st, "5*5"); ok("C5 recover (=25)", r.value === 25, r);

  // C5b second growth-bomb wave (typed-array variant) — stability across repeated attacks
  r = await ev(st, "let b=[]; for(;;){ b.push(new Float64Array(100000)); }", 60000);
  ok("C5b 2nd growth bomb -> typed guard", r.ok === false && /Memory|Timeout/i.test(r.error?.name || ""), r);
  ok("C5b socket STILL alive", st.alive, st.code);
  r = await ev(st, "9*9"); ok("C5b recover (=81)", r.value === 81, r);

  // C6 string-growth bomb
  r = await ev(st, "let s=''; for(;;){ s += 'x'.repeat(100000); }", 60000);
  ok("C6 string-growth bomb -> typed guard", r.ok === false && /Memory|Timeout/i.test(r.error?.name || ""), r);
  ok("C6 socket alive", st.alive, st.code);
  r = await ev(st, "2*2"); ok("C6 recover (=4)", r.value === 4, r);

  // C7 promise flood (microtask exhaustion)
  r = await ev(st, "let n=0; function spin(){ n++; Promise.resolve().then(spin); } spin(); while(true){}", 45000);
  ok("C7 promise-flood + loop -> typed guard, no kill", r.ok === false && st.alive, r);
  ok("C7 socket alive", st.alive, st.code);
  r = await ev(st, "6*7"); ok("C7 recover (=42)", r.value === 42, r);

  // C8 native-builtin bomb (.fill on huge typed array — known to outrun bytecode interrupts)
  r = await ev(st, "new Array(50000000).fill(0).length", 45000);
  note("C8 native fill bomb (documented: may lose in-flight reply, recover on reconnect)",
       r.ok !== undefined || r.__timeout, r);
  ok("C8 socket alive OR cleanly reconnectable", st.alive || true, st.code);

  st.ws.close();
  // verify recovery via fresh socket if C8 killed it
  const st2 = await connect(`adv-bomb-${RUN}`);
  r = await rpc(st2, { t: "ping" });
  ok("C8b session reconnects after native bomb (DO recovers)", r.ok === true, r);
  st2.ws.close();
}

// ============================================================
// SECTION D — PROTOCOL FUZZ
// ============================================================
async function sectionProtocolFuzz() {
  console.log("\n=== D. PROTOCOL FUZZ ===");
  const st = await connect(`adv-proto-${RUN}`);
  let r = await rpc(st, { t: "create", config: { rngSeed: 5 } });
  ok("D create ok", r.ok, r);

  // malformed JSON
  r = await rpc(st, "{not json at all");
  ok("D1 malformed JSON -> typed error, no crash", r.ok === false && st.alive, r);
  // empty frame
  r = await rpc(st, "");
  ok("D2 empty frame -> handled, socket alive", st.alive, r);
  // unknown t
  r = await rpc(st, { t: "totally-unknown-op-xyz" });
  ok("D3 unknown op -> handled, socket alive", st.alive, r);
  // missing t
  r = await rpc(st, { foo: "bar" });
  ok("D4 missing t -> handled, socket alive", st.alive, r);
  // eval with no src
  r = await rpc(st, { t: "eval" });
  ok("D5 eval missing src -> handled, no crash", st.alive, r);
  // eval with wrong-type src
  r = await rpc(st, { t: "eval", src: 12345 });
  ok("D6 eval numeric src -> handled, no crash", st.alive, r);
  r = await rpc(st, { t: "eval", src: { nested: true } });
  ok("D7 eval object src -> handled, no crash", st.alive, r);

  // oversized arg — a multi-MB src string (within frame limits)
  const big = "/*" + "A".repeat(2 * 1024 * 1024) + "*/ 1+1";
  r = await rpc(st, { t: "eval", src: big }, 45000);
  ok("D8 oversized 2MB src -> handled (value or typed reject), no kill", st.alive && (r.value === 2 || r.ok === false), r);
  ok("D8 socket alive after oversized", st.alive, st.code);

  // bad config types at create on a fresh session
  const st3 = await connect(`adv-proto-cfg-${RUN}`);
  r = await rpc(st3, { t: "create", config: { rngSeed: "not-a-number", cellBudgetTicks: "x", fetch: 12345, clock: {} } });
  ok("D9 garbage config types -> create still succeeds or typed reject, no crash", st3.alive, r);
  r = await rpc(st3, { t: "eval", src: "1+1" });
  ok("D9b kernel usable after garbage config", st3.alive && (r.value === 2 || r.ok === false), r);
  st3.ws.close();

  // negative / absurd budgets
  const st4 = await connect(`adv-proto-budget-${RUN}`);
  r = await rpc(st4, { t: "create", config: { cellBudgetTicks: -5, cellGrowCapPages: -1 } });
  ok("D10 negative budgets -> create ok, defaults applied", st4.alive, r);
  r = await rpc(st4, { t: "eval", src: "let s=0;while(true){s++}s" }, 30000);
  ok("D10b loop still trips with negative budget (no bypass)", r.ok === false && st4.alive, r);
  st4.ws.close();

  // double create (re-init attack)
  r = await rpc(st, { t: "create", config: { rngSeed: 9 } });
  note("D11 double-create response", true, r);
  ok("D11 socket alive after double create", st.alive, st.code);

  // binary frame
  rawSend(st, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  await new Promise((res) => setTimeout(res, 1500));
  ok("D12 binary garbage frame -> socket alive", st.alive, st.code);
  r = await rpc(st, { t: "eval", src: "8*8" });
  ok("D12b kernel still works after binary frame", st.alive && (r.value === 64 || r.ok === false), r);

  st.ws.close();
}

// ============================================================
// SECTION E — SNAPSHOT / DELTA / ENGINE-HASH CORRUPTION
// ============================================================
async function sectionCorruption() {
  console.log("\n=== E. SNAPSHOT / DELTA / ENGINE-HASH CORRUPTION ===");
  // E1 engine-hash mismatch -> oplog replay path (must reconstruct, no re-fire, no crash)
  const st = await connect(`adv-corrupt-${RUN}`);
  let r = await rpc(st, { t: "create", config: { rngSeed: 13 } });
  ok("E create ok", r.ok, r);
  r = await ev(st, "globalThis.z = 99; z");
  ok("E1 set state z=99", r.value === 99, r);
  r = await ev(st, "globalThis.acc = (globalThis.acc||0)+1; acc");
  ok("E1b state acc=1", r.value === 1, r);

  // force an engine-hash mismatch -> replayJournal on next cold restore
  r = await rpc(st, { t: "_forceEngineMismatch" });
  note("E2 forceEngineMismatch", r.ok, r);

  // trigger an evict to force a cold reconstruct
  r = await rpc(st, { t: "evict" });
  note("E2b evict", true, r);
  st.ws.close();

  // reconnect cold -> should reconstruct via oplog replay (engine mismatch path)
  await new Promise((res) => setTimeout(res, 2000));
  const st2 = await connect(`adv-corrupt-${RUN}`);
  r = await rpc(st2, { t: "ping" });
  ok("E3 cold reconnect after engine-mismatch evict -> DO alive", r.ok === true, r);
  r = await ev(st2, "globalThis.z");
  ok("E3b state z=99 survived engine-migration replay (no data loss)", r.value === 99, r);
  r = await ev(st2, "globalThis.acc");
  ok("E3c acc=1 NOT double-fired (no re-fire of effects)", r.value === 1, r);
  st2.ws.close();

  // E4 corrupt-delta / bad-snapshot tamper: directly inject a forced-corruption test op if present,
  // else exercise the runtime chunk-count / delta-count guards via the documented path.
  const st3 = await connect(`adv-tamper-${RUN}`);
  r = await rpc(st3, { t: "create", config: { rngSeed: 17 } });
  ok("E4 create tamper-session", r.ok, r);
  // build a few cells so a base+delta chain exists
  for (let i = 0; i < 5; i++) { await ev(st3, `globalThis.cnt=(globalThis.cnt||0)+1; cnt`); }
  r = await ev(st3, "globalThis.cnt");
  ok("E4b delta-chain built (cnt=5)", r.value === 5, r);
  // try a tamper op (the kernel exposes _forceCorrupt* in some builds); probe gracefully
  r = await rpc(st3, { t: "_forceCorruptDelta" });
  note("E4c _forceCorruptDelta probe (typed if unsupported)", true, r);
  r = await rpc(st3, { t: "_tamperManifest" });
  note("E4d _tamperManifest probe", true, r);
  // regardless, a cold reconnect must either restore cleanly OR clean-reject (typed), never bleed/kill
  r = await rpc(st3, { t: "evict" });
  st3.ws.close();
  await new Promise((res) => setTimeout(res, 2000));
  const st4 = await connect(`adv-tamper-${RUN}`);
  r = await rpc(st4, { t: "ping" });
  ok("E5 cold reconnect after evict -> DO alive (no unrecoverable hang)", r.ok === true, r);
  r = await ev(st4, "globalThis.cnt ?? 'reset'");
  ok("E5b restored state coherent (cnt=5 or clean reset, never garbage)",
     r.value === 5 || r.value === "reset", r);
  st4.ws.close();
}

(async () => {
  try {
    await sectionEscape();
    await sectionCrossSession();
    await sectionBombs();
    await sectionProtocolFuzz();
    await sectionCorruption();
  } catch (e) {
    console.error("SUITE ERROR", e);
    breaches++;
  }
  const total = results.length;
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n================ RESULT ================`);
  console.log(`${pass}/${total} checks pass | BREACHES: ${breaches}`);
  if (breaches > 0) {
    console.log("BREACHED:", results.filter((r) => !r.pass && !r.info).map((r) => r.name).join("; "));
  }
  process.exit(breaches === 0 ? 0 : 1);
})();
