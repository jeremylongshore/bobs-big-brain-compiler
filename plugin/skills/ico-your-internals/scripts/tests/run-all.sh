#!/usr/bin/env bash
# Run all script tests. Wired to CI via .github/workflows/ci.yml#plugin-scripts.
# Exit 0 only if every test passes; non-zero on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OVERALL=0

echo "==============================================="
echo "  test_estimate_budget.sh"
echo "==============================================="
if ! "$SCRIPT_DIR/test_estimate_budget.sh"; then
  OVERALL=1
fi

echo
echo "==============================================="
echo "  test_run_sh.sh"
echo "==============================================="
if ! "$SCRIPT_DIR/test_run_sh.sh"; then
  OVERALL=1
fi

echo
echo "==============================================="
echo "  test_verify.py"
echo "==============================================="
if ! python3 -m unittest "$SCRIPT_DIR/test_verify.py" -v 2>&1; then
  OVERALL=1
fi

echo
echo "==============================================="
if [ "$OVERALL" -eq 0 ]; then
  echo "  ALL SCRIPT TESTS PASSED"
else
  echo "  SCRIPT TESTS FAILED — see output above"
fi
echo "==============================================="

exit "$OVERALL"
