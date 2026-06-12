// Live smoke: worker registry over the shared R2 VFS in a DWL isolate.
import WS from "ws";
import { Engram } from "../../../packages/sdk/src/index.ts";

const URL = process.env.ENGRAM_URL || "wss://engram.umgbhalla.xyz";
const KEY = process.env.ENGRAM_KERNEL_KEY;
if (!KEY) { console.error("FATAL: ENGRAM_KERNEL_KEY unset"); process.exit(2); }

const log = (...a) => console.log(...a);
let failures = [];
const check = (name, cond, extra = "") => {
  if (cond) log(`PASS  ${name} ${extra}`);
  else { log(`FAIL  ${name} ${extra}`); failures.push(name + " " + extra); }
};

// Worker source: reads input.n, reads /in.txt from shared VFS, uppercases -> /out.txt, returns n*2.
const WORKER_SRC = `
export async function run(input, env) {
  const result = { n2: (input && typeof input.n === "number") ? input.n * 2 : null };
  try {
    const txt = await env.VFS.readFile("/in.txt");
    if (txt != null) {
      const up = String(txt).toUpperCase();
      await env.VFS.writeFile("/out.txt", up);
      result.wrote = up;
    } else {
      result.wrote = null;
    }
  } catch (e) {
    result.vfsError = String((e && e.message) || e);
  }
  return result;
}
`.trim();

const session = "smoke-" + crypto.randomUUID();
log("session:", session);
log("=== WORKER SOURCE ===\n" + WORKER_SRC + "\n=====================");

const s = await Engram.connect({
  url: URL,
  session,
  kernelKey: KEY,
  WebSocket: WS,
  config: { fs: { provider: "r2" }, fetch: true },
  timeoutMs: 60000,
});
log("connected, status:", JSON.stringify(await s.status()));

try {
  // 1) register -> stable sha256 hex
  const reg1 = await s.registerWorker(WORKER_SRC);
  log("register#1:", JSON.stringify(reg1));
  check("hash is 64-hex sha256", /^[0-9a-f]{64}$/.test(reg1.hash), reg1.hash);

  // idempotency
  const reg2 = await s.registerWorker(WORKER_SRC);
  log("register#2:", JSON.stringify(reg2));
  check("idempotent hash (same source -> same hash)", reg1.hash === reg2.hash, `${reg1.hash}===${reg2.hash}`);
  check("second register cached", reg2.cached === true, `cached=${reg2.cached}`);

  // 2) shared-VFS roundtrip: write /in.txt host-side, invoke, read /out.txt back
  await s.writeFile("/in.txt", "hello");
  const back = new TextDecoder().decode(await s.readFile("/in.txt"));
  check("host writeFile/readFile roundtrip (/in.txt)", back === "hello", `read='${back}'`);

  const out1 = await s.invokeWorker(reg1.hash, { n: 21 });
  log("invoke#1 output:", JSON.stringify(out1));
  check("invoke returns input.n*2 == 42", out1 && out1.n2 === 42, `n2=${out1 && out1.n2}`);
  check("worker read shared /in.txt + uppercased", out1 && out1.wrote === "HELLO", `wrote='${out1 && out1.wrote}'`);

  // read /out.txt the worker wrote into the SHARED VFS (host-side)
  const outTxt = new TextDecoder().decode(await s.readFile("/out.txt"));
  log("host read /out.txt:", JSON.stringify(outTxt));
  check("shared-VFS roundtrip: /out.txt == 'HELLO'", outTxt === "HELLO", `out='${outTxt}'`);

  // also confirm a cell sees the gateway-written file (host.fs in-VM)
  const cellSees = await s.eval(`globalThis.__fsRead ? __fsRead('/out.txt') : 'n/a'`).catch(() => ({ value: "evalErr" }));
  log("cell view of /out.txt (best-effort):", JSON.stringify(cellSees.value));

  // 3) isolation: a hash-worker cannot read another session's prefix.
  // Best-effort structural proof: paths are scoped fs/<doId>/ and the worker only gets env.VFS
  // (no raw bucket). We assert the worker cannot escape via "../" (gateway normalizes).
  const ESCAPE_SRC = `
export async function run(input, env) {
  try {
    const a = await env.VFS.readFile("../../etc/secret");
    const b = await env.VFS.readFile("/../../other/in.txt");
    return { escapeRead: a, escapeRead2: b };
  } catch (e) { return { blocked: String((e && e.message) || e) }; }
}`.trim();
  const escReg = await s.registerWorker(ESCAPE_SRC);
  const escOut = await s.invokeWorker(escReg.hash, {});
  log("isolation probe output:", JSON.stringify(escOut));
  check("path-escape normalized (no cross-prefix read)",
    !escOut || (escOut.escapeRead == null && escOut.escapeRead2 == null), JSON.stringify(escOut));

  // cross-session prefix isolation: session B (different session id -> different doId) must NOT
  // see session A's file. Session A wrote /in.txt='hello'; B reads /in.txt via the SAME worker.
  const sessionB = "smoke-iso-" + crypto.randomUUID();
  const sB = await Engram.connect({
    url: URL, session: sessionB, kernelKey: KEY, WebSocket: WS,
    config: { fs: { provider: "r2" }, fetch: true }, timeoutMs: 60000,
  });
  try {
    const regB = await sB.registerWorker(WORKER_SRC);
    check("cross-session: same source -> same hash (content-addressed)", regB.hash === reg1.hash, `${regB.hash}`);
    const outB = await sB.invokeWorker(regB.hash, { n: 5 });
    log("session-B invoke output:", JSON.stringify(outB));
    // B's VFS prefix is empty -> reads null, does NOT see A's 'hello' / 'HELLO'.
    check("cross-session prefix isolation: B cannot read A's /in.txt",
      outB && outB.wrote === null, `wrote='${outB && outB.wrote}'`);
  } finally { try { await sB.close?.(); } catch {} }

  // 4) regressions: normal eval, vfs write/read, net/tls resolve
  const ev = await s.eval(`1 + 2`);
  check("regression: normal eval (1+2==3)", ev.value === 3, `value=${ev.value}`);

  await s.writeFile("/reg.txt", "regression-data");
  const rb = new TextDecoder().decode(await s.readFile("/reg.txt"));
  check("regression: vfs writeFile/readFile", rb === "regression-data", `read='${rb}'`);

  const net = await s.eval(`(() => { try { const n = require('net'); const t = require('tls'); return !!n && !!t; } catch(e){ return 'ERR:'+e.message; } })()`);
  check("regression: net/tls resolve", net.value === true, `value=${JSON.stringify(net.value)}`);

  log("\n=== SUMMARY ===");
  log(failures.length === 0 ? "ALL PASS" : `FAILURES (${failures.length}): ` + JSON.stringify(failures));
} catch (e) {
  log("FATAL ERROR:", e && (e.stack || e.message || String(e)));
  failures.push("FATAL: " + (e && (e.message || String(e))));
} finally {
  try { await s.close?.(); } catch {}
  process.exit(failures.length === 0 ? 0 : 1);
}
