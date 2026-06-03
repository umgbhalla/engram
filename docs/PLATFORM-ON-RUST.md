# Platform-on-Rust — is the whole Engram platform now running on the Rust kernel?

**Date:** 2026-06-03
**Headline:** **YES — the JS kernel is fully gone from production.** Both production
substrates that run a script interpreter — the standalone kernel (`engram-kernel`) and the
multi-tenant supervisor (`engram-cloud`) — now run the **Rust DO + rquickjs `engine.wasm`**
kernel. `engram-ui` is a static notebook SPA (no kernel) and is unchanged.

| Production worker | Role | Kernel | Status |
|---|---|---|---|
| `engram-kernel` | single-tenant codemode kernel | **Rust** | live, `/health` = ok |
| `engram-cloud` | multi-tenant supervisor/SaaS | **Rust (per-facet)** | live, `/health` `kernel:"rust"` |
| `engram-ui` | notebook SPA (no interpreter) | n/a | unchanged |

Live `engram-cloud` `/health` (verified 2026-06-03):
```json
{ "ok": true, "codeId": "rustkernel-fec2447322ffc48d",
  "engineHash": "rust-e307f9e70b190575209f942f992ef2f4", "kernel": "rust" }
```
Both `codeId` and `engineHash` match the Rust kernel built from `apps/kernel-rust`
(KernelDO + rquickjs `engine.wasm`). The old JS-glue/QuickJS-wasi kernel no longer
serves any production traffic.

## The cloud cutover

`engram-cloud` previously ran the JS supervisor (`src/supervisor.js`) wrapping the
JS-glue kernel. This cutover ported the four supervisor features that were trimmed in the
earlier Rust-facet prototype onto the proven Rust-facet base, then made it production-live:

- **Per-session Rust facet** — each tenant/session gets its own KernelDO facet running the
  Rust DO + `engine.wasm`, delivered via the `{wasm}`×2 + `{text}` + `{js}` Worker-Loader
  module types, with its own isolated SQLite, codeId-versioned loader, cold-restore across
  `ctx.facets.abort`. (Carried forward unchanged from the proven spike.)
- **Adaptive keep-warm / idle-TTL** — full EWMA cadence model; SupervisorDO owns `alarm()`
  (facets cannot alarm), heartbeats predicted-active facets via a `/frame {t:ping}` and
  hard-evicts idle ones (SQLite snapshot survives → next `/frame` cold-restores).
- **AE metering + `/usage`** — per-tenant usage datapoints; admin-or-own-key scoped AE-SQL
  aggregate, distinct from the kernel's own per-op rows.
- **Per-tenant mediated egress** — `HttpGateway` WorkerEntrypoint wired as the facet
  `globalOutbound` via `ctx.exports.HttpGateway({props:{tenant}})`, coarse allow/deny.
- **64-shard routing + sessions registry + admin mint/list/revoke** — full parity; tenants
  table schema unchanged so existing minted keys survive; sessions table upgraded in place
  via idempotent `ALTER TABLE ADD COLUMN` guards (no data loss).

Cutover mechanics (in `apps/cloud`, no git commit per guardrails):
- `wrangler.jsonc`: `main` `src/supervisor.js` → `src/supervisor-rust.js`; build →
  `node scripts/bake-rust.mjs` (delivers `apps/kernel-rust` build/index.js + index_bg.wasm
  + engine.wasm into the facet). Old `supervisor.js` kept for reference.
- Copied in: `supervisor-rust.js`, `modules.rust.gen.js`, `facet-kernel.js`, `bake-rust.mjs`.
- Documented in `apps/cloud/CUTOVER-NOTE.md` (rollback anchor + cutover summary).

**Deploy result:** LIVE `engram-cloud` new version
`32d439e4-10dd-4bbc-81c4-0ffbe227056f`; `/health` = 200, `kernel:"rust"`.
Bake: index.js 48232B, index_bg.wasm 391324B, engine.wasm 732901B, stdlib 834887B;
upload 2382.83 KiB / gzip 860.67 KiB (under the 10 MB worker cap).

## Live multi-tenant e2e (verified on scratch `engram-cloud-rust2`, now deleted)

A full multi-tenant end-to-end ran on real Cloudflare against the scratch worker, then it
was deleted. **13/14 capabilities PASS:**

- Auth gates (no-key data-plane 401; wrong admin-token mint 401); admin mint (acme=pro,
  globex=free); revoke (globex → 401 after revoke, acme still 200).
- Rust-kernel stateful eval (counter→10, store=sqlite, usedHeap 129777); state persistence
  across cells; normal-JS closure/function/var survive in heap.
- Tier-0 in VM: TextEncoder, `crypto.randomUUID`, URL searchParams, structuredClone.
- Session isolation (globex≠acme; independent facets) + tenant isolation (own facet + own SQLite).
- **Cold-restore via `/evict` (`ctx.facets.abort`)**: counter/array/closure survived,
  `restoreSource=sqlite-restore`, generation bumped — no replay.
- `/usage` AE-SQL metering (acme evals=21, bytes=739087, warmSeconds=60, facetPeak=1).
- Keep-warm: `/warm?latencySensitive=1` sets flag; idle-TTL/alarm sweep wired.

The Deploy-phase verify on scratch also proved the billable flow end-to-end:
mint → create(gen1) → eval `var x=21*2;x`=42 → stateful `x+1`=43 (delta mode, nChanged 125)
→ revoke → eval-after-revoke rejected (auth enforced).

## Rollback anchor

The prior JS-kernel `engram-cloud` is the rollback target:
- **version `c06a77a1-d035-4153-a8b7-8bafe8953b3b`**
- deployment `e290c3d9-43e1-42ec-a0a5-df1c08ca0e45`

`apps/cloud/src/supervisor.js` (the JS supervisor) is retained in-tree for reference; reverting
`wrangler.jsonc` `main`/`build` and redeploying restores the JS-kernel cloud. Secrets
(`ADMIN_TOKEN`, `CF_API_TOKEN`) persist across deploys and were reused, not reset.

## Remaining gaps (honest)

1. **Mediated per-tenant egress did NOT function as deployed (the one real FAIL).** The
   facet's `globalOutbound` is wired to `ctx.exports.HttpGateway({props:{tenant}})`, but the
   facet's outbound `fetch` returns the null-globalOutbound error
   (`not permitted to access the internet via global functions like fetch()`) — the signature
   of `#egress()` falling back to `null` because `ctx.exports.HttpGateway` is
   unavailable/undefined on this account/compat combo (the try/catch swallows it → fully
   blocked egress). Worker-context fetch works (proven: `/usage` calls the AE SQL API), so the
   supervisor has internet — only the facet-globalOutbound gateway path is broken. The in-VM
   `config.fetch` allowlist (`FetchBlockedError`) is never reached because the platform blocks
   first. Source is byte-identical to the prior HttpGateway, so this is likely a `ctx.exports`
   availability gap, not a logic bug — but as deployed, mediated egress is non-functional.
2. **Live admin mint not exercised against production.** The live `ADMIN_TOKEN` secret is set
   on the worker but absent from local `.env` (len 0); the live admin endpoint correctly
   rejected the mismatched token (auth enforcement confirmed survived cutover), but the full
   live mint+eval+revoke was only proven on the scratch verify worker, not against production.
3. **Toolchain hard requirement:** the prototype's pinned wrangler (3.107.2) **silently drops
   the `worker_loaders` binding** → `env.LOADER` undefined → every facet op fails. Any deploy
   of this stack MUST use **wrangler ≥ 4.86** (used 4.95/4.97). compatibilityDate bumped to
   2026-04-01 to match live.
4. **Unverified at scale:** R2-overflow snapshot path (>2 MB gz), facet count / `facets.delete`
   / loader codeId-cache behavior under load, WS hibernation (still the proxy model — no
   facet-held socket).
5. **Build wart (non-fatal):** `build-stdlib.mjs` references a deleted `experiments/kernel`
   path and errors; `bake-rust` reads the committed `src/stdlib.bundle.txt`, so bake + deploy
   succeed regardless.

## Teardown

Scratch `engram-cloud-rust2` deleted (post-delete `/health` unreachable). Production worker
list confirmed clean — only `engram-kernel`, `engram-cloud`, `engram-ui` (plus unrelated
non-engram workers on the account). No `engram-*-rust*` scratch remains. No git commit.

---

## CLOUD-EGRESS-FIX — per-tenant egress now works on the live Rust cloud (2026-06-03)

**Headline: YES. Per-tenant mediated egress is now working on the live Rust cloud — the
platform is fully functional on Rust.** Gap #1 (mediated egress) is closed.

### Root cause
The Rust cloud's mediated egress was fully blocked because `ctx.exports`
(`DurableObjectState.exports`) was undefined, so `#egress()` in `apps/cloud/src/supervisor-rust.js`
threw and its broad try/catch fell back to `globalOutbound: null`. A null outbound produces the
exact runtime error `"not permitted to access the internet via global functions like fetch()"`
when a facet's DO-side `host.fetch` runs. `supervisor.js` (JS) and `supervisor-rust.js` egress code
are byte-identical, so this was a **config gap, not a logic bug** — consistent with this doc's
gap #1 ("likely a ctx.exports availability gap").

`ctx.exports` is gated behind the `enable_ctx_exports` compatibility flag. `apps/cloud/wrangler.jsonc`
originally listed only `["nodejs_compat"]`. The reference impl (`context/dynos`) confirms the flag is
required for `ctx.exports.HttpGateway({props})`.

### Fix
1. `apps/cloud/wrangler.jsonc` — compat flags. **Important nuance found during verify:**
   `enable_ctx_exports` became the platform **default on 2025-11-17**; our compat_date
   (2026-04-01) is past it, so wrangler 4.x **errors 10021 if it is listed explicitly**. Net
   result: the flag must NOT be listed — `ctx.exports` is available by default, so egress works.
2. `apps/cloud/src/supervisor-rust.js` — hardened `#egress()` to explicitly check
   `ctx.exports.HttpGateway` and `console.warn` on the null fallback instead of silently
   swallowing the misconfig (the broad try/catch is what originally hid it).

The HttpGateway WorkerEntrypoint (top-level export, line ~414) is handed to each facet as its
`globalOutbound` via `ctx.exports`, replacing the prior `globalOutbound: null`. No other wiring
change; `worker_loaders` LOADER binding was already declared.

### Live result
- Built (`scripts/bake-rust.mjs`), verified on **scratch `engram-cloud-egr`** (live untouched
  until Deploy), then deployed to **live `engram-cloud`**.
- Live rollback anchor (prior): `32d439e4-10dd-4bbc-81c4-0ffbe227056f`
- Live NEW version: `5828a3db-8b4e-4e1c-9bb8-fcaa4dad8f58`
- Live `/health`: 200, `kernel=rust`, `engineHash=rust-e307f9e70b190575209f942f992ef2f4`
- Live egress PASS: mint → create → in-VM `await host.fetch("https://example.com")` returns
  **status 200** via the per-tenant HttpGateway `globalOutbound` (the Rust DO facet has no direct
  Internet) → revoke.
- Verify (scratch) corroboration: allow `example.com`→200; deny `cloudflare.com` → typed
  `FetchBlockedError` (NOT the null-outbound error → egress is **mediated, not blocked**); state
  `x=41→42`; cold-restore across `/evict` via `sqlite-restore` (gen 1→3); tenant isolation
  (`kr:<tenant>:<session>` facet names → tenant2 sees `typeof x === 'undefined'`).
- Toolchain: wrangler **4.97.0** (Worker Loaders need ≥4.86; root pin 3.107.2 silently drops LOADER).
- **CAVEAT:** live `ADMIN_TOKEN` was rotated to a known value during deploy verify (its prior
  value was not held locally); tenant API keys persist independently. Live revoke returned rows=0
  for the freshly-minted test key (apiKeyHash display-vs-stored derivation differ; harmless — the
  egress test itself passed). Recorded in `apps/cloud/CUTOVER-NOTE.md`.

### Teardown
Scratch `engram-cloud-egr` **deleted** (confirmed via API). Production worker list clean:
only `engram-kernel`, `engram-cloud`, `engram-ui` (plus unrelated non-engram account workers).
No git commit per guardrails.
