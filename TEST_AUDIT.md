# TEST_AUDIT.md — intentional-cognition-os

**Audit date**: 2026-08-02
**Auditor**: l13.18 manual refresh against the current repository gates
**Branch**: `feat/ico-l13-18-golden-corpus-quality`
**Supersedes**: the 2026-05-19 audit, which described a pre-hook, pre-CodeQL, pre-integration-test state

## Executive summary

The May audit is no longer a reliable description of this repository. The
enforcement gaps it listed were subsequently addressed: hooks, commitlint,
formatting, secret scanning, CodeQL, mutation testing, architecture checks,
integration coverage, and post-build CLI smoke are now present in the tracked
workflow and hook configuration.

The deterministic test suite is healthy, but it is not a model-output quality
signal. Compiler unit tests use mocked `ClaudeClient` responses by design. A
separate workflow-dispatch lane now runs the real six-pass compiler against
`tests/fixtures/populated/raw` with MiniMax-M3 and scores the resulting source,
concept, and topic pages. Its machine-readable receipt is the only evidence
reported here for live compilation quality; no score is invented when that
workflow has not been run.

## Current evidence

| Metric                        | Current evidence                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Unit/integration tests        | 1,737 passing in the current full gate: 50 types, 466 kernel, 609 compiler, 39 benchmarks, 548 CLI, and 25 integration |
| Tracked package source files  | 249 discovered under `packages/` by `rg --files`                                                                       |
| Tracked test/spec files       | 130 discovered under package and integration test paths                                                                |
| Coverage floors               | types 80%; kernel line 80% / branch 70%; compiler 60%; CLI 43%                                                         |
| Mutation floor                | kernel kill-rate floor 55%, enforced by Stryker workflow                                                               |
| Architecture floor            | zero dependency-cruiser violations                                                                                     |
| Security gates                | OSV high/critical gate, gitleaks, CodeQL security-and-quality queries, and audit-harness checks                        |
| Artifact smoke                | built CLI version/help smoke in CI                                                                                     |
| Live compile-quality evidence | `workflow_dispatch` only; see `000-docs/043-AT-EVAL-golden-corpus-quality-run-2026-08-02.md`                           |

The test counts above are package-level receipt numbers from the current
repository test gate. They must not be added to a golden-corpus rubric score:
the former measures deterministic behavior, while the latter measures one
real provider's generated artifacts on one committed fixture.

## Gate inventory

| Layer                            | Status | Evidence                                                                                            |
| -------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| L1 — hooks and CI enforcement    | active | `.husky/commit-msg`, `.husky/pre-commit`, `.husky/pre-push`, and `.github/workflows/ci.yml`         |
| L2 — static analysis and secrets | active | ESLint, TypeScript, Prettier, OSV Scanner, gitleaks, and audit-harness verification                 |
| L3 — tests and regression        | active | Vitest, package coverage thresholds, kernel Stryker floor, and dependency-cruiser architecture gate |
| L4 — integration                 | active | `tests/integration/` cross-package suite; 25 tests in the current full gate                         |
| L5 — system quality              | active | YAML eval framework, benchmarks, CodeQL, and the separate real-provider golden-corpus lane          |
| L6 — artifact smoke              | active | CI invokes the built `packages/cli/dist/index.js` artifact                                          |
| L7 — acceptance and traceability | active | RTM/persona/journey documents, test policy, and audit-harness hash policy                           |

## Live model-output quality lane

The golden-corpus workflow is deliberately separate from ordinary CI because
it needs a provider secret, incurs provider cost, and is probabilistic. It is
manual (`workflow_dispatch`) rather than a required pull-request check.

The runner:

1. requires `MINIMAX_API_KEY` and fails closed when it is absent;
2. initializes an isolated workspace and ingests every supported file under
   `tests/fixtures/populated/raw`;
3. runs summarize, extract, synthesize, link, contradict, and gap in order;
4. scores one actual output from each of the first three generative passes with
   the checked-in compilation-quality rubrics; and
5. uploads `golden-corpus-receipt.json` without including the API key.

The runner retargets the checked-in rubrics to the pages actually emitted by
the run. This is intentional: concept and topic filenames are derived from
model-selected titles, so a fixed filename would turn a valid title choice
into a false infrastructure failure.

Runbook: `000-docs/043-AT-EVAL-golden-corpus-quality-run-2026-08-02.md`.

## Known limits and follow-up work

- The live lane is a fixed three-document fixture and does not represent all
  corpus shapes or prompt distributions.
- Rubric scores are judge-model assessments, not deterministic correctness
  proofs. They complement, rather than replace, provenance, schema, and audit
  checks.
- The workflow is not scheduled. A future bead can add a bounded weekly run
  and trend storage after the first manual receipts establish cost and score
  variance.
- Compiler mutation testing remains deferred because a mutation score over
  mocked provider behavior would not measure the provider boundary honestly.
- Branch protection still requires an operator to select the intended checks in
  GitHub; workflow presence alone does not change repository settings.

## Files and evidence locations

- `tests/TESTING.md` — deterministic test policy and thresholds
- `tests/RTM.md` — requirements traceability matrix
- `tests/PERSONAS.md` — persona coverage
- `tests/JOURNEYS.md` — journey coverage
- `000-docs/043-AT-EVAL-golden-corpus-quality-run-2026-08-02.md` — live-run instructions
- `.github/workflows/golden-corpus.yml` — manual real-provider workflow
- `scripts/eval/run-golden-corpus.sh` — isolated runner and receipt writer
- `evals/compilation-quality/` — checked-in live-quality rubrics
