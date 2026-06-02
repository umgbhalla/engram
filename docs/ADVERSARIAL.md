# ADVERSARIAL RED-TEAM REPORT — Engram durable hibernating kernel

**Date:** 2026-06-02
**Targets (scratch only):** `engram-adv-cur` (W5 full-base snapshot kernel) · `engram-adv-w4` (W4 byte-delta-chain kernel) · local Rust slice (`experiments/rustkernel/`, rquickjs wasm32-wasip1).
**Live workers (`engram-kernel` / `engram-cloud` / `engram-ui`): NEVER touched, no redeploy, `apps/` untouched.**
Both scratch workers run the same v0.9.3-lineage Rust DO + QuickJS glue; the *only* source delta is the snapshot/restore path (adv-w4 = delta chain + 45MB soft-restore ceiling; adv-cur = full base + hard 18MB dump reject).

## Headline

**ONE WORKER BREACH FOUND.** It is **not** a sandbox escape or data bleed — those held everywhere. The breach is a **whole-DO kill (WS-1006) on `engram-adv-w4` under cumulative heap pressure**, because the W4 delta-snapshot variant **dropped the 18MB `MAX_DUMP_BUFFER_BYTES` clean-reject guard** that `engram-adv-cur` still enforces. A session can be walked past the safe memory envelope into the documented ~256MB monotonic-buffer cliff and then killed unrecoverably. **W4 introduced new attack surface; the deployed-equivalent kernel (adv-cur, == engram-kernel lineage) does NOT have this hole.**

The Rust result is a separate finding: a **local rquickjs guard gap**, not a live-worker breach and not a claim about Rust as a language. The slice's 64MB `set_memory_limit` catches single oversized allocations, but does not bound cumulative sub-limit fast-array growth on wasm32-wasip1. Any Rust rewrite must carry an explicit linear-memory growth tripwire; Rust type safety does not replace guest-resource guards.

---

## Breach matrix (suite × version)

| Suite | engram-adv-cur (W5/full-base) | engram-adv-w4 (W4/delta) | Rust slice (local) |
|---|---|---|---|
| 1 — Sandbox escape (25) | SURVIVED 25/25 | SURVIVED 25/25 | SURVIVED (escape subset, clean) |
| 2 — Resource bombs (14) | SURVIVED 14/14 | SURVIVED 14/14 | SURVIVED 13/14, **1 LOCAL GUARD GAP** (array-alloc) |
| 3 — Snapshot/delta corruption (12) | SURVIVED (full-base subset) | SURVIVED 12/12 | SURVIVED (tamper blit-bounded; same-size flip UNTESTED tail) |
| 4 — Protocol/frame fuzz (46) | SURVIVED 46/46 | **BREACH** (WS-1006 cumulative heap, no 18MB reject) | n/a |
| 5 — Concurrency/isolation (11) | SURVIVED 11/11 | SURVIVED 11/11 | n/a |
| 6 — Rust-slice resilience (21) | n/a | n/a | SURVIVED 21/22 (= array-alloc guard gap above) |

Sandbox isolation, cross-session/cross-tenant isolation, SSRF blocking, protocol clean-reject, mutex serialization, and snapshot-corruption detection: **100% clean on every version.**

---

## Confirmed worker breach + local guard gap

### BREACH-1 (HIGH) — adv-w4 WS-1006 whole-DO kill via missing dump-size reject  [Suite 4]
**Severity: HIGH** (unrecoverable whole-DO kill; the explicit guardrail breach class).
**Where:** `engram-adv-w4` only. `engram-adv-cur` survives the identical attack with a typed `SizeAdmissionError`, socket alive.
**Mechanism (cited from suite 4 response):** A long fuzz session that includes a **9MB giant-source eval** is *admitted* (no size-admission rejection on W4), the WASM linear buffer grows to ~40MB and is snapshotted at mode full/delta. The **next** op (oversized host arg / 12MB frame) then triggers `CLOSED:1006` and a cascade of dead-socket replies. Root cause: **adv-w4 has NO 18MB `MAX_DUMP_BUFFER_BYTES` clean-reject** (`glue.js:19` on adv-cur), so it admits oversized images and climbs into the documented ~256MB monotonic-buffer unrecoverable cliff. WASM linear memory is monotonic → no recovery.
**Reproducibility:** cumulative only. Fresh-session isolation of each individual frame SURVIVES (so the per-frame protocol layer is sound; the kill is the heap walk).
**Note:** the v0.8 mid-cell used-heap tripwire (8MB grow / 16MB abs) DOES catch *incremental* allocations on both — 8× 20MB Uint8Array allocs all tripped `MemoryLimitError`, buffer stayed 1.6MB. The one path past it is a single large **string literal at parse time**, which is exactly the giant-source vector W4 fails to size-reject.
**Fix:** port adv-cur's 18MB `MAX_DUMP_BUFFER_BYTES` clean-reject into the W4 delta-snapshot path so oversized images are refused with a typed error instead of admitted into the cliff.

### GUARD-GAP-1 (MEDIUM locally / HIGH if shipped to workerd) — Rust slice cumulative fast-array growth bypasses native memory_limit  [Suite 6]
**Severity: MEDIUM locally / HIGH if shipped to workerd** (same monotonic-buffer DO-kill class if this design shipped without an additional tripwire).
**Where:** local Rust slice only (`experiments/rustkernel/`).
**Mechanism (cited):** `arr.push(new Array(1e5).fill(7))` drives WASM linear memory to the full **4GB wasm32 ceiling** (65528 pages, used_heap ~3.1GB) **before** rquickjs `set_memory_limit(64MB)` trips. This is not because Rust failed; the guard is QuickJS allocator accounting. On wasm32-wasip1, `malloc_usable_size` is unavailable, so QuickJS's runtime `malloc_size` limit can catch single allocations above the limit but does not reliably count cumulative sub-limit allocations. Locally Node grew to 4GB then threw a catchable `InternalError` (process survived, next eval works), **but on workerd the 128MB/1GB isolate cap means an UNCATCHABLE OOM / whole-DO kill long before**. The Rust slice has **no equivalent mid-cell linear-buffer tripwire** — the exact guard the JS kernel added in v0.8 to close this same resource-exhaustion class.

### (Not a breach, but logged) — UNTESTED tail risks
- **adv-w4 same-size in-place heap bit-flip** restore: all *exercised* tamper vectors were caught at gunzip before any blit; a same-length corruption that passes gunzip + chunk-count was not reachable (gzip is the integrity gate, no checksum). Untested, not a confirmed gap.
- **Rust slice reattach()** is a presence check only, no heap re-validation; same-size tampered image untested. Harness `writeStr` (`harness.mjs`) has **no bounds check** → latent host-side buffer overflow in the *reference harness* (not the kernel) — flag for any rewrite.
- **Mid-await `{t:evict}`** (Suite 5) does not acquire the eval mutex → a cell suspended on `await host.fetch` can be dropped mid-flight, silently swallowing its reply. **Fully recoverable** (socket alive, no kill, mutex not wedged, no bleed) so SURVIVED — but harden by making evict acquire the mutex.

---

## Version-resilience comparison

**cur (W5/full-base) vs W4 (delta-chain):**
- **Sandbox / isolation / protocol / concurrency:** byte-for-byte identical, 0 breaches. The W4 delta machinery does **not** touch the sandbox or host boundary (confirmed by git diff of `src/glue.js` / `src/lib.rs`: delta affects snapshot byte-delta + raised raw-restore ceiling only).
- **Did W4 introduce new attack surface? YES.** W4's snapshot variant **removed adv-cur's 18MB hard dump-reject** and replaced it with a 45MB soft-restore ceiling + W5 compaction. That single change is the entire delta between the two on resilience — and it is a **regression**: it opens BREACH-1 (the monotonic-buffer cliff DO-kill) that adv-cur is immune to. W4's *added* corruption-detection (`CorruptDeltaError`, delta-seq count guard) is sound and caught every delta-tamper vector, so the delta path itself is well-guarded against corruption — but its size-admission posture is weaker.
- **Verdict:** **adv-cur is the safer of the two deployed-equivalent kernels.** W4's byte-delta efficiency came at the cost of the size guard; it must re-add the 18MB reject before it could replace cur.

**vs Rust slice (rquickjs):**
- **What Rust actually changes:** at parity on the things that matter, modestly better on two implementation-risk axes, but not a substitute for runtime resource guards.
- Sandbox escape: **exactly as resistant** (same bare-QuickJS surface; host `nodejs_compat` never crosses into the VM).
- Structurally **safer** on: (1) single-shot allocations — native `set_memory_limit` catches a 200MB string cleanly where the JS kernel needs a JS-side tripwire; (2) host value-marshalling — Rust `coerce`/`json_str`, no `JSON.parse` of untrusted VM output crossing as code.
- Structurally **NOT safer** on the two production-relevant gaps unless those guards are explicitly rebuilt: (1) **monotonic-linear-memory incremental-alloc DO-kill** — same substrate exposure, and the Rust slice currently **lacks the mid-cell tripwire** the JS kernel already shipped (GUARD-GAP-1); (2) **workerd interrupt-throttle** — the JS kernel's real escape edge was workerd throttling the host interrupt callback after ~1.6k invocations/turn; the Rust slice's interrupt budget was only proven under local Node, **never under workerd**, so its budget-guard advantage is unproven on the real substrate. Borrow checker / type safety buy Rust-side implementation safety in host/kernel code, but guest-JS resource exhaustion still lives in QuickJS C and the WASM linear-memory envelope.
- **Verdict:** a Rust rewrite remains justified only on the trust/maintainability axis documented in `docs/RUST-MAXIMAL.md`; it does **not automatically close** the production resource gaps. To match v0.8 it MUST add: (a) a mid-cell `memory.buffer.byteLength` grow tripwire inside the interrupt handler, (b) snapshot manifest/checksum + used-heap admission, (c) the `writeStr` bounds check. This is a rewrite spec constraint, not a correction to any owner claim.

---

## Security verdict on the deployed-equivalent kernel

`engram-adv-cur` is the source-equivalent of the live `engram-kernel` lineage (v0.9.3, full-base snapshot, 18MB hard dump-reject).

- **Sandbox: SOLID.** No host reach (process/require/fs/node imports undefined or ReferenceError; `WebAssembly` entirely absent so no raw-bytes compile). The `__host*` bridge + `host` proxy are *visible and callable* in the VM via Function-escape, but that is the **intended JSON-mediated boundary**: calls return only JSON tool results scoped to this DO's own ctx; unknown/traversal prefixes return typed `{message:'unknown host tool: ...'}`; no host object is ever exposed. Prototype pollution works inside the VM (expected for a REPL) but cannot corrupt the host boundary (overriding `Object.prototype.__hostCall` only shadows in-VM lookups).
- **Isolation: SOLID.** Distinct DO ids → distinct ctx + isolated SQLite; cross-session secret reads returned null/empty; R2 overflow keys namespaced per-prefix + per-hashed-do_id, no cross-tenant bleed. SSRF to localhost/169.254.169.254 blocked at the CF edge (403/error-1003).
- **Resource exhaustion: SOLID for cur.** Every infinite-loop / recursion / alloc-bomb / string-bomb shape trips a typed, recoverable error with the socket alive and the next eval succeeding. The historical workerd interrupt-throttle escape did **not** reproduce (tick budget holds below the throttle floor). The 18MB dump-reject closes the monotonic-buffer cliff (the giant-source vector clean-rejects).
- **Snapshot integrity: SOLID.** All corruption vectors detected with typed errors; engine-hash mismatch routes to faithful journal-replay (no blind blit); no silent wrong-state restore; `reset` heals 100%.

**Bottom line:** the deployed-equivalent kernel (`engram-adv-cur` ≈ `engram-kernel`) survived all 6 suites with **zero breaches**. The single HIGH worker breach (BREACH-1) lives **only** in the experimental W4 delta variant, which is **not deployed** and which regressed by dropping the size guard. The Rust slice finding is a local guard gap that must be carried into any rewrite plan, not a live-system breach. **No breach was found against the live-equivalent kernel.** Recommended hardening before W4 could ship: re-add the 18MB `MAX_DUMP_BUFFER_BYTES` clean-reject; add a mid-cell tripwire + manifest checksum to any Rust kernel; make `{t:evict}` acquire the mutex.

---

## Teardown (completed + verified)

- `engram-adv-cur` deleted via CF API — success=True.
- `engram-adv-w4` deleted via CF API — success=True.
- R2 `engram-snapshots`: 4 scratch keys deleted (2 under `advcur/`, 2 under `advw4/`); both prefixes now list 0 objects. Only scratch-prefix keys touched; live keys untouched.
- Final worker list confirmed: engram-* = **engram-kernel + engram-cloud + engram-ui** only (other workers `curl-worker`/`durelo`/`thinkx-api` are unrelated pre-existing, untouched).
- No edits to `apps/`. No live worker redeployed. Report committed after teardown; follow-up correction commit clarifies the Rust local guard-gap wording.

---

## Follow-up fix validation — W4 protocol/source admission

**Date:** 2026-06-02
**Scratch target:** `engram-adv-w4` only. Live workers untouched.
**Conclusion:** the W4 breach assumption is confirmed fixable without breaking W5's spike-then-free un-wedge path.

**Patch:** W4 now rejects oversized inputs before they can inflate the VM:
- WebSocket text frames above `MAX_WS_TEXT_BYTES = 8 MiB` return typed `ProtocolSizeError` before JSON parse.
- `eval` source above `MAX_EVAL_SRC_BYTES = 2 MiB` returns typed `ProtocolSizeError` before VM eval.
- W5/W4 snapshot serialization still keeps the 45 MiB safe-serialize ceiling for freed-spike images, so the W5 un-wedge behavior is preserved.

**Live scratch proof:**
- `attack-size-regression.mjs`: **6/6 PASS** — 3 MiB eval source rejected before VM eval; 9 MiB frame rejected before JSON parse; sockets stayed alive; 22 MiB spike-then-free checkpointed and cold-restored.
- `verify-w4.mjs`: **9/9 PASS** — base+delta fidelity, closure/map/set/pending-promise survival, W5 wedge regression, seeded determinism.
- `attack-tamper.mjs`: **5/5 SURVIVED** — corrupt base/delta vectors detected, no DO kill.
- Prior still-valid runs in this session: `attack-recover.mjs` recoverability and `attack-suite3.mjs` engine-hash/cross-session/long-chain replay survived.

**Teardown after follow-up:** `engram-adv-w4` deleted with Wrangler; Cloudflare worker list rechecked and shows only `engram-kernel`, `engram-cloud`, `engram-ui` under `engram-*` (`adv_count=0`).
