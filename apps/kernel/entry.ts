// Wrapper entry. Authored in TS; esbuild emits entry.mjs (wrangler `main`) at build time,
// inlining stdlib-meta and keeping the wrangler-special imports (engine.wasm CompiledWasm,
// stdlib.bundle.txt Text, build/worker/shim.mjs) EXTERNAL so wrangler/worker-build resolve them.
//
// Imports the precompiled rquickjs ENGINE wasm as a CompiledWasm asset (WebAssembly.Module)
// and exposes it on globalThis BEFORE the worker-build output (Rust DO shim + kernel-glue.mjs)
// runs. The CompiledWasm import must live here: workerd forbids WebAssembly.compile of bytes.
import engineModule from "./src/engine.wasm"; // WebAssembly.Module (CompiledWasm rule)
import zstdCodecModule from "./src/zstd-codec.wasm"; // WebAssembly.Module (CompiledWasm rule) — issue #9 snapshot codec
import { ENGINE_HASH } from "./src/engine-hash.js"; // build-time SHA-256 of engine.wasm
import STDLIB_BUNDLE from "./src/stdlib.bundle.txt"; // Text module: {name: iifeString}
import { STDLIB_META } from "./src/stdlib-meta"; // module catalog + opt-in set (inlined from .ts)

import { WorkerEntrypoint } from "cloudflare:workers";
import { KernelDO as RustKernelDO } from "./build/worker/shim.mjs";
// SHARED ISOLATION CORE (single source of truth for path hygiene). esbuild inlines @engram/fs's
// keys.ts at build (devDependency, build-only; tree-shaken to just normPath/FsPathError since the
// VfsGateway references nothing else). normPath THROWS FsPathError on a root-escaping `..` (vs the
// old ad-hoc normalizer's silent clamp) and returns a NO-leading-slash, root-relative form — both
// are prefix-safe, so this is security-equivalent (stricter) and the R2 key derivation below is
// UNCHANGED (flat `fs/<doId>/<path>`, no live/ subspace — coherence with the Rust r2_fs_op store).
import { resolve as resolveWs, FsPathError, WORKSPACE_ROOT } from "@engram/fs";

globalThis.__ENGINE_MODULE = engineModule;
globalThis.__ZSTD_MODULE = zstdCodecModule;
globalThis.__ENGINE_HASH = ENGINE_HASH;
globalThis.__STDLIB_BUNDLE = STDLIB_BUNDLE;
globalThis.__STDLIB_META = STDLIB_META;

export { default } from "./build/worker/shim.mjs";

// ── Registry VFS gateway (top-level WorkerEntrypoint export) ─────────────────────────────────
// `ctx.exports.VfsGateway({props:{doId}})` mints a per-session, prefix-isolated RPC stub that the
// KernelDO hands to each dynamic Worker-Loader isolate as `env.VFS`. The dynamic worker NEVER gets
// the raw R2 bucket — only this gateway, whose `fs/<doId>/` prefix is bound to the trusted doId the
// KernelDO passed (the worker cannot choose it). Object keys + path normalization match the
// KernelDO's host.fs / vfs-* store EXACTLY (bucket SNAPSHOTS, key `fs/<doId>/<normpath>`), so a
// gateway-written file is the SAME object a later cell sees via host.fs, and reconcile_fs_files
// re-indexes it into the per-session fs_files SQLite namespace after the invoke.

export class VfsGateway extends WorkerEntrypoint<any> {
  private _bucket() {
    const b = (this.env as any)?.SNAPSHOTS;
    if (!b || typeof b.get !== "function") {
      const e = new Error("VfsGateway: SNAPSHOTS R2 binding unavailable");
      (e as any).name = "RegistryUnavailableError";
      throw e;
    }
    return b;
  }
  private _key(path: string): string {
    const doId = String(((this.ctx as any)?.props?.doId) ?? "");
    if (!doId) {
      const e = new Error("VfsGateway: missing doId prop (prefix isolation)");
      (e as any).name = "RegistryUnavailableError";
      throw e;
    }
    // /workspace-canonical resolution: a hash-worker's CWD defaults to /workspace (the ONE fs
    // root). resolve() returns the clean, root-relative, NO-leading-slash `<rel>` form (throws
    // FsPathError on a `..` that escapes /workspace, or NUL). A bare-"/a/b" maps to "a/b" — the
    // SAME key as before (back-compat); a relative "a/b" also maps to "a/b" (under /workspace).
    const cwd = String(((this.ctx as any)?.props?.cwd) ?? WORKSPACE_ROOT);
    let norm: string;
    try {
      norm = resolveWs(path, cwd);
    } catch (err) {
      // A path that tried to escape /workspace (or held a NUL) is an isolation violation.
      // Surface it as a typed FsPathError (the shared isolation error) rather than a raw throw.
      if (err instanceof FsPathError) throw err;
      const e = new FsPathError(`VfsGateway: bad path ${String(path)}`);
      throw e;
    }
    if (norm === "") {
      // The bare root (/workspace) is a directory, not a file — guard so a file op never targets
      // the bare `fs/<doId>/` prefix key (mirrors @engram/fs liveKey EISDIR).
      const e = new FsPathError(`VfsGateway: ${String(path)} is a directory`, "EISDIR");
      throw e;
    }
    return `fs/${doId}/${norm}`;
  }
  // Read a file from the shared VFS. Returns a UTF-8 string (text channel) or null if absent.
  async readFile(path: string): Promise<string | null> {
    const obj = await this._bucket().get(this._key(path));
    if (!obj) return null;
    return await obj.text();
  }
  // Read raw bytes (ArrayBuffer) or null if absent.
  async readFileBytes(path: string): Promise<ArrayBuffer | null> {
    const obj = await this._bucket().get(this._key(path));
    if (!obj) return null;
    return await obj.arrayBuffer();
  }
  // Write a file to the shared VFS (string or ArrayBuffer/typed-array body). Body to R2 directly;
  // the KernelDO's reconcile_fs_files upserts the fs_files meta row after the invoke completes.
  async writeFile(path: string, data: string | ArrayBuffer | ArrayBufferView): Promise<{ ok: true; bytes: number }> {
    let body: ArrayBuffer | Uint8Array;
    if (typeof data === "string") body = new TextEncoder().encode(data);
    else if (data instanceof ArrayBuffer) body = data;
    else body = new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    const bytes = body instanceof ArrayBuffer ? body.byteLength : body.byteLength;
    await this._bucket().put(this._key(path), body);
    return { ok: true, bytes };
  }
  // Delete a file. Best-effort; reconcile drops the meta row afterwards.
  async deleteFile(path: string): Promise<{ ok: true }> {
    await this._bucket().delete(this._key(path));
    return { ok: true };
  }
  // List file paths under an optional prefix (relative to the session root, leading-slash form).
  async list(prefix = "/"): Promise<string[]> {
    const root = `fs/${String(((this.ctx as any)?.props?.doId) ?? "")}/`;
    const cwd = String(((this.ctx as any)?.props?.cwd) ?? WORKSPACE_ROOT);
    const norm = resolveWs(prefix, cwd); // NO-leading-slash <rel> form (back-compat: bare-/ -> rel)
    // Append "/" for a sub-dir so the R2 prefix matches only entries UNDER it (norm "foo" must not
    // bleed into siblings "foobar"/"foo.txt"). Root listing (norm "") stays the bare session prefix.
    const r2prefix = norm ? `${root}${norm}/` : root;
    const listed = await this._bucket().list({ prefix: r2prefix });
    return (listed.objects || []).map((o: any) => "/" + String(o.key).slice(root.length));
  }
}

// Capture the DO ctx (which carries `.exports` for ctx.exports.VfsGateway) keyed by trusted doId so
// the registry glue can mint a session-scoped gateway even though the Rust DO hands NULL ctx across
// the wasm-bindgen boundary. The Rust DO passes its trusted state.id().toString() as the doId; we
// key on the same lowercase hex here. The map self-prunes on DO disposal where supported.
const __ENGRAM_DO_CTX: Map<string, any> = ((globalThis as any).__ENGRAM_DO_CTX ||= new Map());

function doIdString(state: any): string {
  try {
    // DurableObjectState.id is a DurableObjectId PROPERTY (not a method) in the raw JS ctx; worker-rs
    // exposes it as a method. Handle both: prefer the property, fall back to calling it.
    let idObj = state?.id;
    if (typeof idObj === "function") { try { idObj = idObj.call(state); } catch { /* */ } }
    const s = idObj && typeof idObj.toString === "function" ? idObj.toString() : String(idObj ?? "");
    return s.toLowerCase();
  } catch { return ""; }
}

export class KernelDO extends (RustKernelDO as any) {
  constructor(state: any, env: any) {
    super(state, env);
    try {
      const id = doIdString(state);
      if (id) __ENGRAM_DO_CTX.set(id, state);
    } catch { /* best-effort ctx capture */ }
  }
}
