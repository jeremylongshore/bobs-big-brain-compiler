#!/usr/bin/env bash
# Scheduled deterministic ICO mount scan + governed incremental compile.
# This is NOT the agent-driven team distiller (`teamkb-compile-daily.sh`).

set -euo pipefail
umask 077

export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ICO_BIN="${ICO_BIN:-$HOME/.local/bin/ico}"
ICO_WORKSPACE="${ICO_WORKSPACE:-$HOME/.teamkb/brain}"
PROVIDER_FILE="${ICO_PROVIDER_FILE:-$HOME/.config/intentsolutions/api-providers.sops.json}"
STATE_DIR="${ICO_MAINTAIN_STATE_DIR:-$HOME/.local/state/ico-maintain-daily}"
TIMEOUT_SECONDS="${ICO_MAINTAIN_TIMEOUT:-4500}"
# Direct repository mounts can be legitimately unchanged for long periods.
# Enable an age limit only for a derived feed with an external freshness SLA.
MAX_INPUT_AGE_DAYS="${ICO_MAX_INPUT_AGE_DAYS:-0}"
DAILY_CEILING_USD="${ICO_DAILY_CEILING_USD:-1}"
LOCK_WAIT_SECONDS="${ICO_LOCK_WAIT_SECONDS:-600}"
AF_LIB="${AF_LIB:-$HOME/bin/lib/alert-floor.sh}"

mkdir -p "$STATE_DIR"
: > "$STATE_DIR/last.beat"

alert_failure() {
  local detail="${1:-unknown failure}"
  if [ -r "$AF_LIB" ]; then
    # shellcheck source=/dev/null
    source "$AF_LIB"
    AF_SOURCE=ico-maintain-daily \
      af_dispatch \
      "Bob's Big Brain ICO maintenance failed: $detail" \
      "The compiler could not refresh mounted team knowledge. Check the maintenance receipt and service log." \
      high \
      sys-automation >/dev/null 2>&1 || true
  fi
}

[ -x "$ICO_BIN" ] || {
  alert_failure "ICO binary missing at $ICO_BIN"
  echo "FATAL: ICO binary missing at $ICO_BIN" >&2
  exit 1
}

# Environment wins. Otherwise decrypt only the MiniMax key in-process; never
# write or print it. A no-op scan can still succeed without a provider key.
if [ -z "${MINIMAX_API_KEY:-}" ] && [ -f "$PROVIDER_FILE" ] && command -v sops >/dev/null 2>&1; then
  minimax_key="$(
    sops -d --input-type json --output-type json "$PROVIDER_FILE" \
      | jq -er '.minimax.key | strings | select(length > 0)' 2>/dev/null
  )" || minimax_key=""
  if [ -n "$minimax_key" ]; then
    export MINIMAX_API_KEY="$minimax_key"
  fi
fi
trap 'unset MINIMAX_API_KEY minimax_key 2>/dev/null || true' EXIT

run_log="$STATE_DIR/run-$(date -u +%Y%m%dT%H%M%SZ).log"
set +e
timeout --signal=TERM --kill-after=60s "$TIMEOUT_SECONDS" \
  env ICO_PROVIDER=minimax ICO_MODEL=MiniMax-M3 \
  "$ICO_BIN" --workspace "$ICO_WORKSPACE" maintain \
    --daily-ceiling-usd "$DAILY_CEILING_USD" \
    --debounce-seconds 0 \
    --max-input-age-days "$MAX_INPUT_AGE_DAYS" \
    --lock-wait-seconds "$LOCK_WAIT_SECONDS" \
    >"$run_log" 2>&1
run_code=$?
set -e

receipt="$ICO_WORKSPACE/.ico/maintenance/latest.json"
status="missing-receipt"
error_code="none"
if [ -s "$receipt" ]; then
  status="$(jq -r '.status // "invalid"' "$receipt" 2>/dev/null || echo invalid)"
  error_code="$(jq -r '.errorCode // "none"' "$receipt" 2>/dev/null || echo invalid)"
fi

if [ "$run_code" -eq 0 ] && { [ "$status" = compiled ] || [ "$status" = verified_noop ]; }; then
  jq -n \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "$status" \
    --arg receiptSha256 "$(sha256sum "$receipt" | awk '{print $1}')" \
    '{at:$at,status:$status,receiptSha256:$receiptSha256}' > "$STATE_DIR/last.ok"
  echo "ICO maintenance $status; receipt=$receipt"
  exit 0
fi

alert_failure "status=$status error=$error_code exit=$run_code log=$run_log"
echo "FATAL: ICO maintenance status=$status error=$error_code exit=$run_code" >&2
echo "Receipt: $receipt" >&2
echo "Log: $run_log" >&2
exit 1
