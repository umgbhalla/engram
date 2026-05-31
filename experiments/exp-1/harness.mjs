// EXP-1 orchestrator. Runs the snapshot phase, then the restore phase in a
// SEPARATE node process (proving no in-memory state / no source replay leaks
// across). Asserts the core hypothesis.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runPhase(script) {
  const path = fileURLToPath(new URL(script, import.meta.url));
  const out = execFileSync(process.execPath, [path], { encoding: 'utf8' });
  return JSON.parse(out);
}

console.log('=== EXP-1: QuickJS WASM snapshot/restore round-trip ===\n');

console.log('[Phase A] fresh instance -> eval cell 1 -> snapshot to disk');
const a = runPhase('./snapshot-phase.mjs');
console.log(`  x before snapshot     : ${a.xBefore} (promise still pending)`);
console.log(`  typeof p              : ${a.pType}`);
console.log(`  __stack_pointer       : ${a.stackPointer}`);
console.log(`  runtimePtr/contextPtr : ${a.runtimePtr} / ${a.contextPtr}`);
console.log(`  linear memory         : ${(a.memoryBytes / 1024).toFixed(0)} KiB`);
console.log(`  snapshot raw          : ${a.rawBytes} bytes (${(a.rawBytes / 1024).toFixed(1)} KiB)`);
console.log(`  snapshot gzip         : ${a.gzipBytes} bytes (${(a.gzipBytes / 1024).toFixed(1)} KiB)`);
console.log(`  snapshot time         : ${a.snapshotMs} ms`);

console.log('\n[Phase B] FRESH process -> restore -> drain jobs -> cell 2 inc()');
const b = runPhase('./restore-phase.mjs');
console.log(`  restore time          : ${b.restoreMs} ms`);
console.log(`  x at restore (pre)    : ${b.xAtRestore} (should be 41)`);
console.log(`  jobs drained          : ${b.jobsDrained} (the pending promise)`);
console.log(`  x after drain         : ${b.xAfterDrain} (should be 42)`);
console.log(`  inc() returned        : ${b.incResult} (closure works -> 43)`);
console.log(`  x final               : ${b.xFinal} (should be 43)`);

console.log('\n=== Assertions ===');
const checks = [
  ['pre-snapshot x === 41', a.xBefore === 41],
  ['x at restore === 41 (promise not yet drained)', b.xAtRestore === 41],
  ['exactly 1 pending job drained', b.jobsDrained === 1],
  ['x after drain === 42 (pending promise survived + fired)', b.xAfterDrain === 42],
  ['inc() returned 43 (closure survived)', b.incResult === 43],
  ['x final === 43', b.xFinal === 43],
];
let pass = true;
for (const [label, ok] of checks) {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
  if (!ok) pass = false;
}

console.log(`\n=== CORE HYPOTHESIS: ${pass ? 'PASS' : 'FAIL'} ===`);
console.log('var + closure + PENDING promise survived a memory+globals snapshot');
console.log('restored into a fresh WASM instance in a fresh process, no source replay.');

if (!pass) process.exit(1);
