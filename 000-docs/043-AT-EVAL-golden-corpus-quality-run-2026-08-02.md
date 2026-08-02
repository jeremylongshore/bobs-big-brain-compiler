# Golden-corpus compile-quality runbook

**Status**: Active
**Owner**: compiler maintainers
**Tracking**: bead `intentional-cognition-os-l13.18`, GitHub #196, Plane ICOS-30

## Purpose

The package test suite intentionally mocks the model client. That makes the
compiler passes deterministic and inexpensive, but it cannot tell us whether
MiniMax produces useful summaries, concepts, or topics. This runbook defines
the separate real-pass evidence lane for that question.

The lane is manual by design: it is a `workflow_dispatch` job, uses the
committed `tests/fixtures/populated/raw` corpus, runs all six compile passes,
and scores one output from each of the summarize, extract, and synthesize
passes with the repository's compilation-quality rubrics.

## Run it

1. Set the repository secret `MINIMAX_API_KEY`.
2. Open **Actions → Golden Corpus Compile Quality → Run workflow**.
3. Wait for the **MiniMax-M3 real-pass quality run** job.
4. Download the `golden-corpus-<run-id>` artifact and inspect
   `golden-corpus-receipt.json`.

The workflow fails closed when the secret is missing, the provider cannot
complete a pass, an expected output is absent, or a rubric score is below its
threshold. It never turns a missing provider into a green skip.

For a local run, provide the key in the process environment and run:

```bash
MINIMAX_API_KEY=... pnpm eval:golden-corpus
```

The script also accepts `GOLDEN_CORPUS_ROOT` to choose a temporary output
directory and `GOLDEN_CORPUS_TIMEOUT` to adjust the per-command timeout. It
uses the Anthropic-compatible MiniMax endpoint by default because the OpenAI
wire can inline reasoning text into judge responses.

## Receipt interpretation

`golden-corpus-receipt.json` is the durable machine-readable result of the
run. It contains the provider/model identifier, phase exit codes, compiled
page counts, each rubric result, and the failure class when the run is not
green. It deliberately contains no API key and no raw secret-bearing process
environment.

The three rubric specs are:

- `evals/compilation-quality/summarize-attention.eval.yaml`
- `evals/compilation-quality/extract-concepts.eval.yaml`
- `evals/compilation-quality/synthesize-topic.eval.yaml`

The runner retargets those checked-in rubrics to actual pages produced during
the run. This keeps the rubric reviewable in Git while avoiding a false failure
when a model chooses a different valid concept or topic title.

## Evidence boundary

The receipt is evidence of one real provider run over the committed fixture;
it is not a claim that all possible corpora or prompts will score the same.
Unit-test counts and this receipt answer different questions and must not be
combined into a single quality percentage.
