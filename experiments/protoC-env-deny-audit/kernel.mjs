// PROTOTYPE C — the kernel: QuickJS VM + the new env/host.fs/timers surface, wired through
// the host boundary exactly like glue.js (recursive host.<name> proxy -> __hostCall(prefix, jsonArgs)).
// Mirrors the production glue's deterministic-clock/RNG override + frozen env.

import { QuickJS } from '../e6-oplog/node_modules/quickjs-wasi/dist/index.js';
import { readFileSync } from 'node:fs';
import { hostNow, hostRandom } from './host.mjs';

const WASM = readFileSync(new URL('./quickjs.wasm', import.meta.url));
export const wasmModule = await WebAssembly.compile(WASM);

// The glue installed into the VM at create AND re-installed at restore (host fns are not
// part of the heap — they are JS closures re-bound to durable host state on cold wake).
const GLUE = (config) => `
(function(){
  // ---- (1) FROZEN env / process.env — pure in-VM data, snapshots trivially ----
  const __envData = ${JSON.stringify(config.env || {})};
  function deepFreeze(o){
    Object.getOwnPropertyNames(o).forEach(function(k){
      const v = o[k];
      if (v && typeof v === 'object') deepFreeze(v);
    });
    return Object.freeze(o);
  }
  // read-only: define as non-writable, non-configurable accessor with no setter.
  const __env = deepFreeze(Object.assign(Object.create(null), __envData));
  Object.defineProperty(globalThis, 'env', { value: __env, writable:false, configurable:false, enumerable:true });
  // minimal process.env shim (the ONLY process surface)
  const __penv = deepFreeze(Object.assign(Object.create(null), __envData));
  Object.defineProperty(globalThis, 'process', {
    value: Object.freeze({ env: __penv }), writable:false, configurable:false, enumerable:false
  });

  // ---- (2) host boundary proxy (matches production glue) ----
  // SECURITY: capture the native host bridge into a CLOSURE-LOCAL at install time, then
  // remove the global so VM code cannot shadow/forge it (would defeat the resource guards
  // that rely on __hostCall, e.g. timer/fs caps). Found by the adversarial audit.
  const __HOSTCALL = globalThis.__hostCall;
  try { delete globalThis.__hostCall; } catch(e) {}
  const __J = globalThis.JSON.stringify, __P = globalThis.JSON.parse; // pin against later VM tampering
  function mkHost(prefix){
    return new Proxy(function(){}, {
      get(_t, name){ if(typeof name!=='string') return undefined; return mkHost(prefix?prefix+'.'+name:name); },
      apply(_t,_this,args){
        const out = __HOSTCALL(prefix, __J(args===undefined?[]:args));
        const r = __P(out);
        if (r && r.__err) { const e = new Error(r.message); e.name = r.name||'Error'; throw e; }
        return r ? r.value : undefined;
      }
    });
  }
  globalThis.host = mkHost('');

  // ---- deterministic clock + RNG (externalized) ----
  globalThis.Date.now = function(){ return host.__now(); };
  globalThis.Math.random = function(){ return host.__random(); };

  // ---- (3) timers — host-mediated, bounded. setTimeout schedules a host alarm slot.
  // We model synchronous-drain timers: the VM cannot busy-spin a real wall clock; the host
  // owns the queue and a global cap (timer bomb mitigation).
  let __timerId = 1;
  globalThis.setTimeout = function(fn, ms){
    if (typeof fn !== 'function') throw new TypeError('setTimeout: fn must be a function');
    const id = __timerId++;
    host.__armTimer([id, ms|0]);   // host enforces MAX_TIMERS; throws on bomb
    (globalThis.__pendingTimers ||= {})[id] = fn;
    return id;
  };
  globalThis.clearTimeout = function(id){ if(globalThis.__pendingTimers) delete globalThis.__pendingTimers[id]; host.__disarmTimer([id]); };
  // host calls back into here on alarm wake to fire due callbacks:
  globalThis.__fireTimer = function(id){ const t = globalThis.__pendingTimers; if(t&&t[id]){ const f=t[id]; delete t[id]; f(); } };
})();
`;

// __hostCall router: dispatches host.<prefix>(...args). Owns ALL non-determinism + side effects.
export function makeHostCall(ctx) {
  // ctx: { state, fs, kv, fetchAllow, timers, sessionId }
  return (prefix, argsJson) => {
    const args = JSON.parse(argsJson);
    const ok = (value) => JSON.stringify({ value });
    const err = (name, message) => JSON.stringify({ __err: true, name, message });
    try {
      switch (prefix) {
        case '__now': return ok(hostNow(ctx.state));
        case '__random': return ok(hostRandom(ctx.state));
        case '__armTimer': {
          const [id, ms] = args;
          if (Object.keys(ctx.timers.pending).length >= ctx.timers.max)
            return err('TimerBombError', 'too many pending timers (cap ' + ctx.timers.max + ')');
          ctx.timers.pending[id] = { fireAt: ctx.state.clockMs + ms };
          ctx.state.entropy.timer++;
          return ok(id);
        }
        case '__disarmTimer': { delete ctx.timers.pending[args[0]]; return ok(true); }
        // host.fs.* — per-session, path-isolated, quota'd
        case 'fs.write': return ok(ctx.fs.write(args[0], args[1]));
        case 'fs.read': return ok(ctx.fs.read(args[0]));
        case 'fs.list': return ok(ctx.fs.list());
        case 'fs.unlink': { ctx.fs.unlink(args[0]); return ok(true); }
        // host.kv.* — small, persisted in manifest
        case 'kv.get': return ok(ctx.kv[args[0]] ?? null);
        case 'kv.set': { ctx.kv[args[0]] = args[1]; return ok(true); }
        // host.fetch — allowlisted; deterministic stub here (adds entropy via counter only)
        case 'fetch': {
          const url = new URL(args[0]);
          if (!ctx.fetchAllow.includes(url.hostname)) return err('FetchBlockedError', 'host not allowed: ' + url.hostname);
          ctx.state.entropy.fetch++;
          return ok({ status: 200, body: 'STUB:' + url.hostname });
        }
        default: return err('DenyError', 'host.' + prefix + ' is not exposed (deny-by-default)');
      }
    } catch (e) { return err(e.name || 'Error', e.message); }
  };
}

function bindHostCall(vm, ctx) {
  const hostCall = makeHostCall(ctx);
  const fn = (a, b) => vm.newString(hostCall(vm.dump(a), vm.dump(b)));
  return fn;
}

export async function createKernel(config, ctx) {
  const vm = await QuickJS.create({ wasm: wasmModule });
  const h = vm.newFunction('__hostCall', bindHostCall(vm, ctx));
  vm.global.setProp('__hostCall', h); h.dispose();
  const r = vm.evalCode(GLUE(config)); // throws JSException on error
  r.dispose();
  return vm;
}

export async function restoreKernel(snapBytes, config, ctx) {
  // Cold restore: fresh instance, blit heap, RE-BIND host fns to durable host state.
  // The heap (env, user state, pending-timer table) comes back from the snapshot.
  // The host fn is re-registered BY NAME (registerHostCallback) so the heap's existing
  // reference to __hostCall resolves to a closure over the freshly-rebound durable host state.
  const vm = await QuickJS.restore(snapshotFromBytes(snapBytes), { wasm: wasmModule });
  vm.registerHostCallback('__hostCall', bindHostCall(vm, ctx));
  return vm;
}

// snapshot <-> bytes via the package serializer
export function takeSnapshot(vm) {
  const snap = vm.snapshot();
  return QuickJS.serializeSnapshot(snap);
}
export function snapshotFromBytes(bytes) { return QuickJS.deserializeSnapshot(bytes); }

export function evalCell(vm, src) {
  try {
    const r = vm.evalCode(src);
    const v = vm.dump(r); r.dispose();
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: { name: e.name, message: String(e.message || e) } };
  }
}
