# apps/cloud — RUST-facet cutover (2026-06-03)

apps/cloud is now the **Rust-facet cloud** (was JS-kernel cloud).

- main: `src/supervisor-rust.js` (was `supervisor.js` — kept for reference)
- build: `node scripts/bake-rust.mjs` (delivers apps/kernel-rust Rust DO + engine.wasm into the facet via the `{wasm}` Worker-Loader module type)
- Proven in `experiments/cloud-rust`, verified on scratch `engram-cloud-rust2` (mint+create+stateful-eval[43]+revoke all PASS).
- Deployed LIVE engram-cloud version: `32d439e4-10dd-4bbc-81c4-0ffbe227056f`
- ROLLBACK ANCHOR (prior JS-kernel cloud): version `c06a77a1-d035-4153-a8b7-8bafe8953b3b`, deployment `e290c3d9-43e1-42ec-a0a5-df1c08ca0e45`
- /health now returns `kernel: "rust"`, codeId `rustkernel-fec2447322ffc48d`, engineHash `rust-e307f9e70b190575209f942f992ef2f4`.
- Secrets (ADMIN_TOKEN, CF_API_TOKEN) reused — persist across deploys, not reset.
