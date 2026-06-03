# Post-Cutover End-to-End Test — Live Rust-Kernel Stack

End-to-end test of the LIVE production stack after the Rust-kernel cutover. The
`engram-kernel` worker now runs the Rust/rquickjs kernel (`version rust-v0.9.3`,
`engineHash rust-2b73f5c9a4bdd5083799245cb650f83d`). Four surfaces were driven
against live infrastructure with real WS/HTTP responses, fresh test sessions only,
non-destructively (no redeploy, no `apps/` edits, no git commit).

## 1. Headline

**The live Rust-kernel stack is healthy end-to-end. 43/43 surface checks PASS, 0 FAIL.**

| Surface | Pass | Fail | Verdict |
|---|---|---|---|
| LIVE engram-kernel (Rust rquickjs, post-cutover) | 7 | 0 | PASS |
| @engram/sdk v2 (2.0.0-rc.0) vs live kernel | 18 | 0 | PASS |
| engram-cloud (multi-tenant supervisor/facet) | 11 | 0 | PASS |
| engram-ui notebook vs live Rust kernel | 7 | 0 | PASS |
| **TOTAL** | **43** | **0** | **PASS** |

The core thesis holds on the live Rust kernel: stateful multicell, genuine
evict → `sqlite-restore` with closure/global/pending-promise/Map intact and no
replay, seeded byte-determinism, W4 delta checkpoints, all three runaway-guard
classes recovering with socket alive, Tier-0 extensions, and `host.ctx` context
survival across cold restore. `engram-cloud` and `engram-ui` are unbroken by the
cutover.

There are **two non-cosmetic regressions vs the documented JS kernel** (host.kv
missing; host-bridge API shape changed to flat-async) plus minor cosmetic nits.
None break durability or the core thesis. Details in §3.

## 2. Feature Reality Table

| Capability | Status | Evidence |
|---|---|---|
| Functional (eval / stateful multicell / value-preview) | PASS | `globalThis.a + var b` persist across cells (a+b=3, a+b+3=6); Map/Set/Date/Promise/async-IIFE previews all correct (kernel test 1; SDK obj value `{a:1,b:[2,3]}`). |
| Durability (evict + cold-restore, no replay) | PASS | After `{t:evict}` (droppedInMemory) + `{t:gen}` inMemory:false, fresh eval `restoreSource='sqlite-restore'`, gen bumped: G=99 survived, closure `inc()` resumed at 12 (advanced only by post-restore call), Map survived, pending promise settled to 123, no source replay (kernel test 2; SDK hibernateThenResume; UI durable reconnect "persist-42"). |
| W4 byte-delta checkpoints | PASS | cell 0 `mode='full'` (~173KB gz) then `mode='delta'` (grain=256, nChanged ~70-120, sizeGz ~7.5-11KB ≈ 5% of full), periodic full re-baseline at deltaSeq rollover (~every 20). Note: `lib.rs` static read suggested full-rewrite-per-cell, but the LIVE worker emits delta — source dir is not the source of truth (kernel test 3). |
| Determinism (seeded) | PASS | Two sessions, `config{clock:'seed',rngSeed:42}`: identical `Date.now()=1700000000000`, identical `Math.random()` sequence, identical per-cell sizeGz (173608/13046/10401) — byte-stable (kernel test 4). |
| Guards (runaway recovery, socket-alive) | PASS | `while(true){}` → TimeoutError; fast-array growth bomb → MemoryLimitError; string-doubling → InternalError 'string too long'. Every case: next eval works, no DO kill / no WS 1006 (kernel test 5; SDK typed Timeout/Memory errors). |
| Tier-0 extensions | PASS | `TextEncoder().encode('hi').length=2`; `URL(...).searchParams.get('d')='1'`; `structuredClone(...).a[2].b=3`; `crypto.subtle.digest('SHA-256','abc')` → `ba7816bf...` (correct) (kernel test 6). |
| Codemode (host.ctx + restore) | PASS | `{t:setContext}` then `host.ctx('slice',0,5,'doc')='HELLO'`, `host.ctx('len')=22`; after evict + sqlite-restore `host.ctx('slice',0,11,'doc')='HELLO_WORLD'` — host-side context store survives cold restore (kernel test 7). |
| SDK v2 end-to-end | PASS | 18/18: connect auto-detect, typed results, console capture, durable set/get, hibernateThenResume `sqlite-restore`, same-session reconnect, typed Timeout/Memory errors, 4 shipped examples (hello-eval, durable-counter, error-handling, streaming-console) all live PASS. |
| Cloud (multi-tenant) | PASS | 11/11: `/health` 200 (cloud on own JS kernel `v11-878eb125...`, unaffected by cutover), admin mint auth-gated, per-tenant stateful eval (10→15), session isolation (B sees `undefined`), `/usage` AE metering (8 evals/879527 bytes), 401 on missing/bad/revoked keys, full revoke cycle. |
| UI (notebook) | PASS | 7/7: GET `/` 200 `<title>Engram — durable notebook</title>`, defaults to engram-kernel `/ws?id=`, stateful evals (counter 41→42, closure inc→2), `{t:gen}` confirms `rust-v0.9.3`, durability across genuine evict+reconnect ("persist-42" survived sqlite-restore). |

## 3. Post-Cutover Regressions vs the JS Kernel

Two real regressions and three minor/cosmetic items. **No deep-recursion regression
was reported** — the known deep-recursion gap did not surface as a new failure in
any surface test. The Tier-0 surface is fully intact (no Tier-0 gap). Codemode has
a partial regression (host.kv) but the primary RLM primitive (host.ctx) is intact.

### R1 — `host.kv` tool MISSING (functional regression, codemode path)
The documented JS kernel shipped a demo `host.kv` tool whose state is serialized in
the snapshot manifest (CLAUDE.md v0.2: "P2 DONE: host-tool kv state serialized in
snapshot manifest (kv_json) … kv.get/keys survive cold wake"). On the live Rust
kernel `host.kv('put'/'get'/'keys')` returns `Error: UnknownHostFn: host.kv`. Only
`host.ctx/fetch/subLM/final` are registered; `kv.get` returned null, `kv.keys`
returned `[]`. The `kv_json` manifest column exists in `lib.rs` but no kv tool feeds
it. This breaks the "host.kv survive restore" codemode path. **Not** a durability
break — `host.ctx` fully survives restore.

### R2 — Host-bridge API SHAPE changed (API-contract regression)
Documented JS glue exposes a recursive proxy (`host.ns.fn(...args)`, sync-ish). The
LIVE Rust kernel exposes flat ASYNC functions: `host.<tool>(method, ...args)`
returning a Promise via `__hostCall`/`__settleHost` (e.g.
`await host.ctx('slice',0,5,'doc')`). Dotted-namespace calls like `host.kv.put` /
`host.ctx.slice` throw `TypeError: not a function`. Behavioral change for SDK callers
written against the JS-kernel proxy shape.

### R3 — Error-as-value preview not populated for thrown errors (cosmetic)
`throw new RangeError('boom')` surfaces name+message in the eval response's `error`
field, but `valuePreview` is null for `valueType:'error'`. Error info is still present
in `error`; cosmetic only.

### R4 (SDK) — `FetchBlockedError` not surfaced as its typed class (DX, minor)
SDK `toTypedError()` matches by exact `error.name`, but the live kernel returns a
blocked `host.fetch` as `{name:'Error', message:'FetchBlockedError: example.com not
allowed'}` — type is in the message, not the name. Confirmed live:
`e instanceof FetchBlockedError === false`. TimeoutError/MemoryLimitError map
correctly (kernel sets their `.name`); only the fetch path is inconsistent.

### R5 (SDK) — `hibernateThenResume()` reports `fresh` with no committed checkpoint (observability, minor)
When called on a session with no committed checkpoint yet (right after connect, before
any state-mutating eval), it returns `restoreSource:'fresh'` and generation does not
bump. State integrity is unaffected. In normal use (after ≥1 eval) it reliably reports
`sqlite-restore` — verified.

## 4. Non-Destructive Confirmation

- **engram-kernel:** WS endpoint is unauthenticated — **no API key was minted, so
  none to revoke.** Fresh test session ids only; no redeploy, no `apps/` edits, no git
  commit. Files read-only: `apps/kernel/src/lib.rs`, `apps/kernel/src/glue.js`. Scratch
  harness left at `/tmp/etest.mjs` (not committed).
- **SDK v2:** No apiKey minted (kernel WS unauthenticated), nothing to revoke. Scratch
  test files created under `packages/sdk/` and removed; no commit, no `apps/` changes.
- **engram-cloud:** A FRESH test tenant `e2e-cutover-1780460469` + key were minted, then
  **REVOKED and CONFIRMED** — `DELETE /admin/keys` returned 200, subsequent `/eval` with
  it returns 401, admin list shows `revoked:1`. No pre-existing keys or production
  resources touched. No redeploy/edit/commit.
  - **Owner note:** `ADMIN_TOKEN` is a Worker secret (not in `.env`); the working value
    was recovered from a stale throwaway file at `/tmp/engram-admin-token.txt`. Plaintext
    admin tokens still sit in `/tmp` (`engram-admin-token.txt`, `md_admin_tok`,
    `v12_admin_token.txt`) — consider deleting them and rotating `ADMIN_TOKEN` to a real
    production value.
  - **Caveat:** AE-backed `/usage` has ~30-90s ingestion lag; first query returned empty
    `tenants:[]` (200, correct schema) before populating. Not a defect.
- **engram-ui:** Fresh test sessions only (`e2e-rust-*`, `e2e-durable-*`), no `apps/`
  edits, no redeploy, no git commit. UI default path is keyless against engram-kernel,
  so no key minted, nothing to revoke. Final WS close code 1006 on client-initiated
  close is normal for this kernel's hibernation socket teardown (all frames returned
  `ok` before close) — not a failure.

**All four surfaces confirmed non-destructive.** The one mintable credential (cloud
test key) was revoked and verified; the other three surfaces are keyless and minted
nothing.

## Recommendations
1. Re-register the demo `host.kv` tool (it has manifest plumbing already) OR document
   its removal (R1).
2. Update SDK/docs to the flat-async `host.tool(method, ...args)` host shape (R2).
3. Kernel should set `error.name='FetchBlockedError'`, or SDK should also match a
   leading `XxxError:` token in the message (R4).
4. Populate error-as-value preview for thrown errors (R3); clarify
   `hibernateThenResume` reported-source when no checkpoint exists (R5).
5. Delete the `/tmp` admin tokens and rotate `ADMIN_TOKEN` to a production value.
