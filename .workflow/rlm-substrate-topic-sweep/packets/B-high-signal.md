# Packet B: High-Signal Substrate Inspection

Objective: inspect canonical and known RLM implementations for runtime substrate
features.

Result: canonical RLM uses LocalREPL, IPython subprocess/in-process modes, and
Docker+dill; fast-rlm uses Deno+Pyodide; rig-rlm uses Rust+PyO3; recursive-llm
uses RestrictedPython; skill-style repos use pickle state.

Verification: source grep and targeted file reads of executor, REPL, Docker,
broker, and persistence paths.
