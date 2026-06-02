# Vendored Binary Provenance

Per `docs/INTROSPECTION.md` action #6 — **SAFE variant**: manifest + pin, but do
**NOT** switch cloud to derive-at-build. The kernel runs `wasm-opt -Oz` on the
engine (raw 1.59MB -> 1.45MB, byte-changed at char 10); cloud ships the **raw**
bytes. Any byte change to the vendored engine invalidates every live `engram-cloud`
snapshot via `EngineHashMismatchError`. The vendored bytes stay the **source of
truth**; `quickjs-wasi@3.0.0` + `binaryen` are pinned only to document/verify them.

Machine-readable manifest: [`apps/cloud/vendor/PROVENANCE.json`](../apps/cloud/vendor/PROVENANCE.json).

**Upstream:** `quickjs-wasi@3.0.0` (vercel-labs) — https://www.npmjs.com/package/quickjs-wasi

**Recompute:** `cd apps/cloud && shasum -a 256 vendor/quickjs.wasm vendor/ext/*.wasm vendor/qjs-dist/*.js`

## sha256 table

| Path (under `apps/cloud`) | Bytes | sha256 | Upstream artifact |
|---|---|---|---|
| `vendor/quickjs.wasm` | 1586981 | `52d4a276b33757cf918207d05ac1ce02985cbf5415fdb735e67e93bcf826eb24` | `quickjs.wasm` (RAW, not -Oz) |
| `vendor/ext/crypto.wasm` | 187423 | `3c0ca1e0ecbca51f88ae22ae5da75ee83e6f87170ec8c7efc2ec9ba52b1bd913` | `extensions/crypto/crypto.so` |
| `vendor/ext/encoding.wasm` | 12780 | `50af2847297183c0be2f97948cd83473b0888b424b98af51aaf4200160dce77f` | `extensions/encoding/encoding.so` |
| `vendor/ext/headers.wasm` | 14232 | `fcc7d25dfdda38d1d57d0a532540f3baa56a957f76f85548919716a174ac9037` | `extensions/headers/headers.so` |
| `vendor/ext/structured-clone.wasm` | 9648 | `76356bc2983ce24b6c503a0cb1fa0308e09c18e60aa38d44ca737454ee769c06` | `extensions/structured-clone/structured-clone.so` |
| `vendor/ext/url.wasm` | 920499 | `54167390c210290f0703752527000ba44885606c4ed1ae12be30462c147a9215` | `extensions/url/url.so` |
| `vendor/qjs-dist/extensions.js` | 15720 | `9662299693f6ddd8d56d6e2f91b4bd2202e2cfebe06e834bf9a2b16fa15c4e08` | `dist/extensions.js` |
| `vendor/qjs-dist/index.js` | 79543 | `f9600e8a35ecc4f4a3e1028c062ba8be7d3face5b90fda043e3c5f2099451110` | `dist/index.js` |
| `vendor/qjs-dist/version.js` | 131 | `85dc403fb6aee6e8dc864c9d7f695f6052b1ea1ccbde097bd07c1fe094d9f962` | `dist/version.js` (exports `VERSION="3.0.0"`) |
| `vendor/qjs-dist/wasi-shim.js` | 4033 | `79af15cf5158d181d11021158abb22541fd6d35beca569652317859819960eac` | `dist/wasi-shim.js` |

The 5 ext `.wasm` are byte-identical to the kernel's npm-derived extensions
(`cmp` IDENTICAL), confirming the vendored bytes are the unmodified vercel-labs dist.
