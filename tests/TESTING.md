# TESTING.md — intentional-cognition-os

**Owner**: engineer (Jeremy Longshore). Policy sections below are hash-pinned via `scripts/audit-harness init` and cannot be silently weakened by AI edits.

## Classification

| Field               | Value                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Repo type           | CLI + library monorepo (pnpm workspace, 5 packages)                                         |
| Primary deliverable | `intentional-cognition-os` (npm) with CLI binary `ico`                                      |
| Workspace packages  | `@ico/types`, `@ico/kernel`, `@ico/compiler`, `intentional-cognition-os`, `@ico/benchmarks` |
| Test framework      | vitest                                                                                      |
| Package manager     | pnpm 10.x                                                                                   |
| Node version        | 22+                                                                                         |
| Module system       | ESM-only (`type: module`)                                                                   |
| Compliance overlay  | none                                                                                        |

## Thresholds (engineer-owned, hash-pinned)

| Gate                          | Floor | Rationale                                                                                                                                                                                        |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coverage.line.types`         | 80%   | Already enforced (vitest.config.ts)                                                                                                                                                              |
| `coverage.line.kernel`        | 80%   | Already enforced (vitest.config.ts)                                                                                                                                                              |
| `coverage.branch.kernel`      | 70%   | Already enforced (vitest.config.ts)                                                                                                                                                              |
| `coverage.line.compiler`      | 60%   | Initial floor at current measured (~62%) − 2% to halt regression. Climb plan tracked in beads.                                                                                                   |
| `coverage.line.cli`           | 43%   | Initial floor at current measured (~45%) − 2%. Climb plan tracked in beads.                                                                                                                      |
| `coverage.line.benchmarks`    | n/a   | Benchmark harness — coverage not a meaningful metric for scenario runners.                                                                                                                       |
| `mutation.killed.kernel`      | 55%   | Locked 2026-05-25 (bead 0wy.1). Baseline 60.25% (1800 killed of 2989 mutants, ignoreStatic=true, ~11:36 runtime). Floor = baseline − 5. Re-baseline + bump when kernel tests materially improve. |
| `mutation.killed.compiler`    | n/a   | Compiler scope deferred. ClaudeClient is mocked in tests, so a meaningful mutation score there needs a mock-coverage story we don't have yet. Tracked as follow-up bead.                         |
| `crap.max.prod`               | 30    | Halt threshold per audit-harness defaults.                                                                                                                                                       |
| `crap.max.test`               | 15    | Halt threshold per audit-harness defaults.                                                                                                                                                       |
| `crap.project_average.max`    | 10    | Halt threshold per audit-harness defaults.                                                                                                                                                       |
| `architecture.violations.max` | 0     | Zero-tolerance once dependency-cruiser is wired.                                                                                                                                                 |

### Machine-readable floors (audit-harness contract)

The audit-harness `escape-scan.sh` reads conservative repo-wide floors from
plain `key: value` lines below. The pipe-table above is authoritative for
humans + per-package detail; the lines below are what the harness greps.
Lower of (per-package floor, repo-wide floor) wins — these are the floors
the harness will REFUSE diffs against.

```
coverage.line: 43
coverage.branch: 40
mutation.kill_rate: 55
```

The conservative `coverage.line: 43` matches the lowest enforced per-package
floor (`packages/cli/src`). Once compiler + cli climb past 60%, raise this
line in lock-step. `mutation.kill_rate: 55` reflects the locked kernel
baseline minus the 5-point tolerance band (baseline 60.25%, measured
2026-05-25, bead 0wy.1).

## Model-output quality evidence

The package unit suite mocks `ClaudeClient` responses. That is intentional:
it gives deterministic coverage of validation, receipts, provenance, and
failure handling without making CI depend on a provider or API budget. Those
tests are not evidence that a live model's summaries or syntheses are useful.

The live signal is the manual `workflow_dispatch` job in
`.github/workflows/golden-corpus.yml`. It runs MiniMax-M3 through all six
compiler passes over `tests/fixtures/populated/raw`, scores one source page,
concept page, and topic page with the compilation-quality eval rubrics, and
uploads a machine-readable receipt. Missing provider configuration fails the
run; it is never recorded as a green skip.

See `000-docs/043-AT-EVAL-golden-corpus-quality-run-2026-08-02.md` for the
operator runbook. Keep deterministic test counts and live rubric scores as
separate evidence classes.

## Waived layers

| Layer             | Reason                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| L5-a11y           | No UI surface (CLI tool).                                                                                        |
| L5-web-fuzz       | No HTTP surface.                                                                                                 |
| L4-Testcontainers | better-sqlite3 is in-process; no external infra to containerize.                                                 |
| L4-Pact contract  | No internal service-to-service traffic; Claude API consumption gated by `ClaudeClient` interface + vitest mocks. |

## Installed gates (observational — updated by `/audit-tests` + `/implement-tests`)

Observed 2026-10-27 at `9fe7f6d`. Presence, CI wiring and a fresh measurement
are distinct columns; none implies live model-output or user acceptance.

| Layer  | Gate                                         | Current source/measurement                                                                                        |
| ------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| L1     | Husky, commitlint and lint-staged            | Checked-in pre-commit, commit-msg and pre-push hooks                                                              |
| L1/L2  | Stock and vendored audit-harness 1.5.1       | Both hash-verification entry points pass; PR #260 aligned their protected inventories                             |
| L2     | ESLint, TypeScript and Prettier              | CI lint/type/format jobs; this audit did not change their configuration                                           |
| L2/L5  | OSV, gitleaks and CodeQL                     | CI wiring exists; local OSV unavailable, local harness gitleaks reported PASS; no current alert-backlog claim     |
| L3     | Vitest/coverage-v8 4.1.12                    | Fresh unified ordinary suite: 1,917 tests across 148 files passed; package coverage thresholds passed             |
| L3     | Stryker, kernel only                         | PR/nightly workflow and break floor 55; no fresh mutation score measured in this audit                            |
| L3     | dependency-cruiser                           | Checked-in architecture rules and CI job; a new architecture measurement is not inferred from test success        |
| L3     | fast-check                                   | Kernel promotion and retention property suites exist and are included in the ordinary suite                       |
| L4     | Cross-package integration                    | Eight tracked integration test paths included in the unified coverage run; do not reuse the old 25-test snapshot  |
| L5     | Evals, benchmarks and golden-corpus workflow | Source/configuration present; no live provider run or fresh performance result executed here                      |
| L6     | CLI artifact smoke and plugin script checks  | CI jobs exist; distinguish them from Vitest counts                                                                |
| L7     | RTM/persona/journey documents                | Declarations and historical inferred mappings, not refreshed acceptance percentages                               |
| Policy | `.harness-hash`                              | Includes `stryker.config.js`, coverage config, workflow and test-policy files; exact inventory is in the manifest |

### Known limits in the current install

- The prior warning that Stryker configuration was unpinned is obsolete:
  `.harness-hash` explicitly includes `stryker.config.js`. Current kernel mutation
  measurement remains separate from the dated baseline in the policy rationale.
- The generic deep-audit CRAP runner reported PASS with zero scored production
  and test methods. That is unmeasured complexity, not evidence of meeting the
  CRAP floors. Its child also wrote local reports despite the read-only command
  description. Generated files were preserved outside this checkout; the defect
  is tracked under `compile-then-govern-8pg.1`.
- OSV, standalone markdownlint and j-rig were unavailable to the local generic
  scanner. Owning CI wiring and tool-specific results must be assessed separately;
  a scanner exit of zero is not complete security or quality assurance.
- Some links in experimental dogfood corpus documentation did not resolve in
  the generic link scan. These findings are not a failure of the compiler suite.
- Compiler mutation scope and real model-output quality remain separate
  obligations. No provider call, model evaluation, deployment or account change
  was executed by this audit.

## Frameworks (observational)

- Vitest/coverage-v8 4.1.12, with root unified coverage and package configurations.
- pnpm workspace; TypeScript/tsup builds, including the built CLI artifact.
- fast-check kernel promotion and retention properties.
- Stryker kernel mutation configuration, distinct from the ordinary test suite.
- better-sqlite3 and filesystem fixtures for deterministic state integration.
- ClaudeClient mocks for ordinary compiler tests; no live-output score follows
  from deterministic test or coverage results.

## Traceability (observational)

The RTM, persona and journey declarations are preserved. Their historical
48/48 MUST, 13/14 SHOULD, persona percentages and journey ratios have not been
recomputed from explicit current test links. They must not be advertised as a
fresh measured acceptance result. This audit changes no requirements or tiers.

REQ-063's historical statement that per-package coverage gates are absent is
obsolete: `vitest.config.ts` now binds recursive source globs for types, kernel,
compiler and CLI. That correction does not establish complete requirement,
persona or journey coverage. Test-to-requirement linkage and acceptance need
separate verification before publishing updated percentages.

## Last audit

- **Date:** 2026-10-27; diagnostic refresh for `compile-then-govern-6ps.19`.
- **Source:** `9fe7f6d04ad51e9b55447b98ef240ccb41641642`.
- **Executed:** `pnpm build`, then `pnpm test:coverage`; both exited zero.
- **Ordinary suite:** 1,917 tests in 148 files passed; coverage run took 57.58 seconds.
- **Aggregate coverage:** 81.15% statements, 67.17% branches, 88.22% functions,
  82.75% lines. Package-specific configured floors passed; aggregate branches
  must not be compared with the kernel-only 70% branch floor.
- **Evidence:** author-recorded local results at the source revision above;
  output logs are not committed and no independent human attestation is claimed.
  [Source check history](https://github.com/jeremylongshore/bobs-big-brain-compiler/commit/9fe7f6d04ad51e9b55447b98ef240ccb41641642/checks)
  is separate hosted evidence, not a claim that every check ran in this session.
- **Grade:** not assigned. Older test/mutation snapshots retain their original dates.
- **Report:** [TEST_AUDIT.md](../TEST_AUDIT.md).
- **Unmeasured:** fresh mutation/true CRAP, complete traceability, live provider
  quality and human acceptance. The golden-corpus lane remains separate.
