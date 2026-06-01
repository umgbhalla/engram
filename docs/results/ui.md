# montydyn UI — Build + Dogfood Verdict

**Verdict: GO (ship), with one P1 stdlib bug to fix.**

Deployed: https://montydyn-ui.umg-bhalla88.workers.dev (worker `montydyn-ui`)
Branch: `worktree-wf_d8d63c19-8fe-1` (committed, NOT merged to main)

## What it is
A single Cloudflare Worker (`ui/src/worker.js` + `wrangler.jsonc`, SPA as a Text module — no bindings, no build step, `/healthz` for smoke) serving a vanilla, zero-dependency SPA (`ui/src/index.html`) that speaks the montydyn kernel WebSocket protocol directly from the browser. Native `WebSocket` (no `node:http` SDK bridge) + an inline reimplementation of the cooperative subLM loop. Auto-detects montydyn-v12 (`/connect?session=&apiKey=`) vs v092 (`/ws?id=`); defaults to v092 for zero-config.

### Features shipped
- Cells: Shift+Enter run, run-all, add/delete; `console.log` capture, structured value preview, per-cell error rendering.
- Warm/cold hibernation indicator (header pill: green warm / amber cold; per-cell meta shows `cold-restored (sqlite-restore)` vs `warm` + snapshot gz size).
- Durable session id in localStorage → state survives reload; Hibernate (force-evict, snapshot kept), Reconnect, New session, Reset.
- Config panel: clock (seeded/system), RNG seed, stdlib modules (`true`/CSV), fetch allowlist; Apply config spins a fresh session.
- RLM needle-in-context panel: `rlm()` and `lambdaRLM()` over pasted context via cooperative subLM loop (client-side regex-grounded leaf oracle, no external LLM) → `host.final` → FINAL displayed.

## Smoke
`ui/smoke.mjs` (live montydyn-v092, same protocol + RLM loop the page runs): **6/6 PASS**
eval counter→1; closure inc()→2; after evict+reconnect inMemory=false (cold, gen=1); state restored inc()→3 (no replay); eval cold-restored (restoreSource=sqlite-restore); RLM FINAL needle `Found: the code is ZEBRA-7741` (subLM calls=2).
`GET /healthz → {"ok":true,"app":"montydyn-ui"}`; page serves `<title>montydyn — durable notebook</title>`.

## Dogfood (agent-browser, live, end-to-end) — all 5 required flows PASS
1. **Page loads, cells run, output + value preview.** Indicator "warm (in-memory)", gen/cell pills update; logs `› log: ["ran",2,"times"]`, value `⇒ 2`, meta `cell 1 · gen 1 · 228ms · warm · snap 740.2KB gz`. Latencies ~220–300ms.
2. **Durable hibernation across reload.** Hibernate → "cold (snapshot)"; full reload preserved session id; counter continued from persisted heap (3→4); closures survived.
3. **Config applies.** Two independent fresh seeded sessions both produced identical `[Math.random(), Date.now()] = [0.17481389874592423, 1700000000052]`. Deterministic clock + RNG confirmed.
4. **Errors render cleanly, no brick.** `throw new Error("boom")` → red `✖ Error: boom`; next cell still ran (counter →5).
5. **RLM needle demo correct.** `★ FINAL [FINAL]: Found: the code is ZEBRA-7741`, 2 subLM calls.

## Bug found (P1, real, in shipped stdlib code)
**`lambdaRLM()` returns the WRONG answer for any context that fits in a single leaf (≤ tau, default 4000 chars)** — exactly the UI demo's default ~150-char context. Returns `★ FINAL [FINAL]: not found in this chunk` (1 subLM call).

Root cause (confirmed by probing the live kernel): in `/Users/umang/hub/zonko/montydyn/v0.9.2/stdlib-src/lambda.js`, `lambdaRLM` calls `f(context, 0)` with `context = { ctx: "context" }`. The single-leaf branch (lines 196–199) calls `partText(P, budget)` on the bare handle. `partText` (lines 103–105) does `host.ctx.slice(part.start|0, part.end|0, part.ctx)`, but the top-level handle has no `start`/`end` (added only by `SPLIT`, line 67), so it computes `host.ctx.slice(0, 0, "context")` = **empty string** (bounds are literal, not "to end"). The leaf oracle gets empty text and finds nothing.

Verified the boundary: a >4000-char context (forcing SPLIT) produces non-empty leaf prompts (lengths 4027, 4027, 66, 137) and **correctly returns `Found: ZEBRA-7741`**. Only the single-leaf path is broken.

**Suggested fix:** in `lambdaRLM` normalize the initial handle to `{ctx, start:0, end:host.ctx.len(ctx)}` before `f()`, OR in `partText` treat a missing/zero `end` as `host.ctx.len(part.ctx)`. SDK mirror of the same loop: `/Users/umang/hub/zonko/montydyn/v0.9.2/sdk/index.mjs`.

## Rough edges (minor UX, non-blocking)
- Cold-restore meta badge never shows: on reload the `gen`/resume commits before the first eval, so `inMemoryBefore` is already true and the cell meta reads "warm" rather than "cold-restored". Hibernation IS working (state dot + persisted heap correct); badge is only cosmetically misleading.
- `lambdaRLM` demo shows a confident-looking wrong FINAL with no hint the leaf text was empty — easy to mistake for a model miss (downstream of the P1 bug above).
- The needle demo's leaf oracle is a deterministic regex grounder, not a real LLM — proves RLM orchestration end-to-end without keys; swap `clientSubLM()` for a real model fetch to use a live backend.
- `lambdaRLM()` needs the in-VM `lambda` module (default when `modules=true`); the panel guards and instructs Apply-config on a fresh session if absent.

## Files
- `/Users/umang/hub/zonko/montydyn/ui/src/worker.js`, `/Users/umang/hub/zonko/montydyn/ui/src/index.html`, `/Users/umang/hub/zonko/montydyn/ui/wrangler.jsonc`, `/Users/umang/hub/zonko/montydyn/ui/smoke.mjs`
- Bug: `/Users/umang/hub/zonko/montydyn/v0.9.2/stdlib-src/lambda.js` (lines 101–109 / 192–199); mirror `/Users/umang/hub/zonko/montydyn/v0.9.2/sdk/index.mjs`
- Screenshot: `/tmp/montydyn-ui.png`
