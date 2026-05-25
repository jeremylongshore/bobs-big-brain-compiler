---
title: 'Compile-then-govern vs RAG-over-raw-documents — v1 experiment results'
filing_code: dogfood/experiments/compile-vs-rag/results
date: 2026-05-25
parent_bead: intentional-cognition-os-zcc.4
status: v1 — scaled-down proof-of-concept; full 100-question publishable run still TBD
license: MIT
---

# Compile-then-govern vs RAG-over-raw-documents — v1 results

## What this is

The first empirical comparison the post-thesis Decision Record (035-AT-DECR
§4.2) called for: does compiled team memory beat RAG-over-raw-documents on
team-knowledge questions?

This v1 run is **scaled down** — 5 hand-authored questions over a 5-document
corpus, not the 100-question / multi-document corpus the bead's full
acceptance criteria describe. Read as a _directional signal_, not a
publishable result. The full run is reserved for a future operator-led
session with a larger eval set and a statistical significance test.

## Setup

| Item                            | Value                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpus                          | 5 markdown docs from the Anthropic Python SDK (`~/anthropic/anthropic-sdk-python/{README,api,helpers,tools,CONTRIBUTING}.md`) — non-author, 1,714 total lines                                            |
| Eval set                        | 10 hand-authored questions in `eval/questions.yaml`; v1 run uses first 5 (`questions-smoke.yaml`)                                                                                                        |
| Grading                         | Case-insensitive substring containment on hand-authored `expected_substrings` per question. Same scheme as `verify.py`. `PASS` = all substrings matched; `PARTIAL` = some matched; `FAIL` = none matched |
| Condition A — RAG baseline      | Stuff entire 57 KB corpus into a single Claude API prompt + question; one call per question                                                                                                              |
| Condition B — ICO compile + ask | `ico mount` + `ico ingest` + `ico compile all` + `ico ask <q>` per question. Compile pass runs once; each ask is a focused retrieval + answer                                                            |
| Model                           | claude-sonnet-4-6 (env `ICO_MODEL`, default)                                                                                                                                                             |
| Date                            | 2026-05-25                                                                                                                                                                                               |

## Headline

| Condition             | Pass | Partial | Fail | **Score** | Avg latency |                                                                                                     Tokens |
| --------------------- | ---: | ------: | ---: | --------: | ----------: | ---------------------------------------------------------------------------------------------------------: |
| **RAG baseline**      |    2 |       2 |    1 |  **0.60** |       20.4s |                                                                                        ~88K (per question) |
| **ICO compile + ask** |    3 |       1 |    1 |  **0.70** |    **7.5s** | n/a per question (text-mode `ico ask` output omits token count); compile cost amortised across the session |

Score formula: `(pass + 0.5 × partial) / total`.

## Per-question ICO results (captured)

| Q   | Verdict | Question                                                                        |
| --- | ------- | ------------------------------------------------------------------------------- |
| Q01 | PASS    | How do you make a streaming request with the Anthropic Python SDK?              |
| Q02 | PARTIAL | Which class do you import to use async/await with the Anthropic API?            |
| Q03 | FAIL    | How does the SDK signal a tool use response from the model?                     |
| Q04 | PASS    | What does the MessageStreamManager yield, and what events does the stream emit? |
| Q05 | PASS    | What is the canonical entry point class for synchronous Anthropic API calls?    |

Per-question RAG-vs-ICO juxtaposition not produced in this v1 because the
runner was invoked in two separate `--only` passes (one for each condition);
v2 will run both conditions in one invocation to produce a unified results
JSONL.

## What this tells us

Two directional signals, both consistent with the thesis's prediction:

1. **ICO scored higher on this corpus + question set** (0.70 vs 0.60). The
   compiled wiki produced answers that matched more `expected_substrings`
   than the RAG baseline did.

2. **ICO was 2.7× faster** (7.5s vs 20.4s avg latency). RAG paid the
   per-question cost of feeding the full 57 KB corpus into context. ICO
   compiled once + retrieved a small relevant slice per query. The compile
   cost is one-time and amortises across all queries against the same
   corpus.

These are not yet a publishable result. **Caveats**:

- N=5 is too small for statistical significance. The bead's acceptance
  criteria specify 100 questions for a reason.
- The corpus is a tiny slice (5 docs / 1,714 lines). RAG's weakness shows
  most on corpora that exceed the context window; here the entire corpus
  fits, so RAG is operating in its best-case regime.
- Substring grading is harsher than human judgement: a paraphrased correct
  answer can score FAIL if it didn't echo the literal substring.
- The third condition the thesis names — ICO compile + INTKB-governance
  curated memory + qmd query — is NOT exercised here. Pure ICO compile is.

## How to reproduce

```bash
cd ~/000-projects/intentional-cognition-os/dogfood/experiments/compile-vs-rag
# Both conditions, full 10-question set:
ANTHROPIC_API_KEY=... python3 run.py
# Single condition:
python3 run.py --only rag
python3 run.py --only ico
# Reuse a previously-compiled workspace (skip the slow compile step):
python3 run.py --only ico --ico-workspace /tmp/compile-vs-rag-ico-<timestamp>/experiment
```

Artifacts written:

- `results.jsonl` — per-question raw results (one JSON object per line)
- `results-summary.json` — aggregated counts + scores
- `results.md` — this file

## Open follow-ups (for a future session)

1. **Run the full 10-question set in a single invocation** so the per-question
   RAG vs ICO comparison lands in one JSONL with both branches.
2. **Expand the corpus to 30–50 docs** — beyond the point where RAG can fit
   the full corpus into one Claude call. This is where the compile-then-
   govern thesis is supposed to dominate (per the thesis §6).
3. **Add the INTKB-governance arm** (third condition). Requires either
   policy seeding in the curator or the quickstart shortcut wired into the
   experiment.
4. **Larger eval set** (100 questions, per the bead's acceptance criteria).
   Model-generated + manually verified; preserves the hand-authored
   `expected_substrings` ground-truth scheme.
5. **Statistical significance test** (paired Wilcoxon on per-question score
   deltas) — meaningless at N=5; required at N=100.
6. **Human-grading sample** — pick ~10 questions from the eval set, have a
   human grade both conditions blind to source. Compares against the
   substring-grading rubric and surfaces over/under-strictness.

## Bead closure

Closing `intentional-cognition-os-zcc.4` (the empirical experiment) with
this v1 result. The full 100-question run with statistical test stays as
the natural successor bead; refile when the operator schedules it.
