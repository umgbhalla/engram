#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const args = parseArgs(process.argv.slice(2));
const root = new URL("../", import.meta.url);
const kernelDir = fileURLToPath(new URL("../apps/kernel/", import.meta.url));
const configPath = "wrangler.jsonc";
const workerName = String(args.name || "engram-kernel");
const localWrangler = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
const hasLocalWrangler = existsSync(localWrangler);
const wranglerCommand = String(process.env.WRANGLER_BIN || (hasLocalWrangler ? localWrangler : "bunx"));
const wranglerPrefix = process.env.WRANGLER_BIN || hasLocalWrangler ? [] : ["wrangler"];
const dryRun = Boolean(args.dryRun);
const stopAfterSmoke = Boolean(args.stopAfterSmoke);
const rollout = String(args.rollout || "1,5,25,50,100")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
const tag = String(args.tag || gitSha());
const message = String(args.message || `kernel ${tag}`);
const manifest = JSON.parse(readFileSync(new URL("config/deployed-endpoints.json", root), "utf8"));
const endpoint = String(args.endpoint || process.env.ENGRAM_KERNEL_WS || manifest.public.kernel.defaultWs);
const kernelKey = process.env.ENGRAM_KERNEL_KEY || process.env.ENGRAM_API_KEY || "";

if (!rollout.length || rollout[rollout.length - 1] !== 100) {
  fail("rollout must contain one or more percentages and end at 100");
}
if (!dryRun && !args.allowDirty && gitDirty()) {
  fail("worktree is dirty; commit first or pass --allow-dirty with an explicit --tag");
}

console.log("[deploy-versioned] worker=" + workerName + " tag=" + tag + " dryRun=" + dryRun);

const deployments = deploymentsList();
const current = currentDeployment(deployments);
const oldVersion = currentVersion(current);
if (!oldVersion) fail("could not determine current 100% Worker version from deployments list");
console.log("[deploy-versioned] current=" + oldVersion);
const versionsBeforeUpload = versionsList();
const versionIdsBeforeUpload = new Set(versionsBeforeUpload.map(versionIdOf).filter(Boolean));

if (dryRun) {
  runWrangler(["versions", "upload", "-c", configPath, "--tag", tag, "--message", message, "--dry-run"], { stdio: "inherit" });
  console.log("[deploy-versioned] dry run rollout plan: " + rollout.map((p) => `${oldVersion}@${100 - p} ${tag}@${p}`).join(" -> "));
  process.exit(0);
}

const upload = runWrangler(["versions", "upload", "-c", configPath, "--tag", tag, "--message", message], { capture: true });
const newVersion =
  parseUploadedVersionId(upload.stdout) ||
  newestVersionNotIn(versionIdsBeforeUpload) ||
  latestVersionByTag(tag);
if (!newVersion) {
  if (/migration/i.test(upload.stdout + upload.stderr)) {
    fail("version upload failed because this change includes a Durable Object migration; run an explicit migration deploy instead");
  }
  fail("could not determine uploaded Worker version id");
}
console.log("[deploy-versioned] uploaded=" + newVersion);

deploySplit([
  { id: newVersion, pct: 0 },
  { id: oldVersion, pct: 100 },
], "stage new version at 0%");

smokeVersion(newVersion);
if (stopAfterSmoke) {
  console.log("[deploy-versioned] stopped after 0% smoke; new version remains in active deployment at 0%");
  process.exit(0);
}

for (const pct of rollout) {
  const split = pct >= 100
    ? [{ id: newVersion, pct: 100 }]
    : [{ id: newVersion, pct }, { id: oldVersion, pct: 100 - pct }];
  deploySplit(split, `rollout ${pct}%`);
  smokeVersion(newVersion);
}

console.log("[deploy-versioned] complete newVersion=" + newVersion + " previous=" + oldVersion);

function deploySplit(split, label) {
  const specs = split.filter((s) => s.pct > 0 || split.length > 1).map((s) => `${s.id}@${s.pct}`);
  console.log("[deploy-versioned] " + label + " :: " + specs.join(" "));
  runWrangler(["versions", "deploy", "-c", configPath, ...specs, "--message", message, "--yes"], { stdio: "inherit" });
}

async function smokeVersion(versionId) {
  const session = "deploy-smoke-" + Date.now().toString(36);
  const headers = {
    "Cloudflare-Workers-Version-Overrides": `${workerName}="${versionId}"`,
    "Cloudflare-Workers-Version-Key": session,
  };
  if (kernelKey) headers.Authorization = "Bearer " + kernelKey;
  const url = endpoint.replace(/\/+$/, "") + "/ws?id=" + encodeURIComponent(session);
  const reply = await wsRpc(url, headers, { t: "ping" });
  if (reply?.ok !== true) fail("smoke ping failed: " + JSON.stringify(reply).slice(0, 300));
  if (reply.versionId !== versionId) {
    fail("version override did not hit target; expected " + versionId + " got " + (reply.versionId || "<empty>"));
  }
  console.log("[deploy-versioned] smoke ok versionId=" + reply.versionId);
}

function wsRpc(url, headers, frame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("smoke websocket timeout"));
    }, 20_000);
    ws.once("open", () => ws.send(JSON.stringify(frame)));
    ws.once("message", (data) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      try {
        resolve(JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)));
      } catch (error) {
        reject(error);
      }
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function deploymentsList() {
  const out = runWrangler(["deployments", "list", "-c", configPath, "--json"], { capture: true });
  try {
    return JSON.parse(out.stdout);
  } catch (error) {
    fail("failed to parse deployments list JSON: " + String(error));
  }
}

function currentDeployment(value) {
  if (Array.isArray(value)) return newestByCreated(value);
  if (Array.isArray(value?.deployments)) return newestByCreated(value.deployments);
  if (value?.deployment) return value.deployment;
  return value;
}

function currentVersion(deployment) {
  const versions = extractVersions(deployment);
  const full = versions.find((v) => percentageOf(v) === 100) || versions.sort((a, b) => percentageOf(b) - percentageOf(a))[0];
  return versionIdOf(full);
}

function extractVersions(deployment) {
  if (!deployment) return [];
  if (Array.isArray(deployment.versions)) return deployment.versions;
  if (Array.isArray(deployment.strategy?.versions)) return deployment.strategy.versions;
  if (Array.isArray(deployment.resources?.versions)) return deployment.resources.versions;
  return [];
}

function percentageOf(v) {
  return Number(v?.percentage ?? v?.percent ?? v?.traffic ?? v?.weight ?? 0);
}

function versionIdOf(v) {
  return v?.version_id || v?.versionId || v?.id || v?.tag || "";
}

function versionsList() {
  const out = runWrangler(["versions", "list", "-c", configPath, "--json"], { capture: true });
  try {
    const versions = JSON.parse(out.stdout);
    return Array.isArray(versions) ? versions : versions?.versions || [];
  } catch {
    return [];
  }
}

function latestVersionByTag(wantedTag) {
  const list = versionsList();
  const found = newestByCreated(list.filter((v) => v?.tag === wantedTag || v?.version_tag === wantedTag)) || newestByCreated(list);
  return versionIdOf(found);
}

function newestVersionNotIn(beforeIds) {
  const list = versionsList().filter((v) => !beforeIds.has(versionIdOf(v)));
  return versionIdOf(newestByCreated(list));
}

function parseUploadedVersionId(text) {
  const match = String(text || "").match(/(?:uploaded|created|version(?: id)?)[^0-9a-f]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : "";
}

function newestByCreated(items) {
  return [...(items || [])].sort((a, b) => {
    const byNumber = Number(b?.number ?? 0) - Number(a?.number ?? 0);
    if (byNumber !== 0) return byNumber;
    return Date.parse(b?.created_on || b?.metadata?.created_on || 0) - Date.parse(a?.created_on || a?.metadata?.created_on || 0);
  })[0];
}

function gitSha() {
  const res = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : String(Date.now());
}

function gitDirty() {
  const res = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return res.status === 0 && res.stdout.trim().length > 0;
}

function runWrangler(cmdArgs, opts = {}) {
  return run(wranglerCommand, [...wranglerPrefix, ...cmdArgs], opts);
}

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd || kernelDir,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : opts.stdio || "inherit",
  });
  if (res.status !== 0) {
    const output = [res.stdout, res.stderr].filter(Boolean).join("\n");
    if (/Durable Object migrations/i.test(output)) {
      fail("version upload cannot carry Durable Object migrations; use the explicit migration deploy path");
    }
    fail(cmd + " " + cmdArgs.join(" ") + " failed with exit " + (res.status ?? 1) + (output ? "\n" + output : ""));
  }
  return { stdout: res.stdout || "", stderr: res.stderr || "" };
}

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (raw === "--dry-run") out.dryRun = true;
    else if (raw === "--stop-after-smoke") out.stopAfterSmoke = true;
    else if (raw.startsWith("--")) {
      const eq = raw.indexOf("=");
      const key = raw.slice(2, eq < 0 ? undefined : eq).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = eq < 0 ? true : raw.slice(eq + 1);
    }
  }
  return out;
}

function fail(message) {
  console.error("[deploy-versioned] " + message);
  process.exit(1);
}
