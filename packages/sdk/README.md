# @engram/sdk

A clean, ergonomic TypeScript client for the durable **Engram** kernel — a stateful JavaScript
REPL on Cloudflare whose live namespace (variables, closures, pending promises) **survives idle
eviction and cold restart**. No replay, no re-firing side effects.

One entry point — `Engram.connect()` — gives you a tiny, well-typed session that:

- evals code against a **persisted namespace** (`x=1` in one cell, `x` in the next returns `1`);
- **survives hibernation** (the QuickJS heap is snapshotted to the Durable Object's SQLite and
  blitted back on wake);
- **throws typed errors** (`TimeoutError`, `MemoryLimitError`, …) so a runaway cell is a catchable
  exception, never a crash;
- auto-detects **kernel (WebSocket)** vs **cloud (HTTP + API key)** from the same call;
- auto-reconnects with backoff and re-applies config on reconnect.

> **API status (honest):** this documents `@engram/sdk` **v2.0.0-rc** as implemented in
> `src/index.ts`. The core REPL + durability + typed-error surface is **proven live** on the
> deployed `engram-kernel` (24/24 functional, adversarial-hardened). The higher-level RLM /
> codemode / agent flows from the v0.9.x SDK are **not** in the v2 core yet — see
> [Roadmap](#roadmap-not-in-v2-core-yet). Signatures below match the v2 source exactly.

---

## 60-second quickstart

```bash
npm i @engram/sdk
# Node only — provide a WebSocket implementation:
npm i ws
```

```ts
import { Engram } from "@engram/sdk";

// In Node, pass a WebSocket impl. Browsers use the native one automatically.
const WebSocket = (await import("ws")).default;

// 1. Connect (creates the session, or reattaches to the hibernated heap if it exists)
const s = await Engram.connect({
  url: "wss://engram-kernel.<acct>.workers.dev",
  session: "my-session",
  config: { clock: "seeded" },
  WebSocket,
});

// 2. Eval against the live namespace
const r = await s.eval("globalThis.x = 41; x + 1");   // r.value === 42

// 3. Durable key/value sugar
await s.set("note", "hi");
console.log(await s.get("note"));                      // "hi"

// 4. Prove state survives a full eviction + cold restore
await s.eval("globalThis.count = 7");
await s.hibernateThenResume();                         // evict, then cold-restore from snapshot
console.log((await s.eval("count")).value);            // 7  — survived, NO replay

s.close();
```

That `7` is the whole thesis: `count` was never re-initialized. The heap came back from durable
storage.

---

## Concepts (read once)

- **Session** = one durable kernel instance keyed by `session` id. `connect()` is idempotent:
  same id → reattach the existing heap; new id → fresh kernel.
- **eval cell** = one execution against the persisted namespace. The cell's last expression is
  its value; `await` is allowed. Globals/closures/promises persist between cells.
- **hibernation** = sleep when idle, wake with full live state. State survives at ~0 idle cost.
- **typed errors** = a failed cell throws an `EngramError` subclass by default. The Durable
  Object is never killed; the socket stays alive; the next eval works.
- **determinism** = `clock:"seeded"` makes `Date.now`/`Math.random` deterministic, so a session
  is byte-identical across restore. Use `clock:"real"` to opt out.

---

## API reference

### `Engram.connect(options) → Promise<EngramSession>`

Open (or reattach) a durable session. Auto-detects transport: an `apiKey` **and** an
`http(s)://` url selects the multi-tenant **cloud** (HTTP); otherwise it opens a **WebSocket** to
the bare kernel.

```ts
const s = await Engram.connect({ url, session: "s1", config: { clock: "seeded" }, WebSocket });
```

#### `ConnectOptions`

| option | type | default | meaning |
|---|---|---|---|
| `url` | `string` | — (required) | `ws(s)://` kernel, or `http(s)://` cloud. Trailing slashes fine. |
| `session` | `string` | `"default"` | Durable session id. Same id reattaches the same heap. |
| `apiKey` | `string` | — | Cloud API key (`x-api-key`). Presence + an `http(s)` url → cloud HTTP path. |
| `config` | `EngramConfig` | `{}` | In-VM kernel config, applied once at connect, re-applied on reconnect. |
| `throwOnError` | `boolean` | `true` | Throw a typed `EngramError` on a failed cell. `false` → plain result. |
| `autoReconnect` | `boolean` | `true` | Reconnect with exponential backoff on transport drop. |
| `timeoutMs` | `number` | `60000` | Per-request timeout. |
| `WebSocket` | `ctor` | native | WebSocket impl; Node: `(await import('ws')).default`. |
| `onConsole` | `(line) => void` | — | Callback for every captured `console.*` line, all cells. |

#### `EngramConfig`

| field | type | meaning |
|---|---|---|
| `clock` | `"seeded" \| "real"` | seeded = deterministic `Date`/`Math` (byte-identical snapshots). |
| `rngSeed` | `number` | seed for the deterministic RNG with `clock:"seeded"`. |
| `cellBudgetTicks` | `number` | per-cell instruction budget (interrupt invocations). Raise for heavy loops. |
| `fetch` | `boolean \| string[]` | egress: `false`=block all, `true`=all, `[hosts]`=allowed hostnames. |
| `modules` | `boolean \| string[]` | in-VM stdlib bundle: `true`=defaults, `[names]`=subset. |
| `capture` | `boolean` | capture `console.*` per cell (default true). |
| `[k]` | `unknown` | any other kernel-recognised config key. |

### `session.eval(code, [opts]) → Promise<EvalResult<T>>`

Run one cell against the persisted namespace. `await` is allowed; the last expression is the
value. Throws a typed `EngramError` on failure unless `throwOnError:false`.

```ts
const r = await s.eval("[1,2,3].map(x => x*2)");
// r.ok=true, r.value=[2,4,6] (parsed from the preview), r.valueType="array",
// r.valuePreview="[ 2, 4, 6 ]", r.console=[], r.cell=N, r.checkpoint={...}
```

`opts`: `{ throwOnError?, timeoutMs? }` — per-call overrides.

`EvalResult<T>`:

| field | type | meaning |
|---|---|---|
| `ok` | `boolean` | `true` if the cell completed without throwing. |
| `value` | `T` | the completion value. Objects/arrays are **parsed back** from the kernel preview. |
| `valuePreview` | `string?` | util.inspect-style preview (always present for non-primitives). |
| `valueType` | `string?` | `"number"`/`"string"`/`"object"`/`"array"`/`"error"`/… |
| `console` | `ConsoleLine[]` | `{ level, text }` lines captured during the cell. |
| `error` | `{ name, message, stack? }?` | present when `ok===false`. |
| `checkpoint` | `Checkpoint?` | the durable snapshot committed after this cell. |
| `cell` | `number?` | monotonic cell index. |

`Checkpoint`: `{ ok, cell?, store?: "sqlite"|"r2", sizeGz?, sizeRaw?, usedHeap? }`.

### Durable key/value sugar

Ergonomic helpers over the persisted namespace (stored under a `globalThis.__kv` map, so they
survive hibernation like any other global).

| method | meaning |
|---|---|
| `session.set(key, value)` | store a JSON-serialisable value under `key`. |
| `session.get<T>(key)` | read it back; `undefined` if absent. |

```ts
await s.set("user", { id: 7, name: "ada" });
const u = await s.get<{ id: number; name: string }>("user"); // { id: 7, name: "ada" }
```

### Lifecycle / durability

| method | returns | meaning |
|---|---|---|
| `session.status()` | `Promise<{ generation?, inMemory?, … }>` | liveness + generation probe. |
| `session.evict()` | `Promise<void>` | force-evict the in-memory kernel; snapshot kept. |
| `session.hibernateThenResume()` | `Promise<{ restoreSource?, generation? }>` | evict, then touch to force a **cold restore** from the snapshot; returns the restore source (`"sqlite-restore"`/`"r2-restore"`). |
| `session.reset()` | `Promise<void>` | clear the namespace, drop the snapshot, fresh epoch. |
| `session.close()` | `void` | close the transport (the durable session persists server-side). |

```ts
const { restoreSource, generation } = await s.hibernateThenResume();
// restoreSource === "sqlite-restore", generation bumped => genuinely reconstructed
```

---

## Typed-error table

By default `eval` **throws** a typed `EngramError` subclass on a failed cell. All are exported,
so you can `instanceof`-match them. **The cell is always recoverable: the socket stays alive and
the next eval works** — this is the kernel's hardening guarantee.

```ts
import { TimeoutError, MemoryLimitError, FetchBlockedError, SizeAdmissionError } from "@engram/sdk";
try {
  await s.eval("while (true) {}");
} catch (e) {
  if (e instanceof TimeoutError) { /* … */ }
}
```

| class | `name` | When it throws | Recoverable? |
|---|---|---|---|
| `TimeoutError` | `"TimeoutError"` | Cell exceeds the instruction/tick budget (e.g. `while(true){}`). | ✅ next eval works |
| `MemoryLimitError` | `"MemoryLimitError"` | Cell grows WASM linear memory past the per-cell/absolute cap (alloc bomb / fast array growth — the buffer-growth tripwire catches even native bombs). | ✅ socket alive |
| `FetchBlockedError` | `"FetchBlockedError"` | `host.fetch(url)` to a host not on `config.fetch`. | ✅ |
| `SizeAdmissionError` | `"SizeAdmissionError"` | The heap is too large to snapshot (over the ~18 MB dump ceiling). | ✅ clean reject; `reset()` recovers |
| `EngramError` (base) | kernel name or `"EngramError"` | Any other failed cell (ordinary `TypeError`/`ReferenceError`/…) or a transport fault. | ✅ (cell) / thrown (transport) |

Every `EngramError` carries `.kernelStack` (the kernel stack, when present) and `.result` (the
full `EvalResult` that produced it, for inspection).

**Transport faults** (`"request timed out"`, `"connection closed before reply"`,
`"malformed kernel reply"`, `"No WebSocket available…"`) are also `EngramError`, thrown
regardless of `throwOnError`. With `autoReconnect:true` (default) a dropped socket is reconnected
(exponential backoff, ≤2s) and the request retried once before surfacing.

Pass `throwOnError:false` (in `connect` or per `eval`) to get `{ ok:false, error }` back instead
of an exception.

---

## kernel vs cloud usage

The same SDK, the same `EngramSession` surface. Only the `url` + `apiKey` change; `connect`
auto-detects the transport.

| | `engram-kernel` (direct) | `engram-cloud` (multi-tenant SaaS) |
|---|---|---|
| `url` | `wss://engram-kernel.<acct>.workers.dev` | `https://engram-cloud.<acct>.workers.dev` |
| transport | WebSocket (`/ws?id=`) | HTTP REST (`/configure`,`/eval`,`/status`,`/evict`) — or WS `/connect` if you pass a `ws(s)` url **with** a key |
| auth | none (front it yourself) | **per-tenant API key** (`apiKey`, sent as `x-api-key`) |
| isolation | one DO per `session` | per-session **facet** with its own SQLite, failure-isolated |
| metering | — | AE metering + `GET /usage` per tenant |
| `reset()` | true reset | maps to `evict` (HTTP has no first-class reset; snapshot kept) |
| use when | trusted single-tenant, lowest latency | many tenants, billing, hard isolation |

```ts
// Direct kernel (WebSocket)
const k = await Engram.connect({ url: "wss://engram-kernel…", session: "s1", WebSocket });

// Cloud (HTTP + API key) — same surface
const c = await Engram.connect({ url: "https://engram-cloud…", apiKey: "ek_live_…", session: "s1" });
```

Both honor the same `config`, the same typed errors, and the same durability semantics. On the
HTTP cloud path, `eval` source is sent as a query param and the rich error/console fields are
normalized identically.

---

## Gotchas (honest)

- **Objects/arrays come back parsed.** The kernel sends rich values as a JSON preview string;
  the SDK parses them into `value` for you, with the human form on `valuePreview`. A preview that
  can't round-trip (e.g. an async-IIFE whose completion is an object previews as `{}`) is a known
  kernel limitation — prefer a synchronous return, a top-level `await` expression, or `set`/`get`.
- **Hibernation is *between* cells**, not mid-cell.
- **Snapshot envelope ≈ 18 MB.** Keep big data out of the heap. A buffer-growth bomb makes that
  session's later checkpoints `SizeAdmissionError` (WASM memory is monotonic) until `reset()` —
  the DO is never killed.
- **`reset()` over the cloud HTTP path maps to `evict`** (snapshot kept), not a true wipe.

---

## Substrate / extensibility

The SDK is built to embed inside your own service (e.g. a Cloudflare Worker that owns its URL
scheme and maps request ids → durable Engram sessions). Four seams keep that clean:

- **`connect({ transport })`** — drive a **custom `Transport`** instead of opening a WS/HTTP
  channel from `url`. Bind via a Cloudflare service binding, a DO-to-DO RPC stub, an in-process
  kernel, or a signed/audited channel. Pass an instance or a `(session) => Transport` factory.
  The `Transport`, `Frame`, and `HostFn` types are exported. `EngramSession.fromTransport(t, opts)`
  is the low-level constructor (you call `_applyConfig()` yourself).
- **`onEval` interceptor(s)** — middleware wrapping every `eval`: `(code, opts, next) => Promise<EvalResult>`.
  Trace, time, redact, retry, or rewrite the code/result centrally instead of per call site.
  Pass one or an array (outermost first); add more at runtime with `session.use(mw)`.
- **`session.supportsHostCalls`** — `true` only when the transport can deliver `host.<name>()`
  callbacks (WS / custom transport that opts in). Check it so host tools don't silently no-op
  over the cloud HTTP path.
- **Lifecycle hooks** — `onConnect` (first connect), `onReconnect` (after a cold reconnect
  re-applies config — re-register dynamic host tools here), `onClose` (unexpected drop). WS /
  `openSocket` transports.

```ts
const s = await Engram.connect({
  session: `proj:${projectId}`,                 // bring-your-own id; route however you like
  transport: (sess) => serviceBindingTransport(env.ENGRAM_KERNEL, sess),
  onEval: async (code, _opts, next) => { const r = await next(code); log(r.cell, r.ok); return r; },
  onReconnect: () => s.defineHostModule("db", { query }),  // re-register after a drop
});
```

For DO-to-DO **WebSocket** binding with reconnect, `openSocket: (session) => WebSocketLike` already
exists — use that when you want host callbacks over an injected socket. Use a custom `transport`
when your channel is request/reply (service binding) or non-WS. See
[`examples/substrate-custom-transport.ts`](./examples/substrate-custom-transport.ts).

### Instance management — `EngramClient`

When your service owns a **fleet** of sessions (one per user / project / conversation), `EngramClient`
holds the connection defaults once and reuses a live `EngramSession` per id — two requests for the
same id share one socket, concurrent connects dedupe, and you get fleet-wide lifecycle ops.

```ts
import { EngramClient, presets } from "@engram/sdk";

const client = new EngramClient({ url, WebSocket, config: presets.deterministic() });

const s = await client.session(`proj:${id}`);          // connect-or-reuse by id
await client.eval(`proj:${id}`, "globalThis.x = 1");    // shorthand (connect-or-reuse + eval)
client.size; client.ids(); client.has(id); client.get(id); client.list();
await client.statusAll();                                // {id: {generation, inMemory}}
await client.evictAll();                                 // hibernate the whole fleet
await client.close(id);                                  // close + forget one (durable heap persists)
await client.closeAll();                                 // tear down the fleet
```

Per-call overrides merge over the client defaults (`config`/`host`/`hostModules`/`env` shallow-merge,
overrides win): `await client.session(id, { config: { cellBudgetTicks: 1500 } })`. `EngramClient` also
takes a `transport: (session) => Transport` factory, so a fleet can bind over service bindings too.

### Config presets + `defineConfig`

`presets` are ready-made `EngramConfig` postures (spread + override freely); `defineConfig` validates
a config at the call site so a typo fails fast instead of passing silently through the kernel's open
config map.

```ts
import { presets, defineConfig } from "@engram/sdk";

presets.deterministic(7)         // { clock:"seeded", rngSeed:7, capture:true } — byte-identical replay
presets.realtime()               // real wall-clock Date/Math
presets.nodeFull()               // in-VM stdlib bundle + open egress, seeded
presets.sandboxed(["api.x.com"]) // locked egress allowlist (or sandboxed() to block all)

const config = defineConfig({ ...presets.nodeFull(), cellBudgetTicks: 2000 }); // throws on bad fields
```

---

## Roadmap (not in v2 core yet)

The v0.9.x SDK (`packages/sdk`, `@engram/sdk@0.9.x`) carries higher-level flows the v2 core does
not yet expose: `execute(code, fns)` (Code Mode), host-side big context (`setContext` +
`host.ctx.*`), the depth-1 `rlm()` loop, the provably-terminating `lambdaRLM()`, and the durable
`createAgent()` code-mode adapter. The v2 plan (`docs/RUST-KERNEL-PLAN.md`) folds these onto the
Rust kernel; they will return as v2 layers on top of this clean core. Until then, use
`@engram/sdk@0.9.x` for those, or build them on `eval` (the host boundary is identical).

## Why Engram

See [`WHY-ENGRAM.md`](./WHY-ENGRAM.md) — the one-page dev pitch.

## Runnable examples

See [`examples/`](./examples/): `hello-eval`, `durable-counter`, `rlm-needle`, `agent-codemode`,
`streaming-console`, `error-handling`. Each is a self-contained `.mjs` — set `ENGRAM_ENDPOINT`
and run with `node`.
