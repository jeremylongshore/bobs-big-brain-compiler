# Receipt schema

The dog-food run keeps its raw streams and private manifest in the local cache.
`render-summary.py` creates a separate allowlisted, redacted publication bundle.

## `~/.cache/ico-your-internals/runs/<run-id>/receipts.jsonl` (local only)

One line per question, full answer content. **Never committed** — answer
text can echo source verbatim.

```json
{
  "run_id": "2026-05-20T2100-intent-eval-core-v1",
  "q_id": "Q01",
  "intent_id": "Q01",
  "paraphrase_idx": 0,
  "paraphrase_text": "What is intent-eval-core's role compared to intent-eval-lab?",
  "paraphrase_style": "direct",
  "primary": true,
  "question": "What is intent-eval-core's role compared to intent-eval-lab?",
  "answer": "intent-eval-core handles scoring … [source: CLAUDE.md] … while intent-eval-lab is the experimentation surface [source: 000-docs/003-AT-ARCH-architecture.md].",
  "citations": [
    { "source": "CLAUDE.md", "marker_line": null },
    { "source": "000-docs/003-AT-ARCH-architecture.md", "marker_line": null }
  ],
  "trace_correlation_id": "ask-7f3a8b21",
  "tokens_in": 1240,
  "tokens_out": 187,
  "latency_ms": 4218,
  "model": "claude-sonnet-4-6",
  "timestamp": "2026-05-20T21:03:14Z",
  "expected_substrings": ["scoring", "lab"],
  "expected_sources": ["CLAUDE.md", "000-docs/003-AT-ARCH-architecture.md"]
}
```

v0.2 fields:

- `intent_id` — stable intent identifier (matches `id:` in the bank file). On
  v1 banks this is just the q_id.
- `paraphrase_idx` — 0-based position of the paraphrase under its intent.
  v1 banks always have `paraphrase_idx = 0` (single synthetic primary).
- `paraphrase_text` — the exact text that was asked (== `question` in v1).
- `paraphrase_style` — the style label declared in the bank (e.g. `direct`,
  `leading`, `legacy` for v1-synthesized paraphrases).
- `primary` — whether this paraphrase was flagged primary in the bank.

`q_id` is preserved for backward compatibility — older verify.py /
render-summary.py readers still consume it. `intent_id` is the v0.2 canonical
name; new code should prefer it.

## `~/.cache/ico-your-internals/runs/<run-id>/verifications.jsonl` (local only)

One line per (question, citation) pair. Contains grep evidence from the
source — never committed.

```json
{
  "run_id": "2026-05-20T2100-intent-eval-core-v1",
  "q_id": "Q01",
  "intent_id": "Q01",
  "paraphrase_idx": 0,
  "paraphrase_style": "direct",
  "citation_idx": 0,
  "cited_source": "CLAUDE.md",
  "verdict": "VERIFIED",
  "hits": [
    {
      "substring": "scoring",
      "line": 42,
      "evidence_grep": "L42: scoring engine that consumes eval outputs..."
    }
  ],
  "expected_substring_count": 2,
  "matched_count": 1,
  "score": 0.5
}
```

Every verification line in v0.2 carries `intent_id`, `paraphrase_idx`, and
`paraphrase_style` so render-summary can group by paraphrase for the
`paraphrase_robustness` rollup (ADR-030).

Verdicts: `VERIFIED` (≥1 expected_substring hit in source), `CHALLENGED`
(source exists but no substring matched), `UNVERIFIED` (source missing,
malformed, rejected, or outside the target/workspace containment boundary).

## `~/.cache/ico-your-internals/runs/<run-id>/friction.jsonl` (local only)

Raw compiler and question-loop diagnostics. This file may include absolute paths
or upstream stderr and must never be committed directly.

## `dogfood/runs/<run-id>/friction.jsonl` (redacted public copy)

One line per error / timeout / lint warning. These are bead candidates.

```json
{
  "run_id": "2026-05-20T2100-intent-eval-core-v1",
  "stage": "compile",
  "severity": "error",
  "message": "compile pass synthesize timed out after 180s",
  "exit_code": null,
  "recommend_bead": true
}
```

`stage` values: `init`, `mount`, `ingest`, `compile`, `ask`, `verify`, `render`.
`severity`: `error`, `warning`, `notice`.
`recommend_bead`: whether the operator should consider filing this as a bead
on the ICO repo.

The renderer allowlists these fields, replaces known private paths, redacts
common credential shapes, flattens line breaks, and caps messages at 500
characters. Review the rendered file before committing because heuristic
redaction cannot prove arbitrary upstream diagnostics are disclosure-free.

## `dogfood/runs/<run-id>/metrics.json` (committed — public)

Single JSON document per run. Aggregated counts + per-question rollups.
**No raw answer text**, only counts and shape data.

```json
{
  "run_id": "2026-05-20T2100-intent-eval-core-v2",
  "target": "intent-eval-core",
  "target_slug": "intent-eval-core",
  "bank_version": "v2",
  "ico_version": "1.3.0",
  "started_at": "2026-05-22T21:03:00Z",
  "paraphrases_mode": "all",
  "intents": 5,
  "questions": 25,
  "total_citations": 60,
  "verified": 45,
  "challenged": 10,
  "unverified": 5,
  "verify_rate": 0.75,
  "paraphrases_run": 25,
  "paraphrases_robust": 22,
  "paraphrase_robustness": 0.88,
  "tokens_in": 31000,
  "tokens_out": 4700,
  "friction_count": 2,
  "per_question": [
    {
      "q_id": "Q01",
      "intent_id": "Q01",
      "paraphrase_idx": 0,
      "paraphrase_style": "direct",
      "primary": true,
      "citations": 2,
      "verified": 2,
      "challenged": 0,
      "unverified": 0,
      "expected_substrings": 2,
      "substrings_hit_in_answer": 2,
      "tokens_in": 1240,
      "tokens_out": 187,
      "latency_ms": 4218
    }
  ]
}
```

v0.2 top-level fields:

- `paraphrases_mode` — `primary` or `all`. From run.sh's --paraphrases flag.
- `intents` — count of distinct `intent_id` values seen this run.
- `paraphrases_run` — count of distinct (intent_id, paraphrase_idx) pairs.
- `paraphrases_robust` — paraphrases that surfaced ≥1 VERIFIED citation.
- `paraphrase_robustness` — `paraphrases_robust / paraphrases_run`. Reported
  **side-by-side** with `verify_rate`, never composited (ADR-030).

`per_question` entries carry `intent_id`, `paraphrase_idx`, `paraphrase_style`,
and `primary` so consumers can group + render by paraphrase.

## `dogfood/runs/<run-id>/manifest.json` (committed — public)

An allowlist containing only `run_id`, `target_slug`, `bank_version`,
`ico_version`, `started_at`, `paraphrases_mode`, and `asks_planned`. The private
cache manifest additionally contains absolute target, bank, and workspace paths;
never copy that source file into the publication directory.

## `dogfood/progress.md` (committed — public)

One row appended per run. The cross-run trend signal.

```
| run_id                              | target           | intents | paraphrases | citations | verified | verify_rate | paraphrase_robustness | tokens | friction | notes |
| ----------------------------------- | ---------------- | ------- | ----------- | --------- | -------- | ----------- | --------------------- | ------ | -------- | ----- |
| 2026-05-22T2100Z-intent-eval-core-v2 | intent-eval-core |       5 |          25 |        60 |       45 | 75.0%       | 88.0%                 | 35700  |        2 | [summary](...) (`--paraphrases all`) |
```

The trend table reports `verify_rate` and `paraphrase_robustness` in
**adjacent columns** — never as a composite. Per ADR-030.
