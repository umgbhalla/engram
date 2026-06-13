# Chaos Case 1 (CRITICAL "un-restorable commit") — verified verdict

> Follow-up to `docs/CHAOS-CASCADE.md`. The cascade's opus agent read the generated
> `kernel-glue.mjs`; this is the verified read against the **source-of-truth `kernel-glue.ts`**
> (the `.mjs` is the esbuild output of it — NOT stale; an earlier grep wrongly reported it absent
> because `git grep`/`grep` auto-detected the embedded binary bytes in `.ts` and suppressed
> matches — use `grep -a`).

## What the cascade claimed
CRITICAL silent durable loss: the unconditional `SCRATCH_DELTA_BYTES = 31MB` discount at
`kernel-glue.ts:2574` (`incompressibleBytes = max(usedHeap, bufBytes0 - 31MB)`) lets a
spike-then-free session commit a ~47MB raw W4 base that **admits but cannot cold-restore**.

## What the code actually does (verified, file:line)
Source: `apps/kernel/src/kernel-glue.ts`.

Dump-side admission (`_serializeForDump`, L2539-2596), in order:
1. L2545 `bufBytes0 > SAFE_SERIALIZE_BUFFER_BYTES (76MB)` → reject.
2. L2563 `usedHeap > MAX_USED_BYTES (50MB)` → reject.
3. L2575 `incompressibleBytes = max(usedHeap, bufBytes0-31MB) >= INCOMPRESSIBLE_BUFFER_CEILING (24MB)` → reject.

Restore-side guards (`restore` L3100, `restoreW4` L3140):
- `recordedUsed > MAX_RESTORE_USED_BYTES (50MB)` → reject.
- `raw.length > MAX_RESTORE_RAW_BYTES (76MB)` → reject.

**Dump and restore are in LOCKSTEP on the absolute caps** (76MB raw / 50MB used, constants
L888-891). The dump has one EXTRA, STRICTER gate (the 24MB incompressible ceiling) that restore
does not. ⇒ **anything dump admits, restore also admits.** There is no guard-level
"admitted-at-dump, rejected-at-restore" gap. The discount only loosens the *strict* gate; it
cannot push a base past the *absolute* restore cap.

## Why the 31MB discount exists (the "was there a reason")
Yes — deliberate, documented at L878-883 + L907-913. A flat raw-buffer gate at 24MB would
**false-trip every benign session that ever pulled a big fetch/payload** (resident scratch
high-water persists in monotonic WASM memory). The discount gates the *incompressible extent*
(`max(usedHeap, buffer-31MB)`) below the ~28MB transient-OOM cliff, so an incompressible-heap
session is caught WITHOUT false-tripping benign zero-scratch sessions. Ripping it out
re-introduces the v0.2 BUG-2/4 false-trip regression and gains nothing.

## Corrected verdict: mechanism MIS-STATED; one residual risk remains UNVERIFIED
The cascade's mechanism ("the discount silently commits an unrestorable base") is **wrong** —
the discount cannot exceed the absolute restore cap, and the live run (canary survived,
`sqlite-restore`, gen 296) is consistent with restorability.

The legitimate kernel of the finding, restated precisely:

> **Is `MAX_RESTORE_RAW_BYTES = 76MB` itself ABOVE the true transient-OOM restore cliff?**

The design *assumes* restore transient cost tracks **incompressible content** (zero-scratch pages
are cheap to gunzip + instantiate), so a 76MB-raw / ≤24MB-incompressible image is safe. If that
assumption is wrong and restore transient tracks **full decompressed raw size** (gunzip
materializes all 76MB + a 76MB WASM memory ⇒ ~2× transient), a base both guards admit could still
WS-1006 on cold wake → silent loss. **This is unverified in-session** (and EXP-7's "1102 at
27-32MB raw" vs v0.5's "~256MB DO-kill" are contradictory enough to demand a fresh measurement on
the current zstd+W5 path).

## Action: MEASURE before touching the tuned constant
Do NOT change `SCRATCH_DELTA_BYTES` / `MAX_RESTORE_RAW_BYTES` blind — they are deliberately tuned
and a wrong move regresses v0.2. The cliff must be measured first:
`tests/chaos/restore-cliff.mjs` sweeps raw-image size (with controlled incompressible fraction)
and binary-searches the cold-restore failure point. Run it against a healthy `engram-kernel`.

### Fix options (pick AFTER measurement)
- **If 76MB raw restores fine** (incompressible model holds): no code change. The cascade
  CRITICAL is a false positive; downgrade to "verified safe", keep the discount.
- **If the cliff is below 76MB raw**: two non-regressing fixes —
  1. Lower `SAFE_SERIALIZE_BUFFER_BYTES` + `MAX_RESTORE_RAW_BYTES` (lockstep) to the measured-safe
     raw ceiling. Spike-then-free sessions above it then get a typed `SizeAdmissionError`
     (socket alive, "reset to recover") at DUMP — never a silent acked commit. Nothing lost: the
     prior committed base stays valid.
  2. **Keep-prior-verified-base** (structural, strongest "nothing lost"): don't delete the prior
     base when committing a large-raw base; promote the new base only after a proven cold restore.
     A bad base falls back to the prior verified base + oplog replay (the fallback already exists:
     `restoreW4` CRC-mismatch → replay). Touches `lib.rs` checkpoint commit ordering.

## CONFIRMED (live probe + opus code analysis): the real bug is DUMP-side, not restore-side
The cascade pointed at restore; the truth is the **CHECKPOINT (dump)**. A raw-WS probe
(`tests/chaos/restore-cliff-raw.mjs`) reproducibly failed **at the post-free checkpoint** (NOT
restore) at 16 / 24 / 32 MB raw — `rpc-timeout` and `WS-1006` (uncatchable OOM), monotonic with
spike size. opus code-analysis (high confidence) pinned the mechanism:

1. **Tripwire bypass.** Default `cellGrowCapPages = 1024` (64MB, raised for 32MB fetch bodies —
   `kernel-glue.ts:~1635`). A single `new Uint8Array(16-32MB)` grows ~256-512 pages, FAR under the
   cap, and a single native alloc emits no bytecode interrupts → the v0.8 mid-cell tripwire never
   fires. The spike lands silently.
2. **Admission passes by design.** After free, the buffer is monotonic (~16-32MB), `usedHeap≈0`.
   The 24MB incompressible gate (`max(usedHeap, buf-31MB)`) reads ~0 → ADMITS the freed spike (its
   intended behavior).
3. **5-copy retain peak.** raw < `LARGE_BUFFER_NO_RETAIN_BYTES (63MB)` → takes the RETAIN path, not
   the 2-copy no-retain fence. The `canDelta` branch holds simultaneously: `raw` (L2628) +
   `payload` (L2671) + **`payGz` AND `fullGz` — TWO full compresses** (L2681-2685) + `_pendingImage
   = raw.slice()` (L2690) + the Rust-side `gz` copy (`lib.rs:~2939`). For a 32MB *incompressible*
   image that's ~5× ≈ 130-160MB live in one synchronous checkpoint → crosses the ~128MB workerd
   isolate soft ceiling → WS-1006. At 16MB it's ~80-90MB — still enough to wedge under any load.

Worst single avoidable alloc: **`kernel-glue.ts:2690` (and 2695/2701) `_pendingImage = raw.slice()`**
+ the **double-compress** at L2681/L2685.

## Precise fix (cuts peak; does NOT regress the fetch-body path or W4 correctness)
The 63MB no-retain fence keys off `raw.byteLength`; the real OOM driver is **incompressible raw
size × the retain-path copy multiplier**, which bites well below 63MB. Two surgical changes:

- **(F1) Lower / re-key the no-retain trigger.** Trip the 2-copy no-retain path when the buffer is
  bloated-and-mostly-freed (e.g. `bufBytes0 > ~24MB` with low `usedHeap`), not only at 63MB raw.
  That routes a freed 16-32MB spike to peak `~raw + gz` instead of 5×. Normal small sessions
  (buffer < trigger) keep the W4 delta chain untouched. Tradeoff: a freed-spike session loses its
  delta chain (forced full base) — acceptable, it's the rare case, and correctness is preserved
  (full base resets the oplog tail consistently, as the existing >63MB path already does).
- **(F2) Skip the `fullGz` fallback compress when `raw` is large.** In the `canDelta` branch, don't
  compute both `payGz` and `fullGz` above a size threshold — pick full directly. Removes one full
  incompressible copy from the peak.
- **(F3, defense-in-depth, has a tradeoff — USER DECISION):** drop default `cellGrowCapPages`
  toward 256 for non-fetch sessions so a 16MB single-alloc trips `MemoryLimitError` MID-CELL
  (socket alive) instead of silently wedging the next checkpoint. Cost: breaks >16MB single-alloc
  cells for sessions that legitimately need them (large fetch bodies) unless scoped to non-fetch.

"Nothing lost" guarantee: F1+F2 make the checkpoint SUCCEED (peak under ceiling) rather than
WS-1006. F3 makes the spike fail-closed *before* commit. Either way no silent durable loss.

## Measurement caveat: the cliff is NOT a clean per-session number (shared-isolate contamination)
A clean `restore-cliff-raw.mjs` run (key auto-loaded from .env) showed the failures are
**load/timing-dependent, not size-monotonic**: a 16MB spike hard-crashed (WS-1006) while a 78MB
single alloc failed *cleanly* (catchable QuickJS `InternalError: out of memory`, socket alive) —
the reverse of a true size cliff. Cause: the bare kernel's worker isolate is SHARED across sessions;
repeated heavy probing leaves resident high-water sessions, so a new session's checkpoint OOMs on
the *aggregate* isolate memory, not its own. ⇒ **a reliable threshold can't be measured from a WS
client against the shared deployment.** The fix must therefore be **STRUCTURAL (F1+F2: cut the
checkpoint copy-multiplier)**, NOT a magic threshold tuned to a contaminated measurement. (A clean
number would need a fresh/quiet worker or per-session isolates.) The 5-copy amplification is real
regardless; reducing it lowers peak under any load.

## Status
- Root cause CONFIRMED (dump-side, 5-copy retain peak), fix designed with file:line.
- **No kernel code changed yet** — F1/F2 touch correctness-sensitive W4/commit-ordering; shipping
  needs: implement → `build:worker` (cargo+tsc+worker-build, slow/in-thread) → `alchemy deploy` →
  re-run `restore-cliff-raw.mjs` to confirm the WS-1006 is gone AND W4 delta still reconstructs.
- Live key currently **throttled (401)** from repeated probing — let it cool before re-testing.
