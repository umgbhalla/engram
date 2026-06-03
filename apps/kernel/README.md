# apps/kernel-rust — Engram Rust kernel (cutover-ready)

The **rquickjs-Rust kernel** — the convergence target (decision B). Replaces the 2000-line hand-written
`glue.js` brain with Rust: eval, snapshot/restore, guards, determinism, host-boundary, and the W5/W4/E6
durability stack all run in Rust (borrow-checked). Only ~400 lines of JS remain as WASI/DO plumbing
(`src/kernel-glue.mjs`) — no business logic.

> **This is the cutover target, NOT yet live.** The live `engram-kernel` worker is still served by the
> JS kernel in `apps/kernel/`. Deploying *this* directory replaces it. The JS kernel is the rollback.

## Status — gate-proven on real Cloudflare (`docs/RUST-FINAL-GATE.md`)

```
   functional    24/24 parity with the JS kernel
   durability     W5 un-wedge · W4 byte-delta 12–18× fewer bytes · E6 oplog + engine-migration replay
   determinism    byte-identical snapshots (seeded clock/RNG from Rust)
   guards         interrupt budget · memory limit · buffer-growth tripwire (closes the adversarial gap)
   Tier-0         TextEncoder/Decoder · URL · structuredClone · Headers · crypto.subtle.digest(SHA-256)
   adversarial    80/81, ZERO breaches
   head-to-head   12.45× fewer durable bytes · 18% smaller bundle · p50 +33ms (sub-second) vs JS
```

## Architecture

```
   Rust DO shell (workers-rs, src/lib.rs)         protocol · SQL · snapshot · mutex · checkpoint · AE
        │  imports
        ▼
   rquickjs engine (engine/src/lib.rs → wasm32-wasip1, CompiledWasm)
        eval · value-preview · guards · determinism · host.kv · Tier-0 bootstrap · W4 delta · scrub
        │  WASI imports satisfied by
        ▼
   src/kernel-glue.mjs (~400 lines JS)            WASI shim · memory.buffer blit · gzip · host.fetch
```

## Build / cutover

```bash
# build (engine wasm + worker)
cd apps/kernel-rust && node scripts/build-engine.mjs && npx wrangler@^4 deploy --dry-run

# CUTOVER (replaces the live engram-kernel — needs owner OK + a version anchor for rollback):
#   1. capture the live version id (rollback anchor)
#   2. npx wrangler@^4 deploy -c apps/kernel-rust/wrangler.jsonc
#   3. run the gate (tests/kernel-rust/*.mjs) against it; rollback to the anchor if any axis regresses
```

## Known gaps (non-blocking, tracked)

- `crypto.subtle` = SHA-256 `digest` only (other algos reject `NotSupportedError`).
- `URL` is RFC-3986-ish, not strict WHATWG (no IDNA/punycode edge cases).
- Deep C-stack recursion traps as WASM `unreachable` → wedges the checkpoint path; socket stays alive,
  **recovers via `reset` or reconnect** (the JS kernel recovers in-place with `RangeError`). Non-breach.
- `engram-cloud` still bakes the JS kernel; the facet model needs rewiring to the Rust engine post-cutover.

## Tests

`tests/kernel-rust/` — live-test (24/24), parity5, guard-probe, adversarial-fullgate, w4-verify, etc.
Run against a deployed scratch worker (never the live one).
