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

- **2026-05-22 — h99 fix lands, first meaningful verify-rate**: re-ran verify.py
  against the post-fmo data after the workspace-rooted citation resolution
  fix. **verify_rate climbed 0% → 46.4%** (13 of 28 citations VERIFIED via
  ICO's compiled-wiki paths). Per-question signal granular: Q02 + Q03 at
  100% verified; Q04 + Q05 partial; Q01 ICO-flagged unverified on all 11.
  Substring-hits-in-answer metric: 9/12 across the bank (75%). The trend
  signal has shape now — future runs have a real floor to beat.
- **2026-05-21 — fmo fix lands**: same bank, same compiled wiki, re-run after
  the analyzeQuestion strict-then-broad + possessive-normalization fix.
  **5/5 questions engaged**, 28 citations, 48k tokens. Engagement signal
  went 0/5 → 5/5. The displayed verify_rate stays at 0% because of a
  separate verify.py paradigm gap (bead `intentional-cognition-os-h99`,
  P2) — ICO emits real wiki paths but verify.py greps the target tree.
  Once h99 lands, verify-rate will likely settle at 60-80% on this data.
- **2026-05-21 — v0.1 baseline**: first real run against `intent-eval-core`.
  5/5 questions hit ICO's no-knowledge fallback (verify-rate 0%) — found
  the analyzeQuestion retrieval gap (bead `intentional-cognition-os-fmo`,
  P1). Trend signal officially started.

## Trend

| run_id                                       | target           | qs  | citations | verified | verify_rate | tokens | friction | notes                                                                                                                                                         |
| -------------------------------------------- | ---------------- | --- | --------- | -------- | ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-05-22T0056Z-intent-eval-core-v1         | intent-eval-core | 5   | 0         | 0        | 0.0%        | 0      | 1        | [summary](runs/2026-05-22T0056Z-intent-eval-core-v1/summary.md) — every question hit ICO's no-knowledge fallback (analyzeQuestion retrieval gap)              |
| 2026-05-22T0257Z-intent-eval-core-v1-postfmo | intent-eval-core | 5   | 28        | 13       | 46.4%       | 48019  | 0        | [summary](runs/2026-05-22T0257Z-intent-eval-core-v1-postfmo/summary.md) — initial 0% was misleading per h99; updated after the workspace-rooted verify.py fix |
