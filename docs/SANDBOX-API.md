# Engram Sandbox API Contract

> Canonical, implementation-ready contract for what the Engram QuickJS-in-WASM kernel exposes to
> guest JS, how each surface maps to durable storage, and the single invariant that keeps all
> host-mediated state coherent across evict → cold-restore. Distilled from 4 proven prototypes:
> **A** (`experiments/protoA-host-fs/`), **B** (`experiments/protoB-timers/`),
> **C** (`experiments/protoC-env-deny-audit/`), **D** (`experiments/d-coherence/`).
>
> Substrate constraint: a single Cloudflare Durable Object (single-threaded per id; SQLite +
> R2-overflow + alarms on the supervisor; WebSocket hibernation). VM heap = WASM linear memory,
> snapshotted to SQLite-first / R2-overflow per existing kernel. Host-mediated state lives in
> durable DO storage, NOT in the heap, and is re-bound on cold restore.

---

## 1. THE API SURFACE

The sandbox is **deny-by-default** (Prototype C). Only the rows below are dispatched at the host
router; every other `host.*` prefix returns a `DenyError`. Tiers describe the determinism /
durability contract, not just the call site.

### Tier P — Pure (in-VM, snapshots with the heap, no host call)

| API | Signature | Storage mapping | Snapshot behavior |
|---|---|---|---|
| `env` | frozen `Object.create(null)`, e.g. `env.NODE_ENV` | none — in-heap data | survives heap blit trivially; stays `Object.isFrozen` post-restore (C: 17/17) |
| `process.env` | minimal frozen shim, `Object.create(null)` | none — in-heap | survives heap blit; installed `{writable:false,configurable:false}` |
| Tier-0 ext | `TextEncoder/Decoder`, `URL`/`URLSearchParams`, `structuredClone`, `Headers`, `crypto.subtle` | native `.so` re-instantiated at fixed bases before blit | per v0.8: natives re-installed on restore (same descriptors+order); pure-of-input |

> Pure tier is the cheapest: it is just heap. Restore correctness is a property of the heap-blit
> path that the kernel already proves.

### Tier S — Seeded (deterministic, host-bridged for entropy/time, no external durable effect)

| API | Signature | Storage mapping | Snapshot behavior |
|---|---|---|---|
| time / clock | `Date.now()`, `performance.now()` → `host.__now()` | `nowTick` in manifest (small JSON row) | monotonic virtual clock; restored from manifest, never resets/jumps back (C, B) |
| RNG | `Math.random()` → seeded LCG; `crypto.getRandomValues`/`randomUUID` → seeded WASI `random_get` | `rngSeed`/entropy counter in manifest | seeded sessions byte-identical across restore (v0.8 + B) |
| `setTimeout`/`setInterval` | `setTimeout(fn,ms)→id`, `setInterval(fn,ms)→id`, `clearTimeout/clearInterval(id)` | **closures in heap** (`globalThis.__timers`); **registry in SQLite** `timer:<id>` rows `{fireAtTick,intervalMs,kind,alive}` (NO callback) | exactly-once across restore via seeded virtual time — see §4 |

> Time/RNG are *seeded* not *pure* because they cross the host boundary for the seed source, but
> they add **zero entropy** to the heap, so determinism (the v0.x thesis) holds.

### Tier H — Host-mediated durable (real external state; staged-then-committed per §2)

| API | Signature | Storage mapping | Snapshot behavior |
|---|---|---|---|
| `host.fs` | `writeFile(path,data)→{etag,size}` · `readFile(path)→string\|null\|{__torn}` · `list(prefix)→string[]` · `stat(path)→{path,size,etag,storage}` · `rm(path)→bool` | meta ALWAYS SQLite `files` row `{path,size,etag,storage,inlineB64?,r2key?}`; body **≤4096B inline** in row, **>4096B → R2** key `${sessionId}/${etag}` (content-addressed) | re-bound from durable SQLite+R2 on restore; heap holds the JS shim + etag refs, native `__hostFs` callback re-installed; heap etag == durable meta etag (A: coherence proven) |
| `host.kv` | `get(k)→any\|undefined` · `set(k,v)→void` · `keys()→string[]` | SQLite `kv:<k>` rows (+ snapshotted in manifest `kv_json` per v0.2) | survives cold wake; re-hydrated on restore (B T6, C) |
| `host.ctx` | host-side big-context store: `get/slice/put` (codemode) | R2 key + `manifest:ctx:<id>` pointer | staged R2 temp key promoted to live pointer at commit (D O2) |
| `host.fetch` | `fetch(url,init)→{status,ok,headers,body}` (async; eval is `Promise`) | none durable; result **staged** to commit at end-of-cell (D) | adds 0 entropy → determinism preserved; allowlist enforced (§5) |
| timer-fire side effects | timer callback's host writes (e.g. `host.kv` inc) | committed in the firing checkpoint; `fired:true` flag committed | exactly-once: heap is the "already-fired" authority (B) |

### Tier D — Deny (never dispatched)

| Surface | Result |
|---|---|
| node builtins / `require` / `process` (beyond env shim) | `DenyError` (deny-by-default router) |
| real `fs` / `path_open` / `fd_read` | unreachable — quickjs-wasi shim implements only 6 WASI fns (`clock_time_get`, `fd_write`, `fd_close`, `fd_fdstat_get`, `fd_seek`, `random_get`); **no `path_open`/`fd_read`** (C, source-verified) |
| raw network / sockets | `DenyError`; only `host.fetch` (allowlisted) crosses |
| `WebAssembly.compile` (runtime) | blocked by embedder ("Wasm code generation disallowed"); V1 facets deliver `{wasm:ArrayBuffer}` pre-compiled |
| any other `host.<x>` prefix | `DenyError` |

---

## 2. THE COHERENCE INVARIANT (Prototype D — ship-ready, 16/16 + 41/41 fuzz)

**Invariant (precise):**

> A cell's host-mediated mutations (`kv` / `fs` meta+body / `ctx` pointer / timer registry) are
> **STAGED, never durable, until that cell's `checkpoint()`**. `checkpoint()` is **the single commit
> point** and performs, in **one atomic flush** (workerd output-gate / SQLite write-coalescing — no
> raw `BEGIN/COMMIT`, no `await` that yields to storage I/O mid-flush):
>
> 1. dump live WASM linear memory → staged heap chunks (SQLite ≤200KB gz, else R2 + manifest-pointer swap-then-delete);
> 2. promote staged R2/ctx temp keys → live manifest pointers;
> 3. commit the **entire staged set together** (heap chunks + heap-manifest + kv + fs + ctx pointers + timer registry).
>
> External side effects (timer firing, `host.fetch`) are **gated to AFTER commit**, and their
> completion flag is itself committed in the next checkpoint → exactly-once / fenced.

**Why it is safe:** heap and host share **one commit point**, so any cold restore sees them at a
**byte-identical version**. Anything written after the last checkpoint rolls back **together** (no
tear). A dangling heap→host handle resolves to **ABSENT (detectable, `{__torn}`)**, never garbage.

**The 3 orderings it resolves** (all genuine-evict tested in D):

| Ordering | Scenario | Resolution (verified) |
|---|---|---|
| **O1** host-write → heap-checkpoint → evict | both written before commit | both survive at SAME version; heap closure resumes (counter 102), kv=alice, chunked fs intact |
| **O2** heap-checkpoint → host-write → evict | host write happened *after* the committed heap | post-checkpoint host write **rolls back** to match committed heap; dangling handle **absent (not torn)** |
| **O3** host-write → evict-before-checkpoint | crash before any commit | heap **and** host both roll back to prior commit **together** |

**Negative control (D):** the naive "immediate host commit" design **tears** (`heapBehind=true`,
`hostAhead=true`) — proving the staged-commit design is load-bearing, not incidental.

**Implementation fence (must honor):** all host `put`s + the heap dump must occur with **no
intervening `await` that yields to storage I/O**, or the output gate can flush partially. The P3
async-eval fetch pump must therefore **stage** fetch results and only commit at end-of-cell.

---

## 3. PER-API STATUS

| API | Status | Hard number / evidence |
|---|---|---|
| `host.fs` | **proven-coherent (works-with-caveats)** | A: 22/22 PASS; T2 evict→cold-restore: heap etag == durable meta etag, writeCount=2 (no double-fire), **restorePuts=0**, restore 2.05ms; T3 torn-write → `{__torn:'r2-missing'}` detected; threshold inline≤4096 vs R2≥4097; content-addressed dedup (2 paths/1 put) |
| `setTimeout`/`setInterval` | **proven-coherent (works-with-caveats)** | B: 13/14 PASS; T1 `fired===1` after evict+restore+advance, no double-fire; checkpoint 16.24ms, cold restore 3.34ms; firing byte-identical across runs; **crash probes exactly-once both commit orders** |
| `host.kv` | **proven-coherent** | B T6 `hits===1` across evict (no double-fire); C re-hydrated on restore; D O1 kv=alice survives |
| `host.ctx` | **proven-coherent (model)** | D: R2 cross-store O2 — staged temp key → live pointer at commit; cold wake 2.63ms |
| `host.fetch` | **needs-design (effect-fence)** | D risk: external fetch fired post-commit but crashed before `fired:true` → **at-least-once**; needs an **idempotency-key fence** (not yet prototyped). P3 already proves egress + allowlist works warm. |
| `env` / `process.env` / Tier-0 | **proven-coherent** | C: 17/17, frozen + survives restore; v0.8 natives re-installed |
| coherence invariant (cross-API) | **ship-ready** | D: 16/16 checks + **41/41 mid-flush crash points coherent (0 torn)** |

**Open hard limits to carry forward** (not API bugs, substrate facts): WASM linear memory is
monotonic → snapshot size is high-water-mark; `host.fs` has **no per-session byte quota yet** (C
caps file *count* at 256 via O(1) incremental accounting; bytes still need a cap); `rm` GC scans
all metas O(n) → needs a refcount column at scale.

---

## 4. THE TIMER DECISION

**Decision: SEEDED VIRTUAL TIME, exactly-once across restore.** (B — chosen over wall-clock firing.)

- **One monotonic virtual clock** `nowTick` (epoch 1.7e12, 1 tick == 1 virtual ms). `setTimeout(fn,ms)
  ⇒ fireAtTick = nowTick + ms`. **Firing is driven by advancing the clock, never wall time** →
  deterministic + wall-independent.
- **State split:** callback **closures live ONLY in the VM heap** (`globalThis.__timers`,
  captured by the heap snapshot); the **durable registry** (SQLite `timer:<id>` rows) holds
  `{fireAtTick,intervalMs,kind,alive}` with **no callback**. `setTimeout`/`clearTimeout` are
  VM-installed shims calling host `__persistTimer`/`__dropTimer`.
- **Drain:** host selects due (`fireAtTick<=target`) timers ordered by `(fireAtTick,id)`, invokes
  `globalThis.__fire(id,atTick)` in the VM (runs the heap closure); one-shots delete from heap+reg,
  intervals reschedule.
- **Long hibernation:** the **supervisor DO alarm** (facets cannot set alarms — ADR/v1-facet)
  converts real elapsed wall time into a single `advanceClock(targetTick)`; a catch-up loop fires
  every due timer in deterministic order, **exactly once each**.
- **Exactly-once mechanism:** per-fire atomic unit — advance clock to fire-tick, **then heap
  checkpoint (captures the side effect), then registry mutation**. `__fire` is **idempotent
  because the HEAP is the authority** for "already fired": a re-issued fire on a timer absent from
  the heap returns `ran:false`. So a crash in **either** commit order still yields exactly-once.

**Proof (B):**
- T1: `fired===1` after evict→cold-restore→advance past 5000; further advance does not re-fire.
- T2: interval fires `[1000,2000]` warm, then `[3000,4000,5000]` post-restore — **no replay** of pre-evict fires.
- T3: `clearTimeout`'d timer `fired===0` across restore, **zero orphan registry rows**.
- T5: timer due during a **50000-tick** hibernation fires exactly once on one alarm wake.
- T6: timer callback's `host.kv` side effect `hits===1` across evict, no double-fire on re-advance.
- `/tmp` crash probes (reproducible): committed-fire recovery `fired=1`; heap-committed-then-crash-before-reg-drop recovery `fired=1` (idempotent re-fire) — **both exactly-once**.

**Cost note:** per-fire checkpoint (~16ms heap dump) is fine for sparse timers; a hot `setInterval`
firing thousands of times needs **batched-commit-per-drain** with crash-replay-from-last-checkpoint
(idempotency already supports replay).

---

## 5. SECURITY

**Deny-by-default router** (C): only `host.{fs.{read,write,list,unlink}, kv.{get,set}, fetch,
__now, __random, __armTimer, __disarmTimer}` are dispatched; every other prefix → `DenyError`.

**Per-session path isolation** (`host.fs`, defense in depth):
1. `posix.normalize('/' + userPath)` against a virtual per-session root; any `/..` escape, absolute
   escape, or NUL byte → `EACCES`/`EINVAL`.
2. **The storage key is ALWAYS prefixed** `fs:<sessionId>:<safePath>` (A uses `${sessionId}/${etag}`
   for bodies) — so even a normalization bug **cannot cross sessions**; a cross-session read
   resolves to `ENOENT` in the **attacker's own** namespace, never the victim's bytes.

**Resource caps (must not be forgeable):** timers hard-capped `MAX_TIMERS` → `TimerBombError`
(C: capped at exactly 64 arms, loop terminates); `host.fs` file-count cap 256 → `EDQUOT` (C:
required **O(1) incremental usage accounting** — initial O(n²) per-write list scan hung at ~10k
files); `host.fetch` hostname allowlist → `FetchBlockedError`.

**CRITICAL FIX (real escape found + fixed in C — must port to production):** the native bridge was a
**writable global `__hostCall`**. VM code ran `__hostCall = ()=>JSON.stringify({value:'FORGED'})`
successfully — this did **not** leak host data but **defeated the host-mediated guards** (timer/fs
caps route through `__hostCall`), turning the capped timer bomb into an **unbounded infinite loop**.
**Fix:** capture into a closure-local + delete the global + pin JSON:
```
const __HOSTCALL = globalThis.__hostCall; delete globalThis.__hostCall;
const __J = JSON.stringify, __P = JSON.parse;   // pinned
```
**Production `apps/kernel/src/glue.js` installs `__hostCall` as a plain global (~line 608) and MUST
be audited for this exact shadowing vector before shipping host-mediated guards.**

**Adversarial result (C `adversarial.mjs`): 31/31 vectors SECURE, RC=0** after the one fix —
node builtins/`require`, real fs, network, `WebAssembly.compile`, proto-pollution, `__hostCall`
forge, `Function`-constructor, fs path-traversal ×5 + cross-session list, timer/fs bombs, nested
`eval`. **Layering caveat:** the host-guard layer is the only backstop against host-mediated bombs;
a pure-compute `while(true){}` with no host call needs the **v0.8 interrupt-tick tripwire (budget
1200)** — both layers required, and the host layer must not be forgeable.

---

## 6. BUILD ORDER (implementation-ready → `apps/kernel`)

Each step lands `lib.rs` host fns + `glue.js` bindings, with a **verify gate** = (genuine
evict → cold-restore coherence) **+** (adversarial pass) before merge. Branch per step
(`feat/sandbox-<slug>`), no direct-to-main.

**Step 0 — Security base (BLOCKING, do first).**
Port the C closure-capture fix into `glue.js` (~line 608): `const __HOSTCALL = globalThis.__hostCall;
delete globalThis.__hostCall;` + pinned `__J/__P`. Wire the **deny-by-default router** in `lib.rs`
host dispatch (allow-list only; all else `DenyError`).
*Gate:* re-run `protoC-env-deny-audit/adversarial.mjs` shape against the real kernel → 31/31 SECURE,
`__hostCall` forge blocked, RC=0.

**Step 1 — Staged-commit checkpoint (the invariant, §2).**
Refactor `lib.rs` so host fns only `sql.put()` / `r2.put-to-temp` (stage); `checkpoint()` is the
single atomic flush (heap dump + promote temp pointers + commit staged set, no intervening I/O
`await`). Make P3 fetch pump stage results, commit at end-of-cell.
*Gate:* reproduce D `harness.mjs` O1/O2/O3 + negative control on the kernel; `atomicity.mjs`
mid-flush crash fuzz → all crash points coherent, 0 torn.

**Step 2 — `host.kv` (smallest Tier-H, validates the invariant end-to-end).**
`glue.js`: `host.kv.{get,set,keys}` via `__HOSTCALL`. `lib.rs`: `kv:<k>` staged rows + `kv_json`
snapshot in manifest.
*Gate:* evict→cold-restore `kv.get` survives + side-effect-in-timer `hits===1` no double-fire (B T6);
adversarial: `kv` cannot escape session namespace.

**Step 3 — `host.fs` (A).**
`glue.js`: `writeFile/readFile/list/stat/rm` shim (etag refs live in heap). `lib.rs`: `files` SQLite
meta, inline ≤4096B / R2 `${sessionId}/${etag}` >4096B (content-addressed), **R2 put commits before
meta row** (write-ordering rule), `readFile` returns `{__torn}` on missing/mismatched object, `rm`
refcount-GC. Add **per-session byte quota** (close the C open gap) on top of the 256 file-count cap
with O(1) incremental accounting; carry running totals in the manifest to avoid the O(files) wake scan.
*Gate:* A's T2 (etag==meta, restorePuts=0, no double-fire), T3 torn detect, threshold/dedup; path
isolation ×5 traversal + cross-session list → ENOENT in attacker namespace.

**Step 4 — Seeded timers (B, §4).**
`glue.js`: `setTimeout/setInterval/clearTimeout/clearInterval` shims → `__persistTimer/__dropTimer`;
`globalThis.__fire`. `lib.rs`: `timer:<id>` registry rows, `nowTick` manifest, per-fire atomic unit
(advance→heap checkpoint→registry mutation), heap-as-fired-authority idempotency. **Tick-advance
scheduler lives on the supervisor DO** (facets can't set alarms); kernel exposes
`advanceClock(targetTick)` + deterministic catch-up drain.
*Gate:* B T1/T2/T3/T5/T6 on the kernel; crash probes both commit orders → exactly-once;
`MAX_TIMERS` bomb → `TimerBombError`, loop terminates.

**Step 5 — `host.fetch` effect-fence (the needs-design item).**
Add an **idempotency-key fence**: each fetch staged with a key; on wake, a fetch whose `done:true`
flag is committed is **not** re-issued (closes the at-least-once gap in §3). Keep allowlist +
`FetchBlockedError`.
*Gate:* crash-between-fire-and-`done`-commit → fetch issued exactly once (idempotency key dedups);
blocked host → typed `FetchBlockedError` (not `{}` — fixes the P3 minor); determinism unchanged.

**Step 6 — `host.ctx` pointer-swap (codemode).**
Stage R2 temp key, promote to `manifest:ctx:<id>` at commit (swap-then-delete); add R2 orphan GC
sweep (D risk: crash between R2 put and pointer commit leaks a key — storage leak, not a tear).
*Gate:* D O2 cross-store coherence on kernel; orphan sweep reclaims leaked keys.

**Cross-cutting gate (every step):** zero regression on the existing kernel suite (BUG-1, config+tools
across evict, seeded clock/RNG, state survival) + AE telemetry per op.
