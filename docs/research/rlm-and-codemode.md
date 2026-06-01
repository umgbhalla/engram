# RLM & Code Mode: montydyn as a Durable Recursive-LM / Codemode Backend

Research + design brief. Doc only — no code, no workers, no git changes. Targets two
goals: (a) ship a CLI that launches a durable REPL + an SDK to offer montydyn as
"configurable codemode infrastructure", and (b) understand Recursive Language Models
(RLMs) and "lambda RLMs" well enough to design the right backend surface.

Dates referenced are as of 2026-06. Citations inline; primary sources listed at the end.

---

## 0. TL;DR

- **Recursive Language Models (RLM)** (Zhang/Kraska/Khattab, MIT OASYS,
  arXiv:2512.24601) keep the *huge prompt out of the root LM's context window* by
  storing it as a **variable in a persistent REPL**. The root LM (depth 0) sees only
  the query; it emits code to peek/grep/chunk/map over the `context` variable and
  fires **isolated sub-LM calls** (depth 1) via an `llm_query()` callable; it returns
  via a `FINAL(answer)` / `FINAL_VAR(var)` sentinel.
- The `rlms` pip package abstracts the **sandbox** behind an `environment=` string
  (`local`, `ipython`, `docker`, `modal`, `prime`, `daytona`, `e2b`). The de-facto
  backend contract is tiny: a **stateful REPL** that (1) persists variables across
  `run(code)` calls, (2) can be pre-seeded with `context`, (3) exposes a sub-LM
  callable, (4) returns truncated stdout/result/error, (5) surfaces FINAL.
- **"Lambda RLM" is lambda *calculus*, not AWS Lambda.** It is a hardened successor
  (arXiv:2603.20105, "The Y-Combinator for LLMs") that replaces RLM's free-form code
  loop with **typed, pre-verified combinators** (SPLIT/PEEK/MAP/FILTER/REDUCE/
  CONCAT/CROSS) and a leaf-only oracle, buying termination + closed-form cost bounds.
- **Cloudflare Code Mode** is the same paradigm for *tools* (not context): one
  "write code" tool, MCP/AI-SDK tools rendered as a typed API, code run in a sandbox
  via an `Executor.execute(code, fns) -> {result, error?, logs?}` contract. Cloudflare
  explicitly invites custom executors "for Node VM, QuickJS, containers, …".
- **montydyn fits both contracts with existing primitives** — eval cell ↔ `run`/
  `execute`; `host.<name>()` boundary ↔ `fns`/`llm_query`; `{ok,value,logs}` reply ↔
  `{result,error,logs}`; globalThis persistence across hibernation ↔ "state persists
  across calls". The **differentiator nobody else in the backend list has** is durable
  hibernation: a recursive node can sleep *between turns* with full live state and wake
  at ~190ms, ~0 idle cost.
- **Honest scope:** none of the RLM glue is built yet; montydyn is **JS not Python**
  so it is *not* drop-in for the existing rlms/Qwen3-8B/lambda-RLM Python corpus — it
  backs a **fresh JS-native** scaffold; the 18MB snapshot envelope means a genuinely
  huge context lives **host-side** behind handles, not literally in the heap; and
  hibernation works **at cell/turn boundaries**, *not* mid-flight during a sub-LM fetch.

---

## 1. RLM landscape map — taxonomy by recursion variable

The clean organizing question is **what does each method recurse over?** This both
confirms and slightly sharpens the user's briefing (noted per row).

| Family | Recurses over | Core loop | Needs a code sandbox? | montydyn fit |
|---|---|---|---|---|
| **Canonical RLM** (2512.24601) | **CONTEXT** held as a REPL variable | LM writes code → peek/grep/chunk/map sub-LMs → FINAL | **Yes (core requirement)** | Strongest — montydyn *is* a sandbox backend |
| **λ-RLM** (2603.20105) | CONTEXT, via **typed combinators** + Y-combinator | deterministic SPLIT/MAP/REDUCE, LM only at leaves | Yes, but combinators are deterministic; only leaves hit LM | Strong — combinators as a stdlib module, leaves → `host.subLM` |
| **Slate** (Random Labs, 2026) | **ACTIONS** via bounded threads + episodes | orchestrator-kernel dispatches threads, episodes compose | Code-mode (threads run bash/edits) | Strong — session = thread, snapshot = episode |
| **RSA** (2509.26626) | **SOLUTIONS / candidates** (population of traces) | subsample K of N, synthesize, repeat T | **No** (pure prompting + optional RL) | None — never executes code |
| **THREAD / ROMA / LADDER** | **ACTIONS / subtasks** (task tree) | decompose → spawn → aggregate | Benefit (code-mode), not required | Medium — each node a durable session |
| **MemGPT / MemWalker** (2310.05029) | **MEMORY / summary tree** (paging) | navigate paged memory hierarchy | Durable state > code | Medium — heap-in-SQLite is a natural memory home |
| **TRM / HRM / GRAM** | **LATENTS** inside the weights (~7M-param net) | architectural recursion in latent space | **No** (in-weights, not prompting) | None — zero benefit |

**Confirms the briefing:** the taxonomy split (context / solutions / actions / memory /
latents) and the "sandbox-relevant = RLM + agent code-mode + memory; irrelevant = RSA /
LADDER-training / TRM-HRM" partition are correct and well-supported.

**Extends / sharpens:**
- The RLM paper explicitly states the environment is **flexible** ("not fixed to a REPL
  or code environment"). So a code REPL is a *strong default*, not a hard requirement —
  which actually *widens* montydyn's relevance (it can also back the durable-state side
  of MemGPT-style methods) but *weakens* the "only RLM truly needs a sandbox" framing.
- **RLM is the only family whose *core loop* is code execution.** THREAD/ROMA *benefit*
  from a sandbox when doing tool/code work but run fine on pure text. This is why the
  RLM wedge is the sharpest and most defensible target for montydyn.
- Slate and λ-RLM are best understood as **two different reactions to the same RLM
  weakness** (unbounded free-form REPL recursion): λ-RLM constrains it with *types +
  formal bounds*; Slate constrains it with *bounded threads + episodes + an OS kernel*.
  montydyn supplies the **substrate** both lack: a durable, addressable, hibernating
  compute unit whose snapshot can *be* an episode / a checkpointed recursion node.

---

## 2. What "lambda RLM" resolves to

**Not** serverless. The "lambda" is **lambda calculus**. Concretely:

- **Paper:** *"The Y-Combinator for LLMs: Solving Long-Context Rot with λ-Calculus"*,
  arXiv:2603.20105. **Code:** github.com/lambda-calculus-LLM/lambda-RLM (mirror
  github.com/nktkt/lambda-rlm).
- **Core equation:**
  `λ-RLM ≡ fix(λf. λP. if |P| ≤ τ* then M(P) else REDUCE(⊕, MAP(λpᵢ. f pᵢ, SPLIT(P, k*))))`
  — the oracle `M` (the LM) is called **only at leaves** on sub-prompts guaranteed to
  fit the window; all control flow (SPLIT/PEEK/MAP/FILTER/REDUCE/CONCAT/CROSS) is
  **deterministic symbolic combinators**; the Y-combinator makes recursion an explicit
  semantic object rather than emergent model behavior.
- **Why it matters:** canonical RLM's arbitrary-code loop has unpredictable control
  flow, non-termination risk, and a "coding tax" that hurts weaker models. λ-RLM buys
  **termination, closed-form cost bounds, controlled accuracy-vs-depth scaling, and an
  optimal partition rule** — "terminates in bounded cost with predictable accuracy"
  becomes a theorem.
- **Results:** beats standard RLM in 29/36 (task × model) comparisons, +21.9 avg
  accuracy pts, up to 4.1× lower latency; an 8B+λ-RLM beats a raw 405B on long context.
  **Caveat:** advantage *disappears* on creative-code tasks and high-coding-capability
  models — the fixed combinator library doesn't cover everything.
- **Repo shape:** `combinators.py`, `composition.py`, `oracle.py` (OpenAI/Anthropic/
  Mock leaves), `cost.py`, `planner.py`, `detector.py`, `executor.py`, `system.py`,
  `rlm/lambda_rlm.py`, `rlm/environments/local_repl.py`. Backends are **API model
  providers** (NVIDIA NIM, Together AI); execution is a **sandboxed local Python REPL**.
  **No serverless / pausable / resumable execution exists** — exactly the gap montydyn
  fills.

**Adjacent — "Slate" (Random Labs):** a separate March-2026 product (`npm i -g
@randomlabs/slate`), "first swarm-native coding agent". Thesis: the bottleneck is
**memory/context management**, not intelligence — treat the context window as RAM.
Primitives: **thread** (one bounded action, returns control to orchestrator) → **episode**
(compressed result handed back to the kernel) → orchestrator = **kernel** that "programs
in action space" via a TypeScript DSL. The sharp montydyn mapping: **episode = snapshot**,
**thread = session**, **kernel dispatch / leaf oracle = `host.subLM`**.

---

## 3. montydyn as a codemode / RLM backend

### 3.1 The two backend contracts

**rlms environment adapter** (`environment='montydyn'`), de-facto methods:
1. `run(code) -> {stdout, stderr/result, error}` — execute, **state persists** across calls.
2. `set_context_var(name, value)` — inject the (possibly huge) context as a REPL variable.
3. `install_deps(packages)` *(optional)*.
4. Surface FINAL / FINAL_VAR termination.

**Cloudflare Code Mode executor:**
- `execute(code, fns: Record<string, (...args)=>Promise<unknown>>) -> {result, error?, logs?}`
- `fns` is the tool table injected into the sandbox (each becomes a callable inside the code).

### 3.2 How montydyn's primitives implement them (verified in `v0.8/src/glue.js`)

| Contract need | montydyn primitive | Evidence |
|---|---|---|
| `run(code)` / `execute(code)` | one **eval cell** | `evalCode`, returns `{ok,value,valuePreview,logs,error?}` JSON |
| `fns` / `llm_query` / sub-LM | **`host.<name>()` proxy boundary** | `__hostCall` proxy (`glue.js:529/555`), `__mkHostProxy` rebind |
| egress / actual sub-LM fetch | **`host.fetch(url, init)`** | allowlist-gated, 2MB cap, **0 entropy** (`glue.js:617-667`) |
| `{result, error, logs}` | `{ok, value, logs[]}` reply + per-cell console capture | field-for-field map |
| state persists across calls | **globalThis persistence across hibernation** | deep-hibernation 7/7 zero loss (`docs/results/deep-hibernation.md`) |
| FINAL / FINAL_VAR | *(unbuilt)* — would be a `host.final(...)` sentinel | n/a |
| `set_context_var` | `globalThis.context = …` in an eval | works ≤ envelope; see 3.4 |

**A sub-LM call needs no new VM primitive** — it is a registered host tool
(`host.subLM(prompt, opts)` / `host.llm(messages, opts)`) backed host-side by an
Anthropic/OpenAI `fetch`, isolated exactly like Code Mode's `fns` and rlms' marshaled
sub-calls. Determinism (seeded clock/RNG; fetch adds 0 entropy) makes the *scaffold*
reproducible (the network sub-call result is not — see gaps).

### 3.3 The durable-hibernation advantage (the real wedge)

E2B / Modal / Daytona / Prime keep REPL state in a **live process for the session's
wall-clock lifetime**; on idle-out or teardown the namespace is **gone**. montydyn
snapshots the live QuickJS heap to DO SQLite and **hibernates idle**, then cold-wakes
with full live state, **no replay** (cold p50 ~190ms; server-side restore 0ms in one
frozen-clock turn; 7/7 full 12–20-min evictions survived with zero loss, incl. a 5MB
image byte-stable, closures still callable — `docs/results/deep-hibernation.md`).

For RLM this means the recursion tree becomes a **checkpointed, addressable, per-node
durable** structure: a multi-turn **root loop** (LM emits code → sees output → emits
next code) can sleep **between iterations** — or while waiting on a human/OAuth/tool
callback — and resume the exact namespace (loaded context handle, intermediate maps,
partial `FINAL_VAR`) hours later at ~0 idle cost. **No other backend in the rlms list
offers this.** Multi-tenancy (one deployment hosts many isolated DO-backed sessions)
fits depth>1 fan-out, each sub-call its own durable session/facet.

### 3.4 Honest caveats (do not oversell)

1. **JS ≠ Python — not drop-in.** rlms, the finetuned **RLM-Qwen3-8B**, and λ-RLM all
   assume a **Python scaffold** (`context[:10000]`, `re.split`, `combinators.py`). The
   Qwen3-8B model's fixed system prompt expects Python. montydyn runs JS, so it backs a
   **new JS-flavored RLM** only — it is *not* drop-in for existing trajectories or the
   trained native model. (This is also where local/E2B/Modal *are* drop-in.) Code Mode,
   by contrast, **is JS/TS-native**, so montydyn-as-Code-Mode-executor is a cleaner fit
   than montydyn-as-rlms-backend.
2. **18MB snapshot envelope vs. genuinely huge context.** RLM's premise is contexts ~2
   orders of magnitude beyond the window (~500K chars/sub-call, multi-hundred-MB roots).
   montydyn durably snapshots ≤ ~18MB raw (`MAX_DUMP_BUFFER_BYTES`, `glue.js:115`) and
   trips `MemoryLimitError` at >8MB per-cell / >16MB absolute (`glue.js:141`). **You
   cannot both hold a literally huge context in the REPL variable *and* keep
   hibernation.** Resolution: keep the giant context **host-side** (DO SQLite/R2) behind
   coarse handle tools (`host.ctx.len/slice/grep/chunk/get`); the REPL variable is a
   **lazy handle**, not the bytes. This matches the `repl-env-surface.md` virtual-fs
   pattern and Code Mode's "spec never enters the model context" principle — but it is a
   **different architecture** from local/E2B (which literally hold the full blob), and
   `host.ctx.*` **is entirely unbuilt**.
3. **Hibernation is between cells, not mid-flight.** A sub-LM `host.fetch` is awaited
   **inside the same synchronous DO turn** that ran the cell (`__hostFetch` `glue.js:624`;
   pump comment 617-620). That turn is bounded by the ~1200-tick interrupt budget
   (`glue.js:765-802`) and the ~30s DO wall limit. So a cell that fans out a partition+map
   of long sub-LM calls must **complete them inside one turn**; the session **cannot
   hibernate while a sub-LM call is in flight**. Pausing **between root iterations** is
   supported and is the real win; **mid-call suspension is not** (the lambda-slate framing
   of "pause an RLM node across machines while a sub-LM call is in flight" is **not**
   supported in v0.8). Long sub-calls (LLM latency often >30s) must be chunked / async-
   polled across turns or they WS-1006 the socket.
4. **Nothing is built.** The only SDK today is `v0.8/sdk/index.mjs` (151 lines) — a
   reconnect-safe WS eval client (`connect/eval/reset/gen`). No `set_context_var`, no
   rlms adapter, no `host.subLM`, no FINAL sentinel, no `host.ctx.*`, no CLI, no
   `montydyn` option in the rlms pip package, and **no end-to-end RLM run has ever
   executed on montydyn.** Everything below is *buildable design*, not shipped.

---

## 4. CLI + SDK spec (ready to build)

Design goal: the **CLI** launches a configurable durable REPL (and an end-to-end RLM
loop); the **SDK** embeds montydyn as **configurable codemode infrastructure** with a
small, honest surface that maps onto both the Code Mode and rlms contracts.

### 4.1 CLI

```
montydyn repl [--session <id>] [--config <file>] [--tools <file>] [--context-file <path>]
  # Interactive durable REPL. Resumes the hibernated namespace if <id> exists, else
  # creates it. --config sets clock/rngSeed/cellBudgetTicks/fetch-allowlist/modules.
  # --tools registers host tools from a JS file. --context-file loads a big blob
  # HOST-SIDE as a peek/grep handle (NOT into the heap). Prints session id + resume URL.

montydyn rlm <query> --context <file> [--model <id>] [--depth 1] [--session <id>]
  # End-to-end canonical RLM loop on montydyn: binds context as a host-side handle,
  # drives the root LM with the peek/grep/chunk/map toolset, executes model-written JS
  # cells, returns on FINAL/FINAL_VAR. Each node is a durable session, so Ctrl-C / idle
  # resumes mid-trajectory (between cells). --depth caps recursion (paper default 1).

montydyn sessions [list|inspect <id>|rm <id>]   # durable session lifecycle
montydyn trace <id>                              # dump trajectory (cells + sub-call I/O)
```

### 4.2 SDK (TypeScript) — `@montydyn/sdk`

A thin layer over the reconnect-safe WS client (`v0.8/sdk/index.mjs`), adding the
codemode/RLM affordances. **Honest surface:** context is a *handle*, sub-LM is a host
tool, hibernation is between cells.

```ts
import { connect } from "@montydyn/sdk";

// 1. Connect / attach a durable session (creates if absent, resumes heap if present).
const session = await connect({
  endpoint, id,
  config: {
    rngSeed, clock, cellBudgetTicks,
    fetchAllowlist,         // scope egress to the LLM provider host(s) only
    modules,                // stdlib preset (e.g. lodash/zod for parsing)
    contextHandleMaxSlice,  // cap slice size to avoid the single-oversized-alloc WS-1006
  },
});

// 2. Codemode / rlms executor contract.
await session.eval(code);                       // -> { ok, value, valuePreview, logs, error? }
await session.execute(code, fns);               // Code Mode: -> { result, error?, logs? }
await session.reset();

// 3. Context-as-variable — stored HOST-SIDE, exposed as a lazy handle in the REPL.
await session.setContext("context", blobOrStream);  // chunked into DO SQLite/R2
// In-sandbox the model sees host.ctx.{len, slice(s,e), grep(re,opts), chunk(n), get(k)}
// plus a `context` handle object; bytes never enter the 18MB snapshot envelope.

// 4. Register host tools (the host.<name>() boundary). fns map field-for-field.
session.registerTool("subLM", async (prompt, opts) => callLLM(prompt, opts));
session.registerTool(name, handler);

// 5. Sub-LM hook (sugar over registerTool) — the leaf-oracle / sub-LM-call boundary.
session.onSubLM(async ({ prompt, contextSlice, depth, opts }) => {
  // fire isolated depth+1 call via your model backend; return a string into the REPL.
  // depth>1 may spawn a child durable session (multi-tenant fan-out).
  return await modelBackend.complete(prompt, contextSlice, opts);
});

// 6. Termination sentinel.
session.onFinal(({ kind, value }) => { /* kind: "FINAL" | "FINAL_VAR" */ });
// host.final(answer) / host.finalVar(varName) inside the sandbox resolves + snapshots.

// 7. Lifecycle / durability.
const snap = await session.hibernate();   // freeze; ~0 idle cost
await session.resume();                   // wake-with-state, no replay (~190ms cold)
const meta = await session.trajectory();  // RLMChatCompletion-style .metadata (cells + sub-calls)
```

**rlms-style adapter** (publishable so a JS port — or a Python rlms fork via an HTTP
shim — can select `environment='montydyn'`):

```ts
class MontydynEnv {
  async run(code: string): Promise<{ stdout: string; error?: string }>;
  async setContextVar(name: string, value: unknown): Promise<void>; // -> host-side handle
  async installDeps(modules: string[]): Promise<void>;              // -> config.modules
}
```

**Cloudflare Code Mode executor** (drop-in for `DynamicWorkerExecutor`):

```ts
class MontydynExecutor {
  async execute(code: string, fns: Record<string, (...a:any[])=>Promise<unknown>>):
    Promise<{ result: unknown; error?: string; logs?: string[] }>;
}
// usable directly with createCodeTool({ tools, executor: new MontydynExecutor(...) })
```

**Host-tool families to ship inside the sandbox:**
- `host.ctx.{len, slice(start,end), grep(regex,opts), chunk(size), get(key)}` — coarse,
  boundary-crossing ops over the host-side context store (escapes the 18MB envelope).
- `host.subLM(prompt, opts)` / `host.llm(messages, opts)` — recursive call boundary.
- `host.rlm(query, contextHandle, {depth})` — true depth>1 sub-RLM, each its own session.
- `host.final(answer)` / `host.finalVar(varName)` — termination sentinels.
- λ-RLM combinator module: `SPLIT/PEEK/MAP/FILTER/REDUCE/CONCAT/CROSS` as a configurable
  stdlib so deterministic control flow runs in-sandbox and only **leaves** hit `host.subLM`.

### 4.3 Conceptual identities (for docs/positioning)

- montydyn **session** = Slate **thread** / λ-RLM **lambda** / one RLM recursion node.
- montydyn **snapshot** = Slate **episode** / a checkpointed RLM sub-call.
- `host.subLM` = leaf-oracle / sub-LM-call / thread-dispatch boundary.
- `host.fetch` = egress. `host.final` = loop close.

---

## 5. Recommended build order (relative to V1 facets)

V1 facets (per-sub-call child DOs for depth>1) are a **spike only** (`v1-facet-spike.md`):
facet WS-hibernation is unproven and facets cannot set alarms. So **do not** put the
multi-tenant fan-out on the critical path. Build the single-session value first.

1. **SDK codemode core (no facets).** `MontydynExecutor.execute(code, fns)` + tighten
   `setContext`/`registerTool` over the existing WS client. Ship as a Cloudflare Code
   Mode executor — this is the **cleanest, JS-native, drop-in** win and needs no new VM
   primitive. *Deliverable: `createCodeTool({ executor: MontydynExecutor })` works.*
2. **Host-side context store + `host.ctx.*` handle tools.** The architecturally-correct
   way to carry big context; unblocks RLM without touching the snapshot envelope.
   Benchmark grep/chunk latency vs in-process slicing.
3. **`host.subLM` + FINAL/FINAL_VAR + single-session RLM loop (depth=1).** `montydyn rlm`
   CLI end-to-end. **First real measured trajectory** — close the biggest verification
   gap (no E2E run exists). Validate the **between-cells hibernate/resume** of a paused
   root loop on a real long-context task (OOLONG/BrowseComp slice).
4. **Trajectory logger + `.metadata`** (RLMLogger-parallel), keyed by session id + seed,
   for the shadcn trajectory viewer. Be explicit that sub-LM network I/O is *not*
   reproducible even with seeded clock/RNG.
5. **CLI `repl`** polish + `sessions`/`trace`. Configurable REPL is the user's headline
   "launch a REPL" ask; it rides on top of steps 1–4.
6. **λ-RLM combinator stdlib module** (deterministic in-sandbox, leaves → `host.subLM`).
   Optional; gives formal-bound positioning and a JS port of lambda-RLM.
7. **THEN facets / multi-tenant depth>1 fan-out** — only after single-session is proven
   and after the facet hibernation/alarm gaps from the spike are resolved. This is the
   `host.rlm(...)` depth>1 path and the swarm-of-threads story.

**Async sub-call across turns (stretch, gating real RLM scale):** redesign so a slow
sub-LM call is *fired in cell N, session hibernates, result collected in cell N+1*,
sidestepping the ~30s turn wall. Plausible but **unbuilt and untested** — flag it as the
key open research item before claiming mid-trajectory durability at scale.

---

## Open gaps / risks (carry into the build)

- No end-to-end RLM-on-montydyn run exists; all evidence is component-level.
- Mid-cell sub-LM-call hibernation is unsupported in v0.8 (fetch awaited in-turn).
- ~30s DO wall + ~1200-tick budget vs >30s LLM latency: needs async/polled sub-calls.
- `host.ctx.*` large-context store is proposed, not built or benchmarked.
- "Near-zero idle cost" is from the DO billing model; no figures vs E2B/Modal billed-
  while-held. R2-overflow deep-wake path (>2MB-gz images) never exercised.
- Multi-tenant depth>1 rests on facets (spike only; hibernation/alarms unproven).
- Single oversized native alloc (e.g. `structuredClone` of a huge object) can WS-1006
  recoverably — cap context-handle slice sizes (`contextHandleMaxSlice`).
- JS-vs-Python: not drop-in for the existing RLM corpus or RLM-Qwen3-8B.

---

## Primary sources

- RLM: arXiv:2512.24601 (v2 HTML), alexzhang13.github.io/blog/2025/rlm,
  github.com/alexzhang13/rlm (+ rlm-minimal), petroslamb/rlm fork,
  huggingface.co/mit-oasys/rlm-qwen3-8b-v0.1, rlm.md.
- λ-RLM: arXiv:2603.20105, github.com/lambda-calculus-LLM/lambda-RLM (mirror nktkt/lambda-rlm),
  labo-llm.com lambda-rlm writeup.
- Slate: randomlabs.ai/blog/slate, docs.randomlabs.ai, VentureBeat / Techstrong coverage.
- Other families: RSA arXiv:2509.26626 (rsa-llm.github.io); THREAD arXiv:2405.17402;
  ROMA arXiv:2602.01848 (sentient-agi/ROMA); LADDER arXiv:2503.00735;
  MemWalker arXiv:2310.05029; TRM github.com/SamsungSAILMontreal/TinyRecursiveModels.
- Code Mode: blog.cloudflare.com/code-mode (+ code-mode-mcp), developers.cloudflare.com/agents/api-reference/codemode,
  npmjs.com/package/@cloudflare/codemode, blog.cloudflare.com/dynamic-workers.
- Ephemeral backends: e2b.dev code-interpreter SDK, modal.com Sandbox docs,
  daytona.io RLM guide, deepwiki alexzhang13/rlm Modal sandboxes.
- montydyn internal: `v0.8/src/glue.js`, `v0.8/sdk/index.mjs`,
  `docs/results/v0.8.md`, `docs/results/deep-hibernation.md`,
  `docs/research/repl-env-surface.md`, `docs/results/v1-facet-spike.md`, `CLAUDE.md`.
