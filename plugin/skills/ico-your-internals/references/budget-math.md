# Budget math

`scripts/estimate-budget.sh` produces an **upper bound** for what a run
will cost. Actual cost is typically 30–50% of the estimate, but we
deliberately overestimate so operators are never surprised by a bill.

## Inputs

| Variable    | How it's computed                                                            |
| ----------- | ---------------------------------------------------------------------------- |
| `md_files`  | `find <target> -name "*.md"` excluding node_modules / .git / dist / coverage |
| `words`     | Sum of `wc -w` across all md files                                           |
| `questions` | Count of `- id:` lines in the bank YAML                                      |

## Tokens

```
input_tokens_est   = words × 1.3                # 1.3 tokens per word (English avg)
compile_tokens_est = input_tokens_est × 6       # six ICO compiler passes
qa_tokens_est      = questions × 4000           # 4k tokens/Q allowance (in+out)
total_tokens_est   = compile_tokens_est + qa_tokens_est
```

The `× 6` factor over-counts because not every pass sees the full corpus —
in practice the extract/synthesize passes work on summaries, not raw text.
But for a budget gate we err high.

## Dollars

```
$ est = total_tokens_est × $5.40 / 1M
```

The $5.40 figure is a weighted avg of Sonnet 4.6 pricing:

- Input: $3 / 1M tokens
- Output: $15 / 1M tokens
- Weighting: 80% input / 20% output

If the dog-food workflow shifts toward more output-heavy passes (e.g.
report rendering), revise the weighting toward 60/40 → blended cost
becomes $7.80 / 1M.

## Confirmation thresholds

| Estimate      | Action                                                             |
| ------------- | ------------------------------------------------------------------ |
| ≤ $0.10       | Proceed silently (most small-corpus runs land here)                |
| $0.10 – $0.50 | Log the estimate but proceed                                       |
| $0.50 – $5.00 | Prompt via AskUserQuestion before proceeding                       |
| > $5.00       | Halt with explicit confirmation required + recommend `--dry` first |

## Calibration

After each real run, the `metrics.json` records `tokens_in` and `tokens_out`.
Periodically compare estimate vs actual across the last 10 runs:

```
estimate_accuracy = actual_total / estimate_total
```

If the accuracy ratio is consistently below 0.4 (i.e. we overestimate by
more than 2.5×), drop the `× 6` compile factor to `× 4` or revise the
4k-per-Q allowance downward. Don't update the math more often than once
per 20 runs — small-sample noise will mislead.
