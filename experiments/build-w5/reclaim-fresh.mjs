// reclaim-fresh.mjs — demonstrates the W5 RAW reclaim that IS achievable on this substrate:
// a FRESH instance rehydrated from live state occupies the minimal buffer, sidestepping the
// monotonic high-water-mark. This is the plan's "instantiate a brand-new small instance and
// rehydrate" path (plan §2 / docs FLIP3). The fidelity-complete version needs JS_WriteObject
// (native build) or the EXP-6 oplog (cell-source replay); here we prove the RECLAIM magnitude
// with the oplog (the cell sources) since that is the mechanism W5 actually uses internally.

import { Session } from '../_bench/session.mjs';
const MB = 1024 * 1024;

// the spike "oplog" — the exact cells W5 would replay into a fresh instance (closures+promises
// via source replay, the documented EXP-6 fidelity path; data could alternatively go via
// JS_WriteObject on the native build).
const OPLOG = [
  'var keep="anchor"; var n=12345; var inc=(()=>{let c=0; return ()=>++c;})();',
  'var cnt1=inc(); var cnt2=inc();',
  'var m=new Map([["a",1],["b",2]]); var st=new Set([7,8,9]);',
  'var pend=new Promise(()=>{}); var done=Promise.resolve("ok");',
  // NOTE: the 48MB spike + free are NOT replayed — that is the whole point: the freed spike
  // leaves no live state, so the rehydrated fresh instance never re-grows. We DO replay the
  // value that depended on it (bigBytes) as a captured constant (W5 captures live data values).
  'var bigBytes=48*1024*1024;',
];

async function main() {
  // bloated reference
  const a = new Session(); await a.create();
  for (const c of OPLOG) a.eval(c);
  a.eval('var big=[];for(let i=0;i<48;i++)big.push("x".repeat(1024*1024)); big=null;');
  a.vm.runGC();
  const bloatedMB = +(a.bufferBytes() / MB).toFixed(2);
  a.dispose();

  // W5 compacted: fresh instance, replay oplog only (no spike) → minimal buffer
  const b = new Session(); await b.create();
  for (const c of OPLOG) b.eval(c);
  // advance the closure to the post-spike state (W5 captures live closure value: inc was called twice)
  // the counter must read 3 on next call → it already does (2 calls in oplog), continue:
  const freshMB = +(b.bufferBytes() / MB).toFixed(2);
  const fid = {
    closureNext: b.eval('inc()'),            // 3
    pending: b.eval('typeof pend'),          // object
    mapA: b.eval('m.get("a")'),              // 1
    set: b.eval('JSON.stringify([...st])'),  // [7,8,9]
    keep: b.eval('keep'),                    // anchor
    bigBytes: b.eval('bigBytes'),            // 48MB
  };
  b.dispose();

  const reclaimRawPct = +(100 * (1 - freshMB / bloatedMB)).toFixed(2);
  console.log(JSON.stringify({
    bloatedMB, freshMB, reclaimRawPct,
    fidelity: fid,
    fidelityPass: fid.closureNext === 3 && fid.pending === 'object' && fid.mapA === 1 &&
                  fid.set === '[7,8,9]' && fid.keep === 'anchor' && fid.bigBytes === 48 * MB,
    mechanism: 'fresh-instance rehydrate via EXP-6 oplog replay (the spike leaves no live state to re-grow)',
  }, null, 2));
}
main();
