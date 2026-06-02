# Engram Code Provenance & Structural Introspection

Synthesis of four introspection reports (provenance supply chain, glue.js anatomy, committed-artifact audit, duplication & architecture). All claims cite the underlying findings.

## 1. Where this code came from — external vs original

### The engine is external; the shell is original
The live JavaScript engine is **not original code**. It is the external npm package **`quickjs-wasi@3.0.0`** (vercel-labs), pinned as a devDependency in `apps/kernel/package.json`. Everything Engram-original is the **host shell** around it:

| Original (Engram-authored) | Lines | Role |
|---|---|---|
| `apps/kernel/src/lib.rs` | 1576 | Rust DO shell (mutex, checkpoint, manifest SQL) |
| `apps/kernel/src/glue.js` | 2016 | JS host↔VM glue (the heap-snapshot logic) |
| `apps/cloud/src/glue.js` | 1596 | stale fork of the above |
| `apps/cloud/src/supervisor.js` | 797 | 64-shard supervisor DO |
| `apps/cloud/src/facet-kernel.js` | 273 | facet kernel |
| sdk / cli | 728 / 176 | client surfaces |

Build-time-only tooling (esbuild, binaryen, ws) and injected stdlib (lodash/dayjs/nanoid/uuid/zod/mathjs) are external but never ship as source — they are bundled or injected into the VM. The Rust side pulls `workers-rs 0.8` / `wasm-bindgen 0.2.121` via `worker-build`. `context/` submodules are uninitialized (`cmp` → "No such file or directory").

### The full supply chain (kernel — the clean path)
1. `quickjs-wasi@3.0.0` resolved into hoisted `node_modules`.
2. `prepare-wasm.mjs` resolves `quickjs-wasi/quickjs.wasm`, runs `wasm-opt -Oz` → `src/quickjs.wasm` (1.59MB → 1.45MB, byte-changed at char 10).
3. `prepare-extensions.mjs` copies `node_modules/quickjs-wasi/extensions/<n>/<n>.so` → `src/ext/<n>.wasm` (5 extensions).
4. All derived bytes are **gitignored** (`apps/kernel/.gitignore` lines 6-10; `git check-ignore` confirms) and rebuilt at deploy.
5. `entry.mjs` imports them as CompiledWasm; stdlib ships as Text; `lib.rs:40` binds glue at compile time via `#[wasm_bindgen(module = "/src/glue.js")]`.

### The kernel-vs-cloud WASM asymmetry (the central finding)
Kernel and cloud have **two independent provenance paths for the same engine**:

| | kernel | cloud |
|---|---|---|
| `quickjs-wasi` dependency | yes (`@3.0.0`) | **none** |
| engine source | derived from npm at build | **vendored, git-tracked bytes** |
| `quickjs.wasm` | gitignored, `-Oz` optimized, 1.45MB | tracked, **raw unoptimized 1,586,981 B** |
| delivery | CompiledWasm import + Rust wasm-bindgen | base64-bake (`bake-modules.mjs`) into a `{wasm}` Worker-Loader module for the facet |

Cloud has no `quickjs-wasi` dep, so it cannot derive — it vendors. The vendored ext `.wasm` are **byte-identical** to kernel's derived ext (cmp: all 5 IDENTICAL), proving the vendored bytes are the unmodified dist. The two engines differ only because kernel runs `-Oz` and cloud ships raw.

**Risk:** no version pin links the two paths → they can silently diverge. Both run third-party prebuilt binaries trusted as-is inside the sandbox, and cloud depends on an **undocumented** `{wasm}` Worker-Loader module type as its only facet delivery path.

## 2. Why `glue.js` is so big

`apps/kernel/src/glue.js` is **2016 lines / 99,768 bytes**. Three compounding structural reasons, in order of weight:

**(1) It is comment-dominated — 54% is prose.** 645 comment-only lines totalling **53,852 of 99,768 bytes (54.0%)**. This is an in-file, append-only changelog of every version and fix written inline instead of in `docs/`: version-tag mentions V0.9×17, V0.7×13, V0.8×11, V0.9.3×10, V0.6×6; BUG-1..6 ×17; GUARD/GAP/FEATURE ×33. Constants at lines 84, 95, 107 each carry a timestamped "V0.7 GUARD 3: lowered 45→18MB"-style note. Git can't show the accretion (squashed into one commit `ce4ffd0 "refactor: monorepo"`); it's provable only from these timestamped comments.

**(2) It is a host-program-plus-embedded-guest-program.** `REBIND_SRC` (glue.js:530-638, ~5,700 B backtick string) is a **whole second JS program** eval'd into the QuickJS VM — it rebinds `Date`/`Math.random`/`crypto`/`performance`/`console` and installs a recursive `__mkHostProxy`. More embedded guest snippets exist: `_scrubArena`'s alloc-loop string (1894-1897), `_drivePromise`/`finalInfo` eval strings (`__cellP`, `globalThis[...]` at 1201, 1684, 1709). Two languages live in one file.

**(3) Breadth, not depth — ~12 orthogonal subsystems, never modularized.** No single concern dominates; per-concern bytes: hostFnDefs 9,535 (680-883); guard constants 9,467 (60-181); GlueKernel ctor 6,431 (1082-1230); heap/scrub/dump 6,242 (1846-1991); REBIND_SRC 5,858; normalizeConfig 5,573; stdlib 5,488; restore 5,135; buildToolRegistry 5,025; evalCode 4,983; interruptHandler 4,949; header banner 4,414; replayJournal 4,283; 5 inline Error classes 3,389 (364-412); preview 3,104; determinism 2,455.

**Important caveat:** a module split is **purely cosmetic for the shipped artifact** — esbuild/wrangler bundle it into one file and JS stays JS, so neither bundle bytes nor worker language % change. Justify a split on maintainability only.

## 3. What is wrongly committed and should be build-derived

The repo tracks **10 binary/generated artifacts, all under `apps/cloud`** (~2.8MB). Kernel tracks **zero** — it is the clean model.

Tracked, under `apps/cloud`:
- `src/quickjs.wasm` (1,586,981 B)
- `vendor/ext/{crypto,encoding,headers,structured-clone,url}.wasm` (url 920,499 + crypto 187,423 + encoding ~13k + headers ~14k + structured-clone ~9.6k)
- `vendor/qjs-dist/{index,extensions,wasi-shim,version}.js` (~99,427 B)

**The foot-gun:** `apps/cloud/src/quickjs.wasm` was **force-added past the root `*.gitignore`'s `*.wasm` rule** (`apps/cloud/.gitignore` has no wasm rule; `git check-ignore -v` returns no matching rule yet the file is tracked → only possible via `git add -f`). A future rebuilt/different wasm could be silently skipped by `git add` and go un-updated, invisibly to `git status`.

**Internal inconsistency:** `bake-modules.mjs` reads `quickjs.wasm` from `src/` but reads `ext/` and `qjs-dist/` from `vendor/` — engine and extensions can drift independently, surfacing only as `EngineHashMismatchError` at restore rather than at build.

**Why it's committed-by-necessity (today):** cloud has no `quickjs-wasi` dep and cannot import the npm package at facet runtime, so the bytes must exist somewhere. They are not redundant *within cloud* until a dependency is added. So the right immediate fix is to make the vendoring **deliberate and consistent**, not to delete it.

## 4. The duplication and how to fix it

**The glue fork.** `apps/cloud/src/glue.js` (77,394 B / 1596 lines) is a near-strict subset of `apps/kernel/src/glue.js` (99,768 B / 2016 lines): Myers diff kernel→cloud is **8 insertions, 428 deletions**; `comm` shows **1,588 shared lines, 8 cloud-only, 428 kernel-only**.

**This is feature drift, not refactor noise.** The 428 kernel-only lines are real capabilities cloud lacks: `host.subLM` (`__hostSubLM`, `SubLMError`, `config.subLMEndpoint` POST), `host.final`, RLM `replayed++` accounting, and the fetch default `User-Agent: engram/0.9`. Critically, cloud is **missing the v0.9.3 GAP 1 native-alloc OOM backstop** (`NativeAllocLimitError` / `memoryLimit`) and parts of the v0.9 codemode surface — a real safety divergence between two deployed workers, not cosmetic.

**Other duplicates:** both apps independently carry `quickjs.wasm` + 5 ext `.wasm`, six byte-identical stdlib-src libs (dayjs/lodash/mathjs/nanoid/uuid/zod all cmp-IDENTICAL; kernel also has `lambda.js`), and the ~99KB vendored qjs-dist.

**Why the fork exists (cannot be wished away):** two incompatible delivery mechanisms. Kernel binds glue at **compile time** (`lib.rs:40 #[wasm_bindgen(module="/src/glue.js")]` + `entry.mjs` CompiledWasm) and keeps the bare `import "quickjs-wasi"` (glue.js:60). Cloud **bakes** glue as a JSON-stringified source blob into `modules.gen.js` and rewrites the import (`from "quickjs-wasi"` → `from "./qjs/index.js"`) for in-facet delivery.

**How to fix (ordered):**
1. **Reconcile drift first** — port the 428 kernel-only lines (esp. v0.9.3 `NativeAllocLimitError`/`memoryLimit`) into cloud so the two become byte-reconcilable. Audit the 428-line diff for *intentional* cloud divergences (per-tenant gateway/deny-default) before merging.
2. **Extract a source-level shared package** (`packages/kernel-runtime`) holding glue + shared stdlib-src + wasm/ext. It MUST stay a **source file**, not a runtime npm import — kernel's `#[wasm_bindgen(module=...)]` needs a real on-disk path. Keep the bare `quickjs-wasi` import; let cloud's bake regex do the rewrite.
3. **Wire both builds to the one file** — kernel via symlink/path-stable copy; cloud's `bake-modules.mjs readFileSync` repointed.
4. **Redeploy + verify both** with a real evict→cold-restore.

**Snapshot-invalidation hazard (governs everything above):** `codeId`/engine-hash is computed over glue bytes (`bake-modules.mjs h.update(glue)`). **Any reformat that shifts bytes invalidates every live snapshot via `EngineHashMismatchError`** → cold-session loss. A pure byte-preserving move is safe; a reformat is a breaking redeploy.

## Prioritized action table (value-to-risk order)

| # | Action | Why | Repo / % impact | Deploy-safe? | Effort |
|---|---|---|---|---|---|
| 1 | Port v0.9.3 GAP 1 (`NativeAllocLimitError`/`memoryLimit`) + v0.9 codemode into `apps/cloud/src/glue.js` | Cloud is **missing the uncatchable-OOM backstop** that protects a deployed worker — a correctness/safety hole, not cosmetics | Closes safety gap on engram-cloud; touches ~part of the 428-line drift | No (adds behavior to engram-cloud; needs smoke + restore verify) | M |
| 2 | Move version/BUG/GUARD changelog prose out of inline comments into `docs/`, leave 1-line rationale + doc pointer at each constant | 54% of glue.js (53,852 B) is prose that can contradict live constants (stale 45MB/30000-tick narrative vs current 18MB/1200) | Cuts glue.js comment mass well below 54%; code becomes scannable | **Yes** (comments only, no byte-load-bearing logic) | M |
| 3 | `git rm --cached apps/cloud/src/quickjs.wasm`; relocate to `apps/cloud/vendor/quickjs.wasm`; point `bake-modules.mjs` at `vendor/`; add explicit `!vendor/**` allow in `apps/cloud/.gitignore` | Removes the force-added-past-gitignore foot-gun; makes all cloud vendored bytes live in one deliberate dir; ends src-vs-vendor inconsistency | Removes ~1.55MB force-added blob from tracked `src/`; bytes unchanged → engine-hash stable | **Yes** (bytes identical; one readFileSync path + gitignore edit) | S |
| 4 | Split glue.js into modules under `src/glue/` (limits, determinism, rebind [quarantine ALL embedded-guest source], host-boundary, tools, stdlib, snapshot, config, kernel) as a **pure byte-preserving move** | ~12 orthogonal subsystems in one 2016-line file; makes kernel/cloud diffs per-file tractable | Maintainability only — **0% change** to bundle bytes / language % | No (REBIND_SRC ordering, host-fn re-register, EXTENSION_ORDER are load-bearing; gate on restore suite) | L |
| 5 | Extract `packages/kernel-runtime` (source-level glue + stdlib-src + wasm/ext); kernel via path-stable symlink, cloud bake repointed, keep bare `quickjs-wasi` import | Single source of truth; deletes ~77KB duplicate glue + 6 duplicate stdlib libs + duplicate wasm | Removes ~18-25% of counted glue-layer JS (~77KB of ~189KB) + dup stdlib/wasm | No (requires #1 done first; symlink vs Rust module-path fragility; redeploy both) | L |
| 6 | Commit a provenance manifest (`version` + sha256 per binary) and either add `quickjs-wasi@3.0.0`+`binaryen` to cloud devDeps to derive like kernel, or pin the vendor to a tag | No version pin links kernel-derived vs cloud-vendored engine → silent divergence; auditable third-party binaries | Eliminates ~2.8MB tracked cloud binaries if deriving; single engine source-of-truth | No (must pin `@3.0.0` for engine-hash stability or every cloud snapshot invalidates; confirm raw-vs-`-Oz` bytes before deleting) | M |
| 7 | Redeploy + verify both engram-kernel and engram-cloud with a real evict→cold-restore per app (gate for #4/#5/#6) | `codeId` hashes glue bytes — proves no `EngineHashMismatchError` regression from any byte-shifting refactor | Verification gate | No (high if glue bytes shift → live snapshot loss; schedule as breaking redeploy) | M |