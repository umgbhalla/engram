/**
 * engram-kernel — infrastructure-as-code via Alchemy v2 (alternative to wrangler.jsonc).
 *
 * Mirrors apps/kernel/wrangler.jsonc 1:1 — same worker name, bindings, DO migration, R2
 * overflow bucket, Analytics Engine dataset, compat date + flags — so it ADOPTS the existing
 * `engram-kernel` deployment rather than forking it (`adopt: true`).
 *
 * The kernel is a Rust/worker-build worker: `entry.ts` re-exports the worker-build output
 * (build/worker/shim.mjs -> build/index.js) and pulls in the precompiled rquickjs `engine.wasm`
 * (CompiledWasm) + `stdlib.bundle.txt` (Text). Those artifacts must exist BEFORE `alchemy deploy`:
 * run the worker-build pipeline first via `npm run build:worker` (the `deploy:alchemy` script
 * chains it). Alchemy's esbuild bundles entry.ts; its built-in wasm plugin emits the `.wasm`
 * imports as CompiledWasm modules, and the `.txt` loader below maps stdlib.bundle.txt to Text —
 * the same handling wrangler does via its `rules`.
 *
 * Deploy:   bun run deploy:alchemy        (build:worker + alchemy deploy)
 * Dev:      bun run dev:alchemy
 * Destroy:  bun run destroy:alchemy
 *
 * Secrets: ALCHEMY_PASSWORD encrypts the state file; CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
 * authenticate the deploy (or `alchemy login`).
 *
 * STATUS: authored to match the wrangler config exactly; verify a first cutover with
 * `alchemy deploy` against a non-prod account/name before retiring `wrangler deploy`.
 */
import alchemy from "alchemy";
import { AnalyticsEngineDataset, DurableObjectNamespace, R2Bucket, Worker } from "alchemy/cloudflare";
import { R2RestStateStore } from "alchemy/state";

const app = await alchemy("engram-kernel", {
  // Encrypts secrets in the Alchemy state file. Override in CI/prod via env.
  password: process.env.ALCHEMY_PASSWORD ?? "dev-only-password",
  // ALCHEMY_LOCAL=1 keeps every resource off the network (in-memory IaC shape).
  local: process.env.ALCHEMY_LOCAL === "1" || undefined,
  // State lives in R2 (not local .alchemy files) so the IaC state is durable + shareable.
  // Bucket must already exist (created out-of-band: `wrangler r2 bucket create engram-alchemy-state`).
  stateStore: (scope) => new R2RestStateStore(scope, { bucketName: "engram-alchemy-state", prefix: "engram-kernel/" }),
});

// ---- Durable Object ---------------------------------------------------------
// KernelDO uses ctx.storage.sql => sqlite:true emits the new_sqlite_classes migration
// (equiv to wrangler migrations [{ tag:"v1", new_sqlite_classes:["KernelDO"] }]).
const kernelDo = DurableObjectNamespace("kernel-do", {
  className: "KernelDO",
  sqlite: true,
});

// ---- R2 (snapshot overflow, gz image > ~2MB) --------------------------------
const snapshots = await R2Bucket("engram-snapshots", { adopt: true });

// ---- Analytics Engine (per-op datapoints; dataset engram_kernel) ------------
const ae = AnalyticsEngineDataset("engram-ae", { dataset: "engram_kernel" });

// ---- Worker -----------------------------------------------------------------
export const worker = await Worker("engram-kernel", {
  name: "engram-kernel",
  adopt: true,
  entrypoint: "./entry.ts",
  // workers.dev route ON (the SDK/CLI connect over wss://engram-kernel.<sub>.workers.dev).
  // Setting this false disables the subdomain route and breaks every client. Keep true.
  url: true,
  // Custom domain: SDK/CLI can also connect over wss://engram.umgbhalla.xyz. The zone lives on
  // this account; Alchemy auto-resolves it and provisions the worker custom-domain (DNS + edge cert).
  // Requires the API token to have Workers Routes + Zone DNS edit on the umgbhalla.xyz zone.
  domains: ["engram.umgbhalla.xyz"],
  compatibilityDate: "2025-05-01",
  compatibilityFlags: ["nodejs_compat"],
  observability: { enabled: true },
  bundle: {
    // entry.ts imports stdlib.bundle.txt as a Text module (string default export); map .txt
    // to esbuild's text loader. The .wasm imports (engine.wasm + the worker-build glue wasm)
    // are emitted as CompiledWasm by Alchemy's built-in wasm plugin. Repeat the JS loaders
    // because providing `loader` REPLACES esbuild's defaults.
    loader: {
      ".js": "jsx",
      ".mjs": "jsx",
      ".cjs": "jsx",
      ".txt": "text",
    },
  },
  bindings: {
    KERNEL_DO: kernelDo,
    SNAPSHOTS: snapshots,
    AE: ae,
    // AUTH (Phase 1 shared bearer key). ENGRAM_KERNEL_KEY is a comma-split list of valid keys
    // (rotation: "ek_new,ek_old"). Read in Rust via env.secret(); NEVER enters the heap snapshot.
    // NOTE: set ALCHEMY_PASSWORD in the deploy env for strong at-rest encryption of this secret in
    // the R2 state store — the default "dev-only-password" works but is WEAK (do not rely on it).
    ENGRAM_KERNEL_KEY: alchemy.secret(process.env.ENGRAM_KERNEL_KEY!),
    // FAIL-CLOSED enforce flag: persisted "1" so a deploy that forgets to export the var still
    // boots CLOSED whenever a key is configured. Only an explicit ENGRAM_AUTH_ENFORCE="0"
    // downgrades to log-only (serve + emit AE errorName=unauthorized).
    ENGRAM_AUTH_ENFORCE: process.env.ENGRAM_AUTH_ENFORCE ?? "1",
  },
});

console.log(`engram-kernel deployed via Alchemy${worker.url ? `: ${worker.url}` : ""}`);

await app.finalize();
