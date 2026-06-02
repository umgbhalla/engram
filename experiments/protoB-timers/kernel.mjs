// PROTOTYPE B — durable, seeded, hibernation-safe setTimeout/setInterval.
//
// MODEL OF FIRING: seeded virtual time.
//   - There is one monotonic virtual clock: nowTick (a tick = 1 unit; seeded epoch 1.7e12 ms).
//   - setTimeout(fn,ms) => fireAtTick = nowTick + ms (ms == ticks; the seeded clock advances
//     in 1ms steps, so 1 tick == 1 virtual ms). Deterministic, wall-time independent.
//   - Firing is driven by advancing the clock, NOT by real wall time. A real hibernation of any
//     length maps to "advance nowTick by (wakeTick - lastTick)"; we choose lastTick = the tick at
//     snapshot, and on wake the alarm advances nowTick to whatever virtual time the supervisor
//     decides has elapsed (here: caller-driven advanceClock). Exactly-once is enforced by the
//     DURABLE host registry (fireAtTick + a fired flag), not by the in-memory scheduler.
//
// SPLIT OF STATE (the hard part):
//   - VM HEAP holds: the callback closures, keyed by id, in globalThis.__timers.  (snapshot captures)
//   - HOST REGISTRY (durable, in SQLite manifest) holds: {id, fireAtTick, intervalMs, kind, alive}.
//     NO callback on the host side — only schedule metadata. The callback can ONLY be reached by
//     blitting the heap back, which is the whole proof.
//
// On a host call (setTimeout/clearTimeout) the VM mutates its heap AND calls back to the host to
// persist the registry row. On drain, the host tells the VM which ids to fire (by fireAtTick), the
// VM runs the closures from its heap; the host marks one-shots dead / reschedules intervals.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const PKG = join(ROOT, 'node_modules/.bun/quickjs-wasi@3.0.0/node_modules/quickjs-wasi');
const { QuickJS } = await import(join(PKG, 'dist/index.js'));
const WASM = readFileSync(join(PKG, 'quickjs.wasm'));
const MODULE = await WebAssembly.compile(WASM);

// The seeded clock + RNG live in the VM as plain state so they snapshot. The HOST owns nowTick
// authoritatively (in the manifest) so the alarm can advance it without the VM running.

// VM bootstrap source — installs the timer runtime into the heap.
const BOOT = `
globalThis.__timers = globalThis.__timers || {};   // id -> { fn, fireAtTick, intervalMs, kind }
globalThis.__nextTimerId = globalThis.__nextTimerId || 1;
globalThis.__nowTick = (typeof globalThis.__nowTick === 'number') ? globalThis.__nowTick : 1700000000000;

// host bridge: __persistTimer(id, json) and __dropTimer(id) are host callbacks registered by name.
function __register(kind, fn, ms, repeat) {
  const id = globalThis.__nextTimerId++;
  const intervalMs = repeat ? ms : 0;
  globalThis.__timers[id] = { fn, fireAtTick: globalThis.__nowTick + ms, intervalMs, kind };
  __persistTimer(id, JSON.stringify({ id, fireAtTick: globalThis.__timers[id].fireAtTick, intervalMs, kind, alive: true }));
  return id;
}
globalThis.setTimeout  = (fn, ms) => __register('timeout',  fn, ms|0, false);
globalThis.setInterval = (fn, ms) => __register('interval', fn, ms|0, true);
globalThis.clearTimeout = globalThis.clearInterval = (id) => {
  if (globalThis.__timers[id]) { delete globalThis.__timers[id]; __dropTimer(id); }
};

// Driven by the host scheduler. Fires exactly the ids the host hands us (host is the exactly-once
// authority). Returns, for each interval that fired, its new fireAtTick so host can persist it.
globalThis.__fire = (id, atTick) => {
  globalThis.__nowTick = atTick;
  const t = globalThis.__timers[id];
  if (!t) return JSON.stringify({ ran: false });          // already cleared in heap — skip
  let err = null;
  try { t.fn(); } catch (e) { err = String(e); }
  if (t.intervalMs > 0) {
    t.fireAtTick = atTick + t.intervalMs;                 // reschedule
    return JSON.stringify({ ran: true, reschedule: true, fireAtTick: t.fireAtTick, err });
  } else {
    delete globalThis.__timers[id];                       // one-shot done
    return JSON.stringify({ ran: true, reschedule: false, err });
  }
};
'booted';
`;

export class TimerKernel {
  // store = SqliteSim, r2 = R2Sim, name = session id
  constructor(store, r2, name = 'sess') {
    this.store = store; this.r2 = r2; this.name = name;
    this.vm = null;
    this.inMemory = false;
    this.generation = 0;
    this.fireLog = []; // observability: {id, atTick, kind}
  }

  // host callbacks that the VM calls. They write to the DURABLE registry.
  _bindHostCallbacks() {
    const reg = this._registry();
    this.vm.registerHostCallback('__persistTimer', (idH, jsonH) => {
      const id = this.vm.dump(idH); const json = this.vm.dump(jsonH);
      reg[id] = JSON.parse(json);
      this._saveRegistry(reg);
      return this.vm.hostToHandle(undefined);
    });
    this.vm.registerHostCallback('__dropTimer', (idH) => {
      const id = this.vm.dump(idH); delete reg[id]; this._saveRegistry(reg);
      return this.vm.hostToHandle(undefined);
    });
    this._reg = reg;
  }

  _newFnDefs() {
    // On FRESH create we must declare the host functions BEFORE boot (so setTimeout can call them).
    // newFunction installs the global; registerHostCallback is the post-restore rebinder.
    const reg = this._registry();
    const persist = this.vm.newFunction('__persistTimer', (idH, jsonH) => {
      const id = this.vm.dump(idH); const json = this.vm.dump(jsonH);
      reg[id] = JSON.parse(json); this._saveRegistry(reg);
      return this.vm.hostToHandle(undefined);
    });
    this.vm.setProp(this.vm.global, '__persistTimer', persist);
    const drop = this.vm.newFunction('__dropTimer', (idH) => {
      const id = this.vm.dump(idH); delete reg[id]; this._saveRegistry(reg);
      return this.vm.hostToHandle(undefined);
    });
    this.vm.setProp(this.vm.global, '__dropTimer', drop);
    this._reg = reg;
  }

  _registry() { return this.store.getManifest(`${this.name}:timers`) || {}; }
  _saveRegistry(reg) { this.store.putManifest(`${this.name}:timers`, reg); }
  _nowTick() { const m = this.store.getManifest(`${this.name}:clock`); return m ? m.nowTick : 1700000000000; }
  _saveNowTick(t) { this.store.putManifest(`${this.name}:clock`, { nowTick: t }); }

  async create() {
    this.vm = await QuickJS.create(MODULE);
    this._newFnDefs();
    this.vm.evalCode(BOOT);
    this.vm.executePendingJobs();
    this.inMemory = true; this.generation = 1;
    this._saveNowTick(1700000000000);
  }

  // run arbitrary user code in the live VM
  eval(code) { const h = this.vm.evalCode(code); const r = this.vm.dump(h); this.vm.executePendingJobs(); return r; }

  // CHECKPOINT: dump heap -> SQLite-first, R2 overflow >2MB gz. Also persist nowTick (already live in reg saves).
  checkpoint() {
    // keep VM's __nowTick authoritative in manifest too
    this._saveNowTick(this.vm.dump(this.vm.evalCode('globalThis.__nowTick')));
    const snap = this.vm.snapshot();
    const ser = QuickJS.serializeSnapshot(snap);
    const gz = gzipSync(ser);
    let where;
    if (gz.length > 2 * 1024 * 1024) {
      this.r2.put(`${this.name}.snap.gz`, gz);
      this.store.putManifest(`${this.name}:snapmeta`, { where: 'r2', gzLen: gz.length });
      this.store.rows.delete(`${this.name}.heap#count`); // clear any sqlite copy
      where = 'r2';
    } else {
      this.store.putBlob(`${this.name}.heap`, gz);
      this.store.putManifest(`${this.name}:snapmeta`, { where: 'sqlite', gzLen: gz.length });
      this.r2.delete(`${this.name}.snap.gz`);
      where = 'sqlite';
    }
    return { where, gzBytes: gz.length, rawBytes: ser.length };
  }

  // GENUINE EVICTION: drop the live VM instance and any in-memory scheduler. Nothing in JS holds it.
  evict() {
    if (this.vm) { this.vm.dispose(); this.vm = null; }
    this._reg = null;
    this.inMemory = false;
    // simulate scheduler death: the alarm/timer-wheel object is gone (it was never persisted).
  }

  // COLD RESTORE: fresh instance, blit heap, rebind host handles from durable storage.
  async restore() {
    if (this.inMemory) throw new Error('not evicted');
    const meta = this.store.getManifest(`${this.name}:snapmeta`);
    if (!meta) throw new Error('no snapshot');
    let gz;
    if (meta.where === 'r2') gz = this.r2.get(`${this.name}.snap.gz`);
    else gz = this.store.getBlob(`${this.name}.heap`);
    if (!gz) throw new Error('snapshot bytes missing');
    const ser = gunzipSync(gz);
    const snap = QuickJS.deserializeSnapshot(new Uint8Array(ser));
    this.vm = await QuickJS.restore(snap, MODULE);
    this._bindHostCallbacks();        // re-attach __persistTimer / __dropTimer to the restored heap
    this.inMemory = true; this.generation += 1;
    return { source: meta.where === 'r2' ? 'r2-restore' : 'sqlite-restore' };
  }

  // SEEDED-CLOCK DRAIN. Advance virtual time to targetTick; fire every due timer in order, once each.
  // This is what a DO alarm would call on wake (after restore) or while warm.
  // Exactly-once authority = the host registry: we read due ids from the durable reg, fire each via
  // the VM, then update the reg (one-shots dropped, intervals rescheduled). Catch-up loop handles
  // intervals that should fire multiple times within one big advance (deterministic order).
  // commitOnFire (default true): after EACH fire, atomically commit the heap checkpoint + the
  // registry mutation + the clock as ONE durable unit, matching the kernel's per-cell sync-snapshot.
  // This closes the crash-between-fire-and-commit hole: durable heap and durable registry can never
  // disagree about whether a timer fired. If commitOnFire is false (warm-only, no durability needed)
  // the registry is still updated but the heap effect is only committed at the next checkpoint().
  advanceClock(targetTick, { commitOnFire = true } = {}) {
    if (!this.inMemory) throw new Error('VM not live; restore first');
    let progressed = true;
    let safety = 0;
    while (progressed) {
      if (++safety > 100000) throw new Error('drain runaway');
      const reg = this._registry();
      // collect due, alive timers, ordered by (fireAtTick, id) for determinism
      const due = Object.values(reg)
        .filter(t => t.alive && t.fireAtTick <= targetTick)
        .sort((a, b) => a.fireAtTick - b.fireAtTick || a.id - b.id);
      if (due.length === 0) { progressed = false; break; }
      const t = due[0];                       // fire the single earliest, then re-evaluate
      const resH = this.vm.evalCode(`globalThis.__fire(${t.id}, ${t.fireAtTick})`);
      const res = JSON.parse(this.vm.dump(resH));
      this.vm.executePendingJobs();
      this.fireLog.push({ id: t.id, atTick: t.fireAtTick, kind: t.kind });
      // ATOMIC COMMIT POINT: advance the VM clock to this fire's tick so the heap snapshot encodes
      // exactly "fired-up-to-here", then commit heap + reg + clock together.
      this.vm.evalCode(`globalThis.__nowTick = ${t.fireAtTick}`);
      const reg2 = this._registry();
      if (res.ran && res.reschedule) { reg2[t.id].fireAtTick = res.fireAtTick; }
      else { delete reg2[t.id]; }
      if (commitOnFire) {
        // commit heap FIRST (captures the side effect), THEN registry+clock. On crash before the
        // heap commit lands, the reg is untouched => timer still due => re-fires once (no loss).
        // On crash after heap but before reg: reg still due => re-fires, but heap already has effect
        // => __fire is idempotent because the timer is gone from the HEAP (returns ran:false). Safe.
        this._saveNowTick(t.fireAtTick);
        this.checkpoint();          // durable heap = post-fire
        this._saveRegistry(reg2);   // durable reg = post-fire
      } else {
        this._saveRegistry(reg2);
      }
    }
    // set clock to target
    this.vm.evalCode(`globalThis.__nowTick = ${targetTick}`);
    this._saveNowTick(targetTick);
  }
}
