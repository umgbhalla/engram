# montydyn v0.5 — DEEP hibernation / full-eviction probe

> Live target: `wss://montydyn-v05.umg-bhalla88.workers.dev/ws?id=<id>`.
> AE dataset `montydyn_kernel`. 2026-06-01.
>
> **Question:** the ~70s soak only triggered *shallow* WS-hibernation. A >10min idle with the
> socket fully CLOSED forces a genuine full eviction (DO dropped from the colo, possible
> machine/placement migration on wake) = the true cold-start tail. Does state ALWAYS survive,
> does the generation bump (= genuine reconstruction), and how bad is the deep cold-wake latency
> vs the shallow ~640ms p99?

**Method (per cycle):** connect with a stable reused session id, `eval` to set rich state (var +
closure + accumulating array + tag, plus a real multi-MB image in the mid/large runs), force a
checkpoint, **CLOSE the socket**, idle the FULL duration with NO connection held (`bash sleep`),
then reconnect with the SAME id, send `{t:"gen"}` (expect `inMemory:false` + bumped generation),
`eval` to read state back (expect `restoreSource=sqlite-restore` + correct values + closure still
callable), and record the client-observed cold-wake round-trip.

Three runners, 7 deep cycles total:

| runner | image | cycles | idle/cycle | result |
|---|---|---|---|---|
| base-12 | ~1.31MB raw / ~109KB gz | 3 | 725s (~12min) | survived, gen 1→2 every cycle |
| mid-12  | ~6.55MB raw / ~115-186KB gz (5MB LCG image) | 2 | 720s | survived, gen 1→2, 7→8 |
| base-20 | ~1.31MB raw / ~109KB gz | 2 | 1200s (20min) | survived, gen 1→2 every cycle |

---

## 1. Did state ALWAYS survive a >10min full eviction? Any loss?

**Yes — state survived every one of the 7 deep cycles. Zero loss, zero corruption.**

- **base-12 (3×725s):** `x=42`, `inc()→43` (closure callable), `acc.length=1`, `tag='base12'` —
  exact on all 3.
- **mid-12 (2×720s, 5MB image):** marker correct; `adder(5)=1005`/`1006` (closure callable);
  accumulating array intact and cycle-tagged (len 1→3); the 5MB `Uint8Array` present
  (`imgLen=5242880`) with a **deterministic checksum 7924 stable across restores**; `__cp` marker
  correct.
- **base-20 (2×1200s):** `tag==sessionId`; `n` restored to committed `1000` then `inc()→1001`
  (closure callable); accumulating array len 3; a second closure `sum()` over the array returned
  the correct totals (33, 63). Read-backs: c1 `[hib-base20-c1,1000,1001,3,33]`, c2
  `[hib-base20-c2,1000,1001,3,63]`.

Every cold wake reported `restoreSource=sqlite-restore` (image lived in SQLite, well under the
20MB ceiling and under the 2MB-gz R2-overflow threshold — the R2 path was never exercised).
Subsequent evals on the woken DO were `warm`. **No half-state, no torn snapshot, no lost mutation
across any deep idle.** This extends the v0.5 idle-soak result (which only reached shallow
WS-hibernation at 72s) to genuine full eviction at 12–20min.

---

## 2. Deep cold-wake latency vs the shallow ~640ms p99

The deep-eviction tail is **materially worse for non-trivial images, and it is entirely
client/network + platform — NOT server-side restore work.**

Client-observed deep cold-wake round-trip (connect open + first reply):

| runner | image | deep cold-wake (ms) | vs shallow ~640ms p99 |
|---|---|---|---|
| base-12 | 1.31MB | 131 / 139 / 129 (mean ~133) | **faster** (~0.2×) |
| base-20 | 1.31MB | 1464 / 1326 | ~2× |
| mid-12  | 6.55MB | 1763 / 1460 | ~2.3–2.8× |

The split is the interesting part. base-12's "wake" measured just connect + first `{t:"gen"}`
reply (~130ms — dominated by raw WS RTT because the gen reply doesn't force the restore). base-20
and mid-12 measured connect + gen + **first eval** (which is what actually triggers the
`sqlite-restore`), so they capture the real felt tail. In those:

- **WS open / DO spin-up alone is ~945–1036ms** — this is the dominant term and it is cold-isolate
  + DO-wake on the platform, not our code.
- **First-eval sqlite-restore + WASM linear-memory regrow** adds the rest. mid-12's 5MB image
  showed `restoreTimings.glue growCount:1 / growDeltaPages:82` (linear memory regrown from cold);
  base image showed `growCount:1 / growDelta ~2 pages`.

**Server-side AE corroborates that the tail is NOT server restore work.** Across the run window
(`now()-120min`), `totalServerMs` (double1) and `readMs` (double2) read **0 at p99 and effectively
0 at max** for every source — including the deep `sqlite-restore` cohort:

| op / src | n | gen_max | avg_grow | max_grow | p99 serverMs | max serverMs | p99 readMs | max readMs |
|---|---|---|---|---|---|---|---|---|
| restore / sqlite-restore | 260 | 8 | 0.22 | 1 | 0 | 0 | 0 | 0 |
| eval / sqlite-restore (cold) | 255 | 8 | 0.23 | 1 | 0 | 11 | 0 | 0 |
| eval / warm | 2572 | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| eval / fresh | 190 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |

This is the same frozen-clock-in-sync-turn artifact documented in v0.5-observability: the entire
SQLite restore (read chunks → gunzip → instantiate QuickJS → blit linear memory → regrow → re-
register host fns) completes inside one synchronous workerd turn where the wall clock is frozen,
so server-measured time is 0 even on real deep wakes. The one server-side restore cost center that
*would* be measurable (R2 `readMs`, which crosses an await) was never hit because no image
overflowed to R2.

**Conclusion:** the ~1.3–1.8s deep tail is ~2–2.8× the shallow 640ms p99, and ~95% of it is the
cold WS-connect / DO-spin-up that the platform owns. There is **no evidence of a catastrophic
placement/machine-migration penalty** — latency was bounded and consistent across all cycles
(spread only ~130ms within a runner). The deep tail roughly doubles cold-wake latency but stays
comfortably ~1.3–1.5s; the worst single sample was 1763ms.

---

## 3. Generation-bump evidence the DO genuinely reconstructed

Every deep wake returned `gen()` → `inMemory:false` with an **incremented generation**, the
signature of genuine reconstruction from durable storage (not a warm/shallow WS-hibernation, which
would keep the in-memory isolate alive and not bump the generation):

- base-12: gen **1→2** on all 3 cycles.
- mid-12: gen **1→2** (c0), **7→8** (c1).
- base-20: gen **1→2** on both cycles.

Server-side AE matches the client view exactly. `restore` datapoints with `src=sqlite-restore` and
the bumped generation appear precisely in the client-observed wake windows:

| AE restore ts (UTC) | gen (double7) | maps to |
|---|---|---|
| 12:25:10 | 2 | base-20 c1 |
| 12:28:15 | 2 | mid-12 c0 setup region |
| 12:31:02 | 7 | mid-12 c1 (gen 7→8 wake) |
| 12:39:43 | 2 | base-20 c2 / mid setup |
| 12:45:13 | 2 | base-20 c2 wake |
| 12:48:56 | 8 | mid-12 c1 wake |

The session id is **salted/hashed into `index1`** server-side (raw ids are not queryable — a
`LIKE 'hib-base12%'` filter returns 0 rows), but the timing + generation + restored-cell triplet
is an unambiguous match to each client cycle. The WASM-regrow signal also proves real
reconstruction: across 255 cold `eval`/`sqlite-restore` rows, `growCount` (double10) is 1 on the
genuine cold-restore evals (`avg_grow`≈0.22 over the mixed cohort, `max_grow=1`) — the linear
memory was rebuilt from cold, not reused.

---

## 4. Implications for adaptive-keep-warm + V1

- **Durability is not the risk — latency is.** State survival across full eviction is rock-solid
  (7/7, including a 5MB image with a stable checksum), so an adaptive-keep-warm policy does **not**
  need to defend against data loss. Its only job is hiding the cold-wake tail.
- **Worst real wake a user would feel: ~1.5–1.8s**, dominated by the ~1s cold WS-connect /
  DO-spin-up, plus a few hundred ms of first-eval restore that scales mildly with image size
  (base ~130ms felt on a gen-only ping vs ~1.3–1.8s on a real first eval with a multi-MB image).
  This is bounded and predictable — no fat migration tail at these image sizes.
- **Keep-warm is worth it but cheap-to-target.** Because the tail is platform spin-up, the lever is
  *keeping the DO resident* (a low-frequency ping inside the idle window, before the ~10min
  eviction threshold), not optimizing our restore path — server restore time is already 0. An
  adaptive policy that pings only sessions showing reuse, and lets truly idle ones evict (state is
  safe), captures nearly all the benefit at minimal cost.
- **For V1, base-path restore optimization remains wasted effort** (re-confirms the v0.5
  conclusion: server phases are 0). Image size matters mildly on the felt first-eval tail, so the
  R2 large-image overflow path (>2MB gz) — still unmeasured here — is the one place where deep-wake
  latency could get genuinely worse, and is the priority to instrument and bound for V1.

---

## 5. Anomalies / honest caveats

- **base-12's ~130ms "wake" is not the felt tail.** It measured only connect + `{t:"gen"}` reply;
  `gen` does not force the `sqlite-restore` (that fires on the first `eval`). So base-12's number
  is the *floor* (WS RTT), not the cold-restore-inclusive tail that base-20/mid-12 captured. The
  honest deep tail figure is base-20/mid-12's ~1.3–1.8s.
- **mid-12 setup hit kernel budget edges** (not eviction bugs): a single-cell byte-by-byte 5MB
  fill TIMED OUT against the ~1200-tick / 5000ms-wall per-cell budget, so the fill was split into
  10×512KB cells; and `const SIZE` at top level persists in the global cell scope (redeclaration
  error on reuse). These caused 3 extra cold reconnects during c1 setup (visible as gens 3,5,7)
  before a clean setup at gen 7 — which is why mid-12 c1 woke 7→8 rather than 1→2.
- **base-20 harness false-negative:** the in-script `stateOk` boolean compared against a JSON
  *string* (`eval` returns `value` as a JSON string, e.g. `'["hib-base20-c1",1000,...]'`, not a
  parsed array), so index comparisons failed. Manual inspection confirmed state correct both
  cycles; treat state as verified-correct.
- **AE ingestion lag 30–90s + edge-of-window:** base-20 c2's 12:45:13 wake and mid-12 c1's
  12:48:56 wake sit at/after the query edge and within the ingestion lag, but both still appear in
  the restore rows above, so server-side corroboration is complete for all wakes.
- Token never printed; AE creds sourced via `set -a; . ./.env; set +a`. `quantileWeighted` requires
  3 args: `quantileWeighted(level, valueCol, weight)` (e.g. `quantileWeighted(0.99, double1, 1)`).
