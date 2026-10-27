# Compiler test audit

Diagnostic refresh dated 2026-10-27 for `compile-then-govern-6ps.19`.
Audited source: `9fe7f6d04ad51e9b55447b98ef240ccb41641642`.
No new grade is assigned. This replaces the August snapshot as the current report;
[the previous report](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/TEST_AUDIT.md)
remains historical. Deterministic tests, live model-output quality and human
acceptance are separate evidence classes.

## Measured evidence

At the audited revision, `pnpm build` and then `pnpm test:coverage` exited zero.
The fresh unified ordinary suite passed 1,917 tests in 148 files in 57.58 seconds.
Aggregate coverage was 81.15% statements, 67.17% branches, 88.22% functions and
82.75% lines. Configured package thresholds passed. The aggregate branch number
must not be compared with the kernel-only 70% branch floor.

These are author-recorded local results; execution logs are not committed and
no independent human attestation is claimed. The commands and source revision
make the scope reproducible. [Hosted source check history](https://github.com/jeremylongshore/bobs-big-brain-compiler/commit/9fe7f6d04ad51e9b55447b98ef240ccb41641642/checks)
is separate evidence, not a claim that every hosted check ran in this audit.
Package-root test counts, plugin script tests, benchmarks, mutation runs and
real-provider rubric scores must not be added together as one acceptance number.

Both installed and vendored audit-harness entry points are 1.5.1 and their hash
verification passed. An initial mismatch came from a stale local checkout and
installed dependency against an older vendored manifest. Already-reviewed PR #260
resolved that source discrepancy. The checkout was fast-forwarded and frozen
lockfile dependencies installed; unrelated local work was retained. No new
policy or harness behavior was introduced by this audit.

## Layers: presence, configuration and measurement

| Layer                | Current source/wiring                                                                                            | Evidence limit                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| L1 hooks and CI      | Husky, lint-staged, commitlint, pre-push hash verification and CI jobs                                           | Presence/wiring is distinct from local enforcement and branch-protection configuration                               |
| L2 static            | ESLint, TypeScript, Prettier, gitleaks, OSV and CodeQL workflow configuration                                    | Build passed here; local OSV unavailable, and no refreshed CodeQL backlog or aggregate security assurance is claimed |
| L3 unit and function | Vitest package coverage floors, fast-check kernel properties, kernel-only Stryker and architecture configuration | Fresh ordinary coverage passed; mutation effectiveness and true CRAP were not measured                               |
| L4 integration       | Real SQLite/filesystem fixtures and eight tracked cross-package integration test paths                           | Included in the unified suite; the old 25-integration-test snapshot is not reused as a fresh count                   |
| L5 system quality    | Eval YAML, benchmark runner and manual golden-corpus workflow                                                    | No live provider, fresh performance result or model-output score executed here                                       |
| L6 artifact smoke    | Built CLI smoke and plugin script CI jobs                                                                        | Separate from ordinary Vitest counts; no live deployment inferred                                                    |
| L7 acceptance        | RTM/persona/journey declarations                                                                                 | Historical inferred mappings do not establish current acceptance percentages or human sign-off                       |

Current gate observations are in [tests/TESTING.md](tests/TESTING.md). Its policy
thresholds and waivers are preserved. The old claims that fast-check is absent
and Stryker config is unpinned are obsolete: kernel promotion/retention property
suites exist, and `.harness-hash` pins `stryker.config.js`. REQ-063's historical
missing-package-floor statement is also obsolete; recursive source globs now
bind the package thresholds.

## Classification and traceability

The 1.5.1 root classifier detected CLI, library, monorepo and skill signals.
Per-package classification recognized the CLI package but left benchmarks,
compiler, kernel and types unresolved. Source inspection suggests internal
performance/evaluation tooling, a compiler library with provider integration,
a kernel library with persistence integration and a schema/type library.
These are proposed refinements; no classifier result or policy was rewritten.

Historical RTM/persona/journey ratios remain historical. This audit neither
recomputed current declarative test links nor changed requirements, MoSCoW tiers,
personas or journeys. Test success does not establish a new traceability ratio.

## Measurement gaps and handoff

- Generic deep audit reported CRAP PASS with zero scored production and test
  methods. That result is excluded and cannot establish the policy's CRAP floors.
  The generic child also wrote local reports despite its read-only description.
  Known generated files were preserved outside the checkout. Remediation request
  `compile-then-govern-8pg.1` covers verdict and output-isolation behavior.
- The generic scanner could run gitleaks and observed README presence, but OSV,
  standalone markdownlint and j-rig measurements were unavailable. Link scanning
  also found unresolved experimental dogfood corpus links. Scanner exit zero
  does not mean all gates ran or all links/security controls passed.
- A new mutation score, complete traceability and live provider quality remain
  unmeasured. The dated kernel mutation baseline in policy is not refreshed by
  this ordinary suite. Compiler mutation needs its own meaningful boundary;
  mocked provider responses are not live model-output quality evidence.
- The manual golden-corpus workflow remains the separate provider-backed lane;
  see [its runbook](000-docs/043-AT-EVAL-golden-corpus-quality-run-2026-08-02.md).
  No new provider spend, deployment or account operation is included.

This is a diagnostic handoff, not automatic permission to install new test
infrastructure or change policy floors. No full-audit clean verdict is issued.
