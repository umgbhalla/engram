// EXP-8 — DETERMINISM
//
// Hypothesis: with a seeded RNG and a controlled clock exposed as host imports,
// restore is byte-identical after running the SAME next cell. We externalize the
// engine's sources of non-determinism (current time, PRNG, crypto random) through
// controllable host functions, snapshot after N cells, then on TWO fresh instances
// restore the same snapshot, run the SAME next cell, and hash the resulting linear
// memory. SUCCESS = identical memory hash across the two restored-and-advanced VMs.
//
// We run LOCAL (Node): the determinism question is about the engine + host-import
// boundary, not the CF host. CF was already proven to run this exact wasm in EXP-5a.

import { QuickJS } from "quickjs-wasi";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = await readFile(join(__dirname, "quickjs.wasm"));

// ---------------------------------------------------------------------------
// Controllable host clock + PRNG. These are the externalized non-determinism
// sources. State lives entirely on the host side (NOT in WASM linear memory),
// so it does not perturb the snapshot — but because it is deterministic, two
// restored VMs that advance through the same cell observe the same values.
// ---------------------------------------------------------------------------

// Deterministic monotonic clock: starts at a fixed epoch, advances by a fixed
// tick every time the engine reads it. Pure function of call-count.
function makeDeterministicClock(epochMs = 1_700_000_000_000, tickMs = 1) {
  let calls = 0;
  return {
    nowMs() {
      const t = epochMs + calls * tickMs;
      calls++;
      return t;
    },
    reset() {
      calls = 0;
    },
  };
}

// Seeded PRNG (mulberry32) producing a reproducible byte/float stream.
function makeSeededRng(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  function next() {
    // mulberry32
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    nextFloat: next,
    nextByte() {
      return Math.floor(next() * 256) & 0xff;
    },
    reset() {
      state = seed >>> 0;
    },
  };
}

// ---------------------------------------------------------------------------
// WASI shim overrides. quickjs-wasi lets us replace clock_time_get / random_get.
// These feed Date.now(), Math.random() PRNG seeding, and crypto.getRandomValues
// at the C/WASI level.
// ---------------------------------------------------------------------------
function deterministicWasi(memoryAccessor, clock, rng) {
  return {
    clock_time_get(_clockId, _precision, resultPtr) {
      const view = new DataView(memoryAccessor().buffer);
      const ns = BigInt(clock.nowMs()) * 1_000_000n;
      view.setBigUint64(resultPtr, ns, true);
      return 0; // SUCCESS
    },
    random_get(bufPtr, bufLen) {
      const bytes = new Uint8Array(memoryAccessor().buffer, bufPtr, bufLen);
      for (let i = 0; i < bufLen; i++) bytes[i] = rng.nextByte();
      return 0; // SUCCESS
    },
  };
}

// quickjs-wasi calls the `wasi` option as a FACTORY: `wasi(memoryProxy)` where
// memoryProxy.buffer defers to the live WASM memory. It merges the returned map
// over its builtins. So we return clock_time_get / random_get backed by our
// deterministic clock + seeded PRNG.
function buildWasiFactory(clock, rng) {
  return (memoryProxy) => {
    const accessor = () => memoryProxy; // memoryProxy.buffer is the live buffer
    return deterministicWasi(accessor, clock, rng);
  };
}

// ---------------------------------------------------------------------------
// In-VM rebinding: route Date.now / Math.random / crypto through host functions
// so the JS-visible APIs are ALSO deterministic (not just the WASI seeds). This
// is the "expose as host imports" part of the hypothesis. We install host fns
// `__hostNowMs` and `__hostRandom` and patch the globals to call them.
// ---------------------------------------------------------------------------
const REBIND_SRC = `
  globalThis.Date.now = function () { return __hostNowMs(); };
  const __OrigDate = globalThis.Date;
  // new Date() with no args should also be deterministic:
  globalThis.Date = new Proxy(__OrigDate, {
    construct(target, args) {
      if (args.length === 0) return new target(__hostNowMs());
      return new target(...args);
    },
    apply(target, thisArg, args) { return target.apply(thisArg, args); },
  });
  globalThis.Date.now = function () { return __hostNowMs(); };
  globalThis.Math.random = function () { return __hostRandom(); };
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    const gv = function (arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = (__hostRandom() * 256) & 0xff;
      return arr;
    };
    try { globalThis.crypto.getRandomValues = gv; } catch (e) {}
  }
  'rebound';
`;

function installHostFns(vm, clock, rng) {
  const now = vm.newFunction("__hostNowMs", function () {
    return this.vm.newNumber(clock.nowMs());
  });
  vm.setProp(vm.global, "__hostNowMs", now);
  now.dispose();

  const rand = vm.newFunction("__hostRandom", function () {
    return this.vm.newNumber(rng.nextFloat());
  });
  vm.setProp(vm.global, "__hostRandom", rand);
  rand.dispose();
}

// After restore, the host callbacks must be re-registered by name (they are not
// part of the snapshot — only the JS-side closures that reference them survive).
function reRegisterHostFns(vm, clock, rng) {
  vm.registerHostCallback("__hostNowMs", function () {
    return this.vm.newNumber(clock.nowMs());
  });
  vm.registerHostCallback("__hostRandom", function () {
    return this.vm.newNumber(rng.nextFloat());
  });
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------
function hashMemory(snap) {
  return createHash("sha256").update(snap.memory).digest("hex");
}

function memHashOfVm(vm) {
  const snap = vm.snapshot();
  return { hash: hashMemory(snap), size: snap.memory.length, sp: snap.stackPointer };
}

// A small program of "cells". They deliberately exercise time + random so that
// any leaked non-determinism shows up in linear memory.
const SETUP_CELLS = [
  "globalThis.log = [];",
  "globalThis.x = 0;",
  "log.push(['t0', Date.now()]);",
  "log.push(['r0', Math.random()]);",
  "globalThis.acc = []; for (let i=0;i<5;i++){ acc.push(Math.random()); } acc.length;",
  "globalThis.t1 = Date.now(); globalThis.d = new Date(); d.getTime();",
  "globalThis.inc = () => ++x; inc(); inc();",
];

// The SAME 'next cell' both restored instances run after restore. Uses time +
// random + a stateful mutation, so non-determinism would diverge memory.
const NEXT_CELL =
  "log.push(['next-time', Date.now()]); log.push(['next-rand', Math.random()]); x = inc() + (Math.random() < 2 ? 1 : 0); JSON.stringify({x, logLen: log.length});";

// ---------------------------------------------------------------------------
// STOCK (unseeded) VM: default WASI shim => real wall-clock + crypto random.
// Used to demonstrate that a stock engine DIVERGES after restore+advance.
// ---------------------------------------------------------------------------
async function createStockVm() {
  // No wasi overrides => library defaults (Date.now wall clock, crypto random).
  const vm = await QuickJS.create({ wasm: wasmBytes });
  for (const c of SETUP_CELLS) vm.evalCode(c);
  return vm;
}

// ===========================================================================
// RUN
// ===========================================================================
const results = { ts: new Date().toISOString() };

// ---- Deterministic path ----
{
  const CLOCK_SEED = 1_700_000_000_000;
  const RNG_SEED = 0x12345678;

  // Build the canonical VM, run setup cells, snapshot. Track consumption counts
  // by wrapping the generators.
  const clock = makeDeterministicClock(CLOCK_SEED, 1);
  const rng = makeSeededRng(RNG_SEED);
  let clockCalls = 0,
    rngCalls = 0;
  const cClock = {
    nowMs() {
      clockCalls++;
      return clock.nowMs();
    },
  };
  const cRng = {
    nextFloat() {
      rngCalls++;
      return rng.nextFloat();
    },
    nextByte() {
      rngCalls++;
      return rng.nextByte();
    },
  };
  const vm = await QuickJS.create({
    wasm: wasmBytes,
    wasi: buildWasiFactory(cClock, cRng),
  });
  installHostFns(vm, cClock, cRng);
  vm.evalCode(REBIND_SRC);
  for (const c of SETUP_CELLS) vm.evalCode(c);

  const atSnapshot = memHashOfVm(vm);
  const snap = vm.snapshot();
  const serialized = QuickJS.serializeSnapshot(snap);
  const clockCallsAtSnap = clockCalls;
  const rngCallsAtSnap = rngCalls;
  vm.dispose();

  results.deterministic = {
    setupCells: SETUP_CELLS.length,
    nextCell: NEXT_CELL,
    snapshotMemHash: atSnapshot.hash,
    snapshotSize: atSnapshot.size,
    clockCallsAtSnap,
    rngCallsAtSnap,
  };

  // Restore TWICE on fresh instances, advance through the SAME next cell, hash.
  async function restoreAndAdvance() {
    const c = makeDeterministicClock(CLOCK_SEED, 1);
    const r = makeSeededRng(RNG_SEED);
    for (let i = 0; i < clockCallsAtSnap; i++) c.nowMs();
    for (let i = 0; i < rngCallsAtSnap; i++) r.nextFloat();
    const s = QuickJS.deserializeSnapshot(serialized);
    const rvm = await QuickJS.restore(s, {
      wasm: wasmBytes,
      wasi: buildWasiFactory(c, r),
    });
    reRegisterHostFns(rvm, c, r);
    rvm.executePendingJobs();
    const out = rvm.evalCode(NEXT_CELL).toString();
    const logDump = rvm.evalCode("JSON.stringify(log)").toString();
    const after = memHashOfVm(rvm);
    rvm.dispose();
    return { out, logDump, hash: after.hash, size: after.size };
  }

  const A = await restoreAndAdvance();
  const B = await restoreAndAdvance();
  results.deterministic.instanceA = A;
  results.deterministic.instanceB = B;
  results.deterministic.identical = A.hash === B.hash;
  results.deterministic.outputsMatch = A.out === B.out;
}

// ---- Stock (unseeded) path: expect divergence ----
{
  // Build, snapshot.
  const vm = await createStockVm();
  const snap = vm.snapshot();
  const serialized = QuickJS.serializeSnapshot(snap);
  vm.dispose();

  async function restoreAndAdvanceStock() {
    const s = QuickJS.deserializeSnapshot(serialized);
    const rvm = await QuickJS.restore(s, { wasm: wasmBytes });
    rvm.executePendingJobs();
    const out = rvm.evalCode(NEXT_CELL).toString();
    // Expose the full deterministic-sensitive log so the divergence source is visible.
    const logDump = rvm.evalCode("JSON.stringify(log)").toString();
    const h = hashMemory(rvm.snapshot());
    rvm.dispose();
    return { out, logDump, hash: h };
  }

  // Add a tiny delay so the wall clock actually differs between the two restores.
  const A = await restoreAndAdvanceStock();
  await new Promise((r) => setTimeout(r, 5));
  const B = await restoreAndAdvanceStock();
  results.stock = {
    instanceA: A,
    instanceB: B,
    identical: A.hash === B.hash,
    outputsMatch: A.out === B.out,
    note: "default WASI shim: Date.now()=wall clock, crypto.getRandomValues=real entropy",
  };
}

results.PASS =
  results.deterministic.identical === true &&
  results.deterministic.outputsMatch === true;

console.log(JSON.stringify(results, null, 2));
