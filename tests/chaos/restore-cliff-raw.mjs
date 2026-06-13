// restore-cliff-raw.mjs — DEEP TEST via RAW WebSocket (no SDK reconnect layer, which flakes on
// multi-eval sessions with "ws connect failed"). Measures the real cold-restore transient-OOM
// cliff. See docs/CHAOS-CASE1-VERDICT.md.
//
// Per trial at N MB: open raw ws -> spike linear buffer to ~N MB MOSTLY-ZERO content (low
// incompressible, so the 24MB gate ADMITS) -> free -> {t:evict} (commits + drops the live kernel)
// -> reopen raw ws -> eval canary (forces cold restore). Survives => restorable; socket
// death/1006/timeout => CLIFF (silent-loss risk); typed SizeAdmissionError => guard caught (safe).
//
//   ENGRAM_KERNEL_KEY=...  node tests/chaos/restore-cliff-raw.mjs [loMB] [hiMB] [stepMB]
//   defaults: 16 76 8  (+78 cap probe)

import WebSocket from "ws";
const KK = process.env.ENGRAM_KERNEL_KEY;
if (!KK) { console.error("ENGRAM_KERNEL_KEY required"); process.exit(2); }
const HOST = (process.env.ENGRAM_URL ?? "wss://engram.umgbhalla.xyz").replace(/^http/i, "ws");
const MB = 1024 * 1024;
const lo = Number(process.argv[2] ?? 16), hi = Number(process.argv[3] ?? 76), step = Number(process.argv[4] ?? 8);
const seed = `${Math.floor(performance.now())}-${Math.floor(performance.timeOrigin)}`;

// open a raw ws to the bare kernel (/ws?id=&apiKey=<kernelKey>); resolve on open, reject on error/close-before-open.
function openWs(session) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${HOST}/ws?id=${encodeURIComponent(session)}&apiKey=${encodeURIComponent(KK)}`);
    const to = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error("open timeout")); }, 30000);
    ws.once("open", () => { clearTimeout(to); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(to); reject(e); });
  });
}
// send one frame, await the next message. Rejects on socket close/error/timeout (= a crash signal).
function rpc(ws, frame, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { ws.off("message", onMsg); ws.off("close", onClose); ws.off("error", onErr); clearTimeout(t); };
    const onMsg = (d) => { cleanup(); try { resolve(JSON.parse(String(d))); } catch { resolve({ raw: String(d) }); } };
    const onClose = (c, r) => { cleanup(); reject(new Error(`socket closed ${c} ${String(r).slice(0, 60)}`)); };
    const onErr = (e) => { cleanup(); reject(new Error(`socket error ${e.message}`)); };
    const t = setTimeout(() => { cleanup(); reject(new Error("rpc timeout")); }, timeoutMs);
    ws.on("message", onMsg); ws.once("close", onClose); ws.once("error", onErr);
    ws.send(JSON.stringify(frame));
  });
}
const errStr = (e) => (e?.message ?? String(e));
const isReject = (s) => /SizeAdmission|MemoryLimit/i.test(s);

async function trial(nMB) {
  const session = `cliffraw-${seed}-${nMB}`;
  let ws;
  try { ws = await openWs(session); } catch (e) { return { nMB, outcome: "CLIFF", detail: `open1: ${errStr(e)}` }; }
  try {
    await rpc(ws, { t: "auth", token: KK }, 30000).catch(() => {}); // idempotent; url already carries the key
    await rpc(ws, { t: "eval", src: `globalThis.canary='cliff-${nMB}'` });

    const bytes = nMB * MB;
    let spike;
    try { spike = await rpc(ws, { t: "eval", src: `globalThis.__s=new Uint8Array(${bytes});__s[0]=1;__s[${bytes - 1}]=1;__s.length` }); }
    catch (e) { return { nMB, outcome: isReject(errStr(e)) ? "rejected" : "CLIFF", detail: `spike: ${errStr(e)}` }; }
    if (spike?.error) return { nMB, outcome: isReject(JSON.stringify(spike.error)) ? "rejected" : "CLIFF", detail: `spike-err: ${JSON.stringify(spike.error).slice(0, 120)}` };
    if (spike?.value !== bytes) return { nMB, outcome: "no-spike", detail: `readback ${JSON.stringify(spike?.value)}` };

    // free -> post-eval checkpoint commits the scrubbed ~N MB base. A SizeAdmissionError surfaces here.
    let free;
    try { free = await rpc(ws, { t: "eval", src: `globalThis.__s=null;1` }); }
    catch (e) { return { nMB, outcome: isReject(errStr(e)) ? "rejected" : "CLIFF", detail: `commit: ${errStr(e)}` }; }
    if (free?.error && isReject(JSON.stringify(free.error))) return { nMB, outcome: "rejected", detail: `commit-reject: ${JSON.stringify(free.error).slice(0, 120)}` };
    const cp = free?.checkpoint ?? spike?.checkpoint;
    const sizeRaw = cp?.sizeRaw, sizeGz = cp?.sizeGz;

    // evict: drop the live kernel (durable snapshot kept). Next eval cold-restores.
    try { await rpc(ws, { t: "evict" }, 30000); } catch (e) { /* evict may close the socket; that's fine */ }
    try { ws.close(); } catch {}

    // reopen + cold restore
    let ws2;
    try { ws2 = await openWs(session); } catch (e) { return { nMB, outcome: "CLIFF", detail: `open2(restore): ${errStr(e)}`, sizeRaw, sizeGz }; }
    try {
      await rpc(ws2, { t: "auth", token: KK }, 30000).catch(() => {});
      const after = await rpc(ws2, { t: "eval", src: `globalThis.canary ?? null` }, 90000);
      try { ws2.close(); } catch {}
      if (after?.value === `cliff-${nMB}`) return { nMB, outcome: "restored", detail: `rawMB=${(sizeRaw / MB || 0).toFixed(1)} gzKB=${Math.round((sizeGz || 0) / 1024)}` };
      return { nMB, outcome: "CLIFF", detail: `canary LOST (got ${JSON.stringify(after?.value)}) rawMB=${(sizeRaw / MB || 0).toFixed(1)}` };
    } catch (e) {
      try { ws2.close(); } catch {}
      return { nMB, outcome: "CLIFF", detail: `restore-eval: ${errStr(e)} rawMB=${(sizeRaw / MB || 0).toFixed(1)}` };
    }
  } finally { try { ws.close(); } catch {} }
}

console.log(`\n══ restore-cliff RAW sweep: ${lo}→${hi} MB step ${step} (+78 cap probe) ══`);
console.log(`   🟢restored=safe · 🟡rejected=guard(safe) · 🔴CLIFF=silent-loss(BUG) · ⚪no-spike\n`);
const sizes = []; for (let n = lo; n <= hi; n += step) sizes.push(n); sizes.push(78);
const rows = []; let firstCliff = null;
for (const n of sizes) {
  const r = await trial(n);
  const mark = { restored: "🟢", rejected: "🟡", CLIFF: "🔴", "no-spike": "⚪" }[r.outcome] ?? "❓";
  console.log(`  ${mark} ${String(n).padStart(3)}MB  ${r.outcome.padEnd(9)}  ${r.detail ?? ""}`);
  rows.push(r);
  if (r.outcome === "CLIFF" && firstCliff == null) firstCliff = n;
  await new Promise((res) => setTimeout(res, 1200));
}
console.log(`\n════ CLIFF VERDICT ════`);
if (firstCliff == null) console.log(`  🟢 NO CLIFF in [${lo},${hi}]MB — 31MB discount + 76MB cap are SAFE. case1 CRITICAL = false positive.`);
else console.log(`  🔴 CLIFF at ${firstCliff}MB raw (< 76MB admit cap) — silent-loss CONFIRMED. Lower caps < ${firstCliff}MB or keep-prior-base.`);
const cap = rows.find((r) => r.nMB === 78);
if (cap?.outcome === "CLIFF") console.log(`  ⚠️  78MB probe CRASHED instead of clean-rejecting — absolute cap itself unsafe.`);
process.exit(firstCliff != null ? 1 : 0);
