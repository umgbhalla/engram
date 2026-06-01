# montydyn Notebook UI — build report

**VERDICT: GO.** A real browser notebook/REPL over the codemode kernel is live at
**https://montydyn-ui.umg-bhalla88.workers.dev** (worker `montydyn-ui`). E2E smoke
**6/6 PASS** against the live `montydyn-v092` kernel (same protocol + RLM loop the page runs).

## What shipped (`ui/`)
- **Single Cloudflare Worker** (`ui/src/worker.js` + `wrangler.jsonc`) serving the SPA
  (`ui/src/index.html` as a Text module). No bindings, no build step. `/healthz` for smoke.
- **Vanilla SPA, zero deps.** Speaks the kernel WS protocol DIRECTLY from the browser
  (`/ws?id=<session>`, `{t:"eval"|"create"|"gen"|"evict"|"reset"|"setContext"|"final"}`).
  Browser `WebSocket` is native — no `node:http` bridge needed (the SDK's bridge is only for
  co-located Node; the cooperative subLM RLM loop runs fully against the REMOTE kernel).
- **Cells** (Shift+Enter to run, run-all, add/delete), with **console.log capture**, structured
  **value preview**, and per-cell **error rendering**.
- **Persistence/hibernation indicator** (header pill): `gen` op drives a warm/cold dot —
  green "warm (in-memory)" vs amber "cold (snapshot)"; each cell's meta line shows
  `cold-restored (sqlite-restore)` vs `warm` + snapshot gz size.
- **Session id** in the config panel, persisted to `localStorage` → **state survives reload**
  (same id resumes the hibernated heap). Buttons: new session, reconnect, **Hibernate**
  (force-evict, snapshot kept), Reset.
- **Config panel:** clock (seeded/system), RNG seed, stdlib modules (`true`/CSV), fetch
  allowlist (`true`/`false`/CSV). "Apply config" spins a fresh session id so config takes on a clean heap.
- **RLM panel (needle-in-context):** paste a haystack + query → `run rlm()` or `lambdaRLM()`.
  Chunks `host.ctx`, fans `host.subLM` per chunk through a **client-side regex-grounded leaf
  oracle** (no external LLM needed for the demo), reduces, `host.final` → shows **FINAL**.

## Smoke (`ui/smoke.mjs`, live `montydyn-v092`)
Replicates the page's exact protocol + RLM loop via a Node `ws` client:
```
PASS eval counter -> 1
PASS closure inc() -> 2
PASS after evict+reconnect inMemory=false (cold) gen=1
PASS state restored: inc() -> 3 (expect 3, no replay)
PASS eval cold-restored (restoreSource=sqlite-restore)
PASS RLM FINAL needle: Found: the code is ZEBRA-7741 (subLM calls=2)
6 passed, 0 failed
```
Plus `GET /healthz` → `{"ok":true,"app":"montydyn-ui"}` and the page serves the notebook HTML.

## Notes / gotchas
- The page defaults to the **v092** endpoint (`/ws?id=`). It auto-detects **v12**: enter an API
  key and/or a `-v1x` endpoint → it switches to `/connect?session=&apiKey=`. v12 requires a
  minted tenant key (admin route), so v092 is the zero-config default for the live demo.
- The needle demo's leaf oracle is a deterministic **regex grounder**, not a real LLM — it
  proves the RLM orchestration (chunk → subLM → reduce → FINAL) end-to-end without keys. Swap
  `clientSubLM()` for a real model fetch to use a live backend.
- `lambdaRLM()` needs the in-VM `lambda` module (default when `modules=true`); the panel guards
  and tells you to Apply config on a fresh session if absent.
