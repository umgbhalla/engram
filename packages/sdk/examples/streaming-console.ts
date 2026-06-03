// streaming-console — capture console.* output from a cell.
//
//   ENGRAM_ENDPOINT=wss://engram-kernel.<acct>.workers.dev node streaming-console.ts
//
// Two ways to read console output:
//   (1) the `onConsole` callback at connect — fires for EVERY captured line, across all cells;
//   (2) result.console — the full ordered buffer for one eval ({ level, text }).
// "Streaming" here = you get the whole ordered log buffer back with the result, not a token stream.
//
// Expected output:
//   [live] log    starting work...
//   [live] log    processed item 0
//   [live] log    processed item 1
//   [live] log    processed item 2
//   [live] warn   almost done
//   [live] error  (simulated) something noisy
//   --- result.console ---  (6 lines)
//   result value: done (3 items)

import { Engram } from "@engram/sdk";

const url = process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.example.workers.dev";
const WebSocket = (await import("ws")).default;

const s = await Engram.connect({
  url,
  session: "streaming-console",
  config: { capture: true, clock: "seeded" },
  WebSocket,
  onConsole: (line) => console.log(`[live] ${line.level.padEnd(6)} ${line.text}`),
});

const r = await s.eval(`
  console.log("starting work...");
  let n = 0;
  for (let i = 0; i < 3; i++) { console.log("processed item " + i); n++; }
  console.warn("almost done");
  console.error("(simulated) something noisy");
  "done (" + n + " items)";
`);

console.log(`--- result.console ---  (${r.console.length} lines)`);
console.log("result value:", r.value);

s.close();
