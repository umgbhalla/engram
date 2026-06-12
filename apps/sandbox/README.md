# engram-sandbox — Tier-2 container muscle (standalone)

A real Linux container fronted by a Durable Object (the `@cloudflare/sandbox` `Sandbox` class),
deployed as the **standalone** worker `engram-sandbox`. It runs shell commands, file ops, git,
code, and background processes; the **seam** with the rest of engram is the R2 VFS — each
session's R2 prefix `fs/<doId>/` (the same keys the kernel's `host.fs` / `vfs-*` frames use) is
mounted as the container's `/session` workspace, so the kernel's files and the container shell
are the same bytes.

This worker is independent of `engram-kernel` / `engram-cloud`. It shares the existing R2 bucket
`engram-snapshots` but only ever reads/writes keys under `fs/<doId>/` (or `sandbox-test/` for
smokes) — never snapshot or other keys.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Worker: routes `POST /exec`, `/exec-stream`, `/git`, `/files`, `/mount`, `/unmount`, `/expose`; re-exports `Sandbox` + `ContainerProxy`; `proxyToSandbox` first. |
| `src/client.mjs` | Thin zero-dep Node/browser client (`SandboxClient`) over the worker's HTTP routes. |
| `wrangler.jsonc` | `containers` (image + `standard-1`), `Sandbox` DO binding + `new_sqlite_classes` migration, R2 binding `SANDBOX_R2` → `engram-snapshots`, AE. |
| `Dockerfile` | `FROM docker.io/cloudflare/sandbox:0.12.1` (tag MUST match the npm version); seeds `/session`; no ENTRYPOINT override. |
| `scripts/smoke.mjs` | HTTP smoke against the deployed worker (mount → write → read → exec round-trip). |

## Client (`src/client.mjs`)

```js
import { SandboxClient } from "@engram/sandbox-app/client"; // or "./src/client.mjs"

const sb = new SandboxClient({
  base: "https://engram-sandbox.<sub>.workers.dev",
  session: "<kernel-do-id>",          // == KernelDO id → same R2 prefix fs/<doId>/
  key: process.env.ENGRAM_SANDBOX_KEY, // optional bearer
});

await sb.mount();                       // remount the session R2 prefix at /session
const { stdout } = await sb.exec("ls -la /session");
await sb.writeFile("/session/notes.txt", "hi");
const { content } = await sb.readFile("/session/notes.txt");
await sb.gitCheckout("https://github.com/owner/repo", { dir: "/session/repo" });
const { url } = await sb.exposePort(3000); // public preview URL
```

Methods: `health`, `mount`, `unmount`, `exec`, `execStream`, `gitCheckout`,
`readFile`, `listFiles`, `writeFile`, `mkdir`, `deleteFile`, `exposePort`. Node >= 18 (global fetch).

## API used (`@cloudflare/sandbox@0.12.1`)

- `getSandbox(env.Sandbox, doId, opts?)` → DO stub (one per session id).
- `sandbox.exec(cmd, { cwd })` → `{ stdout, stderr, exitCode, success }`.
- `sandbox.execStream(cmd, opts?)` → `ReadableStream` (SSE).
- `sandbox.writeFile / readFile / mkdir / deleteFile / listFiles`.
- `sandbox.gitCheckout(repo, { branch, targetDir, depth })`.
- `sandbox.exposePort(port, { hostname })` → `{ url }` preview URL.
- `sandbox.mountBucket("SANDBOX_R2", "/session", { prefix: "/fs/<doId>/", readOnly })` — the
  credential-less **R2-binding** variant (`R2BindingMountBucketOptions`: no `endpoint`, egress
  intercepted by `ContainerProxy`). `unmountBucket(path)`.
- `proxyToSandbox(request, env)` — handles preview-URL + browser-terminal routing (call first).
- Re-export `Sandbox` (DO class) **and** `ContainerProxy` (required for credential-less mounts).

## Deploy model

**Docker IS available locally** (`docker info` → running; Docker 29.x), so the canonical path is:

```
cd apps/sandbox
npm install          # @cloudflare/sandbox@0.12.1 + wrangler >= 4.86
wrangler deploy      # builds the Dockerfile, pushes to CF container registry, deploys the worker
```

`wrangler deploy` builds the image and pushes it to Cloudflare's container registry automatically
(first deploy ~1–2 min for the image push; later deploys skip it if the Dockerfile is unchanged).
The image must run on `linux/amd64`.

- **Wrangler version:** the repo's pinned wrangler is `4.83.0`; bump to `>= 4.86` (already in this
  package's devDeps) for Worker-Loader-era container support.
- **CF remote build:** if local Docker is ever unavailable, use a pre-built image reference / CF
  remote build per the Containers image-management docs instead of `image: "./Dockerfile"`.
- **Alchemy:** not provided here. Alchemy's `Container` resource always rebuilds+pushes via Docker
  and the Sandbox-DO-as-Container wiring is unproven; the wrangler path is authoritative. Add an
  `alchemy.run.ts` mirror only after a verified wrangler cutover (cf. `apps/kernel/alchemy.run.ts`).

## Durability & mount lifecycle

- Mounts are **lost** when the container sleeps (default `sleepAfter` 10 min idle) or is destroyed
  → the worker **remounts on every request** via `ensureSessionMount()` (idempotent).
- s3fs-over-R2 is **not POSIX / not atomic** (no atomic rename, weak consistency) → treat container
  file ops as **idempotent jobs over durable R2 state**. The container is ephemeral (cold restart);
  R2 + the kernel manifest are the durable truth.

### Production mount vs `wrangler dev`

The worker hardcodes the **production** path: the credential-less R2-**binding** mount
(`mountBucket("SANDBOX_R2", "/session", { prefix, readOnly })` — `R2BindingMountBucketOptions`, no
`endpoint`, egress intercepted by `ContainerProxy`, no S3 keys in the container).

For local `wrangler dev` there is no egress proxy / s3fs; switch `ensureSessionMount()` to the
local-bucket variant `mountBucket("SANDBOX_R2", "/session", { localBucket: true, prefix })`
(`LocalMountBucketOptions` — bidirectional R2-binding sync, no s3fs). The remote
(`RemoteMountBucketOptions` with a scoped token + `endpoint`/`credentials`) variant is the path to
take when the prefix must become a real tenant boundary (see the security note above).

## Security note (load-bearing)

The R2 `prefix` is a **path view, not a credential scope**. The container's egress-intercepted
mount has access to the whole `engram-snapshots` bucket; `prefix` only changes which keys appear
under `/session`. Session isolation rests on (a) one Sandbox DO id per session and (b) this worker
mounting only that session's prefix — **not** on R2 ACLs. For untrusted multi-tenant code, add a
creds-scoped token mount; do not treat the prefix as a tenant boundary.
