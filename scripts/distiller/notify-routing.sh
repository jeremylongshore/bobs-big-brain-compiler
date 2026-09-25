#!/usr/bin/env bash
# Shared notification seam for the repo-canonical teamkb compile wrapper.
#
# Intent OS owns the canonical alert-floor/Buzz implementation. The compiler only
# supplies the event and deterministic fallback wording; it must not own a second
# formatter or a credential-bearing transport.

notify_routing_log() {
  if declare -F log >/dev/null 2>&1; then
    log "$1"
  elif [ -n "${LOG:-}" ]; then
    printf '[%s] %s\n' "$(date -Is)" "$1" >> "$LOG"
  else
    printf '%s\n' "$1" >&2
  fi
}

notify_routing_load() {
  NOTIFY_GOVERNED=0
  if [ -r "${ALERT_FLOOR_LIB:-}" ]; then
    # shellcheck disable=SC1090
    . "$ALERT_FLOOR_LIB" 2>/dev/null || true
    if declare -F af_dispatch >/dev/null 2>&1 && declare -F af_buzz_transport >/dev/null 2>&1; then
      NOTIFY_GOVERNED=1
      notify_routing_log "governed alert-floor seam loaded from $ALERT_FLOOR_LIB"
    fi
  fi
  if [ "$NOTIFY_GOVERNED" -eq 0 ]; then
    notify_routing_log "WARN: governed alert-floor seam unavailable at ${ALERT_FLOOR_LIB:-unset} — notifications will be skipped"
  fi
  return 0
}

notify_estate() {
  local topic="${1:-sys-incidents}" raw="${2:-}" fallback="${3:-}" severity="${4:-info}" receipt rc
  [ -n "$raw" ] || return 0
  fallback="${fallback:-$raw}"

  if [ "${NOTIFY_GOVERNED:-0}" -eq 1 ]; then
    # Intent OS owns MiniMax-first redacted formatting, evidence preservation,
    # canonical topic aliases, retry/floor behavior, and honest receipts.
    receipt="$(AF_LLM_NORMALIZE=1 AF_BUZZ_CMD=af_buzz_transport \
      af_dispatch "$raw" "$fallback" "$severity" "$topic" 2>>"${LOG:-/dev/null}")" || rc=$?
    rc="${rc:-0}"
    [ -n "$receipt" ] && notify_routing_log "$receipt"
    [ "$rc" -eq 0 ] || notify_routing_log "WARN: governed estate notification returned rc=$rc for topic=$topic"
  else
    notify_routing_log "WARN: skipped estate notification topic=$topic (shared seam unavailable)"
  fi
  return 0
}
