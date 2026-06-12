# FINAL REVIEW — substrate thesis, unified-fs, adopt-sandbox (adversarial pass)

> Reviewer: fable (final-review workflow, 2026-06-11). Scope: `COMPUTE-EDGE-AND-SUBSTRATE.md`,
> `UNIFIED-FS.md`, `ACTION-ITEMS.md`, `ROADMAP-TODO.md`, cross-checked line-by-line against the
> live code in `apps/kernel/` (lib.rs, entry.ts, kernel-glue.mjs, engine/src/lib.rs) and the
> shipped invariants in `../SANDBOX-API.md`.
>
> **Verdict: GO-WITH-CHANGES.** The direction is sound — arguably the only coherent way to turn
> Engram into a substrate without forfeiting the heap-snapshot moat. The four docs are unusually
> honest for vision docs (rejected alternatives are recorded, open unknowns are named). But there
> is one factual error about the current code (A1), one internal contradiction (cache-in-snapshot
> vs smaller-snapshots), several scope-of-claim problems (the "never torn" moat statement, the
> "mid-computation" resume claim), and a missing chapter (multi-tenant facet parity for the entire
> muscle ladder). None are direction-killers; all are fixable in the docs before building.

---

## 1. Verified-true (checked against code, not vibes)

- **Line references are accurate.** `fs_files` DDL at lib.rs:365, `flush_staged_fs` at :725,
  `vfs_write` at :833/:915, `reconcile_fs_files` at :1368, `ctx_js = JsValue::NULL` at :1235,
  `VfsGateway` at entry.ts:44, in-heap-VFS caveats text in engine/src/lib.rs ~2251 ("fs is an
  in-heap virtual filesystem"), `_applyFsProvider` at kernel-glue.mjs:1704, `ERR_FS_ASYNC_ONLY`
  at :2395. The docs were written against the real tree.
- **The ABI claim is literally true.** lib.rs:1186 `MAX_INPUT_BYTES = 1MB`, :1284
  `MAX_OUTPUT_BYTES = 1MB`, :1300 `"OutputTooLargeError … (use env.VFS for large data)"`. Freezing
  this as the universal muscle ABI (A4) is codification, not invention. Correct call.
- **The staged-commit invariant exists and is tested** (`SANDBOX-API.md` §2: 16/16 + 41/41
  mid-flush crash points, 0 torn). Keeping it untouched as `mode:txn` is the right conservatism.
- **artifact-fs rejection is right.** It is a git-FUSE lazy-clone client daemon (Go), not an R2
  object-fs, not bindable from a Worker/DO. Demoting it (and Cloudflare Artifacts) to optional
  Tier2/versioning plugins is the correct answer to the owner's pointer — the docs answer the
  owner's actual question ("or something better") instead of rubber-stamping the suggestion.
- **The pointer pattern is the correct consequence of the 18MB ceiling**, and it composes with the
  existing artifact/oversized-result machinery (a7f3fa5) instead of fighting it.
- **mode:sync as the container default is right.** s3fs-over-R2 is genuinely not POSIX; making
  coherence the default and FUSE the opt-in for big files is the only defensible polarity.
- **Migration phasing is genuinely non-breaking** as designed: `r2_key` indirection means no key
  migration; config persists across cold wake (proven), so existing sessions stay pinned to their
  provider. Phase 0 is additive-only. This is well thought through.
- **Compat-gate data point the docs asked for:** the shipped stdlib bundle
  (`apps/kernel/src/stdlib.bundle.txt`) contains **zero** `readFileSync` call sites. The B1
  "stdlib readFileSync survey" gate passes trivially for the bundled stdlib; the residual risk is
  user-supplied code only (see §3.2).

---

## 2. WRONG / STALE — must fix in the docs

### 2.1 A1 is mischaracterized: the "fail-closed worker fs wiring" is ALREADY BUILT

The docs claim (COMPUTE §2, UNIFIED-FS Phase 0, ACTION-ITEMS A1, effort **M**) that "hash-workers
may have **no working fs path in production**" because "`entry.ts` never supplies `ctx.exports`."
**The code says otherwise:**

- `entry.ts:102` — `__ENGRAM_DO_CTX` global map; `KernelDO` (the exported subclass of the Rust DO)
  captures the raw DurableObjectState into it in its constructor, keyed by lowercased doId hex.
- `kernel-glue.mjs:1268-1273` — when lib.rs passes NULL ctx, the glue **falls back to
  `globalThis.__ENGRAM_DO_CTX.get(doId)`** and mints the prefix-pinned `VfsGateway` stub from
  `captured.exports.VfsGateway({props:{doId}})`, injects it as `env.VFS`, `globalOutbound:null`.
- `wrangler.jsonc:13` and `alchemy.run.ts:71` both carry `enable_ctx_exports`.
- lib.rs:1278 runs `reconcile_fs_files()` after every invoke.

The Rust comment at lib.rs:1233 ("unless a *future* entry.ts wiring supplies ctx.exports") is
**stale** — the future wiring exists. The docs inherited the stale comment instead of reading
entry.ts. Note `b52d066` (host.fs R2 hardening, #18) merged ~13:26 today and the docs were written
~17:12 — same-day staleness is forgivable, but A1 as written sends someone to "fix" working code.

**Re-scope A1 (M → S): "verify live, then delete the stale lib.rs comment."** The genuinely open
sub-questions worth the verification pass: (a) does the captured state's `.exports` actually
resolve `VfsGateway` at runtime (the compat flag + top-level-export combination has never been
live-asserted in `tests/` — no test references `worker-invoke`/`VfsGateway`); (b) does the
worker-rs `self.do_id` hex formatting match `doIdString()`'s lowercase key exactly; (c) does any
of this survive the **engram-cloud facet** context (see §3.6 — almost certainly not, and that's
the real gap hiding behind A1).

### 2.2 Internal contradiction: snapshot-persisting the read cache vs "smaller snapshots"

UNIFIED-FS §4 says the 4–8MB in-heap LRU cache is "snapshot-persisted … harmless — it's
revalidated on wake," while the headline win of the whole design is "file bodies leave the heap →
smaller snapshots, no more file-driven heap high-water-mark." These fight each other:

- 8MB of cache is **44% of the 18MB dump ceiling** — calling it "well under" is generous; it
  recreates the exact file-driven high-water-mark pressure the design claims to kill (and per the
  v0.2 finding, WASM memory is monotonic — cache pages once touched never shrink the buffer).
- Persisting revalidatable bytes into every checkpoint buys nothing and costs dump size, zstd
  time, and restore time on every cell.

**Fix:** purge (or aggressively shrink) the cache at checkpoint time — it is by definition
reconstructible from R2 + etags. Default the cap nearer 2–4MB, configurable. Keep `/tmp` (which
is NOT reconstructible) snapshot-carried, exactly as designed. This is a one-paragraph doc fix
and a real design improvement.

### 2.3 "Heap and fs are never torn … this is the moat" — overclaims scope

COMPUTE §4.1 states the staged-commit invariant as if it covers the unified fs. It covers
**mode:txn only** (in-VM cell writes). UNIFIED-FS §8 admits this ("class-2/3 writers are by
definition outside the heap's commit point") — but the vision doc's moat statement doesn't carry
the qualifier, and the vision doc is what gets quoted. Under the unified design, coherence for
frames/workers/containers/external writers is **boundary-reconciled (LWW + etag-surfacing), not
transactional**. That is a fine and honest position — state it in §4.1: *"atomic for cell writes
(mode:txn); reconciled-at-boundaries for everything else."* Otherwise the first third-party
binding author who loses a write to LWW will quote the moat sentence back at you.

### 2.4 "Snapshot-resumable mid-computation" — slightly oversold

COMPUTE §1/§4 describe the brain as resuming "mid-computation." The shipped primitive is a
**per-cell** checkpoint (post-cell flush; `eval_resume` continuation is bounded by
`cellBudgetTicks`, 5e2d361). The honest phrasing — and it's still the moat — is "resumes *between
cells* with full live state (closures, promises, pending continuations) and no replay." Arbitrary
preemption-point resume is not shipped; don't let a partner design against it.

---

## 3. Coherence holes & risks (design-level, constructive)

### 3.1 `fsVersion` must bump on EVERY mode:direct write, or the cache serves stale bytes

UNIFIED-FS §3 Plane 2 says `fsVersion` bumps "per commit." But mode:direct writers (vfs-* frames,
hash-workers via the gateway, containers, R2-event reconcile) mutate the namespace **between**
commits. If a cell's warm cache is only revalidated against `fsVersion` at cell start, the
sequence ⟨cell warms /a → frame rewrites /a → next cell reads /a sync⟩ serves stale bytes unless
the frame path and `fsReconcile` also bump `fsVersion`. The doc never says they do. **Spec it:**
`fsVersion` increments on staged-commit flush AND on every direct-write/reconcile that changes
any row. Cheap (one SQLite meta bump), and without it the whole "one coherence" claim has a hole
exactly where third parties enter.

### 3.2 ERR_FS_COLD vs library code that walks the tree

The warm-cache design assumes the cell author knows which paths to `warm()`. Real Node-shaped
libraries (isomorphic-git is the canonical case, glob walkers, config-file resolvers) discover
paths dynamically and call sync fs at depths you can't pre-enumerate. Their failure mode under
`provider:'unified'` is a mid-walk typed throw with no recovery short of catch-warm-rerun — and
re-running a cell with side effects violates Engram's own no-replay ethos. Mitigations worth one
line each in the doc: (a) `warm(prefix)` recursive prefetch (bounded by the cache cap), (b) the
error message should carry the missing path so an outer driver can warm-and-retry *idempotent*
cells, (c) keep recommending `provider:'heap'` for sync-heavy library workloads. Don't promise
"real Node code just works" anywhere — the Node-shaped facade promise weakens under unified, and
the `__nodeCompat` caveats rewrite (B5) must say so plainly.

### 3.3 mode:sync copy-through must be streamed, and the middle of the size range is awkward

Copy-in/copy-out flows through the DO (128MB isolate memory, and the kernel heap is far smaller).
The doc never says the copies are **streamed R2→container** rather than buffered through the DO.
At ~100MB–1GB, mode:sync is too slow/hot and mode:mount is the only option — meaning the
*coherent* mode silently stops being available exactly when files get interesting. Acceptable,
but say it: mode:sync is for ≲tens-of-MB declared inputs/outputs; above that you are in
reconcile-land whether you like it or not.

### 3.4 Mid-exec visibility: staged cell writes are invisible to a running container

Under mode:txn a cell's write isn't durable in R2 until checkpoint. A container exec started in
the same cell (or racing a long exec) reads the FUSE mount → R2 → **pre-commit bytes**, plus
s3fs's own caches on top. The docs probe s3fs staleness (prototype 3) but never state the rule.
State it: *inputs a container may read must be committed (or passed via mode:sync copy-in) before
`host.exec`; concurrent cell-writes during a live exec are NOT visible until the next boundary.*

### 3.5 R2 event notifications are bucket-level rules — the wake loop fans in through one queue

Prototype 2 implies per-session event wiring. R2 notification rules are per-bucket, few in number,
prefix/suffix-filtered — you get ONE rule on `fs/` and a queue consumer that parses keys and
routes to the right supervisor/DO. Fine, but it means: hot buckets funnel all sessions' events
through one consumer (throughput + noisy-neighbor), and reconcile MUST be idempotent (A3 already
requires this — good). Also the consumer waking a hibernating DO per event has a cost/abuse edge
(an external writer can force-wake sessions); needs a debounce/batch note.

### 3.6 The missing chapter: multi-tenant (engram-cloud facets) parity for the muscle ladder

The four docs are written against single-tenant `engram-kernel`. The shipped product is ALSO
`engram-cloud` (facet kernels via Worker-Loader `{wasm}`). Open and unaddressed: do facet kernels
have a `LOADER` binding (Tier1 from inside a facet)? Does `ctx.exports`/`__ENGRAM_DO_CTX` exist
in a Worker-Loader-loaded facet class (almost certainly the supervisor must broker)? Facets
cannot set alarms (proven) — noted for Tier3, but the R2-event wake loop and keep-warm also land
on the supervisor. **The substrate's brokering layer probably lives in the supervisor for cloud,
in the DO for bare kernel — two reference monitors, one contract.** This needs a section in
COMPUTE §2 and likely a new action item between A1 and C3.

### 3.7 Ordering nits (roadmap is otherwise sound)

- **Pull D3 (R2 conditional-PUT probe, S, zero prereqs) into Phase 0 / prototype-3 week.** It
  gates C1 mode:mount and costs an afternoon; parking it in "hardening" is the one real
  sequencing error.
- B2's prereq list ("A2, B1") is too strict — the namespace/key-derivation work doesn't need the
  LRU cache; B1 and B2 can run in parallel after A2.
- D2 (determinism pins) is correctly gated before B5; keep that hard.
- The in-flight tier1 worktree (`worktree-tier1-hardening`, `622fa91`) is already moving on C2's
  territory — ACTION-ITEMS says "coordinate, don't fork" once; the roadmap should carry the same
  flag on prototype 4 (it does, ◐). Fine.

---

## 4. Platform facts (CF, 2026) — what I could and couldn't verify

Within my verification horizon (early 2026), these doc claims are **correct**: Workers isolate
≈128MB; Worker Loader is Paid-plan, `get(id,cb)` warm-cache keyed by id (hash-as-codeId is the
right antidote to the cache foot-gun); `{wasm}` Worker-Loader module type is real but
undocumented (proven in the facet spike — correctly carried as a risk); R2 is strongly consistent
with conditional writes via `onlyIf` (probing `etagMatches`-on-PUT through the *binding* is still
the right move — D3); R2 has no append/rename/atomic-multi-key, event notifications → Queues are
real and bucket-level; Workers `node:fs` is ephemeral/virtual with NO R2-backed binding shipped;
facets cannot set alarms; `@cloudflare/sandbox` is a real Linux container behind a DO with
exec/runCode/exposePort and idle-sleep and no heap snapshot.

**Could NOT independently verify (post-cutoff or beta-fluid) — treat as "pin and probe," the docs
mostly already do:** `mountBucket()` exact API/`prefix`/`credentialProxy`/`S3FSMountError`
surface (pin the SDK version in C1, already noted); the 12GiB container instance ceiling (size
tiers have been moving — check current instance-type availability on the account's plan, and note
container instances have their own per-account concurrency/disk limits the docs never mention);
Cloudflare Artifacts beta status/pricing ("$0.15/1k + $0.50/GB-mo", April-2026 dates) — mark
these as observed-at-review-time, not load-bearing (they aren't — Artifacts is correctly
non-load-bearing). The **s3fs-prefix-as-security-boundary question is correctly flagged as THE
P0 unknown** — my strong prior is that `prefix` is a *view*, not a credential scope, in
binding-mount mode (the mount's credential is the bucket binding), so plan for the fallback
(per-session scoped temp S3 creds or the gateway-only path) to become the design, not the backup.

---

## 5. Is the thesis coherent? (the adversarial read)

**Yes.** The strongest test of the substrate framing: every component is forced into one of two
roles — durable coherent state (brain + manifest + R2) or disposable horsepower (Tier1/2/3) — and
every interaction between the roles passes through exactly three frozen seams (the invoke ABI,
the FsLease, the pointer). That's a real architecture, not a slogan. The honest weaknesses are
the ones the docs themselves (mostly) flag: coherence degrades from transactional to reconciled
the moment you leave the heap (§2.3 — make the scoping explicit); sync fs semantics degrade from
"works" to "works-if-warm" (§3.2 — don't oversell Node compat); and the security story's hardest
question (s3fs prefix) is empirically open. The "value over raw Cloudflare = brain + registry +
one fs + brokering" framing in COMPUTE §4 is the right pitch and survives scrutiny — provided the
moat sentence is scoped per §2.3/§2.4.

The adopt-sandbox decision is correct and well-argued: rebuilding container plumbing buys nothing,
the differentiator (live-heap snapshot) is precisely what Sandbox lacks, and the seam (R2 VFS)
is the same seam the rest of the design already needs. The one caveat: adopting Sandbox means
adopting its release cadence and its DO-fronted lifecycle — pin versions, wrap its errors in
Engram-typed errors at the adapter boundary, and never let `@cloudflare/sandbox` types leak into
the frozen ABI.

---

## 6. Required doc corrections (summary checklist)

1. **A1**: re-scope "fix" → "verify live + delete stale lib.rs:1233 comment"; effort M → S; move
   the real unknown (facet-context brokering, §3.6) into its own item.
2. **UNIFIED-FS §4**: purge/shrink the LRU cache at checkpoint; default cap 2–4MB; drop
   "harmless" — persisting it contradicts the smaller-snapshots win.
3. **COMPUTE §4.1**: scope the "never torn" moat claim to mode:txn; add "reconciled-at-boundaries
   for direct writers."
4. **COMPUTE §1**: "mid-computation" → "between cells, no replay."
5. **UNIFIED-FS Plane 2**: `fsVersion` bumps on every direct write/reconcile, not just commits.
6. **UNIFIED-FS §6 / COMPUTE §3**: add the mid-exec visibility rule (§3.4) and the streamed-copy
   + size-band guidance for mode:sync (§3.3).
7. **ROADMAP**: pull D3 into Phase 0; relax B2's B1-prereq; add the facet-parity item.
8. **Platform numbers** (12GiB, Artifacts pricing/dates, mountBucket surface): mark as
   verified-at-review-time; pin `@cloudflare/sandbox` version in C1.
9. **Prototype 2**: note bucket-level rule granularity → one queue consumer routes all sessions;
   add debounce/abuse note for external-writer wake.

## 7. Top risks to validate first (ordered)

1. **s3fs `prefix` security boundary** (prototype 3, P0) — gates untrusted Tier2 entirely;
   assume it fails and design the scoped-credential fallback as primary.
2. **VfsGateway live verification incl. facet context** (re-scoped A1 + §3.6) — the capability
   model's proof-of-pattern has zero live tests today.
3. **ERR_FS_COLD compat blast radius on real user code** (B1 gate) — bundled stdlib is clean
   (0 readFileSync), but library tree-walkers are the unknown; prototype with isomorphic-git.
4. **R2 conditional-PUT via the binding** (D3, pull forward) — gates mode:mount cooperative
   writes.
5. **Reconcile cost at 1k–10k manifest entries + event-loop wake economics** (prototype 2) —
   gates the async-writer substrate story at scale.
