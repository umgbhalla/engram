// probes.mjs — the 7 capability probes from the comparison matrix, each an async
// fn(adapter, ctx) -> { capability, outcome, evidence }.
//
// Each probe drives ONLY the adapter's session interface (create/eval/evict/reconnect/
// close), so the identical probe runs against engram-kernel and CF Sandbox.
//
// outcome ∈ { "PASS-claim", "REFUTES-claim", "INCONCLUSIVE", "ERROR" } where the claim is
// the engram-favourable claim in the matrix. For the engram adapter a PASS-claim confirms
// the capability; for the CF adapter a REFUTES-claim (CF cannot do it) is the *expected*
// divergence and is the point of the comparison.
//
// A "session-id factory" is passed via ctx.sid(prefix) so every run is isolated.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- helpers ---------------------------------------------------------------

// Genuine-ish eviction: evict() drops the in-memory kernel on the same identity. For a
// DEEP/genuine idle eviction, close the socket and wait past the window; we expose both.
async function forceEvict(adapter, session, sid) {
  try { await session.evict(); } catch { /* cf may stop/destroy */ }
}

// Re-open a fresh session on the same id and return it.
async function freshSession(adapter, sid) {
  return adapter.reconnect(sid);
}

function ckptBytes(reply) {
  const c = reply && reply.checkpoint;
  if (!c) return null;
  const v = c.sizeGz;
  return typeof v === "number" ? v : null;
}

// ---- CAP-1: live heap survives genuine eviction (zero disk footprint) ------

export async function cap1_liveHeapSurvivesEviction(adapter, ctx) {
  const capability = "CAP-1-live-heap-survives-eviction";
  const sid = ctx.sid("cap1");
  const ev = {};
  try {
    let s = await adapter.connect(sid);
    await s.create({ rngSeed: 7 });

    // Arm a closure capturing a private counter — exists ONLY in interpreter memory.
    await s.eval('let _c=100; globalThis.inc=()=>++_c; "armed"');
    const r1 = await s.eval("inc()");
    ev.preEvictValue = r1.value;            // expect 101

    await forceEvict(adapter, s, sid);
    await s.close();

    // reconnect on same identity, call the heap-only closure again.
    s = await freshSession(adapter, sid);
    const r2 = await s.eval("inc()");
    ev.postEvictValue = r2.value;           // engram: 102, cf: error/reset
    ev.inMemoryBefore = r2.inMemoryBefore;
    ev.restoreSource = r2.restoreSource;
    ev.postEvictError = r2.error || null;
    await s.close();

    const survived = r2.value === 102 && r2.inMemoryBefore === false &&
      /restore/i.test(String(r2.restoreSource || ""));
    const lost = r2.error || r2.value === undefined || r2.value === null ||
      r2.value === 101 /* reset to initial-after-one-inc */;

    return {
      capability,
      outcome: survived ? "PASS-claim" : lost ? "REFUTES-claim" : "INCONCLUSIVE",
      evidence: ev,
    };
  } catch (e) {
    ev.exception = e.message;
    // For CF, a thrown ReferenceError-equivalent at this stage still refutes the claim.
    return { capability, outcome: "ERROR", evidence: ev };
  }
}

// ---- CAP-2: no replay; side effects fire exactly once ----------------------
// External counter endpoint optional (ctx.counterEndpoint). Falls back to an in-heap
// effect-count + a probe that the source cell is NOT re-run after restore (globalThis.fired
// stays 1 with restoreSource ~ /restore/).

export async function cap2_noReplayEffectsOnce(adapter, ctx) {
  const capability = "CAP-2-no-replay-effects-once";
  const sid = ctx.sid("cap2");
  const ev = {};
  const ep = ctx.counterEndpoint; // e.g. https://host/bump?sid=
  try {
    let s = await adapter.connect(sid);
    await s.create({ fetch: ep ? true : false });

    const effectSrc = ep
      ? `(async()=>{ globalThis.fired=(globalThis.fired||0); await host.fetch(${JSON.stringify(ep + sid)}); globalThis.fired++; return globalThis.fired})()`
      : `(()=>{ globalThis.fired=(globalThis.fired||0)+1; return globalThis.fired })()`;

    const r1 = await s.eval(effectSrc);
    ev.firedAfterFirst = r1.value;          // 1

    await forceEvict(adapter, s, sid);
    await s.close();

    s = await freshSession(adapter, sid);
    // Run a DIFFERENT trivial cell. If the system replays prior cells, the effect re-fires.
    const r2 = await s.eval("globalThis.fired");
    ev.firedAfterRestore = r2.value;        // engram: 1 (no replay), cf: undefined (kernel lost)
    ev.inMemoryBefore = r2.inMemoryBefore;
    ev.restoreSource = r2.restoreSource;
    await s.close();

    const heapKept = r2.value === 1 && /restore/i.test(String(r2.restoreSource || ""));
    const lost = r2.value === undefined || r2.value === null || r2.error;
    return {
      capability,
      outcome: heapKept ? "PASS-claim" : lost ? "REFUTES-claim" : "INCONCLUSIVE",
      evidence: ev,
    };
  } catch (e) {
    ev.exception = e.message;
    return { capability, outcome: "ERROR", evidence: ev };
  }
}

// ---- CAP-3: determinism by seed --------------------------------------------

export async function cap3_determinismBySeed(adapter, ctx) {
  const capability = "CAP-3-determinism-by-seed";
  const drawAll = '[Math.random(),Math.random(),Date.now(),(typeof crypto!=="undefined"&&crypto.randomUUID)?crypto.randomUUID():null]';
  const drawTwo = "[Math.random(),Math.random()]";
  const ev = {};
  try {
    // Session A
    const sidA = ctx.sid("cap3a");
    let a = await adapter.connect(sidA);
    await a.create({ rngSeed: 7, clock: "frozen" });
    const a1 = await a.eval(drawAll);
    ev.A_R1 = a1.value;
    await forceEvict(adapter, a, sidA);
    await a.close();
    a = await freshSession(adapter, sidA);
    const a2 = await a.eval(drawTwo);
    ev.A_R2 = a2.value;
    await a.close();

    // Session B — fresh id, same seed
    const sidB = ctx.sid("cap3b");
    const b = await adapter.connect(sidB);
    await b.create({ rngSeed: 7, clock: "frozen" });
    const b1 = await b.eval(drawAll);
    ev.B_R1 = b1.value;
    await b.close();

    const A = ev.A_R1, B = ev.B_R1;
    const fieldsEqual = Array.isArray(A) && Array.isArray(B)
      ? A.reduce((n, v, i) => n + (JSON.stringify(v) === JSON.stringify(B[i]) ? 1 : 0), 0)
      : 0;
    ev.byteIdenticalFields = `${fieldsEqual}/${Array.isArray(A) ? A.length : 0}`;
    // continuity: R2 must continue A's PRNG stream (cannot equal R1's first two draws if seeded
    // PRNG advanced) — we just record it; the strong assertion is cross-session byte-equality.
    ev.A_R2_continues = Array.isArray(ev.A_R2);

    const crossIdentical = Array.isArray(A) && fieldsEqual === A.length;
    // CF: at minimum time + uuid fields diverge => fewer than all fields identical.
    return {
      capability,
      outcome: crossIdentical ? "PASS-claim" : (fieldsEqual < (Array.isArray(A) ? A.length : 1) ? "REFUTES-claim" : "INCONCLUSIVE"),
      evidence: ev,
    };
  } catch (e) {
    ev.exception = e.message;
    return { capability, outcome: "ERROR", evidence: ev };
  }
}

// ---- CAP-4: per-cell snapshot granularity (byte-delta, sub-KB) -------------

export async function cap4_perCellSnapshotGranularity(adapter, ctx) {
  const capability = "CAP-4-per-cell-snapshot-granularity";
  const sid = ctx.sid("cap4");
  const ev = { perCell: [] };
  try {
    let s = await adapter.connect(sid);
    await s.create({});
    for (let i = 0; i < 10; i++) {
      const r = await s.eval("globalThis.n=(globalThis.n||0)+1");
      const c = r.checkpoint || {};
      ev.perCell.push({ n: r.value, mode: c.mode ?? null, sizeGz: c.sizeGz ?? null, store: c.store ?? null });
    }
    // cold-restore correctness
    await forceEvict(adapter, s, sid);
    await s.close();
    s = await freshSession(adapter, sid);
    const rf = await s.eval("globalThis.n");
    ev.afterRestoreN = rf.value;
    await s.close();

    // Steady-state cells = drop the first (base) cell.
    const steady = ev.perCell.slice(1).filter((c) => typeof c.sizeGz === "number");
    const sizes = steady.map((c) => c.sizeGz).sort((x, y) => x - y);
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : null;
    ev.medianSteadySizeGz = median;
    ev.deltaModeCount = steady.filter((c) => c.mode === "delta").length;
    ev.hasPerCellDurability = steady.some((c) => typeof c.sizeGz === "number" && c.store && c.store !== "none");

    const engramLike = median !== null && median < 2048 && ev.deltaModeCount > 0 && rf.value === 10;
    const cfLike = !ev.hasPerCellDurability; // CF: no automatic sub-KB per-cell checkpoint
    return {
      capability,
      outcome: engramLike ? "PASS-claim" : cfLike ? "REFUTES-claim" : "INCONCLUSIVE",
      evidence: ev,
    };
  } catch (e) {
    ev.exception = e.message;
    return { capability, outcome: "ERROR", evidence: ev };
  }
}

// ---- CAP-5: zero idle cost (genuine eviction + state survival) -------------
// Idle billing is not directly observable from the client; we prove the *survival side*
// (state survives a long idle with NO traffic) + record that no keepAlive/heartbeat was
// sent. ctx.idleMs controls the wait (default short for CI; set ~20min for the real test).

export async function cap5_zeroIdleCost(adapter, ctx) {
  const capability = "CAP-5-zero-idle-cost";
  const sid = ctx.sid("cap5");
  const idleMs = ctx.idleMs ?? 3000;
  const ev = { idleMs, heartbeatsSent: 0 };
  try {
    let s = await adapter.connect(sid);
    await s.create({});
    await s.eval("globalThis.k=777");
    await s.close(); // no keepAlive — socket closed, no traffic during idle

    await sleep(idleMs); // (for the genuine test set ctx.idleMs ~ 20*60*1000)

    s = await freshSession(adapter, sid);
    const r = await s.eval("globalThis.k");
    ev.value = r.value;
    ev.inMemoryBefore = r.inMemoryBefore;
    ev.restoreSource = r.restoreSource;
    await s.close();

    const survivedAtZeroCost = r.value === 777 && r.inMemoryBefore === false;
    // CF: to keep live k it must keepAlive (billed); without it k is lost.
    const lost = r.value === undefined || r.value === null || r.error;
    ev.note = idleMs < 60000
      ? "short idle (CI) — may not exceed the genuine eviction window; set ctx.idleMs ~20min for the real test"
      : "idle exceeded typical eviction window";
    return {
      capability,
      outcome: survivedAtZeroCost ? "PASS-claim" : lost ? "REFUTES-claim" : "INCONCLUSIVE",
      evidence: ev,
    };
  } catch (e) {
    ev.exception = e.message;
    return { capability, outcome: "ERROR", evidence: ev };
  }
}

// ---- CAP-6: cold-wake latency distribution ---------------------------------

export async function cap6_wakeLatencyDistribution(adapter, ctx) {
  const capability = "CAP-6-wake-latency-distribution";
  const M = ctx.wakeSamples ?? 12;
  const samples = [];
  const ev = { samples: M, wallMs: [], restoreSources: {} };
  try {
    for (let i = 0; i < M; i++) {
      const sid = ctx.sid(`cap6-${i}`);
      let s = await adapter.connect(sid);
      await s.create({});
      await s.eval("globalThis.k=1");
      await forceEvict(adapter, s, sid);
      await s.close();

      const t0 = Date.now();
      s = await freshSession(adapter, sid);
      const r = await s.eval("globalThis.k");
      const dt = Date.now() - t0;
      await s.close();
      samples.push(dt);
      ev.wallMs.push(dt);
      const rs = String(r.restoreSource || "?");
      ev.restoreSources[rs] = (ev.restoreSources[rs] || 0) + 1;
    }
    samples.sort((a, b) => a - b);
    const pct = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))];
    ev.p50 = pct(50); ev.p95 = pct(95); ev.p99 = pct(99);

    // engram claim: p50 < ~300ms. cf claim: p50 >= ~1500ms (container floor).
    const fast = ev.p50 < 300;
    const slowFloor = ev.p50 >= 1500;
    return {
      capability,
      outcome: fast ? "PASS-claim" : slowFloor ? "REFUTES-claim" : "INCONCLUSIVE",
      evidence: ev,
    };
  } catch (e) {
    ev.exception = e.message;
    return { capability, outcome: "ERROR", evidence: ev };
  }
}

// ---- CAP-7: concurrency isolation at scale ---------------------------------
// A lightweight inline check (K small, default 12). The heavy ramp lives in scale.mjs.

export async function cap7_concurrencyIsolation(adapter, ctx) {
  const capability = "CAP-7-concurrency-isolation-at-scale";
  const K = ctx.isoK ?? 12;
  const ev = { K, errors: 0, isolationViolations: 0, leaks: [] };
  try {
    const ids = Array.from({ length: K }, (_, i) => ctx.sid(`cap7-${i}`));
    await Promise.all(ids.map(async (sid) => {
      try {
        const s = await adapter.connect(sid);
        await s.create({});
        await s.eval(`globalThis.secret=${JSON.stringify(sid)}; globalThis.secret`);
        // read own secret
        const own = await s.eval("globalThis.secret");
        if (own.value !== sid) { ev.isolationViolations++; ev.leaks.push({ sid, own: own.value }); }
        // probe for any sibling secret bleed (no other session's global should be visible)
        const probe = await s.eval(`(typeof globalThis.__sibling__!=="undefined")?globalThis.__sibling__:null`);
        if (probe.value) { ev.isolationViolations++; ev.leaks.push({ sid, sibling: probe.value }); }
        await s.close();
      } catch (e) {
        ev.errors++;
      }
    }));
    const clean = ev.errors === 0 && ev.isolationViolations === 0;
    return {
      capability,
      outcome: clean ? "PASS-claim" : (ev.errors > 0 || ev.isolationViolations > 0 ? "REFUTES-claim" : "INCONCLUSIVE"),
      evidence: ev,
    };
  } catch (e) {
    ev.exception = e.message;
    return { capability, outcome: "ERROR", evidence: ev };
  }
}

export const ALL_PROBES = [
  cap1_liveHeapSurvivesEviction,
  cap2_noReplayEffectsOnce,
  cap3_determinismBySeed,
  cap4_perCellSnapshotGranularity,
  cap5_zeroIdleCost,
  cap6_wakeLatencyDistribution,
  cap7_concurrencyIsolation,
];
