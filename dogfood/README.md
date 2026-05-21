# dogfood/ — eating our own cooking

This directory tracks every time we run `intentional-cognition-os` against a real
codebase (starting with our own). It is the receipts trail: if someone asks
"is ICO a real product or vaporware?", point them here.

## What's tracked

| File                           | Contents                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `JOURNAL.md`                   | Human-written narrative log. One entry per session. What we tried, what we learned, what we'd do next time.           |
| `progress.md`                  | Machine-appended one-line-per-run trend table. Pure metrics — verify-rate, count, tokens, friction-count. No content. |
| `question-banks/*.yaml`        | Versioned question/answer pairs per target. Reusable across runs so we can see trends.                                |
| `runs/<run-id>/summary.md`     | Per-run rollup. Sanitized — counts + bead candidates, no raw answer content.                                          |
| `runs/<run-id>/metrics.json`   | Per-run machine-readable summary. Aggregatable by intent-eval-lab once that lands.                                    |
| `runs/<run-id>/friction.jsonl` | Bugs surfaced in ICO itself during this run. These become bead candidates.                                            |

## What is NOT tracked here

Raw answer content, source-grep evidence, full receipts, per-API-call cost ledgers,
and the compiled wiki for each run live in `~/.cache/ico-your-internals/` —
**outside this repo entirely**. The skill enforces the split.

| Local-only artifact                | Why it isn't committed                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.cache/.../workspace/`          | The compiled wiki echoes source text. If a future dog-food target is a client repo or private codebase, committing this would leak it. |
| `~/.cache/.../receipts.jsonl`      | Full Q answers can echo source text verbatim.                                                                                          |
| `~/.cache/.../verifications.jsonl` | Source-grep evidence definitely echoes source text.                                                                                    |
| `~/.cache/.../cost.jsonl`          | Per-API-call token + cost detail is more granular than we want public.                                                                 |

`.gitignore` blocks `dogfood/runs/*/workspace/` as a belt-and-suspenders against
accidentally moving a workspace into the repo.

## The progress signal

One number per run: **citation-verify rate** = (citations whose claim substring was
found in the cited source) / (total citations). Tracked over time in `progress.md`.

**What it catches**: hallucinated citations, wrong-source citations, total compile
failures, schema drift in the wiki.

**What it misses**: cases where ICO cites a real source that _mentions_ the topic
but ICO interprets it wrong. For that, we use hand-authored question banks with
known correct answers (the `expected_substrings` field) as a strong signal.

## How to run a dog-food session

```bash
# Run the skill via Claude Code (see plugin/skills/ico-your-internals/):
/ico-your-internals --target intent-eval-core

# Or directly via the script (after plugin install):
plugin/skills/ico-your-internals/scripts/run.sh \
  --target ~/000-projects/intent-eval-platform/intent-eval-core \
  --bank dogfood/question-banks/intent-eval-core-v1.yaml
```

The skill creates `~/.cache/ico-your-internals/runs/<run-id>/`, runs ICO end-to-end
against the target (read-only mount), produces the local-only artifacts, then
copies the public-safe artifacts back into `dogfood/runs/<run-id>/` here for
review and commit.

## When to commit a run

After every successful run **whose receipts you've eyeballed and approved as
free of sensitive content**:

```bash
git add dogfood/runs/<run-id>/ dogfood/progress.md dogfood/JOURNAL.md
git commit -m "dogfood: run N against <target> — <verify-rate>% verified"
```

The skill never auto-commits. The author owns every commit decision.
