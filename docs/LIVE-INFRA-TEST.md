# LIVE-INFRA-TEST — functional test of deployed Engram production

Date: 2026-06-02. Method: black-box functional probes against the three live
deployed surfaces only — no redeploy, no source edits, no commits. Fresh/throwaway
session ids; one admin-minted tenant key (revoked at end). Every result below is
grounded in the actual WS/HTTP/JSON response observed.

---

## (1) HEADLINE

**Is the deployed production actually working end-to-end? YES.**

All three surfaces are live, reachable, and do what the README/docs claim. 24/24
functional checks PASS, 0 FAIL.

| Surface | Endpoint | Pass / Fail |
|---|---|---|
| engram-kernel (core durable hibernating QuickJS-WASM REPL) | `wss://engram-kernel.umg-bhalla88.workers.dev` | **7 / 0** |
| engram-cloud (multi-tenant SaaS) | `https://engram-cloud.umg-bhalla88.workers.dev` | **10 / 0** |
| engram-ui (notebook) | `https://engram-ui.umg-bhalla88.workers.dev` | **7 / 0** |
| **TOTAL** | | **24 / 0** |

Verdict: deployed production is **fully working**. The headline thesis — a durable,
hibernating, stateful JS REPL that sleeps and wakes with full live state and no
replay — is confirmed live: `survivor=12345` survived a genuine eviction
(`droppedInMemory:true`) and came back via `restoreSource=sqlite-restore`.

---

## (2) Feature-scope reality table

Claimed features map to README "What works today" scope; tested live, with the
cited response as evidence.

| Claimed feature | Tested on live? | PASS/FAIL | Evidence (actual response) |
|---|---|---|---|
| Stateful REPL, set+eval | yes (kernel) | PASS | `x=41`, `x+1` → `value=42, ok=true` |
| Live namespace across cells | yes (kernel) | PASS | `globalThis.dbl` defined in cell 1, `dbl(21)` in cell 2 → `42` |
| Evict + cold-restore, no replay | yes (kernel) | PASS | `t:evict` → `{droppedInMemory:true, generation:1, ok:true}`; next eval returned `12345` with `restoreSource=sqlite-restore` |
| Determinism (seeded clock + rngSeed) | yes (kernel, 2 sessions) | PASS | two fresh sessions, seed 99 → byte-identical `[1700000000002, 0.001138708321377635, 0.8175430877599865]` |
| Infinite-loop / budget guard | yes (kernel) | PASS | `while(true){}` → typed `TimeoutError "cell exceeded execution budget (1200 ticks / 5000ms wall)"`, socket alive, next eval `1+1` → `2` |
| `host.fetch` egress (allowlist) | yes (kernel) | PASS | `host.fetch('https://api.github.com/zen')` → `status 200, ok:true`, body 15 bytes `"Encourage flow."` |
| Configurable stdlib (lodash, dayjs) | yes (kernel) | PASS | `_.chunk([1,2,3,4],2)=[[1,2],[3,4]]`, `_.sum([1,2,3])=6`, `dayjs('2020-01-02').add(1,'day').format()='2020-01-03'` |
| Health / version endpoint | yes (cloud) | PASS | `/health` → `200 {ok:true, codeId:kernel-878eb125d17c403b, engineHash:v11-878eb125d17c403b}` |
| Admin key mint | yes (cloud) | PASS | `POST /admin/keys` w/ `x-admin-token` → `200`, raw `apiKey md_1cd2…` + hash (shown once) |
| Multi-tenant stateful eval | yes (cloud) | PASS | sess-A: `counter=40…counter+=2` → `42` (`fresh`, gen1); follow-up `counter+1+"/"+memo` → `"43/hello"` (`warm`, gen2) |
| Per-session isolation | yes (cloud) | PASS | sess-B `typeof counter+"/"+typeof memo` → `"undefined/undefined"`, `restoreSource=fresh` (no leak) |
| Auth enforcement | yes (cloud) | PASS | no key → `401 "missing API key"`; bad key → `401 "invalid or revoked API key"`; wrong admin token → `401 "admin auth required"` |
| Usage metering (AE-backed) | yes (cloud) | PASS | tenant `/usage` (after ~75s AE lag) → `evals:3, bytes:659490, facetPeak:1, activeSessions:2`; admin scoped view matches |
| Key revocation | yes (cloud) | PASS | `DELETE /admin/keys?apiKeyHash=…` → `200 {revoked:71908b…}`; revoked key then `401` on `/eval` (verified twice) |
| Notebook UI loads | yes (ui) | PASS | `GET /` → `200`, 21922 bytes, `<title>Engram — durable notebook</title>`, single self-contained inline ES module, 0 external assets |
| UI defaults to kernel + full connect controls | yes (ui) | PASS | `input#cfgEndpoint = wss://engram-kernel…`; Connect/Reconnect/Reset/new-session/Apply-config present |
| UI WS path E2E to live kernel | yes (ui) | PASS | `/ws?id=` → `{t:create}` → `ok:true, generation:1, restoreSource:fresh`; eval `x=42`→`42`, `x*10`→`420` (namespace persisted, `store:sqlite`) |

---

## (3) Regressions / gaps on live prod

**No regressions.** Nothing that worked in smoke failed on live prod. The full
documented feature scope reproduced against the deployed workers. Two items that
initially read as FAIL on the kernel surface were **strict-client-assertion
artifacts, not product failures**, confirmed on re-probe:

- **host.fetch valuePreview `{}`** — the eval reply's `valuePreview` was `{}`
  because of the documented cosmetic limitation where an async IIFE previews as
  `{}`. Re-probing by writing the fetch result to a global and reading it in a
  sync cell confirmed a genuine `200` from api.github.com with real body bytes. Not
  a regression — the value is real, only the preview is cosmetic.
- **lodash typeof check** — lodash binds as an **object**, not a function, so the
  client's `typeof === 'function'` assertion was wrong; `_.chunk`/`_.sum` and dayjs
  all execute correctly. Tester error, not a product fault.

Minor cosmetic observations (not failures, not blocking):

- **engram-cloud unfiltered admin `/usage`** lists a few spurious "tenant" rows
  (`timeout`, `setContext`, `error`, `eval` — all zero counts). Looks like AE
  blob-schema bleed where op-event blobs get mis-bucketed as tenant ids. Cosmetic;
  the tenant-scoped query is clean.
- **`/usage` AE ingestion lag** — first (immediate) call returned empty
  `tenants[]`; after ~75s it correctly reported the metering. This is the
  documented ~30–90s Cloudflare Analytics Engine lag, not a bug.
- **`/eval` is GET** (`?src=`) not POST as the task wording implied — functionally
  equivalent and works.

---

## (4) Non-destructive confirmation

Confirmed **non-destructive**:

- **Test key revoked.** The only credential minted — tenant
  `test-1780410386-12776`, key hash
  `71908b093f0500be6ccf8896e4979cf7033d1bf3699e5f63209924dff506ebaa` — was revoked
  via admin `DELETE /admin/keys` (`200 {revoked:71908b…}`) and verified rejected
  (`401`) on `/eval`, both before and after the 75s AE wait.
- **No other data touched.** No pre-existing tenant keys touched. Only fresh
  throwaway session ids used (kernel/ui: `uitest-…`; cloud: `sess-A-6841`,
  `sess-B-3158`). On the kernel surface no tenant key was minted at all (nothing to
  revoke there).
- **No deployment / code mutation.** No redeploy, no edits to `apps/`, no git
  commit. Temp test scripts under `.pi/` were removed.
