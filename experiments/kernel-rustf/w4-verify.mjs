// W4 byte-delta runtime verification against deployed engram-rust1b on real CF.
// Drives a 60-cell session of small mutations (one key added per cell), reads per-cell
// checkpoint telemetry, and reports delta/base counts + total durable bytes vs full-dump baseline.
import WebSocket from "ws";

const BASE = "engram-rust1b.umg-bhalla88.workers.dev";
const SID = "w4-verify-" + Date.now();
const NCELLS = 60;

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`wss://${BASE}/?id=${SID}`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}
function rpc(ws, msg) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + JSON.stringify(msg).slice(0, 80))), 30000);
    ws.once("message", (d) => { clearTimeout(t); res(JSON.parse(d.toString())); });
    ws.send(JSON.stringify(msg));
  });
}

const ws = await connect();
let r = await rpc(ws, { t: "create", config: { rngSeed: 7 } });
console.log("create:", JSON.stringify(r).slice(0, 200));

// seed a store object
await rpc(ws, { t: "eval", src: "globalThis.store = {}; 'init'" });

const rows = [];
for (let i = 0; i < NCELLS; i++) {
  const src = `store.k${i} = ${i}; Object.keys(store).length`;
  const resp = await rpc(ws, { t: "eval", src });
  const ck = resp.checkpoint || {};
  rows.push({
    cell: resp.cell,
    value: resp.value,
    mode: ck.mode,
    deltaSeq: ck.deltaSeq,
    nChanged: ck.nChanged,
    nChunks: ck.nChunks,
    sizeGz: ck.sizeGz,
    sizeRaw: ck.sizeRaw,
    store: ck.store,
    ok: ck.ok,
    raw: ck,
  });
}

ws.close();

// ---- analysis ----
console.log("\n=== PER-CELL TELEMETRY (sample) ===");
console.log("cell | mode  | dSeq | nChanged | sizeGz");
for (const row of rows) {
  if (row.cell < 5 || row.cell % 10 === 0 || row.mode === "full" || row.cell >= NCELLS - 3) {
    console.log(
      String(row.cell).padStart(4) + " | " +
      String(row.mode || "?").padEnd(5) + " | " +
      String(row.deltaSeq ?? "?").padStart(4) + " | " +
      String(row.nChanged ?? "?").padStart(8) + " | " +
      String(row.sizeGz ?? "?")
    );
  }
}

let deltaCount = 0, fullCount = 0, otherCount = 0;
let totalW4Bytes = 0;
let fullGzSamples = [];
let maxChain = 0, curChain = 0;
for (const row of rows) {
  const sz = Number(row.sizeGz) || 0;
  totalW4Bytes += sz;
  if (row.mode === "delta") { deltaCount++; curChain++; if (curChain > maxChain) maxChain = curChain; }
  else if (row.mode === "full") { fullCount++; curChain = 0; fullGzSamples.push(sz); }
  else otherCount++;
}

// Estimate full-dump baseline: a full dump every cell == NCELLS * avg full image gz.
const avgFullGz = fullGzSamples.length ? fullGzSamples.reduce((a, b) => a + b, 0) / fullGzSamples.length : 0;
const baselineBytes = Math.round(avgFullGz * NCELLS);
const ratio = baselineBytes ? (baselineBytes / totalW4Bytes).toFixed(2) : "n/a";

console.log("\n=== W4 VERDICT ===");
console.log("delta commits:", deltaCount);
console.log("full  commits:", fullCount, "(expected ~3-4 at BASE_EVERY=20 over 60 cells)");
console.log("other/unknown:", otherCount);
console.log("max delta chain length:", maxChain);
console.log("avg full image gz bytes:", Math.round(avgFullGz));
console.log("TOTAL W4 durable bytes (gz):", totalW4Bytes);
console.log("ESTIMATED full-dump-every-cell baseline (gz):", baselineBytes);
console.log("REDUCTION ratio (baseline / W4):", ratio + "x");

const W4_WIRED = deltaCount > NCELLS * 0.5 && totalW4Bytes < baselineBytes * 0.6;
console.log("\nW4 WIRED:", W4_WIRED ? "YES — deltas dominate, durable bytes << full baseline" :
  "NO — W4 NOT effectively wired (full dump every commit or no reduction)");

console.log("\n__JSON__" + JSON.stringify({
  deltaCount, fullCount, otherCount, maxChain,
  totalW4Bytes, baselineBytes, ratio, avgFullGz: Math.round(avgFullGz),
  W4_WIRED, modes: rows.map(r => r.mode),
  deltaSeqs: rows.map(r => r.deltaSeq),
  sampleSizes: rows.slice(0, 5).map(r => r.sizeGz),
}));
