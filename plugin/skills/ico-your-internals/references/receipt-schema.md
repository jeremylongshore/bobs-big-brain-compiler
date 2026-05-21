# Receipt schema

The dog-food run produces five JSONL streams. Three live locally only;
two are sanitized and committed.

## `~/.cache/ico-your-internals/runs/<run-id>/receipts.jsonl` (local only)

One line per question, full answer content. **Never committed** — answer
text can echo source verbatim.

```json
{
  "run_id": "2026-05-20T2100-intent-eval-core-v1",
  "q_id": "Q01",
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

## `~/.cache/ico-your-internals/runs/<run-id>/verifications.jsonl` (local only)

One line per (question, citation) pair. Contains grep evidence from the
source — never committed.

```json
{
  "run_id": "2026-05-20T2100-intent-eval-core-v1",
  "q_id": "Q01",
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

Verdicts: `VERIFIED` (≥1 expected_substring hit in source), `CHALLENGED`
(source exists but no substring matched), `UNVERIFIED` (source not
findable in target tree).

## `dogfood/runs/<run-id>/friction.jsonl` (committed — public)

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

## `dogfood/runs/<run-id>/metrics.json` (committed — public)

Single JSON document per run. Aggregated counts + per-question rollups.
**No raw answer text**, only counts and shape data.

```json
{
  "run_id": "2026-05-20T2100-intent-eval-core-v1",
  "target": "/home/jeremy/000-projects/intent-eval-platform/intent-eval-core",
  "target_slug": "intent-eval-core",
  "bank_version": "v1",
  "ico_version": "1.1.2",
  "started_at": "2026-05-20T21:03:00Z",
  "questions": 5,
  "total_citations": 12,
  "verified": 9,
  "challenged": 2,
  "unverified": 1,
  "verify_rate": 0.75,
  "tokens_in": 6200,
  "tokens_out": 940,
  "friction_count": 2,
  "per_question": [
    {
      "q_id": "Q01",
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

## `dogfood/progress.md` (committed — public)

One row appended per run. The cross-run trend signal.

```
| run_id                                | target            | qs | citations | verified | verify_rate | tokens | friction | notes |
| ------------------------------------- | ----------------- | -- | --------- | -------- | ----------- | ------ | -------- | --------------- |
| 2026-05-20T2100-intent-eval-core-v1   | intent-eval-core  |  5 |        12 |        9 | 75.0%       | 7140   |        2 | [summary](...) |
```
