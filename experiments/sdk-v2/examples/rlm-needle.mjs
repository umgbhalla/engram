// rlm-needle — find a needle in a big context, RLM-style, built on the v2 `eval` core.
//
//   ENGRAM_ENDPOINT=wss://engram-kernel.<acct>.workers.dev node rlm-needle.mjs
//
// ROADMAP NOTE: the first-class RLM surface (setContext + host.ctx.* + host.subLM + session.rlm)
// lives in @engram/sdk@0.9.x and will return as a v2 layer (see README "Roadmap"). This example
// shows the SAME pattern hand-wired on the v2 core's `eval` + durable namespace, so it runs today:
//   * the big doc is stored ONCE in the persisted namespace (globalThis.__doc) — it survives
//     hibernation like any global, kept out of your client between cells;
//   * the cell greps/chunks it in-VM and the CLIENT (this script) is the "sub-LM" oracle that
//     decides per chunk. We drain a queue of chunk questions through a client-side model stub.
//
// Expected output:
//   doc chars: 22000+
//   chunks: 6
//   answer: FOUND: the needle is "ENGRAM-42"

import { Engram } from "@engram/sdk";

const url = process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.example.workers.dev";
const WebSocket = (await import("ws")).default;

const NEEDLE = "ENGRAM-42";
const filler = "the quick brown fox jumps over the lazy dog. ".repeat(500);
const doc = filler + `\n>>> SECRET TOKEN: ${NEEDLE} <<<\n` + filler;

const s = await Engram.connect({ url, session: "rlm-needle", config: { clock: "seeded" }, WebSocket });
await s.reset();

// Store the big context once in the persisted namespace (survives hibernation).
await s.set("__doc", doc);
console.log("doc chars:", (await s.eval("(globalThis.__kv.__doc || '').length")).value);

// Chunk it in-VM and pull the chunk texts out to the client (the "sub-LM" oracle).
const CHUNK = 4000;
const chunks = await s.eval(`
  const d = globalThis.__kv.__doc || "";
  const out = [];
  for (let i = 0; i * ${CHUNK} < d.length; i++) out.push(d.slice(i * ${CHUNK}, (i + 1) * ${CHUNK}));
  out;
`);
console.log("chunks:", chunks.value.length);

// YOUR model backend (a real one calls an LLM). It inspects each chunk for the needle.
const subLM = async (text) => (text.includes(NEEDLE) ? `FOUND: the needle is "${NEEDLE}"` : null);

let answer = "not found";
for (const text of chunks.value) {
  const hit = await subLM(text);
  if (hit) { answer = hit; break; }
}
console.log("answer:", answer);

s.close();
