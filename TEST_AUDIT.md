# TEST_AUDIT.md — intentional-cognition-os

**Audit date**: 2026-05-19
**Auditor**: `/audit-tests` skill (v5 canonical, audit-harness v0.1.0)
**Branch**: `main`
**Supersedes**: prior `TEST_AUDIT.md` dated 2026-04-09 (40 days stale; covered 572 tests across 2 packages — pre-benchmarks era)

## Headline

| Metric                | Value                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| Grade                 | **B- (76 / 100)**                                                       |
| Tests                 | 1,210 / 1,210 passing across 5 packages                                 |
| MUST coverage         | 48 / 48 (100%)                                                          |
| SHOULD coverage       | 13 / 14 (93%) — 1 uncovered: REQ-053 interactive recall quiz stdin loop |
| Escape-scan           | clean (0 REFUSE / 0 CHALLENGE / 0 FLAG)                                 |
| Bias scan             | clean                                                                   |
| CRAP score            | pass                                                                    |
| Harness freshness     | OK (latest 0.1.0 vendored)                                              |
| Harness hash manifest | absent (fresh repo — not a halt; recommend `audit-harness init`)        |

## Classification

| Field               | Value                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Repo type           | **CLI + library monorepo** (pnpm workspace, 5 packages)                                                                            |
| Primary deliverable | `intentional-cognition-os` (npm), CLI binary `ico`                                                                                 |
| Workspace packages  | `@ico/types` (lib), `@ico/kernel` (lib), `@ico/compiler` (lib), `intentional-cognition-os` (cli), `@ico/benchmarks` (perf harness) |
| Test framework      | vitest (root + per-package configs)                                                                                                |
| Package manager     | pnpm 10.x                                                                                                                          |
| Compliance overlay  | none (no HIPAA / SOX / PCI / SOC2 / GDPR / FedRAMP)                                                                                |
| Source files        | 98                                                                                                                                 |
| Test files          | 90                                                                                                                                 |
| src→test ratio      | 0.92                                                                                                                               |

Per-package test counts: types 14 · kernel 312 · compiler 461 · benchmarks 39 · cli 384.

## Per-layer status

| Layer                               | Status               | Evidence                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1 — Git hooks & CI enforcement** | partial              | CI runs lint/typecheck/test/audit (`.github/workflows/ci.yml`). No git hooks installed — only `.git/hooks/*.sample`. `scripts/audit-harness` exists but is not wired to any hook. No commitlint despite documented conventional-commits convention.                                                                                          |
| **L2 — Static analysis & linting**  | partial              | ESLint + typescript-eslint configured and CI-enforced; OSV scanner replaces `pnpm audit`. Missing: prettier config, gitleaks/dedicated secret scan (only ad-hoc `find .env` shell), `audit-harness verify` not in CI.                                                                                                                        |
| **L3 — Unit & function**            | partial              | 1,210 passing vitest tests. Coverage thresholds defined for only 2 of 5 packages (types 80, kernel 80/70). Compiler ~62% and cli ~45% unenforced. No mutation testing (no Stryker config). No architecture-rule enforcement (`.arch/` is a one-shot HTML report from April, not a CI gate). No property-based tests.                         |
| **L4 — Integration & regression**   | partial              | `vitest.config.ts` includes `tests/integration/**/*.test.ts` glob but directory is empty. Rich `tests/fixtures/{empty,populated}/` corpus exists. Cross-package integration tests live inside the cli package (5 files). No Testcontainers (in-process SQLite is fine). No contract tests against Claude API.                                |
| **L5 — System quality**             | partial              | **Strong custom L5**: `evals/` YAML-driven eval framework (smoke + retrieval + citation + compilation handlers) + `packages/benchmarks/` with 3× degradation gate. Missing: no CodeQL/Semgrep SAST despite external-API consumption + JSON-parsing of model output (P1 conditional trigger). N/A: a11y (CLI), web fuzzing (no HTTP surface). |
| **L6 — E2E / BDD**                  | absent               | No post-build smoke against the published `dist/index.js` binary in CI. No `.feature` files (eval YAML is the closest analog, runs inside vitest not against the artifact).                                                                                                                                                                  |
| **L7 — Acceptance & traceability**  | partial (this audit) | `tests/RTM.md`, `tests/PERSONAS.md`, `tests/JOURNEYS.md` created this run. `tests/TESTING.md` created this run. No hash manifest — `audit-harness init` not yet run.                                                                                                                                                                         |

## P0 / P1 / P2 gap list

### P0 (required + absent/partial)

| ID   | Layer | Gap                                                                                                                                                     |
| ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | L1    | Pre-commit hooks not installed. `audit-harness escape-scan --staged` never executes locally.                                                            |
| P0-2 | L3    | Coverage `fail_under` enforced for only 2 of 5 packages. Compiler (~62%) and cli (~45%) sit below any documented floor; benchmarks has no floor at all. |
| P0-3 | L3    | No mutation testing. With 1,210 tests, the suite needs a mutation-survival floor or drift is invisible.                                                 |
| P0-4 | L3    | No architecture-rule enforcement. Layered topology (types → kernel → compiler → cli) is load-bearing per CLAUDE.md but unchecked in CI.                 |

### P1 (required-partial / recommended-absent / conditional-triggered)

| ID   | Layer | Gap                                                                                                             |
| ---- | ----- | --------------------------------------------------------------------------------------------------------------- |
| P1-1 | L1    | No commitlint despite documented conventional-commits convention.                                               |
| P1-2 | L2    | No gitleaks / dedicated secret scanner. Ad-hoc `find .env` placeholder in CI.                                   |
| P1-3 | L2    | No formatter config (prettier or equivalent).                                                                   |
| P1-4 | L2    | `audit-harness verify` not invoked in CI. Hash-pinning gate dormant.                                            |
| P1-5 | L4    | `tests/integration/` glob configured but empty.                                                                 |
| P1-6 | L5    | No CodeQL or Semgrep SAST workflow. Triggered by Claude SDK + JSON-parsing of model output (per `021-AT-SECV`). |
| P1-7 | L6    | No post-build CLI smoke against `dist/index.js`.                                                                |
| P1-8 | L7    | REQ-053 (`ico recall quiz` interactive stdin loop) uncovered — only non-interactive paths tested.               |

### P2 (recommended-absent, library/cli classification demotes)

| ID   | Layer | Gap                                                                                                                        |
| ---- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | L3    | No property-based tests (`fast-check`). Recall scoring, FTS5 ranking, promotion-rule evaluator are natural fits.           |
| P2-2 | L7    | No declarative `// REQ: REQ-NNN` headers on test files — RTM mappings are inferred from file proximity rather than locked. |

## RTM summary

| Tier             | Total | Covered | Uncovered   | Excluded |
| ---------------- | ----- | ------- | ----------- | -------- |
| MUST             | 48    | 48      | **0**       | —        |
| SHOULD           | 14    | 13      | 1 (REQ-053) | —        |
| COULD            | 6     | 0       | 6           | —        |
| WON'T            | 7     | —       | —           | 7        |
| **Active total** | 68    | 61      | 7           | —        |

Active coverage: **90%**. Zero uncovered MUSTs — no P0 blocks from the traceability side.

## Personas

All four personas at 100% flow coverage:

| Persona          | Criticality | Flows   |
| ---------------- | ----------- | ------- |
| operator         | critical    | 14 / 14 |
| knowledge-worker | standard    | 6 / 6   |
| auditor          | critical    | 5 / 5   |
| ai-agent         | critical    | 13 / 13 |

## Journeys

37 of 38 journey steps tested. The single gap is `recall-loop` step 4 (interactive stdin prompt loop scoring answers), linked to REQ-053.

## Escape-scan

Clean against staged diff: `REFUSE=0 CHALLENGE=0 FLAG=0`.

## Freshness

`@intentsolutions/audit-harness`: installed `0.1.0` (vendored) · latest `0.1.0` · ✓ in sync.

## Recommended handoff

Four P0 gaps and eight P1 gaps surfaced. Per `/audit-tests` Step 8, this triggers a confirmation prompt for `/implement-tests` (on `main` branch, autonomous handoff is disabled).

Suggested install order for `/implement-tests`:

1. **L1-hooks** — Husky + commitlint + pre-commit calling `scripts/audit-harness escape-scan --staged`; pre-push calling `scripts/audit-harness verify`.
2. **L2-secrets + L2-prettier + L2-harness-verify-in-ci** — gitleaks CI step; prettier config + check job; `audit-harness verify` job.
3. **L3-coverage-floors** — vitest thresholds for compiler / cli / benchmarks (initial floors at current measured value + 2% to halt regression while sequencing the climb).
4. **L3-mutation** — Stryker, target kernel + compiler first.
5. **L3-arch** — dependency-cruiser config encoding types → kernel → compiler → cli layering.
6. **L5-SAST** — `.github/workflows/codeql.yml` (JavaScript/TypeScript pack).
7. **L4-integration** — at least one cross-package integration test under `tests/integration/`.
8. **L6-cli-smoke** — post-build job invoking `node packages/cli/dist/index.js --version` and `init` against a tmpdir workspace.
9. **L7-testing-md-hash-pin** — `audit-harness init` to hash-pin `tests/TESTING.md` policy.

## Observations

- The repo's testing posture is **substantively healthy** — 1,210 tests, 100% MUST coverage, no escape-scan flags, no bias patterns. The gaps are _enforcement_ (the walls) rather than test _quantity_. Reflect this when reading the B- grade: it's the gap between "the tests work" (yes) and "the tests are pinned, can't be silently weakened, and have a mutation-survival floor" (not yet).
- The eval framework at `evals/` + benchmark suite at `packages/benchmarks/` is unusual and load-bearing. It substitutes for traditional L5-perf and partially for L6-smoke. `/implement-tests` should not duplicate this layer — it should add the _missing_ artifact-level CLI smoke against the built binary, not re-invent benchmark scenarios.
- 90 vitest files are RTM orphans by the declarative-REQ-ID convention (no `// REQ: REQ-NNN` headers). Mappings in `tests/RTM.md` are inferred from file proximity, which is high-confidence given this repo's strict workspace-per-concern layout. Adding REQ headers is a P2 follow-up.

## Files written by this audit

- `TEST_AUDIT.md` (this file — supersedes 2026-04-09 version)
- `tests/TESTING.md` (created)
- `tests/RTM.md` (created)
- `tests/PERSONAS.md` (created)
- `tests/JOURNEYS.md` (created)
