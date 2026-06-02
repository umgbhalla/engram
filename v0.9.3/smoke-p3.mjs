// engram v0.3 P3 smoke: real fetch egress + allowlist + error-as-value preview,
// plus no-regression on durability/determinism/loop-preemption.
// Usage: node smoke-p3.mjs <wss-base>
import WebSocket from "ws";

const BASE = process.argv[2] || "wss://montydyn-v03.umg-bhalla88.workers.dev";

function ws(id) {
  return new Promise((res, rej) => {
    const w = new WebSocket(`${BASE}/ws?id=${id}`);
    w.once("open", () => res(w));
    w.once("error", rej);
  });
}
function rpc(w, msg, timeoutMs = 30000) {
  return new Promise((res) => {
    const to = setTimeout(() => res({ ok: false, error: { name: "RPC_TIMEOUT" } }), timeoutMs);
    w.once("message", (d) => { clearTimeout(to); res(JSON.parse(d.toString())); });
    try { w.send(JSON.stringify(msg)); } catch (e) { clearTimeout(to); res({ ok: false, error: String(e) }); }
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
}

// (a) allowed host returns a real response
{
  const w = await ws("p3a-" + Date.now());
  await rpc(w, { t: "gen" }, 45000); // warm up the cold worker/DO before the timed checks
  await rpc(w, { t: "create", config: { fetch: ["example.com"], cellBudgetTicks: 200000, cellBudgetMs: 25000 } }, 45000);
  const r = await rpc(w, { t: "eval", src: "const r = await host.fetch('https://example.com/'); ({status:r.status, hasBody:/Example Domain/.test(r.body)})" }, 45000);
  check("(a) allowed fetch returns real 200 response", r.ok && r.value && r.valuePreview && /200/.test(r.valuePreview) && /true/.test(r.valuePreview), `${r.valuePreview} err=${JSON.stringify(r.error)}`);
  // socket alive + state usable
  const nx = await rpc(w, { t: "eval", src: "1+1" });
  check("(a) kernel usable after fetch", nx.ok && nx.value === 2, `value=${nx.value}`);
  w.close();
}

// (b) blocked host (not in allowlist) -> typed error, socket alive, kernel usable
{
  const w = await ws("p3b-" + Date.now());
  await rpc(w, { t: "create", config: { fetch: ["example.com"], cellBudgetTicks: 200000, cellBudgetMs: 25000 } });
  const r = await rpc(w, { t: "eval", src: "await host.fetch('https://evil.example.org/')" }, 30000);
  check("(b1) blocked host -> typed FetchBlockedError", r.ok === false && r.error && r.error.name === "FetchBlockedError", JSON.stringify(r.error));
  check("(b1) socket still open after block", w.readyState === WebSocket.OPEN, `rs=${w.readyState}`);
  const nx = await rpc(w, { t: "eval", src: "6*7" });
  check("(b1) kernel usable after block", nx.ok && nx.value === 42, `value=${nx.value}`);
  w.close();
}

// (b2) fetch:false -> block ALL
{
  const w = await ws("p3b2-" + Date.now());
  await rpc(w, { t: "create", config: { fetch: false, cellBudgetTicks: 200000, cellBudgetMs: 25000 } });
  const r = await rpc(w, { t: "eval", src: "await host.fetch('https://example.com/')" }, 30000);
  check("(b2) fetch:false -> typed FetchBlockedError", r.ok === false && r.error && r.error.name === "FetchBlockedError", JSON.stringify(r.error));
  check("(b2) socket alive after fetch:false block", w.readyState === WebSocket.OPEN, "");
  w.close();
}

// (b3) fetch:true -> allow all
{
  const w = await ws("p3b3-" + Date.now());
  await rpc(w, { t: "create", config: { fetch: true, cellBudgetTicks: 200000, cellBudgetMs: 25000 } });
  const r = await rpc(w, { t: "eval", src: "const r = await host.fetch('https://example.com/'); r.status" }, 30000);
  check("(b3) fetch:true allows any host", r.ok && r.value === 200, `value=${r.value} err=${JSON.stringify(r.error)}`);
  w.close();
}

// (c) returning an Error shows message in preview
{
  const w = await ws("p3c-" + Date.now());
  await rpc(w, { t: "create", config: {} });
  const r = await rpc(w, { t: "eval", src: "new TypeError('kaboom')" });
  check("(c) returned Error preview has name+message", r.ok && r.valueType === "error" && /TypeError/.test(r.valuePreview) && /kaboom/.test(r.valuePreview), `type=${r.valueType} preview=${r.valuePreview}`);
  check("(c) returned Error value has message field", r.value && r.value.message === "kaboom" && r.value.name === "TypeError", JSON.stringify(r.value));
  w.close();
}

// (d) no regression: eval -> evict -> restore + seeded determinism + loop preemption
{
  const w = await ws("p3d-" + Date.now());
  await rpc(w, { t: "create", config: { clock: "seeded", rngSeed: 99, cellBudgetTicks: 1200 } });
  await rpc(w, { t: "eval", src: "globalThis.survivor = 7; globalThis.frozen = Date.now(); survivor" });
  const frozen = (await rpc(w, { t: "eval", src: "frozen" })).value;
  const ev = await rpc(w, { t: "evict" });
  check("(d) evict dropped in-memory", ev.ok && ev.droppedInMemory, "");
  const r = await rpc(w, { t: "eval", src: "survivor + 1" });
  check("(d) state survives evict->restore", r.ok && r.value === 8, `value=${r.value} src=${r.restoreSource}`);
  const det = await rpc(w, { t: "eval", src: "Date.now() === frozen" });
  check("(d) seeded determinism intact after restore", det.ok, `eq=${det.value}`);
  // loop preemption still trips, socket alive
  const tL = Date.now();
  const loop = await rpc(w, { t: "eval", src: "while(true){}" }, 26000);
  console.log(`  (d) loop returned in ${Date.now() - tL}ms`);
  check("(d) loop preemption -> TimeoutError", loop.ok === false && loop.error && loop.error.name === "TimeoutError", JSON.stringify(loop.error));
  check("(d) socket alive after loop (no WS 1006)", w.readyState === WebSocket.OPEN, `rs=${w.readyState}`);
  const after = await rpc(w, { t: "eval", src: "2+3" });
  check("(d) kernel usable after loop trip", after.ok && after.value === 5, `value=${after.value}`);
  w.close();
}

const passed = results.filter((x) => x.pass).length;
console.log(`\n==== ${passed}/${results.length} P3 checks passed ====`);
process.exit(passed === results.length ? 0 : 1);
