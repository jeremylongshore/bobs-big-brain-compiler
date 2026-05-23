# ADR-032: Paraphrase runtime mode — `--paraphrases primary|all`

**Status:** Accepted
**Date:** 2026-05-22
**Bead:** `intentional-cognition-os-ytq`

## Context

The v0.2 schema (ADR-029) declares up to N paraphrases per intent.
Running every paraphrase in every dog-food run is expensive: at 5
intents × 5 paraphrases × ~4k tokens per ask, a single full run
costs ~$1, vs ~$0.20 for the v0.1 "one ask per intent" mode.

We want both:

1. A **cheap default** that matches v0.1's cost shape so the daily
   dog-food cadence stays roughly equivalent.
2. An **opt-in full-paraphrase mode** for when phrasing-sensitivity
   is the explicit subject of the run (regression test, before/after
   ICO refactor, blog-post baseline, etc.).

We also need this flag to be a clear runtime concern — NOT a content
concern. Same bank file, two modes of consuming it.

## Decision

Add a `--paraphrases primary|all` flag to `run.sh`, defaulting to
`primary`.

- **`--paraphrases primary`** (default): for each intent in the
  bank, ask ONE question — the paraphrase flagged `primary: true`.
  Cost-equivalent to v0.1 (~$0.20/run on the standard 5-intent bank).
- **`--paraphrases all`**: for each intent, ask EVERY declared
  paraphrase in `paraphrase_idx` order. Cost scales linearly with
  paraphrase count (~$1/run on a 5×5 bank).

Receipts carry `intent_id`, `paraphrase_idx`, `paraphrase_text`,
`paraphrase_style` regardless of mode. (Under `primary`, the
`paraphrase_idx` field is whatever the primary's index was — usually
0.)

The runtime mode is stamped into the run's `manifest.json` and
surfaced in the `progress.md` row so trend comparison is unambiguous.

Backward compat:

- v1 banks (no `paraphrases:` field) are treated by bank.py as having
  one synthetic paraphrase per intent with `primary: true`. Both
  modes (`primary` and `all`) ask exactly one question per intent
  when running a v1 bank — they're functionally equivalent. No
  user-visible behavior change for v1 consumers.

## Consequences

### Positive

- **Daily cadence stays cheap.** Default mode preserves the existing
  cost shape — operator doesn't need to gatekeep budget on every run.
- **Robustness probing is one flag away.** Opt-in mode preserves the
  ability to spend $1 when phrasing-sensitivity is the question.
- **Manifest stamping prevents trend drift.** A mode-tagged row in
  `progress.md` makes it visible whether a delta in
  `paraphrase_robustness` came from real signal or just from changing
  the denominator.

### Negative

- Operators may forget to set `--paraphrases all` when intending to
  probe phrasing-sensitivity, get a `primary`-mode result, and
  misinterpret the data. Mitigated: progress.md row carries the
  mode tag; summary.md headline calls out the mode explicitly.
- The `primary` designation in the schema becomes load-bearing — if
  no paraphrase is flagged `primary: true`, the bank is invalid under
  `--paraphrases primary`. bank.py enforces "exactly one primary per
  intent" at schema validation, so this fails loudly at parse time,
  not silently at runtime.

### Neutral

- The flag accepts only these two values in v0.2. Future modes
  (`--paraphrases random=K`, `--paraphrases by-style=direct`, etc.)
  can layer on as additive options without changing the existing two.

## Related ADRs

- ADR-029: Schema primitive — defines the `primary: true` field this
  flag depends on.
- ADR-030: Paraphrase robustness metric — the metric's denominator
  depends on which paraphrases this flag actually runs.

- Jeremy Longshore
  intentsolutions.io
