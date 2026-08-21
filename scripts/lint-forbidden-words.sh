#!/usr/bin/env bash
#
# Enforce the ICO documentation honesty vocabulary. Forbidden trust claims may
# appear only when explicitly negated, contrasted, or identified as forbidden.
# Append-only and ordered-log claims also need a protocol or integrity qualifier.
#
# Usage: scripts/lint-forbidden-words.sh [file ...]
# With no arguments, scan README.md and every Markdown file under 000-docs/.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)

files=("$@")
if [ "${#files[@]}" -eq 0 ]; then
  files=("$repo_root/README.md")
  while IFS= read -r -d '' file; do
    files+=("$file")
  done < <(find "$repo_root/000-docs" -type f -name '*.md' -print0 | sort -z)
fi

# Bare positive assertions drift beyond ICO's actual trust model.
forbidden='tamper-proof|immutable|non-repudiation|blockchain'
allow_context="not|never|no |n't|≠|instead of|rather than|as opposed to|forbidden|avoid|isn't|aren't|doesn't|won't|do not|does not"
escape='forbidden-words-lint:[[:space:]]*allow'

# These are valid claims only when they explain the protocol or integrity
# evidence, rather than implying filesystem-enforced immutability.
qualified='append-only|ordered log'
qualifier_context='by protocol|by convention|protocol-level|disclosed|same-timestamp|CHAIN_FORK|benign fork|tamper-evident|hash-chained|hash of the|prev_hash|rewrite-detection|not [^.]*(enforced|filesystem|storage)'

violations=0
for file in "${files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "lint-forbidden-words: skip (not found): $file" >&2
    continue
  fi

  while IFS= read -r hit; do
    line_number=${hit%%:*}
    line_text=${hit#*:}
    if printf '%s' "$line_text" | grep -qiE "$allow_context"; then
      continue
    fi
    if printf '%s' "$line_text" | grep -qiE "$escape"; then
      continue
    fi
    printf '  %s:%s  forbidden claim-word (negate it, or use the correct term e.g. tamper-EVIDENT):\n    %s\n' \
      "$file" "$line_number" "$(printf '%s' "$line_text" | sed 's/^[[:space:]]*//' | cut -c1-160)"
    violations=$((violations + 1))
  done < <(grep -inIE "$forbidden" "$file" || true)

  while IFS= read -r hit; do
    line_number=${hit%%:*}
    line_text=${hit#*:}
    if printf '%s' "$line_text" | grep -qiE "$qualifier_context"; then
      continue
    fi
    if printf '%s' "$line_text" | grep -qiE "$allow_context"; then
      continue
    fi
    if printf '%s' "$line_text" | grep -qiE "$escape"; then
      continue
    fi
    printf '  %s:%s  qualifier-required term (add "by protocol" / "disclosed same-timestamp forks" / a hash-chain framing, or negate it):\n    %s\n' \
      "$file" "$line_number" "$(printf '%s' "$line_text" | sed 's/^[[:space:]]*//' | cut -c1-160)"
    violations=$((violations + 1))
  done < <(grep -inIE "$qualified" "$file" || true)
done

if [ "$violations" -gt 0 ]; then
  echo
  echo "✗ forbidden-words lint: $violations violation(s) — a documentation surface made an unqualified trust claim."
  echo "  Fix: state the honest, tiered claim (tamper-EVIDENT, integrity+ordering+rewrite-detection), or negate the word."
  echo "  Genuine exceptions: <!-- forbidden-words-lint: allow -->"
  exit 1
fi

echo "✓ forbidden-words lint: clean (${#files[@]} file(s) checked)"
