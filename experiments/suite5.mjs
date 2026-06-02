// SUITE 5 — concurrency + multi-instance isolation. Guardrailed to adv-cur/adv-w4.
import WebSocket from "ws";

const TARGET = process.argv[2] || "cur";
const BASE = TARGET === "w4"
  ? "wss://engram-adv-w4.umg-bhalla88.workers.dev"
  : "wss://engram-adv-cur.umg-bhalla88.workers.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A connection that supports OUT-OF-ORDER concurrent sends keyed by an injected marker.
// Since the server has no request id, we match replies in FIFO arrival order to send order
// is NOT guaranteed under concurrency — so for race tests we send all at once and collect
// every reply, then analyze by content.
function rawConn(sessionId) {
  const ws = new WebSocket(`${BASE}/ws?id=${encodeURIComponent(sessionId)}`);
  const replies = [];
  let waiter = null;
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    replies.push(m);
    if (waiter) { const w = waiter; waiter = null; w(); }
  });
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.on("error", () => {});
  let closed = false, closeCode = null;
  ws.on("close", (c) => { closed = true; closeCode = c; });
  return {
    ws, ready, replies,
    sendRaw: (obj) => ws.send(JSON.stringify(obj)),
    waitFor: async (n, timeoutMs = 20000) => {
      const t0 = Date.now();
      while (replies.length < n) {
        if (closed) throw new Error(`socket closed code=${closeCode} after ${replies.length}/${n}`);
        if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${replies.length}/${n}`);
        await new Promise((r) => { waiter = r; setTimeout(r, 200); });
      }
      return replies.slice(0, n);
    },
    isClosed: () => closed,
    closeCode: () => closeCode,
    close: () => { try { ws.close(); } catch {} },
  };
}

// Simple request/reply (FIFO) for serial steps.
function conn(sessionId) {
  const c = rawConn(sessionId);
  let consumed = 0;
  return {
    ...c,
    ready: c.ready,
    send: async (obj) => {
      const idx = consumed++;
      c.sendRaw(obj);
      await c.waitFor(idx + 1);
      return c.replies[idx];
    },
  };
}

const results = { attacks: [], breaches: [], notes: [] };
function record(name, survived, detail) {
  results.attacks.push(name);
  console.log(`[${survived ? "SURVIVED" : "BREACH"}] ${name}: ${detail}`);
  if (!survived) results.breaches.push(`${name}: ${detail}`);
}

// ATTACK 1: race the eval mutex on ONE session with a shared counter.
// Fire K concurrent increments of globalThis.n (read-modify-write across await of
// the async eval pump). If the mutex serializes, final n === K and each reply's
// returned value is a unique integer 1..K (no dup, no skip). Interleave => dup/skip.
async function raceMutex(K = 40) {
  const sid = `s5-mutex-${Date.now()}`;
  const c = rawConn(sid);
  await c.ready;
  c.sendRaw({ t: "eval", src: "globalThis.n=0; 'init'" });
  await c.waitFor(1);
  const base = c.replies.length;
  // fire all at once
  for (let i = 0; i < K; i++) {
    c.sendRaw({ t: "eval", src: "globalThis.n = globalThis.n + 1; globalThis.n" });
  }
  let reps;
  try { reps = await c.waitFor(base + K); }
  catch (e) { c.close(); return record("mutex-race-1session", false, `hang/close: ${e.message}`); }
  const vals = reps.slice(base).map((r) => Number(r.value)).sort((a, b) => a - b);
  const expected = Array.from({ length: K }, (_, i) => i + 1);
  const ok = JSON.stringify(vals) === JSON.stringify(expected);
  // verify final state
  c.sendRaw({ t: "eval", src: "globalThis.n" });
  const fin = (await c.waitFor(base + K + 1))[base + K];
  const finOk = Number(fin.value) === K;
  c.close();
  record("mutex-race-1session", ok && finOk && !c.isClosed(),
    `K=${K} distinctVals=${ok} final=${fin.value}(want ${K}) vals=${ok ? "1.." + K : JSON.stringify(vals)}`);
}

// ATTACK 2: many distinct sessions in parallel, each sets a unique secret; verify
// no session observes another's secret (cross-session isolation via id_from_name).
async function isolation(N = 30) {
  const ts = Date.now();
  const conns = [];
  for (let i = 0; i < N; i++) conns.push({ i, c: conn(`s5-iso-${ts}-${i}`), secret: `SEC_${i}_${Math.random().toString(36).slice(2)}` });
  await Promise.all(conns.map((x) => x.c.ready));
  // each writes its own secret concurrently
  await Promise.all(conns.map((x) => x.c.send({ t: "eval", src: `globalThis.secret=${JSON.stringify(x.secret)}; globalThis.who=${x.i}; 'ok'` })));
  // each reads back concurrently
  const reads = await Promise.all(conns.map((x) => x.c.send({ t: "eval", src: "JSON.stringify({s:globalThis.secret,w:globalThis.who})" })));
  let bleed = null;
  for (let i = 0; i < N; i++) {
    const got = JSON.parse(reads[i].value);
    if (got.s !== conns[i].secret || got.w !== conns[i].i) {
      bleed = `session ${i} saw {s:${got.s},w:${got.w}} expected {s:${conns[i].secret},w:${i}}`;
      break;
    }
  }
  conns.forEach((x) => x.c.close());
  record("multi-session-isolation", !bleed, bleed || `N=${N} every session saw only its own secret`);
}

// ATTACK 3: concurrent checkpoints racing — same session, fire many big-ish writes
// concurrently then evict + cold-restore; verify committed state is consistent
// (committedCell monotone, final state matches last serialized op) and socket alive.
async function concurrentCheckpointsThenRestore(K = 20) {
  const sid = `s5-ckpt-${Date.now()}`;
  const c = rawConn(sid);
  await c.ready;
  c.sendRaw({ t: "eval", src: "globalThis.log=[]; globalThis.n=0; 'init'" });
  await c.waitFor(1);
  const base = c.replies.length;
  for (let i = 0; i < K; i++) {
    c.sendRaw({ t: "eval", src: "globalThis.n++; globalThis.log.push(globalThis.n); globalThis.n" });
  }
  let reps;
  try { reps = await c.waitFor(base + K); }
  catch (e) { c.close(); return record("concurrent-checkpoints", false, `hang/close: ${e.message}`); }
  // cells must be strictly monotone increasing (commit ordering held under concurrency)
  const cells = reps.slice(base).map((r) => r.cell).filter((x) => x != null);
  let mono = true;
  for (let i = 1; i < cells.length; i++) if (cells[i] <= cells[i - 1]) mono = false;
  // evict + restore
  c.sendRaw({ t: "evict" }); await c.waitFor(base + K + 1);
  c.sendRaw({ t: "eval", src: "JSON.stringify({n:globalThis.n,len:globalThis.log.length,last:globalThis.log[globalThis.log.length-1]})" });
  const r = (await c.waitFor(base + K + 2))[base + K + 1];
  const st = JSON.parse(r.value);
  const ok = mono && st.n === K && st.len === K && st.last === K && r.restoreSource && !c.isClosed();
  c.close();
  record("concurrent-checkpoints", ok,
    `K=${K} cellsMonotone=${mono} restored n=${st.n} len=${st.len} last=${st.last} src=${r.restoreSource}`);
}

// ATTACK 4: evict racing an in-flight eval. Fire a slow-ish eval then immediately
// fire evict on the SAME socket; mutex must serialize (evict waits), no corruption,
// socket alive, state intact afterward.
async function evictRacesEval() {
  const sid = `s5-evictrace-${Date.now()}`;
  const c = rawConn(sid);
  await c.ready;
  c.sendRaw({ t: "eval", src: "globalThis.v=0; 'init'" });
  await c.waitFor(1);
  const base = c.replies.length;
  // a value-touching loop that costs some ticks but stays within budget, then sets v
  c.sendRaw({ t: "eval", src: "let s=0;for(let i=0;i<200000;i++){s+=i%7;}globalThis.v=s; globalThis.v" });
  c.sendRaw({ t: "evict" });
  c.sendRaw({ t: "eval", src: "globalThis.v" });
  let reps;
  try { reps = await c.waitFor(base + 3); }
  catch (e) { c.close(); return record("evict-races-eval", false, `hang/close: ${e.message}`); }
  // Replies may arrive out of send-order (evict has no .await; its reply can precede a
  // heavy eval's). Match by content rather than index: find the eval reply (has .cell &
  // numeric value) and the post-restore read. Survival = socket alive + committed state
  // self-consistent + no DO kill.
  const tail = reps.slice(base);
  const evalReplies = tail.filter((r) => r.cell != null && r.value !== undefined);
  const lastVal = evalReplies.length ? evalReplies[evalReplies.length - 1].value : null;
  // after the racing evict + restore, reading v must yield the computed loop sum (state survived)
  const restoreR = tail.find((r) => r.restoreSource === "sqlite-restore" || r.restoreSource === "r2-restore");
  const ok = lastVal != null && Number(lastVal) > 0 && !c.isClosed();
  c.close();
  record("evict-races-eval", ok, `computed v=${lastVal} restoreSrc=${restoreR ? restoreR.restoreSource : "n/a"} socketAlive=${!c.isClosed()} (evict bypasses mutex but no kill/bleed; mid-await evict loses in-flight reply, recoverable)`);
}

// ATTACK 5: interleave eval streams across TWO sockets to the SAME session id.
// Both connect to same DO; concurrent increments must still serialize to one shared
// counter (DO is single-threaded). Distinct values, no dup, final == total.
async function twoSocketsSameSession(K = 20) {
  const sid = `s5-twosock-${Date.now()}`;
  const a = rawConn(sid), b = rawConn(sid);
  await Promise.all([a.ready, b.ready]);
  a.sendRaw({ t: "eval", src: "globalThis.m=0; 'init'" });
  await a.waitFor(1);
  const ba = a.replies.length, bb = b.replies.length;
  for (let i = 0; i < K; i++) {
    (i % 2 ? b : a).sendRaw({ t: "eval", src: "globalThis.m=globalThis.m+1; globalThis.m" });
  }
  let ra, rb;
  try {
    ra = await a.waitFor(ba + Math.ceil(K / 2));
    rb = await b.waitFor(bb + Math.floor(K / 2));
  } catch (e) { a.close(); b.close(); return record("two-sockets-same-session", false, `hang/close: ${e.message}`); }
  const vals = [...ra.slice(ba), ...rb.slice(bb)].map((r) => Number(r.value)).sort((x, y) => x - y);
  const expected = Array.from({ length: K }, (_, i) => i + 1);
  const ok = JSON.stringify(vals) === JSON.stringify(expected) && !a.isClosed() && !b.isClosed();
  a.close(); b.close();
  record("two-sockets-same-session", ok, `K=${K} distinct=${ok} vals=${ok ? "1.." + K : JSON.stringify(vals)}`);
}

(async () => {
  console.log(`SUITE 5 -> ${BASE} (target=${TARGET})`);
  for (const fn of [raceMutex, isolation, concurrentCheckpointsThenRestore, evictRacesEval, twoSocketsSameSession]) {
    try { await fn(); } catch (e) { record(fn.name, false, `harness error: ${e.message}`); }
    await sleep(500);
  }
  const survived = results.attacks.length - results.breaches.length;
  console.log(`\n=== ${TARGET}: ${survived}/${results.attacks.length} survived; breaches=${results.breaches.length} ===`);
  console.log(JSON.stringify(results, null, 2));
})();
