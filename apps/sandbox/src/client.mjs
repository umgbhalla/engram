/**
 * engram-sandbox — thin standalone Node client.
 *
 * Zero-dependency wrapper over the deployed `engram-sandbox` worker's HTTP routes. The session id
 * MUST equal the kernel's KernelDO id so the container mounts the same R2 prefix (`fs/<doId>/`) the
 * kernel's host.fs / vfs-* frames read/write — that is the whole point of the seam.
 *
 * Usage:
 *   import { SandboxClient } from "./client.mjs";
 *   const sb = new SandboxClient({
 *     base: "https://engram-sandbox.<sub>.workers.dev",
 *     session: "<kernel-do-id>",   // lowercase [a-z0-9][a-z0-9_-]{0,127}
 *     key: process.env.ENGRAM_SANDBOX_KEY,   // optional bearer
 *   });
 *   await sb.mount();
 *   const r = await sb.exec("ls -la /workspace");
 *   await sb.writeFile("/workspace/notes.txt", "hi");
 *   const f = await sb.readFile("/workspace/notes.txt");
 *
 * Works on Node >= 18 (global fetch). Browser-safe too (same fetch surface).
 */

export class SandboxClient {
  /** @param {{ base: string, session: string, key?: string, fetch?: typeof fetch }} opts */
  constructor(opts) {
    if (!opts || !opts.base) throw new Error("SandboxClient: { base } is required");
    if (!opts.session) throw new Error("SandboxClient: { session } is required");
    this.base = opts.base.replace(/\/+$/, "");
    this.session = String(opts.session).toLowerCase();
    this.key = opts.key;
    this._fetch = opts.fetch ?? globalThis.fetch;
    if (typeof this._fetch !== "function") {
      throw new Error("SandboxClient: no global fetch; pass { fetch } (Node >= 18 or undici)");
    }
  }

  _headers(extra = {}) {
    return {
      "content-type": "application/json",
      "x-engram-session": this.session,
      ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
      ...extra,
    };
  }

  async _req(path, init = {}) {
    const res = await this._fetch(`${this.base}${path}`, {
      ...init,
      headers: this._headers(init.headers),
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const msg = body && body.error ? body.error : `HTTP ${res.status}`;
      const err = new Error(`engram-sandbox ${path}: ${msg}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  /** GET /health — no auth, no session required (uses the base only). */
  async health() {
    const res = await this._fetch(`${this.base}/health`);
    return res.json();
  }

  /** Force a (re)mount of the session R2 prefix at /workspace. Idempotent. */
  mount() {
    return this._req("/mount", { method: "POST", body: "{}" });
  }

  /** Drop the R2 mount (data stays in R2). */
  unmount() {
    return this._req("/unmount", { method: "POST", body: "{}" });
  }

  /**
   * Run a shell command in the container.
   * @param {string} cmd
   * @param {{ cwd?: string }} [opts]
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, success: boolean }>}
   */
  exec(cmd, opts = {}) {
    return this._req("/exec", {
      method: "POST",
      body: JSON.stringify({ cmd, cwd: opts.cwd }),
    });
  }

  /**
   * Run a command and stream stdout/stderr as Server-Sent Events.
   * @param {string} cmd
   * @returns {Promise<ReadableStream<Uint8Array>>}
   */
  async execStream(cmd) {
    const res = await this._fetch(`${this.base}/exec-stream`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ cmd }),
    });
    if (!res.ok) throw new Error(`engram-sandbox /exec-stream: HTTP ${res.status}`);
    return res.body;
  }

  /**
   * git checkout (shallow clone) into the R2-backed workspace.
   * @param {string} repo
   * @param {{ branch?: string, dir?: string }} [opts]
   */
  gitCheckout(repo, opts = {}) {
    return this._req("/git", {
      method: "POST",
      body: JSON.stringify({ op: "checkout", repo, branch: opts.branch, dir: opts.dir }),
    });
  }

  /** Read a file from the R2-backed workspace. @returns {Promise<{ content: string }>} */
  readFile(path) {
    return this._req(`/files?path=${encodeURIComponent(path)}&op=read`, { method: "GET" });
  }

  /** List a directory in the R2-backed workspace. */
  listFiles(path) {
    return this._req(`/files?path=${encodeURIComponent(path)}&op=list`, { method: "GET" });
  }

  /** Write a file into the R2-backed workspace. */
  writeFile(path, content) {
    return this._req("/files", {
      method: "POST",
      body: JSON.stringify({ op: "write", path, content }),
    });
  }

  /** Create a directory (recursive) in the R2-backed workspace. */
  mkdir(path) {
    return this._req("/files", {
      method: "POST",
      body: JSON.stringify({ op: "mkdir", path }),
    });
  }

  /** Delete a file in the R2-backed workspace. */
  deleteFile(path) {
    return this._req("/files", {
      method: "POST",
      body: JSON.stringify({ op: "delete", path }),
    });
  }

  /**
   * Expose a container port and get a public preview URL.
   * @param {number} port
   * @returns {Promise<{ url: string, port: number, name: string }>}
   */
  exposePort(port) {
    return this._req("/expose", { method: "POST", body: JSON.stringify({ port }) });
  }
}

export default SandboxClient;
