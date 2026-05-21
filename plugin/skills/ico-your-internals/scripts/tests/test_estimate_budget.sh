#!/usr/bin/env bash
# Tests for estimate-budget.sh.
#
# Plain bash assertions — no bats dependency. Run from repo root:
#   plugin/skills/ico-your-internals/scripts/tests/test_estimate_budget.sh
#
# Covers the Gemini PR #77 fix that switched from `wc -w "${arr[@]}"`
# (E2BIG-prone) to `find ... -exec wc -w {} +` streaming.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ESTIMATE="$SCRIPT_DIR/../estimate-budget.sh"

PASS=0
FAIL=0
fail() { echo "  FAIL: $*" >&2; FAIL=$((FAIL+1)); }
pass() { echo "  ok:   $*"; PASS=$((PASS+1)); }

# Shared fixture
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARGET="$TMP/target"
mkdir -p "$TARGET"
BANK="$TMP/bank.yaml"
cat > "$BANK" <<'EOF'
version: v1
target: test
questions:
  - id: Q01
    question: "test"
EOF

# test 1: valid JSON with all required fields
echo "test 1: estimate-budget output is valid JSON with required fields"
echo "hello world" > "$TARGET/doc1.md"
OUTPUT="$("$ESTIMATE" "$TARGET" "$BANK")"
if echo "$OUTPUT" | python3 -c 'import json,sys;json.load(sys.stdin)' 2>/dev/null; then
  pass "output parses as JSON"
else
  fail "output not valid JSON: $OUTPUT"
fi
for field in md_files words input_tokens_est questions qa_tokens_est total_tokens_est dollar_est; do
  if echo "$OUTPUT" | python3 -c "import json,sys;d=json.load(sys.stdin);assert '$field' in d" 2>/dev/null; then
    pass "field present: $field"
  else
    fail "field missing: $field"
  fi
done

# test 2: word count correct for known fixture
echo
echo "test 2: word count correct for known fixture"
rm -rf "$TARGET"; mkdir -p "$TARGET"
echo "one two three" > "$TARGET/a.md"
echo "four five" > "$TARGET/b.md"
OUTPUT="$("$ESTIMATE" "$TARGET" "$BANK")"
WORDS="$(echo "$OUTPUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["words"])')"
if [ "$WORDS" = "5" ]; then pass "word count == 5"; else fail "expected 5, got $WORDS"; fi
MD_COUNT="$(echo "$OUTPUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["md_files"])')"
if [ "$MD_COUNT" = "2" ]; then pass "md_files == 2"; else fail "expected 2, got $MD_COUNT"; fi

# test 3: prunes noise dirs
echo
echo "test 3: node_modules / .git / dist / coverage are pruned"
rm -rf "$TARGET"; mkdir -p "$TARGET"
echo "real word" > "$TARGET/real.md"
mkdir -p "$TARGET/node_modules/x" "$TARGET/.git/y" "$TARGET/dist" "$TARGET/coverage"
echo "noise" > "$TARGET/node_modules/x/junk.md"
echo "noise" > "$TARGET/.git/y/junk.md"
echo "noise" > "$TARGET/dist/junk.md"
echo "noise" > "$TARGET/coverage/junk.md"
OUTPUT="$("$ESTIMATE" "$TARGET" "$BANK")"
WORDS="$(echo "$OUTPUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["words"])')"
if [ "$WORDS" = "2" ]; then pass "only real.md counted"; else fail "expected 2 words, got $WORDS"; fi

# test 4: handles 5,000 files without E2BIG (Gemini PR #77 fix)
echo
echo "test 4: 5,000 .md files without ARG_MAX failure"
rm -rf "$TARGET"; mkdir -p "$TARGET"
for i in $(seq 1 5000); do echo "word_$i" > "$TARGET/file_${i}.md"; done
if OUTPUT="$("$ESTIMATE" "$TARGET" "$BANK")"; then
  pass "did not hit E2BIG on 5,000 files"
  WORDS="$(echo "$OUTPUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["words"])')"
  MD_COUNT="$(echo "$OUTPUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["md_files"])')"
  if [ "$MD_COUNT" = "5000" ]; then pass "counted 5,000"; else fail "expected 5000, got $MD_COUNT"; fi
  if [ "$WORDS" = "5000" ]; then pass "summed 5,000 words"; else fail "expected 5000, got $WORDS"; fi
else
  fail "estimate-budget failed on 5,000-file corpus"
fi

# test 5: empty target → zero counts
echo
echo "test 5: empty target → zero counts"
rm -rf "$TARGET"; mkdir -p "$TARGET"
OUTPUT="$("$ESTIMATE" "$TARGET" "$BANK")"
MD_COUNT="$(echo "$OUTPUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["md_files"])')"
WORDS="$(echo "$OUTPUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["words"])')"
if [ "$MD_COUNT" = "0" ] && [ "$WORDS" = "0" ]; then
  pass "empty target → md_files=0, words=0"
else
  fail "empty: expected 0/0, got $MD_COUNT/$WORDS"
fi

echo
echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "=========================================="
[ "$FAIL" -eq 0 ] || exit 1
