# ENV-SURFACE-POLICY — Engram Runtime Compat Stance

_What belongs inside the VM, what does not, and why._

---

## The stance

Engram is an **honest, curated, deterministic, snapshot-safe runtime**.  
It is **not a Node.js host**. The Node-shaped surface is a convenience alias — not an
identity, not a contract, and never a compatibility target that overrides the three
gates below.

The value Engram offers is the heap-snapshot moat: a live interpreter namespace that
hibernates, cold-restores byte-for-byte, and accumulates state across sessions without
source replay. That property is the product. Any shim that erodes it is net-negative
regardless of how much Node parity it adds.

---

## The compat line — three gates

A shim earns a place in `BOOTSTRAP` (and therefore in every snapshot, forever) only if
it passes **all three** of the following gates:

### Gate 1 — Deterministic / seeded

The shim must be a pure function of `(seed, cell sequence, recorded host-effect
responses)`. It may not introduce new entropy or wall-clock observations.
Examples of acceptable implementations: seeded PRNG, a replayed clock tick,
host-effect responses written back into the VM as literal values.

### Gate 2 — Snapshot-safe

The shim must live entirely in the QuickJS heap. It must not hold:
- handles to host resources (open sockets, file descriptors, timers) that span a
  snapshot/restore boundary,
- references to WASM memory addresses outside the QuickJS heap,
- references to Rust-side state (Mutex guards, JoinHandles, etc.) that cannot be
  reconstructed from the heap bytes alone.

A snapshot of the heap must be sufficient to reconstruct the full shim state in a
fresh WASM instance.

### Gate 3 — Observed-failure-first

The shim must address a real, observed breakage: a cell that a user actually ran that
failed without it. Feature-detect cosmetics ("it would be nice if `process.version`
were defined") do not pass this gate. Evidence: a test case, a filed issue, or a note
in the commit message identifying the cell and the error.

---

## The determinism red line — NEVER ship under any flag

The following are intrinsically incompatible with heap-snapshot durability. They must
**never** appear inside the VM, not even behind a config flag, not even as opt-in shims:

| Category | Examples |
|---|---|
| Real wall-clock | `Date.now()` via `performance.now()` wired to the OS, `new Date()` returning the real tz |
| Real OS entropy | `crypto.getRandomValues` wired to CSRNG rather than the seeded WASI `random_get` |
| Direct sockets / second effect channel | `net.connect`, raw TCP/UDP from within the VM, any write path that bypasses `host.*` |
| Hibernation-spanning timers | `setTimeout` / `setInterval` IDs that survive across a snapshot/restore cycle |
| Value-serialization heap compaction | Any mechanism that round-trips JS values through JSON/msgpack and back to reconstruct a compacted heap (loses Promises, closures, prototype chains — snapshot fidelity is gone) |

**Invariant:** every heap byte must be a pure function of `(seed, cell sequence,
recorded host-effect responses)`. If this invariant breaks, cold-restore is no longer
deterministic and the product guarantee is void.

---

## The escape hatch — when Node parity is genuinely required

Some workloads need capabilities that are intrinsically incompatible with the VM tier:
native addons, raw sockets, real `child_process`, real `worker_threads`, unrestricted
WASM compilation, or real-entropy cryptography. These are valid needs. They are simply
not Engram's job.

The correct answer for those workloads is a **different tier** — a container-class or
process-class sandbox reached via a `host` tool:

- **E2B / Modal / CF Containers** for long-running subprocess workloads
- **A sandboxed Node.js process** brokered by the supervisor for native-addon tasks
- **A dedicated microservice** for real-socket I/O

Engram's role is to be the **durable, deterministic, hibernating REPL** — the
coordinator. It deliberately says "no" to Node parity at the VM tier so it can say
"yes, forever" to heap-snapshot durability.

Reaching for the escape hatch via `host.fetch` or a future `host.exec` tool is the
correct design; shimming the gap inside BOOTSTRAP is not.

---

## Summary table — what works / what is intrinsically excluded

| Capability | Status | Notes |
|---|---|---|
| `fetch` + all WHATWG Web APIs | **Works** | `host.fetch` proxy; determinism-safe (responses recorded) |
| `crypto.subtle` / `getRandomValues` / `randomUUID` | **Works** | Seeded via WASI `random_get`; byte-identical across restore |
| `TextEncoder` / `TextDecoder` | **Works** | quickjs-wasi Tier-0 extension; pure |
| `URL` / `URLSearchParams` | **Works** | quickjs-wasi Tier-0 extension; pure |
| `structuredClone` / `Headers` | **Works** | quickjs-wasi Tier-0 extension; pure |
| Virtual `fs` (R2-backed) | **Works** | `host.fs` → R2; snapshot stores paths not handles |
| Isomorphic-git | **Works** (within source cap) | Pure JS; stays in heap; ~500 KB source cap applies |
| DNS over HTTPS | **Works** | Route through `host.fetch` |
| `process.version` / `process.env` | **Works** | Static shim; no dynamic OS state |
| `Buffer` / `stream` / `events` | **Works** | Pure-JS shims; snapshot-safe |
| `net` / `tls` / raw sockets | **Excluded by design** | Second effect channel; not snapshottable |
| `child_process` / `worker_threads` | **Excluded by design** | Process-boundary handles; not snapshottable |
| Real `wasm` compilation at runtime | **Excluded by design** | workerd blocks `WebAssembly.compile` from JS; by design |
| Real wall-clock (`Date.now()` live) | **Excluded by design** | Breaks determinism invariant |
| Real OS entropy | **Excluded by design** | Breaks determinism invariant |
| Hibernation-spanning `setTimeout` | **Excluded by design** | Handle lost on snapshot; re-created handles break semantics |

---

## Related

- `scripts/check-bootstrap-budget.mjs` — CI gate that fails if BOOTSTRAP grows past the committed byte ceiling
- `docs/SANDBOX-API.md` — host.fs, host.fetch, seeded timers, the staged-commit coherence invariant
- `engine/src/lib.rs` — the `BOOTSTRAP` constant; its byte size is the CI gate metric
