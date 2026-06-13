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

## Status
- Mechanism corrected. Discount justified. **No code changed** (would regress v0.2 / is unverified).
- Blocked on: (a) `engram-kernel` was unresponsive after the cascade run — confirm recovered;
  (b) run `tests/chaos/restore-cliff.mjs` to get the real cliff number.
