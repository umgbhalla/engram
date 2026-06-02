# Engram — Product State

_As of 2026-06_

> Formerly montydyn (renamed to Engram on the rebrand). The heap snapshot IS an engram.

## What Engram IS now

A **durable, multi-tenant codemode REPL**: a sandboxed JavaScript execution kernel that runs untrusted/agent-authored code with persistent, hibernatable state — exposed as a notebook UI, an SDK, a CLI, and an HTTP/WS API.

Capabilities, end to end:

- **Kernel.** QuickJS (WASM) on Cloudflare Durable Objects. Stateful multi-cell sessions: heap persists across evals; closures, namespaces, and >1MB host context survive. Deterministic mode (seeded clock + RNG). Tier-0 web extensions (structuredClone, TextEncoder, crypto.randomUUID), stdlib modules (e.g. lodash), fetch allowlist.
- **Durable hibernation.** Sessions snapshot to SQLite/R2 and cold-restore on demand (`restoreSource=sqlite-restore`). State survives eviction and reload byte-for-byte. Engine-migration journal (v0.9.3): on engine-hash mismatch, replays per-cell sources instead of bricking (best-effort; faithful for pure cells, effectful cells flagged).
- **Hardening / isolation (v0.9.3).** Native-C giant-alloc backstop (dlmalloc malloc-limit, 16MB live-heap ceiling) catches OOM as a catchable typed error before `memory.grow` can crash the DO — the prior WS-1006 hole is closed. Loop preemption keeps the socket alive. Bad-facet isolation verified: bombs on one facet do not disturb same-shard neighbors or cross-tenant sessions.
- **Auth + metering.** Per-tenant API-key auth (admin minting route); Analytics Engine usage metering (`/usage`: evals, facetPeak, sessions).
- **Multi-tenant scale (v12).** 64-shard / 128-facet-per-shard supervisor routing (FNV-1a). HTTP `/eval` data-plane. Clean typed rejection at cap (no crash).
- **lambda-RLM.** Recursive-language-model needle-in-context orchestration (chunk → subLM → reduce → FINAL) over host context, in-VM and via SDK.
- **Agent mode, SDK, CLI, UI.** `@engram/sdk` (Node, with `node:http` bridge); `engram` CLI; and a zero-dep browser notebook UI speaking the kernel WS protocol natively.

## Deployed surface (post-rebrand)

| Surface | URL / artifact | Kernel |
|---|---|---|
| Notebook UI | https://engram-ui.umg-bhalla88.workers.dev | defaults to engram-kernel; can target engram-cloud |
| kernel (from v0.9.3/) | https://engram-kernel.umg-bhalla88.workers.dev | codemode + RLM + hibernation + native backstop + journal |
| cloud / multi-tenant (from v1.2/) | engram-cloud | v1.1-parity, sharded, auth, `/eval`, `/usage` |
| SDK / CLI | `@engram/sdk` + `@engram/cli` (NOT yet npm-published) | — |

## Operating envelope (numeric)

- **Eval latency:** p50 ~255ms; UI warm evals ~220–300ms. Tail p99 ~3–4.4s (cold-facet WASM instantiate).
- **Throughput:** linear to ~146 evals/s at 150 concurrent sessions; 0% error rate, 100% state-correctness at 80/120/150.
- **Live heap ceiling:** 16MB per cell (below 18MB dump ceiling, above ~7MB stdlib envelope); larger working sets must chunk across cells.
- **Host args:** 8MB inbound/outbound cap; `host.ctx.slice/get` capped at 1MB.
- **Routing caps:** 64 shards × 128 facets; cap hit returns a typed rejection.
- **Snapshot:** ~740KB gz for a typical warm session.

## Remaining gaps for GA (honest list)

1. **npm publish** — SDK/CLI built but not published; needs owner OK on package ownership/naming.
2. **Scale at 1000s** — verified to 150 concurrent; behavior at 1000s of concurrent sessions and full 64×128 saturation under sustained load is unproven.
3. **Python kernel** — JS-only today; a second language runtime is a roadmap item, not built.
4. **Docs site** — internal result docs exist; no public docs/quickstart/API reference site.
5. **P1 lambda bug** — `lambdaRLM()` returns wrong answer for single-leaf (≤4000-char) contexts (`v0.9.2/stdlib-src/lambda.js`, mirror in SDK). Fix is small (normalize initial handle bounds) but currently ships broken.

### Carried risks
- Engine-migration journal is **best-effort**: effectful cells (network/kv/entropy) cannot replay faithfully and are flagged; heap-snapshot remains the real durability mechanism.
- Effectful-cell detection is a conservative host-side substring scan (no JS parser in the Rust DO) — may over-flag; affects honesty flag only, not recovery.
- v12 runs the v1.1-parity kernel which predates the v0.9.3 native-error relabel — its bombs surface as `InternalError`/`MemoryLimitError` (still catch cleanly, facet alive). Relabel + journal are v093-specific.
- `{t:engineBump}` is a test-only hook; real engine upgrades detected via build-time `quickjs.wasm` SHA-256.
- v12 `ADMIN_TOKEN` was rotated to a throwaway test value during scale testing and remains set to it (gates admin minting only; no functional impact).
