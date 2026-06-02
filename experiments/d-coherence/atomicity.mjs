// Atomicity-of-commit test: prove the staged flush is all-or-nothing. We inject a
// "crash" at every point during checkpoint() by counting sql.put calls and aborting
// after the Nth, BEFORE sql.commit() runs. Because nothing is durable until commit(),
// EVERY mid-flush crash must leave the store at the PREVIOUS committed version — never
// a partial heap or partial host write. This mirrors workerd's output-gate: writes
// buffered in the turn flush atomically or not at all.
import { SqliteDO, R2Dir } from './store.mjs';
import { Kernel } from './kernel.mjs';

let fails = 0, runs = 0;
for (let crashAfter = 0; crashAfter <= 40; crashAfter++) {
  const sql = new SqliteDO();
  const r2 = new R2Dir(new URL('./_r2atom', import.meta.url).pathname);
  const fx = { fired: [] };
  let k = new Kernel(sql, r2, fx);
  await k.wake();
  k.vmPoke();                       // 101
  k.hostKvPut('k', 'v1'); k.hostFsWrite('/f', 'baseline-content');
  k.checkpoint();                   // commit a clean baseline

  // Begin a new cell: advance heap + host, then attempt checkpoint with a crash
  // injected after `crashAfter` staged puts (commit() never reached if it crashes).
  k.vmPoke();                       // 102 in-mem
  k.hostKvPut('k', 'v2'); k.hostFsWrite('/f', 'mutated-content-longer-spanning-chunks');

  // wrap put to crash mid-flush
  const realCommit = sql.commit.bind(sql);
  let puts = 0; const realPut = sql.put.bind(sql);
  sql.put = (key, val) => { if (++puts > crashAfter) throw new Error('CRASH'); realPut(key, val); };
  let crashed = false;
  try { k.checkpoint(); } catch { crashed = true; }
  sql.put = realPut; // restore

  runs++;
  if (crashed) {
    // EVICT (drop staged) then cold-restore: must be at baseline, never partial.
    k.evict();
    k = new Kernel(sql, r2, fx);
    await k.wake();
    const heapOK = k.vmPoke() === 102;          // baseline heap@101 -> 102
    const hostKOK = k.hostKvGet('k') === 'v1';   // host at baseline
    const hostFOK = k.hostFsRead('/f') === 'baseline-content';
    if (!(heapOK && hostKOK && hostFOK)) { fails++; console.log(`TORN at crashAfter=${crashAfter} heap=${heapOK} k=${hostKOK} f=${hostFOK}`); }
  } else {
    // no crash -> full commit: everything at v2, coherent
    k.evict(); k = new Kernel(sql, r2, fx); await k.wake();
    const ok = k.vmPoke() === 103 && k.hostKvGet('k') === 'v2' && k.hostFsRead('/f') === 'mutated-content-longer-spanning-chunks';
    if (!ok) { fails++; console.log(`POST-COMMIT INCOHERENT at crashAfter=${crashAfter}`); }
  }
}
console.log(`atomicity: ${runs - fails}/${runs} crash-points left coherent (no torn state)`);
process.exit(fails === 0 ? 0 : 1);
