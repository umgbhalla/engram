# context/ — external repos for exploration

Shallow git submodules of external projects relevant to the durable-kernel build.
Read-only reference. Init with `git submodule update --init --depth 1`.

| dir | repo | why it's here | look at |
|---|---|---|---|
| `quickjs-wasi` | vercel-labs/quickjs-wasi | **Core precedent.** Full QuickJS VM (incl. pending promises) round-tripped via `memory.buffer` + `__stack_pointer`. The snapshot thesis, already done. | snapshot/restore code, WASI import shim, how globals captured |
| `quickjs-ng` | quickjs-ng/quickjs | The JS engine we compile to WASM (v0 kernel). Has built-in snapshot/serialize. | `JS_WriteObject`/`ReadObject`, bytecode/heap layout, build flags |
| `boa` | boa-dev/boa | Pure-Rust JS engine, native wasm32, no WASI. Higher-risk alt (no snapshot API, own GC). | whether heap is byte-copy stable; embedding API |
| `rustpython` | RustPython/RustPython | Python kernel path (later). Single-memory wasm, snapshottable; Pyodide is blocked. | wasm32 target, freeze-stdlib, global/shadow-stack exports |
| `workers-rs` | cloudflare/workers-rs | Rust Durable Object host. `worker` 0.8.3 `#[durable_object]`, SQLite, alarms, WS hibernation. | DO macros, `state.storage().sql()`, `accept_web_socket()`, R2 binding |
| `rivetkit` | rivet-gg/rivetkit | Portability layer. CF driver = thin wrapper over SQLite-backed DO; `c.kv` chunked ≤2 MB. | CF driver, actor state API, kv blob handling |
| `perry` | PerryTS/perry | Native TS compiler (SWC→LLVM, Rust). AOT, not REPL — wrong axis for live kernel, but ref for a possible compile-the-session fast-path. | TS frontend, WASM target emission |
| `wizer` | bytecodealliance/wizer | WASM pre-initialization snapshot tool. Reference for what state is/ isn't capturable (refuses funcref/externref churn). | how it snapshots memory+globals; table limitations |
| `dynos` | threepointone/dynos | Dynamic Worker Loader wrapper reference (if we ever load kernels per-tenant). | `LOADER.get/load`, module map, globalOutbound |

## Notes
- Submodules are `--depth 1` shallow. To update one: `cd context/<dir> && git fetch --depth 1 && git checkout <rev>`.
- Not part of the build. Excluded from cargo/wrangler. Reference + code-reading only.
- Heavy repo `rivet-gg/rivet` (full engine monorepo) deliberately omitted — `rivetkit` covers the CF-actor angle. Add later if needed.

## Priority read order for the snapshot bet
1. `quickjs-wasi` — proves the round-trip; copy its approach.
2. `wizer` — what state must be captured (globals!) + table caveats.
3. `workers-rs` — DO host wiring for EXP-4/5.
4. `quickjs-ng` — engine internals when EXP-1 needs tuning.
