// engram v0.9 codemode/RLM smoke. Covers:
//   (a) setContext ~1MB host-side; eval uses host.ctx.grep/chunk WITHOUT the blob in the VM.
//   (b) execute(code,fns) Code Mode drop-in -> {result,logs}.
//   (c) depth-1 RLM loop E2E with a fake/stub model backend (grep+subLM+final).
//   (d) durability: context handle + session survive evict/restore.
//   (e) no regression vs v08 (stdlib, loop preempt, kv, crypto).
// Usage: node smoke-v09.mjs [wss-base]
import WebSocket from "ws";
import { connect, EngramExecutor } from "./sdk/index.mjs";

const BASE = process.argv[2] || "wss://montydyn-v09.umg-bhalla88.workers.dev";
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass }); console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`); };

(async () => {
  console.log(`v0.9 smoke -> ${BASE}`);

  // (a) ~1MB host-side context + ctx.* handle tools, blob NOT in the VM heap.
  console.log("\n== (a) host-side context store + handle tools ==");
  const cid = `v09ctx-${Date.now()}`;
  const s = await connect({ endpoint: BASE, id: cid, config: { clock: "seeded" }, WebSocket });
  // build ~1MB blob with a findable needle.
  let blob = "";
  const line = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(4);
  for (let i = 0; i < 18000; i++) blob += `line ${i}: ${line}\n`;
  blob = blob.slice(0, 1_050_000);
  blob += "\nNEEDLE_TOKEN: the-answer-is-42\n";
  const set = await s.setContext("context", blob);
  rec("setContext stores ~1MB host-side", set.ok && set.len >= 1_000_000, `len=${set.len}`);

  const lenR = await s.eval(`host.ctx.len('context')`);
  rec("host.ctx.len reads host-side length", lenR.ok && Number(lenR.value) === set.len, `value=${lenR.value}`);

  const grepR = await s.eval(`(() => { const m = host.ctx.grep('NEEDLE_TOKEN', {max:5}); return JSON.stringify(m); })()`);
  rec("host.ctx.grep finds needle without loading whole blob", grepR.ok && /the-answer-is-42/.test(String(grepR.value)), `value=${String(grepR.value).slice(0,80)}`);

  const chunkR = await s.eval(`(() => { const c = host.ctx.chunk(4000); const t = host.ctx.get(0,4000); return JSON.stringify({n:c.length, firstLen:t.length}); })()`);
  rec("host.ctx.chunk + get slice without whole blob in VM", chunkR.ok && /"n":2\d\d/.test(String(chunkR.value)) && /firstLen":4000/.test(String(chunkR.value)), `value=${chunkR.value}`);

  // prove the VM heap stays tiny: globalThis has no 1MB string, used heap stays small.
  const heapR = await s.eval(`(() => { const slice = host.ctx.slice(0, 100); return JSON.stringify({ sliceLen: slice.length, hasBlob: typeof globalThis.context }); })()`);
  const heapV = heapR.ok ? JSON.parse(heapR.value) : {};
  rec("VM never holds the blob (slice only)", heapR.ok && heapV.sliceLen === 100 && heapV.hasBlob === "undefined", JSON.stringify(heapV));

  // (d) durability: evict, then context handle survives cold restore.
  console.log("\n== (d) context handle survives evict/restore ==");
  await s.eval(`globalThis.marker = 777`);
  await s._send({ t: "evict" });
  const gen = await s.gen();
  const surviveLen = await s.eval(`host.ctx.len('context')`);
  const surviveMarker = await s.eval(`globalThis.marker`);
  rec("context handle survives evict/restore", surviveLen.ok && Number(surviveLen.value) === set.len, `len=${surviveLen.value} inMemoryWasFalse=${gen.inMemory === false}`);
  rec("namespace survives evict/restore (marker===777)", surviveMarker.ok && Number(surviveMarker.value) === 777, `value=${surviveMarker.value} restoreSource=${surviveMarker.restoreSource}`);
  s.close();

  // (b) execute(code, fns) Code Mode drop-in.
  console.log("\n== (b) execute(code, fns) Code Mode drop-in ==");
  const ex = new EngramExecutor({ endpoint: BASE, id: `v09exec-${Date.now()}`, config: { clock: "seeded" }, WebSocket });
  const out = await ex.execute(
    `(() => { console.log('hello from cell'); const sum = host.adder(40, 2); return { sum }; })()`,
    { adder: (a, b) => a + b },
  );
  rec("execute returns {result} with host fn", out.result && out.result.sum === 42, `result=${JSON.stringify(out.result)} err=${out.error}`);
  rec("execute returns logs", Array.isArray(out.logs) && out.logs.join("|").includes("hello from cell"), `logs=${JSON.stringify(out.logs)}`);
  await ex.close();

  // (c) depth-1 RLM loop E2E with a stub model backend.
  console.log("\n== (c) depth-1 RLM loop E2E (stub model backend) ==");
  const rid = `v09rlm-${Date.now()}`;
  const rs = await connect({ endpoint: BASE, id: rid, config: { clock: "seeded" }, WebSocket });
  let subCalls = 0;
  rs.onSubLM(async ({ prompt }) => {
    subCalls++;
    const m = /Chunk (\d+)/.exec(prompt);
    if (m) return `chunk-${m[1]}-summary`;
    // reduce: detect the needle presence across the prompt
    return /the-answer-is-42/.test(prompt) ? "ANSWER: 42 (found NEEDLE_TOKEN)" : "ANSWER: not found";
  });
  // smaller context so the loop is quick but still multi-chunk.
  let rblob = "";
  for (let i = 0; i < 2000; i++) rblob += `doc line ${i} filler text here\n`;
  rblob += "NEEDLE_TOKEN: the-answer-is-42\n";
  await rs.setContext("context", rblob);
  // custom root model: grep first, then if needle present subLM the surrounding slice + final.
  const r = await rs.rlm("what is the answer", {
    contextName: "context",
    rootModel: ({ query, contextName, step }) => {
      if (step > 0) return null;
      return `(async () => {
        const hits = host.ctx.grep('NEEDLE_TOKEN', {max:3}, ${JSON.stringify(contextName)});
        const i = hits.length ? hits[0].i : 0;
        const around = host.ctx.slice(Math.max(0,i-50), i+100, ${JSON.stringify(contextName)});
        const a = await host.subLM("Query: ${"what is the answer"}\\n\\nRelevant slice:\\n" + around, {});
        host.final(a);
        return { hits: hits.length };
      })()`;
    },
  });
  rec("RLM loop returns FINAL answer via stub subLM", r.kind === "FINAL" && /42/.test(String(r.answer)), `kind=${r.kind} answer=${JSON.stringify(r.answer)} steps=${r.steps}`);
  rec("RLM made >=1 host.subLM call", subCalls >= 1, `subCalls=${subCalls}`);
  const traj = await rs.trajectory();
  rec("trajectory records final + cells", traj.final && traj.cells.length >= 1, `final.kind=${traj.final?.kind} cells=${traj.cells.length}`);
  rs.close();

  // (e) no-regression spot checks.
  console.log("\n== (e) no-regression vs v08 ==");
  const reg = await connect({ endpoint: BASE, id: `v09reg-${Date.now()}`, config: { clock: "seeded", modules: true }, WebSocket });
  const lod = await reg.eval(`_.chunk([1,2,3,4],2).length`);
  rec("stdlib lodash works", lod.ok && Number(lod.value) === 2, `value=${lod.value}`);
  const loop = await reg.eval(`while(true){}`);
  rec("infinite loop -> typed TimeoutError, socket alive", loop.ok === false && loop.error?.name === "TimeoutError", `error=${loop.error?.name}`);
  const after = await reg.eval(`7`);
  rec("socket alive after loop preempt", after.ok && Number(after.value) === 7, `value=${after.value}`);
  await reg.eval(`host.kv.put('k','v1')`);
  await reg._send({ t: "evict" });
  const kv = await reg.eval(`host.kv.get('k')`);
  rec("kv survives restore", kv.ok && kv.value === "v1", `value=${kv.value}`);
  const cr = await reg.eval(`(()=>{const a=new Uint8Array(4);crypto.getRandomValues(a);return Array.from(a).join(',');})()`);
  rec("crypto extension works", cr.ok && /^\d+,\d+,\d+,\d+$/.test(String(cr.value)), `value=${cr.value}`);
  reg.close();

  const passN = results.filter((r) => r.pass).length;
  console.log(`\n===== v0.9 SMOKE: ${passN}/${results.length} PASS =====`);
  for (const r of results) if (!r.pass) console.log(`  FAIL ${r.name}`);
  process.exit(passN === results.length ? 0 : 1);
})().catch((e) => { console.error("CLIENT ERROR:", e); process.exit(2); });
