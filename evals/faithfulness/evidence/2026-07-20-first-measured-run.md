# Compile-faithfulness eval — first measured on-box run (evidence)

Bead `intentional-cognition-os-l13.10`. This file is the **committed evidence**
for the "97% / N=10" faithfulness claim in PR and the seeded floor in
[`../faithfulness-floor.json`](../faithfulness-floor.json). Measured **on-box**
(the dev box holding `~/.teamkb`) on **2026-07-20** by running
`scripts/eval/bbb-compile-faithfulness.sh` against the live brain
(`~/.teamkb/brain`) — not synthetic, not invented.

## What was run

`ico eval run --spec evals/faithfulness/nightly-compile-faithfulness.eval.yaml`
against `~/.teamkb/brain` (sample 10, seed 1, `wiki_subdirs=[sources]`,
threshold 0.8), via the real CLI built from this repo.

## Run transcript (from `~/.local/state/bbb-compile-faithfulness/history.log`, ANSI-stripped)

```
2026-07-20T21:15:18Z  FAIL: eval produced no faithfulness result (rc=1)
    → path-resolution bug (spec resolved relative to the workspace, not the
      repo); fixed to pass the spec absolute.
2026-07-20T21:16:11Z  NO FLOOR YET: measured score=0 · grounded=0% over 0/10 scored
    (N=10) < 0.8 · judge=deepseek-chat · 0 judge tokens
    → the spec's default DeepSeek judge is UNFUNDED (HTTP 402 Insufficient
      Balance, verified by a direct client probe); it judged nothing. Switched
      the judge to MiniMax-M3 (the estate's compile-time model) over the
      Anthropic-compatible wire.
2026-07-20T21:19:15Z  NO FLOOR YET: measured score=0.9714285714285713 ·
    grounded=97% over 10/10 scored (N=10) ≥ 0.8 · judge=MiniMax-M3 ·
    23312 judge tokens (~$0.1307)
    → THIS is the seeding measurement. floor committed = 0.9714285714285713.
2026-07-20T21:20:54Z  PASS: faithfulness score=0.9800000000000001 >=
    floor=0.9714285714285713 · grounded=98% over 10/10 scored (N=10) ≥ 0.8 ·
    judge=MiniMax-M3 · 5557 judge tokens (~$0.0768)
    → second run, confirming the PASS path against the committed floor.
```

## Machine-readable report of the confirming (PASS) run

From `~/.local/state/bbb-compile-faithfulness/last-report.json`:

```json
{
  "score": 0.9800000000000001,
  "passed": true,
  "threshold": 0.8,
  "details": "grounded=98% over 10/10 scored (N=10) ≥ 0.8 · judge=MiniMax-M3 · 5557 judge tokens (~$0.0768)"
}
```

## Reading this

- **Seeded floor**: `0.9714285714285713` (the 97%, N=10 run). Regression below
  it exits nonzero → Slack `#cron-failures`.
- **Judge**: MiniMax-M3 (not the spec's DeepSeek — unfunded, HTTP 402).
- **Cost**: ~$0.08–0.13 per run (why it's a weekly floor-check tier, not on the
  hot compile path).
- The judge writes **no knowledge** into the brain — only the eval's own outputs
  (traces, an audit-log line, `compilations.faithfulness_tokens_used`).
