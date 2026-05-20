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

| Gate                          | Floor | Rationale                                                                                      |
| ----------------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `coverage.line.types`         | 80%   | Already enforced (vitest.config.ts)                                                            |
| `coverage.line.kernel`        | 80%   | Already enforced (vitest.config.ts)                                                            |
| `coverage.branch.kernel`      | 70%   | Already enforced (vitest.config.ts)                                                            |
| `coverage.line.compiler`      | 60%   | Initial floor at current measured (~62%) − 2% to halt regression. Climb plan tracked in beads. |
| `coverage.line.cli`           | 43%   | Initial floor at current measured (~45%) − 2%. Climb plan tracked in beads.                    |
| `coverage.line.benchmarks`    | n/a   | Benchmark harness — coverage not a meaningful metric for scenario runners.                     |
| `mutation.killed.kernel`      | TBD   | Set after first Stryker baseline. Recommend `current_score − 5%`.                              |
| `mutation.killed.compiler`    | TBD   | Set after first Stryker baseline.                                                              |
| `crap.max.prod`               | 30    | Halt threshold per audit-harness defaults.                                                     |
| `crap.max.test`               | 15    | Halt threshold per audit-harness defaults.                                                     |
| `crap.project_average.max`    | 10    | Halt threshold per audit-harness defaults.                                                     |
| `architecture.violations.max` | 0     | Zero-tolerance once dependency-cruiser is wired.                                               |

### Machine-readable floors (audit-harness contract)

The audit-harness `escape-scan.sh` reads conservative repo-wide floors from
plain `key: value` lines below. The pipe-table above is authoritative for
humans + per-package detail; the lines below are what the harness greps.
Lower of (per-package floor, repo-wide floor) wins — these are the floors
the harness will REFUSE diffs against.

```
coverage.line: 43
coverage.branch: 40
mutation.kill_rate: 0
```

The conservative `coverage.line: 43` matches the lowest enforced per-package
floor (`packages/cli/src`). Once compiler + cli climb past 60%, raise this
line in lock-step. `mutation.kill_rate: 0` is the initial value while
Stryker baseline is being recorded; bump to `(baseline − 5)` after the
first run.

## Waived layers

| Layer             | Reason                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| L5-a11y           | No UI surface (CLI tool).                                                                                        |
| L5-web-fuzz       | No HTTP surface.                                                                                                 |
| L4-Testcontainers | better-sqlite3 is in-process; no external infra to containerize.                                                 |
| L4-Pact contract  | No internal service-to-service traffic; Claude API consumption gated by `ClaudeClient` interface + vitest mocks. |

## Installed gates (observational — updated by `/audit-tests` + `/implement-tests`)

State as of 2026-05-19 after the `/implement-tests` install pass.

| Layer | Tool                                              | Status    | Wired                                          |
| ----- | ------------------------------------------------- | --------- | ---------------------------------------------- |
| L0    | `@intentsolutions/audit-harness@0.1.0`            | installed | devDep + `scripts/audit-harness` wrapper       |
| L1    | husky                                             | installed | `.husky/`                                      |
| L1    | commitlint + `@commitlint/config-conventional`    | installed | `.husky/commit-msg`                            |
| L1    | lint-staged                                       | installed | `package.json#lint-staged` + pre-commit        |
| L1    | `audit-harness escape-scan --staged` (pre-commit) | installed | `.husky/pre-commit`                            |
| L1    | `audit-harness verify` (pre-push)                 | installed | `.husky/pre-push`                              |
| L2    | ESLint + typescript-eslint                        | installed | CI (Lint job)                                  |
| L2    | `tsc --noEmit`                                    | installed | CI (Typecheck job)                             |
| L2    | OSV scanner (SCA)                                 | installed | CI (Security Audit job)                        |
| L2    | prettier                                          | installed | CI (Format Check job) + pre-commit             |
| L2    | gitleaks                                          | installed | CI (Secret Scan job)                           |
| L2    | `audit-harness verify` (CI)                       | installed | CI (Audit Harness Verify job)                  |
| L3    | vitest                                            | installed | CI (Test job)                                  |
| L3    | coverage (`@vitest/coverage-v8`)                  | installed | thresholds: types/kernel/compiler/cli          |
| L3    | Stryker (mutation, kernel + compiler)             | installed | `.github/workflows/mutation.yml` (nightly)     |
| L3    | dependency-cruiser (architecture)                 | installed | CI (Architecture Rules job)                    |
| L3    | fast-check (property-based)                       | absent    | n/a — P2 follow-up                             |
| L4    | `tests/integration/**`                            | installed | 1 starter (cross-package-boundary.test.ts)     |
| L5    | OSV scanner (SCA)                                 | installed | CI (Security Audit job)                        |
| L5    | CodeQL (SAST)                                     | installed | `.github/workflows/codeql.yml` (PR+weekly)     |
| L5    | `evals/` framework (functional quality)           | installed | manual + CI-eligible                           |
| L5    | `packages/benchmarks/` (perf + degradation gate)  | installed | manual                                         |
| L6    | post-build CLI smoke                              | installed | CI (CLI Smoke job, against built dist/)        |
| L6    | `.feature` files                                  | absent    | n/a — eval YAML serves equivalent role here    |
| L7    | `RTM.md`                                          | installed | n/a — engineer-owned                           |
| L7    | `PERSONAS.md`                                     | installed | n/a — engineer-owned                           |
| L7    | `JOURNEYS.md`                                     | installed | n/a — engineer-owned                           |
| L7    | hash manifest                                     | installed | `.harness-hash` pins `.dependency-cruiser.cjs` |

### Known limits in the current install

- **Stryker config not hash-pinned**: the harness `PATTERNS` list matches `stryker.conf.json` and `stryker.config.js` but not `stryker.config.json` (our extension). Once a mutation baseline is recorded and `break: N` is set, manually rename to `stryker.config.js` (CommonJS) or wait for an upstream harness patch. Until then, the break threshold can be lowered silently.
- **Stryker `timeoutMS: 30000`** may inflate the kill rate via false timeouts on compiler mutants that touch the full ingest → compile pipeline. Watch the first baseline run for timeout-heavy results before locking a `break` threshold.
- **CodeQL** runs the `security-and-quality` query pack — strict by default. First PR may surface advisory findings that need triage before the gate is locked as required-check.
- **Mutation job** is currently `workflow_dispatch + schedule` (nightly), NOT in the required-check set. Wire to required only after a baseline + floor are recorded in this doc.

## Frameworks (observational)

- vitest (root + per-package configs)
- tsup (ESM-only bundling, `--workspace-concurrency=1`)
- pnpm workspace (10.x)
- @anthropic-ai/sdk (model API)
- better-sqlite3 (deterministic state)
- Zod (runtime schema)
- Commander.js (CLI)

## Traceability (observational)

| Artifact             | Count                                                              |
| -------------------- | ------------------------------------------------------------------ |
| REQ-MUST             | 48 / 48 covered                                                    |
| REQ-SHOULD           | 13 / 14 covered (REQ-053 uncovered)                                |
| REQ-COULD            | 0 / 6 covered (advisory)                                           |
| REQ-WON'T            | 7 (excluded from math)                                             |
| Personas             | 4 / 4 at 100% flow coverage                                        |
| Journey steps tested | 37 / 38                                                            |
| Orphan tests         | 90 (all — convention: no `// REQ:` headers yet; mappings inferred) |

## Last audit

- **Date**: 2026-05-19
- **Skill**: `/audit-tests` (v5 canonical)
- **Grade**: B- (76/100)
- **P0 gaps**: 4
- **P1 gaps**: 8
- **P2 gaps**: 2
- **Escape-scan**: clean
- **Report**: `TEST_AUDIT.md`
