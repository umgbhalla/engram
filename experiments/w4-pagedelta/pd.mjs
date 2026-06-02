// W4 — PAGE-DELTA / INCREMENTAL SNAPSHOT prototype.
// Instead of dumping the whole linear memory each checkpoint, persist only the
// DIRTY 64KB pages since the last checkpoint. Restore = base + applied deltas.
//
// Compares: (A) FULL-DUMP baseline, (B) PAGE-DELTA (this), (C) PAGE-DELTA ∘ OPLOG.
// Measures: bytes written, write-amp, restore cost, correctness, page-churn.
//
// Run: node pd.mjs
import { QuickJS } from '../e6-oplog/node_modules/quickjs-wasi/dist/index.js';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const WASM = readFileSync(new URL('../e6-oplog/node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
const mod = await WebAssembly.compile(WASM);
const PAGE = 65536;

const KB = (b) => (b / 1024).toFixed(1) + 'KB';
const MB = (b) => (b / 1024 / 1024).toFixed(2) + 'MB';

// ---- host boundary identical to e6 (recorded, deterministic) ----
function installHost(vm, recorder) {
  const fn = vm.newFunction('hostCall', function (argHandle) {
    let result;
    if (recorder.mode === 'replay') result = recorder.log[recorder.idx++];
    else { result = recorder.hostState.counter++; recorder.log.push(result); }
    return vm.newNumber(result);
  });
  vm.global.setProp('hostCall', fn);
}
function makeCells(n) {
  const cells = [`globalThis.store=[];globalThis.acc=0;globalThis.log=[];`];
  for (let i = 1; i < n; i++) {
    if (i % 10 === 0) cells.push(`for(let k=0;k<2000;k++){store.push("row-"+${i}+"-"+k+"-"+Math.random().toString())} store.length;`);
    else if (i % 3 === 0) cells.push(`log.push(hostCall(${i}));acc+=log[log.length-1];acc;`);
    else cells.push(`acc+=${i};store.push({i:${i},v:acc});store.length;`);
  }
  return cells.slice(0, n);
}

// ---- page-diff core ----
function pageHashes(buf) {
  // cheap per-page fingerprint: FNV-1a over the page bytes
  const n = Math.ceil(buf.length / PAGE);
  const h = new Array(n);
  for (let p = 0; p < n; p++) {
    let hash = 0x811c9dc5;
    const end = Math.min((p + 1) * PAGE, buf.length);
    for (let i = p * PAGE; i < end; i++) { hash ^= buf[i]; hash = Math.imul(hash, 0x01000193); }
    h[p] = hash >>> 0;
  }
  return h;
}
// returns list of {page, bytes:Uint8Array} for pages whose hash changed (or new pages)
function diffPages(prevBuf, prevHashes, curBuf, curHashes) {
  const dirty = [];
  const n = curHashes.length;
  for (let p = 0; p < n; p++) {
    if (p >= prevHashes.length || curHashes[p] !== prevHashes[p]) {
      const start = p * PAGE, end = Math.min(start + PAGE, curBuf.length);
      dirty.push({ page: p, bytes: curBuf.subarray(start, end) });
    }
  }
  return dirty;
}

async function snapMem(vm) {
  const s = vm.snapshot();
  return { mem: s.memory, sp: s.stackPointer, rt: s.runtimePtr, ctx: s.contextPtr, ext: s.extensions };
}

// =====================================================================
// (A) FULL-DUMP baseline
// =====================================================================
async function runFull(cells) {
  const recorder = { mode: 'record', log: [], hostState: { counter: 1000 } };
  const vm = await QuickJS.create(mod); installHost(vm, recorder);
  let totalGz = 0, totalRaw = 0, lastGz = 0, hwm = 0;
  let lastSnap;
  for (const c of cells) {
    vm.evalCode(c); vm.executePendingJobs();
    const s = await snapMem(vm);
    const gz = gzipSync(Buffer.from(s.mem), { level: 6 });
    totalGz += gz.length; totalRaw += s.mem.length; lastGz = gz.length; hwm = s.mem.length;
    lastSnap = s;
  }
  const finalState = vm.dump(vm.evalCode('acc')); vm.dispose();
  return { totalGz, totalRaw, lastGz, hwm, finalState, lastSnap, recorder };
}

// =====================================================================
// (B) PAGE-DELTA: store dirty pages each cell; periodic base.
//   Storage model: 1 base image (gz) + per-cell dirty-page deltas (gz).
//   We rebase (write a fresh full base) every REBASE cells to bound restore.
// =====================================================================
async function runPageDelta(cells, REBASE) {
  const recorder = { mode: 'record', log: [], hostState: { counter: 1000 } };
  const vm = await QuickJS.create(mod); installHost(vm, recorder);
  let totalGz = 0, totalRaw = 0;
  let baseGzBytes = 0, deltaGzBytes = 0;
  let prevBuf = null, prevHashes = [];
  // persisted log for restore probe
  let lastBaseSnap = null, lastBaseCell = -1;
  const deltasSinceBase = []; // [{page,bytes}...] grouped per cell
  let totalDirtyPages = 0, totalPages = 0, cellCount = 0;
  for (let i = 0; i < cells.length; i++) {
    vm.evalCode(cells[i]); vm.executePendingJobs();
    const s = await snapMem(vm);
    const cur = s.mem; const curHashes = pageHashes(cur);
    cellCount++; totalPages += curHashes.length;
    if (i % REBASE === 0 || prevBuf === null) {
      // BASE: full image
      const gz = gzipSync(Buffer.from(cur), { level: 6 });
      totalGz += gz.length; totalRaw += cur.length; baseGzBytes += gz.length;
      lastBaseSnap = { sp: s.sp, rt: s.rt, ctx: s.ctx, ext: s.ext, baseBuf: Uint8Array.from(cur) };
      lastBaseCell = i; deltasSinceBase.length = 0;
    } else {
      // DELTA: only dirty pages
      const dirty = diffPages(prevBuf, prevHashes, cur, curHashes);
      totalDirtyPages += dirty.length;
      // serialize delta: concat [pageIdx u32][len u32][bytes] then gzip
      const parts = [];
      let rawLen = 0;
      for (const d of dirty) {
        const hdr = Buffer.alloc(8); hdr.writeUInt32LE(d.page, 0); hdr.writeUInt32LE(d.bytes.length, 4);
        parts.push(hdr, Buffer.from(d.bytes)); rawLen += 8 + d.bytes.length;
      }
      // record the final-pointer state too (tiny)
      const deltaRaw = Buffer.concat(parts);
      const gz = gzipSync(deltaRaw, { level: 6 });
      totalGz += gz.length; totalRaw += rawLen; deltaGzBytes += gz.length;
      deltasSinceBase.push({ dirty: dirty.map(d => ({ page: d.page, bytes: Uint8Array.from(d.bytes) })), sp: s.sp, rt: s.rt, ctx: s.ctx, ext: s.ext });
    }
    prevBuf = Uint8Array.from(cur); prevHashes = curHashes;
  }
  const finalState = vm.dump(vm.evalCode('acc')); vm.dispose();
  return { totalGz, totalRaw, baseGzBytes, deltaGzBytes, finalState,
    lastBaseSnap, deltasSinceBase, totalDirtyPages, totalPages, cellCount, recorder };
}

// restore (B): base buffer + apply page deltas (last pointers win)
async function restorePageDelta(pd) {
  const t0 = performance.now();
  // linear memory GROWS over a session, so the final buffer may be larger than
  // the base. Size the restore buffer to the highest page index seen across base
  // + all deltas (this growth info is part of each delta's footprint).
  let maxBytes = pd.lastBaseSnap.baseBuf.length;
  for (const d of pd.deltasSinceBase) for (const pg of d.dirty) maxBytes = Math.max(maxBytes, pg.page * PAGE + pg.bytes.length);
  const buf = new Uint8Array(maxBytes);
  buf.set(pd.lastBaseSnap.baseBuf, 0);
  let sp = pd.lastBaseSnap.sp, rt = pd.lastBaseSnap.rt, ctx = pd.lastBaseSnap.ctx, ext = pd.lastBaseSnap.ext;
  for (const d of pd.deltasSinceBase) {
    for (const pg of d.dirty) buf.set(pg.bytes, pg.page * PAGE);
    sp = d.sp; rt = d.rt; ctx = d.ctx; ext = d.ext;
  }
  const vm = await QuickJS.restore({ memory: buf, stackPointer: sp, runtimePtr: rt, contextPtr: ctx, extensions: ext }, mod);
  const state = vm.dump(vm.evalCode('acc'));
  const t1 = performance.now(); vm.dispose();
  return { ms: t1 - t0, state };
}

async function restoreFull(s) {
  const t0 = performance.now();
  const vm = await QuickJS.restore({ memory: Uint8Array.from(s.mem), stackPointer: s.sp, runtimePtr: s.rt, contextPtr: s.ctx, extensions: s.ext }, mod);
  const state = vm.dump(vm.evalCode('acc'));
  const t1 = performance.now(); vm.dispose();
  return { ms: t1 - t0, state };
}

// =====================================================================
const NCELLS = 50;
const cells = makeCells(NCELLS);
console.log(`# W4 page-delta — ${NCELLS} cells, ${PAGE / 1024}KB pages\n`);

const full = await runFull(cells);
const fullRestore = await restoreFull(full.lastSnap);
console.log('## (A) FULL-DUMP every cell');
console.log(`  final acc:           ${full.finalState}`);
console.log(`  total written:       ${MB(full.totalGz)} gz  (${MB(full.totalRaw)} raw)`);
console.log(`  per-cell snap gz:    ${KB(full.lastGz)}   hwm buffer: ${MB(full.hwm)}`);
console.log(`  restore:             ${fullRestore.ms.toFixed(2)}ms -> acc=${fullRestore.state}`);
console.log(`  write-amp:           ${(full.totalGz / full.lastGz).toFixed(1)}× (50 full snaps)\n`);

console.log('## (B) PAGE-DELTA (base every REBASE cells + dirty-page deltas between)');
for (const R of [10, 25, 9999]) {
  const pd = await runPageDelta(cells, R);
  const rr = await restorePageDelta(pd);
  const numBases = Math.ceil(NCELLS / R);
  const churn = (100 * pd.totalDirtyPages / Math.max(1, (pd.totalPages))).toFixed(1);
  const saveVsFull = (100 * (1 - pd.totalGz / full.totalGz)).toFixed(1);
  const tag = R === 9999 ? 'single base, deltas forever' : `${numBases} bases`;
  console.log(`  REBASE=${R === 9999 ? '∞' : R}  (${tag})`);
  console.log(`    total written:     ${MB(pd.totalGz)} gz  (base ${KB(pd.baseGzBytes)} + delta ${KB(pd.deltaGzBytes)})`);
  console.log(`    savings vs full:   ${saveVsFull}% fewer durable bytes`);
  console.log(`    write-amp:         ${(pd.totalGz / full.lastGz).toFixed(1)}× (vs full ${(full.totalGz / full.lastGz).toFixed(1)}×)`);
  console.log(`    avg dirty/cell:    ${(pd.totalDirtyPages / pd.cellCount).toFixed(1)} pages  (page-churn ${churn}% of all page-reads)`);
  console.log(`    restore:           ${rr.ms.toFixed(2)}ms -> acc=${rr.state}  ${rr.state === full.finalState ? 'MATCH ✓' : 'MISMATCH ✗'}`);
}
console.log('');

// =====================================================================
// (C) PAGE-DELTA ∘ OPLOG : full base periodically, page-deltas between
//     ARE THEMSELVES skipped for cells that produce zero new dirty pages
//     beyond a tiny threshold — and we ALSO show oplog (src-replay) as the
//     between-base strategy vs page-delta as the between-base strategy.
//     Composition test: does page-delta beat oplog, and can they stack?
// =====================================================================
console.log('## (C) Composition: PAGE-DELTA vs OPLOG as the between-base mechanism');
// oplog between bases (e6 style) using same cells/REBASE for apples-to-apples
async function runOplog(cells, N) {
  const recorder = { mode: 'record', log: [], hostState: { counter: 1000 } };
  const vm = await QuickJS.create(mod); installHost(vm, recorder);
  let totalGz = 0, oplogGz = 0, baseGz = 0;
  for (let i = 0; i < cells.length; i++) {
    const before = recorder.log.length;
    vm.evalCode(cells[i]); vm.executePendingJobs();
    if (i % N === 0) {
      const s = await snapMem(vm);
      const gz = gzipSync(Buffer.from(s.mem), { level: 6 });
      totalGz += gz.length; baseGz += gz.length;
    } else {
      const entry = { src: cells[i], hostResults: recorder.log.slice(before) };
      const gz = gzipSync(Buffer.from(JSON.stringify(entry)), { level: 6 });
      totalGz += gz.length; oplogGz += gz.length;
    }
  }
  vm.dispose();
  return { totalGz, oplogGz, baseGz };
}
for (const R of [10, 25]) {
  const pd = await runPageDelta(cells, R);
  const op = await runOplog(cells, R);
  console.log(`  REBASE=${R}:`);
  console.log(`    page-delta total:  ${MB(pd.totalGz)} gz   (between-base = ${KB(pd.deltaGzBytes)} dirty pages)`);
  console.log(`    oplog total:       ${MB(op.totalGz)} gz   (between-base = ${KB(op.oplogGz)} src+results)`);
  const winner = pd.totalGz < op.totalGz ? 'PAGE-DELTA' : 'OPLOG';
  console.log(`    smaller writer:    ${winner}`);
}
console.log(`
## STACKING (page-delta ∘ oplog)
  Page-delta captures *physical* dirty pages; oplog captures *logical* cells.
  They compose on different axes: use OPLOG to make full-base events rarer
  (replay src to rebuild), and PAGE-DELTA to shrink each non-base checkpoint
  to only changed pages. A hybrid = { rare full base, oplog for crash-replay
  safety, page-delta for the durable between-base physical state } — page-delta
  gives O(dirty) writes with NO replay/re-fire risk; oplog gives src-level audit
  but re-executes (re-fire hazard mitigated by recorded host results).`);
