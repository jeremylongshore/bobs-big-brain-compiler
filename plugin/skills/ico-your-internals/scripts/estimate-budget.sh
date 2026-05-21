#!/usr/bin/env bash
# estimate-budget.sh — rough token + cost estimate for a dog-food run.
#
# Usage: estimate-budget.sh <target-path> <bank.yaml>
#
# Outputs JSON to stdout:
#   { "md_files": N, "words": N, "input_tokens_est": N, "questions": N,
#     "qa_tokens_est": N, "total_tokens_est": N, "dollar_est": "0.XX" }
#
# Math (deliberately conservative — meant as an upper bound):
#   words            = total words across .md files in target
#   input_tokens_est = words * 1.3                       (1 word ~= 1.3 tokens)
#   compile_tokens   = input_tokens_est * 6              (six compiler passes)
#   qa_tokens_est    = questions * 4000                  (4k tokens per Q allowance)
#   total            = compile_tokens + qa_tokens_est
#   $ est            = total * $3 / 1M (Sonnet rough avg of input + output)
#
# These are upper bounds. Actual ICO usage will be lower; the goal is to
# flag any run > $0.50 for explicit operator confirmation before kickoff.

set -euo pipefail

target="${1:?usage: estimate-budget.sh <target-path> <bank.yaml>}"
bank="${2:?usage: estimate-budget.sh <target-path> <bank.yaml>}"

[ -d "$target" ] || { echo "target not a directory: $target" >&2; exit 1; }
[ -f "$bank" ]   || { echo "bank not a file: $bank" >&2; exit 1; }

# Count .md files + words (excluding node_modules, .git, dist, coverage).
# Stream through `find -exec wc -w {} +` rather than expanding into a shell
# argv array — large corpora would hit E2BIG (per Gemini PR #77 review).
md_count=$(find "$target" -type f -name "*.md" \
  -not -path "*/node_modules/*" -not -path "*/.git/*" \
  -not -path "*/dist/*" -not -path "*/coverage/*" 2>/dev/null | wc -l)

words=0
if [ "$md_count" -gt 0 ]; then
  # `wc -w ... {} +` may produce a trailing 'total' line; sum the first
  # column of all non-total rows so partial-batch totals are handled too.
  words=$(find "$target" -type f -name "*.md" \
    -not -path "*/node_modules/*" -not -path "*/.git/*" \
    -not -path "*/dist/*" -not -path "*/coverage/*" \
    -exec wc -w {} + 2>/dev/null \
    | awk '$2 != "total" {sum += $1} END {print sum+0}')
fi

# Question count from the bank (count `- id:` lines as a rough proxy)
questions=$(grep -c "^  - id:" "$bank" 2>/dev/null || echo 0)
# Strip any extraneous chars
questions="${questions//[^0-9]/}"
questions="${questions:-0}"

# Math
input_tokens_est=$(( words * 13 / 10 ))
compile_tokens=$(( input_tokens_est * 6 ))
qa_tokens_est=$(( questions * 4000 ))
total_tokens_est=$(( compile_tokens + qa_tokens_est ))

# Sonnet 4.6 rough avg pricing $3 input + $15 output / 1M tokens; assume 80/20 split
# Effective avg ~= 0.8 * 3 + 0.2 * 15 = 5.4
# Cost = total * 5.4 / 1e6
dollar_micros=$(( total_tokens_est * 54 / 10 ))     # micro-dollars (54 = 5.40 * 10)
dollar_int=$(( dollar_micros / 1000000 ))
dollar_frac=$(( (dollar_micros % 1000000) / 10000 ))
dollar_est=$(printf "%d.%02d" "$dollar_int" "$dollar_frac")

cat <<EOF
{
  "md_files": $md_count,
  "words": $words,
  "input_tokens_est": $input_tokens_est,
  "compile_tokens_est": $compile_tokens,
  "questions": $questions,
  "qa_tokens_est": $qa_tokens_est,
  "total_tokens_est": $total_tokens_est,
  "dollar_est": "$dollar_est",
  "model_assumed": "claude-sonnet-4-6",
  "pricing_basis": "Sonnet 4.6 \$3/1M input + \$15/1M output, 80/20 split assumed"
}
EOF
