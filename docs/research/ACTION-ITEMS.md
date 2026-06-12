# Action Items — ordered, buildable, with subsystem + effort

> Concrete work to turn Engram from "durable REPL" into "substrate." Ordered by
> dependency. Effort tags: **S** = ≤1 day · **M** = a few days · **L** = a week+.
> Each item names the Engram subsystem/file it touches.

Cross-links: [`COMPUTE-EDGE-AND-SUBSTRATE.md`](./COMPUTE-EDGE-AND-SUBSTRATE.md) ·
[`UNIFIED-FS.md`](./UNIFIED-FS.md) · [`ROADMAP-TODO.md`](./ROADMAP-TODO.md).

---

## Tier A — Foundation (do first; everything else depends on these)

### A1. Verify the worker fs wiring + delete the stale comment — **S** ✅ DONE
**Touches:** `apps/kernel/src/lib.rs` (the `ctx_js = JsValue::NULL` comment).
**RESOLUTION (was scoped M "fix fail-closed wiring"):** the wiring is NOT broken — it
is **LIVE and proven**. `entry.ts` DOES supply `ctx.exports` out-of-band: the `KernelDO`
subclass (entry.ts) captures the real DO ctx into `globalThis.__ENGRAM_DO_CTX` keyed by
the trusted doId, and `kernel-glue.mjs` resolves it from that map to mint
`captured.exports.VfsGateway({props:{doId}})`. So passing `JsValue::NULL` from Rust is
EXPECTED (the glue resolves the ctx), not a fail-closed bug. The only action was to
**rewrite the stale `lib.rs` comment** that implied the wiring was a "future" TODO. A
registered hash-worker reads/writes `fs/<doId>/<path>` via `env.VFS` prefix-pinned to its
doId (VfsGateway shared-VFS + cross-session isolation smoke proves it). Done.
**See:** [`FINAL-REVIEW.md`](./FINAL-REVIEW.md) §"A1" for the canonical staleness write-up.

### A2. `fs_files` manifest schema extension — **S** ✅ PARTIAL (additive core landed)
**Touches:** `apps/kernel/src/lib.rs` (`fs_files` DDL, `flush_staged_fs`, `vfs_write`,
`reconcile_fs_files`).
**What:** ALTER-add `etag`, `sha256?`, `origin ∈ {cell,frame,container,worker}`, `mode`
columns (all defaulted; NULL etag = "trust r2_key"); record the R2 put etag on every
write path; add a session-monotonic `fsVersion` meta bumped per commit.
**LANDED (unified-fs merge):** `etag TEXT` + `origin TEXT` ALTER-added (nullable, additive);
`origin` set on every write path (`'cell'` cell-flush, `'frame'` vfs-write, `'reconcile'`
gateway reconcile). Session-monotonic **`fsVersion`** meta-row bumped on EVERY durable fs
mutation (cell flush, vfs-write, reconcile) + a `.engram/manifest.json` export written to
R2 at each checkpoint (mirrors `@engram/fs` `exportManifest` shape). The JS `VfsGateway`
now imports `@engram/fs` `normPath`/`FsPathError` (ONE isolation source of truth).
**DEFERRED:** `sha256`/`mode` columns + recording the real R2 put etag (r2_put_resilient
returns no etag today) — both still nullable; export emits `sha256:null`. The `live/`/`cas/`
key-subspace migration is deliberately deferred (flat `fs/<doId>/<path>` scheme kept per the
crown-jewel coherence invariant). **Prereq:** none (purely additive).

### A3. Generalize `reconcile_fs_files` → `fsReconcile(prefix)` — **S**
**Touches:** `apps/kernel/src/lib.rs` (post-`worker-invoke` reconcile path).
**What:** extract the existing post-invoke reconcile into one callable op usable after
any muscle invoke / container return / vfs frame / event-wake. Must be idempotent.
**Prereq:** A2.

### A4. Freeze the muscle-ladder invoke/return ABI as v1 — **S** (doc + glue assert)
**Touches:** `apps/kernel/src/lib.rs` (`worker-invoke` caps), `packages/sdk`.
**What:** codify `{input ≤1MB, fsLease, deadlineMs}` → `{ok, output ≤1MB | pointer,
error, ms}` and the `pointer={path,etag,size,contentType?,preview?}` contract as the
one shape all Tier1/2/3 muscles target. Add a runtime assert/typed error if a muscle
returns a payload over cap instead of a pointer.
**Prereq:** A2 (pointer needs etag).

---

## Tier B — Unified FS (the substrate's data plane)

### B1. `provider:'unified'` = R2 provider + in-heap LRU read-cache — **M**
**Touches:** `apps/kernel/src/kernel-glue.mjs` (`_applyFsProvider` ~1699, `host.__fs`
effect ~1575, 64KB chunking ~2405), `apps/kernel/engine/src/lib.rs` (in-heap VFS ~2325).
**What:** sync `fs.*` consults an in-heap LRU (~4–8MB, reuse `__vfs`); cold sync read
throws typed `ERR_FS_COLD`; add `fs.promises.warm` / `host.fs.warm`; writes write-through
(cache + staged host op); `/tmp/**` stays pure in-heap. Cache entries carry `etag`,
revalidated against `fsVersion` at cell start.
**Prereq:** A2, A3. **Gate:** stdlib `readFileSync`-usage compat survey first.

### B2. New key namespace + manifest export — **S**
**Touches:** `apps/kernel/src/lib.rs` (key derivation, checkpoint).
**What:** new unified sessions write `fs/<doId>/live/<path>` and `fs/<doId>/cas/<sha256>`;
old keys resolve via `r2_key` (no migration). Write `fs/<doId>/.engram/manifest.json`
(committed view + commit journal) at each checkpoint.
**Prereq:** A2, B1.

### B3. Re-back artifacts on `cas/` rows — **S**
**Touches:** `apps/kernel/src/lib.rs` (artifacts ~1647–2011), `packages/sdk`
(`readArtifact`/`streamArtifact`).
**What:** large results land at `fs/<doId>/cas/<sha256>` + a manifest row; the
`{t:artifact,…}` ranged-frame wire becomes a compat shim over `vfs-read` (same model).
Durable instead of cell-invalidated.
**Prereq:** B2.

### B4. Tenant segment in the key (engram-cloud only) — **S**
**Touches:** `apps/cloud` session-mint, `apps/kernel/src/lib.rs` (key prefix).
**What:** insert `fs/<tenant>/<doId>/` at session-mint time; kernel keeps seeing one
opaque prefix. Single-tenant `engram-kernel` paths unchanged.
**Prereq:** B2.

### B5. Flip default to `provider:'unified'` for new sessions — **S**
**Touches:** `config.fs.provider` default, `__nodeCompat` caveats text (engine `lib.rs`
~2228/2251).
**What:** new sessions default unified; `'vfs'`/`'heap'` becomes opt-in
(deterministic/no-binding). Update caveats string. Existing sessions pinned to
persisted config → zero breakage.
**Prereq:** B1–B3 green; determinism pin decision (D2) made.

---

## Tier C — Muscle rungs & substrate API

### C1. Sandbox container seam (`mode:sync` default + `mode:mount`) — **L**
**Touches:** new Tier2 adapter (kernel-side), `apps/kernel/src/lib.rs` (host.exec
dispatch), `@cloudflare/sandbox` integration.
**What:** `mountBucket(SNAPSHOTS,{prefix:'/fs/<tenant>/<doId>'})`; `mode:sync`
(copy-in/out through staged commit, default) + `mode:mount` (FUSE + reconcile-on-return
+ remount-on-wake). Pin a recent SDK (`S3FSMountError`).
**Prereq:** A1, A3, B2. **Blocking unknown:** validate s3fs `prefix` is a real security
boundary (see `ROADMAP-TODO.md` prototype #3) before untrusted tenants.

### C2. `{wasm}` content-addressed muscle registry as a plugin system — **M**
**Touches:** `apps/kernel/src/lib.rs` (`worker-register`/`worker-invoke`,
`registry_workers`), Worker-Loader `{wasm}` delivery.
**What:** formalize the just-built hash-worker registry into the Tier1 plugin surface;
`sha256=id=integrity=warm-cache-key`; switch delivery to the `{wasm}` module type.
**Prereq:** A1, A4. **Coordinate** with the in-flight registry workflow (don't fork it).

### C3. `engram.bind` binding-manifest registration + broker — **L**
**Touches:** `config.tools`/`host.*` router (`kernel-glue.mjs`), session config persist,
AE metering.
**What:** the substrate's public surface (`{name, kind, code, fs, compute, outbound}`),
persisted in session config, dispatched via the deny-by-default `host.*` router; broker
injects ONLY declared env + the lease accessor (`globalOutbound:null` unless allowlisted).
**Prereq:** A1, A4, C1/C2 (at least one muscle kind to bind).

### C4. Tier3 Workflows binding (durable fan-out) — **M**
**Touches:** new Tier3 adapter, `apps/cloud` (supervisor holds alarms — facets can't).
**What:** first Tier3 muscle: durable map over an fs prefix; `kind:'workflow'` in
`engram.bind`.
**Prereq:** A4, C3. (Prototype #1 in the roadmap.)

---

## Tier D — Hardening & honesty

### D1. Per-session byte quota + orphan-object GC + bounded `rm` — **M**
**Touches:** `apps/kernel/src/lib.rs` (`fs_files`, FsLease quotas, rm path).
**What:** enforce `byteQuota`/`fileQuota` from the lease; sweep R2 objects with no
manifest row (crash-between-put-and-commit); fix `rm` O(n) scan. Carried gap from
`SANDBOX-API.md`.
**Prereq:** A2.

### D2. Determinism pins `(path, etag)` per read — **M**
**Touches:** `apps/kernel/src/lib.rs` (staged read-set), determinism harness.
**What:** record per-cell read etags so seeded-session replay is verifiable; otherwise
re-scope the byte-identical-replay claim to `provider:'heap'` sessions in the thesis
docs. MUST land before B5 flips the default for seeded sessions.
**Prereq:** A2.

### D3. R2 `onlyIf:{etagMatches}` conditional-write probe — **S**
**Touches:** test harness against the R2 binding.
**What:** empirically verify If-Match-on-PUT via the binding; gates `mode:mount`
cooperative-write safety. Until proven, `mode:sync` is the only safe container default.
**Prereq:** none (can run anytime; blocks C1 mode:mount).
