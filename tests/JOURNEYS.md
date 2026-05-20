# User Journeys — intentional-cognition-os

<!-- Managed by journey-mapper-agent. Engineer additions preserved. -->
<!-- Generated: 2026-05-19 (initial scaffold). -->
<!-- Threshold: 85% step coverage. Critical journeys (`critical: true`) require 100%. -->

## Journey: operator-cognition-loop

Personas: operator → knowledge-worker
Trigger: operator runs `ico init` on a fresh directory and walks the full ingest → compile → ask → render loop (the canonical "does the loop work?" demo per PRD §Success Metrics)
critical: true
Linked RTM: REQ-005, REQ-006, REQ-007, REQ-001..004, REQ-021..026, REQ-031, REQ-032, REQ-033, REQ-035

| #   | Step                                                                                                                         | Layer      | Test file                                                                                                                                                                                                                                                                                                                           | Status  |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `ico init <dir>` creates workspace tree + SQLite + audit/log.md                                                              | L3, L4     | packages/cli/src/commands/init.test.ts, packages/kernel/src/workspace.test.ts                                                                                                                                                                                                                                                       | Covered |
| 2   | `ico mount add <path>` registers a corpus directory                                                                          | L3, L4     | packages/cli/src/commands/mount.test.ts, packages/kernel/src/mounts.test.ts                                                                                                                                                                                                                                                         | Covered |
| 3   | `ico ingest <mount>` runs adapter pipeline (md/pdf/web-clip) → copies to raw/ → registers source → writes provenance + trace | L3, L4     | packages/cli/src/commands/ingest.test.ts, packages/compiler/src/ingest-pipeline.test.ts, packages/compiler/src/adapters/{markdown,pdf,web-clip,registry,edge-cases}.test.ts                                                                                                                                                         | Covered |
| 4   | `ico compile all` runs Summarize → Extract → Synthesize → Link → Contradict → Gap                                            | L3         | packages/compiler/src/passes/{summarize,extract,synthesize,link,contradict,gap}.test.ts, packages/compiler/src/**tests**/integration.test.ts                                                                                                                                                                                        | Covered |
| 5   | `ico ask "<question>"` analyzes → searches FTS5 → generates → verifies citations                                             | L3, L4, L5 | packages/cli/src/commands/ask.test.ts, packages/cli/src/**tests**/ask-integration.test.ts, packages/compiler/src/ask/{analyze,generate,verify}.test.ts, packages/kernel/src/search.test.ts, evals/retrieval/sample-attention.eval.yaml, evals/retrieval-citation/{answer-grounding,citation-fidelity,retrieval-attention}.eval.yaml | Covered |
| 6   | `ico render report --topic <name>` produces structured markdown in outputs/reports/                                          | L3, L4     | packages/cli/src/commands/render.test.ts, packages/compiler/src/render/report.test.ts, packages/compiler/src/render/artifact-meta.test.ts                                                                                                                                                                                           | Covered |
| 7   | knowledge-worker reads the report; backlinks resolve to wiki pages                                                           | L3         | packages/compiler/src/passes/link.test.ts, packages/compiler/src/validation.test.ts                                                                                                                                                                                                                                                 | Covered |

Coverage: 7/7 steps (100%) — critical journey at threshold.

## Journey: research-task-lifecycle

Personas: operator → ai-agent (orchestrator + 4 sub-agents) → auditor (post-archive)
Trigger: operator runs `ico research "<brief>"` for a question complex enough to warrant a scoped episodic task
critical: true
Linked RTM: REQ-039, REQ-040, REQ-041, REQ-042, REQ-043, REQ-044, REQ-013 (state machine), REQ-014, REQ-015, REQ-016

| #   | Step                                                                                                                                    | Layer  | Test file                                                                                                                                                  | Status  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `ico research <brief>` creates task-YYYYMMDD-NNN, brief.md, SQLite row in `created`                                                     | L3, L4 | packages/cli/src/commands/research.test.ts, packages/kernel/src/tasks.test.ts                                                                              | Covered |
| 2   | Collector agent (deterministic FTS5) writes `evidence/NN-<slug>.md`; transitions `created → collecting`                                 | L3     | packages/compiler/src/agents/collector.test.ts                                                                                                             | Covered |
| 3   | Summarizer agent (Claude) writes `notes/synthesis.md`; transitions `collecting → synthesizing`                                          | L3     | packages/compiler/src/agents/summarizer.test.ts                                                                                                            | Covered |
| 4   | Skeptic agent (Claude, adversarial) writes `critique/critique.md` with 4 fixed sections; transitions `synthesizing → critiquing`        | L3     | packages/compiler/src/agents/skeptic.test.ts                                                                                                               | Covered |
| 5   | Integrator agent (Claude) writes `output/final.md` addressing every concern; transitions `critiquing → rendering`                       | L3     | packages/compiler/src/agents/integrator.test.ts                                                                                                            | Covered |
| 6   | Orchestrator's render stage calls `gatherTaskOutput` + `renderReport` → writes to outputs/reports/; transitions `rendering → completed` | L3, L4 | packages/compiler/src/agents/orchestrator.test.ts, packages/compiler/src/render/{report,task-renderer}.test.ts                                             | Covered |
| 7   | Token budget guard (`ICO_MAX_RESEARCH_TOKENS`) aborts cleanly and leaves task in last-good state for resume                             | L3     | packages/compiler/src/agents/orchestrator.test.ts                                                                                                          | Covered |
| 8   | Failure path: agent err → transitions to `failed_<stage>`; `retry: true` rolls back to predecessor and re-runs                          | L3     | packages/compiler/src/agents/orchestrator.test.ts                                                                                                          | Covered |
| 9   | `ico research archive <taskId>` transitions `completed → archived` without deletion                                                     | L3, L4 | packages/kernel/src/archive.test.ts, packages/cli/src/commands/research.test.ts                                                                            | Covered |
| 10  | Auditor reconstructs task by `correlation_id` jq filter against trace JSONL                                                             | L3, L5 | packages/kernel/src/**tests**/integration.test.ts, packages/cli/src/**tests**/trace-coverage.integration.test.ts, evals/smoke/audit-chain-intact.eval.yaml | Covered |

Coverage: 10/10 steps (100%) — critical journey at threshold.

## Journey: recall-loop

Personas: operator → knowledge-worker
Trigger: operator runs `ico recall generate --topic <t>`, takes the generated quiz, asks for weak-area report, exports to Anki
critical: false
Linked RTM: REQ-051, REQ-052, REQ-053, REQ-054, REQ-055, REQ-056

| #   | Step                                                                                                     | Layer  | Test file                                                                                                                   | Status                            |
| --- | -------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | `ico recall generate --topic <t>` produces 5–10 cards in `recall/cards/` and a quiz in `recall/quizzes/` | L3, L4 | packages/cli/src/commands/recall.test.ts, packages/compiler/src/recall/generate.test.ts                                     | Covered                           |
| 2   | Generated cards have frontmatter and source citations                                                    | L3     | packages/compiler/src/recall/generate.test.ts, packages/compiler/src/validation.test.ts                                     | Covered                           |
| 3   | `ico recall quiz --topic <t>` loads the quiz file (non-interactive path)                                 | L3     | packages/compiler/src/recall/quiz.test.ts, packages/compiler/src/recall/recall-pipeline.integration.test.ts                 | Covered                           |
| 4   | Interactive stdin prompt loop scores each answer and writes a `recall.result` event                      | L4     | (none — no stdin/TTY integration test)                                                                                      | Uncovered — P1 advisory (REQ-053) |
| 5   | `ico recall weak --report` aggregates results into weak-concept ranking                                  | L3, L4 | packages/cli/src/commands/recall.test.ts, packages/kernel/src/recall-results.test.ts, packages/kernel/src/retention.test.ts | Covered                           |
| 6   | `ico recall export --format anki --out deck.txt` emits Anki-compatible TSV                               | L3, L4 | packages/compiler/src/recall/export.test.ts                                                                                 | Covered                           |
| 7   | Atomic-write guarantees on disk-full mid-export                                                          | L3     | packages/compiler/src/recall/disk-full.test.ts                                                                              | Covered                           |

Coverage: 6/7 steps (86%) — above 85% threshold; step 4 is the only gap and is reflected as REQ-053 SHOULD-uncovered.

## Journey: promote-and-unpromote

Personas: operator → auditor
Trigger: operator decides a rendered report belongs in the wiki as durable knowledge; later decides to reverse
critical: false
Linked RTM: REQ-035, REQ-036, REQ-037, REQ-038, REQ-014, REQ-061

| #   | Step                                                                                                   | Layer  | Test file                                                                                                                                       | Status  |
| --- | ------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `ico render report` produces an L4 artifact (precondition)                                             | L3     | packages/compiler/src/render/report.test.ts                                                                                                     | Covered |
| 2   | `ico promote --dry-run <path>` runs the 7 rules + 3 anti-pattern detectors and reports without writing | L3, L4 | packages/cli/src/commands/promote.test.ts, packages/kernel/src/promotion.test.ts                                                                | Covered |
| 3   | `ico promote <path>` moves artifact L4 → L2 with frontmatter rewrite + audit + wiki-index refresh      | L3, L4 | packages/cli/src/**tests**/render-promote-integration.test.ts, packages/kernel/src/post-promote.test.ts, packages/kernel/src/wiki-index.test.ts | Covered |
| 4   | Promotion event written to trace JSONL and `promotions` SQLite table                                   | L3     | packages/kernel/src/promotion.test.ts, packages/kernel/src/traces.test.ts                                                                       | Covered |
| 5   | `ico unpromote <id>` reverses with audit trail; the artifact returns to L4                             | L3, L4 | packages/cli/src/commands/unpromote.test.ts, packages/kernel/src/unpromote.test.ts                                                              | Covered |
| 6   | Auditor verifies hash chain remains unbroken across promote + unpromote                                | L3, L5 | packages/kernel/src/traces.test.ts, evals/smoke/audit-chain-intact.eval.yaml                                                                    | Covered |

Coverage: 6/6 steps (100%).

## Journey: lint-and-eval

Personas: operator → auditor
Trigger: operator runs `ico lint` after a compile; then `ico eval run` to gate quality
critical: false
Linked RTM: REQ-034, REQ-046, REQ-047, REQ-033, REQ-031, REQ-016, REQ-062

| #   | Step                                                                             | Layer  | Test file                                                                                                                                    | Status  |
| --- | -------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `ico lint` checks schema, staleness, uncompiled, orphan wiki pages               | L3, L4 | packages/cli/src/commands/lint.test.ts, packages/compiler/src/staleness.test.ts                                                              | Covered |
| 2   | Lint emits `lint.run` and `lint.result` traces with per-issue arrays             | L3     | packages/cli/src/**tests**/trace-coverage.integration.test.ts                                                                                | Covered |
| 3   | `ico eval run --spec <yaml>` discovers and executes a spec                       | L3, L4 | packages/cli/src/commands/eval.test.ts, packages/kernel/src/evals/runner.test.ts                                                             | Covered |
| 4   | Smoke handler verifies workspace invariants (audit chain intact, FTS5 populated) | L3, L5 | evals/smoke/audit-chain-intact.eval.yaml, evals/smoke/fts5-index-populated.eval.yaml, packages/kernel/src/evals/runner.test.ts               | Covered |
| 5   | Retrieval handler measures recall@k + precision@k against per-metric floors      | L3, L5 | evals/retrieval/sample-attention.eval.yaml, evals/retrieval-citation/retrieval-attention.eval.yaml, packages/kernel/src/evals/runner.test.ts | Covered |
| 6   | Citation handler runs offline hallucination check on any markdown artifact       | L3, L5 | evals/retrieval-citation/{answer-grounding,citation-fidelity}.eval.yaml, packages/compiler/src/ask/verify.test.ts                            | Covered |
| 7   | Compilation handler runs Claude-scored 1–5 rubric                                | L3, L5 | evals/compilation-quality/{extract-concepts,summarize-attention,synthesize-topic}.eval.yaml, packages/compiler/src/evals/compilation.test.ts | Covered |
| 8   | Benchmark suite — 500-source large-corpus run + 3× degradation gate              | L5     | packages/benchmarks/src/utils/{corpus,degradation,timer,wiki,claude-gate}.test.ts                                                            | Covered |

Coverage: 8/8 steps (100%).

## Coverage summary

| Journey                 | Critical | Steps | Covered | %    | Status                             |
| ----------------------- | -------- | ----- | ------- | ---- | ---------------------------------- |
| operator-cognition-loop | yes      | 7     | 7       | 100% | at threshold                       |
| research-task-lifecycle | yes      | 10    | 10      | 100% | at threshold                       |
| recall-loop             | no       | 7     | 6       | 86%  | above threshold (step 4 = REQ-053) |
| promote-and-unpromote   | no       | 6     | 6       | 100% | at threshold                       |
| lint-and-eval           | no       | 8     | 8       | 100% | at threshold                       |

Aggregate: 38/38 critical-journey steps covered (100%); 37/38 non-critical-journey steps covered (97%); overall 37+38 = 37/38 + 38/38 = 36+1 uncovered out of 38; **total 37 covered / 38 steps = 97%** across all journeys.
