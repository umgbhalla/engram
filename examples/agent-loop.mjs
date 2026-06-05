// examples/agent-loop.mjs — an RLM-style agent loop, built ENTIRELY on @engram/sdk.
//
// This is the canonical illustration that "RLM" is an APPLICATION PATTERN, not a kernel
// feature. The Engram kernel ships only a GENERIC VM->client host-callback bridge: a cell's
// `host.<name>(...)` parks the durable VM and round-trips to whatever the CLIENT registers.
// Here the client registers `host.subLM` (a stand-in LLM) and the cell contains a plain
// convergence loop that calls it until a fixpoint. Nothing about loops / "final" / convergence
// lives in the kernel — it's all in this file.
//
// Run (Node):  node examples/agent-loop.mjs
//   optional:  ENGRAM_ENDPOINT=wss://engram-kernel.<acct>.workers.dev node examples/agent-loop.mjs
//
// Swap the `subLM` body for a real provider call (fetch to OpenAI/Anthropic/etc.) to drive a
// genuine agent loop — the loop, the durable state, and the stop condition stay in the cell.

import WebSocket from "ws";
import { connect } from "@engram/sdk";

const url = process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.umg-bhalla88.workers.dev";

const session = await connect({
  url,
  session: "example-agent-" + Date.now(),
  WebSocket,
  throwOnError: false,
  config: { clock: "seeded", rngSeed: 7 },
  // The client-side "LLM". The kernel knows nothing about this name — it just bridges the call
  // back to us. Replace with a real fetch() to a model API to make it a real agent.
  host: {
    subLM: async (prompt) => {
      // deterministic stand-in: wrap the prompt so the loop visibly progresses + converges.
      return `LM<${String(prompt).slice(0, 120)}>`;
    },
  },
});

// The agent loop is ORDINARY user code in a durable cell. It iterates host.subLM until the
// answer stops changing (a fixpoint) or hits a step cap — the stop condition is ours, not the
// kernel's. State persists across cells and survives hibernation.
const loop = `
let answer = 'seed';
let prev = null;
let steps = 0;
while (answer !== prev && steps < 6) {
  prev = answer;
  answer = await host.subLM(answer);   // parks the VM, calls back to the client, resumes
  steps++;
}
({ answer, steps, converged: answer === prev })
`;

const r = await session.eval(loop);
console.log("agent loop result:", JSON.stringify(r.value, null, 2));
console.log("ok:", r.ok, "valueType:", r.valueType);

// The loop's final state is durable — a later cell (or a cold restart) still sees it.
const recall = await session.eval("({ lastAnswer: answer, lastSteps: steps })");
console.log("recalled durable state:", JSON.stringify(recall.value));

session.close();
process.exit(r.ok ? 0 : 1);
