# engram-compare-cfsandbox

A minimal Cloudflare **Sandbox** (Container + Durable Object) worker that exposes an HTTP
API mirroring the engram-kernel WS protocol, so the SAME capability probes
(`../probes.mjs`) can run against a full-Linux container substrate.

## What it is

`src/index.ts` wraps `@cloudflare/sandbox`:

- `getSandbox(env.Sandbox, sid)` — addressable per-session sandbox (DO identity + Container).
- `createCodeContext()` + `runCode(src, {context})` — a persistent code-interpreter kernel for
  stateful JS eval (the closest CF analogue to engram's REPL namespace).
- `stop()` / `destroy()` — force a genuine container teardown (the `/evict` endpoint).

Endpoints driven by `../cf-sandbox-adapter.mjs`:

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/create` | `{sid, config?}` | `{ok, context}` |
| POST | `/eval` | `{sid, src}` | `{ok, value, logs, error, inMemoryBefore, checkpoint}` |
| POST | `/evict` | `{sid}` | `{ok, stopped}` |
| POST | `/reconnect` | `{sid}` | `{ok}` |
| POST | `/snapshot` | `{sid}` | `{ok:false, error}` (no public heap-snapshot API; see TODO) |
| GET | `/gen?sid=` | — | `{ok, generation, inMemory}` |

## Deploy

```sh
cd tests/compare-cf/cf-sandbox
npm install
npx wrangler deploy
```

Then point the runner at it:

```sh
cd tests/compare-cf
CF_SANDBOX_BASE=https://engram-compare-cfsandbox.<your-subdomain>.workers.dev \
  node run.mjs --target cf
```

## Access / beta caveats

- **Workers Paid plan required** — Cloudflare Containers + Durable Objects are paid features.
- **Containers beta access** — Cloudflare Containers were in beta/limited availability; your
  account must be enabled. Without it `wrangler deploy` rejects the `containers` stanza.
- **`@cloudflare/sandbox` is young** — the exact method names (`createCodeContext`, `runCode`,
  `stop`/`destroy`, `ping`) and the base image tag in `Dockerfile` track the installed SDK
  version. Pin `package.json` and the `FROM docker.io/cloudflare/sandbox:<ver>` to the same
  release and re-verify against the SDK docs before deploying.
- **No public heap snapshot/fork** — there is no documented per-cell heap checkpoint. Disk
  persistence and container disk-snapshot+fork are platform features, not a live-interpreter
  heap restore. `/snapshot` returns a typed "unsupported" so probes record the absence
  honestly (this is the core CAP-1 / CAP-4 discriminator).
- **`wrangler ≥ 4.86.0`** (Containers + current config schema).

## The discriminator this scaffold makes observable

After `/evict` the container is torn down. The next `/eval` re-creates the code context on a
**cold kernel** — any variable/closure that lived only in the previous interpreter's RAM is
gone (`ReferenceError` / reset), even though the container's **disk** survived. That is the
exact behaviour CAP-1, CAP-2, and CAP-5 in `../probes.mjs` assert against.
