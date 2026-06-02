// engram v0.8 smoke — Feature A (mid-cell used-heap tripwire) + Feature B (Tier-0
// extensions) + survival across evict/cold-restore + determinism.
// Usage: node smoke-v08.mjs [wss-base] [coldIdleMs]
import WebSocket from "ws";

const BASE = process.argv[2] || "wss://montydyn-v08.umg-bhalla88.workers.dev";
const COLD_IDLE_MS = Number(process.argv[3] || 0); // 0 = skip real cold wake (use evict)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function connect(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);
  const pending = [];
  let onMsg = null;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (onMsg) { const cb = onMsg; onMsg = null; cb(m); } else pending.push(m);
  });
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (obj) => new Promise((res) => {
    if (pending.length) return res(pending.shift());
    onMsg = res; ws.send(JSON.stringify(obj));
  });
  return { ws, ready, send, close: () => ws.close() };
}

const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); log(`  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`); };

async function ev(c, src) { return c.send({ t: "eval", src }); }

(async () => {
  log(`v0.8 smoke -> ${BASE}`);
  const id = `v08smoke-${Date.now()}`;
  const c = connect(id);
  await c.ready;

  // create with extensions; seeded clock; defaults.
  const create = await c.send({ t: "create", config: { clock: "seeded", modules: true } });
  log("create.stdlib.extensions =", JSON.stringify(create?.stdlib?.extensions));
  rec("create wires 5 extensions",
    Array.isArray(create?.stdlib?.extensions) && create.stdlib.extensions.length === 5,
    JSON.stringify(create?.stdlib?.extensions));

  // ---------- Feature B: 5 extensions live ----------
  log("\n== Feature B: extensions live ==");
  // NOTE: a top-level async IIFE's returned value previews as {} (documented v0.7 unwrap race);
  // console.log INSIDE the async body is captured correctly, so we assert via logs.
  const digSrc = `(async()=>{const b=await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));console.log('DIGEST='+Array.from(new Uint8Array(b)).slice(0,4).join(','));})()`;
  const dig = await ev(c, digSrc);
  const digLog = (dig.logs || []).map((l) => l.text).join("|");
  rec("crypto.subtle digest(SHA-256) of TextEncoder('abc')",
    dig.ok && digLog.includes("DIGEST=186,120,22,191"),
    `logs=${JSON.stringify(digLog)} err=${JSON.stringify(dig.error)}`);

  const te = await ev(c, `Array.from(new TextEncoder().encode('hi€')).join(',')`);
  rec("TextEncoder().encode", te.ok && te.value === "104,105,226,130,172", `value=${JSON.stringify(te.value)}`);

  const td = await ev(c, `new TextDecoder().decode(new Uint8Array([104,105]))`);
  rec("TextDecoder().decode", td.ok && td.value === "hi", `value=${JSON.stringify(td.value)}`);

  const url = await ev(c, `new URL('https://ex.com:8443/p?q=1#h').hostname`);
  rec("new URL(...).hostname", url.ok && url.value === "ex.com", `value=${JSON.stringify(url.value)}`);

  const usp = await ev(c, `new URLSearchParams('a=1&b=2').get('b')`);
  rec("URLSearchParams", usp.ok && usp.value === "2", `value=${JSON.stringify(usp.value)}`);

  const sc = await ev(c, `JSON.stringify(structuredClone({a:1,b:[2,3]}))`);
  rec("structuredClone", sc.ok && sc.value === '{"a":1,"b":[2,3]}', `value=${JSON.stringify(sc.value)}`);

  const hdr = await ev(c, `(()=>{const h=new Headers();h.set('X-Test','42');return h.get('x-test');})()`);
  rec("new Headers()", hdr.ok && hdr.value === "42", `value=${JSON.stringify(hdr.value)}`);

  const cgrv = await ev(c, `(()=>{const a=new Uint8Array(4);crypto.getRandomValues(a);return Array.from(a).join(',');})()`);
  const grvFirst = cgrv.value;
  rec("crypto.getRandomValues returns bytes (seeded)", cgrv.ok && /^\d+,\d+,\d+,\d+$/.test(String(cgrv.value)), `value=${JSON.stringify(cgrv.value)}`);

  // ---------- Feature A: mid-cell used-heap tripwire ----------
  log("\n== Feature A: mid-cell alloc-bomb tripwire ==");
  // Unbounded array-push bomb — the exact v0.7 documented gap (a.push(new Array(...)) loop).
  const bomb = await ev(c, `(()=>{const a=[];for(let i=0;i<10000000;i++){a.push(new Array(1000).fill(i));}return a.length;})()`);
  rec("array-push alloc bomb throws typed MemoryLimitError mid-cell",
    bomb.ok === false && bomb.error && bomb.error.name === "MemoryLimitError",
    `ok=${bomb.ok} error=${JSON.stringify(bomb.error?.name)} msg=${(bomb.error?.message||"").slice(0,80)}`);

  // socket alive + next eval works.
  const after = await ev(c, `1+1`);
  rec("socket alive, next eval works after bomb", after.ok && Number(after.value) === 2, `value=${JSON.stringify(after.value)}`);

  // String-concat bomb (second shape: the v0.7 string-doubling gap, bytecode-driven).
  const bomb2 = await ev(c, `(()=>{let s='';for(let i=0;i<10000000;i++){s+='abcdefghij';}return s.length;})()`);
  rec("string-concat bomb -> typed MemoryLimitError",
    bomb2.ok === false && bomb2.error && bomb2.error.name === "MemoryLimitError",
    `ok=${bomb2.ok} error=${JSON.stringify(bomb2.error?.name)}`);
  const after2 = await ev(c, `2+2`);
  rec("socket alive after string bomb", after2.ok && Number(after2.value) === 4, `value=${JSON.stringify(after2.value)}`);

  // set up persistent state to verify survival across restore.
  await ev(c, `globalThis.x=42; globalThis.inc=()=>++x; globalThis._digestProbe='abc';`);

  // ---------- Feature B survives evict/cold-restore ----------
  log("\n== extensions survive evict + cold restore ==");
  log("evict:", JSON.stringify(await c.send({ t: "evict" })));
  const gen = await c.send({ t: "gen" });
  log("gen after evict (inMemory should be false):", JSON.stringify(gen));

  if (COLD_IDLE_MS > 0) { c.close(); await sleep(COLD_IDLE_MS); }
  const c2 = COLD_IDLE_MS > 0 ? connect(id) : c;
  if (COLD_IDLE_MS > 0) await c2.ready;

  const xafter = await ev(c2, `x`);
  rec("namespace survives restore (x===42)", xafter.ok && Number(xafter.value) === 42, `value=${JSON.stringify(xafter.value)} restoreSource=${xafter.restoreSource}`);

  const dig2 = await ev(c2, digSrc);
  const dig2Log = (dig2.logs || []).map((l) => l.text).join("|");
  rec("crypto.subtle works AFTER restore (same digest)", dig2.ok && dig2Log.includes("DIGEST=186,120,22,191"), `logs=${JSON.stringify(dig2Log)}`);

  const url2 = await ev(c2, `new URL('https://ex.com/p').hostname`);
  rec("URL works AFTER restore", url2.ok && url2.value === "ex.com", `value=${JSON.stringify(url2.value)}`);

  const sc2 = await ev(c2, `JSON.stringify(structuredClone({a:1}))`);
  rec("structuredClone works AFTER restore", sc2.ok && sc2.value === '{"a":1}', `value=${JSON.stringify(sc2.value)}`);

  const hdr2 = await ev(c2, `(()=>{const h=new Headers({A:'b'});return h.get('a');})()`);
  rec("Headers works AFTER restore", hdr2.ok && hdr2.value === "b", `value=${JSON.stringify(hdr2.value)}`);

  // ---------- Determinism: fresh session, same seeded config, same getRandomValues seq ----------
  log("\n== determinism: seeded getRandomValues byte-identical across fresh sessions ==");
  const d1 = connect(`v08det-a-${Date.now()}`); await d1.ready;
  await d1.send({ t: "create", config: { clock: "seeded" } });
  const seqA = await ev(d1, `(()=>{const a=new Uint8Array(8);crypto.getRandomValues(a);return Array.from(a).join(',');})()`);
  d1.close();
  const d2 = connect(`v08det-b-${Date.now()}`); await d2.ready;
  await d2.send({ t: "create", config: { clock: "seeded" } });
  const seqB = await ev(d2, `(()=>{const a=new Uint8Array(8);crypto.getRandomValues(a);return Array.from(a).join(',');})()`);
  d2.close();
  rec("seeded crypto.getRandomValues byte-identical across two fresh seeded sessions",
    seqA.ok && seqB.ok && seqA.value === seqB.value, `A=${JSON.stringify(seqA.value)} B=${JSON.stringify(seqB.value)}`);

  // determinism across restore for the SAME session: getRandomValues continues seeded deterministically
  log("\n== determinism across restore (continuation) ==");
  const detId = `v08det-restore-${Date.now()}`;
  const r1 = connect(detId); await r1.ready;
  await r1.send({ t: "create", config: { clock: "seeded" } });
  const pre = await ev(r1, `(()=>{const a=new Uint8Array(4);crypto.getRandomValues(a);return Array.from(a).join(',');})()`);
  await r1.send({ t: "evict" });
  const post = await ev(r1, `(()=>{const a=new Uint8Array(4);crypto.getRandomValues(a);return Array.from(a).join(',');})()`);
  // Compare against a no-restore baseline: a fresh session drawing 4 then 4 bytes.
  const base = connect(`v08det-base-${Date.now()}`); await base.ready;
  await base.send({ t: "create", config: { clock: "seeded" } });
  await ev(base, `(()=>{const a=new Uint8Array(4);crypto.getRandomValues(a);return Array.from(a).join(',');})()`);
  const baseSecond = await ev(base, `(()=>{const a=new Uint8Array(4);crypto.getRandomValues(a);return Array.from(a).join(',');})()`);
  base.close(); r1.close();
  rec("seeded RNG continues deterministically across evict/restore (2nd draw matches no-restore baseline)",
    post.ok && post.value === baseSecond.value, `postRestore=${JSON.stringify(post.value)} baseline2nd=${JSON.stringify(baseSecond.value)}`);

  // ---------- No regression: stdlib + loop preempt + kv ----------
  log("\n== no-regression spot checks ==");
  const rc = connect(`v08reg-${Date.now()}`); await rc.ready;
  await rc.send({ t: "create", config: { clock: "seeded", modules: true } });
  const lodash = await ev(rc, `_.chunk([1,2,3,4],2).length`);
  rec("stdlib lodash works", lodash.ok && Number(lodash.value) === 2, `value=${JSON.stringify(lodash.value)}`);
  const loop = await ev(rc, `while(true){}`);
  rec("infinite loop -> typed TimeoutError, socket alive", loop.ok === false && loop.error && loop.error.name === "TimeoutError", `error=${JSON.stringify(loop.error?.name)}`);
  const afterLoop = await ev(rc, `7`);
  rec("socket alive after loop preempt", afterLoop.ok && Number(afterLoop.value) === 7, `value=${JSON.stringify(afterLoop.value)}`);
  await ev(rc, `host.kv.put('k','v1')`);
  await rc.send({ t: "evict" });
  const kvget = await ev(rc, `host.kv.get('k')`);
  rec("kv survives restore", kvget.ok && kvget.value === "v1", `value=${JSON.stringify(kvget.value)}`);
  rc.close();

  if (COLD_IDLE_MS > 0) c2.close(); else c.close();

  const passN = results.filter((r) => r.pass).length;
  log(`\n===== v0.8 SMOKE: ${passN}/${results.length} PASS =====`);
  for (const r of results) if (!r.pass) log(`  FAIL ${r.name}: ${r.detail}`);
  process.exit(passN === results.length ? 0 : 1);
})().catch((e) => { console.error("CLIENT ERROR:", e); process.exit(2); });
