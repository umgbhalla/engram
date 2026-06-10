#!/usr/bin/env node
// Tests for the @engram/sdk v2 EXTENSIBILITY seams (substrate use). Fully offline —
// drives a mock Transport and a fake WebSocket, no live kernel needed.
//
//   node tests/sdk/sdk-ext.mjs
//
// Covers: custom transport (instance + sync/async factory), supportsHostCalls,
// onEval interceptor (single, chain order, runtime use(), throw, transform),
// EngramSession.fromTransport, and the WS lifecycle hooks (onConnect/onReconnect/onClose)
// via a fake WebSocket that can simulate a mid-session drop + reconnect.
import { Engram, EngramSession, EngramClient, presets, defineConfig } from "../../packages/sdk/dist/index.mjs";

let pass = 0, fail = 0;
const check = (n, c, x = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${x ? "  — " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock Transport ----------------------------------------------------------
function makeMock(supportsHostCalls = true) {
  const frames = [], hosts = new Map();
  return {
    frames, hosts,
    transport: {
      supportsHostCalls,
      async request(frame) {
        frames.push(frame);
        if (frame.t === "eval") return { ok: true, value: frame.src.length, valueType: "number", logs: [] };
        return { ok: true };
      },
      setHost(name, fn) { hosts.set(name, fn); },
      close() {},
    },
  };
}

// ---- fake WebSocket (browser-style addEventListener API) ----------------------
// Opens asynchronously, echoes a canned reply per frame, and exposes drop() to
// simulate an unexpected close so autoReconnect + onClose/onReconnect fire.
const fakeSockets = [];
class FakeWS {
  constructor(_url) {
    this.readyState = 0; // CONNECTING
    this.listeners = { open: [], message: [], close: [], error: [] };
    fakeSockets.push(this);
    // open on next tick
    setTimeout(() => { this.readyState = 1; this.emit("open", {}); }, 0);
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  emit(t, ev) { for (const fn of (this.listeners[t] || []).slice()) fn(ev); }
  send(data) {
    const f = JSON.parse(data);
    // reply on next tick like a real socket
    setTimeout(() => {
      if (this.readyState !== 1) return;
      const reply = f.t === "eval"
        ? { ok: true, value: f.src.length, valueType: "number", logs: [] }
        : { ok: true, generation: 1, inMemory: true };
      this.emit("message", { data: JSON.stringify(reply) });
    }, 0);
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close", {}); }
  drop() { this.readyState = 3; this.emit("close", {}); } // unexpected close
}

// =============================================================================
// 1) custom transport: connect applies config + fires onConnect
{
  const m = makeMock(true);
  let connected = 0;
  const s = await Engram.connect({ transport: m.transport, session: "c1", config: { clock: "seeded" }, onConnect: () => connected++ });
  check("custom transport applies config", m.frames.some((f) => f.t === "create"));
  check("custom transport onConnect fired once", connected === 1, `n=${connected}`);
  check("returns EngramSession", s instanceof EngramSession && s.session === "c1");
}

// 2) transport factory — sync and async, receives session id
{
  const m1 = makeMock(); let gotSync = "";
  await Engram.connect({ transport: (sess) => { gotSync = sess; return m1.transport; }, session: "sync" });
  check("sync factory gets session", gotSync === "sync");
  const m2 = makeMock(); let gotAsync = "";
  await Engram.connect({ transport: async (sess) => { await sleep(1); gotAsync = sess; return m2.transport; }, session: "async" });
  check("async factory gets session", gotAsync === "async");
}

// 3) supportsHostCalls
{
  const sYes = await Engram.connect({ transport: makeMock(true).transport, session: "y" });
  const sNo = await Engram.connect({ transport: makeMock(false).transport, session: "n" });
  const sDefault = await Engram.connect({ transport: { async request(f){return f.t==="eval"?{ok:true,value:0,logs:[]}:{ok:true};}, setHost(){}, close(){} }, session: "d" });
  check("supportsHostCalls true", sYes.supportsHostCalls === true);
  check("supportsHostCalls false", sNo.supportsHostCalls === false);
  check("supportsHostCalls defaults false when omitted", sDefault.supportsHostCalls === false);
}

// 4) onEval: single interceptor transforms code, observes result
{
  const m = makeMock(); const seen = [];
  const s = await Engram.connect({
    transport: m.transport, session: "mw",
    onEval: async (code, opts, next) => { seen.push(code); const r = await next(code + "//x"); seen.push(r.value); return r; },
  });
  const r = await s.eval("ab"); // "ab//x" = 5 chars
  check("onEval transform reaches transport", r.value === 5, `v=${r.value}`);
  check("onEval sees original code + result", seen[0] === "ab" && seen[1] === 5, JSON.stringify(seen));
}

// 5) onEval: chain order outermost-first + runtime use()
{
  const m = makeMock(); const order = [];
  const s = await Engram.connect({
    transport: m.transport, session: "chain",
    onEval: [
      async (c, o, next) => { order.push("A-in"); const r = await next(c); order.push("A-out"); return r; },
      async (c, o, next) => { order.push("B-in"); const r = await next(c); order.push("B-out"); return r; },
    ],
  });
  const ret = s.use(async (c, o, next) => { order.push("C-in"); const r = await next(c); order.push("C-out"); return r; });
  check("use() returns session for chaining", ret === s);
  await s.eval("z");
  check("interceptor order outermost-first", order.join(",") === "A-in,B-in,C-in,C-out,B-out,A-out", order.join(","));
}

// 6) onEval: throwing interceptor skips the transport eval
{
  const m = makeMock();
  const s = await Engram.connect({ transport: m.transport, session: "throw", onEval: async () => { throw new Error("blocked"); } });
  const evalsBefore = m.frames.filter((f) => f.t === "eval").length; // bootstrap eval is legit
  let threw = false;
  try { await s.eval("1+1"); } catch (e) { threw = /blocked/.test(e.message); }
  const evalsAfter = m.frames.filter((f) => f.t === "eval").length;
  check("throwing interceptor skips eval", threw && evalsAfter === evalsBefore, `threw=${threw} before=${evalsBefore} after=${evalsAfter}`);
}

// 7) onEval: interceptor can rewrite the result
{
  const m = makeMock();
  const s = await Engram.connect({ transport: m.transport, session: "rw", onEval: async (c, o, next) => { const r = await next(c); return { ...r, value: 999 }; } });
  const r = await s.eval("x");
  check("interceptor rewrites result value", r.value === 999, `v=${r.value}`);
}

// 8) EngramSession.fromTransport low-level path
{
  const m = makeMock();
  const s = EngramSession.fromTransport(m.transport, { session: "low", config: { clock: "real" } });
  check("fromTransport builds session", s instanceof EngramSession && s.session === "low");
  check("fromTransport does NOT auto-apply config", !m.frames.some((f) => f.t === "create"));
  await s._applyConfig();
  check("fromTransport _applyConfig sends create", m.frames.some((f) => f.t === "create"));
  const r = await s.eval("hello");
  check("fromTransport eval works", r.value === 5, `v=${r.value}`);
}

// 9) no-interceptor zero-overhead path still correct
{
  const m = makeMock();
  const s = await Engram.connect({ transport: m.transport, session: "plain" });
  const r = await s.eval("abcd");
  check("no-interceptor eval path", r.ok && r.value === 4, `v=${r.value}`);
}

// 10) WS lifecycle: onConnect, then drop -> onClose + auto-reconnect -> onReconnect
{
  const events = [];
  const s = await Engram.connect({
    url: "ws://fake/ws", session: "wslife", WebSocket: FakeWS, autoReconnect: true,
    onConnect: () => events.push("connect"),
    onReconnect: () => events.push("reconnect"),
    onClose: () => events.push("close"),
  });
  check("onConnect fired on first WS connect", events.filter((e) => e === "connect").length === 1, JSON.stringify(events));
  const r1 = await s.eval("ok");
  check("eval works pre-drop", r1.value === 2, `v=${r1.value}`);
  // Simulate an unexpected drop of the live socket, then eval (auto-reconnects).
  fakeSockets[fakeSockets.length - 1].drop();
  await sleep(5);
  const r2 = await s.eval("hello"); // triggers reconnect path
  check("eval works after drop (auto-reconnect)", r2.value === 5, `v=${r2.value}`);
  check("onClose fired on unexpected drop", events.includes("close"), JSON.stringify(events));
  check("onReconnect fired after reconnect", events.includes("reconnect"), JSON.stringify(events));
  check("onConnect NOT re-fired on reconnect", events.filter((e) => e === "connect").length === 1, JSON.stringify(events));
  s.close();
}

// 11) config presets + defineConfig validation
{
  check("preset deterministic", presets.deterministic(7).clock === "seeded" && presets.deterministic(7).rngSeed === 7);
  check("preset nodeFull", presets.nodeFull().modules === true && presets.nodeFull().fetch === true);
  check("preset sandboxed default blocks egress", presets.sandboxed().fetch === false);
  check("preset sandboxed allowlist", JSON.stringify(presets.sandboxed(["api.example.com"]).fetch) === '["api.example.com"]');
  check("presets return fresh objects", presets.deterministic() !== presets.deterministic());
  check("defineConfig passes valid", defineConfig({ clock: "seeded", rngSeed: 3 }).rngSeed === 3);
  let threwSeed = false; try { defineConfig({ rngSeed: -1 }); } catch { threwSeed = true; }
  check("defineConfig rejects bad rngSeed", threwSeed);
  let threwBudget = false; try { defineConfig({ cellBudgetTicks: 0 }); } catch { threwBudget = true; }
  check("defineConfig rejects bad cellBudgetTicks", threwBudget);
  let threwClock = false; try { defineConfig({ clock: "fast" }); } catch { threwClock = true; }
  check("defineConfig rejects bad clock", threwClock);
}

// 12) EngramClient — instance management over a transport factory
{
  const minted = []; // record each session id the factory built a transport for
  const client = new EngramClient({
    config: presets.deterministic(2),
    transport: (sess) => { minted.push(sess); return makeMock(true).transport; },
  });
  const a = await client.session("u1");
  const a2 = await client.session("u1");
  check("client reuses session by id", a === a2 && client.size === 1, `size=${client.size}`);
  check("client minted transport once for id", minted.filter((m) => m === "u1").length === 1, JSON.stringify(minted));
  check("client passes id as session", a.session === "u1");
  const b = await client.session("u2");
  check("client tracks multiple sessions", client.size === 2 && client.has("u1") && client.has("u2"));
  check("client ids()", client.ids().sort().join(",") === "u1,u2");
  check("client get() returns cached", client.get("u1") === a);
  check("client get() undefined for unknown", client.get("nope") === undefined);
  check("client list()", client.list().length === 2);
  // eval shorthand
  const r = await client.eval("u1", "abcd");
  check("client.eval shorthand", r.value === 4, `v=${r.value}`);
  // close one
  await client.close("u1");
  check("client close(id) removes", !client.has("u1") && client.size === 1);
  // closeAll
  await client.closeAll();
  check("client closeAll empties", client.size === 0);
}

// 13) EngramClient — concurrent session(id) dedupes to one connect
{
  let connects = 0;
  const client = new EngramClient({ transport: () => { connects++; return makeMock(true).transport; } });
  const [x, y, z] = await Promise.all([client.session("c"), client.session("c"), client.session("c")]);
  check("client dedupes concurrent connects", x === y && y === z && connects === 1, `connects=${connects}`);
  await client.closeAll();
}

// 14) EngramClient — per-call overrides merge over client defaults
{
  let seenConfig = null;
  const client = new EngramClient({
    config: { clock: "seeded", rngSeed: 1 },
    transport: () => {
      const m = makeMock(true);
      const orig = m.transport.request.bind(m.transport);
      m.transport.request = (f) => { if (f.t === "create") seenConfig = f.config; return orig(f); };
      return m.transport;
    },
  });
  await client.session("o1", { config: { rngSeed: 99, cellBudgetTicks: 1500 } });
  check("client merges config overrides", seenConfig && seenConfig.clock === "seeded" && seenConfig.rngSeed === 99 && seenConfig.cellBudgetTicks === 1500, JSON.stringify(seenConfig));
  await client.closeAll();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
