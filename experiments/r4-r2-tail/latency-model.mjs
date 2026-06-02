// latency-model.mjs — R2 GET latency model calibrated to REALCF-VALIDATION.md.
//
// MEASURED GROUND TRUTH (docs/REALCF-VALIDATION.md, engram-bench, >2MB-gz heaps):
//   single R2 GET: warm p50 297ms / p95 591ms ; cold p50 908ms / p95 1771ms.
//   totalMs == readMs (R2 GET dominates the whole restore wall-clock).
//   SQLite reads are synchronous, ~0ms in-turn.
//   ~5MB image (v0.4) measured readMs ~597ms.
//
// We decompose a single-object R2 GET into:
//   T_get(bytes) = T_conn + bytes / BW
// where T_conn is the per-object connection/TTFB latency (the bulk of the cost
// for cold) and BW is effective per-stream throughput. We solve for parameters
// that reproduce the measured points, separately for WARM and COLD regimes.
//
// Calibration targets (object = the gz blob actually transferred):
//   We size the canonical test as a 5MB *incompressible* image. Incompressible =>
//   gz ~= raw (the only case that genuinely hits R2 per REALCF: ">2MB-GZ"). So the
//   transferred object is ~5MB.
//
//   WARM: want T_get(5MB) ~= 300ms (p50 297). COLD: ~= 900ms (p50 908).
//   p95 tail modeled by a jitter multiplier so a single cold object can reach ~1.77s.
//
// Decomposition chosen (and justified by the numbers below):
//   WARM:  T_conn = 120ms, BW = 30 MB/s  -> 120 + 5/30*1000 = 120+167 = 287ms ~ 297  ✓
//   COLD:  T_conn = 740ms, BW = 30 MB/s  -> 740 + 167 = 907ms ~ 908  ✓
//   (cold's extra ~620ms is DO/isolate cold-spin + first-byte; bandwidth same wire.)
//
// PARALLELISM model: K concurrent GETs to distinct objects.
//   - The per-object connection latency T_conn OVERLAPS across streams (independent
//     round-trips fired together) — this is the lever chunked-parallel exploits.
//   - Bandwidth is a SHARED pipe of total BW_total; with K streams each gets
//     BW_total/min(K, K) but the pipe saturates: total transfer time for the whole
//     image is the same whether 1 or K streams (you still move the same bytes over
//     the same wire). We model a modest parallel-BW bonus (multiple TCP streams beat
//     a single stream on a fat long-RTT pipe) capped at PAR_BW_GAIN.
//   So wall-clock for K parallel GETs of an N-byte image split evenly:
//       T_conn  (paid ONCE, overlapped)
//     + N / (BW * min(K, PAR_BW_GAIN))   (transfer, with diminishing parallel BW gain)
//     + scheduling jitter on the slowest stream (straggler) ~ small.
//
//   This is the honest model: parallelism removes (K-1) serial T_conn waits — that's
//   the big win — and gives a bounded bandwidth multiple, not K×.

export const MB = 1024 * 1024;

export const PARAMS = {
  warm: { connMs: 120, bwMBps: 30 },
  cold: { connMs: 740, bwMBps: 30 },
  // multiple parallel TCP streams beat a single stream on a long-RTT fat pipe,
  // but with strong diminishing returns. Effective BW multiplier caps here.
  parBwGain: 3,
  // straggler: the slowest of K parallel streams runs a bit long.
  stragglerFrac: 0.10,
};

/** Single-object GET latency (ms) for `bytes` over the wire, warm/cold. */
export function singleGetMs(bytes, regime = 'cold') {
  const p = PARAMS[regime];
  return p.connMs + (bytes / MB) / p.bwMBps * 1000;
}

/**
 * Wall-clock (ms) to fetch a total of `totalBytes` split into `k` equal objects,
 * fired concurrently. connMs paid once (overlapped); transfer over a pipe whose
 * effective bandwidth scales by min(k, parBwGain).
 */
export function parallelGetMs(totalBytes, k, regime = 'cold') {
  const p = PARAMS[regime];
  if (k <= 1) return singleGetMs(totalBytes, regime);
  const effBw = p.bwMBps * Math.min(k, PARAMS.parBwGain);
  const transfer = (totalBytes / MB) / effBw * 1000;
  // straggler: slowest stream carries ~ (1+stragglerFrac)/k of the bytes.
  const stragglerBytes = (totalBytes / k) * (1 + PARAMS.stragglerFrac);
  const stragglerTransfer = (stragglerBytes / MB) / p.bwMBps * 1000;
  // wall-clock = conn (overlapped once) + max(even-split transfer, straggler tail)
  return p.connMs + Math.max(transfer, stragglerTransfer);
}

/**
 * Streaming gunzip overlap: if we gunzip chunks AS they arrive, the gunzip CPU
 * overlaps the network wait, so it adds ~0 to wall-clock (gunzip is ms-scale and
 * the network is the bottleneck). We model the *non-overlapped* gunzip cost we'd
 * otherwise pay after the last byte: ~ gunzipMBps throughput on the COMPRESSED in.
 * On workerd the in-turn clock freezes CPU (gunzip reads 0ms), but off the wire a
 * real machine pays it; we surface it so the streaming win is visible.
 */
export const GUNZIP_MBPS = 250; // node zlib gunzip ~250+ MB/s of OUTPUT; conservative
export function gunzipMs(rawBytes) {
  return (rawBytes / MB) / GUNZIP_MBPS * 1000;
}
