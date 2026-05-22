# Dog-food progress trend

Machine-appended one-line-per-run trend table. Never edit by hand — the
skill writes new rows on completion of each dog-food run.

The single most important column is **verify_rate**: citations whose claim
substring was found in the cited source, divided by total citations.

| run_id                               | target           | qs  | citations | verified | verify_rate | tokens | friction | notes                                                                                                                                            |
| ------------------------------------ | ---------------- | --- | --------- | -------- | ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-05-22T0056Z-intent-eval-core-v1 | intent-eval-core | 5   | 0         | 0        | 0.0%        | 0      | 1        | [summary](runs/2026-05-22T0056Z-intent-eval-core-v1/summary.md) — every question hit ICO's no-knowledge fallback (analyzeQuestion retrieval gap) |
