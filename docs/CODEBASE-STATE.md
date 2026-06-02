# CODEBASE-STATE — Engram ground truth (2026-06-03)

> Single ground-truth state of the Engram (`montydyn`) repo, synthesized from 6 deep-reads
> (kernel internals, cloud, ui/sdk/cli, experiments build-stack, docs coherence, infra).
> Blunt, citation-first. Where this file and `CLAUDE.md`/`docs/*` disagree, **this file is the
> measured state** — the others carry un-propagated corrections.
>
> Repo HEAD at audit: `7961133` (tree clean on `main`). Kernel self-reports `v0.9.3`.

---

## 1. WHAT IS ACTUALLY DEPLOYED vs WHAT IS EXPERIMENTAL

### Deployed product = 3 Workers, nothing more

| Worker | Source | Self-version | Substrate |
|---|---|---|---|
| `engram-kernel` | `apps/kernel/` (`src/lib.rs` 1576L + `src/glue.js` 1604L) | **v0.9.3** (`lib.rs:383`; R2 prefix `v093/` `lib.rs:260,267`) | Path-(b): Rust DO shell + JS glue over QuickJS-ng WASM |
| `engram-cloud` | `apps/cloud/` (`supervisor.js` 797L + `facet-kernel.js` 291L + `modules.gen.js`) | v1.2 | DO Facets multi-tenant; supervisor-held hibernatable WS |
| `engram-ui` | `apps/ui/` (`src/worker.js` + `src/index.html` 508L) | — | static Worker, no bindings, talks WS directly |

### The live kernel has **NO W5 / NO W4 / NO E6** — this is the headline

The durability stack that `CLAUDE.md` and the doc-map present as the *"production pick"*
(`DURABILITY-BAKEOFF.md` "Combined (W5+W4+E6)") is **NOT integrated into `apps/kernel`**.
The live kernel uses the plain **SQLite-chunked → gzip → full-image** snapshot. No byte-delta,
no page-delta, no buffer compaction.

- Grep for W5/compaction in `apps/kernel/src/{lib.rs,glue.js,engine-hash.js,stdlib-meta.js}` → **no hits**. The only `compact()` in the tree is lodash inside `stdlib.bundle.txt`.
- W5/W4 live ONLY in `experiments/{kernel-w5,kernel-w4,w5-compaction,w4-pagedelta}`.
- Confirmed by spec docs themselves: `docs/W5-COMPACTION-PLAN.md:9` — *"Status: PROVEN in prototype, NOT yet built into apps/kernel. Spec only."* `docs/COMBINED-STACK-INTEGRATION.md:4-5` — *"Not yet applied — requires owner OK + real-CF numbers + verify gate green."*

**Consequence:** the live kernel is the **18MB-hard-reject lineage** — i.e. it equals the
*safer* adversarial variant (`adv-cur`), NOT the W4-delta variant that BREACH-1 killed.

### The actual live guard constants (`glue.js:14-28`) — the real envelope

| Constant | Value | Role | Cite |
|---|---|---|---|
| `MAX_DUMP_BUFFER_BYTES` | **18 MB** | hard dump reject — checked **FIRST**, before any full-buffer touch | `glue.js:19`, reject `:1519-1526` |
| `MAX_RESTORE_RAW_BYTES` | 18 MB | restore-side raw admission | `glue.js:16`, `:1129` |
| `MAX_USED_BYTES` | **50 MB** | snapshot admission on QuickJS *used* heap (after `runGC`) | `glue.js:14`, `:1533-1538` |
| `MAX_RESTORE_USED_BYTES` | 50 MB | restore used-heap admission | `glue.js:15`, `:1123` |
| `NATIVE_MALLOC_LIMIT_BYTES` | 16 MB | QuickJS `memoryLimit` at create+restore (v0.9.3 GAP-1 native giant-alloc backstop) | `glue.js:24`, `:1014`, `:1176` |
| `HOST_ARG_MAX_BYTES` | 8 MB | host-bridge arg/result fence | `glue.js:25`, `:612`, `:639` |
| `CELL_GROWTH_LIMIT_BYTES` / `MAX_CELL_USED_BYTES` | 8 / 16 MB | v0.8 mid-cell tripwire (interrupt reads `buffer.byteLength` every invocation) | `glue.js:21-22`, `:977-979` |
| cell tick budget | default **1200** / cap **2000** | BUG-3 primary preemption (`instrLeft` decrements every interrupt) | `glue.js:805` (`Math.min(v,2_000)`), `:966` |
| `SCRUB_SLACK_BYTES` / `SCRUB_MAX_BUFFER_BYTES` | 4 / 16 MB | arena scrub (zeros freed pages → gz shrinks; **raw buffer does NOT shrink**) | `glue.js:17-18`, `:1543-1549` |
| `MAX_STDLIB_SOURCE_BYTES` / `MAX_INLINE_STDLIB_BYTES` | 500 KB / 2 MB | stdlib injection caps | `glue.js:27-28` |
| `FETCH_MAX_BODY_BYTES` / `FETCH_MAX_HEADERS` | 2 MB / 64 | host.fetch fences | `glue.js:253-254` |

**Dump ordering matters:** the binding gate against the WS-1006 OOM cliff is the **18MB raw
buffer check (`glue.js:1519`)**, which fires *before* the 50MB used-heap check. The docs' repeated
"used-heap admission" framing understates this — used-heap (50MB) is the *secondary* fence and is
effectively unreachable given the 18MB-first geometry.

### Snapshot/restore wiring (all live, none dead)

- `dump()` (`glue.js:1514-1553`): 18MB buffer reject → `runGC` → used-heap check → scrub → `kernel.snapshot()` → serialize → gzip.
- `checkpoint()` (`lib.rs:1025-1186`): SQLite chunked (64KB rows, `CHUNK_BYTES` `lib.rs:105`) when ≤2MB (`SQLITE_HOT_MAX` `lib.rs:107`), else R2 overflow under fresh epoch-scoped key, swap-then-delete. All DELETE+INSERT+manifest+committedCell in **one synchronous turn, no `.await`** → workerd write-coalescing atomicity (raw BEGIN/COMMIT forbidden on DO SQLite).
- `ensure_glue()` restore (`lib.rs:872-1005`): manifest read → engine-hash mismatch branches to **journal-replay** (`:903-942`) → else fetch bytes (R2 / SQLite chunks) → `glue.restore`.
- SQL tables (`lib.rs:124-192`): `meta`, `snap_manifest` (incl `used_heap`, legacy `ctx_json`, `ctx_n_chunks`), `snap_chunks`, `ctx_chunks` (v0.9.1 chunked host-context store), `cell_journal` (v0.9.3 GAP-2 engine-migration journal).
- Frame types (`lib.rs:359-527`): `gen`, `ping`, `create`, `eval`, `reset`, `evict`, `stdlib`, `setContext`, `final`, `engineBump` (test hook), unknown-fallthrough. All wired.

---

## 2. BUILD-STACK READINESS — what is PR-extractable + blockers

### experiments/ is git-tracked and clean

`git status --porcelain experiments/` → empty; `git ls-files experiments/` → 230 files. Nothing
untracked. (Note: `CLAUDE.md` claims experiments were "deleted" — **they were not**; the tree is
still fully on disk. See §3.)

### W5 and W4 ARE cleanly extractable — the dirs *are* the change-set

`kernel-w5` and `kernel-w4` are full clones of `apps/kernel` carrying a confined delta:

- **Delta is in `src/glue.js` + `src/lib.rs` + `wrangler.jsonc` ONLY.** `entry.mjs`, `Cargo.toml`, `package.json`, all `scripts/`, `stdlib-src/`, and `quickjs.wasm` are byte-identical to `apps/kernel` (quickjs.wasm md5 `188955707…` matches across all three).
- **Stacking:** `apps/kernel` is base. `kernel-w5` = base + ~84 lib.rs + ~54 glue lines. `kernel-w4` = `kernel-w5` + more (**W4 ⊃ W5 ⊃ apps/kernel**). Land **W5 first, W4 second** — matches the existing layering and the PR-shaped plan in `COMBINED-STACK-INTEGRATION.md`.
- Both are **built** (fresh `build/index_bg.wasm`) and **real-CF proven** (`W5-REALCF-PROOF.md`: spike→free→checkpoint via used-heap admission, 11/11 PASS, seeded manifests byte-identical; `W4-REALCF-PROOF.md` corroborates on the W5 base).

**What W5 actually changes (glue.js-only production logic):** new constants
`SAFE_SERIALIZE_BUFFER_BYTES=45MB`, `COMPACT_TRIGGER_BYTES=12MB`, `COMPACT_USED_RATIO=0.4`;
`MAX_RESTORE_RAW_BYTES` 18→45MB, `SCRUB_MAX_BUFFER_BYTES` 16→44MB. The **18MB hard reject is
replaced** by a 45MB safe-serialize ceiling with used-heap (50MB) as the real fence + ratio-triggered
scrub → an in-envelope spike-then-free can checkpoint again instead of permanently wedging.

### Blockers / caveats for a clean W5 PR

1. **Strip the test hook.** `kernel-w5/src/lib.rs` ships ~84 lines of NON-production scaffolding: `wedgeTest` op + `memInfo` binding + `wedge_test_critical()`. Only 2 of the 54 glue lines are test-hook (`memInfo`). The actual W5 production change is **glue.js-only** — the lib.rs delta is entirely non-production. Copying the dir wholesale would ship a force-OOM op into production.
2. **Revert the bench identity.** `kernel-w5` uses R2 prefix `benchw5/` and worker name `engram-bench-w5`; W4 uses `benchw4/` / `engram-bench-w4`. Must revert to `v093/` / `engram-kernel` to preserve R2 key continuity with live snapshots.
3. **Owner OK is the real gate.** `COMBINED-STACK-INTEGRATION.md:4-5`.
4. **W4 is higher-risk and gated behind W5.** Needs the fidelity gate (closure/promise/Map/Set survive base+delta restore) + engine-hash-mismatch journal-replay fallback verified (`COMBINED-STACK-INTEGRATION.md §5`).
5. **W4 admission regression (BREACH-1) — MUST re-add the 18MB reject.** The W4-delta variant *dropped* the 18MB hard reject → WS-1006 whole-DO kill under cumulative heap pressure (`ADVERSARIAL.md:10,33-39`). The fix was proven (`b1c5363`, ProtocolSizeError gates, 6/6 PASS) but **lives only in `ADVERSARIAL.md`'s follow-up, NOT folded into `W4-BYTEDELTA-PLAN.md`** — see §3. Building W4 from its plan alone re-introduces the breach.
6. **Engine-hash cutover migration is un-exercised.** Live `engram-kernel` snapshots will see an engine-hash shift on cutover and migrate via journal-replay on first wake (`COMBINED-STACK-INTEGRATION.md:105`) — never tested against real persisted sessions.
7. **Proof workers deleted** → `verify-w5.mjs` / `verify-w4.mjs` point at dead `engram-bench-w{5,4}` URLs; proofs not independently re-runnable without redeploy.
8. **Residual that W5 does NOT fix:** the monotonic raw WASM buffer still cannot shrink in place. W5 only un-wedges the dump ceiling + scrubs for gz. A session above the 45MB safe-serialize ceiling still fails — but fails-safe (typed error, socket alive), not a crash.

### The rest of experiments/ = scaffolding (not build targets)

Bakeoff harnesses (`_bench/`, `build-{baseline,e4,e6,w3,w5,w4,combined,sandbox}/`, `realcf/`) =
in-process sims, results frozen in `DURABILITY-BAKEOFF.md` / `REALCF-VALIDATION.md`. Mechanism probes
(`e1..e6`, `w2/w3/w4/w5/w7`, `rustkernel`, sandbox protos, `imp-*`, `r4-*`) = superseded, findings in
`docs/`. `adv-cur`/`adv-w4` = adversarial red-team kernels.

---

## 3. CONTRADICTIONS + STALE — documented vs actual, with corrections

### Kernel constants

- **45MB ceiling is dead.** `CLAUDE.md` v0.2 status repeatedly cites a "45MB safe-to-instantiate raw ceiling" / "~45MB buffer dump". **No 45MB constant exists in live code.** Live dump+restore ceiling is **18MB** (`glue.js:16,19`), set by v0.7. (The 45MB figure is real only in the *unmerged* `kernel-w5` future state.)
- **1500 tick cap is stale.** v0.2 GATE-FIX text says "default 1200 / max 1500". Actual cap is **2000** (`glue.js:805` `Math.min(v,2_000)`).
- **Provenance drift:** `lib.rs:60` comment + `wrangler.jsonc` comment say "v09/ keys"; code actually writes **`v093/`** (`lib.rs:260`). Stale comments.
- **Legacy column:** `ctx_json` (`lib.rs:144-148,1144-1146`) always written `'{}'` now; live context store is `ctx_chunks`. Read-back only for pre-v0.9.1 snapshots.
- `Manifest.cell` / `Manifest.epoch` carry `#[allow(dead_code)]` (`lib.rs:1428-1431`) — read from SQL, unused.

### Cloud

- **AE dataset renamed → silent doc/data divergence.** `apps/cloud/wrangler.jsonc:51` + `supervisor.js:637` now bind dataset **`engram_kernel`**. All historical docs (`v0.5/v0.6/v1.2/deep-hibernation`, `v1.2.md:22,25`) reference **`montydyn_kernel`**. Current cloud reads/writes a DIFFERENT dataset than documented. Anyone querying `montydyn_kernel` for current usage gets nothing.
- **AE cross-version bleed (real, partially mitigated).** `v1.2.md:22`, `LIVE-INFRA-TEST.md:78`: old v0.5/v1.1 rows put the op-name in `blob1`, so unfiltered admin `/usage` mis-buckets op names (`timeout`,`setContext`,`error`,`eval`) as zero-metric tenant rows. `queryUsage` mitigates with a `blob2 IN(...)` filter (`supervisor.js:667`) but **no `blob1` sanity gate** → not fully fixed. Code comment admits a dedicated dataset is the real fix.
- **Vestigial metering clause.** `supervisor.js:457` gates an eval-count on `reply.type === 'result' || reply.ok || …`, but `glue.evalCode` never emits a `type` field (`glue.js:1266-1287` returns `{ok,value,valuePreview,…}`). The `type==='result'` clause is permanently false — only the `reply.ok` branch fires.

### UI / SDK / CLI

- **UI default endpoint is a DELETED worker.** `apps/ui/src/index.html:94,141` hardcode `DEFAULT_ENDPOINT = wss://engram-bench-w4…` — the W4 bench worker, recorded **DELETED** (`W4-REALCF-PROOF.md:104`). Out-of-the-box UI points at a non-existent endpoint.
- **UI sends a bench-only message the prod kernel rejects.** `index.html:441` sends `{t:'wedgeTest',spikeMb:22}`. `engram-kernel` has no `wedgeTest` handler → returns `{ok:false,error:'unknown msg type wedgeTest'}` (`lib.rs:527` unknown arm). The UI's built-in e2e "W5 spike/free" + "post-wedge cold restore" steps **fail against the real kernel** (`wedgeTest` only existed in `experiments/kernel-w4`).
- **UI cloud-autodetect is stale.** `index.html:163` comment "v12 uses /connect / v092 uses /ws" + the `/-v1\d/` regex key off OLD worker names — will NOT match `engram-cloud`. Cloud only detected via explicit `/connect` or non-empty apiKey.
- **Three-way version skew:** kernel **v0.9.3** (`lib.rs:383`) / SDK **0.9.2** (`packages/sdk/package.json:3`) / CLI **0.9.0** (`packages/cli/package.json:3`). (CLI default endpoint `wss://engram-kernel…` *is* correct — `engram.mjs:22`.)
- **"experiments deleted" is false.** `CLAUDE.md` says experiments are deleted / in git history only; the tree is fully present (~45 dirs incl. `kernel-w4`, the source of the dead UI default). The deletion in `36eaa70` did not remove the top-level tree.

### Docs coherence (the durability/reclaim story)

- **Doc count wrong.** `CLAUDE.md` doc-map implies a 24-doc index; `find docs -type f` = **66 files**. The "exploration arc" row in the map has no filename in its first cell (malformed).
- **Reclaim number stale in 3 docs (highest-impact stale claim).** The corrected verdict is **raw-buffer reclaim = 0% on workerd (physically precluded; monotonic)**; gz/used-heap ~99.6–99.85% is the hard ceiling (`REALCF-VALIDATION.md:18`, `STATE-OF-THE-ART.md §4`). But uncorrected old claims persist: `DURABILITY-ROADMAP.md:19` "96.9% reclaim"; `DURABILITY-BAKEOFF.md:29,84,110,135` "97.46%/96.9% RAW reclaim" (`:135` even says "in-place RAW reclaim" = exactly the 0% number); `WASM-EXPEDITIONS-2.md:66,69,112,155,177` "96.9% reclaimed". A reader trusting these alone would mis-plan the memory-envelope economics.
- **`W5-COMPACTION-PLAN.md` is self-contradictory.** Header (`:7-35`) ends in "raw-buffer reclaim FUNDAMENTALLY IMPOSSIBLE" and calls §2's "fresh instance starts small" assumption FALSE on workerd — yet **§2 (`:56-97`) still presents the refuted plan verbatim** ("A fresh WASM instance starts at the minimum memory size", "the 48MB is never reborn"). The dead plan body is an active foot-gun: an implementer reading only §2 builds the refuted mechanism.
- **`W4-BYTEDELTA-PLAN.md` omits BREACH-1.** Grep for `18MB|MAX_DUMP|reject|regression|breach` → **zero matches**. The plan never records that W4 must RE-ADD the 18MB clean-reject. Cutting over W4 from this plan re-introduces the WS-1006 kill.
- **`docs/roadmap.md` frozen pre-V1.1.** Treats V1.1 multi-tenant facet parity as the blocking next phase "building now in parallel" — but V1.1/v1.2/v0.9.3 are all SHIPPED. Could cause duplicate work.
- **`docs/TODO.md` fully stale.** Phase 0/1/2 entirely unchecked (EXP-1 "unchecked", "Drop CF creds" open, Python kernel "active") — frozen at inception, product shipped through v1.2. Unusable as a status board.
- **Narrative disagreement.** `STATE-OF-THE-ART.md §3` + `COMBINED-STACK-INTEGRATION.md` frame the W5→W4→E6 cutover as the *active frontier / next real step*, while `CLAUDE.md` says "PRODUCT COMPLETE" and lists this stack nowhere in "Remaining to GA". Two top-level narratives disagree on whether durability is the main remaining work.
- `STATE-OF-THE-ART.md §7` arc-index omits `ADVERSARIAL.md`, `W5-REALCF-PROOF.md`, `W4-REALCF-PROOF.md` (all committed parts of the same arc).

### Infra

- `Cargo.toml` package name is still **`montydyn-v05`** despite the Engram rebrand / `engram-kernel` worker.
- Test default URLs stale: `tests/kernel/*.mjs` default to `wss://montydyn-v03..v093` (pre-rebrand, swept). `smoke.mjs`, `smoke-stdlib.mjs`, `obs-*.mjs` hardcode `montydyn-v05/v06/v07` with **no argv override** → non-functional as written.
- `package.json` carries `deploy:w4`/`test:w4`/`verify:w4` pointing at `experiments/kernel-w4` + `engram-bench-w4` — experiment plumbing promoted into the product root; `scripts/deploy.ts` only knows kernel/cloud/ui (rejects `w4`) → inconsistent surfaces.
- `apps/kernel/bench/` is empty; bench harnesses actually live at `tests/kernel/bench/`.

---

## 4. RISKS + FOOT-GUNS

### Memory / kernel

- **Monotonic buffer cannot shrink in place — the long-standing BUG-2/4 hard limit persists.** A session that spikes the buffer past 18MB is **permanently unable to checkpoint** and must reset. This is exactly the v0.5 ~256MB DO-kill finding. No compaction code exists in the live kernel; W5 (the un-wedge) is unmerged.
- **`MAX_USED_BYTES=50MB` is misleadingly loose vs the documented ≤57MB-live / ~20MB-raw envelope.** The real binding guard is the 18MB raw buffer ceiling; the 50MB used-heap check is effectively unreachable as a first line. Low practical risk (geometry makes the 50MB-without-18MB path unreachable) but the constant should not be read as the operative fence.
- **Mid-cell tripwire can be outrun.** Tick cap 2000 (`glue.js:805`) sits below the workerd interrupt-throttle floor by design (tight value-free loops >~5–6M iters false-trip recoverably), but a native-builtin bomb (`.fill` on a huge typed array) yields **no bytecode interrupts** and can outrun the byteLength tripwire.
- **`cell_is_effectful` is a substring heuristic, no JS parse** (`lib.rs:1525`) → can misclassify cells (false negatives on aliased host calls). Journal-replay recovery honesty is best-effort only.

### Cloud

- **Shard key is sessionId-only** (`shardFor`, `supervisor.js:770/787`), NOT tenant+session. A tenant minting many low-entropy `sessionId` strings concentrates onto one supervisor shard and can hit the 128-facet cap (`_touch` `:313-318`) → noisy-neighbor / DoS across tenants on the same shard.
- **AUTH single point of failure.** Every data-plane request does a synchronous RPC to the one `AUTH_SHARD` ("sup-auth") to resolve the key (`:777,:755`). The documented lazy per-shard mirror (`_cacheTenant`, comments `:160-161`) **is never invoked** → the AUTH shard is a hot single DO, a latency/availability bottleneck for ALL tenants. The comment contradicts the code.
- **Weak AE SQL sanitization.** `queryUsage` interpolates tenant with only `.replace(/'/g,'')` (`:668`) into AE SQL. Tenant is server-resolved (low practical risk) but admin `?tenant=` flows in beyond quote-stripping.
- **Per-cell checkpoint write amplification.** Full gz heap image written to facet SQLite on EVERY `evalCell` (`facet-kernel.js:185`), no batching → cost scales with heap size.

### UI / SDK

- **Out-of-the-box UI is broken** (dead default endpoint + `wedgeTest` e2e dependency). First-time user with defaults gets connection failure / failing self-test.
- **CLI is effectively kernel-only** — no apiKey/`x-api-key`/`?apiKey` plumbing; cannot reach `engram-cloud`'s `/connect` without manual encoding.
- `execute(code,fns)` ships function SOURCE via `fn.toString()` (`index.mjs:150`) — closures over client scope silently break.
- SDK in Node without a global `WebSocket` and without `{WebSocket}` passed → `connect()` throws (`ws` peerDep optional). CLI imports `ws` so it's fine; direct SDK users can trip this.

### Infra / supply-chain

- **wrangler floor violation.** `CLAUDE.md` key-facts: Worker Loader needs wrangler **≥4.86.0** (error 10195 otherwise) and `engram-cloud` uses `worker_loaders`. The ONLY wrangler on PATH is global `/opt/homebrew/bin/wrangler` **v3.107.2**, and wrangler is **declared nowhere** (no dep, not in `bun.lock`). A fresh clone cannot reproduce a cloud deploy. Build/deploy reproducibility depends entirely on the operator's global toolchain (wrangler, cargo `worker-build`, node).
- **Force-added / divergent wasm delivery.** Root `.gitignore` `*.wasm` + kernel `.gitignore` `src/quickjs.wasm`/`src/ext/` vs `.gitattributes` labeling `*.wasm` a "Required binary delivery artifact". Reconciled only because `apps/cloud/.gitignore` does `*.wasm` then `!vendor/**`. **Kernel derives + wasm-opts** quickjs.wasm from `node_modules/quickjs-wasi` at build time; **cloud vendors the RAW** (un-opt'd) bytes to keep engine bytes snapshot-stable. The two apps ship **opposite** engine bytes → real drift risk if `node_modules` quickjs-wasi changes (kernel re-derives, cloud stays pinned to vendor).
- **`wasm-opt` silent fallback.** `prepare-wasm.mjs` ships the UN-optimized engine if binaryen fails → non-deterministic engine SHA across machines.
- **Account id committed.** `CF_ACCOUNT_ID=54a86ff…` in `apps/cloud/wrangler.jsonc` vars (comment claims "non-secret"; real identifier in a private repo — exposure risk if visibility changes).
- **No CI, no test runner.** ~11 smoke harnesses + bench are standalone node+ws scripts hitting LIVE workers; none wired to `package.json`, none run on build/deploy; many hardcode swept URLs → "tests exist" is false confidence.
- **Broken submodule state.** git reports `expected submodule path quickjs-ng not to be a symbolic link`; `context/quickjs-wasi` fails. Could break a clean checkout for another agent.
- **`modules.gen.js` stale-snapshot risk.** Generated artifact committed (~79KB+, embeds base64 quickjs.wasm + all glue/ext as string exports). If `bake-modules` isn't re-run after a `glue.js` change, cloud ships stale engine bytes. (Mitigant: `bake-modules.mjs:40` reads `apps/kernel/src/glue.js` as single source of truth — confirmed by commit `41e668f`.)

---

## 5. HONEST CURRENT ROADMAP — two paths, adversarial findings folded in

The product is shipped and scale-validated at v0.9.3 / v1.2. The genuinely open frontier is
**durability hardening**, and there are two paths.

### Path A — JS-harden (cut over the proven durability stack into apps/kernel)

This is the lower-risk, already-proven path. Ordered:

1. **W5 first.** glue.js-only production change (45MB safe-serialize ceiling replaces the 18MB hard reject; used-heap 50MB becomes the real fence; ratio-triggered scrub). Closes the spike-then-free **WEDGE**. Pre-merge: **strip the `wedgeTest`/`memInfo` test hook** from `kernel-w5/lib.rs`, **revert `benchw5/`→`v093/`** and worker name. Blocked on **owner OK** (`COMBINED-STACK-INTEGRATION.md:4-5`).
2. **W4 second (gated behind W5, higher risk).** 256B byte-delta dump. **MUST re-add the 18MB clean-reject** (BREACH-1 / `b1c5363`) — the `W4-BYTEDELTA-PLAN.md` spec omits this; use `ADVERSARIAL.md`'s follow-up as the authoritative requirement. Needs fidelity gate (closure/promise/Map/Set across base+delta restore) + journal-replay fallback verified.
3. **Exercise the engine-hash cutover migration** against real persisted `engram-kernel` sessions (un-tested; first-wake journal-replay).

**Hard residual either way:** raw WASM buffer reclaim is **0% / physically impossible on workerd**
(monotonic; `REALCF-VALIDATION.md:18`). W5 only un-wedges the ceiling + shrinks gz; a session above
the 45MB safe-serialize ceiling still fails-safe (typed error, socket alive). **Correct the
96.9%/97.46% RAW-reclaim claims in `DURABILITY-ROADMAP.md`/`DURABILITY-BAKEOFF.md`/`WASM-EXPEDITIONS-2.md`
and delete `W5-COMPACTION-PLAN.md §2` before anyone plans capacity around them.**

### Path B — Rust-rewrite (move the JS brain to Rust/WASM)

Explored, **no parity gain** (`REWRITE-OPTIONS.md`; verdict corrected in `77712ae`). The `rustkernel`
rquickjs probe surfaced **GUARD-GAP-1** (`ADVERSARIAL.md:41-44`): rquickjs's native `set_memory_limit`
does **not** bound cumulative fast-array growth → a Rust rewrite would still need an explicit mid-cell
tripwire (the same guard the JS glue already has). So a rewrite **inherits the JS kernel's guard
burden without buying memory-reclaim** — Path B is not justified by durability; defer.

### Cross-cutting cleanups (cheap, unblock honesty)

- Reconcile the AE dataset rename (`engram_kernel` vs documented `montydyn_kernel`); ideally a dedicated v1.2 dataset to kill the blob-schema bleed.
- Fix the UI default endpoint (`engram-bench-w4` → `engram-cloud`/`engram-kernel`) and remove/guard the `wedgeTest` e2e step.
- Bump SDK 0.9.2 / CLI 0.9.0 to track kernel v0.9.3; pin wrangler ≥4.86.0 as a real dep.
- Refresh `docs/TODO.md` + `docs/roadmap.md` (both frozen pre-V1.1).

### V1 facets (separate track, spike proven)

Facet WS hibernation resolved via the **supervisor-proxy** model (supervisor holds the hibernatable
socket, RPCs each frame to the facet — facet-held client sockets are broken `DataCloneError`). Facets
**cannot set alarms** → idle/TTL scheduling lives on the supervisor's 30s sweep. Durability is per-cell
synchronous checkpoint into the facet's own SQLite, independent of alarms. This is shipped in
`engram-cloud`; remaining facet work is scale-at-1000s, not correctness.

---

### Appendix — fastest pointers

- Live guard constants: `apps/kernel/src/glue.js:14-28`
- Dump ordering (18MB-first): `apps/kernel/src/glue.js:1514-1553`
- Checkpoint atomicity: `apps/kernel/src/lib.rs:1025-1186`
- W5 change-set (unmerged): `experiments/kernel-w5/src/glue.js` (+ strip `lib.rs` test hook)
- W5 not-merged proof: `docs/W5-COMPACTION-PLAN.md:9`, `docs/COMBINED-STACK-INTEGRATION.md:4-5`
- BREACH-1 / W4 must-re-add-18MB: `docs/ADVERSARIAL.md:10,33-39,92-109`
- Reclaim truth: `docs/REALCF-VALIDATION.md:18`
- AE dataset rename: `apps/cloud/wrangler.jsonc:51`, `supervisor.js:637`
- UI dead default: `apps/ui/src/index.html:94,141,441`
