// @montydyn/sdk — configurable codemode / RLM infrastructure over the durable montydyn kernel.
//
//   import { connect, MontydynExecutor } from "@montydyn/sdk";
//   const s = await connect({ endpoint: "wss://montydyn-v09...workers.dev", id: "sess",
//                             config: { clock: "seeded", modules: true } });
//   await s.eval("globalThis.x = 41; x + 1");      // -> { ok, value, valuePreview, logs, error? }
//   await s.execute(code, fns);                    // Code Mode drop-in -> { result, error?, logs }
//   await s.setContext("context", bigBlob);        // host-side handle; bytes stay out of the VM
//   s.onSubLM(async ({ prompt, opts }) => "...");  // client supplies the model backend
//   const r = await s.rlm(query, { contextName: "context" });  // depth-1 RLM loop, E2E
//
// Design (honest, per docs/research/rlm-and-codemode.md):
//   * eval = the REPL cell; execute = the Code Mode contract; the host.<name>() proxy = `fns`.
//   * The BIG context lives HOST-SIDE behind host.ctx.* handle tools (escapes the 18MB
//     snapshot envelope); only the slices the model pulls cross into the VM.
//   * host.subLM bridges the leaf-oracle to a MODEL BACKEND THE CLIENT OWNS. The SDK stands up
//     a tiny local HTTP endpoint (onSubLM handler) and passes its URL as config.subLMEndpoint;
//     the kernel POSTs {prompt,opts} to it.
//   * Durable hibernation between cells/turns is the differentiator: the context handle +
//     namespace survive evict/cold-restore (the kernel persists them in the snapshot meta).

import http from "node:http";

function getWebSocketCtor(explicit) {
  if (explicit) return explicit;
  if (typeof WebSocket !== "undefined") return WebSocket;
  throw new Error("No WebSocket available; pass { WebSocket } (e.g. from 'ws') in Node");
}

/**
 * Connect / attach a durable session (creates if absent, resumes the hibernated heap if present).
 * @param {{endpoint:string,id?:string,config?:object,WebSocket?:any,subLMEndpoint?:string,autoReconnect?:boolean}} opts
 */
export async function connect(opts = {}) {
  const endpoint = opts.endpoint || opts.url;
  if (!endpoint) throw new Error("connect({ endpoint }) is required");
  const WS = getWebSocketCtor(opts.WebSocket);
  const id = opts.id || "default";
  const base = String(endpoint).replace(/\/+$/, "");
  const wsUrl = `${base}/ws?id=${encodeURIComponent(id)}`;
  const session = new MontydynSession(WS, wsUrl, opts);
  await session._open();
  return session;
}

export class MontydynSession {
  constructor(WS, wsUrl, opts) {
    this.WS = WS;
    this.wsUrl = wsUrl;
    this.id = opts.id || "default";
    this.config = { ...(opts.config || {}) };
    this.autoReconnect = opts.autoReconnect !== false;
    this.ws = null;
    this._queue = Promise.resolve();
    this._closed = false;
    this._subLMHandler = null;
    this._finalHandler = null;
    this._tools = new Map(); // name -> handler (host-side, served via the local bridge)
    this._bridge = null; // { server, url }
    this._trajectory = []; // [{kind, ...}]
    if (opts.subLMEndpoint) this.config.subLMEndpoint = opts.subLMEndpoint;
  }

  // ---- transport -----------------------------------------------------------
  async _open() {
    if (this.ws && this.ws.readyState === 1) return;
    await new Promise((resolve, reject) => {
      const ws = new this.WS(this.wsUrl);
      this.ws = ws;
      const onErr = (e) => reject(e instanceof Error ? e : new Error("ws error"));
      ws.addEventListener
        ? ws.addEventListener("open", () => resolve(), { once: true })
        : ws.once("open", () => resolve());
      ws.addEventListener ? ws.addEventListener("error", onErr, { once: true }) : ws.once("error", onErr);
    });
    if (this.config && Object.keys(this.config).length) {
      await this._raw({ t: "create", config: this.config });
    }
  }

  _raw(msg, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      const cleanup = () => {
        clearTimeout(timer);
        if (ws.removeEventListener) {
          ws.removeEventListener("message", onMsg);
          ws.removeEventListener("close", onClose);
        } else {
          ws.off("message", onMsg);
          ws.off("close", onClose);
        }
      };
      const onMsg = (ev) => {
        cleanup();
        const data = ev.data !== undefined ? ev.data : ev;
        try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); }
      };
      const onClose = () => { cleanup(); reject(new Error("ws closed before reply")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("rpc timeout")); }, timeoutMs);
      ws.addEventListener
        ? (ws.addEventListener("message", onMsg, { once: true }), ws.addEventListener("close", onClose, { once: true }))
        : (ws.once("message", onMsg), ws.once("close", onClose));
      ws.send(JSON.stringify(msg));
    });
  }

  _send(msg, timeoutMs) {
    const run = async () => {
      try {
        await this._open();
        return await this._raw(msg, timeoutMs);
      } catch (e) {
        if (this.autoReconnect && !this._closed && /closed|error/i.test(String(e.message))) {
          this.ws = null;
          await this._open();
          return await this._raw(msg, timeoutMs);
        }
        throw e;
      }
    };
    const p = this._queue.then(run, run);
    this._queue = p.then(() => {}, () => {});
    return p;
  }

  // ---- codemode / rlms executor contract -----------------------------------
  /** Eval a cell against the persisted namespace. -> { ok, value, valuePreview, logs, error?, final } */
  async eval(src, timeoutMs) {
    const r = await this._send({ t: "eval", src }, timeoutMs);
    this._trajectory.push({ kind: "eval", src, ok: r.ok, valueType: r.valueType, cell: r.cell });
    return r;
  }

  /**
   * Cloudflare Code Mode drop-in: execute(code, fns) -> { result, error?, logs }.
   * `fns` are registered as host tools (host.<name>()), then the code runs in one eval cell.
   * The code should produce its result by returning it (the cell's completion value).
   */
  async execute(code, fns = {}) {
    // Code Mode `fns` are injected into the VM as host.<name> functions from their source.
    // (For a REMOTE kernel the client closure cannot cross; we ship the function SOURCE so the
    // tool runs in-sandbox. Pass pure functions, or use onSubLM/registerTool + the local bridge
    // when the SDK and kernel are co-located and config.subLMEndpoint is publicly reachable.)
    const entries = Object.entries(fns || {});
    if (entries.length) {
      // host is a Proxy (no set-trap), so we cannot just assign host.<name>. Instead wrap it:
      // a plain object that forwards the dynamic host namespaces (ctx/kv/fetch/subLM/final/...)
      // to the original proxy and adds the injected fns as own callable properties.
      const inject = entries.map(([name, fn]) => `    obj[${JSON.stringify(name)}] = (${fn.toString()});`).join("\n");
      await this.eval(
        `(() => {
          const orig = globalThis.host;
          if (!globalThis.__hostOrig) globalThis.__hostOrig = orig;
          const obj = (typeof globalThis.host === 'object' && globalThis.host && !globalThis.host.__wrapped) ? globalThis.host : {};
          obj.__wrapped = true;
          // forward known dynamic namespaces to the original host proxy
          for (const k of ['ctx','kv','fetch','subLM','final','finalVar','echo','add','now']) {
            try { Object.defineProperty(obj, k, { configurable: true, enumerable: false, get(){ return globalThis.__hostOrig[k]; } }); } catch(_){}
          }
${inject}
          globalThis.host = obj;
          return 'fns-injected';
        })()`,
      );
    }
    const r = await this.eval(code);
    const logs = (r.logs || []).map((l) => (typeof l === "string" ? l : `${l.level}: ${l.text}`));
    if (!r.ok) return { result: undefined, error: r.error ? `${r.error.name}: ${r.error.message}` : "error", logs };
    // For object/array results the kernel returns `value` as the preview JSON string; parse it
    // back so the Code Mode `result` is the real structured value. (An async-IIFE whose value
    // previews as {} is a known kernel unwrap limitation; prefer a synchronous return or a
    // top-level await expression for rich results.)
    let result = r.value;
    if ((r.valueType === "object" || r.valueType === "array") && typeof r.value === "string") {
      try { result = JSON.parse(r.value); } catch (_) {}
      if ((result == null || (typeof result === "object" && Object.keys(result).length === 0)) && r.valuePreview) {
        try { result = JSON.parse(r.valuePreview); } catch (_) {}
      }
    }
    return { result, logs };
  }

  async reset() { return this._send({ t: "reset" }); }
  async gen() { return this._send({ t: "gen" }); }

  // ---- context-as-variable (host-side handle) ------------------------------
  /** Store a big context blob HOST-SIDE; the VM reads it via host.ctx.*; bytes stay out of the heap. */
  async setContext(name, blob) {
    if (blob === undefined) { blob = name; name = "context"; }
    return this._send({ t: "setContext", name: name || "context", blob: String(blob) }, 120000);
  }

  // ---- host tools / sub-LM / final -----------------------------------------
  /** Register a host tool (the host.<name>() boundary). Handler: (...args) => any (sync or async). */
  registerTool(name, handler) { this._tools.set(String(name), handler); return this; }

  /** Client supplies the model backend (the leaf oracle). Handler: ({prompt,opts}) => string|Promise<string>. */
  onSubLM(handler) { this._subLMHandler = handler; return this; }

  /** Notified when the RLM answer is recorded (host.final/host.finalVar). */
  onFinal(handler) { this._finalHandler = handler; return this; }

  // ---- lifecycle / durability ----------------------------------------------
  /** Force-evict the in-memory kernel (durable snapshot kept). Wakes with full state on next op. */
  async hibernate() { return this._send({ t: "evict" }); }
  /** Wake the session and confirm liveness/state. */
  async resume() { await this._open(); return this.gen(); }
  /** The recorded cell/sub-call trajectory + the server-recorded final answer. */
  async trajectory() {
    const f = await this._send({ t: "final" });
    return { cells: this._trajectory.slice(), final: f.final || null };
  }

  // ---- the depth-1 RLM loop (E2E) ------------------------------------------
  /**
   * Run the canonical depth-1 RLM loop on montydyn. The ROOT 'LM' (a pluggable rootModel that
   * writes JS cells) sees the query + the context handle surface; it emits code that
   * greps/chunks host.ctx and queues sub-LM prompts via host.subLM(prompt). The SDK orchestrates:
   * it runs each cell, drains any queued sub-LM prompts through the CLIENT-SIDE model backend
   * (onSubLM), feeds the completions back into the VM (globalThis.__subLM[id]), re-runs the cell
   * with answers available, and returns when host.final(answer) fires.
   *
   * This SDK-orchestrated path works against the REMOTE deployed kernel (the kernel never has to
   * reach back to the client). host.subLM also works as a direct async fetch when the SDK and
   * kernel are CO-LOCATED and config.subLMEndpoint is publicly reachable (see _ensureBridge).
   * @param {string} query
   * @param {{contextName?:string, rootModel?:Function, maxSteps?:number}} opts
   */
  async rlm(query, opts = {}) {
    const contextName = opts.contextName || "context";
    const maxSteps = opts.maxSteps || 6;
    const rootModel = opts.rootModel || defaultRootModel;
    // Install the host-side queueing host.subLM shim ONCE: it records prompts and reads back
    // answers the SDK injects, so a cell can `await host.subLM(p)` while the SDK runs the backend.
    await this.eval(SUBLM_SHIM_SRC);
    let subLMCalls = 0;
    const history = [];
    for (let step = 0; step < maxSteps; step++) {
      const code = await rootModel({ query, contextName, step, history, session: this });
      if (code == null) break;
      // Run-then-drain loop: the cell may queue sub-LM prompts; fulfill them client-side and
      // re-run until no new prompts appear (or host.final fires).
      let r;
      for (let pump = 0; pump < 500; pump++) {
        r = await this.eval(`globalThis.__subLM_run(${JSON.stringify(code)})`, 120000);
        // The cell returns the queue; an array return previews as a JSON STRING in `value`, so
        // we JSON.parse it (a plain array `value` is also handled).
        const pending = await this.eval(`JSON.stringify(globalThis.__subLM_pending())`);
        let reqs = [];
        if (pending.ok) {
          try { reqs = typeof pending.value === "string" ? JSON.parse(pending.value) : (Array.isArray(pending.value) ? pending.value : []); }
          catch (_) { reqs = []; }
        }
        if (reqs.length === 0) break;
        const answers = {};
        for (const req of reqs) {
          subLMCalls++;
          this._trajectory.push({ kind: "subLM", prompt: String(req.prompt).slice(0, 200) });
          const h = this._subLMHandler;
          answers[req.id] = h ? String(await h({ prompt: req.prompt, opts: req.opts || {} })) : "";
        }
        await this.eval(`globalThis.__subLM_fulfill(${JSON.stringify(answers)})`);
      }
      history.push({ step, code, ok: r.ok, value: r.value, valuePreview: r.valuePreview, logs: r.logs, error: r.error });
      const finR = await this._send({ t: "final" });
      const fin = finR.final && finR.final.kind ? finR.final : null;
      if (fin) {
        this._trajectory.push({ kind: "final", final: fin });
        if (this._finalHandler) await this._finalHandler(fin);
        return { answer: fin.value, kind: fin.kind, steps: step + 1, subLMCalls, history };
      }
    }
    const last = history[history.length - 1];
    return { answer: last ? last.value : null, kind: "EXHAUSTED", steps: history.length, subLMCalls, history };
  }

  // ---- v0.9.2 LAMBDA-RLM (typed combinators, bounded + cost-capped) --------
  /**
   * Run the LAMBDA-RLM (lambda-calculus RLM) over a context using the in-VM typed combinators
   * (globalThis.lambda.SPLIT/MAP/REDUCE + the bounded recursion driver). Unlike free-form rlm(),
   * this is PROVABLY TERMINATING and cost-capped: recursion is bounded by maxDepth and the total
   * number of leaf-oracle (host.subLM) calls is hard-capped at costBudget, so a deliberately
   * over-decomposing query is bounded, never blown up.
   *
   * The leaf oracle is the CLIENT's model backend (onSubLM): we install the cooperative sub-LM
   * shim (same mechanism as rlm()), run the lambda driver in ONE cell, drain queued leaf prompts
   * through onSubLM, and re-run until the driver completes. Works against the REMOTE deployed
   * kernel (the kernel never reaches back to the client).
   *
   * @param {string} query
   * @param {{context?:string, ctx?:string, split?:any, reduce?:any,
   *          maxDepth?:number, costBudget?:number, leafChars?:number, tau?:number, maxPumps?:number}} opts
   */
  async lambdaRLM(query, opts = {}) {
    const has = await this.eval(
      "typeof globalThis.lambda === 'object' && typeof globalThis.lambda.lambdaRLM === 'function'",
    );
    if (!(has.ok && (has.value === true || has.value === "true"))) {
      throw new Error(
        "lambdaRLM requires the in-VM `lambda` stdlib module. Create the session with " +
          "config.modules:true (default set includes `lambda`) or config.modules:[...,'lambda'].",
      );
    }
    await this.eval(SUBLM_SHIM_SRC);
    // Clear any leaf-answer cache from a PRIOR lambdaRLM/rlm run on this session so this run's
    // leaves are actually fired (the cache only makes a single run's re-runs deterministic).
    await this.eval(`globalThis.__subLM_answers = {}; globalThis.__subLM_queue = []; globalThis.__lambda_result = null; 0`);
    const drvOpts = {
      maxDepth: opts.maxDepth != null ? opts.maxDepth : 2,
      costBudget: opts.costBudget != null ? opts.costBudget : 32,
    };
    if (opts.leafChars != null) drvOpts.leafChars = opts.leafChars;
    if (opts.tau != null) drvOpts.tau = opts.tau;
    if (typeof opts.split === "number" || typeof opts.split === "string") drvOpts.split = opts.split;
    if (typeof opts.reduce === "string" || opts.reduce === true) drvOpts.reduce = opts.reduce;
    if (opts.context != null) drvOpts.context = String(opts.context);
    else if (opts.ctx != null) drvOpts.ctx = String(opts.ctx);
    else drvOpts.ctx = "context";

    const splitSrc = typeof opts.split === "function" ? opts.split.toString() : null;
    const reduceSrc = typeof opts.reduce === "function" ? opts.reduce.toString() : null;

    const code = `
      (async () => {
        const opts = ${JSON.stringify(drvOpts)};
        ${splitSrc ? `opts.split = (${splitSrc});` : ""}
        ${reduceSrc ? `opts.reduce = (${reduceSrc});` : ""}
        const r = await globalThis.lambda.lambdaRLM(${JSON.stringify(query)}, opts);
        globalThis.__lambda_result = r;
        host.final(r.answer);
        return r;
      })()
    `;

    const maxPumps = opts.maxPumps || 2000;
    let subLMCalls = 0;
    for (let pump = 0; pump < maxPumps; pump++) {
      await this.eval(`globalThis.__subLM_run(${JSON.stringify(code)})`, 120000);
      const pending = await this.eval(`JSON.stringify(globalThis.__subLM_pending())`);
      let reqs = [];
      if (pending.ok) {
        try { reqs = typeof pending.value === "string" ? JSON.parse(pending.value) : (Array.isArray(pending.value) ? pending.value : []); }
        catch (_) { reqs = []; }
      }
      if (reqs.length === 0) break;
      const answers = {};
      for (const req of reqs) {
        subLMCalls++;
        this._trajectory.push({ kind: "subLM", prompt: String(req.prompt).slice(0, 200) });
        const h = this._subLMHandler;
        answers[req.id] = h ? String(await h({ prompt: req.prompt, opts: req.opts || {} })) : "";
      }
      await this.eval(`globalThis.__subLM_fulfill(${JSON.stringify(answers)})`);
    }
    const meta = await this.eval(`JSON.stringify(globalThis.__lambda_result || null)`);
    let result = null;
    try { result = typeof meta.value === "string" ? JSON.parse(meta.value) : meta.value; } catch (_) {}
    const fin = await this._send({ t: "final" });
    this._trajectory.push({ kind: "lambdaRLM", query, leafCalls: result ? result.leafCalls : subLMCalls });
    return {
      answer: result ? result.answer : (fin.final ? fin.final.value : null),
      leafCalls: result ? result.leafCalls : subLMCalls,
      maxDepthSeen: result ? result.maxDepthSeen : null,
      exhausted: result ? !!result.exhausted : false,
      budget: result ? result.budget : { maxDepth: drvOpts.maxDepth, costBudget: drvOpts.costBudget },
      subLMCalls,
    };
  }

  // ---- the client-side sub-LM bridge (local HTTP endpoint) -----------------
  // The kernel's host.subLM POSTs {prompt,opts} here; we run the client's onSubLM handler and
  // return {completion}. The endpoint host is auto-added to config.fetch (the allowlist).
  async _ensureBridge() {
    if (this._bridge) return this._bridge;
    if (!this._subLMHandler && this._tools.size === 0) return null;
    const self = this;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const j = body ? JSON.parse(body) : {};
          if (req.url === "/sublm") {
            self._trajectory.push({ kind: "subLM", prompt: String(j.prompt || "").slice(0, 200) });
            const h = self._subLMHandler;
            const out = h ? await h({ prompt: j.prompt, opts: j.opts || {} }) : "";
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ completion: String(out == null ? "" : out) }));
            return;
          }
          if (req.url && req.url.startsWith("/tool/")) {
            const name = decodeURIComponent(req.url.slice("/tool/".length));
            const fn = self._tools.get(name);
            const out = fn ? await fn(...(Array.isArray(j.args) ? j.args : [])) : null;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ value: out == null ? null : out }));
            return;
          }
          res.writeHead(404); res.end("{}");
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
        }
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}`;
    this._bridge = { server, url, port };
    // Wire the kernel: subLM endpoint + allowlist the bridge host so host.subLM/host.fetch reach it.
    const fetchAllow = Array.isArray(this.config.fetch) ? this.config.fetch.slice() : [];
    if (!fetchAllow.includes("127.0.0.1")) fetchAllow.push("127.0.0.1");
    this.config = { ...this.config, subLMEndpoint: `${url}/sublm`, fetch: this.config.fetch === true ? true : fetchAllow };
    await this._send({ t: "create", config: this.config });
    return this._bridge;
  }

  close() {
    this._closed = true;
    if (this._bridge) { try { this._bridge.server.close(); } catch (_) {} this._bridge = null; }
    if (this.ws) { try { this.ws.close(); } catch (_) {} }
  }
}

// In-VM cooperative sub-LM shim installed by rlm(). It overrides host.subLM with a
// REPLAY-BASED resolver: each cell run replays from scratch; the Nth host.subLM(prompt) call
// returns its cached answer if the SDK has provided one, otherwise it QUEUES the prompt and
// aborts the cell (a sentinel rejection). The SDK fulfills the queued prompts via the
// client-side model backend, then re-runs the cell; once every prompt is cached the cell runs
// to completion (and calls host.final). Deterministic prompt order is required (the RLM scaffold
// computes prompts from the context handle + prior cached answers, which is deterministic).
const SUBLM_SHIM_SRC = `
  (() => {
    globalThis.__subLM_answers = globalThis.__subLM_answers || {};   // key -> completion
    globalThis.__subLM_queue = [];                                    // [{id, prompt, opts}]
    const PENDING = "__SUBLM_PENDING__";
    // Stable key per prompt+opts so re-runs map to the same answer regardless of call order.
    const keyOf = (prompt, opts) => { try { return JSON.stringify([prompt, opts || null]); } catch (_) { return String(prompt); } };
    // Override host.subLM to the cooperative resolver (returns a resolved Promise of the answer,
    // or queues + throws PENDING to abort this cell run).
    globalThis.host = new Proxy(globalThis.host, {
      get(t, name) {
        if (name === 'subLM') {
          return (prompt, opts) => {
            const k = keyOf(String(prompt), opts);
            if (Object.prototype.hasOwnProperty.call(globalThis.__subLM_answers, k)) {
              return Promise.resolve(globalThis.__subLM_answers[k]);
            }
            globalThis.__subLM_queue.push({ id: k, prompt: String(prompt), opts: opts || null });
            throw PENDING; // abort the cell; the SDK will fulfill + re-run.
          };
        }
        return t[name];
      },
    });
    globalThis.__subLM_run = (codeStr) => {
      globalThis.__subLM_queue = [];
      try {
        // eval the cell source; if it throws PENDING, swallow it (queue holds the prompts).
        return eval(codeStr);
      } catch (e) {
        if (e === PENDING || (e && e.message === PENDING)) return { __pending: true };
        throw e;
      }
    };
    // Async cells: a thrown PENDING inside an async IIFE rejects the returned promise. The
    // pump checks the QUEUE (not the cell value), so a rejected pending cell is fine.
    globalThis.__subLM_pending = () => globalThis.__subLM_queue.slice();
    globalThis.__subLM_fulfill = (answers) => { Object.assign(globalThis.__subLM_answers, answers); return Object.keys(answers).length; };
    return 'subLM-shim-ready';
  })()
`;

// A trivial deterministic default ROOT model (no LLM). Step 0: chunk the context, fan
// host.subLM over each chunk, reduce, then host.final. Useful for smoke/tests; real callers
// pass their own rootModel (or use host.subLM with a real backend via onSubLM).
function defaultRootModel({ query, contextName, step }) {
  if (step > 0) return null; // single-shot scaffold
  return `
    (async () => {
      const name = ${JSON.stringify(contextName)};
      const q = ${JSON.stringify(query)};
      const total = host.ctx.len(name);
      const chunks = host.ctx.chunk(4000, name);
      const parts = [];
      for (const c of chunks) {
        const text = host.ctx.get(c.i, 4000, name);
        parts.push(await host.subLM("Query: " + q + "\\n\\nChunk " + c.i + ":\\n" + text, { chunk: c.i }));
      }
      const answer = await host.subLM("Query: " + q + "\\n\\nReduce these partials into one answer:\\n" + parts.join("\\n---\\n"), { reduce: true });
      host.final(answer);
      return { totalChars: total, nChunks: chunks.length };
    })()
  `;
}

/**
 * Cloudflare Code Mode executor (drop-in for DynamicWorkerExecutor):
 *   const ex = new MontydynExecutor({ endpoint, id, config });
 *   await ex.execute(code, fns) -> { result, error?, logs }
 */
export class MontydynExecutor {
  constructor(opts = {}) { this.opts = opts; this.session = null; }
  async _session() { if (!this.session) this.session = await connect(this.opts); return this.session; }
  async execute(code, fns = {}) { const s = await this._session(); return s.execute(code, fns); }
  async close() { if (this.session) this.session.close(); this.session = null; }
}

/** rlms-style environment adapter (so a JS RLM scaffold can select environment='montydyn'). */
export class MontydynEnv {
  constructor(opts = {}) { this.opts = opts; this.session = null; }
  async _session() { if (!this.session) this.session = await connect(this.opts); return this.session; }
  async run(code) {
    const s = await this._session();
    const r = await s.eval(code);
    return { stdout: (r.logs || []).map((l) => l.text).join("\n"), result: r.value, error: r.ok ? undefined : (r.error && r.error.message) };
  }
  async setContextVar(name, value) { const s = await this._session(); return s.setContext(name, typeof value === "string" ? value : JSON.stringify(value)); }
  async installDeps(_modules) { /* config.modules is set at connect; no-op runtime install */ }
  async close() { if (this.session) this.session.close(); this.session = null; }
}

// ===========================================================================
// v0.9.2 — AGENT CODE-MODE ADAPTER
//
// Gives an AI agent a DURABLE per-agent session: the agent writes JS that runs in its OWN
// montydyn facet/session; the registered host tools (host.<name>()) ARE the agent's tool surface;
// multi-turn state lives in the snapshot (hibernates between turns, restores on the next turn).
// This is the Code Mode paradigm ("write code" is the one tool; tools render as a typed API) on
// top of the durable kernel — the differentiator nobody else has is hibernation BETWEEN turns.
//
//   const agent = await createAgent({ endpoint, id: "agent-7", config: { modules: true } });
//   agent.registerTool("search", async (q) => [...]);            // tool -> host_call
//   const t1 = await agent.turn(`globalThis.notes = await host.search("x"); notes.length`);
//   await agent.hibernate();                                     // sleep between turns
//   const t2 = await agent.turn(`notes.length`);                 // turn-2 SEES turn-1's state
//   // t2.result === t1.result   (durable across the simulated hibernation)
//
// A turn returns { result, logs, toolCalls } (Code Mode's shape). Tool calls route through the
// kernel's host_call boundary; the SDK records each one in toolCalls. Tools are served via the
// client-side HTTP bridge (host.<name> -> host_call -> POST /tool/<name> -> handler), so a remote
// kernel reaches the client's tool implementations without the closure having to cross the wire.
// ===========================================================================
export class Agent {
  /**
   * @param {MontydynSession} session
   * @param {{tools?:Record<string,Function>}} [opts]
   */
  constructor(session, opts = {}) {
    this.session = session;
    this.turns = []; // [{ turn, code, result, logs, toolCalls }]
    this._toolCalls = []; // accumulates the CURRENT turn's tool calls
    this._registered = new Set();
    this._handlers = new Map(); // name -> client-side handler (the host_call implementation)
    if (opts.tools) for (const [n, fn] of Object.entries(opts.tools)) this.registerTool(n, fn);
  }

  /**
   * Code Mode tool-registration: map a named tool -> a host_call. The handler runs CLIENT-SIDE;
   * inside the agent's code it is callable as host.<name>(...args). The call is drained through
   * the cooperative tool shim (no inbound connection needed) and recorded in the turn's toolCalls.
   * Registering after the first turn re-wires the shim on the next turn.
   */
  registerTool(name, handler) {
    this._handlers.set(String(name), handler);
    this._registered.add(String(name));
    this._toolShimWired = false; // re-install the shim so the new tool name is bound
    return this;
  }

  /**
   * Wire the tool surface into the kernel WITHOUT an inbound connection (works against the REMOTE
   * deployed worker). We install a COOPERATIVE tool shim (the same queue/replay mechanism as the
   * sub-LM shim): host.<name>(...args) either returns its cached result or QUEUES the call and
   * aborts the cell; the SDK drains the queue through the client-side handlers (the host_call
   * boundary) and re-runs the cell until it completes. This is the Code Mode "tools render as a
   * typed API; calls become host_call" mapping, transport-agnostic.
   */
  async _ensureToolShim() {
    if (this._toolShimWired) return;
    const names = Array.from(this._registered);
    const installSrc = `
      (() => {
        globalThis.__agent_answers = globalThis.__agent_answers || {};   // callKey -> JSON result
        globalThis.__agent_queue = [];                                    // [{id, tool, args}]
        const PENDING = "__AGENT_PENDING__";
        const keyOf = (tool, args) => { try { return JSON.stringify([tool, args]); } catch(_) { return tool + ":" + String(args); } };
        const names = ${JSON.stringify(names)};
        const nameSet = new Set(names);
        const orig = globalThis.__agentHostOrig || globalThis.host;
        globalThis.__agentHostOrig = orig;
        const obj = {};
        // forward the built-in dynamic host namespaces + the lambda combinator module — but NEVER
        // a name the agent registered as a tool (agent tools take precedence over builtins, so a
        // tool named e.g. 'add' shadows the demo host.add).
        for (const k of ['ctx','kv','fetch','subLM','final','finalVar','echo','add','now']) {
          if (nameSet.has(k)) continue;
          try { Object.defineProperty(obj, k, { configurable: true, enumerable: false, get(){ return globalThis.__agentHostOrig[k]; } }); } catch(_){}
        }
        try { Object.defineProperty(obj, 'lambda', { configurable: true, enumerable: false, get(){ return globalThis.lambda; } }); } catch(_){}
        for (const name of names) {
          obj[name] = (...args) => {
            const k = keyOf(name, args);
            if (Object.prototype.hasOwnProperty.call(globalThis.__agent_answers, k)) {
              return Promise.resolve(globalThis.__agent_answers[k]);
            }
            globalThis.__agent_queue.push({ id: k, tool: name, args });
            throw PENDING; // abort this cell run; the SDK fulfills + re-runs.
          };
        }
        globalThis.host = obj;
        // Run a turn's code. We await it so the SETTLED value (not a Promise) becomes the cell
        // result, sidestepping the kernel's async-IIFE-previews-as-{} unwrap limitation. A PENDING
        // (sync throw OR async rejection) aborts cleanly; the SDK fulfills the queue + re-runs.
        globalThis.__agent_run = async (codeStr) => {
          globalThis.__agent_queue = [];
          try {
            const v = await eval(codeStr);
            globalThis.__agent_lastResult = v;
            return v;
          } catch (e) {
            if (e === PENDING || (e && e.message === PENDING)) return { __pending: true };
            throw e;
          }
        };
        globalThis.__agent_pending = () => globalThis.__agent_queue.slice();
        globalThis.__agent_fulfill = (answers) => { Object.assign(globalThis.__agent_answers, answers); return Object.keys(answers).length; };
        return 'agent-tool-shim-ready';
      })()
    `;
    await this.session.eval(installSrc);
    this._toolShimWired = true;
  }

  /**
   * Run ONE agent turn. `code` is JS the agent wrote; it runs against the persisted namespace
   * (so it sees prior turns' globals). Returns { result, logs, toolCalls } (Code Mode shape).
   * Tool calls (host.<name>) are drained through the client-side handlers (host_call boundary)
   * via a cooperative run-then-drain loop, then the cell re-runs with answers cached.
   * @param {string} code
   */
  async turn(code) {
    await this._ensureToolShim();
    this._toolCalls = [];
    const turnIdx = this.turns.length;
    const hasTools = this._registered.size > 0;
    let r;
    if (!hasTools) {
      r = await this.session.eval(code, 120000);
    } else {
      // Clear the per-turn answer cache so a tool with identical args in a LATER turn is actually
      // re-invoked (the cache exists only to make a single turn's re-runs deterministic).
      await this.session.eval(`globalThis.__agent_answers = {}; 0`);
      // run-then-drain: the cell may queue tool calls; fulfill them client-side and re-run until
      // none remain (answers are cached + replayed within THIS turn, so re-running is deterministic).
      for (let pump = 0; pump < 500; pump++) {
        r = await this.session.eval(`globalThis.__agent_run(${JSON.stringify(code)})`, 120000);
        const pending = await this.session.eval(`JSON.stringify(globalThis.__agent_pending())`);
        let reqs = [];
        if (pending.ok) {
          try { reqs = typeof pending.value === "string" ? JSON.parse(pending.value) : (Array.isArray(pending.value) ? pending.value : []); }
          catch (_) { reqs = []; }
        }
        if (reqs.length === 0) break;
        const answers = {};
        for (const req of reqs) {
          const handler = this._handlers.get(req.tool);
          const call = { tool: req.tool, args: req.args, ts: Date.now() };
          try {
            const out = await (handler ? handler(...(req.args || [])) : undefined);
            call.ok = true; call.result = out;
            answers[req.id] = out === undefined ? null : out;
          } catch (e) {
            call.ok = false; call.error = String(e && e.message ? e.message : e);
            answers[req.id] = null;
          }
          this._toolCalls.push(call);
        }
        await this.session.eval(`globalThis.__agent_fulfill(${JSON.stringify(answers)})`);
      }
    }
    const logs = (r.logs || []).map((l) => (typeof l === "string" ? l : `${l.level}: ${l.text}`));
    let result = r.value;
    if ((r.valueType === "object" || r.valueType === "array") && typeof r.value === "string") {
      try { result = JSON.parse(r.value); } catch (_) {}
    }
    // Read back the explicit last-result global (clean structured value; sidesteps the kernel's
    // async-IIFE unwrap limitation where an object result previews as {}).
    if (hasTools && r.ok) {
      const lr = await this.session.eval(`JSON.stringify(globalThis.__agent_lastResult === undefined ? null : globalThis.__agent_lastResult)`);
      if (lr.ok) { try { const v = typeof lr.value === "string" ? JSON.parse(lr.value) : lr.value; if (v !== null) result = v; } catch (_) {} }
    }
    const rec = {
      turn: turnIdx,
      code,
      ok: r.ok,
      result: r.ok ? result : undefined,
      error: r.ok ? undefined : (r.error ? `${r.error.name}: ${r.error.message}` : "error"),
      logs,
      toolCalls: this._toolCalls.slice(),
    };
    this.turns.push(rec);
    return rec;
  }

  /** Hibernate the agent between turns (durable snapshot kept; state restores on the next turn). */
  async hibernate() { return this.session.hibernate(); }
  /** Wake the agent (state restores from the snapshot on the next op). */
  async resume() { return this.session.resume(); }
  /** The full multi-turn transcript (code + result + logs + tool calls per turn). */
  transcript() { return this.turns.slice(); }
  close() { return this.session.close(); }
}

/**
 * Create a durable per-agent code-mode session.
 * @param {{endpoint:string, id?:string, config?:object, WebSocket?:any, tools?:Record<string,Function>,
 *          onSubLM?:Function}} opts
 * @returns {Promise<Agent>}
 */
export async function createAgent(opts = {}) {
  const session = await connect(opts);
  if (opts.onSubLM) session.onSubLM(opts.onSubLM);
  return new Agent(session, { tools: opts.tools });
}

export default { connect, MontydynSession, MontydynExecutor, MontydynEnv, Agent, createAgent };
