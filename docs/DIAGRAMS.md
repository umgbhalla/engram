# Diagrams

All four architecture diagrams are authored as **Mermaid** source (`docs/diagrams/*.mmd`)
and rendered to themed SVG (`docs/diagrams/*.svg`). They reflect the **current all-Rust
truth** (per `PLATFORM-ON-RUST.md`): the kernel is a Rust DurableObject (workers-rs) running
the `rquickjs` `engine.wasm` interpreter — there is no separate "JS glue" layer, only a
~30–50 line in-VM JS bootstrap (host Proxy + `Date` trap). Durability is the **W5+W4+E6
delta stack** (used-heap admission + arena scrub · 256B byte-delta · E6 oplog crash-tail +
engine-migration journal). Snapshots go to DO SQLite (chunked) with R2 `engram-snapshots`
overflow only above ~2 MB gz.

Shared theme: dark GitHub palette (`--bg:#0d1117`, `--fg:#e6edf3`, `--accent:#4493f8`,
`--surface:#161b22`, `--line:#3d444d`, `--muted:#9198a1`), Inter font, set via the
`%%{init}%%` header in each `.mmd`.

## Render

All four use the same command (substitute the diagram key):

```sh
npx @mermaid-js/mermaid-cli -i docs/diagrams/<key>.mmd -o docs/diagrams/<key>.svg -b "#0d1117"
```

Regenerate all:

```sh
for k in architecture multi-tenant session-states snapshot-restore; do
  npx @mermaid-js/mermaid-cli -i docs/diagrams/$k.mmd -o docs/diagrams/$k.svg -b "#0d1117"
done
```

## The four diagrams

| Key | Mermaid type | Shows (current state) |
|---|---|---|
| `architecture` | `flowchart TB` | Single-tenant kernel topology: client (SDK/CLI/UI) over WS/HTTP into the **`engram-kernel` Rust DurableObject** (eval mutex · guards · determinism · checkpoint commit-order), which drives the **`rquickjs` VM** (`engine.wasm` + live linear memory = the engram + the in-VM JS bootstrap). The DO's snapshot pipeline (**W5+W4+E6 delta stack**) writes to **DO SQLite** (chunked rows + manifest, primary) spilling to **R2 `engram-snapshots`** above 2 MB gz. Host I/O boundary (`host.fetch` allowlist, host tools/kv via `__hostCall`, seeded clock/RNG/crypto) and **Analytics Engine** (`engram_kernel` dataset) per-op metering. |
| `multi-tenant` | `flowchart TB` | The **`engram-cloud`** supervisor model: tenant client → **SupervisorDO** (64-shard) doing routing, per-tenant API-key auth, alarms (idle/TTL/keep-warm — facets can't set alarms, so they live here), `worker_loaders`, the **WS-hibernation PROXY** (supervisor holds the socket and RPCs each frame), and AE metering + `/usage`. Per-session **KernelFacets** are each a **Rust DurableObject** running its own `engine.wasm`, with its **own isolated SQLite** (W5+W4+E6 delta stack), R2 overflow, failure-isolated. Kernel delivered as a `{wasm}` Worker-Loader module. |
| `session-states` | `stateDiagram-v2` | Lifecycle of one session: **Cold** (no instance, only DO identity + SQLite) → **Creating** (Rust DO instantiates `engine.wasm`, runs bootstrap, persists config) → **Live** (nested: Idle namespace ⇄ Evaluating cell ⇄ Checkpoint), where Evaluating shows the tick-budget + mid-cell used-heap tripwires and Checkpoint shows the used-heap size-admission guard and the W5+W4+E6 stack → **Hibernating** (DO evicted, instance gone, snapshot durable) → **ColdRestore** (new instance, Tier-0 natives re-instantiated at fixed bases, heap blitted back, restore guard on recorded `used_heap`, **no replay**) → back to Live. |
| `snapshot-restore` | `sequenceDiagram` | The eval→snapshot→evict→cold-wake round-trip between **Client**, the **Rust DurableObject**, **`rquickjs engine.wasm`**, the **W5+W4+E6 delta stack**, **DO SQLite**, and **R2 engram-snapshots**. Live path: eval runs on linear memory (effects fire once, memory monotonic), used-heap admission + scrub, dump `memory.buffer`, 256B byte-delta + E6 tail, write changed chunks (or R2 spill >2 MB gz). Wake path: read manifest (`used_heap`/engine-hash/`kv_json`), reconstruct image, new instance + Tier-0 natives, blit memory back, resume at generation N+1 with **no replay / no re-fired effects**. |

## Status

All four diagrams are beautiful themed Mermaid, updated to the current all-Rust state,
rendered to valid SVG, and embedded in the root `README.md` (architecture at top;
snapshot-restore + session-states + multi-tenant under "How it works"). Root `package.json`
is untouched.
