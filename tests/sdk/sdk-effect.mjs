#!/usr/bin/env node
// Tests for the OPTIONAL @engram/sdk/effect (Effect v4) layer. Offline (mock transport).
// Requires `effect` installed (peer dep). Run: node tests/sdk/sdk-effect.mjs
import { Effect } from "effect";
import { EngramClient } from "../../packages/sdk/dist/index.mjs";
import { connectEffect, evalEffect, acquireSession, clientEvalEffect } from "../../packages/sdk/dist/effect.mjs";

let pass = 0, fail = 0;
const ck = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };

function mock() {
  let closed = false;
  return {
    isClosed: () => closed,
    transport: {
      supportsHostCalls: true,
      async request(f) {
        if (f.t === "eval") {
          if (String(f.src).startsWith("THROW")) return { ok: false, error: { name: "TimeoutError", message: "boom" }, logs: [] };
          return { ok: true, value: f.src.length, valueType: "number", logs: [] };
        }
        return { ok: true, generation: 1, inMemory: true };
      },
      setHost() {}, close() { closed = true; },
    },
  };
}

// 1) connectEffect + evalEffect through runPromise
{
  const m = mock();
  const r = await Effect.runPromise(Effect.flatMap(connectEffect({ transport: m.transport, session: "e1" }), (s) => evalEffect(s, "abcd")));
  ck("connectEffect + evalEffect", r.value === 4, `v=${r.value}`);
}

// 2) acquireSession scoped — closes transport when the scope ends
{
  const m = mock();
  const r = await Effect.runPromise(Effect.scoped(Effect.flatMap(acquireSession({ transport: m.transport, session: "e2" }), (s) => evalEffect(s, "hi"))));
  ck("acquireSession scoped eval", r.value === 2, `v=${r.value}`);
  ck("acquireSession auto-closes on scope end", m.isClosed() === true);
}

// 3) failed cell -> Effect failure channel as a typed EngramError
{
  const m = mock();
  const prog = Effect.flatMap(connectEffect({ transport: m.transport, session: "e3" }), (s) => evalEffect(s, "THROW now"));
  const exit = await Effect.runPromiseExit(prog);
  ck("failed cell -> Effect failure", exit._tag === "Failure", `tag=${exit._tag}`);
  let name = "";
  try { await Effect.runPromise(prog); } catch (e) { name = e?.name || e?.cause?.name || String(e); }
  ck("error is typed (TimeoutError)", /Timeout/.test(name), name);
}

// 4) clientEvalEffect over EngramClient
{
  const m = mock();
  const client = new EngramClient({ transport: () => m.transport });
  const r = await Effect.runPromise(clientEvalEffect(client, "u1", "xyz"));
  ck("clientEvalEffect via client", r.value === 3, `v=${r.value}`);
  await client.closeAll();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
