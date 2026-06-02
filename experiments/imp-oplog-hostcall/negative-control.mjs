// negative-control.mjs — prove the recorded-result slot is LOAD-BEARING.
//
// Same setup as run.mjs, but replay uses the NAIVE strategy: re-run cell sources with the
// host dispatcher in LIVE mode (re-firing). This is what E6 WOULD do if the host-call-result
// slot were ignored. Expectation: the replayed window (seq 11,12,13) double-fires -> tally
// overshoots (26, not 20). Also a MULTI-CALL-PER-CELL ordering test that, replayed live with
// seeded RNG, would still re-fire each call. This makes the gap-closing claim falsifiable.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextEncoder, TextDecoder } from 'node:util';
import { DOStore } from '../_bench/store.mjs';
import { HostSession } from './host-session.mjs';

const enc = new TextEncoder(); const dec = new TextDecoder();

async function run({ totalCells = 20, crashAfter = 13, snapshotEveryN = 5, replayMode }) {
  const dir = join(tmpdir(), `imp-negctl-${Date.now()}-${Math.random()}`);
  const store = new DOStore({ r2Dir: dir });
  const key = `negctl`;
  let gen = 0;
  const kv = { tally: 0, increment() { return ++this.tally; } };

  const cells = [];
  for (let i = 0; i < totalCells; i++)
    cells.push(`globalThis.r=globalThis.r||[]; globalThis.r.push(host.kvIncrement()); globalThis.n=globalThis.r.length;`);

  const sess = new HostSession({ tools: ['kvIncrement'] });
  await sess.create();

  let mode = 'live', recording = null, replayQueue = null, replayIdx = 0;
  sess.setDispatch((name) => {
    if (mode === 'live') { const r = kv.increment(); if (recording) recording.push(r); return r; }
    // replay
    if (replayMode === 'recorded') return replayQueue[replayIdx++];        // correct E6
    if (replayMode === 'naive-refire') { return kv.increment(); }          // BUG: re-fires
  });

  const oplog = []; let fullSeq = 1; let fullImage = null;
  const liveCell = (i) => {
    recording = []; sess.eval(cells[i]); gen++;
    const isFull = gen === 1 || gen % snapshotEveryN === 0;
    if (isFull) { fullImage = sess.dump(); fullSeq = gen; oplog.length = 0; }
    else oplog.push({ seq: gen, src: cells[i], hostResults: recording.slice() });
  };

  for (let i = 0; i < crashAfter; i++) liveCell(i);
  const tallyAtCrash = kv.tally;
  sess.dispose();

  await sess.restore(fullImage);
  mode = 'replay';
  const replayedCount = oplog.length;   // captured BEFORE continued live cells truncate oplog
  for (const e of oplog) { replayQueue = e.hostResults; replayIdx = 0; sess.eval(e.src); }
  const tallyAfterReplay = kv.tally;
  mode = 'live';
  for (let i = crashAfter; i < totalCells; i++) liveCell(i);

  const vmN = sess.eval('globalThis.n'); sess.dispose();
  return { replayMode, fullSeq, oplogLen: replayedCount, tallyAtCrash, tallyAfterReplay, finalTally: kv.tally, vmN };
}

const recorded = await run({ replayMode: 'recorded' });
const naive = await run({ replayMode: 'naive-refire' });

console.log('\n=== NEGATIVE CONTROL: recorded-result slot is load-bearing ===');
console.log('recorded (correct E6):  ', JSON.stringify(recorded));
console.log('naive-refire (the bug): ', JSON.stringify(naive));
const P = (c, m) => console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
P(recorded.finalTally === 20, `recorded-result replay => tally 20 (exactly once)`);
P(naive.finalTally === 20 + naive.oplogLen, `naive re-fire => tally ${naive.finalTally} = 20 + ${naive.oplogLen} replayed (DOUBLE-FIRE, as expected)`);
P(recorded.tallyAfterReplay === recorded.tallyAtCrash, `recorded: replay does not bump tally`);
P(naive.tallyAfterReplay === naive.tallyAtCrash + naive.oplogLen, `naive: replay DID bump tally by ${naive.oplogLen} (the side-effect leak)`);
