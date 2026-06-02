// sandbox.mjs — SANDBOX-SUITE: host.fs (R2-backed) + durable seeded timers + frozen env
// + deny-by-default router, wired onto the shared _bench substrate (Session + DOStore),
// implementing the staged-commit COHERENCE INVARIANT from docs/SANDBOX-API.md §2.
//
// What this proves end-to-end:
//   - host.fs writes (inline <=4096B in SQLite, else content-addressed R2) are STAGED and
//     only become durable at checkpoint(); R2 body is put BEFORE meta commit (put-before-commit).
//   - durable seeded timers: callback closures live in the heap (snapshot), the registry
//     {fireAtTick,intervalMs,kind,alive} lives in durable SQLite, exactly-once across restore.
//   - env / process.env are frozen Object.create(null), survive heap blit Object.isFrozen.
//   - deny-by-default: only whitelisted host.* prefixes dispatch; everything else -> DenyError.
//   - the SINGLE COMMIT POINT: all host mutations (fs meta+body, kv, timer registry) are
//     staged in memory and flushed together with the heap dump in checkpoint(), so a cold
//     restore always sees heap and host at the SAME version (no tear). Anything written after
//     the last checkpoint rolls back together.
//
// Substrate: imports _bench/store.mjs (DO SQLite chunks + R2 dir) and _bench/session.mjs
// (seeded clock/RNG, genuine cold restore = brand-new VM instance).

import { QuickJS } from 'quickjs-wasi';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DOStore } from '../_bench/store.mjs';

const require = createRequire(import.meta.url);
const WASM_BYTES = new Uint8Array(readFileSync(require.resolve('quickjs-wasi/quickjs.wasm')));

const INLINE_MAX = 4096;          // <= inline in SQLite row, else R2
const MAX_TIMERS = 64;            // resource cap (un-forgeable, host-side)
const MAX_FILES = 256;            // file-count cap
const EPOCH_TICK = 1_700_000_000_000; // virtual clock epoch (1 tick == 1 virtual ms)

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

// Seeded WASI identical to _bench/session.mjs so snapshots stay byte-deterministic.
function makeWasi(seed, nowTickRef) {
  return (memory) => {
    let s = seed >>> 0;
    const nextByte = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s & 0xff; };
    return {
      clock_time_get(_c, _p, resultPtr) {
        // virtual clock driven by nowTickRef (advanced by the supervisor alarm sim)
        new DataView(memory.buffer).setBigUint64(resultPtr, BigInt(nowTickRef.tick) * 1_000_000n, true);
        return 0;
      },
      random_get(bufPtr, bufLen) {
        const view = new Uint8Array(memory.buffer, bufPtr, bufLen);
        for (let i = 0; i < bufLen; i++) view[i] = nextByte();
        return 0;
      },
    };
  };
}

// ---------------------------------------------------------------------------
// DURABLE HOST STATE — lives in the DOStore (SQLite-first), NOT in the heap.
// Modeled as a plain object persisted as one tiny JSON manifest row + R2 bodies.
//   files: { path -> { size, etag, storage:'inline'|'r2', inline?:b64, r2key? } }
//   kv:    { k -> jsonValue }
//   timers:{ id -> { fireAtTick, intervalMs, kind:'timeout'|'interval', alive } }
//   nowTick, timerSeq
// R2 bodies are content-addressed: r2 key = `${sessionId}/${etag}` (cross-session-safe).
// ---------------------------------------------------------------------------
function emptyHostState() {
  return { files: {}, kv: {}, timers: {}, nowTick: EPOCH_TICK, timerSeq: 0, fired: {} };
}

const DENY = (op) => { const e = new Error(`DenyError: host.${op} is not permitted`); e.name = 'DenyError'; return e; };

// The host router. Mutations write to a STAGED copy; checkpoint() commits.
// readFile/list/stat/get read from the staged (== current) view.
function makeRouter(state, r2, sessionId, stats) {
  // allowed op prefixes (deny-by-default)
  const ALLOWED = new Set([
    'fs.writeFile', 'fs.readFile', 'fs.list', 'fs.stat', 'fs.rm',
    'kv.get', 'kv.set', 'kv.keys',
    '__now', '__random', '__armTimer', '__disarmTimer', '__fire',
  ]);

  function normalizePath(p) {
    if (typeof p !== 'string' || p.includes('\0')) { const e = new Error('EINVAL'); e.name = 'EINVAL'; throw e; }
    // virtual per-session root; collapse and reject escapes
    const parts = [];
    for (const seg of ('/' + p).split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (parts.length === 0) { const e = new Error('EACCES'); e.name = 'EACCES'; throw e; } parts.pop(); continue; }
      parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  function dispatch(op, args) {
    if (!ALLOWED.has(op)) throw DENY(op);
    switch (op) {
      case 'fs.writeFile': {
        const path = normalizePath(args[0]);
        const buf = Buffer.from(String(args[1]), 'utf8');
        const etag = sha256(buf), size = buf.length;
        if (!(path in state.files) && Object.keys(state.files).length >= MAX_FILES) {
          const e = new Error('EDQUOT'); e.name = 'EDQUOT'; throw e;
        }
        stats.fsWrites++;
        if (size <= INLINE_MAX) {
          state.files[path] = { size, etag, storage: 'inline', inline: buf.toString('base64'), r2key: null };
          stats.inlineWrites++;
        } else {
          // PUT R2 BODY FIRST (put-before-commit), content-addressed.
          const r2key = `${sessionId}/${etag}`;
          if (!r2.hasStaged(r2key)) { r2.putStaged(r2key, buf); stats.r2puts++; }
          state.files[path] = { size, etag, storage: 'r2', inline: null, r2key };
          stats.overflowWrites++;
        }
        return { etag, size };
      }
      case 'fs.readFile': {
        const path = normalizePath(args[0]);
        const m = state.files[path];
        if (!m) return null;
        stats.fsReads++;
        if (m.storage === 'inline') {
          const buf = Buffer.from(m.inline, 'base64');
          if (sha256(buf) !== m.etag) return { __torn: true, reason: 'inline-mismatch' };
          return buf.toString('utf8');
        }
        const body = r2.getCommittedOrStaged(m.r2key);
        if (!body) return { __torn: true, reason: 'r2-missing' };
        if (sha256(body) !== m.etag) return { __torn: true, reason: 'etag-mismatch' };
        return Buffer.from(body).toString('utf8');
      }
      case 'fs.list': {
        const pre = args[0] || '';
        return Object.keys(state.files).filter((p) => p.startsWith(pre)).sort();
      }
      case 'fs.stat': {
        const m = state.files[normalizePath(args[0])];
        return m ? { path: normalizePath(args[0]), size: m.size, etag: m.etag, storage: m.storage } : null;
      }
      case 'fs.rm': {
        const path = normalizePath(args[0]);
        const m = state.files[path];
        if (!m) return false;
        delete state.files[path];
        if (m.storage === 'r2') {
          const stillRef = Object.values(state.files).some((mm) => mm.r2key === m.r2key);
          if (!stillRef) r2.deleteStaged(m.r2key);
        }
        return true;
      }
      case 'kv.get': return Object.prototype.hasOwnProperty.call(state.kv, args[0]) ? state.kv[args[0]] : undefined;
      case 'kv.set': { state.kv[args[0]] = args[1]; stats.kvSets++; return null; }
      case 'kv.keys': return Object.keys(state.kv).sort();
      case '__now': return state.nowTick;
      case '__armTimer': {
        if (Object.values(state.timers).filter((t) => t.alive).length >= MAX_TIMERS) {
          const e = new Error('TimerBombError'); e.name = 'TimerBombError'; throw e;
        }
        const id = ++state.timerSeq;
        const ms = Math.max(0, Number(args[0]) | 0);
        const kind = args[1] === 'interval' ? 'interval' : 'timeout';
        state.timers[id] = { fireAtTick: state.nowTick + ms, intervalMs: kind === 'interval' ? ms : 0, kind, alive: true };
        stats.timersArmed++;
        return id;
      }
      case '__disarmTimer': {
        const t = state.timers[args[0]];
        if (t) { t.alive = false; delete state.timers[args[0]]; }
        return null;
      }
      default: throw DENY(op);
    }
  }
  return { dispatch, normalizePath };
}

// ---------------------------------------------------------------------------
// R2 staging shim over the real DOStore — staged puts/deletes are only made
// durable when commit() is called (the single commit point). This is what lets
// O3 (crash before checkpoint) roll back host body writes together with the heap.
// ---------------------------------------------------------------------------
function makeStagedR2(store, ctx) {
  const stagedPuts = new Map();    // r2key -> Uint8Array (pending durable)
  const stagedDeletes = new Set(); // r2key pending delete
  const committed = new Set();     // r2keys we have committed (durable in store)

  const skey = (r2key) => `${ctx.key}/fsbody/${encodeURIComponent(r2key)}`;
  return {
    putStaged(r2key, buf) { stagedPuts.set(r2key, new Uint8Array(buf)); stagedDeletes.delete(r2key); },
    deleteStaged(r2key) { stagedPuts.delete(r2key); stagedDeletes.add(r2key); },
    hasStaged(r2key) { return stagedPuts.has(r2key) || committed.has(r2key); },
    getCommittedOrStaged(r2key) {
      if (stagedPuts.has(r2key)) return stagedPuts.get(r2key);
      if (committed.has(r2key)) return store.getRaw(skey(r2key));
      return null;
    },
    // Commit phase 1: flush staged R2 bodies BEFORE the meta/heap manifest commit.
    flushBodies() {
      for (const [r2key, buf] of stagedPuts) {
        store.putRaw(skey(r2key), buf, { forceR2: buf.byteLength >= 4096 });
        committed.add(r2key);
      }
      for (const r2key of stagedDeletes) { store.deleteSnapshot(skey(r2key)); committed.delete(r2key); }
      stagedPuts.clear(); stagedDeletes.clear();
    },
    // Rehydrate committed set on cold restore from the manifest's file list.
    markCommitted(r2keys) { for (const k of r2keys) committed.add(k); },
    bodyKey: skey,
  };
}

// ---------------------------------------------------------------------------
// The sandbox VM session: wraps a QuickJS VM, installs the host bridge + the
// in-heap shims (env/process.env frozen, host.fs/host.kv, setTimeout/setInterval,
// __fire timer driver), and does genuine cold restore (brand-new instance).
// ---------------------------------------------------------------------------
export class SandboxSession {
  constructor({ seed = 0x12345678 } = {}) {
    this.seed = seed;
    this.vm = null;
    this.generation = 0;
    this.state = emptyHostState();         // DURABLE host state (staged view)
    this.nowTickRef = { tick: this.state.nowTick };
    this.stats = { fsWrites: 0, fsReads: 0, inlineWrites: 0, overflowWrites: 0, r2puts: 0, kvSets: 0, timersArmed: 0, fires: 0 };
  }

  _opts() { return { wasm: WASM_BYTES, wasi: makeWasi(this.seed, this.nowTickRef) }; }

  _bindHost(r2) {
    const router = makeRouter(this.state, r2, 'sess-' + this.seed, this.stats);
    this._router = router;
    const vm = this.vm;
    // Single native bridge. Capture into closure; the in-heap shim deletes the global.
    const fn = vm.newFunction('__hostCall', (reqH) => {
      let out;
      try {
        const req = JSON.parse(vm.dump(reqH));
        const res = router.dispatch(req.op, req.args || []);
        out = { ok: true, value: res === undefined ? null : res };
      } catch (e) {
        out = { ok: false, error: { name: e.name || 'Error', message: e.message } };
      }
      return vm.newString(JSON.stringify(out));
    });
    vm.setProp(vm.global, '__hostCall', fn);
  }

  _installShims() {
    // in-heap shims: frozen env, host.fs/kv, seeded timers, __fire driver,
    // and the security hardening (capture __hostCall into closure, delete global, pin JSON).
    this.vm.evalCode(`
      (function(){
        const __HC = globalThis.__hostCall; delete globalThis.__hostCall; // un-forgeable bridge
        const __J = JSON.stringify, __P = JSON.parse;
        function call(op, args){ const r = __P(__HC(__J({op, args:args||[]}))); if(!r.ok){ const e=new Error(r.error.message); e.name=r.error.name; throw e; } return r.value; }
        globalThis.__call = call;

        // Tier P: frozen env / process.env
        const env = Object.create(null); env.NODE_ENV='production'; env.ENGRAM='1'; Object.freeze(env);
        Object.defineProperty(globalThis,'env',{value:env,writable:false,configurable:false,enumerable:true});
        const penv = Object.create(null); penv.NODE_ENV='production'; Object.freeze(penv);
        Object.defineProperty(globalThis,'process',{value:Object.freeze({env:penv}),writable:false,configurable:false,enumerable:true});

        // host surface
        const host = Object.create(null);
        host.fs = {
          writeFile:(p,d)=>call('fs.writeFile',[p,d]),
          readFile:(p)=>call('fs.readFile',[p]),
          list:(pre)=>call('fs.list',[pre||'']),
          stat:(p)=>call('fs.stat',[p]),
          rm:(p)=>call('fs.rm',[p]),
        };
        host.kv = { get:(k)=>call('kv.get',[k]), set:(k,v)=>call('kv.set',[k,v]), keys:()=>call('kv.keys',[]) };
        Object.defineProperty(globalThis,'host',{value:host,writable:false,configurable:false,enumerable:true});

        // Tier S: seeded virtual time + timers.
        // callback closures live HERE in the heap (__timers); registry is durable (host).
        globalThis.__timers = globalThis.__timers || {};
        globalThis.setTimeout = function(fn, ms){ const id = call('__armTimer',[ms|0,'timeout']); __timers[id]=fn; return id; };
        globalThis.setInterval = function(fn, ms){ const id = call('__armTimer',[ms|0,'interval']); __timers[id]=fn; return id; };
        globalThis.clearTimeout = function(id){ call('__disarmTimer',[id]); delete __timers[id]; };
        globalThis.clearInterval = globalThis.clearTimeout;
        // __fire(id) runs the heap closure exactly once; HEAP is the authority for "already fired".
        globalThis.__fire = function(id){ const fn = __timers[id]; if(typeof fn!=='function') return false; fn(); return true; };
        globalThis.__dropTimerClosure = function(id){ delete __timers[id]; };
        Date.now = function(){ return call('__now',[]); };
      })();
    `, '<shims>');
  }

  async create(r2) {
    this.vm = await QuickJS.create(this._opts());
    this.generation = 1;
    this._bindHost(r2);
    this._installShims();
    return this;
  }

  eval(src) { return this.vm.dump(this.vm.evalCode(src, '<cell>')); }

  dump() { this.vm.runGC(); return QuickJS.serializeSnapshot(this.vm.snapshot()); }
  dispose() { if (this.vm) { this.vm.dispose(); this.vm = null; } }

  // genuine cold restore: brand-new instance + heap blit + RE-BIND native host fn.
  async restore(heapImage, r2) {
    this.vm = await QuickJS.restore(QuickJS.deserializeSnapshot(heapImage), this._opts());
    // a cold restore is, by definition, a generation past the original create (>=2).
    this.generation = Math.max(this.generation, 1) + 1;
    this._bindHost(r2); // shims (host.fs/setTimeout) are IN the heap; only native bridge re-binds
    return this;
  }

  usedHeap() { return this.vm.getMemoryUsage().memoryUsedSize; }

  // Advance virtual clock and fire all due timers exactly once (the supervisor-alarm sim).
  // Returns the ids fired. Caller checkpoints to capture the side effects.
  advanceClock(targetTick) {
    this.state.nowTick = targetTick;
    this.nowTickRef.tick = targetTick;
    const fired = [];
    // deterministic order (fireAtTick, id)
    let guard = 0;
    for (;;) {
      const due = Object.entries(this.state.timers)
        .filter(([, t]) => t.alive && t.fireAtTick <= targetTick)
        .sort((a, b) => (a[1].fireAtTick - b[1].fireAtTick) || (Number(a[0]) - Number(b[0])));
      if (due.length === 0) break;
      const [idStr, t] = due[0];
      const id = Number(idStr);
      // run the heap closure (exactly-once: heap is authority)
      const ran = this.eval(`__fire(${id})`);
      this.vm.executePendingJobs();
      if (ran) { this.stats.fires++; fired.push(id); }
      if (t.kind === 'interval') {
        t.fireAtTick += t.intervalMs;
        if (t.fireAtTick <= targetTick) { /* will refire in loop */ }
      } else {
        t.alive = false; delete this.state.timers[id];
        this.eval(`__dropTimerClosure(${id})`);
      }
      if (++guard > 100000) throw new Error('timer drain runaway');
    }
    return fired;
  }
}

export { DOStore, emptyHostState, makeStagedR2 };
