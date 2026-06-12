// Live verification: stack-depth ceiling + hash-worker invoke + regression.
import WS from "ws";
import { Engram } from "../../../packages/sdk/src/index.ts";

const URL = process.env.ENGRAM_URL || "wss://engram.umgbhalla.xyz";
const KEY = process.env.ENGRAM_KERNEL_KEY;
if (!KEY) { console.error("FATAL: ENGRAM_KERNEL_KEY unset"); process.exit(2); }

const log = (...a) => console.log(...a);
const failures = [];
const check = (name, cond, extra = "") => {
  log(`${cond ? "PASS " : "FAIL "} ${name} ${extra}`);
  if (!cond) failures.push(`${name} ${extra}`);
};

const cfg = { fs: { provider: "r2" }, fetch: true };
const mk = (suffix) => Engram.connect({
  url: URL, session: `verify-${suffix}-${crypto.randomUUID()}`,
  kernelKey: KEY, WebSocket: WS, config: cfg, timeoutMs: 90000,
  throwOnError: false,
});

// ───────────────────────── STACK DEPTH ─────────────────────────
// runs one recursion at depth N on a fresh warmed session, returns
// {ok, value, name, msg, warmOk, unreachable}
async function probeDepth(N) {
  const s = await mk(`depth-${N}`);
  try {
    // warmup so the cold-create cost isn't charged to the recursion request
    const w0 = await s.eval(`1`, { timeoutMs: 90000 });
    if (!w0.ok) return { ok: false, name: "warmup-failed", msg: JSON.stringify(w0.error) };
    const r = await s.eval(`function r(n){return n<=0?0:r(n-1)} r(${N})`, { timeoutMs: 90000 });
    const txt = `${r.error?.name} ${r.error?.message}`;
    const unreachable = /unreachable/i.test(txt);
    // warm check (no corruption)
    const warm = await s.eval(`1+1`, { timeoutMs: 90000 });
    const warmTxt = `${warm.error?.name} ${warm.error?.message}`;
    return {
      ok: r.ok, value: r.value, name: r.error?.name, msg: r.error?.message,
      unreachable, warmOk: warm.ok && warm.value === 2,
      warmUnreachable: /unreachable/i.test(warmTxt), warmRaw: { ok: warm.ok, v: warm.value, e: warm.error },
    };
  } catch (e) {
    return { ok: false, name: "CLIENT", msg: String(e?.message || e), unreachable: false, warmOk: false };
  } finally { try { await s.close(); } catch {} }
}

async function stackDepth() {
  log("\n=== STACK DEPTH ===");
  const Ns = [500, 1000, 2000, 3000, 5000];
  const results = {};
  let largestOk = 0, firstThrow = null;
  for (const N of Ns) {
    let rec = await probeDepth(N);
    if (rec.name === "CLIENT") { log(`  N=${N} transient (${rec.msg}); retry once`); rec = await probeDepth(N); }
    results[N] = rec;
    log(`N=${N}: ${JSON.stringify(rec)}`);
    const catchable = !rec.ok && /range|stack|recursion|internal|overflow/i.test(`${rec.name} ${rec.msg}`) && !rec.unreachable;
    if (rec.unreachable || rec.warmUnreachable) check(`N=${N} no 'unreachable' (uncatchable) trap`, false, JSON.stringify(rec));
    check(`N=${N} warm 1+1==2 (no corruption)`, rec.warmOk, JSON.stringify(rec.warmRaw));
    if (rec.ok && rec.value === 0) { if (N > largestOk) largestOk = N; }
    else if (catchable && firstThrow === null) firstThrow = N;
  }
  log(`largest probed N returning 0: ${largestOk}; first catchable throw at: ${firstThrow}`);

  // Binary-search the exact ceiling between largestOk (success) and firstThrow (catchable throw).
  let lo = largestOk, hi = firstThrow || largestOk * 2 || 4000, ceiling = largestOk;
  while (hi - lo > 100) {
    const mid = Math.floor((lo + hi) / 2);
    let rec = await probeDepth(mid);
    if (rec.name === "CLIENT") rec = await probeDepth(mid);
    log(`  bisect N=${mid}: ok=${rec.ok} value=${rec.value} err=${rec.name}:${rec.msg} warmOk=${rec.warmOk} unreachable=${rec.unreachable || rec.warmUnreachable}`);
    if (rec.unreachable || rec.warmUnreachable) { check(`bisect N=${mid} not uncatchable`, false, JSON.stringify(rec)); break; }
    check(`bisect N=${mid} warm intact`, rec.warmOk, JSON.stringify(rec.warmRaw));
    if (rec.ok && rec.value === 0) { lo = mid; ceiling = mid; } else { hi = mid; }
  }
  log(`exact ceiling ~= ${ceiling} (success); next catchable throw above it`);

  // beyond-ceiling MUST be a catchable error caught by an in-VM try/catch, socket alive
  const s3 = await mk("depth-beyond");
  let beyondCatchable = false, beyondRec = null;
  try {
    await s3.eval(`1`, { timeoutMs: 90000 });
    const bigN = (firstThrow || ceiling) + 2000;
    const r = await s3.eval(`(function(){try{ function r(n){return n<=0?0:r(n-1)} return {v:r(${bigN})}; }catch(e){ return {caught:e.name, msg:String(e.message).slice(0,60)} }})()`, { timeoutMs: 90000 });
    beyondRec = r.value;
    log(`beyond N=${bigN} (in-VM try/catch): ${JSON.stringify(r.value)} ok=${r.ok} err=${r.error?.name}:${r.error?.message}`);
    beyondCatchable = r.ok && r.value && r.value.caught && !/unreachable/i.test(`${r.value.caught} ${r.value.msg}`);
    const warm = await s3.eval(`3+4`, { timeoutMs: 90000 });
    check(`beyond warm 3+4==7 (socket alive, no corruption)`, warm.ok && warm.value === 7, JSON.stringify({ ok: warm.ok, v: warm.value, e: warm.error }));
  } finally { try { await s3.close(); } catch {} }
  check(`beyond-ceiling CATCHABLE (in-VM try/catch caught a recursion error, not 'unreachable')`, !!beyondCatchable, JSON.stringify(beyondRec));
  check(`depth ceiling clearly in the thousands (>1000)`, ceiling > 1000, `ceiling=${ceiling}`);
  return { ceiling, firstThrow, results, beyondRec };
}

// ───────────────────────── HASH WORKER ─────────────────────────
const WORKER_SRC = `export async function run(input, env){ return { n2: input.n*2, vfs: await env.VFS.readFile("/workspace/x").catch(()=>null) } }`;
async function hashWorker() {
  log("\n=== HASH WORKER ===");
  const s = await mk("hashw");
  let out = null;
  try {
    await s.writeFile("/workspace/x", "shared-vfs-content");
    const reg = await s.registerWorker(WORKER_SRC);
    check("register -> 64-hex hash", /^[0-9a-f]{64}$/.test(reg.hash), reg.hash);
    out = await s.invokeWorker(reg.hash, { n: 21 });
    log(`invoke output: ${JSON.stringify(out)}`);
    check("invoke n2==42 (no 'Body has already been used')", out && out.n2 === 42, `n2=${out?.n2}`);
    check("worker reads shared VFS /workspace/x", out && out.vfs === "shared-vfs-content", `vfs=${JSON.stringify(out?.vfs)}`);
  } catch (e) {
    log(`hashWorker threw: ${e?.message || e}`);
    check("hashWorker no throw", false, String(e?.message || e));
  } finally { try { await s.close(); } catch {} }
  return out;
}

// ───────────────────────── REGRESSION ─────────────────────────
async function regression() {
  log("\n=== REGRESSION ===");
  const s = await mk("regr");
  try {
    const ev = await s.eval(`40 + 2`); check("eval 40+2==42", ev.ok && ev.value === 42, `v=${ev.value}`);

    // vfs /workspace roundtrip
    await s.writeFile("/workspace/r.txt", "roundtrip-ok");
    const rb = new TextDecoder().decode(await s.readFile("/workspace/r.txt"));
    check("vfs /workspace roundtrip", rb === "roundtrip-ok", `read='${rb}'`);

    // net/tls require
    const net = await s.eval(`(()=>{const n=require('net'); const t=require('tls'); return typeof n==='object' && typeof t==='object'})()`);
    check("net/tls require", net.ok && net.value === true, JSON.stringify({ ok: net.ok, v: net.value, e: net.error }));

    // sha512
    const sha = await s.eval(`require('crypto').createHash('sha512').update('abc').digest('hex')`);
    const expect = "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f";
    check("sha512('abc') correct", sha.ok && sha.value === expect, `got=${String(sha.value).slice(0, 16)}...`);

    // use('nanoid')
    const nano = await s.eval(`(async()=>{const {nanoid}=await use('nanoid'); const id=nanoid(); return typeof id==='string' && id.length>=10})()`);
    check("use('nanoid')", nano.ok && nano.value === true, JSON.stringify({ ok: nano.ok, v: nano.value, e: nano.error?.message }));

    // TS generics (sucrase)
    const ts = await s.eval(`function id<T>(x: T): T { return x } const arr: Array<number> = [1,2,3]; id<number>(arr.length)`);
    check("TS generics (sucrase)", ts.ok && ts.value === 3, JSON.stringify({ ok: ts.ok, v: ts.value, e: ts.error?.message }));

    // state survives + durability hibernate+resume
    await s.eval(`globalThis.__verify_state = 12345`);
    const hr = await s.hibernateThenResume();
    log(`hibernate+resume: ${JSON.stringify(hr)}`);
    const after = await s.eval(`globalThis.__verify_state`);
    check("durability hibernate+resume (state survives)", after.ok && after.value === 12345, JSON.stringify({ ok: after.ok, v: after.value, gen: hr?.generation, src: hr?.restoreSource }));

    // while(true) -> TimeoutError
    const wt = await s.eval(`while(true){}`, { timeoutMs: 90000 });
    check("while(true) -> TimeoutError (catchable, socket alive)", !wt.ok && /timeout/i.test(`${wt.error?.name} ${wt.error?.message}`), JSON.stringify({ ok: wt.ok, e: wt.error }));
    const warmA = await s.eval(`5+5`); check("warm after while(true) 5+5==10", warmA.ok && warmA.value === 10, JSON.stringify({ ok: warmA.ok, v: warmA.value }));

    // big-alloc -> MemoryLimitError
    const ba = await s.eval(`const a=[]; while(true){ a.push(new Array(1000000).fill(7)) }`, { timeoutMs: 90000 });
    check("big-alloc -> MemoryLimitError/SizeAdmission (catchable)", !ba.ok && /(memory|size|admission|limit)/i.test(`${ba.error?.name} ${ba.error?.message}`), JSON.stringify({ ok: ba.ok, e: ba.error }));
    const warmB = await s.eval(`6+6`); check("warm after big-alloc 6+6==12", warmB.ok && warmB.value === 12, JSON.stringify({ ok: warmB.ok, v: warmB.value }));
  } catch (e) {
    log(`regression threw: ${e?.message || e}`);
    check("regression no unexpected throw", false, String(e?.message || e));
  } finally { try { await s.close(); } catch {} }
}

const depth = await stackDepth();
const hw = await hashWorker();
await regression();

log("\n=== SUMMARY ===");
log(`depthCeiling: ${depth.ceiling}`);
log(`failures (${failures.length}): ${JSON.stringify(failures, null, 2)}`);
log(`RESULT: ${failures.length === 0 ? "ALL PASS" : "FAILURES"}`);
process.exit(failures.length === 0 ? 0 : 1);
