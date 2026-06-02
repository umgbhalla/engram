// montydyn V1 FACET SPIKE — supervisor Worker + SupervisorDO.
//
// Proves (in order) the ADR-0003 packaging: a supervisor DurableObject loads a DO
// class from a Dynamic Worker (env.LOADER.getDurableObjectClass) and runs it as a
// child FACET (ctx.facets.get) with its OWN isolated SQLite. HTTP routes drive each
// proof step and return JSON so an external smoke client can assert.
import { DurableObject } from "cloudflare:workers";
import {
  COUNTER_SRC,
  WASMPROBE_SRC,
  TINY_WASM_B64,
  QUICKJS_WASM_B64,
  KERNEL_GLUE_SRC,
  QJS_DIST,
} from "./modules.gen.js";

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

export class SupervisorDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS secret (k TEXT PRIMARY KEY, v TEXT);"
    );
    // Supervisor stores a SECRET in its OWN db. Facets must NOT be able to read it.
    this.ctx.storage.sql.exec(
      "INSERT INTO secret(k,v) VALUES('supervisor_secret','TOP-SECRET-42') ON CONFLICT(k) DO UPDATE SET v=excluded.v;"
    );
  }

  // Load the counter dynamic worker (cached warm by codeId) and extract its DO class.
  #loadCounterWorker() {
    return this.env.LOADER.get("counter-v2", async () => ({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "facet-counter.js",
      modules: { "facet-counter.js": COUNTER_SRC },
      globalOutbound: null,
    }));
  }

  #loadWasmProbeWorker() {
    return this.env.LOADER.get("wasmprobe-v2", async () => ({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "facet-wasmprobe.js",
      modules: {
        "facet-wasmprobe.js": WASMPROBE_SRC,
        // Explicit module descriptors. workerd's loader rejects a BARE ArrayBuffer
        // value (it inspects a descriptor object). It DOES support a `wasm` type
        // (revealed by the loader's own error message) → ship as a CompiledWasm-style
        // {wasm} module AND as a {data} ArrayBuffer to compare both paths.
        "tiny.wasm": { wasm: b64ToArrayBuffer(TINY_WASM_B64) },
        "tiny.data": { data: b64ToArrayBuffer(TINY_WASM_B64) },
      },
      globalOutbound: null,
    }));
  }

  #loadKernelWorker() {
    if (!QUICKJS_WASM_B64 || !KERNEL_GLUE_SRC) return null;
    const modules = {
      "facet-kernel.js": KERNEL_GLUE_SRC,
      // quickjs.wasm shipped as {wasm} → arrives as a pre-compiled WebAssembly.Module
      // (the runtime-compile path is blocked; {wasm} is the working CompiledWasm path).
      "quickjs.wasm": { wasm: b64ToArrayBuffer(QUICKJS_WASM_B64) },
    };
    // quickjs-wasi dist files, keyed under qjs/ so relative imports resolve.
    for (const [f, srcStr] of Object.entries(QJS_DIST)) modules["qjs/" + f] = srcStr;
    return this.env.LOADER.get("kernel-v2", async () => ({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "facet-kernel.js",
      modules,
      globalOutbound: null,
    }));
  }

  // Get (or resume) a named counter facet with its own isolated SQLite.
  #counterFacet(name) {
    return this.ctx.facets.get(name, async () => {
      const worker = this.#loadCounterWorker();
      return { class: worker.getDurableObjectClass("CounterFacet") };
    });
  }

  #wasmProbeFacet(name) {
    return this.ctx.facets.get(name, async () => {
      const worker = this.#loadWasmProbeWorker();
      return { class: worker.getDurableObjectClass("WasmProbeFacet") };
    });
  }

  #kernelFacet(name) {
    return this.ctx.facets.get(name, async () => {
      const worker = this.#loadKernelWorker();
      if (!worker) throw new Error("kernel worker not baked");
      return { class: worker.getDurableObjectClass("KernelFacet") };
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const J = (o, code = 200) =>
      new Response(JSON.stringify(o, null, 2), {
        status: code,
        headers: { "content-type": "application/json" },
      });

    try {
      // STEP 2: trivial DO loaded + run as a facet; bump its own SQLite counter.
      if (p === "/step2/bump") {
        const f = this.#counterFacet("tenantA");
        const n = await f.bump();
        return J({ step: 2, facet: "tenantA", counter: n });
      }

      // STEP 2: prove the facet CANNOT read the supervisor's secret. The facet reads
      // 'supervisor_secret' from ITS OWN db (which never has it) → null. Supervisor
      // reads it from its own db → present. Isolation proven.
      if (p === "/step2/isolation") {
        const f = this.#counterFacet("tenantA");
        const facetSeesSecret = await f.read("supervisor_secret");
        const supSeesSecret = this.ctx.storage.sql
          .exec("SELECT v FROM secret WHERE k='supervisor_secret';")
          .toArray()[0]?.v;
        return J({
          step: 2,
          facetSeesSupervisorSecret: facetSeesSecret, // expect null
          supervisorSeesOwnSecret: supSeesSecret, // expect TOP-SECRET-42
          isolated: facetSeesSecret === null && !!supSeesSecret,
        });
      }

      // STEP 3: two facets under one supervisor have independent storage.
      if (p === "/step3/independent") {
        const a = this.#counterFacet("tenantA");
        const b = this.#counterFacet("tenantB");
        await a.write("mine", "A-value");
        await b.write("mine", "B-value");
        const aSees = await a.read("mine");
        const bSees = await b.read("mine");
        // also independent counters
        const aN = await a.bump();
        const bN1 = await b.bump();
        const bN2 = await b.bump();
        return J({
          step: 3,
          aSees,
          bSees,
          independent: aSees === "A-value" && bSees === "B-value",
          aCounter: aN,
          bCounter: bN2,
          countersIndependent: aN !== bN2,
        });
      }

      // PROBES: facet platform features (alarms, websockets, nesting) — undocumented.
      if (p === "/probe/features") {
        const f = this.#counterFacet("probetenant2");
        const ws = await f.probeWebSocket();
        const nesting = await f.probeNesting();
        let alarm;
        try {
          alarm = await f.probeAlarm();
        } catch (e) {
          alarm = { setAlarm: false, threw: String((e && e.message) || e) };
        }
        return J({ probe: "features", ws, nesting, alarm });
      }
      if (p === "/probe/alarm-fired") {
        const f = this.#counterFacet("probetenant");
        return J({ probe: "alarm-fired", firedAt: await f.readAlarmFired() });
      }

      // STEP 4: instantiate WASM from a {data} module inside a facet.
      if (p === "/step4/wasm") {
        const f = this.#wasmProbeFacet("wasmtenant");
        const dataModule = await f.probeDataModule();
        const compiledImport = await f.probeCompiledImport();
        const compile = await f.probeCompile();
        const instantiate = await f.probeInstantiate();
        const syncModule = await f.probeSyncModule();
        return J({ step: 4, dataModule, compiledImport, compile, instantiate, syncModule });
      }

      // STEP 5: quickjs kernel facet — eval one cell, snapshot into the facet's own
      // SQLite, evict, cold-restore.
      if (p.startsWith("/step5/")) {
        if (!QUICKJS_WASM_B64) return J({ step: 5, skipped: "quickjs.wasm not baked" });
        const f = this.#kernelFacet("kerneltenant");
        if (p === "/step5/eval") {
          const src = url.searchParams.get("src") || "globalThis.x=(globalThis.x||0)+1; x";
          const r = await f.evalCell(src);
          return J({ step: 5, op: "eval", ...r });
        }
        if (p === "/step5/snapshot") {
          const r = await f.snapshotToOwnSql();
          return J({ step: 5, op: "snapshot", ...r });
        }
        if (p === "/step5/evict") {
          this.ctx.facets.abort("kerneltenant", new Error("evict for cold-restore test"));
          return J({ step: 5, op: "evict", aborted: true });
        }
        if (p === "/step5/restore") {
          const r = await f.restoreFromOwnSql();
          const ev = await f.evalCell("x");
          return J({ step: 5, op: "restore", restore: r, evalAfter: ev });
        }
      }

      if (p === "/health") return new Response("ok");
      return J({
        spike: "montydyn-v1-facet",
        routes: [
          "/step2/bump",
          "/step2/isolation",
          "/step3/independent",
          "/step4/wasm",
          "/step5/eval?src=...",
          "/step5/snapshot",
          "/step5/evict",
          "/step5/restore",
        ],
      });
    } catch (e) {
      return J({ error: String((e && e.stack) || e) }, 500);
    }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const id = url.searchParams.get("id") || "default";
    const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(id));
    return stub.fetch(req);
  },
};
