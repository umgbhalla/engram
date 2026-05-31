# EXP-4b results — Rust DO + nested-WASM memory access spike

**Date:** 2026-06-01 · **Branch:** `exp/4b-rust-host` · **Verdict: PASS ✅ — BOTH paths work on real Cloudflare**

This spike answers feasibility **risk #3 / open question #1** (the biggest unvalidated
risk): *can a workers-rs RUST Durable Object host read/write a nested QuickJS wasm
instance's linear memory + exported globals to snapshot it?*

**Both paths were built, deployed, and proven on production Cloudflare:**

- **(a) PURE RUST** — a Rust DO instantiates the nested QuickJS wasm *from Rust* (via
  js-sys driving the JS `WebAssembly` API) and reads/writes its `memory.buffer` and
  `__stack_pointer` Global directly, dumps a full image, drops the instance, restores
  into a FRESH instance, and reads the sentinel + global back. **PASS.**
- **(b) RUST DO shell + thin JS glue** (quickjs-wasi, the EXP-5a approach) — a Rust DO
  delegates the real QuickJS eval (`x=42`, closure) + memory dump to a JS glue module.
  Namespace survived a **real DO eviction** (Rust constructor generation 1→2) restored
  from R2. **PASS.**

**Verdict on "all-Rust":** the all-Rust path is **clean for the snapshot mechanics**
(instantiate + read/write nested linear memory + globals + restore are all reachable
from Rust). It is **NOT clean for *driving* the interpreter** (eval): that needs the
full QuickJS C-ABI / WASI shim, which quickjs-wasi already provides in JS. So the
**practical** recommendation is **path (b): Rust DO shell + JS glue for eval+dump** —
not because Rust *can't* touch nested memory (it provably can), but because
reimplementing the quickjs-wasi WASI+marshalling shim in Rust is pure cost with no
benefit. See "Verdict for the build".

**Deployed worker:** `https://montydyn-exp4b.umg-bhalla88.workers.dev`
(HTTP `/path-a?id=<s>` runs path-a; `wss://…/ws?id=<s>` drives both)
**DO binding:** `KERNEL_DO` (Rust class `KernelDO`) · **R2:** `montydyn-snapshots`,
keys namespaced `exp4b/<doId>.qjs.gz` · **Worker startup:** 14 ms (no Error 10021).

## Architecture

- **Host DO = Rust** `worker` 0.8.3 `#[durable_object]`, `wasm32-unknown-unknown`,
  built with `worker-build` 0.8.3. SQLite `meta.generation` bumped every constructor
  (eviction evidence); hibernatable WebSocket via `state.accept_web_socket()` +
  `set_websocket_auto_response(ping/pong)`; R2 via `env.bucket("SNAPSHOTS")`.
- **Nested QuickJS** = the same prebuilt `quickjs.wasm` (quickjs-wasi 3.0.0) used in
  EXP-1/5a, bundled as a **CompiledWasm** module → a `WebAssembly.Module`.
- **The `WebAssembly.Module` is supplied to both the Rust path and the JS glue via a
  thin wrapper entry (`entry.mjs`)** that imports `quickjs.wasm` as CompiledWasm and
  stashes it on `globalThis.__QJS_MODULE` before the worker boots (see Gotchas — this
  layering is forced by the toolchain).

## Path (a) — pure-Rust nested memory + global access ✅

`src/lib.rs::run_path_a()`, entirely in Rust via js-sys:

1. `WebAssembly::Instance::new(&module, &imports)` — Rust instantiates the nested
   QuickJS module (12 host/WASI imports supplied as Rust closures; minimal stubs,
   enough to instantiate + run `_initialize`).
2. Grab `exports.memory` (a `WebAssembly::Memory`) and `exports.__stack_pointer`
   (a `WebAssembly::Global`) from Rust.
3. **Write** from Rust: poke a 16-byte sentinel `MONTYDYN-EXP4B-A` into nested linear
   memory at offset 900 000; set `__stack_pointer` global to a marker.
4. **Read** from Rust: copy the full `memory.buffer` (a `Uint8Array`) into a Rust
   `Vec<u8>`; read the global back.
5. **Drop** the instance (simulated eviction), instantiate a FRESH one, blit the image
   back into its memory and restore the global — all from Rust.
6. **Read sentinel + global back** from the fresh instance.

| Check | Got |
|---|---|
| nested `memory` length (initial) | **1,179,648 B** (18 × 64 KiB pages) |
| sentinel readable after Rust write (live) | **true** |
| `__stack_pointer` initial | **1048576** |
| `__stack_pointer` after Rust write | **4342338** (marker) |
| full image bytes read by Rust | **1,179,648** |
| sentinel restored into fresh instance, read by Rust | **true** |
| `__stack_pointer` restored & read by Rust | **4342338** ✓ |
| **`pass`** | **true** |

This proves **all four primitives — read memory, write memory, read global, write
global, plus full image snapshot+restore into a fresh nested instance — are reachable
from a Rust workers-rs DO.** The feared blocker (risk #3) does **not** exist for the
memory-access mechanics.

## Path (b) — Rust DO shell + JS glue, real eviction ✅

The Rust DO (`KernelDO`) holds an opaque JS `GlueKernel` (quickjs-wasi) in a
`RefCell`; `eval`/`snapshot`/`evict` route through it. Lazy restore: first `eval`
after a cold start gunzips the R2 blob → `deserializeSnapshot` → `QuickJS.restore`.

**Real cold wake (idle-driven eviction):** setup `x=42; inc=()=>++x`, snapshot at
Rust-constructor **generation 1**, disconnect, idle 75 s, reconnect:

| Check | Expected | Got |
|---|---|---|
| Rust DO generation after idle | bumped (reconstructed) | **2** |
| glue kernel present at reconnect | absent | **false** |
| first `eval "x"` restoreSource | `r2-restore` | **r2-restore** |
| `eval "x"` | 42 | **42** |
| `eval "inc()"` (closure survived) | 43 | **43** |

`generation 1 → 2` proves the **Rust** DO was genuinely evicted and re-constructed,
yet the QuickJS namespace came back from R2 — **real eviction, not a simulation.** A
deterministic `{t:'evict'}` drop also passed (`x=42`, `inc()=43`, `r2-restore`).

## Numbers (on Cloudflare)

| Metric | Value |
|---|---|
| Snapshot raw (serialized) | **1,245,212 B** (~1.19 MiB) |
| Snapshot gzip (R2) | **99,802 B** (~97.5 KiB) — ~12.5× |
| `__stack_pointer` at snapshot (path-b) | 1048576 (quiescent stack top) |
| Path-b restore round-trip (client-observed: msg→R2 get→gunzip→restore→eval→reply) | **~912 ms** |
| Path-a full nested dump+restore round-trip (client-observed) | **~359 ms** |
| Nested QuickJS initial linear memory | 1,179,648 B (18 pages) |
| Rust DO wasm (`index_bg.wasm`, release, wasm-opt) | ~349 KiB |
| Total Worker upload | 2003.69 KiB / gzip 709.52 KiB |
| Worker startup | 14 ms |

Sizes match EXP-5a exactly (same quickjs.wasm + same snapshot path) — expected, since
path-b reuses the EXP-5a JS dump. Path-a round-trip (~359 ms) is the pure-Rust
instantiate-twice + blit cost and is *not* directly comparable (no gzip/R2, and it
does two instantiations in one request).

## Platform errors hit

**None of the feared runtime ones.** No Error 1101/1102/10021/10195 at this size.
The *build*-time blockers (toolchain, not platform) are documented below — they were
all worked around without patching worker-build.

## Gotchas / findings

- **Pure-Rust nested access is real but indirect.** On workerd there is no native wasm
  host (no wasmtime/wasmer — those need JIT/OS). "Pure Rust host" therefore means *Rust
  driving the JS `WebAssembly` API via js-sys* (`WebAssembly::Instance::new`,
  `Memory::buffer` → `Uint8Array`, `Global::value`/`set_value`). All of these are in
  js-sys 0.3 and work on workerd. There is **no** Rust-native embedding of the nested
  module; it is always mediated by the JS engine — but that mediation is fully
  controllable from Rust.
- **All-Rust is clean for snapshot mechanics, NOT for eval.** Reading/writing nested
  memory + globals and snapshot/restore are clean from Rust. *Driving* QuickJS (eval a
  cell) requires the 12 host/WASI imports as real implementations **and** the
  JS_Eval C-ABI argument marshalling into linear memory — i.e. reimplementing the
  entire quickjs-wasi shim in Rust. That is the real cost of "all-Rust", and it buys
  nothing over reusing the proven JS glue. **Recommendation: degrade to path (b)** —
  Rust DO shell + JS glue for eval+dump — exactly as the feasibility doc predicted
  ("'All-Rust' likely degrades to 'Rust DO shell + JS glue doing the dump' —
  acceptable, not the clean thesis"). The nuance this spike adds: the *dump itself* is
  NOT the hard part (Rust can do it); the *eval driver* is.
- **CompiledWasm must be bundled by WRANGLER, not worker-build's esbuild.** workerd
  bans `WebAssembly.compile` of arbitrary bytes, so quickjs.wasm must be a CompiledWasm
  import. But worker-build runs its own esbuild internally (which has no `.wasm` loader
  and no external-flag passthrough). Solution: a wrapper `entry.mjs` (wrangler `main`)
  does `import q from "./src/quickjs.wasm"` (CompiledWasm rule) → `globalThis.__QJS_MODULE`,
  then re-exports `build/worker/shim.mjs`. The JS glue and Rust both read the Module
  from `globalThis`. The Rust DO wasm (`index_bg.wasm`) is handled by worker-build; the
  CompiledWasm rule is scoped to `src/quickjs.wasm` so the two don't collide.
- **worker-build 0.8.3 × project package.json `dependencies` = build break.** If the
  project `package.json` lists `quickjs-wasi`, worker-build merges it into the
  wasm-bindgen snippet `package.json` and then mis-parses the nested
  `{"dependencies":{…}}` shape (`invalid type: map, expected a string at line 2 col 18`).
  Fix: **do NOT list quickjs-wasi in `dependencies`** — keep it only in `node_modules`
  (install via a transient dep or directly) and `import { QuickJS } from "quickjs-wasi"`
  in glue.js as a bare specifier; worker-build's esbuild resolves it from node_modules
  and emits no snippet dependency. (Pinning wasm-bindgen did NOT fix this; it is the
  package.json merge, not the bindgen version.)
- **DurableObject trait methods take `&self`.** Unlike the JS DO (`this.kernel=…`), the
  Rust `DurableObject` trait hands `&self` to `fetch`/`websocket_message`. Mutable
  per-session state (the live glue kernel) must use interior mutability
  (`RefCell<Option<GlueKernel>>`); never hold a `borrow()` across an `.await` (clone the
  cheap JS handle out first).
- **GlueKernel (a wasm-bindgen extern type) is not auto-`Clone`** here — `.clone()` on
  `&GlueKernel` resolved to `&GlueKernel`. Clone via the underlying `JsValue`
  (`v.clone().unchecked_into()`); it is a JS reference, not a deep copy.
- **Hibernation works under a Rust DO** exactly as under JS: `accept_web_socket` +
  auto ping/pong let the DO go idle → evict → reconstruct (generation bump observed).

## Leftover resources (intentionally kept)

- Worker `montydyn-exp4b` (URL above) — left deployed.
- R2 bucket `montydyn-snapshots` — shared; EXP-4b keys namespaced `exp4b/…`.
- Pre-existing workers/buckets (curl-worker, durelo, thinkx-api, durelo-content,
  nova-archive, sdev-skills, montydyn-exp5a) **not touched**.

## Files

- `experiments/exp-4b/Cargo.toml` (worker 0.8, js-sys; `opt-level=z`, lto)
- `experiments/exp-4b/src/lib.rs` (Rust DO `KernelDO`; path-a `run_path_a`; path-b glue bindings)
- `experiments/exp-4b/src/glue.js` (quickjs-wasi driver + Module exposer)
- `experiments/exp-4b/entry.mjs` (wrangler entry; CompiledWasm import → globalThis)
- `experiments/exp-4b/src/quickjs.wasm` (CompiledWasm, copied from exp-5a)
- `experiments/exp-4b/wrangler.jsonc`, `package.json`, `test-client.mjs`

## Verdict for the build

**Risk #3 is RETIRED.** A Rust workers-rs Durable Object **can** read and write a
nested QuickJS wasm instance's linear memory and exported globals, and snapshot+restore
it across a real eviction — **proven both as pure-Rust memory mechanics and as a real
QuickJS namespace under a Rust DO via JS glue.**

**Adopt path (b): Rust DO shell + JS glue for eval+dump.** The all-Rust dump is
*possible* (this spike shows it) but the all-Rust *eval driver* (QuickJS C-ABI + WASI
shim) is gratuitous cost; reuse the proven quickjs-wasi JS glue. This matches the
EXP-5a JS thesis result while confirming the host can be Rust where we want identity,
SQLite, alarms, and lifecycle in Rust. No clean-thesis regret: the only thing that
*must* stay JS is the interpreter driver, which was always going to be the engine's own
shim.
