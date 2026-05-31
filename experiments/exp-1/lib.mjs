// Shared helpers for EXP-1.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Resolve the prebuilt quickjs.wasm bytes shipped with the npm package. */
export async function loadWasmBytes() {
  const wasmPath = require.resolve('quickjs-wasi/quickjs.wasm');
  return readFile(wasmPath);
}

/** Cell 1: define a var, a closure, and a PENDING promise that mutates x. */
export const CELL_1 = `
globalThis.x = 41;
globalThis.inc = () => { x++; return x; };
var p = Promise.resolve().then(() => { x = x + 1; });
`;

export const SNAPSHOT_PATH = new URL('./snapshot.bin', import.meta.url).pathname;

/** Enumerate ALL exported mutable globals of a wasm instance (host-side read). */
export function readMutableGlobals(instance) {
  const out = {};
  for (const [name, val] of Object.entries(instance.exports)) {
    if (val instanceof WebAssembly.Global) {
      try {
        out[name] = val.value;
      } catch {
        out[name] = '<unreadable>';
      }
    }
  }
  return out;
}
