# Substrate Summary

The RLM ecosystem mostly uses ordinary execution boundaries:

- In-process Python or JavaScript dictionaries/VMs for state.
- Subprocess, Docker, Pyodide, Goja, or cloud sandbox sessions for isolation.
- Pickle/dill files for state across process/container invocations.
- Brokered `llm_query`/`rlm_query` callbacks for recursion.
- Timeouts, budgets, and output truncation as the primary guards.

Missing or rare:

- Live heap checkpointing.
- Parent-state fork/copy-on-write recursion.
- Durable hibernating recursion trees.
- Replay-free recovery of active interpreter state.
- Content-addressed shared workspace as a first-class RLM primitive.
