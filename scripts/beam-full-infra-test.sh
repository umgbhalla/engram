#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_ID="beam-infra-$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$ROOT/scratch/beam/$RUN_ID"
mkdir -p "$OUT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BUN_BIN="${BUN_BIN:-}"
if [[ -z "$BUN_BIN" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  elif [[ -x "$HOME/.bun/bin/bun" ]]; then
    BUN_BIN="$HOME/.bun/bin/bun"
  else
    echo "Missing bun. Install with: curl -fsSL https://bun.sh/install | bash" >&2
    exit 2
  fi
fi

# Some repo scripts invoke "node". Beam is intentionally minimal, so provide a
# per-run node shim to Bun instead of mutating the machine globally.
SHIM_DIR="$OUT_DIR/bin"
mkdir -p "$SHIM_DIR"
ln -sfn "$BUN_BIN" "$SHIM_DIR/node"
export PATH="$SHIM_DIR:$(dirname "$BUN_BIN"):$PATH"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: $name" >&2
    exit 2
  fi
}

run_step() {
  local name="$1"
  shift
  echo
  echo "== $name =="
  local log="$OUT_DIR/$name.log"
  set +e
  "$@" >"$log" 2>&1
  local status=$?
  set -e
  sed -n '1,220p' "$log"
  if [[ $status -ne 0 ]]; then
    echo "STEP_FAILED $name status=$status log=$log" >&2
    exit "$status"
  fi
}

require_env ENGRAM_KERNEL_KEY

echo "runId=$RUN_ID"
echo "root=$ROOT"
echo "bun=$("$BUN_BIN" --version)"
echo "nodeShim=$(command -v node)"
echo "head=$(git rev-parse --short HEAD)"
echo "out=$OUT_DIR"

run_step build-sdk "$BUN_BIN" run build:sdk
run_step build-cli "$BUN_BIN" run build:cli
run_step endpoints "$BUN_BIN" scripts/check-deployed-endpoints.mjs
run_step smoke-live "$BUN_BIN" scripts/smoke-live.mjs
run_step telemetry-probe "$BUN_BIN" scripts/telemetry-probe.mjs --samples 3 --timeoutMs 30000 --out "$OUT_DIR/telemetry.json"
run_step warm-buffered "$BUN_BIN" scripts/probe-warm-buffered.mjs --evals 8 --keepAliveMs 15000 --warmFlushIdleMs 5000 --out "$OUT_DIR/warm-buffered.json"
run_step hot-chaos "$BUN_BIN" scripts/chaos-hot-repl.mjs --iterations 25 --keepAliveMs 20000 --warmFlushIdleMs 7000 --longDelayMs 12000 --maxDelayMs 2500 --burstMin 4 --burstMax 12 --churnKb 128 --out "$OUT_DIR/chaos-hot-repl.json"
run_step single-connection-hammer "$BUN_BIN" scripts/hammer-single-connection.mjs --queue 16 --warmSamples 20 --timeoutSamples 8 --keepAliveMs 20000 --gapMs 12000 --timeoutP95MaxMs 15000 --out "$OUT_DIR/hammer-single.json" --markdown "$OUT_DIR/hammer-single.md"

if [[ -n "${ENGRAM_SANDBOX_URL:-}" && -n "${ENGRAM_SANDBOX_KEY:-}" ]]; then
  run_step sandbox-direct "$BUN_BIN" --eval "
const url = process.env.ENGRAM_SANDBOX_URL.replace(/\/$/, '') + '/exec';
const res = await fetch(url, {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + process.env.ENGRAM_SANDBOX_KEY,
    'content-type': 'application/json',
    'x-engram-session': 'beamverify' + Date.now().toString(36)
  },
  body: JSON.stringify({ cmd: 'pwd && printf "\\nBEAM_SANDBOX_VERIFY\\n"', cwd: '/workspace' })
});
const body = await res.text();
console.log(JSON.stringify({ status: res.status, ok: res.ok, body: body.slice(0, 500) }, null, 2));
if (!res.ok || !body.includes('BEAM_SANDBOX_VERIFY')) process.exit(1);
"
else
  echo
  echo "== sandbox-direct =="
  echo "SKIP missing ENGRAM_SANDBOX_URL or ENGRAM_SANDBOX_KEY"
fi

if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo
  echo "== analytics-engine =="
  curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    --data-binary @- > "$OUT_DIR/analytics-engine.json" <<'SQL'
SELECT blob1 AS op, blob2 AS restoreSource, blob4 AS errorName,
       count() AS n,
       max(double3) AS max_sizeRaw,
       max(double5) AS max_usedHeap
FROM engram_kernel
WHERE timestamp > now() - INTERVAL '30' MINUTE
GROUP BY op, restoreSource, errorName
ORDER BY n DESC
LIMIT 30
SQL
  sed -n '1,220p' "$OUT_DIR/analytics-engine.json"
else
  echo
  echo "== analytics-engine =="
  echo "SKIP missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN"
fi

echo
echo "BEAM_FULL_INFRA_OK runId=$RUN_ID out=$OUT_DIR"
