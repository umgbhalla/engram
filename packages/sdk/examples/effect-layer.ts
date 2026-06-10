/**
 * @engram/sdk/effect — driving the durable kernel with Effect v4.
 *
 * Requires the optional peer dep: `npm i effect@^4.0.0-beta`.
 *
 * Shows the three idioms: a scoped session that auto-closes, eval in the typed error channel,
 * and a fleet eval via EngramClient — all composed as one Effect and run at the edge.
 */
import { Effect } from "effect";
import { EngramClient, presets } from "@engram/sdk";
import { acquireSession, evalEffect, clientEvalEffect } from "@engram/sdk/effect";

const URL = process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.example.workers.dev";

// A scoped program: the session is closed automatically when the scope ends (even on failure).
const single = Effect.scoped(
  Effect.gen(function* () {
    const WebSocket = (yield* Effect.promise(() => import("ws"))).default;
    const s = yield* acquireSession({ url: URL, session: "effect-demo", WebSocket, config: presets.deterministic() });
    yield* evalEffect(s, "globalThis.x = 41");
    const r = yield* evalEffect(s, "x + 1");
    return r.value; // 42
  }),
);

// A fleet program over EngramClient.
async function fleet() {
  const WebSocket = (await import("ws")).default;
  const client = new EngramClient({ url: URL, WebSocket, config: presets.deterministic() });
  const program = Effect.all([
    clientEvalEffect(client, "user:a", "1 + 1"),
    clientEvalEffect(client, "user:b", "2 + 2"),
  ]);
  const [a, b] = await Effect.runPromise(program);
  console.log("a:", a.value, "b:", b.value);
  await client.closeAll();
}

async function main() {
  console.log("single:", await Effect.runPromise(single));
  await fleet();
}

main().catch((e) => { console.error(e); process.exit(1); });
