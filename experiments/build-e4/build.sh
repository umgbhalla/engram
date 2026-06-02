#!/usr/bin/env bash
# E4 wizer-bake build (reproducible). Re-bakes the baked wasm from the wizer-enabled
# base module. The base module (qjs_wiz_base.wasm) is the stock quickjs-wasi engine
# (same source as node_modules/quickjs-wasi/quickjs.wasm) recompiled with the added
#   __attribute__((export_name("wizer.initialize"))) void wizer_initialize(void){ boot+inject stdlib }
# hook (see ../e4-wizer/interface_wiz.c tail). Rebuilding the base needs wasi-sdk; the
# baked artifact is produced from it with wizer alone:
set -euo pipefail
cd "$(dirname "$0")"
wizer qjs_wiz_base.wasm --allow-wasi --init-func "wizer.initialize" -o qjs_baked.wasm
ls -la qjs_baked.wasm
echo "OK: baked wasm ready (CompiledWasm-loadable, stdlib resident, no runtime init/inject)."
