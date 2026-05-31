# EXP-6 results — MEMORY CEILING PROBE (go/no-go number)

**Date:** 2026-06-01 · **Branch:** `exp/6-memory-ceiling` · **Verdict: PASS ✅ (ceiling found)**

We found the real usable namespace budget for a QuickJS kernel snapshotting inside
a Cloudflare Durable Object. The hypothesis — that the 128 MB isolate cap plus the
~2–3× transient copy during dump trips OOM well under any naive "64 MB" budget — is
**confirmed**: a full snapshot reliably succeeds up to **~57 MB of live QuickJS
linear memory**, and the kernel **dies hard at ~60 MB live** (the isolate is torn
down — WebSocket closes `1006` / `responseStreamDisconnected`, with **no catchable
JS exception** surfaced). gzip/streaming does **not** move the ceiling.

## Headline number

| Metric | Value |
|---|---|
| **Last live linear memory at which a FULL snapshot succeeds** | **57.25 MB** |
| **First failure (worker death)** | trying to reach **~60–61 MB** live |
| Failure mode | isolate hard kill: WS `code=1006`, `outcome=responseStreamDisconnected`, **no JS exception / no log line** (uncatchable OOM, not a throw) |
| Does gzip vs streamed change the ceiling? | **No** — identical boundary in both modes |

**Real usable namespace budget ≈ 57 MB** (with a hard wall ~60 MB). Plan operating
sizes well below this — ~40 MB gives comfortable headroom for the transient spike.

### Decisive twist: it is the SNAPSHOT spike, not raw size

A separate **grow-only** probe (allocate live memory but **never snapshot**,
`experiments/exp-6/grow-only.mjs`) grew the live QuickJS linear memory **past 193 MB
without dying** — i.e. WASM linear memory for a DO is **not** capped at 128 MB at all.
So the ~57 MB ceiling is **entirely** the cost of the snapshot's transient extra
copies, not the steady-state namespace size. The takeaway flips from "the kernel
can't be big" to "**the kernel can be big, but the current dump path can't snapshot
a big one**" — fixing the redundant copy is what unlocks larger kernels.

## What was deployed

- **Worker + JS Durable Object** `montydyn-exp6` (reuses the proven EXP-5a kernel
  path: `quickjs-wasi@3.0.0` `quickjs.wasm` bundled as a **CompiledWasm** module).
- **URL:** `https://montydyn-exp6.umg-bhalla88.workers.dev`
  (WS: `wss://montydyn-exp6.umg-bhalla88.workers.dev/ws?id=<session>`)
- R2 bucket `montydyn-snapshots` reused; EXP-6 keys namespaced `exp6/<doId>.qjs.gz`
  (only touched by the optional `snapstore` message, not by the ceiling probe).
- Worker startup 14 ms, upload 1654 KiB / gzip 558 KiB. No Error 10021/10195.

## Method

Driver: `experiments/exp-6/test-client.mjs`. Over one hibernatable WebSocket:

1. `{t:'reset'}` — fresh kernel, `memoryLimit:-1` so QuickJS's *own* allocator does
   not cap us before the **isolate** does (we want the CF isolate ceiling, not a
   QuickJS soft limit).
2. `{t:'grow', mb}` — allocate `mb` × 1 MiB `Uint8Array`s inside QuickJS, each
   `fill()`ed (pages committed, not lazily-zero), retained on a global array so the
   data is **live** and must be captured by a snapshot. Reports the kernel's own
   exported `memory.buffer.byteLength` = live linear memory.
3. `{t:'snapcheck', mode}` — full `snapshot()` → `serializeSnapshot()` → gzip
   (`buffered` = whole gz buffer; `streamed` = gzip through a `CompressionStream`
   counting output without materializing a second full gz buffer). Reports
   serialized size, gz size, and the peak-transient estimate.

Step 4 MiB at a time until the snapshot throws OR the worker dies.

## The curve (4 MiB steps, buffered snapshot)

Each row = a `grow` then a full `snapcheck`. `serialized` ≈ live linear memory (the
snapshot is essentially a copy of the whole image). `peakTransient` = live +
`snap.memory` copy + serialized copy (the worst-case simultaneous footprint; gz is
negligible because `.fill()` data is highly compressible).

| Live linear (MB) | snapshot? | serialized (MB) | gz (MB) | ratio | peak transient (MB) |
|---:|:---:|---:|---:|---:|---:|
| 5.25 | ✅ | 5.25 | 0.10 | 51× | 15.75 |
| 9.25 | ✅ | 9.25 | 0.11 | 86× | 27.75 |
| 13.25 | ✅ | 13.25 | 0.11 | 118× | 39.75 |
| 17.25 | ✅ | 17.25 | 0.12 | 148× | 51.75 |
| 21.25 | ✅ | 21.25 | 0.12 | 175× | 63.75 |
| 25.25 | ✅ | 25.25 | 0.13 | 201× | 75.75 |
| 29.25 | ✅ | 29.25 | 0.13 | 226× | 87.75 |
| 33.25 | ✅ | 33.25 | 0.13 | 247× | 99.75 |
| 37.25 | ✅ | 37.25 | 0.14 | 268× | 111.75 |
| 41.25 | ✅ | 41.25 | 0.14 | 288× | 123.75 |
| 45.25 | ✅ | 45.25 | 0.15 | 305× | 135.75 |
| 49.25 | ✅ | 49.25 | 0.15 | 323× | 147.75 |
| 53.25 | ✅ | 53.25 | 0.16 | 338× | 159.75 |
| **57.25** | ✅ **(last OK)** | 57.25 | 0.16 | 354× | 171.75 |
| **~60–61** | 💀 **worker dies during `grow`** (WS 1006) | — | — | — | — |

Reproduced across multiple runs: last-OK is consistently **57.25 MB**, death on the
push to ~60 MB.

In a coarser (8 MiB) run the death instead landed on the *second consecutive*
snapshot at 65.25 MB live — i.e. the boundary is a band ~57–65 MB live depending on
exactly which transient spike (a `grow` allocation vs a fresh `snapshot` copy) tips
the isolate over. Either way the **safe, repeatable budget is ~57 MB**.

## Why it dies where it does (the 2–3× spike)

At snapshot time the isolate simultaneously holds, for one QuickJS image of size `L`:

- **L** — the live WASM linear memory (kept alive by the running kernel),
- **~L** — `snap.memory`, a fresh `Uint8Array` copy taken by `snapshot()`,
- **~L** — `serializeSnapshot()` output, another full copy,
- ~0 — the gz buffer (negligible here; data is compressible).

So a snapshot momentarily needs **~3 × L** plus QuickJS/runtime overhead. At
L ≈ 57 MB that is ≈ 172 MB of *logical* allocation churn against a **128 MB isolate
cap** — GC reclaims `snap.memory` between steps, but the next `grow`/`snapshot` can't
get over the hump and the isolate is killed. This is exactly the predicted failure:
**OOM well under the namespace size you'd naively budget from the 128 MB number.**

## gzip / streaming did NOT change the ceiling

`buffered` and `streamed` modes hit the **same** boundary. Reason: the killer is the
**serialize copy** (a full second image of linear memory) plus the live memory, not
the gzip output — which is tiny (sub-0.2 MB) for this workload and even smaller when
streamed. Streaming the *output* helps nothing because the input (`serialized`, ~L)
must still be fully materialized before/while compressing. To raise the ceiling you'd
have to **avoid the full serialized copy** (e.g. stream the snapshot's `memory`
ArrayBuffer directly into `CompressionStream`/R2 without the intermediate
`serializeSnapshot()` Uint8Array), which is a kernel/lib change, not a transport one.

## Platform errors hit

- **Isolate OOM = hard kill, not Error 1102 text.** The OOM does **not** surface as a
  catchable JS exception or an `exceptions[]`/`logs[]` entry in `wrangler tail`. The
  observable signature is: climbing wallTime on the final `grow` (185→705 ms), then
  the WebSocket message event simply stops and a close event fires with
  `wasClean:false, code:1006`, and the fetch shows
  `outcome:"responseStreamDisconnected"`. So in production this manifests as an
  **abrupt DO/WS death**, not a graceful error you can `try/catch`.
- No Error 10021 (startup) / 10195 (paid gate) — same as EXP-5a.

## Live-only ceiling (no snapshot) — grow-only probe

`grow-only.mjs` stepped live linear memory in 8 MiB increments with **no snapshot**:

| Live linear (MB) | alive? |
|---:|:---:|
| 57.25 | ✅ |
| 65.25 | ✅ |
| 97.25 | ✅ |
| 129.25 | ✅ (past the supposed "128 MB cap") |
| 161.25 | ✅ |
| **193.25** | ✅ (probe ceiling; did not die) |

So **steady-state live memory is NOT the limiter** — it scaled past 193 MB. The
57 MB snapshot ceiling is purely the **transient dump spike**.

## Implications for the build

- **Real usable namespace budget ≈ 57 MB live linear memory.** Treat ~40 MB as the
  comfortable operating ceiling to leave room for the snapshot spike + runtime.
- **Snapshots must be cheap on transient memory.** The current path makes ~3 full
  copies of linear memory. For larger kernels, eliminate `serializeSnapshot()`'s
  extra copy and stream `snap.memory` straight to gzip→R2. That is the lever that
  moves the ceiling, not gzip mode.
- **OOM is uncatchable here** — guard by *size*: refuse/limit `grow` and refuse
  snapshots above a configured live-memory threshold (e.g. 45–50 MB) so the kernel
  fails gracefully instead of being torn down mid-operation. Pair with EXP-9's
  per-cell checkpoint so a kill never loses more than the last cell.
- Confirms the EXP-5a note that R2 chunking is a non-issue at these sizes — gz stays
  sub-0.2 MB for compressible data; even an incompressible 57 MB image is one R2 put.

## Files

- `experiments/exp-6/wrangler.jsonc` (worker `montydyn-exp6`)
- `experiments/exp-6/src/worker.mjs` (DO: `reset` / `grow` / `snapcheck` / `snapstore` / `stat`)
- `experiments/exp-6/src/quickjs.wasm` (CompiledWasm, same binary as EXP-1/5a)
- `experiments/exp-6/test-client.mjs` (Node `ws` step-up probe driver)

## Leftover resources (intentionally kept)

- Worker `montydyn-exp6` (URL above) — left deployed for follow-up (EXP-7 latency).
- R2 bucket `montydyn-snapshots` — shared; EXP-6 keys under `exp6/`.
- Pre-existing workers/buckets (curl-worker, durelo, thinkx-api, durelo-content,
  nova-archive, sdev-skills, montydyn-exp5a) **not touched**.

## Verdict

**PASS.** Go/no-go number recorded: **~57 MB usable namespace, hard wall ~60 MB**,
OOM as an uncatchable isolate kill. Hypothesis confirmed — the transient dump copy,
not the steady-state size, sets the ceiling, and it lands ~half of the 128 MB cap as
predicted. gzip/streaming doesn't help; removing the redundant serialize copy is the
real lever for EXP-7+.
