# RLM Substrate Usage

> Research artifact from the GitHub `topic:recursive-language-models` sweep plus the
> earlier RLM execution-environment survey. This document focuses on substrate usage:
> what runtime executes code, where state lives, what survives, and which substrate
> features RLM implementations actually use. It intentionally avoids re-explaining
> RLM algorithm design.

## Bottom Line

Current RLM implementations use only a small subset of what a durable substrate could
provide. The common substrate contract is:

- execute a code cell in a persistent-ish namespace
- expose `llm_query` / `rlm_query` as callbacks from that code
- capture stdout, final answer, and errors
- provide a file/document workspace or loaded context variable
- enforce simple budgets, depth caps, timeouts, and output truncation

The field mostly does **not** use:

- live heap checkpointing
- parent-state fork or copy-on-write child state
- durable hibernating recursion trees
- replay-free recovery of in-flight interpreter state
- content-addressed shared workspaces as a first-class recursion primitive
- durable actor/session identity per recursive node

So the substrate demand today is modest, but the open gap is large: RLMs are
currently shaped around weak substrates. Engram's differentiated feature is not
that existing RLMs already depend on heap snapshots; it is that heap snapshots
make new RLM execution shapes possible.

## Feature Usage By Frequency

| Substrate feature | Usage in surveyed RLMs | Notes |
|---|---:|---|
| Persistent namespace across cells | Very common | Python dicts, IPython user namespace, Goja VM state, Pyodide globals, pickle/dill reloads. Usually only survives while process/session lives. |
| Code execution cell | Universal for code-mode RLMs | Usually Python `exec()`; sometimes JS/Goja, Pyodide, PyO3, Azure Dynamic Sessions. |
| `llm_query` callback | Universal for recursive/code RLMs | Most are flat sub-LLM calls; fewer spawn child RLM loops. |
| Batched subcalls | Common | ThreadPoolExecutor, async gather, Promise.all, or explicit batch APIs. |
| Context/file loading | Common | Context variables, temp dirs, mounted Docker volumes, uploaded files, RAG stores. |
| Output capture/truncation | Common | Used as a guardrail and forcing function for delegation. |
| Depth/budget limits | Common | Usually orchestration-level, not substrate-level. |
| Timeout/kill | Mixed | Docker/subprocess/cloud can kill. In-process Python often cannot safely enforce. |
| OS/container isolation | Mixed | Docker, Daytona, E2B, Modal, Azure sessions, Apple containers. Many repos stay in-process. |
| Pickle/dill state across invocations | Common in isolated Python variants | This is the ecosystem's durability ceiling; unpicklable values are dropped. |
| Durable workflow replay | Rare | Centaur-like control planes do this, but not live interpreter persistence. |
| Heap checkpoint / hibernation | Absent outside Engram history | No surveyed external repo checkpoints live interpreter memory. |
| Parent-state fork | Absent | Children get fresh environments plus sliced prompts/context. |
| Durable recursion tree | Absent | Existing recursive nodes are disposable calls/sandboxes, not resumable actors. |

## Substrate Matrix

| System | Runtime substrate | State model | Recursive call substrate | What survives | Missing substrate features |
|---|---|---|---|---|---|
| `alexzhang13/rlm` LocalREPL | In-process Python `exec()` | `globals` / `locals` dicts | Direct Python callbacks to parent `RLM._subcall` | Process memory only | isolation, hard kill, durable state, fork |
| `alexzhang13/rlm` IPython subprocess | `ipykernel` subprocess via Jupyter client | Kernel user namespace | TCP socket broker back to parent | Kernel state while subprocess lives | durable checkpoint, parent state fork |
| `alexzhang13/rlm` DockerREPL | Docker container plus `docker exec python -c` | `/workspace/state.dill` | HTTP proxy to parent | Pickle/dill-able vars during container life | live heap, unpicklable state, durable tree |
| `rlm-minimal` | In-process Python REPL | local dicts | flat sub-LLM call | one run | isolation, persistence, deep recursion |
| `lambda-RLM` | In-process Python exec | one local call stack | deterministic recursive combinator | one process | crash recovery, durable stack |
| `fast-rlm` | Deno + Pyodide WASM | Pyodide globals per subagent | async `llm_query`, `batch_llm_query`, MCP bridge | one Pyodide process lifetime | memory snapshot, durable Pyodide state |
| `rig-rlm` | Rust + PyO3 embedded CPython | fresh `PyDict` per call | Python function into Rust orchestrator | effectively nothing | sandbox, persistence, limits |
| `recursive-llm` | RestrictedPython in-process | env dict | child RLM calls with max depth | one run | enforced timeout, durable state |
| `claude_code_RLM` | Claude Code + host Python subprocess | `.claude/rlm_state/state.pkl` | Claude Code subagent/task calls | pickleable vars and files | in-flight orchestration, heap state |
| `vladcioaba/rlm-skill` | CLI skill Python REPL | `state.pkl` per session | HTTP/model helper functions | pickleable vars, budget JSON | live heap, fork |
| `KillerShoaib/RLM-From-Scratch` | Docker `--rm` per command | mounted `/workspace/state.pkl` | `llm_query` helper | pickleable vars in state dir | durable process, closures/sockets/generators |
| `Hmbown/zigrlm` | Zig orchestrator, JS mode, Docker Python mode | Docker `/workspace/state.pickle` | host callbacks for `llm_query` / `rlm_query` | pickle/dill-able namespace | heap checkpoint, durable nodes |
| `kujtimiihoxha/recap` | Goja JavaScript VM | VM variables/functions persist across tool calls | async `llm_query(context, query)` | process lifetime and summarization boundary | crash recovery, fork |
| `aymenfurter/rlm-on-azure` | Azure Container Apps Dynamic Sessions | remote session files/state | Copilot SDK root/sub sessions | session lifetime | durable heap, fork, in-flight resume |
| `SuperagenticAI/rlm-code` | runtime registry: local subprocess, Docker, Daytona, E2B, Modal, Apple container, Monty | varies; local dicts, dill, session JSON | framework/tool adapters | runtime-dependent | no common live checkpoint primitive |
| `Hmbown/yahoohoo` | MCP server + local Python subprocess sandbox | per sandbox run | fd protocol for `llm_query` | bounded run output | persistent live state, fork |
| `jsueling/rlm` | Docker Python container | live container / script execution | `llm_query` helper | container lifetime | durable checkpoint |
| `tushark01/rlm_demo` | in-process Python sandbox | globals dict per session | recursive helper method | one session | strong isolation, durability |
| `dschulmeist/replm` | wrapper/orchestrator, Python REPL style | session/orchestrator state | subcall manager | process/session | live checkpoint |
| RAG/topic-only repos | SQLite/vector stores, retrieval code | index/database state | LLM calls over retrieved chunks | retrieval artifacts | not execution substrates |
| proof/generator/UI topic repos | Lean proofs, AGENTS generators, UI demos | none relevant | none relevant | N/A | not RLM substrate examples |

## Per-REPL Implementation And Usage Notes

This is the layer that matters: how each RLM actually implements the REPL-like
substrate and which parts of that substrate the RLM loop uses.

### Canonical `alexzhang13/rlm`

**LocalREPL**

- Implementation: a Python object owns `globals` and `locals` dicts, then runs
  model-emitted code with `exec(code, combined, combined)`.
- REPL state: normal Python variables in memory. The namespace persists across
  cells while the environment object lives.
- Substrate used by RLM: context injection, `SHOW_VARS`, stdout capture,
  `answer` dict, `llm_query`, `llm_query_batched`, `rlm_query`,
  `rlm_query_batched`.
- Recursion use: `rlm_query` calls back into the parent `RLM._subcall`, which
  creates a fresh child RLM/environment. The child does not inherit parent
  namespace.
- Limits: weak Python builtins filtering, no strong sandbox, no reliable hard
  kill for hostile/blocking code.
- Durability: none. The entire REPL is process memory.

**IPythonREPL**

- Implementation: wraps IPython either in-process or as an `ipykernel`
  subprocess through Jupyter client.
- REPL state: IPython user namespace, persistent for kernel lifetime.
- Substrate used by RLM: same scaffold functions as LocalREPL, plus a broker
  when the kernel is in a subprocess.
- Recursion use: subprocess kernel calls parent through a socket/JSON broker;
  parent spawns child RLMs. Again, no parent-state fork.
- Limits: subprocess mode can interrupt/timeout a cell more honestly than
  in-process Python.
- Durability: none. Kernel lifetime only.

**DockerREPL**

- Implementation: long-lived Docker container, each cell executed through
  `docker exec python -c <script>`.
- REPL state: script loads `/workspace/state.dill`, runs code, then saves
  pickle/dill-able variables back.
- Substrate used by RLM: volume mount, dill state file, parent HTTP proxy for
  `llm_query`, stdout/error JSON envelope.
- Recursion use: mostly flat `llm_query` back to parent; recursion is not a
  heap fork or container fork.
- Limits: Docker gives OS isolation; state is lossy because dill cannot preserve
  live runtime values.
- Durability: state file survives process execs and maybe container lifetime;
  orchestration and live heap do not.

**Cloud isolated backends: Daytona/E2B/Modal/Prime-style**

- Implementation: remote sandbox/microVM/container runs generated Python scripts.
- REPL state: usually the same dill/pickle state file pattern inside the sandbox.
- Substrate used by RLM: file upload, remote execute, HTTP/tunnel broker, timeout,
  sandbox lifecycle APIs.
- Recursion use: subcalls go back through a broker to the parent; children are
  fresh sandboxes or fresh logical calls.
- Limits: stronger isolation and package/runtime freedom, but weak persistence.
- Durability: sandbox/session lifetime, not durable heap.

### `rlm-minimal`

- Implementation: tiny in-process Python REPL around `exec`/`eval`.
- REPL state: one dict-like namespace for a completion.
- Substrate used by RLM: run code blocks, expose `llm_query`, `FINAL`,
  `FINAL_VAR`, capture output.
- Recursion use: pedagogical depth-1 style; subcall is a model call, not a child
  persisted REPL.
- Durability: none.

### `lambda-RLM`

- Implementation: Python local execution with deterministic combinator code.
- REPL state: one process/call stack; context loaded into Python variables.
- Substrate used by RLM: code execution as a host for SPLIT/MAP/REDUCE-like
  functions and bounded recursive calls.
- Recursion use: structured recursive function calls inside the same interpreter,
  not separate durable child sessions.
- Durability: none. If the Python process dies mid-combinator, the tree is gone.

### `fast-rlm`

- Implementation: Deno process loads Pyodide; each subagent runs Python inside
  WASM via `pyodide.runPythonAsync`.
- REPL state: Pyodide globals persist during one subagent's lifetime.
- Substrate used by RLM: Python async REPL, `llm_query`, `batch_llm_query`,
  `FINAL`, schema validation, MCP bridges, Deno file/config/env access.
- Recursion use: `llm_query` starts another subagent with its own new Pyodide
  instance and prompt/context. No heap inheritance from parent.
- Limits: strong-ish WASM/Deno boundary, cost/depth/batch guards, but no
  checkpointing despite WASM being snapshot-friendly in principle.
- Durability: logs/final JSON only, not REPL memory.

### `rig-rlm`

- Implementation: Rust orchestrator embeds CPython with PyO3.
- REPL state: fresh Python dict per command path in the inspected implementation.
- Substrate used by RLM: execute Python snippets, expose a model-query function,
  parse final result variable.
- Recursion use: Python function calls back into Rust to spawn another agent.
- Limits: prototype boundary, no meaningful sandbox; separate bash command path
  can run shell commands.
- Durability: none.

### `recursive-llm`

- Implementation: RestrictedPython compiles code with `compile_restricted_exec`
  and runs it in a restricted global/env pair.
- REPL state: env dict persists through one run.
- Substrate used by RLM: safe-ish code execution, restricted builtins/modules,
  final answer extraction, recursive helper function.
- Recursion use: child RLM calls with max depth, each fresh environment.
- Limits: timeout parameter exists but inspected code says it is not enforced.
- Durability: none.

### `claude_code_RLM`

- Implementation: Claude Code workflow drives a Python CLI REPL script.
- REPL state: `.claude/rlm_state/state.pkl`; each invocation loads state, runs
  code, filters pickleable variables, saves atomically.
- Substrate used by RLM: file-backed context chunks, Python helper functions,
  state file, Claude Code task/subagent calls.
- Recursion use: Claude Code subagents analyze chunks; subagents do not inherit
  the REPL namespace.
- Limits: durability is better than most community examples, but only for
  pickleable values and files.
- Durability: partial disk persistence; no live process checkpoint.

### `vladcioaba/rlm-skill`

- Implementation: local Python CLI skill with `start`, `exec`, `final`,
  `budget`, `list`, `stop`.
- REPL state: per-session `state.pkl` plus budget JSON.
- Substrate used by RLM: persistent context, helper injection, `llm_query`,
  `llm_query_batch`, budget/token guard, final file output.
- Recursion use: model calls through helper; not a durable child REPL tree.
- Durability: pickleable namespace and budget file.

### `KillerShoaib/RLM-From-Scratch`

- Implementation: orchestrator shells out to Docker `run --rm`; mounted
  `state_dir:/workspace`.
- REPL state: `/workspace/state.pkl` loaded/saved by `rlm_repl.py`.
- Substrate used by RLM: Docker isolation, mounted files, state pickle,
  `llm_query`, file helper functions, final answer file.
- Recursion use: sub-LLM helper, not heap fork.
- Limits: every container process starts fresh and reconstructs from pickle.
- Durability: state directory survives; live interpreter does not.

### `Hmbown/zigrlm`

- Implementation: Zig orchestrator supports a JS mode and a Docker Python mode.
- REPL state: Docker Python script uses `/workspace/state.pickle`, dill if
  available, pickle otherwise.
- Substrate used by RLM: Docker process control, timeout watcher, JSON protocol,
  host callbacks for `llm_query`, `rlm_query`, batched variants.
- Recursion use: host callbacks route recursive requests to the orchestrator.
- Limits: better systems programming around process control, same pickle ceiling.
- Durability: pickleable state only.

### `kujtimiihoxha/recap`

- Implementation: Go program embeds a Goja JavaScript runtime plus event loop.
- REPL state: JavaScript variables and functions persist in the Goja runtime.
- Substrate used by RLM: loaded `documents` array, `print`, async
  `llm_query(context, query)`, run-code tool, context summarization when model
  context fills up.
- Recursion use: `llm_query` is an async bridge to the host model.
- Interesting usage: the model conversation may be summarized while the sandbox
  state remains alive. This is a clear separation of model context from REPL state.
- Durability: process lifetime only; no snapshot on crash.

### `aymenfurter/rlm-on-azure`

- Implementation: Azure Container Apps Dynamic Sessions provide the remote code
  execution session. Copilot SDK drives root and sub-agent tool calls.
- REPL state: remote session files/variables while the Azure session exists.
- Substrate used by RLM: create session, upload corpus, upload SDK wheel, execute
  init code, execute Python via `run_python` tool.
- Recursion use: in-sandbox `rlm_query` creates fresh Copilot sessions and
  child namespaces.
- Limits: strong external substrate dependency; no evidence of durable heap.
- Durability: remote session lifetime.

### `SuperagenticAI/rlm-code`

- Implementation: multiple runtime backends under one interface: local subprocess,
  Docker, Daytona, E2B, Modal, Apple container, Monty/Engram-facing runtime,
  plus local/dockery code interpreters.
- REPL state: depends on backend. Local interpreter uses persistent namespace;
  Docker interpreter uses `state.dill`; session manager saves JSON metadata.
- Substrate used by RLM: runtime selection, sandbox execute API, persistent shell,
  session replay/history, framework adapters.
- Recursion use: adapters/tool calls rather than one uniform durable substrate.
- Interesting usage: it is a taxonomy repo as much as an implementation; useful
  for seeing all substrate options in one place.
- Durability: varies; no universal live checkpoint.

### `Hmbown/yahoohoo`

- Implementation: MCP server invokes a local Python subprocess sandbox runner.
- REPL state: per-run input/output; not a persistent notebook namespace.
- Substrate used by RLM: AST validation, restricted imports/builtins, resource
  limits, subprocess timeout, fd 3 protocol for host `llm_query`.
- Recursion use: sandbox code requests host sampling; max call limit guards it.
- Interesting usage: MCP is the outer substrate; Python sandbox is a tool inside it.
- Durability: none beyond returned result.

### `jsueling/rlm`

- Implementation: Docker Python container via Python Docker SDK.
- REPL state: live container/workdir behavior; code written/executed inside
  running container.
- Substrate used by RLM: Docker isolation, injected `llm_query`, model loop
  parses Python blocks and runs them.
- Durability: container lifetime, not checkpoint.

### `tushark01/rlm_demo`

- Implementation: in-process Python sandbox built around a globals dict and
  redirected stdout.
- REPL state: globals persist for one session/root run.
- Substrate used by RLM: `run_python(code)` tool, document-bound helpers,
  recursive helper method, stdout limit.
- Durability: none.

### `dschulmeist/replm` / forks

- Implementation: Python wrapper/orchestrator around REPL-style execution and
  subcall manager.
- REPL state: process/session state plus tracing/cache layers.
- Substrate used by RLM: wrapper API, subcall manager, async gather, metadata,
  tracing, cache.
- Interesting usage: more about orchestration ergonomics than a novel execution
  substrate.
- Durability: no live checkpoint found.

## Topic Sweep Additions

The GitHub topic page added useful breadth but did not change the core conclusion.

High-signal additions:

- `kujtimiihoxha/recap`: notable because it uses a persistent Goja JavaScript
  sandbox and explicitly survives context summarization boundaries while VM state
  remains in memory.
- `Hmbown/zigrlm`: useful because it separates orchestration in Zig from Docker
  Python state in `/workspace/state.pickle`.
- `aymenfurter/rlm-on-azure`: useful because it maps RLM execution onto Azure
  Dynamic Sessions and Copilot SDK tool calls.
- `SuperagenticAI/rlm-code`: useful because it catalogs many substrate backends
  in one project: local, Docker, cloud sandboxes, and Monty/Engram-facing runtime.
- `Hmbown/yahoohoo`: useful because it is MCP-first and uses a practical local
  subprocess sandbox with AST restrictions and an fd-based `llm_query` protocol.

Low-signal or non-substrate additions:

- AGENTS.md generators using DSPy/RLM as an application layer.
- Lean proof repositories about RLM theory.
- RAG benchmarks and vector-store projects.
- Memory/audit-trail systems.
- Generic UI demos tagged RLM.

## What Existing RLMs Actually Need From A Substrate

The practical minimum is small:

1. A stateful code-cell API: `eval(code) -> stdout, value, error`.
2. A persistent namespace across turns.
3. An injected subcall API: `llm_query`, `rlm_query`, and batch variants.
4. A way to load large context without placing all of it in the model prompt.
5. A file/workspace abstraction.
6. Output truncation and structured final-answer capture.
7. Budget, depth, concurrency, and timeout controls.
8. A reset/cleanup path.

That is enough to port most existing RLMs.

## What Existing RLMs Do Not Yet Exploit

These are the substrate features that would be new, not merely parity:

1. **Heap checkpointing:** persist closures, globals, promises, module state, and
   unpicklable runtime values without value serialization.
2. **Replay-free resume:** wake a kernel without re-running previous code or
   re-firing side effects.
3. **Durable recursive nodes:** make every child RLM call a resumable session,
   not an ephemeral function call or disposable sandbox.
4. **Fork from parent state:** create a child from a parent snapshot so it inherits
   the computed workspace/namespace without reloading or copying manually.
5. **Shared content-addressed workspace:** pass files/artifacts by stable handle
   across parent and child nodes.
6. **Crash-tolerant long recursion:** let deep RLM trees sleep between work bursts
   instead of keeping every node resident or losing the run.

## Engram Implication

For compatibility, Engram only needs to expose the boring substrate well:

- cell eval
- persistent namespace
- stdout/error/value capture
- `host.subLM` or equivalent model-call bridge
- `host.spawn` as fresh child session
- shared `/workspace`
- budget/depth/concurrency controls

For differentiation, Engram should not pitch this as "RLM algorithm support."
It should pitch the substrate gap:

> Existing RLMs simulate state with Python dicts, pickle files, Docker volumes,
> or cloud sandbox sessions. Engram can make the interpreter heap itself the
> durable artifact, so a recursive computation can hibernate and resume without
> replay.

The most important future primitive is `host.fork`: restore a parent heap snapshot
into a child session/facet. That is the feature no surveyed RLM substrate has.

## Common Themes

### 1. The REPL is mostly used as external working memory

Most systems use the REPL less like a general computer and more like a scratchpad
that can hold large text, indices, chunk lists, intermediate buffers, and partial
answers outside the model context window.

Concrete pattern:

- load corpus into `context`, `documents`, files, or a mounted workspace
- use code to search/filter/chunk
- send only selected chunks to `llm_query`
- aggregate returned summaries in REPL variables

### 2. Subcalls are logical children, not substrate children

Even when code says `rlm_query`, the child usually receives only a prompt or
context slice. It does not receive a fork of the parent's interpreter state.

Common child forms:

- a fresh Python dict
- a fresh Pyodide instance
- a fresh Docker/cloud sandbox
- a fresh model session
- a plain model call with no REPL at all

### 3. Pickle/dill is the shared persistence hack

When projects need state across process/container invocations, they almost always
serialize a filtered namespace to `state.pkl`, `state.dill`, or similar.

This preserves simple values but loses or filters:

- open handles
- sockets
- generators
- closures/lambdas depending on implementation
- pending async work
- interpreter internals
- in-flight side effects

### 4. Stronger isolation usually means weaker state

In-process REPLs preserve rich state while alive but are unsafe and hard to kill.
Docker/cloud sandboxes improve isolation and timeout behavior but fall back to
pickle/dill or session lifetime for state.

That is the central tradeoff in the field.

### 5. Context summarization is used because substrate state is not trusted enough

Many systems summarize the model conversation while trying to keep the REPL state
alive. `recap` makes this explicit: the model context can be compacted while the
Goja sandbox keeps variables/functions.

This points to the core split:

- model context is compressed
- REPL state is treated as ground truth

But because the REPL state is usually ephemeral, that ground truth is fragile.

### 6. Guarding is orchestration-level, not substrate-level

Budgets, depth caps, max calls, output truncation, and delegation checks are
usually implemented in the orchestrator/helper functions, not in the runtime
substrate itself.

Substrate-level guards appear only when the backend has a hard kill boundary:

- subprocess timeout
- Docker timeout
- cloud sandbox timeout
- Deno/Pyodide process boundary

### 7. Batch fanout is the main performance feature

The most common optimization is not checkpointing or fork; it is batching:

- `llm_query_batched`
- `batch_llm_query`
- `Promise.all`
- thread pools
- async gather

This confirms that RLM workloads are map/reduce-shaped in practice.

## Shared Implementation Themes

These are patterns that repeat across unrelated repos:

- **Injected helper scaffold:** every cell gets functions like `llm_query`,
  `FINAL`, `SHOW_VARS`, `print`, or file helpers injected into the namespace.
- **State cleanup filter:** pickle-backed REPLs remove helper functions and
  unpickleable objects before saving.
- **Answer sentinel:** final answer is usually a variable, dict mutation, helper
  call, or file written by `FINAL`.
- **Parent broker:** isolated sandboxes cannot call the model directly without a
  bridge, so they use sockets, HTTP, fd protocols, or host callbacks.
- **Fresh child default:** recursion spawns a new logical environment instead of
  inheriting state.
- **Output clipping:** stdout is clipped aggressively to avoid dumping the corpus
  back into the model context.
- **Context handles over context text:** better implementations pass filenames,
  workspace paths, document arrays, or context variables instead of raw prompt text.

## Tangential Themes

These are adjacent, not core RLM substrate, but they show where the ecosystem is
trying to go.

### MCP as outer substrate

`yahoohoo`, `fast-rlm`, and other newer projects route tools/resources through
MCP-like interfaces. MCP is not the REPL, but it becomes the control plane around
the REPL.

### RAG stores are data substrate, not execution substrate

Some topic repos use SQLite/vector stores heavily. That persistence is for
retrieval indices, not interpreter state. It should not be confused with REPL
checkpointing.

### Workflow replay is orthogonal

Durable workflow systems can replay orchestration steps, but that is different
from resuming a live interpreter heap. Replay can avoid rerunning completed
workflow steps; it cannot preserve arbitrary in-process REPL state unless the
REPL itself is checkpointed.

### Cloud sandbox vendors solve isolation, not recursion durability

Daytona/E2B/Modal/Azure-style environments are valuable for package installs,
Linux tools, and hard kill boundaries. They still mostly expose disposable
sessions, not durable recursive actors.

### JS substrates are emerging beside Python

Goja and Engram-like/Monty-facing runtimes matter because RLM does not require
Python specifically. The actual requirement is a programmable stateful namespace
plus model-call bridge.

### The term RLM is overloaded

The topic page includes proof repos, RAG experiments, AGENTS generators, UI demos,
and memory systems. For substrate research, most of those are noise unless they
execute model-written code in a stateful environment.

## Verification Notes

- Topic source: `https://api.github.com/search/repositories?q=topic:recursive-language-models&per_page=100`.
- Clone root: `/tmp/rlm-substrate-research`.
- Topic count at sweep time: 20 repositories, all cloned/fetched.
- Substrate markers inspected: `exec`, `eval`, `docker`, `subprocess`,
  `pickle`, `dill`, `Pyodide`, `goja`, `session`, `sandbox`,
  `timeout`, `llm_query`, `rlm_query`, `checkpoint`, `snapshot`,
  and `fork`.
- Existing deeper survey: `docs/research/RLM-EXEC-ENVIRONMENTS.md`.
- Workflow record: `.workflow/rlm-substrate-topic-sweep/`.
