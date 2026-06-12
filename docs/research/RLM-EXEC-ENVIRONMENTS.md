# RLM Exec Environments — Cross-System Survey + Engram Positioning

> Owner-facing synthesis of the RLM (Recursive Language Model) execution-environment survey,
> 2026-06-11. Every claim below is grounded in cloned source / fetched docs (citations inline per
> system); anything press-only or unverifiable is flagged. Context: engram's RLM layer was stripped
> from the runtime (`docs/RLM-STRIPPED.md`) and is being rebuilt as an application layer (ouru) —
> this doc maps where engram's durable snapshot-REPL substrate sits against every exec env the
> RLM ecosystem actually uses.

## TL;DR

The entire RLM ecosystem — canonical (alexzhang13/rlm), the blog reference (rlm-minimal), every
community port, λ-RLM, and the commercial sandbox vendors (Prime, Daytona, E2B, Modal) — runs its
REPL on **ephemeral state**. The strongest persistence anyone has is a **dill/pickle file on disk**
(per-cell variable dump that silently drops unpicklable values: open sockets, generators, lambdas,
in-flight promises). **Nobody can pause a deep recursion tree and resume it after eviction.**
Engram's heap-snapshot REPL (live interpreter memory → DO SQLite, no replay) is precisely the
primitive this ecosystem lacks — and with `host.spawn`/`host.fork` + a shared R2 `/workspace`,
the *recursion tree itself* becomes durable, not just one node's namespace.

---

## 1. Comparison table

Legend: "Fresh+slice" = child gets a brand-new env seeded only with the sub-prompt (logical
isolation, no heap/KV inheritance) — this is the universal RLM pattern; no surveyed system forks
parent state.

| System | Exec Env (the concrete sandbox) | State Model | Recursion / Sub-call Mechanism | Isolation vs Fork | Durable? | Notable internals |
|---|---|---|---|---|---|---|
| **RLM canonical — LocalREPL** (alexzhang13/rlm, default) | In-process Python `exec()` in the driver thread; `_SAFE_BUILTINS` dict (blocks eval/exec/compile but allows `__import__`/`open`) — convention, not a sandbox | Persistent `globals`/`locals` dicts across cells; `persistent=True` reuses env across completions w/ versioned `context_N` | `llm_query` (flat) + `rlm_query` → `RLM._subcall` spawns child RLM w/ own fresh LocalREPL; `max_depth` default 1 (sub-calls degrade to flat) | Fresh+slice; same OS process, separate dicts. No fork | **No.** In-RAM dicts; process death loses everything incl. in-flight recursion | Context-as-variable (`context_0`); `_AnswerDict` `answer["ready"]=True` termination; scaffold re-injected per cell; **no enforceable timeout** ("Python cannot interrupt blocking user code") |
| **RLM canonical — IPython in-process** | Real `InteractiveShell` in the same process; per-instance fake `__main__` module to avoid sys.modules clobber | Persistent `user_ns` for instance lifetime; in-RAM only | Same scaffold; reentry guards force children to be separate instances; subcall semaphore | Fresh+slice, same process | **No** | Best-effort SIGALRM cell timeout (Unix main-thread only, silent no-op elsewhere) |
| **RLM canonical — IPython subprocess** | Real `ipykernel` subprocess via `jupyter_client.KernelManager`, ZMQ channels — true OS-process isolation | Kernel `user_ns` persists across cells but is NOT round-tripped to parent (locals returned `{}` — ZMQ cost); parent keeps a shadow of injected context | Kernel-side plain fns → TCP socket back to parent `_SubcallBroker` (4-byte-prefix JSON); subcall runs PARENT-side, spawns fresh child RLM | Process isolation kernel↔driver; sub-RLM still fresh+slice, no kernel fork | **No** — but kernel survives cell timeouts | **Only env with a hard enforceable cell timeout** (`execute_interactive(timeout)` + `interrupt_kernel`); dill-hex tool shipping; cell-id attribution for straggler completions |
| **RLM canonical — DockerREPL** | Long-lived container (`python:3.11-slim`, `--rm`, volume-mounted tempdir); each cell = fresh `docker exec python -c` w/ FULL builtins | Persistent across cells via **dill file** `/workspace/state.dill` (load at start, save at end of every exec); `persistent=True` → `NotImplementedError` | `llm_query` only — **no `rlm_query`** (no recursion container-side); HTTP proxy to parent via `host.docker.internal` | Container OS/FS isolation; dill file is the only shared surface | **Semi** (within one completion): dill survives exec restarts; container `--rm`'d on teardown | Base64 code transport; dill silently drops unpicklable vars; 300s proxy timeout |
| **RLM canonical — Modal / E2B / Prime / Daytona** (`IsolatedEnv`) | Remote cloud microVM/sandbox per env ("completely separate machine"); cells = generated exec script run remotely, full builtins | Same dill pattern: `/tmp/rlm_state.dill` per cell; `persistent=True` → `NotImplementedError` in ALL four | `llm_query` only (flat); in-sandbox Flask broker (`/enqueue`/`pending`/`respond`) + parent long-poller over tunnel/preview URL; no sub-RLM wired | Maximal infra isolation (VM+net); sub-LM is a logical HTTP call, never a fork | **No** as substrate: sandboxes auto-stop/terminate; dill gives intra-completion recovery only | Tunnel-URL bridge; sandbox-level timeouts (300–600s, Daytona auto_stop); preinstalled numpy/pandas/scipy/dill |
| **rlm-minimal** (the blog's reference) | In-process `exec()`/`eval()` (`REPLEnv`), restricted builtins (allows `__import__`/`open`); cwd→tempdir | Persistent `globals`/`locals` per query; single REPLEnv per completion | `llm_query` → `Sub_RLM` = one-shot OpenAI call, NO child REPL ("depth=1 only" per README); deeper = swap in nested `RLM_REPL` | Sub-call is logical, not even a fresh REPL | **No.** Pedagogical; no timeout, no budget (`cost_summary` raises) | `FINAL()`/`FINAL_VAR()` text-parsed termination; notebook-style trailing-expr eval; gpt-5 root / gpt-5-nano sub |
| **λ-RLM** (Huawei+IIT-Delhi, arXiv 2603.20105) | In-process `exec()` in LocalREPL (hard-pins `environment="local"` despite docstring saying "subprocess"); same weak `_SAFE_BUILTINS` | Near single-shot: 3 exec calls total; context loaded once as `context_0`; env torn down in `finally: repl.cleanup()` | **Pre-planned deterministic** recursive Python fn `_Phi` (Split→map Φ→Reduce); k*, τ*, depth computed analytically BEFORE exec; only leaves hit the model. "Y-combinator" is branding, not model-driven recursion | No fork — `_Phi(c)` shares ONE REPL/call stack (recursionlimit 5000); per-leaf context = `_Split` word-boundary slice | **No.** Process death mid-`_Phi` loses the whole Python call stack | Formal termination (Split strictly shrinks) + closed-form cost Ĉ; combinator library `_Split/_Peek/_Reduce/_FilterRelevant`; 1 LLM call for planning (task-type menu) |
| **Engram prior lambda-RLM** (v0.9.2, now STRIPPED) | QuickJS-ng (Rust→WASM) inside a CF Durable Object; combinators eval'd into the heap from stdlib bundle | Persistent QuickJS namespace, **heap-snapshot to DO SQLite per cell** — survives eviction, no replay | Bounded SPLIT/MAP/REDUCE combinators (terminate by construction) → `host.subLM` host-mediated; v0.9 depth-1 RLM loop w/ host-side context slicing (`host.ctx`/ctx_chunks, 4.36MB needle) | Sub-calls host-mediated, not a VM fork; tenant isolation at a different layer (per-session facet + own SQLite) | **WAS yes** — the only durable one in this table. RLM layer now removed from runtime (`docs/RLM-STRIPPED.md`); lives in `@engram/sdk@0.9.x`/git history; substrate remains | Seeded determinism, interrupt-budget + used-heap guards; `host.final` termination |
| **fast-rlm** (avbiswas) | Pyodide (CPython→WASM) inside a Deno subprocess; `runPythonAsync` per ```repl block; isolation = WASM + Deno capability flags | Persistent Pyodide namespace within one agent's lifetime; nothing checkpointed (JSONL logs + final JSON only) | `llm_query` → recursively spawns `subagent(depth+1)` = brand-new Pyodide instance + loop; `batch_llm_query` parallel fan-out; max_depth=3, 20 calls/agent | Fresh+slice — new WASM instance per child; tools do NOT auto-inherit; env vars do | **No** — Pyodide linear memory is snapshottable *in principle* but fast-rlm doesn't | Compression guard (self-confirm judge blocks under-compressed delegation); AJV schema-validated `FINAL` w/ retry; cost caps ($0.2); glm-5 / minimax-m2.5 via OpenRouter |
| **rig-rlm** (Rust, PyO3) | **Native CPython embedded in-process** via PyO3 — no sandbox at all; plus a `RUN <bash>` command over the user's entire filesystem | **Per-call fresh** `PyDict` locals — effectively stateless (weakest in survey); `context` field dead code | `query_llm` pyfunction → new tokio runtime → brand-new `RigRlm` agent. **No depth limit, no budget, no cycle guard** — unbounded recursion foot-gun | Fresh agent, same OS process, zero real boundary | **No** | `ExecutionEnvironment` trait w/ Firecracker TODO (unimplemented); `my_answer`/`FINAL` text parsing; LM Studio qwen3-8b or gpt-5.2 |
| **claude_code_RLM** (Brainqub3) | Claude Code as scaffold; exec = plain `python3 rlm_repl.py` CLI subprocess running `exec()` on host; "sandbox" = Claude Code's permission system | **Disk pickle**: `.claude/rlm_state/state.pkl` loaded/re-saved atomically per `exec` invocation — state survives across processes and CC turns; unpicklable vars dropped w/ warning | Root CC conversation chunks context to files, delegates each to `rlm-subcall` subagent (Haiku, Read-only) via Task tool; depth hard-1 ("subagents cannot spawn subagents") | Subagent = fresh context window + 1 chunk file; pickle state never exposed to it | **Partial** — most durable of the community impls: REPL state + chunk files survive session death; orchestration (conversation + in-flight subagents) does not | Helpers peek/grep/chunk_indices/write_chunks/buffers; structured JSON sub-answer contract; Opus 4.5 root / Haiku sub |
| **recursive-llm** (ysz) | RestrictedPython in-process (`compile_restricted_exec`, safe-globals, whitelisted modules, no file/net) — bytecode-level restriction, same process | Persistent env dict within one `acomplete()`; fresh per call | `recursive_llm(sub_query, sub_context)` → genuine new sub-RLM w/ own REPLExecutor; **max_depth=5** (deepest configurable in survey), max_iterations=30; cheaper `recursive_model` at depth>0 | Fresh+slice; new RestrictedPython scope, same process | **No** | Sync→async bridge via ThreadPoolExecutor+asyncio.run; FINAL/FINAL_VAR regex; timeout param exists but explicitly NOT enforced; LiteLLM model-agnostic |
| **Prime Intellect RLM** (blog + `prime` backend) | Prime "Sandboxes" (proprietary remote isolation; IsolatedEnv, docker_image param); HTTP broker pattern for LM calls | Persistent namespace via dill `/tmp/rlm_state.dill`; mutable `answer` dict editable over turns | `llm_batch` parallel sub-LM fan-out from REPL; **recursion depth exactly 1** (blog states it; arbitrary depth = future work) | Fresh+slice + sandbox-level isolation; no fork | **No** — per-rollout sandbox, `persistent` unsupported for isolated backends | stdout capped 8192 chars/turn (forces delegation); GPT-5 / GPT-5-mini |
| **Daytona RLM** (docs + `daytona` backend) | Remote Daytona Sandbox per agent, fresh repo clone each (underlying VM/container tech undisclosed); Flask broker uploaded + preview-link tunnel w/ token | dill `/tmp/rlm_state.dill` per code block; cross-call `persistent` raises | `rlm_query`/`rlm_query_batched` spawn sub-agents **each in a fresh Daytona sandbox**; guide claims "unlimited recursion depth", budget-gated (max_sandboxes 50, max_iterations 50, 3600s global) | Strongest fork-shaped isolation: child = new sandbox + fresh clone; still slice-not-fork (no FS/heap inheritance) | **No** — "sub-agent sandboxes are deleted immediately after completion" | sandbox_manager budget gating; auto_stop_interval; FINAL/FINAL_VAR; ThreadPoolExecutor fan-out |
| **k-a.in RLM-py** | In-process `exec()` w/ **full builtins** (not even safe-builtins); hand-rolled REPLEnv | Persistent locals within one completion; fresh REPLEnv per call | `llm_query` → flat `sub_llm.chat()` — no child REPL, depth-1 | Slice-only, no isolation at all | **No** | FINAL/FINAL_VAR regex; ```repl block extraction; max_iterations=15; based on rlm-minimal |
| **Centaur** (paradigmxyz) — *not an RLM; adjacent control plane* | Kubernetes sandbox pod per Slack-thread/session running a full CLI harness (Claude Code/Codex/Amp); default-deny NetworkPolicy + per-sandbox iron-proxy credential injection. Plain pods, not microVMs | Durable control-plane state in **Postgres** (turns, events, terminal state, delivery obligations); pod FS reused within a thread but not authoritative | Not RLM recursion: durable **workflow engine** — checkpoint-per-step handlers, sleep days, child workflows each w/ own pod | Fresh pod per thread/child; state passed explicitly through the durable API | **Yes at orchestration layer** (strongest non-engram durability): workers/clients can die and replay. BUT "sandbox pod dies → execution becomes terminal" — in-pod live process NOT resumable | Replayable event stream; warm pod pool; harness-agnostic Anthropic-style message adapter |
| **Slate v1** (Random Labs) — ⚠️ **closed-source, ALL claims press-paraphrase, unverifiable** | Undisclosed. Press: orchestrator emits a TypeScript action-space DSL; workers "execute in terminals and file systems." No named container/VM tech anywhere | "Thread Weaving": workers return compressed episodes woven into orchestrator context; no persistent REPL namespace described | Orchestrator "generates the next layer of programs"; spawns subthreads via DSL; no public depth limit | Workers fresh + episode-sliced context; boundary tech undisclosed | **Unknown** — no checkpoint/resume mechanism in any public source | Multi-model swarm (Sonnet orchestrate / GPT-5.4 code / GLM 5 research); blog JS-gated, VentureBeat 403 — treat every cell here as unverified |
| **SWARM** (swarm-ai-safety) — *safety SIM harness, not an RLM* | In-process Python; `SandboxEnvironment` docstring says it's "logical organisation only, not a security boundary"; opt-in `DockerSandbox` per-exec w/ governance limits + FailoverChain | In-memory virtual FS dict + execution log; `checkpoint`/`restore` of the FS (LRU max 20) — simulation snapshots, not a language namespace | `SPAWN_SUBAGENT` = simulated evolutionary action (SpawnTree, max_depth=3, reputation ×0.5 inheritance, genome mutation). "RLM" appears only as a *metrics* module measuring recursive-collusion phenomena | Logical fork of reputation/resources/genome, not process/heap | **No** (in-memory, LRU-evicted) | Secret redaction before logging; governance-derived Docker limits; the one system that *forks* anything — and it's simulated reputation |
| **OpenProse + Reactor** | Each render = one bounded `@openai/agents` session + real per-node working dir ("Codex-style", NOT an OS sandbox) + optional `docker run` shell sandbox (cwd-shell fallback) | **On-disk content-addressed world-model store**: published face (sha256-fingerprinted, subscribable) vs private scratch (wiped fresh each render). Not a variable namespace — declared truth + receipts | `spawn_subagent` tool (SDK `agent.asTool()`); genuinely recursive (child may get `spawn_subagent`); bounded ONLY by shared `maxTurns` + Usage→Cost (maxTurns=null = deliberate unbounded) | Child = fresh Agent BUT **inherits parent's RunContext handle** (same node scratch/working dir; usage rolls up) — closest thing to a fork in the survey, and it's a handle-share, not a heap fork. "No node left behind": child evaporates, never commits | **Split**: world-model durable across runs (failed render commits nothing, prior truth stands); per-render session + recursion **ephemeral** — interruption = re-render from last committed truth | Fingerprint memoization ("cost scales with surprise"); deterministic reconciler, no LLM judge; content-addressed receipts, keyless replay |
| **CUHK reproduction** (arXiv 2603.02615) | Canonical LocalREPL (fork of alexzhang13/rlm) — same exec/env as row 1 | Same | Same; novel contribution = testing **depth=2**: it uniformly HURT accuracy and blew latency 3.6s→344.5s | Same | **No** | Key external datapoint: naive depth>1 on ephemeral envs is cost-catastrophic — see Findings §4 |
| *Adjacent non-envs (surveyed for contrast)* | **MinivLLM** = vLLM reimpl (paged-attention serving layer; mp.spawn = tensor-parallel workers, not sandboxes). **tinygrad.c** = C tensor engine (sqlite kernel cache = build artifacts). **RLM-JB** (arXiv 2602.16520) = pure text root→worker chunk-screening pipeline, zero exec | — | RLM-JB shows the "RLM" label applied with NO code exec at all — model composition only | — | — | Proof the term "RLM" spans serving infra, model composition, and exec REPLs; only the last needs an exec env |

---

## 2. Engram positioning — per exec-env class

Engram's offer: a **durable snapshot-REPL** (live QuickJS heap → DO SQLite per cell, wake with
full live state, no replay), a planned **`host.spawn` / `host.fork`** recursion primitive, a
**shared R2 `/workspace`** (content-addressed durable files via the host.fs R2 provider, commit
b52d066), and a **sandbox tier** (WASM linear memory + capability-scoped host fns + multi-tenant
DO facets, each with own SQLite). The unique edge across every class: **a recursion tree that
hibernates and resumes — no replay; capability-scoped muscle; content-addressed state.**

### vs in-process `exec()` (LocalREPL, rlm-minimal, λ-RLM, k-a.in, recursive-llm, rig-rlm)

This class trades everything for zero setup latency: no isolation (restricted-builtins dicts that
still allow `__import__`/`open`; rig-rlm is literally native Python + arbitrary bash), no
enforceable timeout (canonical LocalREPL admits "Python cannot interrupt blocking user code"),
and total loss on process death. Engram **strictly dominates on every axis except Python-ness**:
the WASM sandbox is a real boundary (12-import ceiling, capability-scoped `host.*`), the
interrupt-tick budget + used-heap tripwire give typed, recoverable timeouts these envs structurally
cannot have, and the per-cell heap snapshot makes the namespace — closures, pending promises,
everything dill drops — survive eviction. λ-RLM is the sharpest contrast: its deterministic
`_Phi` recursion + closed-form cost is exactly the combinator shape engram already shipped
(SPLIT/MAP/REDUCE, v0.9.2) — but λ-RLM's call stack dies with the process, while an engram `_Phi`
tree built on `host.spawn` would checkpoint at every node and resume mid-tree. Honest gap: these
are Python; engram is JS. (Python kernel dropped per owner — the positioning is "durable JS
code-mode", not Python parity.)

### vs IPython subprocess (the canonical "true isolation" tier)

The subprocess kernel is the canonical repo's best engineering: hard cell timeout + interrupt,
process isolation, kernel survives cell death. But its state is trapped — user_ns isn't even
round-tripped to the parent ("serializing arbitrary user_ns through ZMQ is costly; skip"), and a
dead kernel process loses everything. Engram's snapshot IS the round-trip: the entire heap is the
durable artifact, readable/restorable/content-addressable, and the DO+facet model gives the same
process-isolation property with hibernation for free (a kernel that's idle costs nothing and
wakes in ~130ms–1.5s with state intact — proven to 20-min full eviction, `docs/results/deep-hibernation.md`).

### vs Docker (DockerREPL)

Docker buys OS isolation and the survey's first persistence (dill file on a volume) at the cost of
container lifecycle management, per-exec process spin-up, and `--rm` teardown. The dill file is a
lossy value-serialization of *picklable* vars — engram's snapshot is lossless (promises, closures,
host-tool kv all survive, by construction, because it's the literal memory image). And Docker
multi-turn is `NotImplementedError`; engram sessions are multi-turn by default and bill nothing
while hibernating. Engram's sandbox tier replaces the container; the shared R2 `/workspace`
replaces the volume mount — content-addressed instead of a mutable bind-mount.

### vs Daytona / Modal / E2B / Prime (cloud microVM sandboxes)

The vendors sell isolation-as-a-service; the RLM layer on top is still flat-`llm_query` + dill +
auto-terminating sandboxes ("sub-agent sandboxes are deleted immediately after completion";
`persistent=True` raises in all four). Daytona's deep-RLM is the closest competitor shape —
fresh sandbox per sub-agent, "unlimited depth," budget gating — but every node is *disposable*:
a 50-sandbox tree that hits the 3600s global timeout is simply dead. Engram inverts the economics:
a sub-agent is a facet whose heap snapshot persists for free, so a deep tree can run for days of
wall-clock across hibernation cycles while consuming compute only when awake. Where the vendors'
broker pattern hairpins every LM call through a Flask server + tunnel URL, engram's `host.*` calls
are an in-DO function call. Honest gap: the vendors offer full Linux userlands (pip, arbitrary
binaries); engram offers a Node-shaped JS facade. For "run untrusted code-mode JS with durable
state," engram wins; for "pip install scipy," they do.

### vs Claude-Code-as-env (claude_code_RLM)

The most instructive community design: it independently reinvented durability (pickle the REPL
state to disk so it survives across turns) because the orchestrator (a CC session) is itself
ephemeral. Engram is that pattern done at the substrate level — the "pickle file" is the whole
heap, atomic per cell, with the orchestration loop *also* resumable (a session is a DO that wakes
where it left off). Notably, this design's chunk-files-on-disk + Read-only subagent contract maps
1:1 onto engram's shared R2 `/workspace` + capability-scoped child: a `host.spawn` child handed a
content-addressed workspace path and a scoped capability set is the same architecture, minus the
"orchestration dies with the Claude session" hole. Engram can also BE the env under Claude Code
(the `engram` CLI / SDK already is).

### vs Centaur-class durable orchestration (and the workflow-engine pattern generally)

Centaur is the only surveyed system with real durability — and it's **checkpoint-and-replay at the
step level** (Postgres event trail; re-run handler, skip completed checkpoints), with the explicit
caveat "sandbox pod dies → execution becomes terminal." That's the precise line engram crosses:
engram checkpoints the *live process*, not the steps around it. A Centaur child workflow resumes by
replaying orchestration; an engram child resumes mid-heap with its locals, closures, and pending
state intact — no replay, no re-fired side effects (the core no-replay invariant, proven since V0).
The two are complementary: Centaur-shaped control planes (or ouru) can orchestrate engram kernels
and get durable *leaves*, eliminating the "terminal execution" failure class. OpenProse sits
between: durable world-model, ephemeral renders — engram makes the render itself durable.

### vs swarm orchestrators (Slate, SWARM)

Slate (unverified, press-only) compresses worker episodes into the orchestrator because full state
can't persist — Thread Weaving is a *coping mechanism* for ephemeral workers. With durable workers,
the episode isn't a lossy summary; it's a resumable session id whose full heap can be re-woken and
interrogated. SWARM's spawn-tree accounting (depth limits, inherited reputation, resource splitting,
budget gates) is the governance layer a production `host.spawn`/`host.fork` tree needs — worth
borrowing wholesale — but its sandbox is explicitly "not a security boundary." Engram supplies the
boundary and the durable spawn tree; SWARM-style governance metadata rides in the supervisor.

### The composite edge, stated once

Every surveyed system makes the same forced choice: **isolation XOR statefulness XOR durability**
(in-process = stateful but unsafe+ephemeral; microVM = safe but disposable; workflow engines =
durable but replay-based, live process expendable). Engram's snapshot-REPL refuses the trade: the
WASM heap is simultaneously the sandbox boundary, the live state, and the durable artifact. Add
`host.spawn`/`host.fork` (children = facets with snapshotted heaps; fork = restore parent's
content-addressed snapshot into a fresh facet — the heap-image *enables* true state forking, which
zero surveyed systems have) + shared R2 `/workspace` for cross-node artifacts, and you get the
thing nobody in this survey can build: **a recursion tree where every node hibernates, every node
resumes, and a week-long deep RLM run costs only its awake seconds.**

---

## 3. Key findings

1. **The dill file is the ecosystem's durability ceiling.** Canonical Docker + all four cloud
   backends persist state as a per-cell `dill.dump` of *picklable* vars to `/tmp/rlm_state.dill`
   — lossy (drops sockets, generators, unpicklable closures), intra-completion only, and
   `persistent=True` raises `NotImplementedError` in every isolated backend. No surveyed system
   can checkpoint a live recursion. Engram's lossless heap image is a different category, not a
   better dill.

2. **Recursion is everywhere shallow and nowhere forked.** The universal sub-call pattern is
   fresh-env + sliced-prompt (logical isolation); not one system inherits parent heap, namespace,
   or KV-cache. Defaults: canonical max_depth=1, Prime exactly 1, claude_code_RLM hard-1,
   fast-rlm 3, recursive-llm 5, rig-rlm unbounded-by-accident. The only fork-ish mechanisms found:
   OpenProse's RunContext *handle* share and SWARM's simulated reputation split. `host.fork`
   (restore parent snapshot into a child facet) would be genuinely novel.

3. **Isolation and statefulness are inversely correlated across the survey.** The safest envs
   (microVM IsolatedEnv family) have the weakest state story (dill + auto-terminate + no
   persistent flag) and can't even host recursion (no `rlm_query` wired); the most stateful envs
   (in-process LocalREPL/IPython) have effectively no security boundary and no enforceable
   timeout. Only the canonical ipykernel-subprocess achieves a hard timeout — and it pays by
   abandoning state visibility. Engram's WASM tier is the only design where the same mechanism
   (linear memory) provides boundary, state, and checkpoint.

4. **Naive deep recursion on ephemeral envs is empirically cost-catastrophic** — the CUHK
   reproduction (arXiv 2603.02615) found depth=2 uniformly hurt accuracy and inflated latency
   3.6s→344.5s. Read with λ-RLM's result (deterministic pre-planned recursion, neural inference
   only at bounded leaves, 29/36 wins, 4.1× lower latency): the winning shape is *structured,
   bounded, combinator-driven* recursion — exactly engram's stripped SPLIT/MAP/REDUCE design —
   and the cost problem is precisely what durable hibernation amortizes (depth is expensive only
   when every node must stay resident).

5. **The "RLM" label has detached from its mechanism — the exec env is the real differentiator.**
   The term now spans pure model-composition with zero exec (RLM-JB), deterministic combinator
   programs (λ-RLM), code-mode REPLs (canonical), swarm marketing (Slate, unverifiable), and a
   safety *metric* (SWARM). When evaluating "RLM" claims, ask only: what executes the code, where
   does state live, what survives a crash. By that test the field is: 15+ ephemeral REPLs, one
   pickle file, one replay-based workflow engine, and engram.

6. **Durable orchestration exists; durable execution doesn't.** Centaur (Postgres event trail,
   checkpointed workflows, days-long sleeps) and OpenProse (content-addressed world model,
   crash-safe commits) both solved the *control-plane* durability problem — and both explicitly
   leave the live process expendable ("sandbox pod dies → execution becomes terminal"; renders
   re-run from last truth). The whole field converges on checkpoint-and-replay; engram's
   no-replay heap resume is the unoccupied square, and it composes with (rather than competes
   against) those control planes — ouru can be the Centaur-shaped layer over engram leaves.

7. **Two ideas worth stealing for ouru/host.spawn:** (a) fast-rlm's *compression guard* — a
   cheap self-confirm that blocks under-compressed delegation before a sub-call spends money —
   is the best anti-degenerate-recursion control surveyed and is trivially a supervisor-side
   policy; (b) SWARM's SpawnTree accounting (depth caps, resource splitting, inherited reputation,
   budget `can_acquire` gating) + Prime's 8192-char stdout cap (forces delegation instead of
   dumping) are the governance primitives a durable recursion tree needs so hibernation doesn't
   become immortal-zombie sprawl.

---

## Provenance / verification notes

- **Verified from cloned source:** alexzhang13/rlm (all 6 env backends), rlm-minimal,
  lambda-RLM (lambda-calculus-LLM/lambda-RLM), fast-rlm, rig-rlm, claude_code_RLM, recursive-llm,
  paradigmxyz/centaur docs, swarm-ai-safety/swarm, openprose/prose, drbillwang/rlm-reproduction,
  MinivLLM, tinygrad.c. Line-level citations live in the underlying survey notes.
- **Verified from fetched papers/docs:** arXiv 2603.20105 (λ-RLM), 2602.16520 (RLM-JB),
  2603.02615 (CUHK repro), primeintellect.ai/blog/rlm, daytona.io RLM docs.
- **UNVERIFIED:** Slate v1 — closed-source; blog JS-gated, VentureBeat 403; every cell is
  third-party press paraphrase. fast-rlm's announcement tweet inaccessible (X 402); repo source
  used as authoritative.
- **Engram internals:** `docs/RLM-STRIPPED.md`, CLAUDE.md status log (v0.9–v0.9.3, V1.x),
  `docs/SANDBOX-API.md` (host.fs→R2), commit b52d066 (R2 durable file provider).
  `host.spawn`/`host.fork` are the *planned* ouru-layer primitives, not yet shipped — positioning
  statements about them are design claims, grounded in the proven substrate (snapshot/restore,
  facets, R2 fs), not shipped behavior.
