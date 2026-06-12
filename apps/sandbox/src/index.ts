/**
 * engram-sandbox — STANDALONE Tier-2 container muscle.
 *
 * A real Linux container (the @cloudflare/sandbox `Sandbox` Durable Object) that runs shell
 * commands, file ops, git, code, and background procs — fronted by this Worker. The SEAM with
 * the rest of engram is the R2 VFS: each session's R2 prefix `fs/<doId>/` (the SAME keys the
 * kernel's host.fs / vfs-* frames read/write) is mounted (credential-less, via the R2 binding)
 * as the container's `/workspace` workspace. The kernel's files and the container shell are the
 * same bytes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *  client ──HTTP──▶ engram-sandbox Worker ──(getSandbox stub)──▶ Sandbox DO ──▶ container
 *                         │                                              │
 *                         │  proxyToSandbox(request,env) handles preview │ s3fs-FUSE mount
 *                         │  URLs + browser terminal first.             ▼
 *                         └──────────── R2 bucket engram-snapshots @ fs/<doId>/ ◀── kernel
 *
 *  - doId          : the session identity == the kernel's KernelDO id (so the prefix matches).
 *  - /workspace    : the R2-backed workspace inside the container. This IS the canonical fs root
 *                    (owner invariant): the kernel session's R2 prefix `fs/<doId>/` is mounted at
 *                    /workspace, so a cell's `/workspace/x.txt` is LITERALLY the same R2 key
 *                    (fs/<doId>/x.txt) and the same bytes the container sees at /workspace/x.txt.
 *                    The @cloudflare/sandbox base image SEEDS /workspace; ensureSessionMount clears
 *                    that seed on a fresh container BEFORE mounting (gated on "not already mounted")
 *                    + mounts with `nonempty` so the R2 files win.
 *  - container ops : idempotent JOBS over durable R2 state. The container is ephemeral (cold
 *                    restart after 10-min idle sleep), R2 + the kernel manifest are durable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY / CAPABILITY MODEL  (read before extending)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - The R2 `prefix` is a PATH VIEW, not a credential scope. The container holds (via the
 *    credential-less binding mount / egress interception) access to the WHOLE `engram-snapshots`
 *    bucket; `prefix:"/fs/<doId>/"` only changes which keys appear under the mount point. A
 *    process that breaks out of s3fs and talks to the egress proxy directly is NOT confined to
 *    the prefix. Isolation between sessions therefore relies on (a) one Sandbox DO id per
 *    session and (b) this Worker only ever mounting that session's prefix — NOT on R2 ACLs.
 *    Do NOT treat the prefix as a tenant boundary for untrusted multi-tenant code without an
 *    additional creds-scoped token mount.
 *  - The Worker injects ONLY the bindings a session needs (capability injection): this file
 *    passes the R2 binding + doId and nothing else into the container.
 *  - Auth: gate every route behind ENGRAM_SANDBOX_KEY (bearer) before touching a sandbox.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DURABILITY / MOUNT LIFECYCLE
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Mounts are LOST when the container sleeps (10-min idle) or is destroyed → we REMOUNT on
 *    every request via `ensureSessionMount()` (idempotent: skip if already mounted).
 *  - s3fs-over-R2 is NOT POSIX and NOT atomic (no rename-atomicity, weak consistency). Treat
 *    container file ops as idempotent jobs; do not rely on lockfiles or atomic rename on the mount.
 *  - The bucket mount persists DATA across sandbox lifecycles (next cold start re-mounts, data
 *    is still in R2). Only the running container + its mount table are ephemeral.
 */

import { getSandbox, proxyToSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";

// Re-export the Sandbox DO class (required by the durable_objects binding in wrangler.jsonc)
// and ContainerProxy (required for credential-less R2 binding mounts via egress interception).
export { Sandbox, ContainerProxy } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<SandboxType>;
  // R2 binding NAME used by mountBucket() for credential-less mounts. Same bucket as the kernel.
  SANDBOX_R2: R2Bucket;
  AE?: AnalyticsEngineDataset;
  ENGRAM_SANDBOX_KEY?: string;
}

// THE canonical fs root (owner invariant): the kernel session's R2 prefix is mounted HERE so the
// container's /workspace == the cell's /workspace == R2 fs/<doId>/. The session CWD is /workspace.
const MOUNT_PATH = "/workspace";

/** Per-session R2 key prefix — MUST match the kernel's host.fs / vfs-* layout. */
function sessionPrefix(doId: string): string {
  // Hardened: only [a-z0-9-_] session ids; everything else is rejected upstream.
  return `/fs/${doId}/`;
}

/** Lowercase + validate a session id (Sandbox preview URLs require lowercase ids). */
function normalizeSessionId(raw: string): string | null {
  const id = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ? id : null;
}

/**
 * Derive the @cloudflare/sandbox container id from the session id.
 *
 * The kernel's DO id is 64 hex chars, but `getSandbox()` requires a 1-63 char id
 * ("Sandbox ID must be 1-63 characters long."). The R2 MOUNT PREFIX still uses the
 * FULL `doId` (so the keys line up with the kernel's `fs/<doId>/`), but the container
 * identity only needs to be deterministic + collision-free per session — so we truncate
 * to 63 chars. 63 hex chars = 252 bits of entropy, no practical collision risk, and the
 * mapping is stable (same session id always lands on the same container).
 */
function containerId(doId: string): string {
  return doId.length <= 63 ? doId : doId.slice(0, 63);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Mount the session R2 prefix at /workspace ONCE per live container. Idempotent + non-destructive.
 *
 * CRITICAL: the Sandbox SDK's `mountBucket()` does NOT check for an existing mount — it blindly
 * runs `s3fs` over the path again. With `nonempty`, a second mount STACKS a fresh s3fs on top of
 * the first, which (a) shadows/loses the previous mount's buffered (not-yet-flushed) writes and
 * (b) wedges the path ("ls: Operation not permitted"). So we MUST check `mountpoint -q /workspace`
 * first and skip if already mounted — re-mounting on every request was corrupting container->R2
 * writes (the container->cell half of the shared VFS). We only (re)mount when the path is NOT a
 * live mountpoint (fresh container / post-sleep cold-start).
 *
 * Credential-less: first arg is the R2 BINDING NAME; ContainerProxy intercepts egress so no S3
 * keys cross into the container.
 */
async function ensureSessionMount(sandbox: SandboxType, doId: string): Promise<void> {
  // Already mounted in this live container? Then leave it alone — re-mounting stacks s3fs and
  // loses in-flight writes. `mountpoint -q` exits 0 iff /workspace is a live mount.
  try {
    const chk = await sandbox.exec(`mountpoint -q ${MOUNT_PATH}`);
    if (chk.exitCode === 0) return;
  } catch {
    // exec/mountpoint unavailable → fall through and attempt the mount.
  }
  // SEEDED-/workspace FIX: the @cloudflare/sandbox base image seeds /workspace with image content.
  // We mount the kernel's R2 prefix OVER it, and the R2 files MUST win. Since we only reach here
  // when /workspace is NOT a live R2 mount (the mountpoint -q check above returned non-zero), the
  // contents here are the IMAGE SEED, never R2-backed bytes — so clearing them is safe and never
  // touches durable data. Clear the seed, then mount with `nonempty` so s3fs tolerates the dir.
  try {
    await sandbox.exec(
      `rm -rf ${MOUNT_PATH}/* ${MOUNT_PATH}/.[!.]* ${MOUNT_PATH}/..?* 2>/dev/null || true`,
    );
  } catch {
    // Best-effort: if the seed clear fails, `nonempty` still lets the mount proceed.
  }
  try {
    await sandbox.mountBucket("SANDBOX_R2", MOUNT_PATH, {
      // PATH VIEW into the bucket — NOT a credential scope (see header).
      prefix: sessionPrefix(doId),
      readOnly: false,
      // `nonempty`: tolerate a stale/dirty mountpoint left by a previous mount after a
      // sleep/cold-restart (s3fs otherwise refuses with "MOUNTPOINT ... is not empty" and
      // wedges every subsequent request). Provider R2 defaults still apply on top of this.
      s3fsOptions: ["nonempty"],
    });
  } catch (err) {
    // Already-mounted (or an idempotent re-mount of the same path) is fine; surface a genuine
    // S3FSMountError (bad creds / network) to the caller.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already.*mount|mountpoint.*busy|is not empty/i.test(msg)) throw err;
  }
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function requireAuth(request: Request, env: Env): boolean {
  if (!env.ENGRAM_SANDBOX_KEY) return true; // open in dev when no key configured
  const hdr = request.headers.get("authorization") ?? "";
  const tok = hdr.replace(/^Bearer\s+/i, "");
  const keys = env.ENGRAM_SANDBOX_KEY.split(",").map((k) => k.trim());
  return keys.includes(tok);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1) Preview-URL + browser-terminal routing MUST run first (subdomain-routed requests).
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true, worker: "engram-sandbox" });

    if (!requireAuth(request, env)) return unauthorized();

    // Session id comes from header or ?session= ; equals the kernel KernelDO id.
    const rawId =
      request.headers.get("x-engram-session") ?? url.searchParams.get("session") ?? "";
    const doId = normalizeSessionId(rawId);
    if (!doId) return json({ error: "missing or invalid session id" }, 400);

    // One Sandbox DO per session id == one container == the kernel's prefix owner.
    // The container identity is the doId truncated to the SDK's 63-char limit; the R2 mount
    // still uses the FULL doId prefix (sessionPrefix) so kernel + container see the same bytes.
    const sandbox = getSandbox(env.Sandbox, containerId(doId), {
      // Keep the container warm for interactive sessions; tune for cost. (default sleepAfter "10m")
      // keepAlive: false,
    });

    try {
      switch (url.pathname) {
        // ── POST /exec  { cmd, args?, cwd? } → { stdout, stderr, exitCode, success } ──────────
        case "/exec": {
          if (request.method !== "POST") return json({ error: "POST only" }, 405);
          const { cmd, cwd } = (await request.json()) as { cmd: string; cwd?: string };
          if (!cmd) return json({ error: "cmd required" }, 400);
          await ensureSessionMount(sandbox, doId);
          const result = await sandbox.exec(cmd, { cwd: cwd ?? MOUNT_PATH });
          recordAE(env, ctx, doId, "exec", result.exitCode);
          return json(result);
        }

        // ── POST /exec-stream { cmd } → SSE stream of stdout/stderr events ─────────────────────
        case "/exec-stream": {
          if (request.method !== "POST") return json({ error: "POST only" }, 405);
          const { cmd } = (await request.json()) as { cmd: string };
          if (!cmd) return json({ error: "cmd required" }, 400);
          await ensureSessionMount(sandbox, doId);
          const stream = await sandbox.execStream(cmd, { cwd: MOUNT_PATH });
          return new Response(stream as unknown as ReadableStream, {
            headers: { "content-type": "text/event-stream" },
          });
        }

        // ── /git  { op:"checkout", repo, branch?, dir? } ──────────────────────────────────────
        case "/git": {
          if (request.method !== "POST") return json({ error: "POST only" }, 405);
          const body = (await request.json()) as {
            op: string;
            repo?: string;
            branch?: string;
            dir?: string;
          };
          await ensureSessionMount(sandbox, doId);
          if (body.op === "checkout" && body.repo) {
            // Clone INTO the R2-backed workspace so the kernel sees the tree.
            await sandbox.gitCheckout(body.repo, {
              branch: body.branch,
              targetDir: body.dir ?? `${MOUNT_PATH}/repo`,
              depth: 1,
            });
            recordAE(env, ctx, doId, "git", 0);
            return json({ ok: true });
          }
          return json({ error: "unsupported git op" }, 400);
        }

        // ── /files  read/write/list/mkdir/delete over the R2-backed workspace ─────────────────
        case "/files": {
          await ensureSessionMount(sandbox, doId);
          if (request.method === "GET") {
            const path = url.searchParams.get("path");
            if (!path) return json({ error: "path required" }, 400);
            const op = url.searchParams.get("op") ?? "read";
            if (op === "list") return json(await sandbox.listFiles(path));
            const file = await sandbox.readFile(path);
            return json({ content: file.content });
          }
          if (request.method === "POST") {
            const body = (await request.json()) as {
              op: "write" | "mkdir" | "delete";
              path: string;
              content?: string;
            };
            if (body.op === "write") {
              await sandbox.writeFile(body.path, body.content ?? "");
              recordAE(env, ctx, doId, "files-write", 0);
              return json({ ok: true });
            }
            if (body.op === "mkdir") {
              await sandbox.mkdir(body.path, { recursive: true });
              return json({ ok: true });
            }
            if (body.op === "delete") {
              await sandbox.deleteFile(body.path);
              return json({ ok: true });
            }
          }
          return json({ error: "bad files request" }, 400);
        }

        // ── POST /mount → force a (re)mount; GET → mount info ─────────────────────────────────
        case "/mount": {
          await ensureSessionMount(sandbox, doId);
          return json({ ok: true, mountPath: MOUNT_PATH, prefix: sessionPrefix(doId) });
        }

        // ── POST /unmount → drop the R2 mount (data stays in R2) ──────────────────────────────
        case "/unmount": {
          await sandbox.unmountBucket(MOUNT_PATH);
          return json({ ok: true });
        }

        // ── POST /expose { port } → public preview URL for a service in the container ─────────
        case "/expose": {
          if (request.method !== "POST") return json({ error: "POST only" }, 405);
          const { port } = (await request.json()) as { port: number };
          const preview = await sandbox.exposePort(port, { hostname: url.hostname });
          return json(preview);
        }

        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordAE(env, ctx, doId, "error", 1, message);
      return json({ error: message }, 500);
    }
  },
};

function recordAE(
  env: Env,
  ctx: ExecutionContext,
  doId: string,
  op: string,
  code: number,
  errName = "",
): void {
  if (!env.AE) return;
  try {
    env.AE.writeDataPoint({
      indexes: [doId],
      blobs: [op, errName],
      doubles: [code],
    });
  } catch {
    /* AE is best-effort */
  }
}
