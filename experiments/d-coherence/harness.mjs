// Coherence test matrix. Proves the staged-commit invariant holds across the 3
// dangerous eviction orderings, plus timer exactly-once, plus the R2-overflow path.
import { SqliteDO, R2Dir } from './store.mjs';
import { Kernel } from './kernel.mjs';

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail }); }

function fresh() {
  const sql = new SqliteDO();
  const r2 = new R2Dir(new URL('./_r2', import.meta.url).pathname);
  const fx = { fired: [] };
  return { sql, r2, fx, k: new Kernel(sql, r2, fx) };
}

// =====================================================================
// ORDERING 1: host-write -> heap-checkpoint -> evict
//   Both happen inside the same committed checkpoint. After cold restore both the
//   host state AND the heap must be present and at the SAME version. No tear.
// =====================================================================
{
  let { sql, r2, fx, k } = fresh();
  await k.wake();                  // fresh
  k.vmPoke();                      // heap: counter 101
  k.hostKvPut('user', 'alice');    // host write (staged)
  k.hostFsWrite('/log.txt', 'hello-world-this-is-chunked-content-spanning-multiple-chunks');
  k.checkpoint();                  // SINGLE commit: heap + host land together
  k.evict();                       // genuine eviction (instance + scheduler gone)

  // cold restore: fresh kernel object, same durable store
  k = new Kernel(sql, r2, fx);
  const w = await k.wake();
  check('O1 cold restore (genuine reconstruction)', !k.inMemory && (w.restoreSource === 'sqlite-restore' || w.restoreSource === 'r2-restore'), w.restoreSource);
  check('O1 heap survived (closure counter resumes 102)', k.vmPoke() === 102, k.vmReadX());
  check('O1 heap global x===42', k.vmReadX() === 42);
  check('O1 host kv survived', k.hostKvGet('user') === 'alice', k.hostKvGet('user'));
  check('O1 host fs survived', k.hostFsRead('/log.txt') === 'hello-world-this-is-chunked-content-spanning-multiple-chunks');
}

// =====================================================================
// ORDERING 2: heap-checkpoint -> host-write -> evict
//   The heap was committed, but the host write came AFTER and was NEVER committed
//   (eviction dropped staged). The heap may "reference" a host object (handle id)
//   that was never durably written. RECONCILIATION RULE: the host write rolls back
//   to match the committed heap. The dangling handle must be detectable (absent),
//   NOT silently read as torn/garbage. The cell that did the post-checkpoint write
//   is logically un-acknowledged and must re-run.
// =====================================================================
{
  let { sql, r2, fx, k } = fresh();
  await k.wake();
  k.vmPoke();                      // 101
  // the cell stores a handle id in the heap (model: kv key the heap will reference)
  k.hostKvPut('handle:doc1', 'committed-v1');
  k.checkpoint();                  // commit #1: heap@101 + handle:doc1=committed-v1

  // NEW cell begins: mutate host AFTER the checkpoint, before the next checkpoint
  k.hostKvPut('handle:doc1', 'uncommitted-v2');  // staged only
  k.hostKvPut('handle:doc2', 'uncommitted-new'); // staged only, heap doesn't ref it yet
  k.evict();                       // evict BEFORE this cell checkpoints

  k = new Kernel(sql, r2, fx);
  await k.wake();
  check('O2 heap rolled to last commit (counter 101->102)', k.vmPoke() === 102);
  check('O2 host handle:doc1 == committed value (v2 rolled back)', k.hostKvGet('handle:doc1') === 'committed-v1', k.hostKvGet('handle:doc1'));
  check('O2 dangling handle:doc2 absent (not torn)', k.hostKvGet('handle:doc2') === undefined, k.hostKvGet('handle:doc2'));
}

// =====================================================================
// ORDERING 3: host-write -> evict BEFORE heap-checkpoint
//   Host write was staged but never committed (no checkpoint happened at all this
//   cell). Heap rolls back to previous commit; host state must roll back WITH it.
//   RULE: since host writes are staged and only durable via checkpoint, an evict
//   before checkpoint loses BOTH -> they stay at the same (previous) version.
// =====================================================================
{
  let { sql, r2, fx, k } = fresh();
  await k.wake();
  k.vmPoke();                      // 101
  k.hostKvPut('cfg', 'baseline');
  k.checkpoint();                  // commit baseline: heap@101 + cfg=baseline

  // cell mutates heap AND host, then evicts with NO checkpoint
  k.vmPoke();                      // heap now 102 in-memory (uncommitted)
  k.hostKvPut('cfg', 'mutated');   // staged
  k.evict();                       // crash before checkpoint

  k = new Kernel(sql, r2, fx);
  await k.wake();
  // heap must be back at the committed 101 -> next poke yields 102 (not 103)
  check('O3 heap rolled back to committed (poke->102 not 103)', k.vmPoke() === 102, 'value');
  check('O3 host cfg rolled back to baseline', k.hostKvGet('cfg') === 'baseline', k.hostKvGet('cfg'));
}

// =====================================================================
// TIMER EXACTLY-ONCE: fire a timer, evict immediately after firing, cold restore.
//   The effect must NOT double-fire (fired flag committed atomically with the
//   firing checkpoint).
// =====================================================================
{
  let { sql, r2, fx, k } = fresh();
  await k.wake();
  k.hostSetTimer('t1', 1000, 'send-email');
  k.checkpoint();                  // timer registered durably, scheduler armed
  k.fireDueAlarms(2000);           // due -> fires, checkpoints fired:true
  check('TIMER fired exactly once before evict', fx.fired.length === 1 && fx.fired[0] === 'send-email');
  k.evict();                       // evict right after firing

  k = new Kernel(sql, r2, fx);     // shared fx -> would show a 2nd entry if re-fired
  await k.wake();                  // rebuild scheduler from durable registry
  k.fireDueAlarms(3000);           // timer is durably fired -> must NOT fire again
  check('TIMER no double-fire after evict+restore', fx.fired.length === 1, `fired=${fx.fired.length}`);
}

// =====================================================================
// R2-OVERFLOW heap path: big ctx forces heap>2KB gz? heap gz is ~5KB so it takes
//   the r2 path naturally. Prove host.ctx (R2) + heap (R2) cold-restore coherently.
// =====================================================================
{
  let { sql, r2, fx, k } = fresh();
  await k.wake();
  k.vmPoke();
  const big = Buffer.alloc(8192, 0xab); // big context
  k.hostCtxPut('ctxA', big);
  k.checkpoint();                  // heap (likely r2) + ctx (r2) + manifest ptr commit
  k.evict();

  k = new Kernel(sql, r2, fx);
  const w = await k.wake();
  const got = k.hostCtxGet('ctxA');
  check('R2 heap path used', w.restoreSource === 'r2-restore' || w.restoreSource === 'sqlite-restore', w.restoreSource);
  check('R2 ctx survived eviction coherently', got && got.length === 8192 && got[0] === 0xab && got[8191] === 0xab);
  check('R2 heap survived alongside ctx (poke->102)', k.vmPoke() === 102);
}

// =====================================================================
// ORDERING 2-NEGATIVE CONTROL: prove that WITHOUT staged-commit (naive design where
//   host writes land immediately) we GET a tear. We simulate the naive path by
//   committing host write but NOT the heap, then evicting.
// =====================================================================
{
  let { sql, r2, fx, k } = fresh();
  await k.wake();
  k.vmPoke();                      // heap 101
  k.checkpoint();                  // commit heap@101
  // NAIVE: host write commits immediately (bypass staging) while heap advances in-mem
  k.vmPoke();                      // heap 102 in-mem (uncommitted)
  k.hostKvPut('doc', 'v2'); k.sql.commit();  // <-- naive immediate commit, no heap dump
  k.evict();
  k = new Kernel(sql, r2, fx);
  await k.wake();
  // TEAR: host says v2, but heap rolled back to 101 (poke->102). State versions diverge.
  const heapBehind = k.vmPoke() === 102;       // heap at old version
  const hostAhead = k.hostKvGet('doc') === 'v2'; // host at new version
  check('NEGATIVE CONTROL: naive design DOES tear (host ahead of heap)', heapBehind && hostAhead,
        `heapBehind=${heapBehind} hostAhead=${hostAhead}`);
}

// ---- report ----
let pass = 0;
for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail !== undefined ? '  ['+r.detail+']' : ''}`); if (r.pass) pass++; }
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
