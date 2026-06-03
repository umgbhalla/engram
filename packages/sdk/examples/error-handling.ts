// error-handling — every error class is a CATCHABLE typed exception, not a crash. The socket
// stays alive through ordinary JS errors, infinite loops, alloc bombs, and blocked fetches; the
// next eval always works. This is the kernel's hardening guarantee.
//
//   ENGRAM_ENDPOINT=wss://engram-kernel.<acct>.workers.dev node error-handling.ts
//
// By default eval() THROWS a typed EngramError subclass on a failed cell. Pass
// { throwOnError: false } (at connect or per-eval) to get { ok:false, error } back instead.
//
// Expected output (the cell stays recoverable in every case):
//   1. ordinary JS error      threw EngramError(ReferenceError)   | next eval: 42
//   2. infinite loop          threw TimeoutError                  | next eval: 42
//   3. alloc bomb             threw MemoryLimitError              | next eval: 42
//   4. blocked fetch          threw FetchBlockedError             | next eval: 42
//   5. throwOnError:false     -> { ok:false, error.name:"ReferenceError" }

import { Engram, EngramError, TimeoutError, MemoryLimitError, FetchBlockedError } from "@engram/sdk";

const url = process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.example.workers.dev";
const WebSocket = (await import("ws")).default;

const s = await Engram.connect({
  url,
  session: "error-handling",
  config: { clock: "seeded", fetch: ["api.allowed.example"] }, // other hosts are blocked
  WebSocket,
});

async function probe(label, src) {
  let threw = "(none)";
  try {
    await s.eval(src, { timeoutMs: 30000 });
  } catch (e) {
    threw =
      e instanceof TimeoutError ? "TimeoutError"
      : e instanceof MemoryLimitError ? "MemoryLimitError"
      : e instanceof FetchBlockedError ? "FetchBlockedError"
      : e instanceof EngramError ? `EngramError(${e.name})`
      : `(unexpected) ${e}`;
  }
  const next = await s.eval("21 + 21"); // the socket must still be alive
  console.log(`${label.padEnd(24)} threw ${threw.padEnd(34)} | next eval: ${next.value}`);
}

await probe("1. ordinary JS error", "thisIsNotDefined");
await probe("2. infinite loop", "while (true) {}");
await probe("3. alloc bomb", "const a=[]; for(;;){ a.push(new Array(200000).fill(7)); }");
await probe("4. blocked fetch", "await host.fetch('https://evil.example/x')");

// Opt out of throwing — get the structured result instead:
const r = await s.eval("thisIsNotDefined", { throwOnError: false });
console.log("5. throwOnError:false     ->", { ok: r.ok, "error.name": r.error?.name });

s.close();
