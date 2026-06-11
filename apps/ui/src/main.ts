// Engram notebook app — seed story cells, config builder, live state indicator,
// collapsible panels, and the deployed UI→kernel E2E runner. The WS protocol
// (kernel.ts) and run/eval/config/E2E wiring are unchanged; this is the UI shell.
import "./styles.css";
import { Kernel } from "./kernel";
import type { ArtifactValue, EngramConfig, KernelReply, KernelState, MimeBundle, MimeOutput } from "./kernel";
import { SEED_CELLS } from "./seed";
import type { SeedCell } from "./seed";

const DEFAULT_ENDPOINT = "wss://engram-kernel.umg-bhalla88.workers.dev";

// --- typed DOM lookups ------------------------------------------------------
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}
const $in = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
const $sel = (id: string): HTMLSelectElement => el<HTMLSelectElement>(id);

const qs = new URLSearchParams(location.search);

const LS = {
  get k(): string | null { return localStorage.getItem("md_session"); },
  set k(v: string) { localStorage.setItem("md_session", v); },
  get ep(): string | null { return localStorage.getItem("md_endpoint"); },
  set ep(v: string) { localStorage.setItem("md_endpoint", v); },
  get key(): string { return localStorage.getItem("md_apikey") || ""; },
  set key(v: string) { localStorage.setItem("md_apikey", v || ""); },
};

function randId(): string {
  return "nb-" + Math.random().toString(36).slice(2, 10);
}
function queryEndpoint(): string {
  return qs.get("endpoint") || qs.get("kernel") || "";
}
function esc(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

// --- icons (inline, restrained) ---------------------------------------------
const ICON = {
  run: `<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5l11 7-11 7V5Z"/></svg><span class="spinner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg></span>`,
  del: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`,
  warn: `<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>`,
};

// --- kernel -----------------------------------------------------------------
const kernel = new Kernel(() => ({
  endpoint: $in("cfgEndpoint").value,
  sessionId: $in("cfgSession").value,
  apiKey: $in("cfgApiKey").value,
}));

// NOTE: no host functions are bound by default — the kernel ships a GENERIC VM->client
// host-callback bridge (a cell's `host.<name>()` round-trips to whatever the client registers
// via `kernel.setHost`). The kernel has no native RLM/agent surface. For an agent-loop example
// that binds `host.subLM` and drives a convergence loop from a cell, see /examples in the repo.

// --- state indicator --------------------------------------------------------
function setSessionPill(): void {
  el("sessionPill").textContent = "session " + ($in("cfgSession").value || "–");
}
async function refreshState(): Promise<void> {
  try {
    const g = await kernel.gen();
    const warm = !!g.inMemory;
    el("stateDot").className = "dot " + (warm ? "warm" : "cold");
    el("stateTxt").textContent = warm ? "warm" : "cold";
    el("genPill").textContent = `gen ${g.generation ?? "–"} · cell ${g.committedCell ?? 0}`;
  } catch {
    el("stateDot").className = "dot off";
    el("stateTxt").textContent = "disconnected";
    el("genPill").textContent = "gen –";
  }
  setSessionPill();
}
kernel.onState = (s: KernelState): void => {
  if (s === "disconnected") {
    el("stateDot").className = "dot off";
    el("stateTxt").textContent = "disconnected";
  }
  if (s === "connecting") {
    el("stateDot").className = "dot pending";
    el("stateTxt").textContent = "connecting…";
  }
};

// --- config -----------------------------------------------------------------
function buildConfig(): EngramConfig {
  const modulesRaw = $in("cfgModules").value.trim();
  let modules: boolean | string[] = false;
  if (modulesRaw === "true") modules = true;
  else if (modulesRaw && modulesRaw !== "false")
    modules = modulesRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const fetchRaw = $in("cfgFetch").value.trim();
  let fetch: boolean | string[] = false;
  if (fetchRaw === "true") fetch = true;
  else if (fetchRaw && fetchRaw !== "false")
    fetch = fetchRaw.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    clock: $sel("cfgClock").value === "real" ? "real" : "seeded",
    rngSeed: Number($in("cfgSeed").value) || 0,
    modules,
    fetch,
  };
}

// --- cells ------------------------------------------------------------------
interface CellEl extends HTMLDivElement {
  _run: () => Promise<void>;
  _ta: HTMLTextAreaElement;
  _kind: "story" | "advanced";
}

let cellSeq = 0;
function addCell(seed?: SeedCell): CellEl {
  const id = ++cellSeq;
  const kind = seed?.kind ?? "story";
  const title = seed?.title ?? `Cell ${id}`;
  const div = document.createElement("div") as CellEl;
  div.className = "cell kind-" + kind;
  div._kind = kind;

  const noteHtml = seed?.note
    ? `<div class="cell-note">${ICON.warn}<span>${esc(seed.note)}</span></div>`
    : "";

  div.innerHTML = `
    <div class="cell-head">
      <span class="cell-status" aria-hidden="true"></span>
      <span class="cell-title">${esc(title)}</span>
      ${kind === "advanced" ? '<span class="cell-tag">example</span>' : ""}
      <span class="cell-grow"></span>
      <div class="cell-actions">
        <button class="icon-btn run" data-run title="Run cell (⇧⏎)" aria-label="Run cell">${ICON.run}</button>
        <button class="icon-btn del" data-del title="Delete cell" aria-label="Delete cell">${ICON.del}</button>
      </div>
    </div>
    ${noteHtml}
    <textarea spellcheck="false" placeholder="// TypeScript — runs against the durable namespace (⇧⏎ to run)"></textarea>
    <div class="out"></div>
    <div class="meta" hidden></div>`;

  const ta = div.querySelector("textarea") as HTMLTextAreaElement;
  ta.value = seed?.code ?? "";
  const out = div.querySelector(".out") as HTMLDivElement;
  const meta = div.querySelector(".meta") as HTMLDivElement;

  const autosize = (): void => {
    ta.style.height = "auto";
    ta.style.height = Math.max(52, ta.scrollHeight) + "px";
  };
  ta.addEventListener("input", autosize);
  ta.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run();
    }
  });
  (div.querySelector("[data-run]") as HTMLButtonElement).onclick = () => void run();
  (div.querySelector("[data-del]") as HTMLButtonElement).onclick = () => {
    div.style.opacity = "0";
    div.style.transform = "translateY(-4px)";
    setTimeout(() => div.remove(), 140);
  };

  async function run(): Promise<void> {
    div.classList.remove("state-ok", "state-error");
    div.classList.add("running");
    out.innerHTML = `<span class="running-line"><span class="spin-inline"></span>evaluating…</span>`;
    const t0 = performance.now();
    try {
      const r = await kernel.eval(ta.value);
      await renderRichResult(out, r);
      div.classList.add(r.ok === false ? "state-error" : "state-ok");
      renderMeta(meta, r, Math.round(performance.now() - t0));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.innerHTML = `<div class="err"><span class="lead">✖ </span>${esc(msg)}</div>`;
      div.classList.add("state-error");
      meta.hidden = true;
    } finally {
      div.classList.remove("running");
      void refreshState();
    }
  }

  div._run = run;
  div._ta = ta;
  el("cells").appendChild(div);
  requestAnimationFrame(autosize);
  return div;
}

function renderResult(out: HTMLElement, r: KernelReply): void {
  let html = "";
  for (const l of r.logs || []) {
    const txt = typeof l === "string" ? l : l.text ?? l.msg ?? "";
    html += `<div class="log"><span class="lead">› </span>${esc(txt)}</div>`;
  }
  if (r.ok === false && r.error) {
    html += `<div class="err"><span class="lead">✖ </span>${esc(r.error.name || "Error")}: ${esc(r.error.message || "")}</div>`;
    if (r.error.stack) html += `<div class="err-stack">${esc(r.error.stack)}</div>`;
  } else {
    const v = r.valuePreview != null ? r.valuePreview : r.value;
    if (v !== null && v !== undefined && v !== "") {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      html += `<div class="val"><span class="lead">⇒ </span>${esc(text)}</div>`;
    } else if (!(r.logs && r.logs.length)) {
      html += `<div class="log"><span class="lead">⇒ </span><i>undefined</i></div>`;
    }
  }
  if (r.final && r.final.kind)
    html += `<div class="final">★ FINAL [${esc(r.final.kind)}]: ${esc(String(r.final.value))}</div>`;
  out.innerHTML = html;
}

async function renderRichResult(out: HTMLElement, r: KernelReply): Promise<void> {
  if (!Array.isArray(r.outputs) || r.outputs.length === 0) {
    renderResult(out, r);
    return;
  }
  let html = "";
  for (const l of r.logs || []) {
    const txt = typeof l === "string" ? l : l.text ?? l.msg ?? "";
    html += '<div class="log"><span class="lead">› </span>' + esc(txt) + '</div>';
  }
  if (r.ok === false && r.error) {
    html += '<div class="err"><span class="lead">✖ </span>' + esc(r.error.name || "Error") + ": " + esc(r.error.message || "") + "</div>";
    if (r.error.stack) html += '<div class="err-stack">' + esc(r.error.stack) + "</div>";
  }
  for (const output of r.outputs) {
    html += await renderMimeOutput(output);
  }
  if (r.final && r.final.kind) {
    html += '<div class="final">★ FINAL [' + esc(r.final.kind) + "]: " + esc(String(r.final.value)) + "</div>";
  }
  out.innerHTML = html;
}

async function renderMimeOutput(output: MimeOutput): Promise<string> {
  if (output.output_type === "clear_output") return "";
  if (output.output_type === "stream") return '<div class="log"><span class="lead">› </span>' + esc(String(output.text || "")) + "</div>";
  if (output.output_type === "error") return '<div class="err"><span class="lead">✖ </span>' + esc(String(output.text || "error")) + "</div>";
  if (!output.data) return "";
  const rendered = await renderMimeBundle(output.data);
  const cls = output.output_type === "execute_result" ? "mime-result" : "mime-display";
  return '<div class="' + cls + '">' + rendered + "</div>";
}

async function renderMimeBundle(bundle: MimeBundle): Promise<string> {
  const html = bundle["text/html"];
  if (html !== undefined) return '<iframe class="mime-html" sandbox="" srcdoc="' + escAttr(await mimeText(html)) + '"></iframe>';
  const svg = bundle["image/svg+xml"];
  if (svg !== undefined) return '<iframe class="mime-svg" sandbox="" srcdoc="' + escAttr(await mimeText(svg)) + '"></iframe>';
  const png = bundle["image/png"];
  if (png !== undefined) return '<img class="mime-image" alt="" src="data:image/png;base64,' + escAttr(await mimeText(png)) + '">';
  const jpeg = bundle["image/jpeg"] || bundle["image/jpg"];
  if (jpeg !== undefined) return '<img class="mime-image" alt="" src="data:image/jpeg;base64,' + escAttr(await mimeText(jpeg)) + '">';
  const md = bundle["text/markdown"];
  if (md !== undefined) return '<div class="mime-markdown">' + renderMarkdownText(await mimeText(md)) + "</div>";
  const json = bundle["application/json"];
  if (json !== undefined) return '<pre class="mime-json">' + esc(JSON.stringify(json, null, 2)) + "</pre>";
  const text = bundle["text/plain"];
  if (text !== undefined) return '<pre class="mime-plain">' + esc(await mimeText(text)) + "</pre>";
  const firstKey = Object.keys(bundle)[0];
  return firstKey ? '<pre class="mime-plain">' + esc(firstKey + "\\n" + JSON.stringify(bundle[firstKey], null, 2)) + "</pre>" : "";
}

async function mimeText(value: unknown): Promise<string> {
  if (isArtifact(value)) return kernel.readArtifact(value, 120000);
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function isArtifact(value: unknown): value is ArtifactValue {
  return !!value && typeof value === "object" && (value as ArtifactValue).kind === "artifact" && typeof (value as ArtifactValue).handle === "string";
}

function renderMarkdownText(text: string): string {
  const escaped = esc(text);
  return escaped
    .replace(/^### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^## (.*)$/gm, "<h3>$1</h3>")
    .replace(/^# (.*)$/gm, "<h2>$1</h2>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function escAttr(s: string): string {
  return esc(s).replace(/'/g, "&#39;");
}

function renderMeta(meta: HTMLElement, r: KernelReply, ms: number): void {
  const restored = r.inMemoryBefore === false;
  const chips: string[] = [];
  chips.push(`<span class="chip">cell ${r.cell ?? 0}</span>`);
  chips.push(`<span class="chip">gen ${r.generation ?? "–"}</span>`);
  chips.push(`<span class="chip">${ms}ms</span>`);
  chips.push(
    restored
      ? `<span class="chip cold">cold · ${esc(r.restoreSource || "snapshot")}</span>`
      : `<span class="chip warm">warm</span>`,
  );
  if (r.checkpoint && r.checkpoint.sizeGz)
    chips.push(`<span class="chip">snap ${(r.checkpoint.sizeGz / 1024).toFixed(1)}KB gz</span>`);
  meta.innerHTML = chips.join("");
  meta.hidden = false;
}

// --- collapsible panels -----------------------------------------------------
function wirePanel(headId: string, bodyId: string): void {
  const head = el<HTMLButtonElement>(headId);
  const body = el(bodyId);
  head.addEventListener("click", () => {
    const open = head.getAttribute("aria-expanded") === "true";
    head.setAttribute("aria-expanded", String(!open));
    body.hidden = open;
  });
}

// --- deployed system E2E ----------------------------------------------------
function e2eLine(cls: string, s: string): string {
  return '<div class="' + cls + '">' + esc(s) + "</div>";
}
function pass(name: string, detail = ""): string {
  return e2eLine("val", "PASS " + name + (detail ? " :: " + detail : ""));
}
function fail(name: string, detail = ""): string {
  return e2eLine("err", "FAIL " + name + (detail ? " :: " + detail : ""));
}

interface E2eResult {
  ok: boolean;
  session: string;
  endpoint: string;
  details?: string[];
  error?: string;
}

async function runDeployedE2e(): Promise<E2eResult> {
  const out = el("e2eOut");
  const badge = el("e2eBadge");
  out.dataset.status = "running";
  badge.dataset.status = "running";
  badge.textContent = "running";
  out.innerHTML = e2eLine("log", "running deployed UI → kernel E2E…");
  const oldSession = $in("cfgSession").value;
  const testSession = "ui-e2e-" + Date.now().toString(36);
  const lines: string[] = [];
  try {
    persistConn();
    $in("cfgSession").value = testSession;
    LS.k = testSession;
    kernel.close();
    kernel.setConfig({ clock: "seeded", rngSeed: 777, modules: true, fetch: true, cellBudgetTicks: 200000 });

    const setup = await kernel.eval("let x: number = 42; const inc = (): number => ++x; x");
    const setupOk = setup.ok !== false && setup.value === 42;
    lines.push(setupOk
      ? pass("typescript eval writes durable state", "value=" + setup.value)
      : fail("typescript eval writes durable state", JSON.stringify(setup)));

    await kernel.evict();
    const cold = await kernel.gen();
    const coldOk = cold.ok !== false && cold.inMemory === false;
    lines.push(coldOk
      ? pass("hibernate drops in-memory kernel", "inMemory=" + cold.inMemory)
      : fail("hibernate drops in-memory kernel", JSON.stringify(cold)));

    const restored = await kernel.eval("x");
    const restoredOk = restored.ok !== false && restored.value === 42 && /restore/.test(restored.restoreSource || "");
    lines.push(restoredOk
      ? pass("cold restore keeps heap state", "value=" + restored.value + " source=" + restored.restoreSource)
      : fail("cold restore keeps heap state", JSON.stringify(restored)));

    const closure = await kernel.eval("inc()");
    const closureOk = closure.ok !== false && closure.value === 43;
    lines.push(closureOk
      ? pass("closure survives restore", "value=" + closure.value)
      : fail("closure survives restore", JSON.stringify(closure)));

    const ts = await kernel.eval("const greet = <T,>(v: T): string => `hi ${v}`; greet(x)");
    const tsOk = ts.ok !== false && ts.value === "hi 43";
    lines.push(tsOk
      ? pass("typescript generics + annotations", "value=" + JSON.stringify(ts.value))
      : fail("typescript generics + annotations", JSON.stringify(ts).slice(0, 400)));

    const enumRej = await kernel.eval("enum Color { Red }");
    const enumRejOk = enumRej.ok === false && enumRej.error?.name === "TypeScriptError";
    lines.push(enumRejOk
      ? pass("un-erasable TS rejected cleanly", enumRej.error?.name || "")
      : fail("un-erasable TS rejected cleanly", JSON.stringify(enumRej).slice(0, 400)));

    const recover = await kernel.eval("x + 1");
    const recoverOk = recover.ok !== false && recover.value === 44;
    lines.push(recoverOk
      ? pass("session recovers after TS error", "value=" + recover.value)
      : fail("session recovers after TS error", JSON.stringify(recover)));

    const ok = lines.every((s) => !s.includes(">FAIL "));
    out.dataset.status = ok ? "pass" : "fail";
    badge.dataset.status = ok ? "pass" : "fail";
    badge.textContent = ok ? "pass" : "fail";
    out.innerHTML = lines.join("") + e2eLine(ok ? "final" : "err", ok ? "✓ E2E PASS — 7/7" : "✗ E2E FAIL");
    return { ok, session: testSession, endpoint: $in("cfgEndpoint").value, details: lines.map((l) => l.replace(/<[^>]+>/g, "")) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out.dataset.status = "fail";
    badge.dataset.status = "fail";
    badge.textContent = "fail";
    out.innerHTML = lines.join("") + fail("E2E exception", msg);
    return { ok: false, session: testSession, endpoint: $in("cfgEndpoint").value, error: msg };
  } finally {
    $in("cfgSession").value = oldSession || testSession;
    LS.k = $in("cfgSession").value;
    void refreshState();
  }
}

// --- wiring -----------------------------------------------------------------
function ensureSession(): void {
  if (!$in("cfgSession").value) $in("cfgSession").value = LS.k || randId();
  LS.k = $in("cfgSession").value;
}
const persistConn = (): void => {
  LS.ep = $in("cfgEndpoint").value;
  LS.key = $in("cfgApiKey").value.trim();
};

wirePanel("connHead", "connBody");
wirePanel("cfgHead", "cfgBody");
wirePanel("e2eHead", "e2eBody");

el<HTMLButtonElement>("addCell").onclick = () => {
  const c = addCell();
  c._ta.focus();
};
el<HTMLButtonElement>("runAll").onclick = async () => {
  for (const child of Array.from(el("cells").children)) {
    const cell = child as CellEl;
    if (cell._kind === "advanced") continue; // advanced examples need config; skip in Run all
    await cell._run();
  }
};
el<HTMLButtonElement>("newSession").onclick = () => {
  $in("cfgSession").value = randId();
  LS.k = $in("cfgSession").value;
  kernel.close();
  void refreshState();
};
el<HTMLButtonElement>("reconnect").onclick = async () => {
  persistConn();
  kernel.close();
  kernel.setConfig(buildConfig());
  await kernel.open();
  void refreshState();
};
el<HTMLButtonElement>("hibernate").onclick = async () => {
  await kernel.evict();
  void refreshState();
};
el<HTMLButtonElement>("resetSession").onclick = async () => {
  await kernel.reset();
  void refreshState();
};
el<HTMLButtonElement>("runE2e").onclick = () => void runDeployedE2e();
el<HTMLButtonElement>("applyConfig").onclick = async () => {
  persistConn();
  $in("cfgSession").value = randId();
  LS.k = $in("cfgSession").value;
  kernel.close();
  kernel.setConfig(buildConfig());
  await kernel.open();
  await kernel.eval("1");
  void refreshState();
};

// boot — URL params win, then persisted connection, then the deployed default.
const epFromQuery = queryEndpoint();
$in("cfgEndpoint").value = epFromQuery || LS.ep || DEFAULT_ENDPOINT;
if (qs.get("apiKey")) $in("cfgApiKey").value = qs.get("apiKey") as string;
else if (LS.key) $in("cfgApiKey").value = LS.key;
if (qs.get("session")) $in("cfgSession").value = qs.get("session") as string;

ensureSession();
setSessionPill();
kernel.setConfig(buildConfig());

for (const seed of SEED_CELLS) addCell(seed);

kernel.open().then(refreshState, refreshState);

declare global {
  interface Window {
    __ENGRAM_E2E__: () => Promise<E2eResult>;
  }
}
window.__ENGRAM_E2E__ = runDeployedE2e;
if (qs.get("e2e") === "1") {
  el<HTMLButtonElement>("e2eHead").click();
  setTimeout(() => void runDeployedE2e(), 250);
}
setInterval(() => void refreshState(), 15000);
