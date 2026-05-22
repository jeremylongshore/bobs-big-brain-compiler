# Dog-food progress trend

Two sections below: **Milestones** (human-written, append-only, marks
significant inflection points) and **Trend** (machine-appended one-line-
per-run data table — never edit by hand; the skill writes new rows on run
completion).

Different cadences, different owners, different shapes — but they sit
together because the milestones explain the rows around them. Mirrors
keep-a-changelog's spirit (human narrative above machine data) without
conflating per-run rows with release notes.

The single most important column in the trend is **verify_rate**:
citations whose claim substring was found in the cited source, divided by
total citations.

## Milestones

Append-only — newest at top. One line per inflection point in the
dog-food signal. Examples of what belongs here: first non-zero verify-
rate, a step change in friction-count, an ICO bug fix that unblocks a
class of questions, a new target type successfully exercised.

- **2026-05-21 — v0.1 baseline**: first real run against `intent-eval-core`.
  5/5 questions hit ICO's no-knowledge fallback (verify-rate 0%) — found
  the analyzeQuestion retrieval gap (bead `intentional-cognition-os-fmo`,
  P1). Trend signal officially started.

## Trend

| run_id                               | target           | qs  | citations | verified | verify_rate | tokens | friction | notes                                                                                                                                            |
| ------------------------------------ | ---------------- | --- | --------- | -------- | ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-05-22T0056Z-intent-eval-core-v1 | intent-eval-core | 5   | 0         | 0        | 0.0%        | 0      | 1        | [summary](runs/2026-05-22T0056Z-intent-eval-core-v1/summary.md) — every question hit ICO's no-knowledge fallback (analyzeQuestion retrieval gap) |
