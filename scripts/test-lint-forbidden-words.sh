#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
linter="$script_dir/lint-forbidden-words.sh"
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT

assert_rejected() {
  local name=$1
  local fixture=$2
  local output="$fixture_dir/$name.out"
  if bash "$linter" "$fixture" >"$output" 2>&1; then
    echo "expected rejection: $name" >&2
    exit 1
  fi
}

assert_accepted() {
  local name=$1
  local fixture=$2
  if ! bash "$linter" "$fixture" >/dev/null 2>&1; then
    echo "expected acceptance: $name" >&2
    exit 1
  fi
}

printf '%s\n' 'The audit trail is immutable.' >"$fixture_dir/forbidden.md"
assert_rejected "forbidden-claim" "$fixture_dir/forbidden.md"

printf '%s\n' 'The log is tamper-evident, not tamper-proof, and not immutable blockchain storage.' \
  >"$fixture_dir/negated.md"
assert_accepted "negated-claim" "$fixture_dir/negated.md"

printf '%s\n' 'The audit trail is append-only.' >"$fixture_dir/unqualified.md"
assert_rejected "unqualified-append-only" "$fixture_dir/unqualified.md"

printf '%s\n' 'The audit trail is append-only by protocol and hash-chained; forks are disclosed.' \
  >"$fixture_dir/qualified.md"
assert_accepted "qualified-append-only" "$fixture_dir/qualified.md"

printf '%s\n' '<!-- forbidden-words-lint: allow --> historical terminology: immutable.' \
  >"$fixture_dir/escaped.md"
assert_accepted "explicit-escape" "$fixture_dir/escaped.md"

echo "✓ forbidden-words lint regression tests passed"
