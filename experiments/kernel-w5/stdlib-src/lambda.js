// engram v0.9.2 — LAMBDA-RLM TYPED COMBINATORS (in-VM stdlib module).
//
// The "lambda calculus" RLM from docs/research/rlm-and-codemode.md (arXiv:2603.20105,
// "The Y-Combinator for LLMs"): replace canonical RLM's free-form code loop with TYPED,
// DETERMINISTIC combinators (SPLIT / MAP / REDUCE) whose only LM contact is at the LEAVES
// (host.subLM). A depth + cost budget makes recursion PROVABLY TERMINATING and cost-capped:
//
//   λ-RLM ≡ fix(λf. λP. if |P| ≤ τ* then M(P)
//                       else REDUCE(⊕, MAP(λpᵢ. f(pᵢ), SPLIT(P, k*))))
//
// where M = the leaf oracle (host.subLM), all control flow (SPLIT/MAP/REDUCE) is deterministic,
// and the Y-combinator (fix) makes recursion an explicit semantic object rather than emergent
// model behavior. Unlike free-form RLM this CANNOT blow up: every recursion decrements `maxDepth`
// AND every leaf-oracle call decrements a hard `costBudget`; when either is exhausted the node
// degrades to a SINGLE truncated leaf call (or a deterministic fallback) instead of fanning out.
//
// This module installs `globalThis.lambda` (and is also reachable as host.lambda.* via the SDK
// sugar). It is PURE in-VM JS — it composes the existing host.ctx.* (context handle) and
// host.subLM (leaf oracle) primitives; no new VM/host primitive is required. Because it lives in
// the heap it is snapshot-captured and survives hibernation for free (like all stdlib).
(() => {
  // ---- cost ledger -----------------------------------------------------------
  // A single mutable budget object threaded through a whole lambdaRLM run. Every leaf-oracle
  // call decrements `leavesLeft`; every recursive descent decrements `depth`. When the ledger
  // is exhausted the combinators STOP fanning out — the closed-form bound is:
  //   total leaf calls  ≤  costBudget                (hard ceiling, independent of decomposition)
  //   recursion depth   ≤  maxDepth                  (each SPLIT level costs 1 depth)
  // so a deliberately over-decomposing query is BOUNDED, never exponential.
  function makeBudget(opts) {
    opts = opts && typeof opts === "object" ? opts : {};
    return {
      depthLeft: Number.isFinite(opts.maxDepth) ? Math.max(0, opts.maxDepth | 0) : 2,
      leavesLeft: Number.isFinite(opts.costBudget) ? Math.max(1, opts.costBudget | 0) : 32,
      leafChars: Number.isFinite(opts.leafChars) ? Math.max(256, opts.leafChars | 0) : 4000,
      // τ* — a part at or below this size is a LEAF (no further SPLIT). Defaults to leafChars.
      tau: Number.isFinite(opts.tau) ? Math.max(256, opts.tau | 0) : (Number.isFinite(opts.leafChars) ? opts.leafChars | 0 : 4000),
      // telemetry
      leafCalls: 0,
      splits: 0,
      maxDepthSeen: 0,
      exhausted: false,
    };
  }

  // ---- SPLIT(ctx, by) -> parts ----------------------------------------------
  // Deterministically partition a context (a string, OR a {name} host.ctx handle ref, OR an
  // array) into parts. `by` controls the partition rule:
  //   number          -> fixed-size char chunks of that many chars
  //   "lines"         -> split on newlines (grouped to ~tau chars)
  //   "paragraphs"    -> split on blank lines (grouped to ~tau chars)
  //   regexp / string -> split on that separator
  //   function        -> by(text) -> string[]  (custom)
  // A handle ref {ctx:name} reads through host.ctx.* so the bytes never enter the heap wholesale.
  function SPLIT(ctx, by, budget) {
    budget = budget || makeBudget({});
    budget.splits++;
    const tau = budget.tau;
    // Array passes through (already partitioned).
    if (Array.isArray(ctx)) return ctx.slice();
    // Host-side context handle: {ctx:"name"} -> chunk via host.ctx (bytes stay host-side).
    if (ctx && typeof ctx === "object" && typeof ctx.ctx === "string") {
      const name = ctx.ctx;
      const size = typeof by === "number" && by > 0 ? (by | 0) : tau;
      const chunks = host.ctx.chunk(size, name);
      // Return LAZY handle parts: each part is {ctx:name, start, end} so MAP can pull only the
      // slice it needs (still escapes the 18MB envelope for a genuinely huge context).
      return chunks.map((c) => ({ ctx: name, start: c.start, end: c.end, i: c.i }));
    }
    const s = String(ctx == null ? "" : ctx);
    if (typeof by === "function") return by(s);
    if (typeof by === "number" && by > 0) {
      const out = [];
      for (let i = 0; i < s.length; i += by) out.push(s.slice(i, i + by));
      return out.length ? out : [s];
    }
    if (by === "lines" || by === "paragraphs") {
      const sep = by === "paragraphs" ? /\n\s*\n/ : /\n/;
      const raw = s.split(sep);
      // group adjacent units up to ~tau so we don't fan out into thousands of tiny leaves
      const out = [];
      let cur = "";
      for (const u of raw) {
        if (cur.length + u.length + 1 > tau && cur.length) { out.push(cur); cur = ""; }
        cur += (cur ? "\n" : "") + u;
      }
      if (cur.length) out.push(cur);
      return out.length ? out : [s];
    }
    if (by instanceof RegExp || typeof by === "string") {
      const parts = s.split(by);
      return parts.length ? parts : [s];
    }
    // default: fixed-size tau chunks
    const out = [];
    for (let i = 0; i < s.length; i += tau) out.push(s.slice(i, i + tau));
    return out.length ? out : [s];
  }

  // Resolve a part to its TEXT (pulling a lazy host-side slice through host.ctx if needed),
  // capped at leafChars so a leaf prompt can never exceed the model window / WS-1006 the cell.
  function partText(part, budget) {
    const cap = budget.leafChars;
    if (part && typeof part === "object" && typeof part.ctx === "string") {
      // P1 fix: a single-leaf (un-SPLIT) handle has no start/end -> default end to
      // the FULL context length (host.ctx.len) so it doesn't slice(0,0) to empty.
      const start = part.start | 0;
      const end = part.end != null ? (part.end | 0) : host.ctx.len(part.ctx);
      const t = host.ctx.slice(start, end, part.ctx);
      return t.length > cap ? t.slice(0, cap) : t;
    }
    const s = String(part == null ? "" : part);
    return s.length > cap ? s.slice(0, cap) : s;
  }

  // ---- MAP(parts, leafFn) -> results ----------------------------------------
  // Apply the leaf oracle to each part. `leafFn(text, i, part)` SHOULD be a bounded sub-LM call
  // (await host.subLM(...)). MAP is async (leaves await the oracle) and decrements the shared
  // cost budget per leaf; once the budget is exhausted REMAINING parts are NOT sent to the oracle
  // (they return a deterministic "[budget-exhausted]" sentinel) — this is the hard cost cap.
  // Leaves are independent so they CAN be fired concurrently (Promise.all); the kernel drains all
  // in-flight host.subLM fetches in one eval-pump round, so parallel leaves complete in one turn.
  async function MAP(parts, leafFn, budget) {
    budget = budget || makeBudget({});
    const results = new Array(parts.length);
    const tasks = [];
    for (let i = 0; i < parts.length; i++) {
      if (budget.leavesLeft <= 0) {
        budget.exhausted = true;
        results[i] = "[budget-exhausted]";
        continue;
      }
      budget.leavesLeft--;
      budget.leafCalls++;
      const idx = i;
      const part = parts[i];
      const text = partText(part, budget);
      tasks.push(
        Promise.resolve(leafFn(text, idx, part)).then((r) => { results[idx] = r; }),
      );
    }
    await Promise.all(tasks);
    return results;
  }

  // ---- REDUCE(results, mergeFn) -> value -------------------------------------
  // Fold the leaf results into one value. `mergeFn(acc, r, i)` is deterministic by default
  // (string-join); a caller may pass an async mergeFn that itself calls host.subLM to SYNTHESIZE
  // (that synthesis call also decrements the budget if `budget` is threaded through — callers
  // typically do the final synthesis OUTSIDE MAP's per-leaf budget, see lambdaRLM below).
  async function REDUCE(results, mergeFn, init) {
    if (typeof mergeFn !== "function") {
      return results.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n---\n");
    }
    let acc = init;
    for (let i = 0; i < results.length; i++) acc = await mergeFn(acc, results[i], i);
    return acc;
  }

  // ---- the bounded recursive driver (fix / Y-combinator) ---------------------
  // lambdaRLM(query, {context|ctx, split, leaf, reduce, maxDepth, costBudget, leafChars, tau})
  //
  //   f(P) = if |P| ≤ τ* OR depth exhausted OR budget exhausted  ->  leaf(P)      [oracle]
  //          else REDUCE(MAP(SPLIT(P), λp. f(p)))                                 [recurse]
  //
  // TERMINATION (theorem, not hope): each recursive descent strictly decrements budget.depthLeft,
  // and every leaf strictly decrements budget.leavesLeft; both are non-negative integers, so the
  // recursion tree is finite with ≤ costBudget leaf-oracle calls and ≤ maxDepth height REGARDLESS
  // of how aggressively `split` decomposes. An over-decomposing split is bounded, not blown up.
  async function lambdaRLM(query, opts) {
    opts = opts && typeof opts === "object" ? opts : {};
    const budget = makeBudget(opts);
    // The leaf oracle. Default: host.subLM(query + part). A caller can override `leaf`.
    const leaf = typeof opts.leaf === "function"
      ? opts.leaf
      : async (text, i) => host.subLM("Query: " + query + "\n\nText part " + i + ":\n" + text, { leaf: true });
    // The SPLIT rule (number/string/regexp/fn). Defaults to fixed tau chunks.
    const splitBy = opts.split != null ? opts.split : budget.tau;
    // The REDUCE merge. Default: deterministic join; if opts.reduce==="synthesize" do ONE final
    // host.subLM synthesis over the joined partials (a single extra oracle call, budget-checked).
    const reduceOpt = opts.reduce;

    const context = opts.context != null ? opts.context
      : opts.ctx != null ? (typeof opts.ctx === "string" ? { ctx: opts.ctx } : opts.ctx)
      : "";

    // size of a part (chars), reading host-handle length without pulling bytes
    const sizeOf = (P) => {
      if (Array.isArray(P)) return P.reduce((n, x) => n + sizeOf(x), 0);
      if (P && typeof P === "object" && typeof P.ctx === "string") {
        if (Number.isFinite(P.start) && Number.isFinite(P.end)) return (P.end | 0) - (P.start | 0);
        return host.ctx.len(P.ctx);
      }
      return String(P == null ? "" : P).length;
    };

    async function f(P, depth) {
      budget.maxDepthSeen = Math.max(budget.maxDepthSeen, depth);
      const size = sizeOf(P);
      // LEAF condition: small enough, OR no depth left, OR budget exhausted.
      if (size <= budget.tau || depth >= budget.depthLeft || budget.leavesLeft <= 0) {
        if (budget.leavesLeft <= 0) { budget.exhausted = true; return "[budget-exhausted]"; }
        budget.leavesLeft--; budget.leafCalls++;
        return await leaf(partText(P, budget), 0, P);
      }
      // RECURSE: SPLIT this part, MAP f over the sub-parts (one depth deeper), REDUCE.
      const parts = SPLIT(P, splitBy, budget);
      // Guard against a degenerate split that doesn't shrink (single part == P): force a leaf.
      if (parts.length <= 1) {
        if (budget.leavesLeft <= 0) { budget.exhausted = true; return "[budget-exhausted]"; }
        budget.leavesLeft--; budget.leafCalls++;
        return await leaf(partText(parts[0] != null ? parts[0] : P, budget), 0, P);
      }
      const childResults = [];
      for (let i = 0; i < parts.length; i++) {
        if (budget.leavesLeft <= 0) { budget.exhausted = true; break; }
        childResults.push(await f(parts[i], depth + 1));
      }
      return await mergeResults(childResults);
    }

    async function mergeResults(results) {
      if (reduceOpt === "synthesize" || reduceOpt === true) {
        const joined = await REDUCE(results, null);
        if (budget.leavesLeft <= 0) { budget.exhausted = true; return joined; }
        budget.leavesLeft--; budget.leafCalls++;
        return await leaf("Query: " + query + "\n\nSynthesize ONE answer from these partial answers:\n" + joined, -1, null);
      }
      if (typeof reduceOpt === "function") return await REDUCE(results, reduceOpt);
      return await REDUCE(results, null);
    }

    const answer = await f(context, 0);
    return {
      answer,
      leafCalls: budget.leafCalls,
      splits: budget.splits,
      maxDepthSeen: budget.maxDepthSeen,
      exhausted: budget.exhausted,
      budget: { maxDepth: budget.depthLeft, costBudget: opts.costBudget != null ? (opts.costBudget | 0) : 32 },
    };
  }

  globalThis.lambda = { SPLIT, MAP, REDUCE, lambdaRLM, makeBudget, partText };
  return "lambda-rlm-ready";
})();
