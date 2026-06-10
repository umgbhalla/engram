#!/usr/bin/env node

import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const manifestUrl = new URL("config/deployed-endpoints.json", root);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
const publicEndpoints = manifest.public || {};

const failures = [];

function requireString(path, value) {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`manifest ${path} must be a non-empty string`);
  }
}

function fileText(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function expectContains(path, needle, label = needle) {
  if (!fileText(path).includes(needle)) {
    failures.push(`${path} is missing ${label}`);
  }
}

requireString("public.kernel.defaultWs", publicEndpoints.kernel?.defaultWs);
requireString("public.kernel.workersDevHttp", publicEndpoints.kernel?.workersDevHttp);
requireString("public.cloud.http", publicEndpoints.cloud?.http);
requireString("public.ui.http", publicEndpoints.ui?.http);
requireString("public.docs.http", publicEndpoints.docs?.http);
requireString("resources.r2Snapshots", manifest.resources?.r2Snapshots);
requireString("resources.analyticsEngine", manifest.resources?.analyticsEngine);

const kernelWs = publicEndpoints.kernel?.defaultWs;
const kernelHttp = publicEndpoints.kernel?.workersDevHttp;
const uiHttp = publicEndpoints.ui?.http;
const docsHttp = publicEndpoints.docs?.http;

expectContains("scripts/smoke-live.mjs", "deployed-endpoints.json", "endpoint manifest loader");
expectContains("scripts/e2e-ui.ts", "deployed-endpoints.json", "endpoint manifest loader");
expectContains("apps/ui/src/main.ts", kernelWs, "kernel default WebSocket");
expectContains("apps/ui/index.html", kernelWs, "kernel default WebSocket");
expectContains("packages/cli/src/engram.ts", kernelWs, "CLI default WebSocket");
expectContains("packages/cli/src/repl.ts", kernelWs, "REPL resume default WebSocket");
expectContains("README.md", kernelWs, "README kernel WebSocket");
expectContains("README.md", uiHttp, "README UI URL");
expectContains("apps/docs/src/content/docs/reference/protocol.md", kernelWs, "protocol docs kernel WebSocket");
expectContains("apps/docs/src/content/docs/using/quick-start.md", kernelWs, "quick-start kernel WebSocket");
expectContains("apps/docs/src/content/docs/using/ui.md", uiHttp, "UI docs URL");
expectContains("apps/docs/src/content/docs/reference/deployed.md", uiHttp, "deployed docs UI URL");
expectContains("apps/docs/src/content/docs/index.mdx", uiHttp, "docs index UI URL");
expectContains("apps/docs/astro.config.mjs", uiHttp, "docs live demo URL");
expectContains("apps/docs/src/components/TopLinks.astro", uiHttp, "docs top link URL");
expectContains("apps/kernel/wrangler.jsonc", '"engram-kernel"', "kernel worker name");
expectContains("apps/docs/wrangler.jsonc", '"engram-docs"', "docs worker name");
expectContains("apps/ui/wrangler.jsonc", '"engram-ui"', "UI worker name");

if (kernelHttp && kernelWs && !kernelWs.startsWith("wss://")) {
  failures.push("public.kernel.defaultWs must be a wss:// URL");
}
if (kernelHttp && !kernelHttp.startsWith("https://")) {
  failures.push("public.kernel.workersDevHttp must be an https:// URL");
}
if (docsHttp && !docsHttp.startsWith("https://")) {
  failures.push("public.docs.http must be an https:// URL");
}

if (failures.length) {
  for (const failure of failures) console.error("FAIL", failure);
  console.error(`\n${failures.length} deployed endpoint check(s) failed`);
  process.exit(1);
}

console.log("PASS deployed endpoint manifest is internally consistent with current defaults/docs");
