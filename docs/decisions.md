# Architecture Decision Records

## ADR-0001 — Drop Dynamic Worker Loader for the kernel substrate (V0)

**Status:** Accepted (V0). Revisited by ADR-0003.

**Context.** Project began exploring Dynamic Worker Loader (`env.LOADER`) for a durable resumable REPL. DW Loader spins up ephemeral, per-request V8 isolates, best-effort warm, keyed only by id, with **no persistence guarantee** and no module type for `.wasm`.

**Decision.** V0 does **not** use Dynamic Worker Loader. The kernel substrate is a **Durable Object** (single persistent identity + SQLite + hibernation) with the QuickJS engine bundled as a **CompiledWasm** module. DO replaced the loader.

**Why.** A kernel needs the opposite of what DW Loader offers: one persistent single-identity actor that owns state and survives eviction. The engine is a *fixed* image → bundle it, don't load it dynamically. EXP-4b confirmed pure-Rust nested eval isn't viable; path (b) = Rust DO shell + JS glue.

**Consequence.** V0 bindings: `KERNEL_DO` (DO+SQLite), `SNAPSHOTS` (R2 overflow), CompiledWasm `quickjs.wasm`. No `LOADER`.

---

## ADR-0002 — Live-heap snapshot, not logical-state reconstruction

**Status:** Accepted.

**Context.** Two ways to make a REPL durable: (A) reconstruct an equivalent namespace from durable *data* (the model facet-native `ctx.storage` and journaling use); (B) snapshot the raw interpreter **heap** and blit it back.

**Decision.** Use (B): dump QuickJS WASM **linear memory + mutable globals** at quiescent cell boundaries; restore into a fresh instance. No source replay, no re-fired side effects.

**Why.** Model (A) loses live object identity, closures, and pending promises — not a real kernel. (B) is only possible because WASM linear memory is a plain ArrayBuffer (V8 isolate heap is not snapshottable). Proven EXP-1/5a; byte-deterministic with seeded clock/RNG (EXP-8).

**Consequence.** Snapshots are byte-coupled to the engine build → engine-hash guard + per-cell journal fallback (EXP-9). This is orthogonal to facets: even inside a facet, we still heap-snapshot into the facet's SQLite.

---

## ADR-0003 — Adopt Durable Object Facets for V1 multi-tenant (Worker Loader re-enters here)

**Status:** Proposed (V0.1 / V1 direction).

**Context.** V0 = one DO per session (one identity/namespace each). Going multi-tenant + dynamically-configurable needs: per-session isolation, supervisor-owned auth/metering/billing/kill-switch, and per-tenant/versioned kernel code. DO **Facets** provide exactly this: a supervisor DO loads a DO **class from a Dynamic Worker** (`LOADER.getDurableObjectClass`) and runs it as a child facet with its **own isolated SQLite**.

**Decision.** V1 packages the kernel as a **facet under a supervisor DO**. This is where **Worker Loader deliberately re-enters** (reversing ADR-0001 *only* for the multi-tenant/dynamic-config case): the per-tenant kernel class is loaded via `env.LOADER`, hot-swappable via `abort`+restart, isolated per session.

**Why.** Facets fuse "dynamically-loaded code" + "persistent isolated storage" + "supervisor control" — the precise shape of a multi-tenant, dynamically-configured, stateful REPL. The live-heap snapshot (ADR-0002) still applies *inside* each facet's SQLite.

**Consequences / open questions.**
- Facets require `new_sqlite_classes` supervisor + `worker_loaders` binding (Workers Paid, beta).
- Undocumented: per-facet alarms/WebSockets, nesting, per-facet limits, exact eviction semantics → must validate empirically before depending on them.
- Facet-native `ctx.storage` is model (A); we keep model (B) heap-snapshot on top. Two storage uses coexist in one facet DB: our snapshot chunks + any logical state.
- Cost/perf of many facets per supervisor + heap snapshots each — unmeasured.

**Sequencing.** V0.1 first proves the kernel is *usable/useful* as a flat DO (current V0 hardened + a real product surface). Only if that lands do we layer facets for multi-tenancy. Don't add facet complexity before the single-tenant kernel earns it.
