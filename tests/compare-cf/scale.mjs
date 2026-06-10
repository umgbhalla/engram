// scale.mjs — open-loop concurrency driver.
//
// Spawns N concurrent fresh sessions; each does create -> eval(secret) -> evict ->
// reconnect -> read-back. Records: error rate, latency histogram (p50/p95/p99 of the full
// create->reconnect->read round-trip), and an isolation check (no cross-session state
// bleed: each session reads back exactly its own secret, and a sibling probe is null).
//
// Resilient to transient WS blips (bounded retries with small backoff). Modest default
// N=40 to avoid hammering prod.
//
// Usage (via run.mjs, or standalone):
//   import { runScale } from "./scale.mjs";
//   const r = await runScale(adapter, { N: 40, sidPrefix: "scale" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { tries = 3, backoffMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await sleep(backoffMs * (i + 1)); }
  }
  throw lastErr;
}

function percentiles(arr) {
  if (!arr.length) return { p50: null, p95: null, p99: null, min: null, max: null };
  const s = [...arr].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { p50: pct(50), p95: pct(95), p99: pct(99), min: s[0], max: s[s.length - 1] };
}

export async function runScale(adapter, opts = {}) {
  const N = opts.N ?? Number(process.env.SCALE_N || 40);
  const prefix = opts.sidPrefix || "scale";
  const stamp = Date.now();

  const latencies = [];
  const results = { N, errors: 0, isolationViolations: 0, killsOrClose: 0, leaks: [] };

  async function oneSession(i) {
    const sid = `${prefix}-${stamp}-${i}`;
    const secret = `S-${sid}`;
    const t0 = Date.now();
    try {
      // create + write secret
      await withRetry(async () => {
        const s = await adapter.connect(sid);
        await s.create({});
        const w = await s.eval(`globalThis.secret=${JSON.stringify(secret)}; globalThis.secret`);
        if (w.value !== secret) throw new Error("write mismatch");
        try { await s.evict(); } catch { /* ignore */ }
        await s.close();
      });

      // reconnect + read back (cold restore path on engram)
      const rr = await withRetry(async () => {
        const s = await adapter.reconnect(sid);
        const r = await s.eval("globalThis.secret");
        // sibling-bleed probe: no other session's secret may be visible here
        const sib = await s.eval(`(typeof globalThis.__sibling__!=="undefined")?globalThis.__sibling__:null`);
        await s.close();
        return { read: r.value, sibling: sib.value, restoreSource: r.restoreSource, inMemoryBefore: r.inMemoryBefore };
      });

      latencies.push(Date.now() - t0);

      if (rr.read !== secret) {
        results.isolationViolations++;
        results.leaks.push({ sid, expected: secret, got: rr.read });
      }
      if (rr.sibling) {
        results.isolationViolations++;
        results.leaks.push({ sid, siblingBleed: rr.sibling });
      }
    } catch (e) {
      results.errors++;
      if (/closed|1006|kill/i.test(String(e.message))) results.killsOrClose++;
    }
  }

  // Open-loop: fire all N concurrently.
  await Promise.all(Array.from({ length: N }, (_, i) => oneSession(i)));

  results.latencyMs = percentiles(latencies);
  results.completed = latencies.length;
  results.errorRate = N ? results.errors / N : 0;
  results.clean = results.errors === 0 && results.isolationViolations === 0 && results.killsOrClose === 0;
  return results;
}

// Standalone runner (engram only, for quick local use).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { makeEngramAdapter } = await import("./engram-adapter.mjs");
  const adapter = makeEngramAdapter();
  const r = await runScale(adapter, { N: Number(process.env.SCALE_N || 40) });
  console.log(JSON.stringify(r, null, 2));
}
