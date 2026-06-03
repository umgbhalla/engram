// Engram notebook app — cells, config builder, state indicator, deployed E2E runner.
import "./styles.css";
import { Kernel } from "./kernel";
import type { EngramConfig, KernelReply, KernelState } from "./kernel";

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
  get k(): string | null {
    return localStorage.getItem("md_session");
  },
  set k(v: string) {
    localStorage.setItem("md_session", v);
  },
  get ep(): string | null {
    return localStorage.getItem("md_endpoint");
  },
  set ep(v: string) {
    localStorage.setItem("md_endpoint", v);
  },
  get key(): string {
    return localStorage.getItem("md_apikey") || "";
  },
  set key(v: string) {
    localStorage.setItem("md_apikey", v || "");
  },
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

// --- kernel -----------------------------------------------------------------
const kernel = new Kernel(() => ({
  endpoint: $in("cfgEndpoint").value,
  sessionId: $in("cfgSession").value,
  apiKey: $in("cfgApiKey").value,
}));

// --- state indicator --------------------------------------------------------
async function refreshState(): Promise<void> {
  try {
    const g = await kernel.gen();
    const warm = !!g.inMemory;
    el("stateDot").className = "dot " + (warm ? "warm" : "cold");
    el("stateTxt").textContent = warm ? "warm (in-memory)" : "cold (snapshot)";
    el("genPill").textContent = `gen ${g.generation} · cell ${g.committedCell}`;
  } catch {
    el("stateDot").className = "dot off";
    el("stateTxt").textContent = "disconnected";
    el("genPill").textContent = "gen –";
  }
}
kernel.onState = (s: KernelState): void => {
  if (s === "disconnected") {
    el("stateDot").className = "dot off";
    el("stateTxt").textContent = "disconnected";
  }
  if (s === "connecting") {
    el("stateDot").className = "dot";
    el("stateTxt").textContent = "connecting…";
  }
};

// --- config -----------------------------------------------------------------
function buildConfig(): EngramConfig {
  const modulesRaw = $in("cfgModules").value.trim();
  let modules: boolean | string[] = true;
  if (modulesRaw && modulesRaw !== "true") {
    modules =
      modulesRaw === "false"
        ? false
        : modulesRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
  }
  const fetchRaw = $in("cfgFetch").value.trim();
  let fetch: boolean | string[] = true;
  if (fetchRaw === "false") fetch = false;
  else if (fetchRaw && fetchRaw !== "true")
    fetch = fetchRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
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
}

let cellSeq = 0;
function addCell(src = ""): CellEl {
  const id = ++cellSeq;
  const div = document.createElement("div") as CellEl;
  div.className = "cell";
  div.innerHTML = `
    <div class="cell-head"><span class="num">[${id}]</span><span class="grow"></span>
      <button data-run>▶ run (⇧⏎)</button><button data-del>✕</button></div>
    <textarea spellcheck="false" placeholder="// JS — runs against the durable namespace"></textarea>
    <div class="out" hidden></div><div class="meta" hidden></div>`;
  const ta = div.querySelector("textarea") as HTMLTextAreaElement;
  ta.value = src;
  const out = div.querySelector(".out") as HTMLDivElement;
  const meta = div.querySelector(".meta") as HTMLDivElement;
  ta.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      void run();
    }
  });
  (div.querySelector("[data-run]") as HTMLButtonElement).onclick = () => void run();
  (div.querySelector("[data-del]") as HTMLButtonElement).onclick = () => div.remove();
  async function run(): Promise<void> {
    div.classList.add("running");
    out.hidden = false;
    out.innerHTML = "<span class='log'>running…</span>";
    const t0 = performance.now();
    try {
      const r = await kernel.eval(ta.value);
      renderResult(out, r);
      const ms = Math.round(performance.now() - t0);
      meta.hidden = false;
      const restored = r.inMemoryBefore === false;
      meta.innerHTML =
        `cell ${r.cell} · gen ${r.generation} · ${ms}ms` +
        (restored
          ? ` · <span style="color:var(--amber)">cold-restored (${r.restoreSource || "snapshot"})</span>`
          : ` · warm`) +
        (r.checkpoint && r.checkpoint.sizeGz
          ? ` · snap ${(r.checkpoint.sizeGz / 1024).toFixed(1)}KB gz`
          : "");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.innerHTML = `<span class='err'>${esc(msg)}</span>`;
    } finally {
      div.classList.remove("running");
      void refreshState();
    }
  }
  div._run = run;
  div._ta = ta;
  el("cells").appendChild(div);
  return div;
}

function renderResult(out: HTMLElement, r: KernelReply): void {
  let html = "";
  for (const l of r.logs || []) {
    const txt = typeof l === "string" ? l : `${l.level}: ${l.text}`;
    html += `<div class="log">› ${esc(txt)}</div>`;
  }
  if (!r.ok && r.error) {
    html += `<div class="err">✖ ${esc(r.error.name || "Error")}: ${esc(r.error.message || "")}</div>`;
  } else {
    const v = r.valuePreview != null ? r.valuePreview : r.value;
    if (v !== null && v !== undefined && v !== "")
      html += `<div class="val">⇒ ${esc(typeof v === "string" ? v : JSON.stringify(v))}</div>`;
    else html += `<div class="log">⇒ <i>undefined</i></div>`;
  }
  if (r.final && r.final.kind)
    html += `<div class="final">★ FINAL [${r.final.kind}]: ${esc(String(r.final.value))}</div>`;
  out.innerHTML = html || "<span class='log'>(no output)</span>";
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
  out.dataset.status = "running";
  out.innerHTML = e2eLine("log", "running deployed UI -> kernel E2E...");
  const oldSession = $in("cfgSession").value;
  const testSession = "ui-e2e-" + Date.now().toString(36);
  const lines: string[] = [];
  try {
    persistConn();
    $in("cfgSession").value = testSession;
    LS.k = testSession;
    kernel.close();
    kernel.setConfig({ clock: "seeded", rngSeed: 777, modules: true, fetch: true, cellBudgetTicks: 200000 });

    const setup = await kernel.eval("globalThis.x=42; globalThis.inc=()=>++x; x");
    const setupOk = setup.ok !== false && setup.value === 42;
    lines.push(
      setupOk
        ? pass("eval writes durable state", "value=" + setup.value)
        : fail("eval writes durable state", JSON.stringify(setup)),
    );

    await kernel.evict();
    const cold = await kernel.gen();
    const coldOk = cold.ok !== false && cold.inMemory === false;
    lines.push(
      coldOk
        ? pass("hibernate drops in-memory kernel", "inMemory=" + cold.inMemory)
        : fail("hibernate drops in-memory kernel", JSON.stringify(cold)),
    );

    const restored = await kernel.eval("x");
    const restoredOk = restored.ok !== false && restored.value === 42 && /restore/.test(restored.restoreSource || "");
    lines.push(
      restoredOk
        ? pass("cold restore keeps heap state", "value=" + restored.value + " source=" + restored.restoreSource)
        : fail("cold restore keeps heap state", JSON.stringify(restored)),
    );

    const closure = await kernel.eval("inc()");
    const closureOk = closure.ok !== false && closure.value === 43;
    lines.push(
      closureOk
        ? pass("closure survives restore", "value=" + closure.value)
        : fail("closure survives restore", JSON.stringify(closure)),
    );

    const blocked = await kernel.eval("'x';" + " ".repeat(3 * 1024 * 1024));
    const blockedOk = blocked.ok === false && !!blocked.error && blocked.error.name === "ProtocolSizeError";
    lines.push(
      blockedOk
        ? pass("oversized source guard", blocked.error?.name || "")
        : fail("oversized source guard", JSON.stringify(blocked).slice(0, 400)),
    );

    const wedge = await kernel.send({ t: "wedgeTest", spikeMb: 22 }, 60000);
    const wedgeOk = !!(wedge && wedge.checkpoint && wedge.checkpoint.ok !== false && wedge.checkpoint.scrubbed === true);
    lines.push(
      wedgeOk
        ? pass("W5 spike/free checkpoint", "scrubbed=" + wedge.checkpoint?.scrubbed + " gz=" + wedge.checkpoint?.sizeGz)
        : fail("W5 spike/free checkpoint", JSON.stringify(wedge).slice(0, 400)),
    );

    await kernel.evict();
    const wedgeRestore = await kernel.eval("x");
    const wedgeRestoreOk =
      wedgeRestore.ok !== false && wedgeRestore.value === 43 && /restore/.test(wedgeRestore.restoreSource || "");
    lines.push(
      wedgeRestoreOk
        ? pass("post-wedge cold restore", "value=" + wedgeRestore.value + " source=" + wedgeRestore.restoreSource)
        : fail("post-wedge cold restore", JSON.stringify(wedgeRestore)),
    );

    const ok = lines.every((s) => !s.includes(">FAIL "));
    out.dataset.status = ok ? "pass" : "fail";
    out.innerHTML = lines.join("") + e2eLine(ok ? "final" : "err", ok ? "E2E PASS" : "E2E FAIL");
    return {
      ok,
      session: testSession,
      endpoint: $in("cfgEndpoint").value,
      details: lines.map((l) => l.replace(/<[^>]+>/g, "")),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out.dataset.status = "fail";
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

el<HTMLButtonElement>("addCell").onclick = () => addCell();
el<HTMLButtonElement>("runAll").onclick = async () => {
  for (const child of Array.from(el("cells").children)) {
    await (child as CellEl)._run();
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
if (epFromQuery) $in("cfgEndpoint").value = epFromQuery;
else $in("cfgEndpoint").value = LS.ep || DEFAULT_ENDPOINT;
if (qs.get("apiKey")) $in("cfgApiKey").value = qs.get("apiKey") as string;
else if (LS.key) $in("cfgApiKey").value = LS.key;
if (qs.get("session")) $in("cfgSession").value = qs.get("session") as string;

ensureSession();
kernel.setConfig(buildConfig());
addCell(
  '// durable across reload: increment a counter that lives in the heap\nglobalThis.n = (globalThis.n||0) + 1;\nconsole.log("ran", n, "times");\nn',
);
addCell("// closures survive hibernation too\nglobalThis.inc = globalThis.inc || (()=>++globalThis.n);\ninc()");
kernel.open().then(refreshState, refreshState);

declare global {
  interface Window {
    __ENGRAM_E2E__: () => Promise<E2eResult>;
  }
}
window.__ENGRAM_E2E__ = runDeployedE2e;
if (qs.get("e2e") === "1") setTimeout(() => void runDeployedE2e(), 250);
setInterval(() => void refreshState(), 15000);
