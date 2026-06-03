#!/usr/bin/env node
// Smoke test for @engram/sdk v2. Exercises connect / eval / state / typed errors / reconnect /
// hibernate against a live kernel or cloud endpoint.
//
//   KERNEL: node sdk-smoke.mjs wss://engram-rust2....workers.dev
//   CLOUD : node sdk-smoke.mjs https://engram-cloud....workers.dev ek_yourApiKey
//
// In Node we bridge the WebSocket via the `ws` package.
import { Engram, TimeoutError, MemoryLimitError } from "./dist/index.mjs";

const URL = process.argv[2] || process.env.ENGRAM_URL;
const API_KEY = process.argv[3] || process.env.ENGRAM_API_KEY;
if (!URL) {
  console.error("usage: node sdk-smoke.mjs <url> [apiKey]");
  process.exit(2);
}

let WebSocketImpl;
try {
  WebSocketImpl = (await import("ws")).default;
} catch {
  WebSocketImpl = globalThis.WebSocket; // Node 22+ has a global WebSocket
}

let pass = 0,
  fail = 0;
const consoleLines = [];
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? "  — " + extra : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? "  — " + extra : ""}`);
  }
}

const session = "sdk-smoke-" + Math.random().toString(36).slice(2, 8);
console.log(`\nEngram SDK v2 smoke  ·  url=${URL}  ·  session=${session}\n`);

const s = await Engram.connect({
  url: URL,
  apiKey: API_KEY,
  session,
  config: { clock: "seeded", rngSeed: 7 },
  WebSocket: WebSocketImpl,
  onConsole: (l) => consoleLines.push(l),
});

// 1) basic eval + typed value
{
  const r = await s.eval("2 + 2");
  check("eval primitive", r.ok && r.value === 4, `value=${r.value}`);
}

// 2) stateful namespace across cells
{
  await s.eval("globalThis.x = 41");
  const r = await s.eval("x + 1");
  check("stateful namespace", r.value === 42, `x+1=${r.value}`);
}

// 3) console capture (per-cell + onConsole callback)
{
  const before = consoleLines.length;
  const r = await s.eval("console.log('hello', 1+1); 'done'");
  const got = r.console.some((l) => /hello.*2/.test(l.text));
  check("console capture", got && consoleLines.length > before, JSON.stringify(r.console));
}

// 4) object value parsed back to a real value (not a string)
{
  const r = await s.eval("({ a: 1, b: [2, 3] })");
  const v = r.value;
  check("object value parsed", v && v.a === 1 && Array.isArray(v.b), r.valuePreview || JSON.stringify(v));
}

// 5) durable set/get sugar
{
  await s.set("note", { msg: "hi", n: 5 });
  const v = await s.get("note");
  check("set/get sugar", v && v.msg === "hi" && v.n === 5, JSON.stringify(v));
}

// 6) typed error on a thrown cell
{
  try {
    await s.eval("throw new Error('boom')");
    check("throws typed error", false, "did not throw");
  } catch (e) {
    check("throws typed error", /boom/.test(e.message), `${e.name}: ${e.message}`);
  }
}

// 7) opt-out of throwing
{
  const r = await s.eval("throw new Error('quiet')", { throwOnError: false });
  check("throwOnError:false returns result", !r.ok && /quiet/.test(r.error?.message || ""), JSON.stringify(r.error));
}

// 8) typed TimeoutError on infinite loop (guard)
{
  try {
    await s.eval("while(true){}", { timeoutMs: 20000 });
    check("TimeoutError typed", false, "did not trip");
  } catch (e) {
    check("TimeoutError typed", e instanceof TimeoutError || e.name === "TimeoutError", `${e.name}: ${e.message}`);
  }
}

// 9) async cell with await
{
  const r = await s.eval("await Promise.resolve(123)");
  check("async/await cell", r.value === 123, `value=${r.value}`);
}

// 10) hibernate + resume keeps state (no replay)
{
  await s.eval("globalThis.persisted = 'survives'");
  const h = await s.hibernateThenResume();
  const r = await s.eval("globalThis.persisted");
  check("hibernate then resume state", r.value === "survives", `restoreSource=${h.restoreSource} value=${r.value}`);
}

// 11) reconnect: close the socket, then eval should auto-reconnect and still see state
{
  s.close();
  // reopen a fresh session object to the SAME durable session id
  const s2 = await Engram.connect({ url: URL, apiKey: API_KEY, session, WebSocket: WebSocketImpl });
  const r = await s2.eval("globalThis.persisted");
  check("reconnect same session sees state", r.value === "survives", `value=${r.value}`);
  s2.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
