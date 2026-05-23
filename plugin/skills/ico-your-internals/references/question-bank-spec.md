# Question-bank spec

A question bank is a YAML file under `dogfood/question-banks/<target>-v<N>.yaml`
in this repo. It defines the questions a dog-food run asks of ICO, plus the
ground truth the verify step checks against.

There are two schema versions, both supported by `bank.py`:

- **v1** — one `question:` string per entry. Used by `intent-eval-core-v1.yaml`.
- **v2** — one `intent:` plus a list-of-dicts `paraphrases:` per entry. Used by
  `intent-eval-core-v2.yaml` and later. Adds paraphrase-variance testing.

`bank.py` is the canonical loader. Anything that consumes a bank — ask-loop.py,
verify.py, render-summary.py — goes through `load_bank()` + `iter_prompts()`.

## File header (both versions)

```yaml
version: v1 | v2 # bump on any breaking change to content
target: intent-eval-core
target_path_hint: ~/000-projects/.../intent-eval-core
authored: 2026-05-22 # ISO date this version was authored
author: Jeremy Longshore
```

`version` and the filename must agree. Per ADR-031, bank files are
**immutable once cited** — fix typos by revving the filename, never by
in-place editing.

## v1 entry shape

```yaml
- id: Q01
  question: |
    What is intent-eval-core's role compared to intent-eval-lab?
  expected_substrings:
    - 'scoring'
    - 'lab'
  expected_sources:
    - CLAUDE.md
    - 000-docs/003-AT-ARCH-architecture.md
  verification_mode: strong
  notes: |
    Probes ICO's ability to articulate a project boundary.
```

| Field                 | Required                   | Meaning                                                                                                                               |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | yes                        | Stable identifier. **Never renumber** — append-only.                                                                                  |
| `question`            | yes                        | Free-text. Should be answerable from the target's docs alone.                                                                         |
| `expected_substrings` | yes for strong mode        | Substrings the verify step searches for in (a) ICO's answer (strong signal) and (b) the cited source (weak signal). Case-insensitive. |
| `expected_sources`    | recommended                | Source files ICO ought to cite. If empty, only substring presence is checked.                                                         |
| `verification_mode`   | optional, default `strong` | `strong` = check substrings + citations. `weak` = check citations only.                                                               |
| `notes`               | optional                   | Why this question is in the bank.                                                                                                     |

`bank.py` loads v1 entries as one synthetic primary paraphrase per intent
with `style: legacy`. v1 banks need no changes to keep working.

## v2 entry shape

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
  recall_floor: 0.6 # optional, per-intent — advisory only in v0.2
  notes: |
    The role boundary is documented across CLAUDE.md and the per-repo
    blueprint. Each paraphrase probes a different framing.
```

| Field                    | Required                   | Meaning                                                                                                                      |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | yes                        | Stable intent identifier. **Never renumber** — append-only.                                                                  |
| `intent`                 | yes                        | Free-text statement of WHAT the entry is probing. NOT what gets asked of ICO. Used for human reviewers.                      |
| `paraphrases`            | yes                        | Non-empty list-of-dicts. Each dict needs `text`, `style`, `primary` (see below).                                             |
| `paraphrases[*].text`    | yes                        | The actual question to ask ICO.                                                                                              |
| `paraphrases[*].style`   | yes                        | Free-text style label (e.g. `direct`, `leading`, `negative`, `comparative`, `open`). Used for per-style failure attribution. |
| `paraphrases[*].primary` | yes                        | Boolean. Exactly ONE paraphrase per intent must be `primary: true`. Enforced at load time.                                   |
| `expected_substrings`    | yes for strong mode        | **Per-intent** (NOT per-paraphrase). Paraphrases share ground truth by definition.                                           |
| `expected_sources`       | recommended                | Per-intent. Source files ICO ought to cite.                                                                                  |
| `verification_mode`      | optional, default `strong` | Per-intent.                                                                                                                  |
| `recall_floor`           | optional                   | Per-intent. Float in [0,1]. Advisory threshold for paraphrase_robustness — rendered in summary.md but NOT a CI gate in v0.2. |
| `notes`                  | optional                   | Per-intent.                                                                                                                  |

See ADR-029 for the schema rationale and ADR-030 for the metric this primitive feeds.

## Runtime mode — `--paraphrases primary|all`

Run.sh's `--paraphrases` flag selects which paraphrases enter the ask loop:

- `--paraphrases primary` (default): one ask per intent (the primary paraphrase). Cost-equivalent to v0.1 (~$0.20 on a 5-intent bank).
- `--paraphrases all`: every declared paraphrase per intent. Scales linearly with paraphrase count (~$1 on a 5×5 bank).

The mode is stamped into manifest.json and the `progress.md` row so trend comparison stays honest. See ADR-032.

## Authoring guidelines

- **Hand-author against the actual repo state.** Open the target's docs and write
  questions you ALREADY know the answers to. The point is ground truth.
- **Keep `expected_substrings` short and specific.** Long phrases will rarely match
  verbatim; aim for 1–3 word distinctive terms.
- **Don't over-constrain `expected_sources`.** If a question can be answered from
  any of three docs, list all three.
- **Bias toward boundaries.** Questions that probe project boundaries, role
  definitions, exit-code contracts, schema fields — the kind of thing where a
  wrong answer is unambiguously wrong.
- **Cover both shallow and deep questions.** A 5-intent bank should mix: 2
  surface-level, 2 cross-doc synthesis, 1 contradiction probe.
- **v2 paraphrases should differ in surface form, not in meaning.** A paraphrase
  whose answer is actually different is a NEW intent, not a paraphrase.
- **Designate one primary per intent.** That paraphrase is what runs in the
  default cheap mode and what shows up in cost-bounded baselines.

## Anti-patterns

- ❌ Questions whose answers are time-sensitive ("what's the latest version?")
- ❌ Questions about content not in the docs ("what does the author think about X?")
- ❌ Expected substrings that are too generic ("the", "system", "code")
- ❌ Renumbering ids. Append-only.
- ❌ Editing a bank file after it has been used in a real run — bump the version + rev the filename.
- ❌ Mixing v1 and v2 shapes inside the same file (bank.py rejects this at load time).
- ❌ Zero or multiple `primary: true` paraphrases under one intent (bank.py rejects).
