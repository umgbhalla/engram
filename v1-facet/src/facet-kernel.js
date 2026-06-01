// Dynamic facet code: the montydyn QuickJS kernel, running as a FACET.
//
// KEY ADAPTATION vs v0.2: the v0.2 kernel imports quickjs.wasm as a bundled
// CompiledWasm module via entry.mjs. Worker Loader has no bundler step, so here we
// ship quickjs.wasm as a {wasm} module (arrives as a pre-compiled
// WebAssembly.Module — runtime WebAssembly.compile of raw bytes is BLOCKED in the
// facet, but the {wasm} module type gives us CompiledWasm directly, proven in step 4).
// quickjs-wasi (single ESM, self-contained) is shipped as {js} modules.
import { DurableObject } from "cloudflare:workers";
import { QuickJS } from "./qjs/index.js";
import quickjsModule from "./quickjs.wasm"; // {wasm} → WebAssembly.Module

// ---- gzip helpers (workerd CompressionStream) ----
async function gzip(u8) {
  const cs = new CompressionStream("gzip");
  const stream = new Response(u8).body.pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(u8) {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(u8).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Minimal seeded WASI factory (entropy not load-bearing for this spike).
function wasiFactory() {
  return () => ({});
}

export class KernelFacet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.kernel = null;
    // The facet's OWN SQLite — the heap snapshot lands HERE, isolated per tenant.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS snap (id INTEGER PRIMARY KEY CHECK(id=1), gz BLOB, size_raw INTEGER, size_gz INTEGER);"
    );
  }

  async #ensure() {
    if (this.kernel) return "warm";
    // Lazy cold-restore from the facet's own SQLite if a snapshot exists.
    const rows = this.ctx.storage.sql.exec("SELECT gz FROM snap WHERE id=1;").toArray();
    if (rows.length && rows[0].gz) {
      const gz = rows[0].gz instanceof Uint8Array ? rows[0].gz : new Uint8Array(rows[0].gz);
      const serialized = await gunzip(gz);
      const snap = QuickJS.deserializeSnapshot(serialized);
      this.kernel = await QuickJS.restore(snap, { wasm: quickjsModule, wasi: wasiFactory() });
      this.kernel.executePendingJobs?.();
      return "cold-restore";
    }
    this.kernel = await QuickJS.create({ wasm: quickjsModule, wasi: wasiFactory() });
    return "fresh";
  }

  async evalCell(src) {
    const source = await this.#ensure();
    try {
      const h = this.kernel.evalCode(String(src));
      let preview;
      try {
        const native = h && h.vm && typeof h.vm.dump === "function" ? h.vm.dump(h) : undefined;
        preview = JSON.stringify(native);
      } catch (e) {
        preview = "<unconvertible>";
      }
      h && h.dispose && h.dispose();
      return { ok: true, value: preview, restoreSource: source };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), restoreSource: source };
    }
  }

  async snapshotToOwnSql() {
    await this.#ensure();
    this.kernel.runGC?.();
    const snap = this.kernel.snapshot();
    const serialized = QuickJS.serializeSnapshot(snap);
    const raw = serialized instanceof Uint8Array ? serialized : new Uint8Array(serialized);
    const gz = await gzip(raw);
    this.ctx.storage.sql.exec(
      "INSERT INTO snap(id,gz,size_raw,size_gz) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET gz=excluded.gz,size_raw=excluded.size_raw,size_gz=excluded.size_gz;",
      gz,
      raw.byteLength,
      gz.byteLength
    );
    return { ok: true, sizeRaw: raw.byteLength, sizeGz: gz.byteLength };
  }

  async restoreFromOwnSql() {
    this.kernel = null; // force the cold path
    const source = await this.#ensure();
    return { ok: true, restoreSource: source };
  }
}
