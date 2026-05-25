# ADR-030: Paraphrase robustness metric — definition and side-by-side reporting rule

**Status:** Accepted
**Date:** 2026-05-22
**Bead:** `intentional-cognition-os-7xp`

## Context

The dog-food v0.2 schema (ADR-029) introduces multiple paraphrases per
intent. We need a metric that turns the new data into a trend signal —
specifically, a signal for **phrasing sensitivity**: "if I ask the same
thing a different way, does ICO still engage with verified evidence?"

The existing `verify_rate` is a per-citation rate: verified citations /
total citations across the whole run. It will still be reported, but it
can be high or low independent of phrasing-sensitivity. Two failure
modes the existing metric can't separate:

1. "ICO answered all 5 paraphrases of the same intent but only one
   produced verified citations" — verify_rate looks like 20% but the
   real story is 1/5 paraphrases worked.
2. "ICO answered 1 of 5 paraphrases with 5 verified citations and
   refused the other 4" — verify_rate looks like 100% but only 1/5
   paraphrases engaged at all.

The new metric must separate these. It must also be **reported
side-by-side** with verify_rate, not composited — averaging the two
hides the distinction we built the schema to surface.

Options considered for the metric name and shape:

- **`recall@paraphrases`** — borrows from IR (recall@k). Rejected:
  "recall" has precise IR semantics (true positives / relevant items)
  we don't want to overload. We're measuring something subtly
  different — "fraction of phrasings that engaged ICO at all", not
  "fraction of relevant items retrieved".
- **`paraphrase_engagement_rate`** — accurate but verbose. The word
  "engagement" is overloaded in product analytics.
- **`paraphrase_robustness`** — concise, semantically precise: "how
  robust is ICO to phrasing variance?" Selected.

Composite-vs-side-by-side considered:

- **Composite** (weighted avg of verify_rate + paraphrase_robustness):
  hides exactly the signal we want. Rejected.
- **Side-by-side** (two columns in progress.md, two fields in
  metrics.json): preserves diagnostic resolution. **Selected.**

## Decision

Adopt the metric **`paraphrase_robustness`**, defined as:

```
paraphrase_robustness =
    (# paraphrases that surfaced at least one VERIFIED citation)
  / (# paraphrases run in this execution)
```

- The numerator counts a paraphrase as "robust" if **at least one
  citation under that paraphrase verifies**. Not the citation count;
  just whether at least one stuck.
- The denominator is **paraphrases run**, not paraphrases declared.
  Under `--paraphrases primary`, denominator = number of intents. Under
  `--paraphrases all`, denominator = total paraphrases across the bank.
- Strict `>=` against any per-intent `recall_floor` threshold (advisory
  only in v0.2 — rendered in summary.md but NOT a CI gate).

Report side-by-side with `verify_rate` in:

- `dogfood/runs/<run-id>/metrics.json` — two top-level fields,
  `verify_rate` and `paraphrase_robustness`.
- `dogfood/runs/<run-id>/summary.md` — two separate headline rows.
- `dogfood/progress.md` — two adjacent columns in the trend table.

Never composite. Never average. The two metrics answer different
questions and must remain visually distinct.

## Consequences

### Positive

- **Headline metric directly measures the new schema's value.** If
  v0.2 doesn't move paraphrase_robustness, the v0.2 effort had no
  diagnostic effect — we want that clearly visible.
- **Separates citation-quality regressions from engagement
  regressions.** If verify_rate drops but paraphrase_robustness holds,
  the bug is in citation extraction. If paraphrase_robustness drops
  but verify_rate holds, the bug is in question understanding (fmo-
  family bug). These are different code paths.
- **Trend table preserves comparability**: v0.1 rows have
  `paraphrase_robustness = N/A` (rendered as `—`). New rows fill it in.
  No retroactive editing.

### Negative

- One more column to maintain in `progress.md`. Mitigated: machine-
  appended only; humans never edit the trend table.
- A run that uses `--paraphrases primary` exclusively cannot
  distinguish "phrasing variance is fine" from "didn't actually probe
  phrasing variance" — only `--paraphrases all` exercises the metric
  fully. We tag the runtime mode in `progress.md` so this stays
  honest.

### Neutral

- The metric depends on the receipt+verification pipeline correctly
  attributing each citation to its `intent_id` + `paraphrase_idx`.
  Wiring lives in `verify.py` (per-paraphrase rollup) and
  `render-summary.py` (per-intent grouping + global rollup).

## Related ADRs

- ADR-029: Schema primitive — defines the data structure this metric
  consumes.
- ADR-032: Runtime mode flag — defines how `--paraphrases primary|all`
  selects which paraphrases enter the metric's denominator.

- Jeremy Longshore
  intentsolutions.io
