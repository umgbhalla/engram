// durable-counter — prove live state survives a FULL eviction + cold restart.
//
//   ENGRAM_ENDPOINT=wss://engram-kernel.<acct>.workers.dev node durable-counter.ts
//
// The counter is never re-initialized after the first cell. hibernateThenResume() throws away
// the in-memory kernel and forces a cold restore from the snapshot — `count` comes back intact,
// NO replay.
//
// Expected output:
//   start: 0
//   after ++:  1
//   --- hibernate + cold restore ---
//   restoreSource: sqlite-restore   generation bumped: true
//   after wake ++: 2   <-- count SURVIVED; closures/promises would too

import { Engram } from "@engram/sdk";

const url = process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.example.workers.dev";
const WebSocket = (await import("ws")).default;

const s = await Engram.connect({ url, session: "durable-counter", config: { clock: "seeded" }, WebSocket });

await s.reset(); // start clean for a repeatable demo
console.log("start:", (await s.eval("globalThis.count = 0; count")).value);
console.log("after ++: ", (await s.eval("++count")).value);

const before = await s.status();
console.log("--- hibernate + cold restore ---");
const { restoreSource, generation } = await s.hibernateThenResume();
console.log("restoreSource:", restoreSource, "  generation bumped:", generation !== before.generation);

const r = await s.eval("++count");
console.log("after wake ++:", r.value, "<-- count SURVIVED");

s.close();
