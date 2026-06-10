// run.mjs — comparison harness entry point.
//
//   node run.mjs --target engram        (default)
//   node run.mjs --target cf            (requires CF_SANDBOX_BASE; see cf-sandbox/README.md)
//
// Optional flags:
//   --probes cap1,cap4        run a subset (comma-separated cap ids or fn-name prefixes)
//   --scale-n 40              concurrency for the scale driver (0 to skip)
//   --idle-ms 3000            CAP-5 idle wait (set ~1200000 for the genuine 20-min test)
//   --wake-samples 12         CAP-6 sample count
//   --iso-k 12                CAP-7 inline isolation fan-out
//   --counter <url>           CAP-2 external counter endpoint (…/bump?sid=)
//   --base <host>             override engram WS host (default engram-kernel.…workers.dev)
//
// Prints a single JSON object: { target, base, startedAt, durationMs, probes:[...], scale:{...} }.

import { makeEngramAdapter } from "./engram-adapter.mjs";
import { makeCfSandboxAdapter } from "./cf-sandbox-adapter.mjs";
import { ALL_PROBES } from "./probes.mjs";
import { runScale } from "./scale.mjs";

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const name = k.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { a[name] = next; i++; }
      else a[name] = true;
    }
  }
  return a;
}

const args = parseArgs(process.argv);
const target = (args.target || "engram").toLowerCase();

const adapter = target === "cf"
  ? makeCfSandboxAdapter({ base: process.env.CF_SANDBOX_BASE })
  : makeEngramAdapter({ base: args.base });

if (target === "cf" && adapter.configured === false) {
  console.error("WARNING: CF_SANDBOX_BASE not set — CF probes will fail loud. Deploy cf-sandbox/ first.");
}

let probeFilter = null;
if (typeof args.probes === "string") {
  const wanted = args.probes.split(",").map((s) => s.trim().toLowerCase());
  probeFilter = (fn) => wanted.some((w) => fn.name.toLowerCase().includes(w.replace(/-/g, "")));
}

// session-id factory: unique per run so identities are isolated.
const runStamp = Date.now();
let counter = 0;
const ctx = {
  sid: (prefix) => `cmp-${target}-${prefix}-${runStamp}-${counter++}`,
  idleMs: args["idle-ms"] ? Number(args["idle-ms"]) : 3000,
  wakeSamples: args["wake-samples"] ? Number(args["wake-samples"]) : 12,
  isoK: args["iso-k"] ? Number(args["iso-k"]) : 12,
  counterEndpoint: typeof args.counter === "string" ? args.counter : null,
};

const startedAt = new Date().toISOString();
const t0 = Date.now();

const probes = probeFilter ? ALL_PROBES.filter(probeFilter) : ALL_PROBES;
const probeResults = [];
for (const probe of probes) {
  const r0 = Date.now();
  let res;
  try {
    res = await probe(adapter, ctx);
  } catch (e) {
    res = { capability: probe.name, outcome: "ERROR", evidence: { exception: e.message } };
  }
  res.tookMs = Date.now() - r0;
  probeResults.push(res);
}

let scale = null;
const scaleN = args["scale-n"] !== undefined ? Number(args["scale-n"]) : 40;
if (scaleN > 0) {
  try {
    scale = await runScale(adapter, { N: scaleN, sidPrefix: `cmp-${target}-scale-${runStamp}` });
  } catch (e) {
    scale = { error: e.message };
  }
}

const out = {
  target,
  base: adapter.base,
  startedAt,
  durationMs: Date.now() - t0,
  summary: probeResults.map((p) => ({ capability: p.capability, outcome: p.outcome })),
  probes: probeResults,
  scale,
};

console.log(JSON.stringify(out, null, 2));
