// workloads.mjs — the 5 STANDARD benchmark workloads, ported verbatim from
// experiments/_bench/workloads.mjs so the on-CF numbers compare to the local bake-off.

function wLight() {
  const cells = [];
  cells.push("var acc = 0; var arr = []; var mk = (n)=>()=>n*2; var fns = [];");
  for (let i = 1; i <= 48; i++) {
    cells.push(`acc += ${i}; arr.push(${i}); fns.push(mk(${i}));`);
  }
  cells.push("var closureSum = fns.reduce((s,f)=>s+f(),0);");
  return {
    name: "W-light",
    cells,
    check: "JSON.stringify({acc, len: arr.length, closureSum})",
    expected: JSON.stringify({ acc: 1176, len: 48, closureSum: 2352 }),
    evictAfter: 25,
  };
}

function wSpike() {
  const cells = [
    'var keep = "anchor";',
    'var big = []; for (let i=0;i<48;i++){ big.push("x".repeat(1024*1024)); }',
    "var bigLen = big.length; var bigBytes = big.reduce((s,x)=>s+x.length,0);",
    "big = null;",
    'var afterFree = keep + ":freed";',
  ];
  return {
    name: "W-spike",
    cells,
    check: "JSON.stringify({bigLen, bigBytes, afterFree})",
    expected: JSON.stringify({ bigLen: 48, bigBytes: 48 * 1024 * 1024, afterFree: "anchor:freed" }),
    evictAfter: 4,
  };
}

function wChurn() {
  const cells = ['var rounds = 0; var liveTag = "";'];
  for (let i = 0; i < 30; i++) {
    cells.push(`{ let tmp = "y".repeat(2*1024*1024); liveTag = tmp.slice(0,3); tmp = null; rounds++; }`);
  }
  return {
    name: "W-churn",
    cells,
    check: "JSON.stringify({rounds, liveTag})",
    expected: JSON.stringify({ rounds: 30, liveTag: "yyy" }),
    evictAfter: 15,
  };
}

function wLong() {
  const cells = ["var db = {}; var total = 0;"];
  for (let i = 0; i < 200; i++) {
    cells.push(`db["k${i}"] = {i:${i}, sq:${i * i}}; total += ${i};`);
  }
  return {
    name: "W-long",
    cells,
    check: 'JSON.stringify({total, keys: Object.keys(db).length, last: db["k199"].sq})',
    expected: JSON.stringify({ total: 19900, keys: 200, last: 199 * 199 }),
    evictAfter: 100,
  };
}

function wBigCtx() {
  const cells = [
    'var ctx = ""; for (let i=0;i<1536;i++){ ctx += ("row"+i+":"+ (i*7%97) + "\\n"); while(ctx.length < (i+1)*1024) ctx += "."; }',
    "var ctxLen = ctx.length;",
    'var needle = "row1000:" + (1000*7%97);',
    "var found = ctx.indexOf(needle) >= 0;",
    "var digest = 0; for (let i=0;i<ctx.length;i++){ digest = (digest*31 + ctx.charCodeAt(i)) >>> 0; }",
  ];
  return {
    name: "W-bigctx",
    cells,
    check: "JSON.stringify({over1mb: ctxLen > 1048576, found, digestType: typeof digest})",
    expected: JSON.stringify({ over1mb: true, found: true, digestType: "number" }),
    evictAfter: 3,
  };
}

// W-incompressible: builds a large high-entropy string via a seeded LCG so the heap
// image does NOT gzip below the 2MB R2-overflow threshold -> forces an R2 round-trip on
// restore (the one path the local sim charged 0ms for). Deterministic (no external RNG).
function wIncompressible() {
  // Build ~3MB of high-entropy printable bytes in ONE cell (minimize full-heap dumps,
  // which each copy the image and would OOM the 128MB DO isolate). gz of 3MB random
  // stays above the 2MB R2-overflow threshold -> forces a real R2 round-trip on restore.
  // Full-entropy bytes in a Uint8Array (dense, NOT compressible) via a full-period LCG
  // taking the high byte. ~4MB of incompressible bytes -> gz stays above the 2MB
  // R2-overflow threshold -> forces a real R2 round-trip on restore. Deterministic.
  const N = 4 * 1024 * 1024;
  const cells = [
    `var s = 2654435761 >>> 0;
     var blob = new Uint8Array(${N});
     for (let i=0;i<${N};i++){ s = (s*1664525 + 1013904223) >>> 0; blob[i] = (s >>> 24) & 0xff; }
     var blobLen = blob.length;`,
    "var checksum = 0; for(let i=0;i<blob.length;i+=2048){ checksum = (checksum*31 + blob[i]) >>> 0; }",
  ];
  return {
    name: "W-incompressible",
    cells,
    check: "JSON.stringify({blobLen, csType: typeof checksum})",
    expected: JSON.stringify({ blobLen: N, csType: "number" }),
    evictAfter: 1,
  };
}

export const WORKLOADS = {
  "W-light": wLight,
  "W-spike": wSpike,
  "W-churn": wChurn,
  "W-long": wLong,
  "W-bigctx": wBigCtx,
  "W-incompressible": wIncompressible,
};
export const ALIASES = {
  light: "W-light",
  spike: "W-spike",
  churn: "W-churn",
  long: "W-long",
  bigctx: "W-bigctx",
  incompressible: "W-incompressible",
  r2: "W-incompressible",
};
