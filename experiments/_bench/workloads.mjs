// workloads.mjs — the 5 STANDARD benchmark workloads.
//
// Each workload is a deterministic generator returning:
//   { name, cells: string[], check: '<js expr returning a JSON-able value>', expected: <value> }
//
// `cells` are evaluated in order in ONE session. The runner forces a genuine evict +
// cold-restore at a defined midpoint, then continues. After the last cell it evals
// `check` and deep-compares the host-dumped result to `expected` for the FIDELITY gate.
//
// Determinism: no Date.now()/Math.random() leaks into `expected` — clock+RNG are seeded
// in the Session driver, but the checks avoid them entirely so any strategy is comparable.

// W-light: 50 small cells building an accumulator + a closure + an array.
function wLight() {
  const cells = [];
  cells.push('var acc = 0; var arr = []; var mk = (n)=>()=>n*2; var fns = [];');
  for (let i = 1; i <= 48; i++) {
    cells.push(`acc += ${i}; arr.push(${i}); fns.push(mk(${i}));`);
  }
  cells.push('var closureSum = fns.reduce((s,f)=>s+f(),0);');
  // sum 1..48 = 1176 ; closureSum = 2*1176 = 2352 ; arr.length 48
  return {
    name: 'W-light',
    cells,
    check: 'JSON.stringify({acc, len: arr.length, closureSum})',
    expected: JSON.stringify({ acc: 1176, len: 48, closureSum: 2352 }),
    evictAfter: 25,
  };
}

// W-spike: grow a big buffer (~48MB) then free it. Tests peak-image + reclaim.
function wSpike() {
  const cells = [
    'var keep = "anchor";',
    // ~48MB: 48 * 1MB strings held in an array
    'var big = []; for (let i=0;i<48;i++){ big.push("x".repeat(1024*1024)); }',
    'var bigLen = big.length; var bigBytes = big.reduce((s,x)=>s+x.length,0);',
    'big = null;',            // free the spike
    'var afterFree = keep + ":freed";',
  ];
  return {
    name: 'W-spike',
    cells,
    check: 'JSON.stringify({bigLen, bigBytes, afterFree})',
    expected: JSON.stringify({ bigLen: 48, bigBytes: 48 * 1024 * 1024, afterFree: 'anchor:freed' }),
    evictAfter: 4, // after the free, so cold-restore sees the post-spike state
  };
}

// W-churn: repeatedly alloc ~2MB then free, 30x. Tests delta/dirty-page churn.
function wChurn() {
  const cells = ['var rounds = 0; var liveTag = "";'];
  for (let i = 0; i < 30; i++) {
    cells.push(`{ let tmp = "y".repeat(2*1024*1024); liveTag = tmp.slice(0,3); tmp = null; rounds++; }`);
  }
  return {
    name: 'W-churn',
    cells,
    check: 'JSON.stringify({rounds, liveTag})',
    expected: JSON.stringify({ rounds: 30, liveTag: 'yyy' }),
    evictAfter: 15,
  };
}

// W-long: 200 cells, steady small growth of a Map-like object graph.
function wLong() {
  const cells = ['var db = {}; var total = 0;'];
  for (let i = 0; i < 200; i++) {
    cells.push(`db["k${i}"] = {i:${i}, sq:${i * i}}; total += ${i};`);
  }
  // sum 0..199 = 19900 ; keys = 200
  return {
    name: 'W-long',
    cells,
    check: 'JSON.stringify({total, keys: Object.keys(db).length, last: db["k199"].sq})',
    expected: JSON.stringify({ total: 19900, keys: 200, last: 199 * 199 }),
    evictAfter: 100,
  };
}

// W-bigctx: load a >1MB string context into the heap and reference it across restore.
function wBigCtx() {
  const cells = [
    // build a deterministic >1MB context block (1.5MB)
    'var ctx = ""; for (let i=0;i<1536;i++){ ctx += ("row"+i+":"+ (i*7%97) + "\\n"); while(ctx.length < (i+1)*1024) ctx += "."; }',
    'var ctxLen = ctx.length;',
    'var needle = "row1000:" + (1000*7%97);',
    'var found = ctx.indexOf(needle) >= 0;',
    'var digest = 0; for (let i=0;i<ctx.length;i++){ digest = (digest*31 + ctx.charCodeAt(i)) >>> 0; }',
  ];
  return {
    name: 'W-bigctx',
    cells,
    check: 'JSON.stringify({over1mb: ctxLen > 1048576, found, digestType: typeof digest})',
    expected: JSON.stringify({ over1mb: true, found: true, digestType: 'number' }),
    evictAfter: 3,
  };
}

export const WORKLOADS = {
  'W-light': wLight,
  'W-spike': wSpike,
  'W-churn': wChurn,
  'W-long': wLong,
  'W-bigctx': wBigCtx,
};

export function allWorkloads() {
  return Object.values(WORKLOADS).map((g) => g());
}
