#!/usr/bin/env bun
// Engram monorepo deploy driver.
//
//   bun scripts/deploy.ts            -> deploy kernel, cloud, ui (in order)
//   bun scripts/deploy.ts kernel     -> deploy only the kernel
//   bun scripts/deploy.ts cloud ui   -> deploy a subset, in the given order
//
// Each app is deployed via `wrangler deploy -c apps/<app>/wrangler.jsonc`.

import { spawnSync } from "node:child_process";

const APPS = {
  kernel: "apps/kernel/wrangler.jsonc",
  cloud: "apps/cloud/wrangler.jsonc",
  ui: "apps/ui/wrangler.jsonc",
} as const;

type AppName = keyof typeof APPS;

const requested = process.argv.slice(2) as string[];
const order: AppName[] = ["kernel", "cloud", "ui"];

const targets: AppName[] =
  requested.length === 0
    ? order
    : requested.map((a) => {
        if (!(a in APPS)) {
          console.error(`unknown app "${a}" (valid: ${Object.keys(APPS).join(", ")})`);
          process.exit(2);
        }
        return a as AppName;
      });

let failed = 0;
for (const app of targets) {
  const config = APPS[app];
  console.log(`\n=== deploy ${app}  (wrangler deploy -c ${config}) ===`);
  const res = spawnSync("wrangler", ["deploy", "-c", config], {
    stdio: "inherit",
    encoding: "utf8",
  });
  const code = res.status ?? 1;
  if (code === 0) {
    console.log(`--- ${app}: OK`);
  } else {
    failed++;
    console.error(`--- ${app}: FAILED (exit ${code})`);
  }
}

console.log(`\n${targets.length - failed}/${targets.length} app(s) deployed.`);
process.exit(failed === 0 ? 0 : 1);
