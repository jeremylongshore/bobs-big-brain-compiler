# Question-bank spec

A question bank is a YAML file under `dogfood/question-banks/<target>-v<N>.yaml`
in the target's repo. It defines the questions a dog-food run asks of ICO, plus
the ground truth the verify step checks against.

## File header

```yaml
version: v1 # bump on any breaking change to content
target: intent-eval-core # name of the target project
target_path_hint: ~/000-projects/.../intent-eval-core
authored: 2026-05-20 # ISO date this version was authored
author: Jeremy Longshore
```

`version` matters: changing a question's content is a breaking change because
prior runs' verify-rates are no longer comparable. Bump the version and
rename the file (`-v2.yaml`) to preserve historical comparability.

## Question entry

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
    Probes ICO's ability to articulate a project boundary that lives in
    CLAUDE.md but is also reinforced in the architecture doc.
```

| Field                 | Required                   | Meaning                                                                                                                                          |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | yes                        | Stable identifier. **Never renumber** — append-only.                                                                                             |
| `question`            | yes                        | Free-text. Should be answerable from the target's docs alone.                                                                                    |
| `expected_substrings` | yes for strong mode        | Substrings the verify step searches for in (a) ICO's answer (strong signal) and (b) the cited source (weak signal). Case-insensitive.            |
| `expected_sources`    | recommended                | Source files ICO ought to cite. If empty, only substring presence is checked.                                                                    |
| `verification_mode`   | optional, default `strong` | `strong` = check substrings + citations. `weak` = check citations only (use for questions where the answer text varies but the source is fixed). |
| `notes`               | optional                   | Why this question is in the bank. What in ICO it's probing.                                                                                      |

## Authoring guidelines

- **Hand-author against the actual repo state.** Open the target's docs and write questions you ALREADY know the answers to. The point is ground truth.
- **Keep `expected_substrings` short and specific.** Long phrases will rarely match verbatim; aim for 1–3 word distinctive terms.
- **Don't over-constrain `expected_sources`.** If a question can be answered from any of three docs, list all three. ICO is free to cite any one.
- **Bias toward boundaries.** Questions that probe project boundaries, role definitions, exit-code contracts, schema fields — the kind of thing where a wrong answer is unambiguously wrong.
- **Cover both shallow and deep questions.** A 5-question bank should mix: 2 surface-level (find-in-CLAUDE.md), 2 cross-doc synthesis (multiple sources needed), 1 contradiction probe (where ICO might disagree with itself).

## Anti-patterns

- ❌ Questions whose answers are time-sensitive ("what's the latest version?") — these go stale faster than ICO.
- ❌ Questions about content not in the docs ("what does the author think about X?") — ICO will hallucinate; verify will fail without surfacing why.
- ❌ Expected substrings that are too generic ("the", "system", "code") — false positives on every source.
- ❌ Renumbering Q-ids. If you delete a question, leave a placeholder; if you add one, append. Stable ids let progress.md compare apples to apples.
