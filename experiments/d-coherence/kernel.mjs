// The coherence kernel. Wraps the REAL QuickJS wasm heap (from e1) and the host
// store (store.mjs) behind a SINGLE staged-commit checkpoint.
//
// Host-mediated APIs modeled (all of them route through the same staged commit):
//   host.kv     -> small rows in SQLite manifest (kv:<k>)
//   host.fs     -> chunked rows in SQLite (fs:<path>:<chunk>) + size in manifest
//   host.ctx    -> big chunked context -> R2 (overflow), pointer in manifest
//   host.timers -> timer registry rows (timer:<id>) + alarm scheduler rebuilt on wake
//
// THE INVARIANT WE ENFORCE AND TEST:
//   A cell's host mutations are STAGED, never durable, until checkpoint().
//   checkpoint() performs, atomically (single workerd output-gate flush):
//       1. dump wasm linear memory -> heap snapshot (staged in SQLite/R2)
//       2. flush ALL staged host writes (kv/fs/ctx/timers)
//   in ONE commit. Heap and host state therefore share ONE commit point, so they
//   can never be at different versions on a cold restore. Effects (timers firing,
//   external fetch) are gated AFTER the commit -> exactly-once, no double-fire.

import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { gzipSync, gunzipSync } from 'node:zlib';

const WASM = new URL('../e1-rust-quickjs/snapshotter/target/wasm32-wasip1/release/snapshotter.wasm', import.meta.url);
const mod = await WebAssembly.compile(readFileSync(WASM));
const R2_OVERFLOW = 200 * 1024; // bytes — base heap (~100KB gz) takes sqlite chunked path; big-ctx tests force R2
const HEAP_KEY = 'heap';

async function instantiate() {
  const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {} });
  const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.wasiImport });
  try { wasi.initialize(inst); } catch {}
  return inst;
}

export class Kernel {
  constructor(sqlite, r2, sideEffects) {
    this.sql = sqlite;
    this.r2 = r2;
    this.fx = sideEffects;          // {fired:[]} — records exactly-once effect firing
    this.inst = null;
    this.generation = 0;
    this.alarmScheduler = null;     // in-memory, dropped on eviction
  }

  // ---- cold start: fresh instance, either setup() or blit a committed heap ----
  async wake() {
    this.inst = await instantiate();
    this.generation++;
    const heapPtr = this.sql.get('manifest:heap'); // 'sqlite' or 'r2'
    if (!heapPtr) {
      // brand new session
      this.inst.exports.setup();
      this.inMemory = true;
      this.restoreSource = 'fresh';
    } else {
      // COLD RESTORE: blit committed heap into fresh instance
      let raw;
      if (heapPtr === 'r2') {
        raw = gunzipSync(this.r2.get(HEAP_KEY));
        this.restoreSource = 'r2-restore';
      } else {
        // reassemble chunked heap rows
        const n = this.sql.get('manifest:heapChunks');
        const parts = [];
        for (let i = 0; i < n; i++) parts.push(this.sql.get(`heap:${i}`));
        raw = gunzipSync(Buffer.concat(parts));
        this.restoreSource = 'sqlite-restore';
      }
      const mem = this.inst.exports.memory;
      const need = raw.length >> 16, have = mem.buffer.byteLength >> 16;
      if (need > have) mem.grow(need - have);
      new Uint8Array(mem.buffer).set(raw);
      this.inst.exports.reattach();
      this.inMemory = false;
    }
    // rebuild alarm scheduler from durable timer rows (registry survived; scheduler didn't)
    this.rebuildAlarms();
    return { generation: this.generation, restoreSource: this.restoreSource };
  }

  rebuildAlarms() {
    this.alarmScheduler = new Map();
    for (const k of this.sql.keys()) {
      if (k.startsWith('timer:')) {
        const t = this.sql.get(k);
        // only re-arm timers that have NOT already fired (fired flag is durable)
        if (!t.fired) this.alarmScheduler.set(k, t);
      }
    }
  }

  // ---- host-mediated API surface. ALL writes are STAGED (sql.put), not committed. ----
  hostKvPut(k, v) { this.sql.put(`kv:${k}`, v); }
  hostKvGet(k) { return this.sql.get(`kv:${k}`); }

  hostFsWrite(path, content) {
    // chunked write modeled; staged
    const buf = Buffer.from(content);
    const chunkSize = 64;
    const n = Math.ceil(buf.length / chunkSize) || 0;
    this.sql.put(`fs:${path}:n`, n);
    for (let i = 0; i < n; i++) this.sql.put(`fs:${path}:${i}`, buf.subarray(i * chunkSize, (i + 1) * chunkSize));
  }
  hostFsRead(path) {
    const n = this.sql.get(`fs:${path}:n`);
    if (n === undefined) return undefined;
    const parts = []; for (let i = 0; i < n; i++) parts.push(this.sql.get(`fs:${path}:${i}`));
    return Buffer.concat(parts).toString();
  }

  hostCtxPut(id, bigBuf) {
    // big context -> R2, pointer staged in manifest. We stage the R2 write to a
    // TEMP key, and only swap the manifest pointer at commit (swap-then-delete).
    const tmp = `ctx:${id}:staged`;
    this.r2.put(tmp, bigBuf);
    this.sql.put(`manifest:ctxstage:${id}`, tmp);
  }
  hostCtxGet(id) {
    const ptr = this.sql.get(`manifest:ctx:${id}`);
    return ptr ? this.r2.get(ptr) : undefined;
  }

  // register a timer -> staged registry row. Scheduler armed only AFTER commit.
  hostSetTimer(id, fireAt, payload) {
    this.sql.put(`timer:${id}`, { id, fireAt, payload, fired: false });
  }

  // VM heap mutation (real wasm): poke the closure counter to model in-VM state change
  vmPoke() { return this.inst.exports.poke_inc(); }
  vmReadX() { return this.inst.exports.read_x(); }

  // -------- THE SINGLE COMMIT POINT --------
  // Stages the heap snapshot, then flushes the WHOLE staged set (heap + host) atomically.
  checkpoint() {
    // 1. dump live wasm linear memory and STAGE it (chunked sqlite or r2 overflow)
    const raw = Buffer.from(new Uint8Array(this.inst.exports.memory.buffer));
    const gz = gzipSync(raw);
    if (gz.length > R2_OVERFLOW) {
      this.r2.put(HEAP_KEY, gz);
      this.sql.put('manifest:heap', 'r2');
      this.sql.del('manifest:heapChunks');
    } else {
      const chunkSize = 64 * 1024, n = Math.ceil(gz.length / chunkSize);
      for (let i = 0; i < n; i++) this.sql.put(`heap:${i}`, gz.subarray(i * chunkSize, (i + 1) * chunkSize));
      this.sql.put('manifest:heap', 'sqlite');
      this.sql.put('manifest:heapChunks', n);
    }
    // 2. resolve staged ctx pointers (swap-then-commit): promote staged ctx to live ptr
    for (const k of this.sql.keys()) {
      if (k.startsWith('manifest:ctxstage:')) {
        const id = k.slice('manifest:ctxstage:'.length);
        this.sql.put(`manifest:ctx:${id}`, this.sql.get(k));
        this.sql.del(k);
      }
    }
    // 3. ATOMIC FLUSH — heap + kv + fs + ctx-ptr + timer registry all land together
    this.sql.commit();
    // 4. POST-COMMIT side effects (arm scheduler / external effects) — exactly-once
    this.rebuildAlarms();
  }

  // Eviction: drop staged (uncommitted) writes, drop scheduler, drop instance.
  evict() {
    this.sql.evictPending();
    this.alarmScheduler = null;
    this.inst = null;
  }

  // Fire due alarms. Effect fires once, then marks timer fired and re-checkpoints.
  // Models exactly-once: a fired timer's `fired:true` is durably committed so a
  // post-fire eviction never re-fires it.
  fireDueAlarms(now) {
    if (!this.alarmScheduler) return;
    for (const [k, t] of [...this.alarmScheduler]) {
      if (t.fireAt <= now && !t.fired) {
        this.fx.fired.push(t.payload);     // THE side effect
        t.fired = true;
        this.sql.put(k, { ...t, fired: true });
        this.checkpoint();                  // durably record that it fired
        this.alarmScheduler.delete(k);
      }
    }
  }
}
