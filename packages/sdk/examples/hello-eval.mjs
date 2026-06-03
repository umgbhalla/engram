// hello-eval — the simplest thing: connect, eval, see a value.
//
//   ENGRAM_ENDPOINT=wss://engram-kernel.<acct>.workers.dev node hello-eval.mjs
//
// Expected output:
//   value: ready
//   1 + 41 = 42
//   array value: [ 2, 4, 6 ]   (parsed back into a real array)

import { Engram } from "@engram/sdk";

const url = process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.example.workers.dev";
const WebSocket = (await import("ws")).default; // Node; browsers use the native one

const s = await Engram.connect({ url, session: "hello-eval", WebSocket });

const a = await s.eval("globalThis.greeting = 'ready'; greeting");
console.log("value:", a.value);

const b = await s.eval("1 + 41");
console.log("1 + 41 =", b.value);

const c = await s.eval("[1, 2, 3].map((x) => x * 2)");
console.log("array value:", c.value); // objects/arrays come back parsed, not as a string

s.close();
