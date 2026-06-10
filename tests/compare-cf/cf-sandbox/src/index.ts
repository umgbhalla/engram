// engram-compare-cfsandbox — minimal HTTP API over @cloudflare/sandbox so the SAME
// capability probes (probes.mjs) can run against a CF Sandbox container.
//
// The runner (cf-sandbox-adapter.mjs) drives these endpoints:
//   POST /create   { sid, config? }                  -> { ok, sid, context }  create/attach a code context
//   POST /eval     { sid, src }                       -> { ok, value, logs, error, inMemoryBefore, checkpoint }
//   POST /evict    { sid }                            -> { ok, stopped }   stop/destroy the container
//   POST /reconnect{ sid }                            -> { ok }            re-acquire the sandbox
//   POST /snapshot { sid }                            -> { ok:false, error } no public heap-snapshot API
//   GET  /gen?sid=...                                 -> { ok, generation, inMemory }
//
// @cloudflare/sandbox 0.4.x API surface used:
//   import { getSandbox, Sandbox } from "@cloudflare/sandbox";
//   const sb = getSandbox(env.Sandbox, sid);
//   const ctx = await sb.createCodeContext({ language: "javascript" }); // persistent kernel
//   const res = await sb.runCode(src, { context: ctx });                // stateful eval
//   await sb.stop();                                                    // tear down container
//   ExecutionResult = { code, logs:{stdout,stderr}, error?, results:[{text?,json?,...}] }

import { getSandbox, Sandbox } from "@cloudflare/sandbox";

// Re-export the Sandbox DO class so wrangler's durable_objects binding + migration resolve.
export { Sandbox };

export interface Env {
  Sandbox: DurableObjectNamespace;
}

type Json = Record<string, unknown>;

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Per-sid code-context cache living in the WORKER isolate. The DO identity (sid) is durable,
// but this JS map is NOT persisted — it is the live in-RAM handle to the container's kernel.
// This is exactly the CAP-1 discriminator: when the container is torn down (/evict) the live
// kernel and any heap-only globals are gone, even though the container's disk persisted. We
// reuse the SAME context across evals while warm so that a genuinely-stateful kernel is tested
// (the closest CF analogue to engram's persistent REPL namespace).
const ctxCache = new Map<string, any>();

async function getContext(sb: any, sid: string, forceNew = false): Promise<any> {
  if (!forceNew && ctxCache.has(sid)) return ctxCache.get(sid);
  const ctx = await sb.createCodeContext({ language: "javascript" });
  ctxCache.set(sid, ctx);
  return ctx;
}

// Pull the "value" of the last expression out of an ExecutionResult.results[] array.
function extractValue(res: any): unknown {
  const results = Array.isArray(res?.results) ? res.results : [];
  if (results.length === 0) return null;
  const last = results[results.length - 1] || {};
  if (last.json !== undefined) return last.json;
  if (last.text !== undefined) {
    const t = String(last.text);
    // results[].text is a JS-style repr. The CF JS executor single-quotes strings ('armed'),
    // which is NOT valid JSON. Normalize so probes can compare structured values:
    //   try JSON.parse (handles 42, [..], {..}, "..", true/null)
    //   else if single-quoted string literal -> strip the quotes
    //   else return the raw text
    try { return JSON.parse(t); } catch { /* fall through */ }
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
      return t.slice(1, -1).replace(/\\'/g, "'");
    }
    return t;
  }
  if (last.data !== undefined) return last.data;
  return null;
}

function extractLogs(res: any): string[] {
  const out: string[] = [];
  const l = res?.logs;
  if (l && Array.isArray(l.stdout)) out.push(...l.stdout);
  if (l && Array.isArray(l.stderr)) out.push(...l.stderr);
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/gen") {
        const sid = url.searchParams.get("sid") || "default";
        const sb: any = getSandbox(env.Sandbox, sid);
        let inMemory = false;
        try { inMemory = !!(await sb.ping?.()); } catch { inMemory = false; }
        return json({ ok: true, generation: 0, inMemory: inMemory && ctxCache.has(sid) });
      }

      if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
      const body = (await req.json().catch(() => ({}))) as Json;
      const sid = String(body.sid || "default");
      const sb: any = getSandbox(env.Sandbox, sid);

      if (path === "/create") {
        // Fresh context for this session (drops any prior warm kernel for the same sid).
        const ctx = await getContext(sb, sid, /*forceNew*/ true);
        return json({ ok: true, sid, context: ctx?.id ?? null });
      }

      if (path === "/eval") {
        const src = String(body.src ?? "");
        // inMemoryBefore: did a live warm kernel context already exist for this sid?
        const inMemoryBefore = ctxCache.has(sid);
        // Re-use the warm context if present; create one on a cold sandbox.
        const ctx = await getContext(sb, sid, false);
        const res: any = await sb.runCode(src, { context: ctx });
        const err = res?.error
          ? { name: res.error.name, message: res.error.message, stack: res.error.traceback ?? res.error.stack ?? null }
          : null;
        return json({
          ok: !err,
          value: extractValue(res),
          logs: extractLogs(res),
          error: err,
          inMemoryBefore,
          // CF has no per-eval byte-delta heap checkpoint; surface an explicit "none" so probes
          // that read checkpoint.* record the absence honestly.
          checkpoint: { store: "none", mode: "none", sizeGz: null, sizeRaw: null, usedHeap: null },
        });
      }

      if (path === "/evict") {
        // Genuine teardown: drop the live context handle AND stop the container so the next
        // /eval boots a cold kernel with no heap-only state.
        ctxCache.delete(sid);
        let stopped = false;
        try { await (sb.stop?.() ?? sb.destroy?.()); stopped = true; } catch { stopped = false; }
        return json({ ok: true, stopped });
      }

      if (path === "/reconnect") {
        // Re-acquiring is just getSandbox(sid) again; the live context map was cleared on evict,
        // so the next /eval rebuilds a cold context. Nothing durable to restore.
        ctxCache.delete(sid);
        return json({ ok: true });
      }

      if (path === "/snapshot") {
        // No documented heap snapshot/fork in @cloudflare/sandbox 0.4.x; disk-snapshot/fork is a
        // platform feature, not a per-cell live-heap checkpoint. Return typed "unsupported".
        return json({ ok: false, error: "snapshot API not available", bytes: null, ms: null });
      }

      return json({ ok: false, error: `unknown path ${path}` }, 404);
    } catch (e: any) {
      return json({ ok: false, error: e?.message || String(e), name: e?.name || "Error" }, 500);
    }
  },
};
