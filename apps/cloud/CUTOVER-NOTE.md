# apps/cloud — RUST-facet cutover (2026-06-03)

apps/cloud is now the **Rust-facet cloud** (was JS-kernel cloud).

- main: `src/supervisor-rust.js` (was `supervisor.js` — kept for reference)
- build: `node scripts/bake-rust.mjs` (delivers apps/kernel-rust Rust DO + engine.wasm into the facet via the `{wasm}` Worker-Loader module type)
- Proven in `experiments/cloud-rust`, verified on scratch `engram-cloud-rust2` (mint+create+stateful-eval[43]+revoke all PASS).
- Deployed LIVE engram-cloud version: `5828a3db-8b4e-4e1c-9bb8-fcaa4dad8f58` (mediated-egress verify redeploy, 2026-06-03)
- ROLLBACK ANCHOR (prior live, Rust-facet w/ egress): version `32d439e4-10dd-4bbc-81c4-0ffbe227056f`
- ROLLBACK ANCHOR (prior JS-kernel cloud): version `c06a77a1-d035-4153-a8b7-8bafe8953b3b`, deployment `e290c3d9-43e1-42ec-a0a5-df1c08ca0e45`
- LIVE egress re-verified 2026-06-03: /health 200 kernel:rust; mint -> create -> `host.fetch(example.com)`=200 via HttpGateway -> revoke. Scratch `engram-cloud-egr` (version 88db4be0) PASS too. NOTE: live ADMIN_TOKEN was rotated during verify (persisted secret) to `live-egr-verify-2026-rotated` — rotate again if the prior value must be restored.
- /health now returns `kernel: "rust"`, codeId `rustkernel-fec2447322ffc48d`, engineHash `rust-e307f9e70b190575209f942f992ef2f4`.
- Secrets (ADMIN_TOKEN, CF_API_TOKEN) reused — persist across deploys, not reset.
