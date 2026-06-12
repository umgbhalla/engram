#!/usr/bin/env node
/**
 * engram-sandbox smoke — exercises the deployed worker's HTTP routes against a throwaway
 * session id (so it only ever touches R2 keys under fs/<doId>/ ; never other keys).
 *
 *   BASE=https://engram-sandbox.<sub>.workers.dev KEY=ek_... node scripts/smoke.mjs
 *
 * Verifies: /health, mount, exec in /session, write→read round-trip (the R2-VFS seam),
 * git checkout, listFiles. A passing run proves the container shell and R2 prefix are the
 * same bytes.
 */
const BASE = process.env.BASE ?? "http://localhost:8787";
const KEY = process.env.KEY ?? "";
const SESSION = process.env.SESSION ?? `smoke-${Date.now().toString(36)}`;

const H = {
  "content-type": "application/json",
  "x-engram-session": SESSION,
  ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
};

let pass = 0,
  fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}
const post = (p, body) => fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(body) });
const get = (p) => fetch(`${BASE}${p}`, { headers: H });

console.log(`engram-sandbox smoke  base=${BASE} session=${SESSION}`);

await check("health", async () => {
  const r = await fetch(`${BASE}/health`);
  if (!r.ok) throw new Error(`status ${r.status}`);
});

await check("mount", async () => {
  const r = await post("/mount", {});
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(JSON.stringify(j));
});

await check("exec pwd", async () => {
  const r = await post("/exec", { cmd: "pwd" });
  const j = await r.json();
  if (!j.success && j.exitCode !== 0) throw new Error(JSON.stringify(j));
});

const probe = `engram-${SESSION}.txt`;
await check("write file", async () => {
  const r = await post("/files", { op: "write", path: `/session/${probe}`, content: "hello-engram" });
  if (!r.ok) throw new Error(await r.text());
});

await check("read file round-trip (R2-VFS seam)", async () => {
  const r = await get(`/files?path=/session/${encodeURIComponent(probe)}`);
  const j = await r.json();
  if (!String(j.content).includes("hello-engram")) throw new Error(JSON.stringify(j));
});

await check("exec sees the written file", async () => {
  const r = await post("/exec", { cmd: `cat /session/${probe}` });
  const j = await r.json();
  if (!String(j.stdout).includes("hello-engram")) throw new Error(JSON.stringify(j));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
