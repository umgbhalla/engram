/**
 * EngramClient — managing a FLEET of durable sessions behind one set of defaults.
 *
 * The substrate pattern: your service maps an inbound id (user / project / conversation) to a
 * durable Engram session. EngramClient reuses one live session per id, dedupes concurrent
 * connects, and gives you fleet-wide lifecycle ops — so a request handler is just
 * `client.eval(id, code)`.
 *
 * Node: `npm i ws` and pass it through. Browser/Worker: omit `WebSocket`.
 */
import { EngramClient, presets, defineConfig } from "@engram/sdk";

const URL = process.env.ENGRAM_ENDPOINT || "wss://engram-kernel.example.workers.dev";

async function main() {
  // Node WebSocket bridge (omit in browser/Worker).
  const WebSocket = (await import("ws")).default;

  const client = new EngramClient({
    url: URL,
    WebSocket,
    // One config posture for the whole fleet — validated up front.
    config: defineConfig({ ...presets.deterministic(42), cellBudgetTicks: 1500 }),
    // Fleet-wide eval tracing.
    onEval: async (code, _opts, next) => {
      const r = await next(code);
      console.log(`[trace] ok=${r.ok} cell=${r.cell}`);
      return r;
    },
  });

  // Two users, each with their own durable namespace.
  await client.eval("user:alice", "globalThis.score = 10");
  await client.eval("user:bob", "globalThis.score = 99");

  // Re-attach by id — same live session, state intact.
  const a = await client.eval("user:alice", "score + 1"); // 11
  const b = await client.eval("user:bob", "score + 1"); // 100
  console.log("alice:", a.value, "bob:", b.value);

  console.log("fleet size:", client.size, "ids:", client.ids());
  console.log("status:", await client.statusAll());

  // Hibernate the whole fleet (snapshots persist; next eval cold-restores).
  await client.evictAll();

  // Tear down local handles — durable heaps live on server-side, reattachable anytime.
  await client.closeAll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
