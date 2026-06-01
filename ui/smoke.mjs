// Smoke: exercises the EXACT protocol + RLM loop the UI uses, against the live v092 kernel.
import WebSocket from "ws";
const BASE = "wss://montydyn-v092.umg-bhalla88.workers.dev";
const SID = "ui-smoke-" + Math.random().toString(36).slice(2, 8);

function conn(id) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(id)}`);
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (m, t = 120000) => new Promise((res, rej) => {
    const onMsg = (d) => { clearTimeout(timer); ws.off("message", onMsg); res(JSON.parse(d.toString())); };
    const timer = setTimeout(() => { ws.off("message", onMsg); rej(new Error("timeout")); }, t);
    ws.on("message", onMsg); ws.send(JSON.stringify(m));
  });
  return { ws, ready, send, close: () => ws.close() };
}

const SHIM = `(() => { globalThis.__subLM_answers=globalThis.__subLM_answers||{}; globalThis.__subLM_queue=[];
  const P="__SUBLM_PENDING__"; const k=(p,o)=>{try{return JSON.stringify([p,o||null]);}catch(_){return String(p);}};
  globalThis.host=new Proxy(globalThis.host,{get(t,n){ if(n==='subLM') return (p,o)=>{const kk=k(String(p),o);
    if(Object.prototype.hasOwnProperty.call(globalThis.__subLM_answers,kk))return Promise.resolve(globalThis.__subLM_answers[kk]);
    globalThis.__subLM_queue.push({id:kk,prompt:String(p),opts:o||null}); throw P;}; return t[n];}});
  globalThis.__subLM_run=(c)=>{globalThis.__subLM_queue=[];try{return eval(c);}catch(e){if(e===P||(e&&e.message===P))return{__pending:true};throw e;}};
  globalThis.__subLM_pending=()=>globalThis.__subLM_queue.slice();
  globalThis.__subLM_fulfill=(a)=>{Object.assign(globalThis.__subLM_answers,a);return Object.keys(a).length;}; return 'ok'; })()`;

const root = (q) => `(async () => { const name="context", q=${JSON.stringify(q)};
  const chunks=host.ctx.chunk(4000,name); const parts=[];
  for (const c of chunks){ const text=host.ctx.get(c.i,4000,name);
    parts.push(await host.subLM("Query: "+q+"\\n\\nChunk "+c.i+":\\n"+text,{chunk:c.i})); }
  const answer=await host.subLM("Query: "+q+"\\n\\nReduce these partials into ONE answer:\\n"+parts.join("\\n---\\n"),{reduce:true});
  host.final(answer); return {nChunks:chunks.length}; })()`;

function clientSubLM(q, prompt) {
  if (/Reduce these partials/.test(prompt)) {
    const lines = prompt.split("\n").filter(l => l && !/^Query:|^Reduce|^---/.test(l));
    const hit = lines.find(l => !/not found/i.test(l) && /[A-Z]{2,}-?\d|code/i.test(l));
    return hit ? hit.trim() : (lines[0]||"not found").trim();
  }
  const m = prompt.match(/\b([A-Z]{3,}-\d{3,}|[A-Z0-9]{4,}-[A-Z0-9]{2,})\b/);
  return m ? "Found: the code is " + m[1] : "not found in this chunk";
}

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? "PASS " : "FAIL ") + m); };

(async () => {
  // 1) connect + config + eval (durable counter)
  let c = conn(SID); await c.ready;
  await c.send({ t: "create", config: { clock: "seeded", rngSeed: 42, modules: true, fetch: false } });
  const e1 = await c.send({ t: "eval", src: "globalThis.n=(globalThis.n||0)+1; n" });
  ok(e1.ok && (e1.value == 1 || e1.valuePreview == 1), `eval counter -> ${e1.value}`);
  const e2 = await c.send({ t: "eval", src: "globalThis.inc=()=>++n; inc()" });
  ok(e2.value == 2 || e2.valuePreview == 2, `closure inc() -> ${e2.value}`);

  // 2) hibernate (evict in-memory) then reconnect -> state restored, NO replay
  await c.send({ t: "evict" });
  c.close();
  await new Promise(r => setTimeout(r, 400));
  c = conn(SID); await c.ready;
  const g = await c.send({ t: "gen" });
  ok(g.inMemory === false, `after evict+reconnect inMemory=false (cold) gen=${g.generation}`);
  const e3 = await c.send({ t: "eval", src: "inc()" });
  ok(e3.value == 3 || e3.valuePreview == 3, `state restored: inc() -> ${e3.value} (expect 3, no replay)`);
  ok(e3.inMemoryBefore === false, `eval cold-restored (restoreSource=${e3.restoreSource})`);

  // 3) RLM needle-in-context -> FINAL
  const ctx = "Filler about synergy. Buried deep the secret access code is ZEBRA-7741. More filler.";
  const q = "What is the secret access code?";
  await c.send({ t: "setContext", name: "context", blob: ctx });
  await c.send({ t: "eval", src: SHIM });
  await c.send({ t: "eval", src: "globalThis.__subLM_answers={};globalThis.__subLM_queue=[];0" });
  const code = root(q);
  let calls = 0;
  for (let p = 0; p < 200; p++) {
    await c.send({ t: "eval", src: `globalThis.__subLM_run(${JSON.stringify(code)})` });
    const pend = await c.send({ t: "eval", src: `JSON.stringify(globalThis.__subLM_pending())` });
    let reqs = []; try { reqs = JSON.parse(pend.value); } catch (_) {}
    if (!reqs.length) break;
    const ans = {}; for (const r of reqs) { calls++; ans[r.id] = clientSubLM(q, r.prompt); }
    await c.send({ t: "eval", src: `globalThis.__subLM_fulfill(${JSON.stringify(ans)})` });
  }
  const fin = await c.send({ t: "final" });
  const f = fin.final && fin.final.kind ? fin.final : null;
  ok(f && /ZEBRA-7741/.test(String(f.value)), `RLM FINAL needle: ${f ? f.value : "none"} (subLM calls=${calls})`);

  c.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERR", e); process.exit(2); });
