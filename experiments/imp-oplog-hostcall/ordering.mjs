// ordering.mjs — ordering subtlety: MULTIPLE side-effecting host calls per cell.
//
// A cell may issue several host calls (and interleave two different effectful tools). The
// recorded results MUST be consumed in EXACT emission order during replay, or VM state
// diverges. Two external tallies (A: kvIncrement, B: feeBump simulating host.fetch POST).
// Each replayed cell does A,B,A — replay must hand back exactly [a1,b1,a2] in order, fire
// nothing. We assert both external tallies are exactly-once and the VM-side log matches.

import { HostSession } from './host-session.mjs';

const A = { n: 0, inc() { return ++this.n; } };
const B = { n: 0, bump() { return (this.n += 10); } };

const cell = `
  globalThis.log = globalThis.log || [];
  globalThis.log.push(host.kvIncrement());   // A
  globalThis.log.push(host.feeBump());        // B
  globalThis.log.push(host.kvIncrement());   // A
`;
const totalCells = 8, crashAfter = 5, N = 3;   // full@1,3 ; crash@5 -> restore full@3, replay 4,5

const sess = new HostSession({ tools: ['kvIncrement', 'feeBump'] });
await sess.create();

let mode = 'live', rec = null, q = null, qi = 0;
sess.setDispatch((name) => {
  if (mode === 'live') {
    const r = name === 'kvIncrement' ? A.inc() : B.bump();
    rec.push({ name, r }); return r;
  }
  const e = q[qi++];
  if (e.name !== name) throw new Error(`ORDER VIOLATION: replay expected ${e.name} got ${name}`);
  return e.r;   // recorded, no fire
});

const oplog = []; let fullImg = null;
let gen = 0;
const live = (i) => {
  rec = []; sess.eval(cell); gen++;
  const full = gen === 1 || gen % N === 0;
  if (full) { fullImg = sess.dump(); oplog.length = 0; } else oplog.push({ seq: gen, src: cell, hr: rec.slice() });
};

for (let i = 0; i < crashAfter; i++) live(i);
const aAtCrash = A.n, bAtCrash = B.n;
const replayPlan = oplog.map((e) => e.seq);
sess.dispose();

await sess.restore(fullImg);
mode = 'replay';
for (const e of oplog) { q = e.hr; qi = 0; sess.eval(e.src); if (qi !== q.length) throw new Error('underflow'); }
const aAfterReplay = A.n, bAfterReplay = B.n;
mode = 'live';
for (let i = crashAfter; i < totalCells; i++) live(i);

const vmLog = sess.eval('JSON.stringify(globalThis.log)');
sess.dispose();

const expectedLog = [];
for (let c = 0; c < totalCells; c++) { /* A,B,A pattern; A increments 1, B by 10 */ }
// reconstruct expected: A called 2x/cell => 2*8=16 A-calls => last A = 16; B 1x/cell => 8 => last 80
console.log('\n=== ORDERING: multi-call-per-cell exactly-once ===');
console.log(JSON.stringify({
  totalCells, crashAfter, N, replayedSeqs: replayPlan,
  A_atCrash: aAtCrash, A_afterReplay: aAfterReplay, A_final: A.n,
  B_atCrash: bAtCrash, B_afterReplay: bAfterReplay, B_final: B.n,
}, null, 2));
console.log('VM log:', vmLog);
const P = (c, m) => console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
P(aAfterReplay === aAtCrash && bAfterReplay === bAtCrash, `replay fired NOTHING (A ${aAtCrash}->${aAfterReplay}, B ${bAtCrash}->${bAfterReplay})`);
P(A.n === 2 * totalCells, `tally A exactly-once == ${2 * totalCells} (got ${A.n})`);
P(B.n === 10 * totalCells, `tally B exactly-once == ${10 * totalCells} (got ${B.n})`);
// VM log must be monotone A,B,A per cell with no gaps/dupes
const log = JSON.parse(vmLog);
const aVals = log.filter((_, i) => i % 3 !== 1);
const bVals = log.filter((_, i) => i % 3 === 1);
P(JSON.stringify(aVals) === JSON.stringify([...Array(2 * totalCells)].map((_, i) => i + 1)), `VM A-values 1..${2 * totalCells} in order (no dup/gap)`);
P(JSON.stringify(bVals) === JSON.stringify([...Array(totalCells)].map((_, i) => (i + 1) * 10)), `VM B-values 10..${10 * totalCells} in order`);
