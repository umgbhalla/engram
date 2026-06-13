# Final Report: RLM substrate topic sweep

## Outcome
Cloned/refreshed all 20 repositories currently returned by the GitHub
`topic:recursive-language-models` API into `/tmp/rlm-substrate-research`.
Inspected the topic repos plus the previously named canonical RLM repos for
execution-substrate features.

## Accepted Results
- Canonical `alexzhang13/rlm`: in-process Python exec, IPython subprocess mode,
  Docker mode with `dill` state, socket/HTTP brokers for subcalls.
- `rlm-minimal`: small in-process Python REPL substrate.
- `fast-rlm`: Deno + Pyodide WASM per subagent; persistent only for the life
  of that Pyodide instance; MCP bridge and async batch subcalls.
- `rig-rlm`: Rust + PyO3 execution boundary.
- `recursive-llm`: RestrictedPython in-process executor; timeout field is not
  enforced in the inspected code.
- `claude_code_RLM` / `vladcioaba/rlm-skill`: assistant-driven Python REPL
  with `state.pkl` persistence of pickleable variables.
- `KillerShoaib/RLM-From-Scratch`: Docker `--rm` invocations sharing
  `/workspace/state.pkl`; only pickleable objects persist.
- `Hmbown/zigrlm`: Zig orchestrator with JS mode and Docker Python mode,
  `/workspace/state.pickle`, host callbacks for `llm_query` and `rlm_query`.
- `kujtimiihoxha/recap`: persistent Goja JavaScript sandbox; context
  summarization while preserving sandbox variables/functions.
- `aymenfurter/rlm-on-azure`: Azure Container Apps Dynamic Sessions as the
  sandboxed REPL; Copilot SDK sessions for root/sub agents.
- `SuperagenticAI/rlm-code`: broad runtime registry: local subprocess,
  Docker, Daytona, E2B, Modal, Apple container, and a Monty/Engram-facing runtime.
- `Hmbown/yahoohoo`: MCP server plus local Python subprocess sandbox with AST
  restrictions, resource limits, and fd-based `llm_query` protocol.

## Rejected Results
- Several topic repos are tagged RLM but are not execution substrate examples:
  Lean proof repos, AGENTS.md generators, RAG benchmarks, memory/audit-trail
  systems, and generic UI demos.
- SQLite usage in RAG repos is mostly retrieval/index storage, not an RLM
  execution checkpoint substrate.

## Conflicts Resolved
When README claims and code differed, classifications used source code paths
that actually execute code, persist state, or dispatch subcalls.

## Verification Evidence
- GitHub topic API returned 20 repos; all 20 now exist under
  `/tmp/rlm-substrate-research`.
- Source grep inspected runtime markers: `exec`, `eval`, `docker`,
  `subprocess`, `pickle`, `dill`, `Pyodide`, `goja`, `session`,
  `sandbox`, `timeout`, `llm_query`, `rlm_query`, `checkpoint`,
  `snapshot`, and `fork`.

## Remaining Risks
- Some large/demo repos were classified shallowly after their execution substrate
  became clear.
- Public repo state can drift; clone paths reflect the current topic result.

## Reusable Follow-up
Turn this into a repo doc if Engram needs a public positioning note:
`docs/research/RLM-SUBSTRATE-USAGE.md`.
