---
title: Trace Coverage Audit — 2026-05-15
doc_id: 023-OD-AUDIT-trace-coverage-2026-05-15
status: complete
created: 2026-05-15
related_beads:
  - intentional-cognition-os-2rd.4 # E10-B04
related_specs:
  - 011-AT-TRSC-trace-schema
---

# Trace Coverage Audit (E10-B04)

**Date:** 2026-05-15
**Bead:** intentional-cognition-os-2rd.4 (E10-B04)
**Trigger:** Epic 10 mandate — every CLI command must leave a queryable audit footprint.

## Methodology

For every CLI command, this audit checks:

1. **Trace emission** — does the command (or the kernel / compiler function it delegates to) call `writeTrace`? If so, with what event types?
2. **Audit-log entry** — does the command call `appendAuditLog`, which writes a human-readable line to `audit/log.md`?
3. **Correlation grouping** — when a command emits multiple events, do they share a `correlation_id` so the audit layer can reconstruct the flow?
4. **Schema conformance** — do emitted payloads match the event-type fields defined in `011-AT-TRSC` §6?
5. **Hash chain integrity** — does the SHA-256 `prev_hash` chain in the daily JSONL files validate end-to-end? Verified by the `smoke-audit-chain-intact` eval shipped in E10-B01.

## Findings

### Coverage matrix

| Command                     | Trace event(s)                                         | Audit log        | Correlation               | Notes                                                                                                                  |
| --------------------------- | ------------------------------------------------------ | ---------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ico init`                  | —                                                      | `workspace.init` | n/a                       | One-shot bootstrap; `workspace.init` isn't in §6 yet — left as audit-log entry. **Acceptable** for now.                |
| `ico mount add\|remove`     | —                                                      | —                | n/a                       | Mutates a kernel table but emits nothing. **Gap** — should at least append to audit log. Tracked for B05+.             |
| `ico ingest`                | `ingest` (per file)                                    | yes (per file)   | per-file                  | Conforms.                                                                                                              |
| `ico compile`               | `compilation.start`, `compilation.complete` (per pass) | yes              | per pass                  | Six passes each emit a pair. Conforms.                                                                                 |
| `ico ask`                   | `ask.start`, `ask.complete`                            | yes              | start/complete share id   | Conforms.                                                                                                              |
| `ico research <brief>`      | `task.created` + per-stage traces from agents          | yes              | per-task                  | Orchestrator emits `orchestrator.{start,stage_start,stage_complete,abort,complete}` plus per-agent traces. Conforms.   |
| `ico research archive <id>` | `task.archived`                                        | yes              | per-task                  | Conforms.                                                                                                              |
| `ico render`                | `render.start`, `render.complete`                      | yes              | start/complete share id   | Conforms.                                                                                                              |
| `ico promote`               | `promotion`                                            | yes              | per-promotion             | Conforms.                                                                                                              |
| `ico unpromote`             | `unpromote`                                            | yes              | per-unpromotion           | Conforms. (Note: `unpromote` isn't enumerated in §6; treated as the inverse of `promotion`. Spec gap, not a code gap.) |
| `ico lint`                  | **`lint.run`, `lint.result`**                          | yes              | start/result share id     | **Fixed in this bead** — was previously a stub.                                                                        |
| `ico recall generate`       | `recall.generate`                                      | yes              | per-generation            | Conforms.                                                                                                              |
| `ico recall quiz`           | `recall.quiz`, `recall.result` (per question)          | yes              | session-id as correlation | Conforms — addressed via the gemini-review fix on PR #52.                                                              |
| `ico recall weak`           | —                                                      | —                | n/a                       | Read-only aggregate over `recall_results`. **No trace required** — read-only by design.                                |
| `ico recall export`         | —                                                      | —                | n/a                       | Read-only over `recall/cards/`. **No trace required** — pure data transform with no mutation.                          |
| `ico eval run`              | `eval.run`, `eval.result` (per spec)                   | —                | per-spec                  | Conforms. Batch-level correlation deferred (see "Future work").                                                        |
| `ico status`                | —                                                      | —                | n/a                       | Read-only summary. **No trace required**.                                                                              |
| `ico inspect`               | —                                                      | —                | n/a                       | Read-only inspector. **No trace required**.                                                                            |

### Confirmed-good event types

Every event type listed in `011-AT-TRSC` §6.1–6.20 has at least one source emitter in the codebase:

- `ingest` → `commands/ingest.ts`
- `compilation.start` / `.complete` → `compiler/passes/{summarize,extract,synthesize,link,contradict,gap}.ts`
- `retrieval` → `compiler/ask/analyze.ts`
- `ask.start` / `.complete` → `commands/ask.ts`
- `render.start` / `.complete` → `commands/render.ts`
- `promotion` → `kernel/promotion.ts`
- `task.created` / `.transition` / `.completed` / `.archived` → `kernel/tasks.ts`, `kernel/archive.ts`, `compiler/agents/orchestrator.ts`
- `recall.generate` → `compiler/recall/generate.ts`
- `recall.quiz` / `recall.result` → `compiler/recall/quiz.ts`
- `eval.run` / `eval.result` → `kernel/evals/runner.ts`
- `lint.run` / `lint.result` → `commands/lint.ts` (newly added in this bead)

### Hash-chain integrity

The append-only JSONL trace files form an integrity chain: every line records `prev_hash = SHA-256(prev_line)`. The `smoke-audit-chain-intact` eval (shipped in E10-B01, `evals/smoke/audit-chain-intact.eval.yaml`) walks every daily trace file via the SQL index and verifies the chain.

This audit ran the eval against a freshly-built workspace populated by the integration test in this bead and observed **zero chain breaks** across all events emitted by the test flow.

## Remaining gaps

1. **`ico mount add/remove` emits nothing.** Low severity — mount registration is rare and reversible. Optional fix in B05 (error hardening) or whenever a `mount.add` / `mount.remove` event type lands in §6.
2. **`workspace.init` and `unpromote` are not enumerated in `011-AT-TRSC` §6.** The code emits them; the spec doesn't list them. Spec drift, not code drift. Patch §6 to either (a) document them or (b) collapse `workspace.init` into the audit log only.
3. **Eval batch correlation.** Each spec in a batch run gets its own `correlation_id`; the batch itself doesn't have one. Add `batch_correlation_id` to `eval.run` payloads in a follow-up so an `ico eval run` invocation is reconstructable end-to-end. Tracked for B11 follow-up.

## Verification

Run the trace-coverage integration test:

```bash
pnpm --filter @ico/cli test -- trace-coverage.integration.test.ts
```

The test:

1. Initializes a workspace and ingests a markdown source.
2. Runs `ico lint` against the workspace and asserts `lint.run` + `lint.result` traces exist.
3. Runs `ico eval run` against the seeded specs and asserts `eval.run` + `eval.result` traces exist.
4. Loads the `smoke-audit-chain-intact` spec and runs it programmatically; asserts the chain walks without breaks.

## Decisions

- **Read-only commands do not emit traces.** `status`, `inspect`, `recall weak`, `recall export` mutate nothing; emitting an event would be observation pollution. Documented above so future readers don't add traces "for completeness".
- **Lint emits per-pass detail in the result payload.** Per `011-AT-TRSC` §6.20, the `issues` array contains `{path, severity, message}` entries. We flatten schema / staleness / uncompiled / orphan findings into that shape so external tooling has one queryable representation.
