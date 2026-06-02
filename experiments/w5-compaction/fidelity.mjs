// W5 fidelity boundary: what survives JSON-based fresh-instance compaction and what does NOT.
// We enumerate JS constructs and classify each as: SERIALIZABLE (data), REPLAY-ABLE (source oplog
// reconstructs it), or LOST (no general recovery without engine-level heap walk).
import { QuickJS } from '../e6-oplog/node_modules/quickjs-wasi/dist/index.js';
import { readFileSync } from 'node:fs';
const WASM = readFileSync(new URL('../e6-oplog/node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
const mod = await WebAssembly.compile(WASM);

const vm = await QuickJS.create(mod);
// Build a heap with hard-to-serialize constructs
vm.evalCode(`
  globalThis.cls = (function(){ let secret = 99; return { get: ()=>secret, bump: ()=>++secret }; })();
  globalThis.m = new Map([["a",1],["b",2]]);
  globalThis.s = new Set([1,2,3]);
  globalThis.ta = new Uint8Array([5,6,7]);
  globalThis.fn = function add(a,b){ return a+b; };
  globalThis.re = /ab+c/gi;
  globalThis.sym = Symbol("tag");
  globalThis.circular = {}; globalThis.circular.self = globalThis.circular;
  globalThis.wr = new WeakRef({live:true});
  globalThis.gen = (function*(){ yield 1; yield 2; })();
  globalThis.genFirst = globalThis.gen.next().value;
  globalThis.err = new TypeError("boom");
  globalThis.cls.bump(); // secret now 100
`);
vm.executePendingJobs();

// What can structured/JSON serialization capture?
const probe = (expr) => { try { return vm.dump(vm.evalCode(expr)); } catch(e){ return "ERR:"+e; } };

const report = {
  // SERIALIZABLE via JSON (with custom replacers for BigInt/Date)
  map_via_entries: probe('JSON.stringify([...m.entries()])'),
  set_via_array: probe('JSON.stringify([...s])'),
  typedarray_via_array: probe('JSON.stringify([...ta])'),
  regex_via_source_flags: probe('JSON.stringify({src:re.source, flags:re.flags})'),
  error_via_fields: probe('JSON.stringify({name:err.name,message:err.message})'),
  // REPLAY-ABLE: function source text is recoverable
  fn_source: probe('fn.toString()'),
  closure_source: probe('cls.get.toString()'), // body recoverable BUT not captured `secret`
  closure_captured_value: probe('cls.get()'), // 100 — readable, but tied to the closure scope
  // LOST without engine heap-walk:
  // - generator resumption point (gen already advanced past yield 1)
  gen_next_after: probe('gen.next().value'), // 2 — live position not JSON-serializable
  // - Symbol identity (Symbol() is unique, not Symbol.for)
  sym_is_registered: probe('Symbol.keyFor(sym) !== undefined'), // false -> identity lost on rehydrate
  // - WeakRef target liveness
  wr_alive: probe('wr.deref() !== undefined'),
  // - circular refs break naive JSON.stringify
  circular_naive: probe('(function(){try{JSON.stringify(circular);return "ok"}catch(e){return "THROWS:"+e.name}})()'),
};
vm.dispose();
console.log(JSON.stringify(report, null, 2));
