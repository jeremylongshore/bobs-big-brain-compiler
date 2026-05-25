#!/usr/bin/env bash
# Reproduction + regression test for the bd-sync rapid-write race
# (bead intentional-cognition-os-55q.4).
#
# What it tests: after running bd-sync note across N beads in tight
# sequence (the exact pattern that lost 7/13 notes during the
# 2026-05-23 hygiene reset), do all N notes persist in BOTH:
#   1. Dolt DB (visible via bd show)
#   2. .beads/issues.jsonl (the flat-file that downstream readers and
#      auto-import paths use as source-of-truth on session restart)
#
# Why we test both layers: the original race lost data from both
# layers in bd 1.0.3. bd 1.0.4 keeps the Dolt write durable, but JSONL
# can still drift because Dolt's auto-export to JSONL has a 15-min
# minimum interval (per .beads/config.yaml). bd-sync compensates by
# calling `bd export` after every bead-side write — this script
# regression-tests that compensation.
#
# Exit code:
#   0 — all N notes persist in both layers (fix works)
#   1 — at least one note missing in either layer (regression)
#
# Usage: ./scripts/repro-bd-sync-race.sh [N]
#   N defaults to 10. Higher N widens the race window.
#
# Implementation note: the verification uses captured-output + echo|grep
# (not `bd show | grep -q`) on purpose. The latter triggers SIGPIPE on
# bd show when grep -q exits early on match, and `set -euo pipefail`
# then mis-reports the pipe as failed. The original v1 of this script
# fell into that trap and reported false-positive race triggers when
# the data was actually present. See the diagnostic narrative in bead
# 55q.4's closing notes.

set -euo pipefail

N="${1:-10}"
SANDBOX=$(mktemp -d /tmp/bd-sync-race-repro-XXXXXX)
trap "rm -rf $SANDBOX" EXIT

cd "$SANDBOX"
bd init --prefix racerepro >/dev/null

for i in $(seq 1 "$N"); do
  bd create --title "race test bead $i" --type task --priority 2 -q >/dev/null
done

BEADS=$(bd list --status open --format json 2>/dev/null | jq -r '.[].id' | sort)
COUNT=$(echo "$BEADS" | wc -l | tr -d ' ')
if [ "$COUNT" -ne "$N" ]; then
  echo "setup failure: expected $N beads, got $COUNT" >&2
  exit 2
fi

# Tight loop — the exact pattern that lost notes on 2026-05-23.
for b in $BEADS; do
  bd-sync note "$b" "MARKER-$b" >/dev/null 2>&1
done

db_missing=0
jsonl_missing=0
for b in $BEADS; do
  # Capture-then-grep avoids the SIGPIPE / pipefail interaction that
  # plagued the v1 verification. bd show writes to stdout; if grep -q
  # is on the right side of a pipe and exits early, bd show gets
  # SIGPIPE → exits 141 → pipefail reports the pipe as failed.
  show_output=$(bd show "$b" 2>/dev/null || echo "")
  if ! echo "$show_output" | grep -q "MARKER-$b"; then
    db_missing=$((db_missing + 1))
    echo "  ✗ DB missing marker on $b"
  fi
  # grep -c returns "0\nexit=1" on no-match; capture stdout-only and treat
  # missing file (exit 2) as zero matches.
  jsonl_match=$(grep -c "MARKER-$b" .beads/issues.jsonl 2>/dev/null || true)
  jsonl_match="${jsonl_match:-0}"
  if [ "$jsonl_match" -eq 0 ]; then
    jsonl_missing=$((jsonl_missing + 1))
    echo "  ✗ JSONL missing marker on $b"
  fi
done

if [ "$db_missing" -eq 0 ] && [ "$jsonl_missing" -eq 0 ]; then
  echo "PASS: $N/$N beads have markers in both DB and JSONL"
  exit 0
else
  echo ""
  echo "FAIL: DB missing=$db_missing  JSONL missing=$jsonl_missing  (of $N)"
  echo "Race reproduced — the bd-sync flush_jsonl defense has regressed."
  exit 1
fi
