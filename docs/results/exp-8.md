# EXP-8 results — DETERMINISM (seeded RNG + controlled clock as host imports)

**Date:** 2026-06-01 · **Branch:** `exp/8-determinism` · **Verdict: PASS ✅**

## Hypothesis

With a **seeded RNG** and a **controlled (deterministic monotonic) clock** exposed
as host imports — instead of the engine's built-ins — restoring a snapshot and
running the **same next cell** yields **byte-identical linear memory**.

**Confirmed.** Two independent fresh QuickJS instances, each restored from the same
post-N-cell snapshot and advanced through the identical next cell, produce the
**same SHA-256 of WASM linear memory**. A stock unseeded engine **diverges**.

## Where it ran & why local

Local (Node 25). The determinism question is entirely about the **engine + the
host-import boundary** (time / random / crypto), not about the CF host. The exact
same `quickjs.wasm` was already proven to run on real Cloudflare in EXP-5a; nothing
about determinism changes between Node and workerd because both feed the engine
through the same WASI import surface. Running local gives clean, repeatable hashing
without R2/DO noise.

## Method

1. Build a QuickJS VM whose **non-determinism sources are externalized** to host code:
   - **WASI level** (`quickjs-wasi`'s `wasi` factory option overrides):
     - `clock_time_get` → a **deterministic monotonic clock** (fixed epoch
       1700000000000 ms, +1 ms per read; pure function of read-count).
     - `random_get` → a **seeded PRNG** (mulberry32, seed `0x12345678`).
       This feeds QuickJS-ng's `Math.random` seeding **and** `crypto.getRandomValues`.
   - **JS-visible level** (host functions injected via `newFunction`, then globals
     rebound inside the VM): `Date.now()` → `__hostNowMs()`, `Math.random()` →
     `__hostRandom()`, `new Date()` (no args) → deterministic clock,
     `crypto.getRandomValues` → seeded bytes. This is the literal "route time /
     random / crypto through controllable host functions" the experiment asked for.
2. Run **7 setup cells** that use `Date.now()`, `Math.random()`, `new Date()`, and a
   stateful closure (`x`, `inc`, an `acc` array of 5 randoms, a `log` array).
3. **Snapshot** memory + globals; serialize.
4. On **two separate fresh instances**: deserialize, `QuickJS.restore`,
   **re-register the host callbacks by name**, replay the deterministic generator
   state to its snapshot-time call-count, then run the **SAME next cell**
   (`log.push(['next-time',Date.now()]); log.push(['next-rand',Math.random()]); x=inc()+…`).
5. **Hash** the resulting linear memory (SHA-256) and compare A vs B.

## Result — deterministic path ✅

| Check | A | B |
|---|---|---|
| next-cell output | `{"x":4,"logLen":4}` | `{"x":4,"logLen":4}` |
| `log` after advance | `[["t0",1700000000002],["r0",0.9045877147000283],["next-time",1700000000005],["next-rand",0.3698200259823352]]` | *(identical)* |
| **memory SHA-256** | `1772e1ff55a555dbc440701b6e1d8df61daad545c829088729875bfe93fe12d3` | **identical** |

- `identical: true`, `outputsMatch: true` → **PASS**.
- **Cross-process reproducible:** the same hash `1772e1ff…` appears across *separate*
  `node` process invocations, not just within one run. Memory size 1,310,720 bytes.
- Snapshot taken at clock-read-count 5, rng-call-count 10 (replayed on restore).

## Result — stock (unseeded) path: DIVERGES ❌ (as expected)

Default WASI shim (`Date.now()` = wall clock, `crypto.getRandomValues` = real entropy),
same setup cells, snapshot once, restore twice with a 5 ms gap, run the same next cell:

| Check | A | B |
|---|---|---|
| `log` after advance | `…["next-time",1780256344494]…` | `…["next-time",1780256344502]…` |
| **memory SHA-256** | `0509e431…` | `0518311d…` → **different** |

`identical: false`. The 8 ms wall-clock delta between the two restores lands a
different `Date.now()` value into the `log` array, so linear memory diverges. This
proves the externalization is **load-bearing**, not incidental.

## Which sources of non-determinism must be externalized

To get byte-identical restore-and-advance, **every** observable entropy/wall-time
source the running cell can touch must come from host-controlled, reproducible state:

1. **Current time** — `clock_time_get` (WASI) → drives `Date.now()`, `new Date()`,
   `Date` constructor with no args, and `performance.now()` if used. **Required.**
2. **PRNG** — `Math.random()`. QuickJS-ng seeds its PRNG **once** from the clock at
   context init, so a deterministic clock *alone* makes `Math.random()` reproducible;
   but to be robust against re-seeding / engine differences we also rebind
   `Math.random` to a host seeded PRNG. **Required (belt-and-suspenders).**
3. **CSPRNG** — `crypto.getRandomValues` (WASI `random_get`) → must be a seeded
   stream, else any `crypto`-using cell diverges. **Required.**
4. **Timezone** — `Date` local-time methods depend on the host TZ. `quickjs-wasi`
   exposes a `timezoneOffset` option; pin it (or use UTC-only cells) for full
   determinism of `toString()`/`getHours()`. *(Not exercised here; flagged.)*
5. **Generator-state continuity across restore** — the host PRNG/clock state lives
   **outside** WASM linear memory (so it does NOT perturb the snapshot bytes). On
   restore you must replay/persist that host-side counter to its snapshot-time
   position so the *next* cell observes the correct continuation. Here we replay by
   call-count; in production the counter would be persisted alongside the snapshot.

**Not** sources of divergence here (already deterministic): object/property layout,
hash-map iteration order, GC (QuickJS GC is deterministic and snapshot was quiescent),
atom table, stack pointer — all reproduced byte-identically.

## Does a stock unseeded engine diverge? — YES

Demonstrated above: with the default WASI shim, two restores of the *same* snapshot
running the *same* cell produce **different** memory hashes purely from wall-clock
drift (and would also diverge on any `crypto`/`Math.random` use). Determinism is
**not free** — it is a direct consequence of routing the entropy/time imports
through controllable host functions.

## Gotchas / findings

- **`quickjs-wasi`'s `wasi` option is a factory** `(memoryProxy) => overridesMap`,
  merged over the builtins. `memoryProxy.buffer` defers to the live WASM memory, so
  overrides can read/write linear memory without a manual memory ref. This is the
  clean injection point for a deterministic clock + seeded `random_get`.
- **Host callbacks are NOT in the snapshot.** `newFunction("__hostNowMs", …)` stores
  a C-function trampoline whose JS-side closure must be **re-registered by name**
  after `restore` via `registerHostCallback(name, fn)` (the in-VM `Date.now`/
  `Math.random` rebinding *does* survive, since it's plain JS in linear memory; only
  the host-side closure target is re-bound). Forgetting this throws on first call.
- **Keep host RNG/clock state out of linear memory.** If the seeded counter lived in
  WASM memory it would change the snapshot bytes each cell; keeping it host-side keeps
  the snapshot a pure function of executed JS, and lets two restores share one seed.
- **A single un-externalized source is enough to break it.** In the stock run, the
  PRNG values happened to coincide (single clock-seeded PRNG) yet memory still
  diverged from the clock alone — confirming you must externalize *all* of them.

## Files

- `experiments/exp-8/src/determinism.mjs` — the full harness (deterministic + stock).
- `experiments/exp-8/src/quickjs.wasm` — engine (same binary as EXP-1/EXP-5a).
- `experiments/exp-8/package.json` — `npm test` runs it.

## Verdict for the build

**PASS.** Determinism is achievable and cheap: route time, `Math.random`, and crypto
through host-controlled seeded/monotonic implementations, persist the host-side
seed/counter beside the snapshot, and restore-and-advance is **byte-identical**. This
is the property that makes the kernel's snapshots **verifiable and replayable** — two
restores of the same state advancing the same cell converge bit-for-bit. A stock
engine does not, so this externalization is mandatory, not optional. No CF resources
deployed (local experiment).
