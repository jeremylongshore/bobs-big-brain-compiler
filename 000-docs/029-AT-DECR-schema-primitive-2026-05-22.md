# ADR-029: Question-bank v0.2 schema primitive — intent + paraphrases-as-list-of-dicts

**Status:** Accepted
**Date:** 2026-05-22
**Bead:** `intentional-cognition-os-er2`

## Context

The v0.1 question-bank schema records one `question:` string per `id`. The
v0.1 dog-food run produced one strong signal (`fmo`) and one tooling signal
(`h99`), but it cannot test **phrasing sensitivity**: does ICO still engage
when the same intent is asked with a different surface form? Today, if a
user asks "What does X do?" tomorrow instead of "What is X's role?", we
don't know whether ICO will still surface verified citations.

We need a schema primitive that:

1. Captures multiple surface phrasings of the same intent without
   duplicating ground truth (`expected_substrings`, `expected_sources`
   stay per-intent).
2. Lets us designate ONE canonical phrasing as `primary` so the cheap
   default mode (`--paraphrases primary`) is reproducible across runs.
3. Lets us attribute failure per surface style ("rhetorical question
   phrasing fails 80% of the time" is a real diagnostic, not just an
   averaged failure rate).
4. Is loadable from v1 files without modification (backward compat).
5. Rejects half-converted ("mixed") files at schema validation —
   silent partial migrations corrupt the trend metric.

Options considered:

- **A. List-of-strings**: `paraphrases: ["text 1", "text 2"]`. Simplest.
  Loses primary designation and per-style failure attribution.
- **B. Dict-of-styles**: `paraphrases: {direct: "...", rhetorical: "..."}`.
  Style becomes the key — convenient but couples style to identity. Two
  paraphrases of the same style get awkward keys (`rhetorical_1`,
  `rhetorical_2`).
- **C. List-of-dicts**: `paraphrases: [{text, style, primary}]`. Stable
  positional index (`paraphrase_idx`), explicit primary flag, style as a
  data field (not a key — same style can appear multiple times naturally).

## Decision

Adopt option C — **list-of-dicts** with `text` (required), `style`
(required, free-text but recommended from a small vocabulary), and
`primary` (required, boolean — exactly one paraphrase per intent has
`primary: true`).

```yaml
- id: Q01
  intent: |
    Probe whether ICO can articulate intent-eval-core's kernel-only role.
  paraphrases:
    - text: "What is intent-eval-core's role inside the platform?"
      style: direct
      primary: true
    - text: 'How does intent-eval-core differ from intent-eval-lab?'
      style: comparative
      primary: false
    - text: 'What does intent-eval-core explicitly NOT do?'
      style: negative
      primary: false
    - text: 'Could you walk me through where intent-eval-core fits?'
      style: open
      primary: false
    - text: 'intent-eval-core is the scoring kernel, right?'
      style: leading
      primary: false
  expected_substrings:
    - 'kernel'
    - 'contracts'
    - 'no runtime'
  expected_sources:
    - CLAUDE.md
    - 000-docs/002-AT-ARCH-repo-blueprint-2026-05-18.md
  verification_mode: strong
  recall_floor: 0.6 # optional, per-intent
  notes: |
    The role boundary is documented across CLAUDE.md and the per-repo
    blueprint. Each paraphrase probes a different framing.
```

`expected_substrings` and `expected_sources` stay **per-intent**, NOT
per-paraphrase, because paraphrases share ground truth by definition.
(Per-paraphrase overrides are reserved for v0.3 if data demands it.)

The v1 schema (`question:` instead of `intent: + paraphrases:`) remains
loadable: `bank.py:load_bank()` treats a v1 file as "one intent, one
paraphrase, primary=true, style='legacy'". Existing v1 banks need no
changes.

## Consequences

### Positive

- **Stable identity per paraphrase**: positional index `paraphrase_idx`
  is durable across runs — if `paraphrases[2]` regresses, comparing the
  same `intent_id` + `paraphrase_idx` across run-A and run-B isolates
  the regression to the same surface form.
- **Per-style failure attribution**: `style: leading` failing while
  `style: direct` succeeds tells us ICO is brittle on a specific
  rhetorical pattern, not just generically.
- **Single primary, deterministic default cost**: `--paraphrases primary`
  runs exactly N asks per N intents (same cost shape as v0.1).
- **Schema-level enforcement of well-formedness**: bank.py rejects a
  bank where two paraphrases under the same intent both claim
  `primary: true`, or where zero do. Catches authoring drift early.

### Negative

- More verbose YAML — five-line dict per paraphrase vs one-line string.
  Mitigated: existing intents migrate by hand once; new intents follow
  the template.
- Authoring discipline required: we ask authors to assign a `style`
  label per paraphrase. Free-text is permitted (we don't enum-restrict
  in v0.2) to avoid premature vocabulary lockdown. v0.3 may freeze a
  vocab once enough data is in.

### Neutral

- Loading v2 banks costs ~5x more memory than v1 (5 strings vs 1) —
  immaterial at our scale (5 intents × 5 paraphrases = 25 strings).

## Related ADRs

- ADR-030: Paraphrase robustness metric — defines how this primitive
  feeds the new headline metric.
- ADR-031: Bank versioning, file-per-version — reaffirms that v1 and
  v2 banks live in separate files for trend comparability.
- ADR-032: Paraphrase runtime mode flag — defines how the runtime
  consumes this primitive.

- Jeremy Longshore
  intentsolutions.io
