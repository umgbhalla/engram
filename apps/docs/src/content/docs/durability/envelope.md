---
title: Operating envelope
description: The measured size, latency, and concurrency ceilings.
---

All numbers are measured on production workerd. The bet holds with **HIGH confidence** — every
feasibility risk probed passed; the remaining constraints are *quantitative* (image-size ceilings),
not architectural.

## Headline numbers

- **Eval latency:** p50 ~255 ms; warm UI evals ~220–300 ms. Tail p99 ~3–4.4 s on cold-facet WASM
  instantiate.
- **Cold wake:** base ~130 ms; 5 MB image ~1.5–1.8 s; 20-min deep eviction ~1.5 s — platform-bound.
- **Throughput:** linear to ~146 evals/s at 150 concurrent sessions; **0% error, 100%
  state-correctness** at 80 / 120 / 150 concurrent.
- **Live heap ceiling:** 16 MB/cell (below the 18 MB dump ceiling; above the ~7 MB stdlib envelope).
- **Host args:** 8 MB inbound / outbound; `host.ctx.slice/get` capped at 1 MB.
- **Routing:** 64 shards × 128 facets; cap hit ⇒ typed rejection (no crash).
- **Snapshot size:** ~740 KB gz for a typical warm session.

## Size ceilings

| Dimension | Value |
|---|---|
| MAX live namespace (no snapshot) | >193 MB (no 128 MB cap) |
| MAX snapshot-able live memory | ~57 MB last-OK; hard wall ~60–61 MB |
| Production snapshot guard | refuse grow / snapshot above ~45–50 MB live |
| MAX raw snapshot for fast (<1 s p50) resume | ~21 MB raw / ~14 MB gz |
| Conservative safe raw image | ≤ ~20 MB raw |
| DO crash ceiling (back-to-back restore) | Error 1102 at ~27–32 MB raw |
| Real-kernel gz ratio | ~12× → 20 MB raw ≈ 1.7 MB gz |

## Restore latency by size

| Raw | Gzip | p50 | p95 |
|---|---|---|---|
| 1.25 MB | 0.10 MB | 231 ms | 493 ms |
| ~7 MB | 2.8 MB | 275 ms | 600 ms |
| ~11 MB | 6.2 MB | 299 ms | 1082 ms |
| ~14 MB | 8.8 MB | 415 ms | 911 ms |
| ~21 MB | 13.9 MB | 385 ms | 1075 ms |
| ~27 MB | — | DO crash (1102 / WS 1006) | — |

Latency is **100% R2 network, ~0% compute** — gunzip + deserialize + instantiate + blit + globals
are all sub-ms even at 30 MB. The p95 > 1 s tails are R2 cold-first-fetch variance, not a size wall;
warm is ~250–400 ms. **Latency tracks gz size; the crash ceiling tracks raw size.**
