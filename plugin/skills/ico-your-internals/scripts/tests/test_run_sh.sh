#!/usr/bin/env bash
# Tests for run.sh argument shape + slug sanitization.
#
# Plain bash assertions — no bats dependency. Runs in --dry mode so no
# real ico calls happen. Verifies the 4 bugs found in the v0.1 first
# real dog-food run can't silently regress:
#
#   1. TARGET_SLUG trailing newline → dash contamination
#   2. WS path matches where `ico init <name> --path <parent>` creates it
#   3. --workspace placement BEFORE subcommand
#   4. compile target loop (no `compile all`)
#
# Run from repo root:
#   plugin/skills/ico-your-internals/scripts/tests/test_run_sh.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../run.sh"

PASS=0
FAIL=0
fail() { echo "  FAIL: $*" >&2; FAIL=$((FAIL+1)); }
pass() { echo "  ok:   $*"; PASS=$((PASS+1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARGET="$TMP/intent-eval-core"
mkdir -p "$TARGET"
echo "test md" > "$TARGET/sample.md"
BANK="$TMP/bank.yaml"
cat > "$BANK" <<'EOF'
version: v1
target: intent-eval-core
questions:
  - id: Q01
    question: "test?"
EOF

# A dummy ANTHROPIC_API_KEY satisfies preflight without exposing real creds.
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-test-key-for-dry-run-only}"

# Stub `ico` so run.sh's preflight passes on CI runners that don't have the
# global package installed. The stub only needs to handle `ico --version`
# (the only ico call before --dry exits). All other ico subcommands are
# unreachable in --dry mode.
STUB_BIN="$TMP/stub-bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/ico" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  --version) echo "0.0.0-stub" ;;
  *)         echo "stub ico called with: $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$STUB_BIN/ico"
export PATH="$STUB_BIN:$PATH"

# test 1: --dry mode runs without invoking ico subcommands beyond version
echo "test 1: --dry mode completes cleanly without Claude calls"
DRY_OUT="$("$RUN_SH" --target "$TARGET" --bank "$BANK" --repo-root "$TMP" --dry 2>&1)" || {
  fail "--dry exited non-zero"
}
if echo "$DRY_OUT" | grep -q '"dry":true'; then
  pass "--dry final payload reports dry:true"
else
  fail "--dry didn't produce dry:true payload"
fi
RUN_ID="$(echo "$DRY_OUT" | grep -oE '"run_id":"[^"]+' | sed 's/"run_id":"//' | head -1)"
if [ -n "$RUN_ID" ]; then
  pass "--dry surfaced run_id"
else
  fail "no run_id in --dry output"
fi

# test 2: TARGET_SLUG has no trailing dash (bug 1)
echo
echo "test 2: TARGET_SLUG strips trailing newline cleanly (no '--' in run_id)"
# Look for "--" inside the run_id (which would indicate the slug had a
# trailing dash AND the BANK_VERSION concatenation produced a double dash).
# The run_id format is: <TS>-<TARGET_SLUG>-<BANK_VERSION>. The TS has
# single dashes between date components. Any "--" sequence is a contamination.
if echo "$RUN_ID" | grep -q -- "--"; then
  fail "run_id contains '--' (slug contamination): $RUN_ID"
else
  pass "run_id has no double-dash sequence"
fi
# Also positive: the slug component should equal exactly "intent-eval-core"
if echo "$RUN_ID" | grep -qE "intent-eval-core-v1$"; then
  pass "run_id ends with 'intent-eval-core-v1' (slug correctly bounded)"
else
  fail "run_id does not end with 'intent-eval-core-v1': $RUN_ID"
fi

# test 3: --workspace flag placement is BEFORE subcommand in run.sh (bug 3)
echo
echo "test 3: --workspace flag placed BEFORE subcommand"
# Inspect the source for the right pattern. There should be no
# "ico mount add ... --workspace" or "ico ingest ... --workspace" patterns
# (which would be the wrong placement). Instead, "ico --workspace ... mount"
# and "ico --workspace ... ingest" are correct.
if grep -qE 'ico[[:space:]]+mount[[:space:]]+add[[:space:]]+[^|]+--workspace' "$RUN_SH"; then
  fail "found 'ico mount add ... --workspace' (wrong flag placement)"
else
  pass "no 'ico mount add ... --workspace' anti-pattern"
fi
if grep -qE 'ico[[:space:]]+ingest[[:space:]]+[^|]+--workspace' "$RUN_SH"; then
  fail "found 'ico ingest ... --workspace' (wrong flag placement)"
else
  pass "no 'ico ingest ... --workspace' anti-pattern"
fi
if grep -qE 'ico[[:space:]]+--workspace.*mount add' "$RUN_SH"; then
  pass "found correct 'ico --workspace ... mount add' pattern"
else
  fail "missing 'ico --workspace ... mount add' pattern"
fi
if grep -qE 'ico[[:space:]]+--workspace.*compile' "$RUN_SH"; then
  pass "found correct 'ico --workspace ... compile' pattern"
else
  fail "missing 'ico --workspace ... compile' pattern"
fi

# test 4: compile loop covers all 6 passes, no `compile all` (bug 4)
echo
echo "test 4: compile uses 6-pass loop, not 'compile all'"
if grep -qE 'compile all' "$RUN_SH"; then
  fail "found 'compile all' (invalid target)"
else
  pass "no 'compile all' (invalid target)"
fi
for pass_name in sources concepts topics links contradictions gaps; do
  if grep -qE "compile \"?\\\$pass\"?|$pass_name" "$RUN_SH"; then
    pass "compile pass '$pass_name' present in loop"
  else
    fail "compile pass '$pass_name' missing"
  fi
done

# test 5: WS path matches ico init's actual creation pattern (bug 2)
echo
echo "test 5: WS path equals \$CACHE_ROOT/\$TARGET_SLUG (matches ico init)"
# Patterns use double-quotes + \$ to write literal $CACHE_ROOT/... that
# grep matches against the source. Escaping with \$ avoids SC2016 (which
# only fires on $VAR inside single quotes) without changing the regex.
if grep -qE "WS=\"\\\$CACHE_ROOT/\\\$TARGET_SLUG\"" "$RUN_SH"; then
  pass "WS=\$CACHE_ROOT/\$TARGET_SLUG (correct — matches ico init output)"
elif grep -qE "WS=\"\\\$CACHE_ROOT/workspace\"" "$RUN_SH"; then
  fail "WS=\$CACHE_ROOT/workspace (wrong — ico init doesn't put it there)"
else
  fail "WS assignment not found in expected form"
fi

# test 6: ask subprocess call has --workspace + --json BEFORE 'ask'
# Per v0.2 the ask loop lives in ask-loop.py, not run.sh — check there.
echo
echo "test 6: ask subprocess call places --workspace + --json BEFORE 'ask'"
ASK_LOOP_FILE="$SCRIPT_DIR/../ask-loop.py"
if [ -f "$ASK_LOOP_FILE" ] && grep -qE '"ico", "--workspace", ws, "--json", "ask"' "$ASK_LOOP_FILE"; then
  pass "ask-loop.py subprocess.run uses correct global-flags-first order"
else
  fail "subprocess.run does not use --workspace/--json before 'ask' (looked in $ASK_LOOP_FILE)"
fi

# test 7: v0.2 — the inline ask-loop heredoc is gone (extracted to ask-loop.py).
# Per ADR-029 + ADR-032, the ask loop now consumes paraphrases via bank.py;
# inlining it as a bash heredoc is incompatible with that. Heredoc must die.
echo
printf "test 7: v0.2 — inline 'python3 - ... <<%s' heredoc is removed\n" "'PY'"
if grep -qE "python3 - .*<<.PY" "$RUN_SH"; then
  fail "found inline python3 heredoc — should be extracted to ask-loop.py"
else
  pass "no inline 'python3 - <<PY' heredoc"
fi

# test 8: v0.2 — run.sh delegates the ask loop to ask-loop.py
echo
echo "test 8: v0.2 — run.sh invokes ask-loop.py for the ask phase"
if grep -qE "ask-loop\.py" "$RUN_SH"; then
  pass "run.sh references ask-loop.py"
else
  fail "run.sh does not reference ask-loop.py"
fi
ASK_LOOP="$SCRIPT_DIR/../ask-loop.py"
if [ -f "$ASK_LOOP" ]; then
  pass "ask-loop.py exists"
else
  fail "ask-loop.py does not exist at $ASK_LOOP"
fi

# test 9: v0.2 — --dry surfaces the planned ask count (intents × paraphrases).
# Per ADR-032 the default mode is 'primary' so a 1-question v1 fixture is
# 1 intent × 1 paraphrase = 1 ask planned.
echo
echo "test 9: v0.2 — --dry reports planned ask count"
if echo "$DRY_OUT" | grep -qE '"asks_planned":[[:space:]]*[0-9]+'; then
  pass "--dry payload reports asks_planned"
else
  fail "--dry payload missing asks_planned"
fi

echo
echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "=========================================="
[ "$FAIL" -eq 0 ] || exit 1
