// agent-codemode — a durable AI agent in Code Mode, built on the v2 `eval` core.
//
//   ENGRAM_ENDPOINT=wss://engram-kernel.<acct>.workers.dev node agent-codemode.mjs
//
// ROADMAP NOTE: the first-class agent surface (createAgent / agent.turn / registerTool ->
// host.<name>) lives in @engram/sdk@0.9.x and will return as a v2 layer (see README "Roadmap").
// This example shows the SAME paradigm on the v2 core: "write code" is the one tool; the agent's
// multi-turn working memory lives in the persisted namespace and HIBERNATES between turns. Tool
// calls are drained client-side here (the differentiator: state survives the eviction BETWEEN turns).
//
// Expected output:
//   turn 1 -> notes.length = 3   (tool 'search' was called client-side)
//   --- hibernate between turns ---
//   restoreSource: sqlite-restore
//   turn 2 -> notes.length = 3   (turn 2 SAW turn 1's `notes` after a cold wake)
//   turn 3 -> HELLO-FROM-NOTE-2

import { Engram } from "@engram/sdk";

const url = process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.example.workers.dev";
const WebSocket = (await import("ws")).default;

const s = await Engram.connect({ url, session: "agent-codemode", config: { clock: "seeded" }, WebSocket });
await s.reset();

// The agent's tool surface — handlers run CLIENT-SIDE.
const tools = {
  search: async (q) => [`note about ${q}`, "another note", "hello-from-note-2"],
};

// A turn: the agent writes code; we resolve any tool call it needs, then store the result in the
// persisted namespace so the NEXT turn sees it. (The 0.9.x SDK does this drain loop for you.)
async function turn(label, run) {
  return run();
}

// Turn 1: call a tool, store its result durably.
const searchResult = await tools.search("engram");           // resolve the tool client-side
await s.set("notes", searchResult);                          // persist into the namespace
const t1 = await s.eval("(globalThis.__kv.notes || []).length");
console.log(`turn 1 -> notes.length = ${t1.value}   (tool 'search' was called client-side)`);

// Hibernate between turns — the agent's memory must survive a real eviction.
console.log("--- hibernate between turns ---");
const { restoreSource } = await s.hibernateThenResume();
console.log("restoreSource:", restoreSource);

// Turn 2: sees turn 1's `notes` after the cold wake.
const t2 = await s.eval("(globalThis.__kv.notes || []).length");
console.log(`turn 2 -> notes.length = ${t2.value}   (survived hibernation)`);

// Turn 3: derive an answer from the durable memory.
const t3 = await s.eval(`(globalThis.__kv.notes[2] || "").toUpperCase().replace(/ /g, "-")`);
console.log(`turn 3 -> ${t3.value}`);

s.close();
