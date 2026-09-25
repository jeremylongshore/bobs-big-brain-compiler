#!/usr/bin/env bash
# Deterministic contract test for the nightly wrapper's notification seam.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/teamkb-compile-daily.sh"
ROUTING="$SCRIPT_DIR/notify-routing.sh"
TEST_ROOT="$(mktemp -d -t teamkb-notify-test.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# Static guard: ntfy must not return through either notification path.
! grep -nE 'ntfy\.sh|NTFY_TOPIC' "$WRAPPER" || fail 'wrapper still contains an ntfy dependency'
grep -q 'af_dispatch' "$ROUTING" || fail 'routing seam does not prefer the governed alert-floor seam'
! grep -nE 'slack_post|notify-lib\.sh|NOTIFY_LIB|(^|[^[:alnum:]_])llm_normalize([^[:alnum:]_]|$)' "$WRAPPER" "$ROUTING" || fail 'legacy notification compatibility path remains'
grep -q 'notify_estate "sys-automation"' "$WRAPPER" || fail 'failure route is not sys-automation'
grep -q 'notify_estate "sys-incidents"' "$WRAPPER" || fail 'abnormal-exit route is not sys-incidents'
grep -q 'TeamKB nightly compile' "$WRAPPER" || fail 'deterministic human fallback is missing'

# Behavioral guard: a fake governed alert-floor library records the canonical
# topic selected by the wrapper seam without reaching any network or credential
# path.
capture="$TEST_ROOT/capture.log"
log_file="$TEST_ROOT/routing.log"
cat > "$TEST_ROOT/alert-floor.sh" <<'EOF'
af_buzz_transport() { :; }
af_llm_normalize() {
  printf 'Normal human compile alert\n' >> "$NOTIFY_CAPTURE"
  printf 'Normal human compile alert'
}
af_dispatch() {
  local raw="$1" fallback="$2" severity="$3" topic="$4" rendered
  printf 'dispatch topic=%s severity=%s raw=%s fallback=%s\n' "$topic" "$severity" "$raw" "$fallback" >> "$NOTIFY_CAPTURE"
  rendered="$(af_llm_normalize "$raw" "$fallback" "topic=$topic")"
  printf 'buzz-visible=%s\n' "$rendered" >> "$NOTIFY_CAPTURE"
  printf 'af_dispatch: status=delivered buzz=ok topic=%s\n' "$topic"
}
EOF

NOTIFY_CAPTURE="$capture"
ALERT_FLOOR_LIB="$TEST_ROOT/alert-floor.sh"
LOG="$log_file"
# shellcheck source=notify-routing.sh
. "$ROUTING"
notify_routing_load
notify_estate sys-automation 'RAW AGENT DUMP: FAILED 2026-08-02' 'TeamKB compile failed for 2026-08-02; check the run log.' high
notify_estate sys-incidents 'RAW AGENT DUMP: ABORTED 2026-08-02' 'TeamKB compile aborted on 2026-08-02; check the run log.' critical

grep -q 'dispatch topic=sys-automation severity=high' "$capture" ||
  fail 'sys-automation topic was not passed to governed dispatch'
grep -q 'dispatch topic=sys-incidents severity=critical' "$capture" ||
  fail 'sys-incidents topic was not passed to governed dispatch'
grep -q 'buzz-visible=Normal human compile alert' "$capture" ||
  fail 'MiniMax normalization did not run before the visible Buzz message'
! grep -q 'buzz-visible=.*RAW AGENT DUMP' "$capture" ||
  fail 'raw agent output reached the visible Buzz message'

# Missing-library fallback must be loud in the log but still non-fatal.
unset -f af_dispatch af_buzz_transport af_llm_normalize 2>/dev/null || true
ALERT_FLOOR_LIB="$TEST_ROOT/missing-alert-floor.sh"
notify_routing_load
notify_estate cron-failures 'skipped delivery' 'TeamKB compile failed; check the run log.' high
grep -q 'shared seam unavailable' "$log_file" || fail 'missing-library fallback was not logged'

printf 'notification routing: PASS\n'
