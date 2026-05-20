# Personas — intentional-cognition-os

<!-- Managed by persona-coverage-agent. Engineer additions preserved. -->
<!-- Generated: 2026-05-19 (initial scaffold). -->
<!-- Threshold: 80% flow coverage (default). `operator` and `ai-agent` are tagged critical. -->

## operator

Tier: cli-user (the only declared human user role for v1.0 — local-first, single-user)
Tag: critical
Permissions: read+write workspace, invoke Claude API (own key), promote artifacts, archive tasks
Key flows: init, mount, ingest, compile, ask, render, lint, promote, unpromote, status, inspect, research, recall, eval

Test coverage:

- init: packages/cli/src/commands/init.test.ts, packages/kernel/src/workspace.test.ts — Covered
- mount: packages/cli/src/commands/mount.test.ts, packages/kernel/src/mounts.test.ts — Covered
- ingest: packages/cli/src/commands/ingest.test.ts, packages/compiler/src/ingest-pipeline.test.ts — Covered
- compile: packages/compiler/src/passes/\*.test.ts (6 passes), packages/compiler/src/**tests**/integration.test.ts — Covered
- ask: packages/cli/src/commands/ask.test.ts, packages/cli/src/**tests**/ask-integration.test.ts, packages/compiler/src/ask/\*.test.ts — Covered
- render: packages/cli/src/commands/render.test.ts, packages/compiler/src/render/{report,slides,task-renderer,artifact-meta}.test.ts — Covered
- lint: packages/cli/src/commands/lint.test.ts — Covered
- promote: packages/cli/src/commands/promote.test.ts, packages/kernel/src/{promotion,post-promote}.test.ts — Covered
- unpromote: packages/cli/src/commands/unpromote.test.ts, packages/kernel/src/unpromote.test.ts — Covered
- status: packages/cli/src/commands/status.test.ts — Covered
- inspect: packages/cli/src/commands/inspect.test.ts — Covered
- research: packages/cli/src/commands/research.test.ts, packages/compiler/src/agents/orchestrator.test.ts — Covered
- recall: packages/cli/src/commands/recall.test.ts, packages/compiler/src/recall/\*.test.ts — Covered (interactive quiz stdin loop untested — see RTM REQ-053)
- eval: packages/cli/src/commands/eval.test.ts, packages/kernel/src/evals/runner.test.ts — Covered

Coverage: 14/14 flows (100%) — at threshold; one sub-step gap on `recall` (interactive quiz).

## knowledge-worker

Tier: downstream consumer (reads compiled wiki + outputs + recall artifacts; does NOT invoke `ico` directly in v1.0 — this persona consumes the files via editor, Obsidian, or static viewer)
Tag: standard
Permissions: read-only on workspace/wiki, workspace/outputs, workspace/recall
Key flows: read-compiled-page, follow-backlink, consume-report, consume-slide-deck, take-quiz, export-anki

Test coverage:

- read-compiled-page: packages/compiler/src/validation.test.ts (frontmatter conformance assures readability), packages/kernel/src/wiki-index.test.ts — Covered
- follow-backlink: packages/compiler/src/passes/link.test.ts — Covered (link pass produces backlinks; no end-to-end reader test exists because there is no in-repo reader UI)
- consume-report: packages/compiler/src/render/report.test.ts, packages/compiler/src/render/artifact-meta.test.ts — Covered
- consume-slide-deck: packages/compiler/src/render/slides.test.ts — Covered
- take-quiz: packages/compiler/src/recall/quiz.test.ts, packages/compiler/src/recall/recall-pipeline.integration.test.ts — Covered (non-interactive paths only)
- export-anki: packages/compiler/src/recall/export.test.ts — Covered

Coverage: 6/6 flows (100%). Note: this persona's flows are _file-consumption_ flows; coverage is satisfied when the file conforms to spec (frontmatter, Marp directives, Anki TSV) — no UI tests required for v1.0.

## auditor

Tier: forensic / compliance consumer (reads `workspace/audit/log.md` and JSONL traces; verifies hash chain and provenance)
Tag: critical
Permissions: read-only on workspace/audit and SQLite `traces` / `provenance` / `promotions` tables
Key flows: read-audit-log, verify-trace-chain, replay-task-correlation, audit-promotion, audit-citation-fidelity

Test coverage:

- read-audit-log: packages/kernel/src/audit-log.test.ts — Covered
- verify-trace-chain: packages/kernel/src/traces.test.ts, evals/smoke/audit-chain-intact.eval.yaml, packages/cli/src/**tests**/trace-coverage.integration.test.ts — Covered
- replay-task-correlation: packages/kernel/src/**tests**/integration.test.ts, packages/compiler/src/agents/orchestrator.test.ts — Covered (orchestrator emits one correlation_id per research task; verified end-to-end)
- audit-promotion: packages/kernel/src/promotion.test.ts, packages/kernel/src/post-promote.test.ts, packages/kernel/src/unpromote.test.ts — Covered
- audit-citation-fidelity: packages/compiler/src/ask/verify.test.ts, evals/retrieval-citation/citation-fidelity.eval.yaml, evals/retrieval-citation/answer-grounding.eval.yaml — Covered

Coverage: 5/5 flows (100%). Critical persona at threshold.

## ai-agent

Tier: probabilistic side of the boundary (Claude API caller via `ClaudeClient`; covers compiler passes + the four research agents). The deterministic kernel never grants this persona write access to audit, promotion, or policy tables — verified by architecture and by every agent test mocking `ClaudeClient`.
Tag: critical
Permissions: read sources/wiki via deterministic kernel API only; propose drafts; **never** writes durable state directly
Key flows: summarize-pass, extract-pass, synthesize-pass, link-pass, contradict-pass, gap-pass, collect-agent, summarize-agent, skeptic-agent, integrator-agent, orchestrate-stages, generate-answer, generate-recall

Test coverage:

- summarize-pass: packages/compiler/src/passes/summarize.test.ts — Covered
- extract-pass: packages/compiler/src/passes/extract.test.ts — Covered
- synthesize-pass: packages/compiler/src/passes/synthesize.test.ts — Covered
- link-pass: packages/compiler/src/passes/link.test.ts — Covered
- contradict-pass: packages/compiler/src/passes/contradict.test.ts — Covered
- gap-pass: packages/compiler/src/passes/gap.test.ts — Covered
- collect-agent: packages/compiler/src/agents/collector.test.ts — Covered (deterministic, no Claude)
- summarize-agent: packages/compiler/src/agents/summarizer.test.ts — Covered
- skeptic-agent: packages/compiler/src/agents/skeptic.test.ts — Covered
- integrator-agent: packages/compiler/src/agents/integrator.test.ts — Covered
- orchestrate-stages: packages/compiler/src/agents/orchestrator.test.ts — Covered (resume + retry + token budget + step-pause)
- generate-answer: packages/compiler/src/ask/{analyze,generate,verify}.test.ts — Covered
- generate-recall: packages/compiler/src/recall/generate.test.ts — Covered

Coverage: 13/13 flows (100%). Critical persona at threshold. Injection defense covered by REQ-027 (claude-client.test.ts).

## Coverage summary

| Persona          | Tag      | Flows declared | Flows covered | %    | Status                                    |
| ---------------- | -------- | -------------- | ------------- | ---- | ----------------------------------------- |
| operator         | critical | 14             | 14            | 100% | at threshold (REQ-053 sub-step gap noted) |
| knowledge-worker | standard | 6              | 6             | 100% | at threshold                              |
| auditor          | critical | 5              | 5             | 100% | at threshold                              |
| ai-agent         | critical | 13             | 13            | 100% | at threshold                              |

No persona below threshold. The only sub-step gap (interactive quiz stdin loop, REQ-053) is reflected as a SHOULD-uncovered in RTM.
