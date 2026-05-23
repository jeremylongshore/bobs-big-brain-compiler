# ADR-031: Question-bank versioning — separate file per major version

**Status:** Accepted
**Date:** 2026-05-22
**Bead:** `intentional-cognition-os-p6w`

## Context

The v0.1 question-bank-spec already records that "bumping a question's
content is a breaking change because prior runs' verify-rates are no
longer comparable." The convention has been: bump `version:` and rename
the file (`intent-eval-core-v2.yaml`).

The v0.2 schema work prompted a re-examination: could we instead let a
single file evolve in place (e.g. `intent-eval-core.yaml` with a
`schema_version:` field bumped on breaking changes)? The argument for
single-file evolution is fewer files; the argument against is trend-
comparability — once a bank file's question content changes,
historical metric rows referencing "intent-eval-core.yaml v1" lose
their ground truth because the file no longer holds the v1 questions.

This ADR is here because the v0.2 PR introduces a NEW bank file
(`intent-eval-core-v2.yaml`) and we want the convention to be a
durable, written decision — not just a custom inherited from v0.1.

## Decision

**Reaffirm the existing convention: one file per major version of a
bank.** The v0.1 bank (`intent-eval-core-v1.yaml`) stays untouched
forever. The v0.2 bank lives at `intent-eval-core-v2.yaml` as a new
file. Future versions get `-v3.yaml`, `-v4.yaml`, etc.

Rules:

1. **A bank file is immutable once a run has cited it.** If a typo
   needs fixing in v1 after v1 has been used in a real run, file a
   bead, write `-v2.yaml`, and move forward — do NOT edit v1 in place.
2. **The `version:` field in the file matches the filename version.**
   No drift permitted; bank.py validates this.
3. **Trend comparability is the whole point.** Two trend rows
   referencing `intent-eval-core-v1` must be answering questions
   against the same ground truth. The file-per-version rule is what
   makes that true.
4. **Schema version (v1 vs v2 of the SHAPE) is separate from content
   version (v1 vs v2 of the QUESTIONS).** Both happen to bump
   together at v0.2 — the v2 shape introduction coincides with new
   v2 content — but they don't have to. v0.3 could ship
   `intent-eval-core-v3.yaml` with new questions in the same v2
   shape, OR with the same v2 questions in a new v3 shape.

## Consequences

### Positive

- **Trend metric integrity preserved.** A row in `progress.md`
  referencing `intent-eval-core-v1` will always reference the same
  questions, indefinitely.
- **Diff-friendly.** Reviewing what changed between v1 and v2 is a
  simple two-file diff; no git-blame archaeology to reconstruct what
  v1 used to say.
- **Multiple banks can run concurrently against the same target.** A
  v0.3 mode could run BOTH v1 and v2 banks against the same target
  and compare drift across schema generations.

### Negative

- More files in `dogfood/question-banks/`. Mitigated: file count is
  ~1 new bank per major version per target; total likely stays under
  50 for the project's lifetime.
- A small risk of authors not realizing they need to rev the version
  and editing v1 directly. Mitigated: bank.py emits a warning when
  the in-file `version:` doesn't match the filename version.

### Neutral

- Backward-compat support in code (loading both v1 and v2 banks) is
  not a consequence of this ADR — that's settled in ADR-029. This
  ADR is purely about file-naming and the immutability rule.

## Related ADRs

- ADR-029: Schema primitive — defines the v1 vs v2 shape difference.
- ADR-030: Paraphrase robustness metric — relies on stable per-bank
  ground truth for trend comparison.

- Jeremy Longshore
  intentsolutions.io
