# montydyn v0.3 — durable stateful JS kernel + real fetch egress

V0.3 builds on V0.2 (all V0.2 hardening kept) and adds the two **P3** items:

1. **Real outbound fetch egress + allowlist enforcement.** `host.fetch(url, init)` performs
   a real DO-side `fetch()` and resolves to `{status, ok, headers, body}` (text). The
   `config.fetch` allowlist is enforced: `false` blocks all, `true` allows all, `[hosts]`
   allows only those hostnames. Blocked/invalid requests reject with a typed
   `FetchBlockedError`; the socket stays alive and the kernel usable. Fetch is an explicit
   host effect that does **not** touch the seeded clock/RNG counters, so determinism is
   preserved. (Eval is now ASYNC so cells can `await host.fetch(...)`.)
2. **Error-as-VALUE preview.** When a cell *returns* (not throws) an Error object, the
   preview now includes `name` + `message` (+ a short stack) — `valueType:"error"`, and the
   structured `{name, message, stack}` is carried in `value`.

Built **on top of V0.2** (`v0/`, `v0.1/`, `v0.2/` are untouched). Same substrate: Rust
DurableObject shell (`src/lib.rs`) + JS glue driving QuickJS via `quickjs-wasi`
(`src/glue.js`) + `entry.mjs` CompiledWasm wrapper. All prior guards kept (engine-hash,
atomic checkpoint with write-coalescing + R2 swap-then-delete, seeded determinism,
SQLite-first snapshot, BUG-1 error handling, dynamic config persistence, used-heap
admission, interrupt-tick loop preemption, kv-state persistence).

Deployed worker: **`montydyn-v03`** — `https://montydyn-v03.<account>.workers.dev`
(V0/V0.1/V0.2 workers left intact). R2 `montydyn-snapshots` reused (overflow; keys
namespaced under `v03/`).

## P3 fetch usage

```js
// host.fetch returns a Promise resolving to {status, ok, headers, body}
const r = await host.fetch("https://example.com/");
r.status;        // 200
r.body;          // response text (capped at 2MB)
r.headers["content-type"];

// Allowlist (set at create time): only example.com is reachable.
// {t:"create", config:{ fetch:["example.com"] }}
await host.fetch("https://other.org/");  // -> rejects with FetchBlockedError
```

---

## (inherited) V0.2 hardening

## What's new in V0.2 (hardening)

### P0 — BUG-2/4 memory reclaim (the size-trip wedge)
WASM linear memory is **monotonic**: `memory.grow` never shrinks the buffer in place, and
QuickJS's dlmalloc does not compact live allocations downward. So a snapshot of
`memory.buffer` always stays at the high-water mark, and V0.1's size-guard (measured on
`memory.buffer.byteLength`) permanently wedged checkpointing after any spike-then-free.

V0.2:
1. **Used-heap admission guard (the un-wedge).** The size-admission guard now measures
   QuickJS's **actual used heap** via `getMemoryUsage().memoryUsedSize` (and `mallocSize`),
   not the buffer length. After a free + GC the used heap drops back to baseline, so a
   session that spiked **within the operating envelope** then freed **can checkpoint
   again** — no permanent `SizeAdmissionError`, and the store returns from `r2` to `sqlite`.
2. **Arena SCRUB (snapshot/store shrink).** The freed dlmalloc region still holds stale,
   *incompressible* bytes that bloat the gz image. After a free, `dump()` allocates
   zero-initialized `ArrayBuffer`s across the freed slack inside the VM (dlmalloc re-serves
   those just-freed chunks, which are spec-zeroed), then frees them + GC — so the freed
   pages are now zero and **gzip collapses them**. Locally: a 30MB free drops the gz image
   from ~0.84MB back to ~0.18MB, namespace intact. The scrub is bounded and never grows
   memory (safety), and is skipped above a buffer ceiling.
3. **Fail-safe dump ceiling.** `snapshot()`+serialize copy the *full* buffer ~2-3x and OOM
   is **uncatchable** (Error 1102 / WS 1006). So once the buffer has grown past a safe
   ceiling (~45MB) `dump()` refuses with a typed `SizeAdmissionError` **before** touching
   the full buffer — socket alive, prior snapshot intact, `reset` recovers — instead of
   hanging/crashing the DO.

**What shrinks vs what doesn't:** the **used heap** and the **gz/stored image** shrink back
after a free (and the store returns to sqlite); the **raw `memory.buffer`** does NOT shrink
in place — that is a fundamental WASM constraint. True compaction into a smaller fresh
instance is **not feasible** without value-level re-serialization (which would lose
pending-promise/closure fidelity): restoring a snapshot re-grows memory to the old buffer
size, and the live high-water after free+GC+scrub remains at the top (dlmalloc does not
move live chunks). Both verified empirically; documented in `docs/results/v0.2.md`.

### P1 — BUG-3 reliable preemption
On workerd `Date.now()` is **frozen** during synchronous execution, so a wall-clock
deadline never trips. V0.2 makes the **interrupt-tick budget the hard primary**: the
handler decrements a hard budget on **every** invocation, so ANY loop — including a truly
empty `while(true){}` that never touches a value — hits the budget and trips a typed
**`TimeoutError`** with the socket alive (no WS 1006). The default is lowered from V0.1's
30000 to **8000 ticks** (an empty loop trips in <1s on workerd; a 10M-iteration legit loop
≈2000 ticks still completes). Wall-clock (`cellBudgetMs`) is a secondary guard only.

### P2 — host-tool (kv) state persistence
`host.kv.*` state lives outside WASM linear memory; V0.1 lost it on cold wake. V0.2
serializes the kv Map in `dump()`, persists it in the snapshot manifest (`kv_json` column),
and re-hydrates it on `restore()` — `kv.get`/`kv.keys` now survive an evict + cold restore.

### Inherited from V0.1 (unchanged, re-verified no-regression)
- **BUG-1** error handling (throw/syntax/Reference/Type → typed `{ok:false,error}`, mutex
  released, next eval works, reset recovers).
- Dynamic session config persisted across cold wake; host tools via `host.<name>`;
  per-cell `console.*` capture; structured value preview; reconnect-safe SDK.
- **BUG-5** seeded `performance.now`; **BUG-6** correct `r2-restore`/`sqlite-restore` label.
- Seeded clock/RNG determinism, engine-hash guard, atomic checkpoint, SQLite-first/R2-overflow.

### Features
- **Dynamic session config** — a `{t:"create", config:{...}}` message (or `config` on the
  first eval) shapes the env: `clock` (`"seeded"`|`"real"`), `rngSeed`, `capture`,
  `cellBudgetMs`, `cellBudgetTicks`, `fetch` (off / `true` / allow-list), `tools` (host
  tool allow-list). **Config is persisted in the snapshot meta row** and re-applied
  before the first eval on cold wake → identical environment + re-registered host tools.
- **Host tools** — named host functions exposed into the VM as `host.<name>(...)` and
  `host.<ns>.<name>(...)` via a `host_call(name, jsonArgs)` boundary. Built-in demo tools:
  `echo`, `add`, `now`, `kv.put` / `kv.get` / `kv.keys`. Re-registered after restore.
- **Output capture** — `console.log/info/warn/error/debug` buffered per cell, returned as
  `logs:[{level,text}]`.
- **Result quality** — structured value preview (`valuePreview` + `valueType`), not bare
  stringify; objects/arrays use a structured dump. Errors carry `name/message/stack`.
- **Client SDK** — `sdk/index.mjs`: `connect(url, {id, config, WebSocket})` →
  `eval(src)` / `reset()` / `gen()` / `create(config)` / `evict()` / `close()`.
  Reconnect-safe (re-sends config on reconnect), serializes requests (one in-flight).

## Protocol (WebSocket, JSON)

Connect: `wss://montydyn-v01.<account>.workers.dev/ws?id=<session>`

| msg | effect |
|---|---|
| `{t:"create", config:{...}}` | persist + apply session config; establish/restore the kernel. Returns `{ok, config, restoreSource}` |
| `{t:"eval", src, config?}` | eval `src`; checkpoint to SQLite. `config` (optional, first-eval only) sets config if none yet. Returns `{ok, value, valuePreview, valueType, logs, error?, cell, restoreSource, checkpoint}` |
| `{t:"reset"}` | drop kernel + clear snapshot + bump epoch (recovers a wedged/errored session) |
| `{t:"gen"}` | `{generation, inMemory, epoch, committedCell, engineHash}` |
| `{t:"evict"}` | (test) drop in-memory kernel, keep durable snapshot |

### config fields
```
clock           "seeded" (default) | "real"
rngSeed         int (default 0x12345678)
capture         bool (default true) — console.* capture
cellBudgetMs    int ms wall-clock budget (default 5000; secondary guard)
cellBudgetTicks int interrupt-tick budget (default 8000, cap 200000; PRIMARY hard preempt on workerd — trips empty loops too)
fetch           false (default) | true | string[]  — outbound fetch policy (reserved)
tools           string[] — host tool allow-list (default: all built-ins)
```

## Build & deploy

```sh
npm install
node scripts/engine-hash.mjs            # (also run by the build command)
set -a; . ../.env; set +a               # CF creds (gitignored, from repo root)
npx wrangler@^4 deploy                  # deploys montydyn-v02
```

## Smoke test

```sh
node smoke.mjs wss://montydyn-v02.<account>.workers.dev
```
Proves (41/41 live): BUG-1 (throw → `ok:false`+error, next eval works, reset recovers),
dynamic config + host tools persisted across an evict (seeded clock + host tool survive
cold restore), output capture + value preview, **P0** (40MB in-envelope spike → free →
checkpoints again, used heap reclaimed, store stays sqlite; a >ceiling 60MB spike refused
with a typed error, socket alive), **P1** (empty `while(true){}` → typed `TimeoutError` in
<1s, socket open, next eval works; 10M-iter legit loop completes), **P2** (`kv.get`/`keys`
survive cold restore), and core durability (eval → evict → restore). See
`../docs/results/v0.2.md` for recorded runs.

## Layout
```
v0.2/
  entry.mjs            CompiledWasm wrapper (imports quickjs.wasm + engine-hash.js)
  wrangler.jsonc       worker montydyn-v02: DO(SQLite) + R2 overflow + CompiledWasm rule
  Cargo.toml           workers-rs 0.8, wasm-bindgen =0.2.121
  scripts/engine-hash.mjs   build-time SHA-256 bake-in
  src/lib.rs           Rust DO shell: config + kv persistence, restore labels, JSON eval bridge
  src/glue.js          JS kernel: P0 used-heap guard + scrub + fail-safe dump ceiling,
                       P1 hard tick-budget preemption, P2 kv hydrate, + all V0.1 features
  src/quickjs.wasm     QuickJS-ng compiled to WASM
  sdk/index.mjs        reconnect-safe client SDK
  smoke.mjs            live acceptance smoke test (41 checks)
```

## Known limitations
- **Raw image / WASM buffer does not shrink in place after a free.** WASM linear memory is
  monotonic and dlmalloc does not compact live chunks downward, so the raw `memory.buffer`
  stays at the high-water mark; only the *used heap* and the *gz/stored image* shrink back
  (store returns to sqlite). A session whose buffer grew past the ~45MB dump ceiling can no
  longer durably checkpoint until `reset` — the dump fails safe (typed error, socket alive)
  rather than risking an uncatchable OOM. True compaction would need value-level
  re-serialization (loses pending-promise/closure fidelity) — out of scope. See
  `docs/results/v0.2.md`.
- A >~50MB live spike is outside the documented operating envelope (EXP-6/7: dumpable
  ≤~57MB, isolate OOM uncatchable); such spikes are refused/handled fail-safe, not crashed.
- `fetch` capability is plumbed through config but the outbound-fetch host tool is
  reserved for a later iteration (no network egress from the VM).
