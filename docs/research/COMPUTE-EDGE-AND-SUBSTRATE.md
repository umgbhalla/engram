# Compute Edge & Substrate — the Engram thesis past the REPL

> **One line:** Engram is no longer "a durable JS REPL." It is a **substrate** — a
> durable, hibernating *brain* that orchestrates an escalating ladder of *muscle*
> (in-heap → isolate → container → workflow) over **one coherent R2 data plane**,
> brokering capabilities to each rung so that other people's binding-infra can plug
> in and run coherently. The REPL is the brain; everything else is muscle behind
> one contract.

Cross-links: [`UNIFIED-FS.md`](./UNIFIED-FS.md) (the one data plane this whole
thesis stands on) · [`ACTION-ITEMS.md`](./ACTION-ITEMS.md) (what to build) ·
[`ROADMAP-TODO.md`](./ROADMAP-TODO.md) (in what order) ·
[`repl-env-surface.md`](./repl-env-surface.md) (why the VM is bare QuickJS, the
two-runtime model) · `../SANDBOX-API.md` (the staged-commit coherence invariant —
the crown jewel).

---

## 0. Why "substrate" and not "REPL"

The shipped product (V1.0, multi-tenant, metered) is a durable hibernating JS REPL
whose per-cell heap snapshot is the resumption primitive. That is **done**. The
owner direction is to treat it as a *platform other infra builds on*: RAG indexers,
SQL-over-R2 engines, build pipelines, agent runtimes, transcode jobs. For that to
work, three things must be true that aren't fully true yet:

1. **One filesystem.** Cells, isolates, containers, workflows, external bindings,
   and SDK clients must all read/write the *same bytes coherently*. Today the fs is
   fragmented (in-heap VFS vs `host.fs` R2 vs artifacts vs container FUSE vs KV
   sugar). → solved in [`UNIFIED-FS.md`](./UNIFIED-FS.md).
2. **One compute contract.** Heavy work can't run in the 18MB single-threaded heap.
   It must escalate to bigger muscle behind a single invoke/return ABI so rungs are
   substitutable. → the muscle ladder, below.
3. **One security model.** Third-party code/bindings must run *fail-closed*: only
   the capabilities the kernel hands them, nothing more. → capability-binding, below.

This doc is the vision that ties those together. The other three docs are the plan.

---

## 1. The muscle ladder (Tier 0–3) — one contract, four rungs

The **brain** is the durable QuickJS heap inside the kernel DO: single-threaded,
~18MB dump ceiling, snapshot-resumable mid-computation. It is deliberately small and
slow at bulk work — that's the price of being snapshottable. When a cell needs more
than the brain can hold or do, it calls **`host.exec(hash, args)`** and the kernel
dispatches to the right rung:

| Tier | What | Where it runs | Limits | Use for |
|---|---|---|---|---|
| **0** | In-heap stdlib | the QuickJS heap itself | ≤18MB dump | lodash/zod/date math, small pure transforms (shipped: `config.modules`, see v0.6) |
| **1** | Hash-worker isolate | dynamic `{wasm}`+pure-JS Worker-Loader isolate | 128MB, ephemeral, no live-heap | CPU-bound pure compute: parse, hash, esbuild, DuckDB-WASM, image resize |
| **2** | Sandbox container | `@cloudflare/sandbox` (real Linux behind a DO) | 12 GiB, real bash/git/python/native, 10min idle-sleep | npm install, native toolchains, ffmpeg, headless browser, real POSIX |
| **3** | Workflow | Cloudflare Workflows | durable, retried, multi-step, hours | fan-out/orchestration, long pipelines, map over an fs prefix |

**The single ABI all rungs target (freeze as v1):**

```
invoke:  { input: JSON ≤1MB, fsLease, deadlineMs }
return:  { ok, output: JSON ≤1MB | pointer, error:{name,message}, ms }
```

This is *already* the exact shape of the shipped `worker-invoke` path in
`apps/kernel/src/lib.rs` (1MB input/output caps, typed `OutputTooLargeError` whose
message literally says "use env.VFS for large data", timeout/cpu clamps). **Declaring
it the universal ABI is what makes Tier1/2/3 substitutable behind one `host.exec`
call.** A cell shouldn't know or care which rung ran its job.

### Result production — the pointer pattern (NOT payloads)

The 18MB heap ceiling is the hard constraint that shapes everything. So the rule is:

> **A muscle returns a POINTER, never a payload.**
> `pointer = { path, etag, size, contentType?, preview? }`

The bytes land in the R2 data plane (`fs/<doId>/cas/<sha256>` or `…/live/<path>`);
the muscle returns a small handle into that namespace; the heap stays tiny; the next
cell dereferences lazily (or streams) when it actually needs the data. `preview`
(first N bytes / a schema summary) buys back most interactive UX without pulling the
whole payload through the heap. This is why the unified fs (next doc) is *load-bearing*
for the muscle ladder, not a side quest — the pointer contract is meaningless without
one coherent namespace the pointer can point into.

---

## 2. The capability-binding security model

Every rung runs **fail-closed**. The kernel is the only reference monitor; it hands
each muscle exactly the capabilities its binding manifest declares, and nothing else.

Three capability axes, injected by the kernel at invoke time:

1. **Code** — content-addressed. `sha256 = id = integrity = warm-cache-key`. The
   kernel only runs code whose hash is registered (`registry_workers` table, body at
   R2 `workers/<hash>.js`). A muscle can't smuggle in code; the hash *is* the
   identity and the integrity check and the Worker-Loader warm-cache key, all at once.
2. **Filesystem** — prefix-isolated via an **`FsLease`**:
   `{ leaseId, tenantId, prefix, modes:[read|write], byteQuota, fileQuota, ttlMs }`.
   The reference implementation already exists: `VfsGateway` (a `WorkerEntrypoint` in
   `apps/kernel/entry.ts`) mints a per-session RPC stub whose `fs/<doId>/` prefix is
   pinned to a *trusted* doId via props — the dynamic worker never sees the raw
   bucket. ⚠ **Known gap:** `lib.rs` ~1231 currently passes `ctx_js = JsValue::NULL`
   and the glue *fails closed* ("RegistryUnavailableError") because the `ctx.exports`
   wiring in `entry.ts` is incomplete — so hash-workers may have **no working fs path
   in production right now**. Fixing this is action item #1; it's the proof-of-pattern
   for the entire capability model.
3. **Egress / bindings** — deny-by-default. `globalOutbound:null` unless the manifest
   allowlists hosts. Other env bindings (a KV namespace, a Vectorize index, a service
   binding) are injected *only if declared*. This extends the already-shipped
   deny-by-default `host.*` router and `config.tools` mechanism — it's not a new
   subsystem, it's `config.tools` grown a manifest.

### Binding registration — how external infra plugs in

```js
engram.bind({
  name: 'rag',                                  // exposed to cells as host.rag.*
  kind: 'hash-worker'|'container'|'workflow'|'service'|'cf-binding',
  code: '<sha256>' | {service:'…'} | {image:'…'},
  fs:   { prefix:'/rag', modes:['read','write'] },   // → FsLease minted at invoke
  compute: { timeoutMs, cpuMs },
  outbound: null | ['api.example.com'],              // capability env injection
})
```

Manifests persist in session config (config already survives cold wake — proven).
Dispatch goes through the existing `host.*` router. The broker injects **only** the
declared env + the lease accessor. This is the substrate's public API surface: a RAG
binding, a SQL-over-R2 binding, an ffmpeg binding, an Artifacts-versioner binding are
all *the same shape* — which is itself the proof the substrate model holds.

---

## 3. The Sandbox decision — ADOPT `@cloudflare/sandbox`, don't rebuild

**Decision: adopt, do not reinvent.** `@cloudflare/sandbox` is a real Linux container
fronted by a DO, with `exec`/`execStream`/`runCode`/`files`/`git`/`exposePort`+preview
URLs/background-procs, 10-min idle-sleep. It has **no live-heap snapshot** — which is
*exactly Engram's differentiator*: the brain hibernates and resumes mid-computation
holding pointers into the fs; the container does not. So the division of labour is
clean: **brain = durable + coherent state; container = raw POSIX horsepower.** Don't
rebuild container plumbing we'd only do worse.

### The seam IS the R2 VFS

The container and the kernel must be the same bytes. Mechanism:
`mountBucket(SNAPSHOTS, { prefix:'/fs/<tenant>/<doId>' })` (s3fs FUSE) mounts the
session's R2 prefix into the container so `host.fs` in a cell and `cat` in the
container shell see one tree. Caveats (all real, all designed-around in
[`UNIFIED-FS.md`](./UNIFIED-FS.md) §container reconciliation):

- FUSE-over-R2 is **not POSIX, not atomic** → the kernel's SQLite `fs_files` manifest
  is the source of truth, not the bucket listing.
- **Mounts die on sandbox sleep** → must remount on wake, then reconcile.
- Copy hot files to container `/tmp`; CF warns against overlaying image-seeded files
  at `/workspace` (prefer `/data`/`/mnt`, symlink if needed).
- Offer two modes: **`mode:sync`** (declared inputs/outputs copied through the
  staged-commit path — coherent, the default) vs **`mode:mount`** (direct FUSE — fast,
  for big files, reconcile-on-return).

⚠ **Top open unknown:** is s3fs `prefix` a real *security* boundary or just a view
scope? In R2-binding mount mode the underlying credential scope is unclear; endpoint
mode without `credentialProxy:true` writes creds to container disk. This MUST be
validated before untrusted Tier2 tenants (fallback: per-session scoped temp S3 creds,
or per-tenant buckets). See `ROADMAP-TODO.md` prototype #3 and `UNIFIED-FS.md` risks.

---

## 4. Engram-as-substrate — what we are, stated plainly

A bare Cloudflare account already gives you Workers, Sandbox, R2, Workflows. Engram's
value over assembling those raw is exactly four things:

1. **A durable hibernating brain.** A live heap that snapshots mid-computation and
   resumes holding pointers into the fs, with the **staged-commit invariant**
   (`../SANDBOX-API.md`, proven 16/16 + 41/41 crash-fuzz) guaranteeing heap + fs
   metadata + bodies commit in *one atomic flush* — heap and fs are never torn. The
   Sandbox SDK has no equivalent. This is the moat.
2. **A content-addressed muscle registry** with per-session invoke gating — code is
   pinned by hash, warm-cached by hash, integrity-checked by hash.
3. **One coherent filesystem** across REPL / isolate / container / workflow / external
   bindings (the entire reason `UNIFIED-FS.md` exists).
4. **Capability brokering** — deny-by-default, lease-minted, AE-metered per tenant.

### Pluggable binding examples (all via `engram.bind`)

- **SQL-over-R2** — DuckDB-WASM hash-worker queries parquet under the lease prefix →
  pointer to `result.parquet`.
- **RAG** — indexer muscle subscribed to R2 events on `/docs`, writes to Vectorize,
  exposes `host.rag.query`.
- **ffmpeg** — Tier2 container, `mode:mount`, transcode, return pointer.
- **build-worker** — esbuild hash-worker: `/src` → `/dist` pointer.
- **Artifacts versioner** — commit `live/` tree at checkpoints for fork/branch of
  session filesystems (see §5).
- **headless scraper** — Tier2 container, `exposePort` preview URL.
- **Workers-AI image-gen** — `kind:'cf-binding'`.
- **Workflows fan-out** — Tier3, durable map over an fs prefix.

---

## 5. Where Cloudflare Artifacts / artifact-fs fit (a plugin, NOT the primary fs)

The owner pointed at `github.com/cloudflare/artifact-fs` as a candidate unification
primitive. **It is not.** Verified June 2026:

- **artifact-fs** is a *git-backed FUSE lazy-clone driver* (Go daemon: blobless clone,
  on-demand blob hydration via `git cat-file --batch`, SQLite snapshot index, CoW
  overlay, 500ms refs watcher). Built for fast repo mounts in agents/sandboxes —
  **not** an R2 object-fs, not a Workers binding, not usable in a DO.
- **Cloudflare Artifacts** (closed beta, April 2026) is "versioned storage that speaks
  Git", built **on Durable Objects, not R2**, git-semantics-only, ops-priced
  (~$0.15/1k ops + $0.50/GB-mo), short-lived per-repo tokens, fork-from-any-commit.

So neither is the byte plane. **R2 is the byte plane.** But two useful things:

1. Artifacts' *internal architecture* — DO SQLite metadata authority + R2 bodies +
   overlay + reconcile — **validates exactly what Engram already shipped** in
   `host.fs`. We're on the right shape.
2. They become **optional plugins**: artifact-fs FUSE *inside* Tier2 containers for
   fast big-repo mounts; Cloudflare Artifacts (when its beta opens) as a per-session
   *versioning adapter* — mirror `fs/<doId>/live/` into a per-session Artifacts repo,
   commit at checkpoints → forkable/time-travelable session filesystems, plugged in
   through `engram.bind` like everything else. Do **not** make either load-bearing.

Full treatment in [`UNIFIED-FS.md`](./UNIFIED-FS.md).
