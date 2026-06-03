# RLM-STRIPPED — Slimming the Rust Kernel to a Pure REPL Core

> **Headline:** The entire RLM / codemode host surface (`host.subLM` · `host.ctx` · `host.final` ·
> `host.finalVar` · the lambda-RLM combinator stdlib · the `setContext`/`final`/`stdlib` DO frames and
> their `ctx_chunks` SQLite store) is **gone from the live `engram-kernel`** — `src/lib.rs` dropped
> **114 lines (1099 → 985)**, the stdlib bundle lost the `lambda` key (**−3 558 source bytes**, 7 → 6
> keys; meta 6 → 5 modules, totalBytes 838 539 → 834 981), and the slimmed RLM-free build was
> **redeployed LIVE and passed full core e2e** (REPL + durability + guards + host.fetch + Tier-0
> extensions all green; every RLM frame and host-fn now errors cleanly with the socket alive).

## What was removed

**Rust DO frame router + SQL (`apps/kernel-rust/src/lib.rs`):**
- Frame routes deleted: `{t:setContext}` (host.ctx store), `{t:final}` (host.final/finalVar report),
  `{t:stdlib}` (stdlib-info/rlm frame).
- Method `set_context_critical()` (host-side ctx persistence) deleted.
- `wasm_bindgen` externs dropped: `setContext`, `getContextJson`, `finalInfo`, `stdlibInfo`.
- SQL: `ctx_chunks` table CREATE removed; `snap_manifest.ctx_n_chunks` ALTER column removed; all
  `ctx_chunks` INSERT/DELETE removed from checkpoint (delta + full-base paths) and reset; `ctxJson`
  read removed from dump; `read_ctx_json()` deleted; `Manifest.ctx_n_chunks` field + its SELECT
  column + serde Row field removed.
- `replayJournal` call dropped its 4th `ctx_json` arg (now 3: journal, config, kv); `restore_w4`
  call dropped its trailing `ctx_json` arg (now 9) — fixing a pre-existing arg-count mismatch.

**Stdlib bundle / meta:**
- `src/stdlib.bundle.txt`: deleted the `lambda` key (lambda-RLM SPLIT/MAP/REDUCE combinator IIFE, ~3 558 bytes).
- `src/stdlib-meta.js`: removed `lambda` from modules/sizes/versions; updated `totalBytes`.

**Already-removed earlier on this branch (verified, not re-done):**
- `engine/src/lib.rs` RLM host bindings (`host.subLM`/`ctx`/`final`/`finalVar`) — BOOTSTRAP host Proxy
  now marshals **only fetch**; `kv_export`/`kv_import` are inert `{}` stubs.
- `kernel-glue.mjs` `_serviceHostCall` handles **only fetch** (subLM/ctx/final/finalVar/kv callbacks gone);
  `host.fetch` impl (`_doFetch`) + allowlist KEPT.

## Size / line reduction

| Metric | Before | After | Δ |
|---|---|---|---|
| `src/lib.rs` lines | 1099 | 985 | **−114** |
| stdlib bundle keys | 7 | 6 | −1 (`lambda`) |
| stdlib `lambda` source bytes | 3 558 | 0 | **−3 558** |
| stdlib-meta modules | 6 | 5 | −1 |
| stdlib-meta totalBytes | 838 539 | 834 981 | −3 558 |
| Worker upload (gzip) | — | **720.63 KiB** | (1997.53 KiB raw) |
| Worker startup | — | **15 ms** | |

Engine rebuilt: `ENGINE_HASH = rust-e307f9e70b190575209f942f992ef2f4`.

## Slim kernel core surface (what remains)

Frame router arms: **`create` · `eval` · `ping` · `gen` · `reset` · `evict` · `health`** (+ test-only
`_forceEngineMismatch` E6 hook).

Kept intact and verified:
- **Eval** (async, fetch pump) + stateful REPL namespace + structured value preview + per-cell `console` capture.
- **Durability:** W5/W4/E6 snapshot/restore (dump/dumpW4, restore/restoreW4, delta chain, oplog
  engine-migration replay).
- **Guards:** interrupt budget, buffer-growth tripwire, used-heap size-admission, `scrub_arena`.
- **Seeded determinism:** `Date.now`/`Math.random`/`performance.now`/`crypto` LCG.
- **Tier-0 web extensions:** `TextEncoder`/`Decoder`, `URL`, `structuredClone`, `Headers`, `crypto.subtle` SHA-256.
- **host.fetch** egress + allowlist.
- **General pure-JS stdlib:** lodash / dayjs / nanoid / uuid / zod default, mathjs opt-in.

## Live redeploy result

Deployed `apps/kernel-rust` (RLM-stripped) to **LIVE `engram-kernel`**
(`https://engram-kernel.umg-bhalla88.workers.dev`):
- New version id `d49a9360-5474-4636-b2d6-4603febd20ad`; **rollback anchor** (prior live)
  `75de2e56-cb1a-4aac-839f-e45252e116a6` (captured before deploy).
- `/health` → **HTTP 200 `ok`**. Upload 1997.53 KiB / **gzip 720.63 KiB**. Startup 15 ms.
- Bindings: `KERNEL_DO` (DO) · `SNAPSHOTS` (R2 `engram-snapshots`) · `AE` (`engram_kernel`).
- Build: wasm-pack compile + wasm-opt + esbuild OK (one benign `Manifest.epoch` dead-code warning).

## Core e2e on live (all PASS)

- **Core REPL:** `create` (clock/rngSeed/capture) → gen 1, `fresh`; `x=42`, stateful `inc()→43`,
  cold second session `inc()→43`; object value preview (`valueType=object`); console capture
  (`console.log('hello',1+1)` → `hello 2`); **Tier-0 globals all functional** (crypto.randomUUID /
  TextEncoder / URL / structuredClone / Headers); **seeded determinism byte-identical** across two
  independent fresh sessions (`0.4932122668392295|1700000000000`).
- **Durability:** sim-evict (`inMemory=false`, `sqlite-restore`) AND **real 75 s cold wake** (gen 1→2,
  `sqlite-restore`) — global var + closure + awaited Promise value all survive, no replay.
- **Guards:** `while(true){x=1}` → typed `TimeoutError` ("cell exceeded the instruction budget"),
  socket alive, next eval `2+2=4` works.
- **host.fetch:** `host.fetch('https://example.com')` → real `{status:200,ok:true,headers,body}`
  (read via global; `await` cells return `null` at the trailing expression — pump behavior).
- **RLM surface REMOVED CLEANLY (both layers, no crash):**
  - Frame layer: `t:subLM` / `t:final` / `t:setContext` → `{ok:false, error:'unknown msg type <t>'}`.
  - Host-fn layer: `host.subLM(...)` / `host.final(...)` throw `UnknownHostFn: host.<name>`;
    `host.ctx` is `null` (`host.ctx.len()` → TypeError). Socket stayed alive through all RLM probes.

## Caveat

The live deploy was slimmed from `apps/kernel-rust`. The checked-in `apps/kernel/src/{lib.rs,glue.js}`
(the JS kernel, v0.9.3) **still contains the full RLM source** (subLM/final/setContext/host.ctx) and
does **not** match the deployed slimmed worker. `apps/kernel` (JS) and `apps/cloud` were untouched by
this work. No git commit was made for the strip.
