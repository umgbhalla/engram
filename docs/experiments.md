# Phased experiment plan (JS-first, cheapest-highest-signal first)

> Local experiments need only Node/Rust. CF experiments need **paid** Workers account
> + API token, wrangler, R2 bucket, a DO class with `new_sqlite_classes` migration.

| # | Name | Needs | Hypothesis | Success metric |
|---|---|---|---|---|
| **1** | Local round-trip | local | QuickJS namespace + closure + pending Promise survive memory+globals dump/restore | `x===42` after restore; closure works; record raw/gzip size + snap/restore time |
| **2** | Globals-necessity + host re-bind | local | memory-only restore corrupts on next alloc; +globals succeeds; named host callbacks re-bind | corruption reproduced then fixed; output routes after restore |
| **3** | Codesize & startup gate | paid deploy | QuickJS kernel fits 10 MiB gzipped + parses under startup CPU limit | gzipped <10 MiB; no error 10021 (run Boa too) |
| **4** | Rust DO authoring chain | paid CF | Rust DO instantiates, persists SQLite, fires alarm | counter survives; alarm fires |
| **5** | **THE THESIS TEST** | paid CF + R2 + WS | live JS namespace survives DO eviction via linear-memory dump | `x===42` after proven cold wake; constructor counter incremented |
| **6** | Memory-ceiling probe | paid CF | 2× spike trips Error 1102 well under 64 MB | record linear-memory size at failure = real usable budget |
| **7** | Restore latency dist | paid CF + R2 | sub-second restore holds only to ~8–16 MB | p50/p95 table at 1/8/16/32/64 MB; size where "fast resume" breaks |
| **8** | Determinism | local/CF | seeded clock/RNG → byte-identical restore after same next cell | identical memory hash |
| **9** | Crash-robustness + upgrade guard | paid CF | last per-cell checkpoint restores w/o clean onSleep; v2 build rejected by hash guard | checkpoint restores; mismatch rejected cleanly |
| **10** | RustPython / Rivet (deferred) | — | repeat 1/5 for RustPython wasm; repeat 5 under RivetKit CF driver | namespace survives; wrapper adds no friction |

## Detail — EXP-1 (start here, no creds)

**Hypothesis:** QuickJS namespace + a closure + a pending Promise survive a
memory+globals dump/restore.

**Setup:** Node + quickjs-wasi (or rquickjs→wasm). Eval
`globalThis.x=41; var p=Promise.resolve().then(()=>x++)`. `serializeSnapshot()` to disk.
Fresh process: deserialize, `executePendingJobs`, eval `x`.

**Success:** `x===42`; pre-snapshot closure works. Record raw vs gzip size, snapshot+restore time.

## Detail — EXP-2

(a) snapshot memory only, restore, allocate → expect corruption; add globals → works.
(b) register `print` by name, snapshot, restore, `registerHostCallback('print', fn)`, invoke from JS.

## Sequencing

```
EXP-1 ─┬─ EXP-2 ──────────────┐ (local, no creds — START NOW)
       └─ EXP-3 (deploy)      │
                              ▼
EXP-4 (Rust DO) ── EXP-5 (THESIS) ─┬─ EXP-6 (ceiling)
                                   ├─ EXP-7 (latency)
                                   ├─ EXP-8 (determinism)
                                   └─ EXP-9 (crash/upgrade)
                                          │
                                          ▼
                                   EXP-10 (RustPython / Rivet)
```

EXP-5 is the decisive go/no-go for the whole bet. EXP-6 + EXP-7 set the real
operating envelope (max namespace size, max snapshot for "fast resume").
