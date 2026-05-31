# montydyn-v0 Stress / Soak / Edge Test Results

Date: 2026-05-31
Target: live deployment `wss://montydyn-v0.umg-bhalla88.workers.dev/ws`
Source reference: `/Users/umang/hub/zonko/montydyn/v0/src/lib.rs`, `/Users/umang/hub/zonko/montydyn/v0/src/glue.js`

## 1. Overall Verdict

**V0 is NOT production-solid as-is. One blocking, trivially-reproducible defect makes the REPL unusable after the very first user mistake.**

The durable-execution core is genuinely excellent: concurrency serialization, long-session soak, cold restore, async/microtask survival, determinism, and the R2 overflow path are all rock-solid and numerically verified (5 of 6 suites PASS, many across 3–4 repeat runs). The kernel never lost an update, never corrupted a snapshot, and never double-executed a drained job.

But the **errors** suite is a hard FAIL: **any uncaught JS-level error in an eval cell (a `throw`, a syntax error, a `ReferenceError`, a `TypeError`) permanently wedges the per-DO eval mutex.** The eval never returns, the socket stays open with no close frame, and *every* subsequent eval hangs forever — including after a fresh reconnect to the same session id. Since a typo or a thrown error is the single most common thing a user does in a REPL, this defect alone blocks production. Everything downstream (concurrency, soak, etc.) was validated only on clean evals, so the strong PASS results are real but live "above" this landmine.

Bottom line: **fix the eval-hang (BUG-1) and V0's durability story is production-grade. Until then it is a demo that breaks on first error.**

## 2. Per-Suite Summary

| Suite | Verdict | Key result | Repeat runs |
|---|---|---|---|
| concurrency | PASS | 20x / 100x / two-socket 50x / eval+evict interleave — 0 lost updates, cells strictly monotonic & contiguous, FIFO replies | 4 |
| soak | PASS | 160 sequential cells, 16 mid-session cold restores, state byte-perfect; restore RTT 162–174ms flat (no drift) | 3 |
| multi-evict | PASS | 8 explicit evict cycles + 1 real 72s idle eviction; namespace + closures survive every restore | 1 (+72s idle) |
| async | PASS | Microtask/job-queue drains exactly once at cold-restore boundary; unsettled promise + captured resolver survive snapshot | multiple |
| **errors** | **FAIL** | **Any JS error permanently wedges eval mutex (no response, socket stays open, survives reconnect)**; huge-alloc leaves session permanently un-checkpointable | 4 (reproduced) |
| determinism | PASS (1 minor leak) | Seeded `Math.random` + `Date.now` bit-identical across 5 restores vs control; `performance.now()` unseeded | — |
| r2-overflow | PASS (2 minor findings) | 3.78MB incompressible image overflows to R2, durable across evict + cold reconnect; fresh-key swap-then-delete crash-safe by design | multiple |

## 3. Bugs (ranked by severity)

### BUG-1 — Eval mutex deadlock on any uncaught JS error  **[BLOCKER]**
**Severity: CRITICAL. Blocks production.**

Any uncaught JS-level error inside an eval cell never returns a response. The WebSocket stays open (no close, no 1006), and the per-DO eval critical section / mutex is permanently wedged: all subsequent evals hang, **including after a fresh reconnect to the same session id**. `{t:gen}` still responds (DO is alive, `inMemory:true`, `committedCell:0`), so it is the eval critical section specifically that is stuck, not the whole object.

Affected inputs (all wedge identically):
- `throw new Error('boom')`
- `var = =` (syntax error)
- `nonexistentVarXYZ` (ReferenceError)
- `null.foo` (TypeError)
- `(()=>{throw "x"})()` (throw in expression)

Repro:
```
connect wss://.../ws?id=<uniq>
eval '1'                       -> ok, cell 0
eval "throw new Error('boom')" -> NO RESPONSE (confirmed hung at 60001ms, socket open)
eval '123'                     -> NO RESPONSE (mutex wedged)
# reconnect fresh WS to same id
eval anything                  -> still hangs; {t:gen} still returns
```
Reproduced 4x across distinct session ids. Control (clean evals) always work and checkpoint normally, so the wedge is specific to JS-error cells, not flakiness.

**Likely cause:** `src/glue.js:260` `evalCode` stringifies the kernel `evalCode` result but has no handling for a QuickJS *pending exception* handle. So when the user code throws, `eval_critical` (`src/lib.rs:245`) never resolves and never releases the in-DO mutex. By contrast the dump `SizeAdmissionError` is caught and surfaced as `{ok:false}` (`lib.rs:163` `unwrap_or_else`), but a thrown user error is not — it hangs instead of surfacing.

**Suggested fix:** In `glue.js evalCode`, detect a QuickJS exception handle after `kernel.evalCode(src)`, drain/format it (message + stack), and return it as a normal `{ok:false, error}` value so `eval_critical` resolves and releases the mutex. Add a `try/catch` (or equivalent) around the whole eval+dump path in `lib.rs:245` so *no* code path can leave the critical section without resolving. Confirm `{t:reset}` is not also queued behind the same wedged mutex (not separately confirmed — `gen` works, but reset was not tested while wedged).

**Blocks: YES.** This is the single highest-value finding — a clean, 100%-reproducible deadlock on the most common user action.

### BUG-2 — Live image never reclaimed after size-guard trip  **[MEDIUM]**
**Severity: MEDIUM. Does not block, but makes affected sessions permanently un-checkpointable.**

After the live QuickJS image exceeds `MAX_LIVE_BYTES` (50MB / 52,428,800), the dump returns a clean typed `SizeAdmissionError` over a **live** socket (good). But the bloated kernel is never reclaimed: freeing the data (`delete globalThis.huge`) still returns the same `SizeAdmissionError`, because the checkpoint dump runs on every eval and keeps failing. The session can never checkpoint again.

Repro:
```
eval `new Uint8Array(${60*1024*1024})`  -> {ok:false, SizeAdmissionError: live image 64225280 > 52428800 ... at de.dump}, socket alive
eval 'delete globalThis.huge'           -> same SizeAdmissionError
eval 'amark'                            -> same SizeAdmissionError
```
**Suggested fix:** Force a QuickJS GC / arena compaction before (or on failure of) `dump()` so freed memory drops the live image back under the guard. Alternatively, gate the size check on *post-GC* live bytes. Same underlying QuickJS arena-not-compacted issue as BUG-4 below.

**Blocks: NO** (clean typed error, socket survives, no data loss), but should be fixed before exposing arbitrary allocation to users.

### BUG-3 — No in-isolate CPU/wall budget; long loop kills the DO  **[LOW / EXPECTED]**
**Severity: LOW. Expected platform behavior, but worth documenting.**

`while(true){}` has no in-isolate budget; it rides the eval synchronously until the Cloudflare DO wall/CPU limit kills the whole object → **WS close 1006 at ~30s**. This is *not* a clean typed timeout. **Positive:** durable state survives the abrupt kill — reconnect restores the prior namespace (`restoreSource=sqlite-restore`, generation bumped 1→2), so the SQLite snapshot is not corrupted by the teardown.

**Suggested fix:** Add an interrupt handler / instruction-count or wall-clock budget inside the QuickJS host so runaway code returns a typed `{ok:false, error:'TimeoutError'}` instead of taking down the DO. Lower priority than BUG-1/2.

**Blocks: NO.**

### BUG-4 (r2) — Overflowed image never shrinks back to SQLite hot path  **[LOW]**
Once a namespace overflows to R2 (image > `SQLITE_HOT_MAX` = 2,097,152), it stays on R2 forever. Reassigning `globalThis.big = new Uint8Array(8)` leaves `sizeGz` pinned at ~3,775,000 and `store='r2'` across all later cells — the freed 3.5MB arena is not compacted before dump. Cost is an extra ~3.78MB R2 put + get on every subsequent checkpoint/restore. Same root cause as BUG-2 (no pre-dump GC/compaction). **Severity: low (cost/perf, no data loss). Blocks: NO.**

### BUG-5 (determinism) — `performance.now()` is unseeded  **[LOW]**
`performance` is exposed (`typeof performance === 'object'`, has `.now`), but `performance.now()` is wall-clock-derived and non-deterministic — unlike `Date.now()` and `Math.random()` which are seeded and bit-identical across restores. Across an evict it returns a different value while `Date.now()` stays pinned to the seeded epoch `1700000000004`. Any user code using `performance.now()` for timing/jitter/seeds breaks value-determinism. **Suggested fix:** seed `performance.now()` off the same clock counter as `Date.now()` (or remove `performance` entirely, matching the absent `crypto`/`setTimeout`). **Blocks: NO.**

### BUG-6 (r2) — `restoreSource` mislabels R2 restores as `sqlite-restore`  **[LOW / OBSERVABILITY]**
R2-backed restores (both evict and cold-reconnect paths) report `restoreSource='sqlite-restore'` even though bytes are fetched from R2. The protocol advertises `'r2-restore'` but `lib.rs ensure_glue()` routes both R2 and SQLite through `glue.restore()` with the same label, so `'r2-restore'` is never emitted — operators can't distinguish the two. **Suggested fix:** set the label from the branch that actually fetched the bytes. **Blocks: NO** (observability only).

## 4. Robustness Gaps / Behaviors to Document

- **Long-running / infinite loops:** No in-isolate timeout. Runaway code is killed by the CF DO wall/CPU limit (~30s, WS 1006), not a typed error. Durable state survives the kill intact. Document that there is no graceful eval timeout yet (see BUG-3).
- **Async survival semantics:** The QuickJS microtask/job queue is **never pumped during warm evaluation** — `eval_code` is a synchronous host call and does not spin the event loop between REPL cells. Microtasks (and pending jobs) drain **exactly once, at the cold-restore boundary** (and idempotently — verified `counter=1` after two consecutive evict cycles). `setTimeout`/`setInterval` do not exist; only `queueMicrotask` and promise microtasks. **Footgun to document:** a settled microtask's side effect is observable *after an evict* but not during continued warm same-kernel evaluation, so observed async-settlement timing depends on whether a restore happened in between. Genuinely-unsettled promises and their captured host resolver functions survive the snapshot and remain resolvable post-restore. Unhandled rejections do not poison the snapshot or crash the kernel.
- **R2 overflow path:** Solid. Overflow detection at `SQLITE_HOT_MAX`=2MB, fresh cell/epoch-scoped R2 key per checkpoint, swap-then-delete (old key + old manifest survive until the new manifest commits in the atomic SQL turn). Verified durable across repeated replace, evict, and full cold reconnect with a 3.5MB incompressible payload. Crash-safety of swap-then-delete verified by code inspection (`lib.rs:404-495`) + observed fresh-key-per-cell behavior — **not** by an injected mid-replace crash (no fault-injection hook available). R2 restore latency: 520ms (evict) / 869ms (cold). R2 put latency under repeated replace: avg ~3.07s for 3.78MB.
- **`generation` semantics (important for tooling):** `generation` tracks **DO-instance reconstructions / engine version**, NOT in-memory kernel drops. Explicit `{t:evict}` does **not** bump it (stayed 1 across all cycles); only a real idle eviction (DO destroyed) bumps it (1→2). Tools using `generation` (or `gen > genAtSetup`) as a "was the kernel restored" proxy will miss explicit-evict restores. **Use `restoreSource` (and `inMemory:false` from `{t:gen}`) instead** — except note BUG-6, where `restoreSource` can't distinguish R2 from SQLite.
- **Server-side restore is sub-millisecond.** Reported `restoreLatencyMs=0` for SQLite restores; the user-visible ~165ms is WebSocket round-trip to the edge, and is flat regardless of session depth (160 cells of state still restores in ~165ms RTT). `sizeRaw` is a constant 1,310,748-byte fixed heap image; `sizeGz` (~104→109KB over 160 cells) is the meaningful growth indicator.
- **Determinism contract:** seeded `Math.random` (mulberry32, seed `0x12345678`) and `Date.now` (epoch `1700000000000` + `clockCalls`×1ms) are fully value-deterministic across restores, reconstructed from persisted `rngCalls`/`clockCalls` counters (no full replay). `crypto`/`require`/`process` are undefined as expected. Only `performance.now()` leaks non-determinism (BUG-5).

## 5. Recommended Fixes + Follow-up Tests

**Fix order:**
1. **BUG-1 (BLOCKER):** Handle QuickJS pending exceptions in `glue.js evalCode`; surface as `{ok:false, error}`; wrap `eval_critical` (`lib.rs:245`) so no path leaves the mutex unreleased.
2. **BUG-2 + BUG-4 (shared root cause):** Run QuickJS GC / arena compaction before `dump()` (or compute the size guard on post-GC live bytes) so freed memory shrinks the live image — fixes both the un-checkpointable-after-size-trip session and the stuck-on-R2 behavior.
3. **BUG-3:** Add a QuickJS interrupt/instruction-budget so runaway loops return a typed `TimeoutError` instead of killing the DO.
4. **BUG-5:** Seed `performance.now()` off the clock counter, or remove `performance`.
5. **BUG-6:** Emit the correct `r2-restore` vs `sqlite-restore` label from the branch that fetched the bytes.

**Follow-up tests:**
- After BUG-1 fix: re-run the full errors suite, then re-run concurrency/soak **with errors interleaved** (current PASS results were clean-eval-only). Specifically confirm `{t:reset}` recovers a session whose previous eval threw.
- After BUG-2/4 fix: assert `store` returns to `sqlite` and `sizeGz` drops after freeing a large allocation; assert a size-trip session can checkpoint again after `delete` + GC.
- Inject a real DO crash mid-R2-replace (needs a fault-injection hook) to empirically confirm swap-then-delete crash-safety, currently only verified by code read.
- Exercise the R2 path under the soak suite (soak stayed ~108KB gz, far below 2MB, so never tripped R2).
- Add a determinism assertion for `performance.now()` post-fix.

**Test artifacts (throwaway clients, repo source NOT modified, no CF resources deleted):** `/tmp/montydyn-concurrency/test.mjs`, `/tmp/soak-test/soak.mjs`, `/tmp/mdtest/multi.mjs`, `/tmp/montydyn-async/probe*.mjs`, `/tmp/stress-errors/`, R2/determinism probes. Session id prefixes: `stress-concurrency-*`, `stress-soak-*`, `stress-multi-evict-*`, `stress-async-*`, `stress-errors-*`, `stress-determinism-*`.

---

Note: I did not write the file (per my constraints against creating .md report files). The above is the complete report content intended for `/Users/umang/hub/zonko/montydyn/docs/results/v0-tests.md`.