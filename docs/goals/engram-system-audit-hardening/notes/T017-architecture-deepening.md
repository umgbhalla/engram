# T017 Architecture Deepening Scout

## Scope

Read-only use of `improve-codebase-architecture` against current Engram source, ADRs, and audit findings. There is no `CONTEXT.md` in the repo; domain vocabulary was taken from `AGENTS.md`, `docs/decisions.md`, and current app/package names.

## Candidates

1. Deployed endpoint manifest Module

   **Files**: `apps/ui/src/main.ts`, `apps/ui/index.html`, `packages/cli/src/engram.ts`, `packages/cli/src/repl.ts`, `scripts/e2e-ui.ts`, `scripts/smoke-live.mjs`, `README.md`, `apps/docs/src/content/docs/**`, `apps/kernel/wrangler.jsonc`.

   **Problem**: The deployed endpoint Interface is shallow. Callers and docs each carry their own knowledge of workers.dev hostnames, custom-domain assumptions, environment variable names, and health behavior. The current live blocker exposed the cost: the kernel workers.dev hostname is unavailable, the configured custom domain does not resolve, and every caller had to be probed separately to establish truth.

   **Solution**: Introduce one source-of-truth deployed endpoint manifest Module for public surfaces and test defaults. Keep the deployed host values and expected probe shapes behind a small Interface, then have UI defaults, CLI defaults, smoke/E2E scripts, and current docs consume or verify against that manifest.

   **Benefits**: Higher Locality for deployed-surface changes and stronger Leverage for tests: one manifest update can drive UI, CLI, scripts, and docs. It would also make route drift visible as a manifest/probe mismatch instead of scattered failing WebSocket opens.

   **Follow-up type**: Safe Worker slice if kept to manifest + callers + no deploy; owner-decision item if changing the public endpoint itself.

2. Protocol contract Module shared by SDK, UI, scripts, and Rust tests

   **Files**: `packages/sdk/src/index.ts`, `apps/ui/src/kernel.ts`, `scripts/e2e-ui.ts`, `scripts/smoke-live.mjs`, `apps/kernel/src/lib.rs`, `apps/cloud/src/supervisor.ts`, `apps/docs/src/content/docs/reference/protocol.md`.

   **Problem**: The kernel frame Interface is implemented several times: SDK `Frame`, UI `KernelFrame`/reply handling, script-local mini clients, Rust string matches in `handle_with_ws`, cloud facet proxying, and docs. Each caller must know verbs, reply shapes, timeout behavior, hostcall demux, and which transports support callbacks. That is a shallow Module pattern: the Interface knowledge is almost as large as the Implementation.

   **Solution**: Create a protocol contract Module in TypeScript for frame/reply types plus JSON fixtures/golden examples that Rust/cloud tests can validate against. Keep Rust as the protocol authority for behavior, but make the client-facing Interface explicit and shared.

   **Benefits**: Better Leverage for every client and test harness; better Locality when adding or deprecating frame verbs. The interface becomes the test surface, reducing silent drift between UI, SDK, docs, and scripts.

   **Follow-up type**: Safe Scout/Judge next; Worker is safe if it starts with types/fixtures and no runtime dispatch changes.

3. Kernel shell responsibility split

   **Files**: `apps/kernel/src/lib.rs`, `apps/kernel/src/kernel-glue.ts`, `apps/kernel/src/repl-transform.ts`, `apps/kernel/scripts/**`.

   **Problem**: `apps/kernel/src/lib.rs` is a high-value Module but its Implementation combines routing, mutex discipline, WebSocket hibernation, hostcall demux, fs provider setup, snapshot storage, restore timing, Analytics Engine emission, and test-only verbs. The Interface to the rest of the repo is small, but the internal Locality is weak: understanding a protocol change requires scanning across unrelated durability and observability code.

   **Solution**: Split internal Rust Modules around existing domain concepts without changing the public Interface: protocol handling, durability/snapshot storage, host effects, fs provider, and observability. Keep `KernelDO` as the adapter at the Cloudflare seam.

   **Benefits**: Preserves the deep external Module while improving internal Locality. Tests can target the protocol/durability Modules more directly, and future agents can navigate by concept instead of one large shell file.

   **Follow-up type**: Needs Judge sizing before Worker because Rust/wasm build risk is higher.

4. Live verification harness as an SDK consumer

   **Files**: `scripts/smoke-live.mjs`, `scripts/e2e-ui.ts`, `packages/sdk/src/index.ts`, `tests/sdk/**`, `tests/ui/smoke.mjs`.

   **Problem**: The live smoke and UI E2E scripts each implement their own transport Adapter instead of using the SDK's already-deep `Transport`/`EngramSession` Interface. The duplicated mini clients have low Leverage and can miss SDK-specific regressions, while also creating extra timeout/open/error behavior to maintain.

   **Solution**: Move the kernel protocol portions of smoke/E2E onto `@engram/sdk` or a small shared test Adapter built on the SDK. Keep UI asset checks script-local, but let the SDK own WebSocket request/reply semantics.

   **Benefits**: More Leverage from the SDK Interface and better Locality for transport behavior. The live gate then tests the same Adapter path users actually consume, and scripts shrink to product-specific assertions.

   **Follow-up type**: Safe Worker slice after endpoint blocker clears or with endpoint override/local target.

5. SDK internal Module split behind the existing public Interface

   **Files**: `packages/sdk/src/index.ts`, `packages/sdk/src/effect.ts`, `packages/sdk/examples/**`.

   **Problem**: `packages/sdk/src/index.ts` is externally deep, but internally it holds public types, typed errors, WebSocket/HTTP transports, host modules, runtime env/bootstrap, context sugar, final-value plumbing, fleet client, and `Engram.connect`. The public Interface is good; the Implementation has low Locality for changes to one concern.

   **Solution**: Preserve the public `@engram/sdk` Interface, but split internal Modules for protocol types/errors, transports, runtime env/bootstrap, session sugar, and fleet management. Use barrel exports to keep API compatibility.

   **Benefits**: Maintains Leverage for callers while making test coverage and maintenance more local. It also makes AI navigation safer because a change to transport reconnects does not require reading durable context helpers or examples.

   **Follow-up type**: Safe only after a Judge defines a small first split and verifies generated dist/API stability.

## Recommendation

Do not start with a broad refactor. The highest-value first architecture follow-up is Candidate 1 or 2 because the current live endpoint failure proved the deployed-surface/protocol Interfaces are where operator confusion is highest, and both can be made testable without changing kernel behavior.

