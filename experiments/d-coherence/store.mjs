// Faithful model of the Cloudflare DO durable substrate.
//
//   DO-SQLite  -> a JS Map of rows. Critically models workerd's WRITE-COALESCING:
//                 all puts/deletes issued within one synchronous turn (no await
//                 boundary that yields to I/O) either ALL land or NONE land if the
//                 turn is interrupted before the implicit output-gate flush.
//                 We model the flush as `commit()`; staged writes live in a pending
//                 buffer and are atomically merged on commit, dropped on a crash.
//   R2         -> a directory on disk, put/get/delete. NOT transactional with SQLite.
//                 Crash-atomicity for R2 is achieved by swap-then-delete (write new
//                 key, point manifest at it, then delete old) — manifest pointer is
//                 the commit point.
//   alarms     -> a registry row in SQLite (so it survives) + an in-memory scheduler
//                 that is DROPPED on eviction and must be rebuilt from the row on wake.
//
// The eviction model: dropping the SQLiteDO's `pending` buffer (uncommitted writes
// vanish) + dropping the in-memory alarm scheduler + dropping the wasm instance.
// Committed SQLite rows + R2 files survive (they are "durable").

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';

export class SqliteDO {
  constructor() {
    this.committed = new Map();   // durable rows  key -> Buffer|string|json
    this.pending = new Map();     // staged this turn; merged on commit
    this.pendingDeletes = new Set();
    this.committedDeletesGuard = new Set();
  }
  // staged write — does NOT durably land until commit()
  put(key, val) { this.pending.set(key, val); this.pendingDeletes.delete(key); }
  del(key) { this.pendingDeletes.add(key); this.pending.delete(key); }
  // reads see staged-over-committed (read-your-writes within the turn)
  get(key) {
    if (this.pendingDeletes.has(key)) return undefined;
    if (this.pending.has(key)) return this.pending.get(key);
    return this.committed.get(key);
  }
  has(key) { return this.get(key) !== undefined; }
  keys() {
    const s = new Set([...this.committed.keys(), ...this.pending.keys()]);
    for (const d of this.pendingDeletes) s.delete(d);
    return [...s];
  }
  // THE COMMIT POINT. Atomic flush of the whole staged set (workerd output-gate).
  commit() {
    for (const k of this.pendingDeletes) this.committed.delete(k);
    for (const [k, v] of this.pending) this.committed.set(k, v);
    this.pending.clear(); this.pendingDeletes.clear();
  }
  // EVICTION: lose everything not committed. Models DO going away mid-turn.
  evictPending() { this.pending.clear(); this.pendingDeletes.clear(); }
}

export class R2Dir {
  constructor(dir) { this.dir = dir; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
  put(key, buf) { writeFileSync(`${this.dir}/${key}`, buf); }
  get(key) { const p = `${this.dir}/${key}`; return existsSync(p) ? readFileSync(p) : undefined; }
  del(key) { const p = `${this.dir}/${key}`; if (existsSync(p)) rmSync(p); }
  list() { return readdirSync(this.dir); }
}
