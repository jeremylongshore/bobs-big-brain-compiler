# Compiler test audit

Diagnostic refresh dated 2026-10-27 for `compile-then-govern-6ps.19`.
Audited source: `9fe7f6d04ad51e9b55447b98ef240ccb41641642`.
No new grade is assigned. This replaces the August snapshot as the current report;
[the previous report](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/TEST_AUDIT.md)
remains historical. Deterministic tests, live model-output quality and human
acceptance are separate evidence classes.

## Measured evidence

The [hosted Coverage job at refresh head `63414f5`](https://github.com/jeremylongshore/bobs-big-brain-compiler/actions/runs/40454049349/job/122023116790)
records 1,917 tests in 148 files passing, with 81.15% statements, 67.17%
branches, 88.22% functions and 82.75% lines. The job exited successfully with
configured package thresholds. [The source comparison](https://github.com/jeremylongshore/bobs-big-brain-compiler/compare/9fe7f6d04ad51e9b55447b98ef240ccb41641642...63414f52210ca209cc55bb07ae64fcd619f45501)
changes only this report, the observational testing document and its hash entry;
runtime, test code and coverage configuration are unchanged from `9fe7f6d`.
The aggregate branch number must not be compared with the kernel-only floor:
[the pinned coverage configuration](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/vitest.config.ts)
defines distinct package globs and thresholds.

The author also reports an uncommitted local `pnpm build` followed by
`pnpm test:coverage` at `9fe7f6d`, both exiting zero. That local run is not
independently attested; the linked hosted job supplies the public measurement
above. Package-root test counts, plugin script tests, benchmarks, mutation runs
and real-provider rubric scores are separate evidence classes.

The [vendored version record](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/.audit-harness/VERSION)
is 1.5.1, and [merged PR #260](https://github.com/jeremylongshore/bobs-big-brain-compiler/pull/260)
aligned both entry points. At audit time the author observed the installed npm
package also at 1.5.1 and reported both local verifier commands exiting zero.
[This refresh's hosted hash-verification job](https://github.com/jeremylongshore/bobs-big-brain-compiler/actions/runs/40454049349/job/122023116845)
separately records `harness-hash: OK`. Local environment observations below are
author-recorded diagnostics, not signed records or independent attestations.

## Layers: presence, configuration and measurement

| Layer                | Current source/wiring                                                                                            | Evidence limit                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| L1 hooks and CI      | Husky, lint-staged, commitlint, pre-push hash verification and CI jobs                                           | Presence/wiring is distinct from local enforcement and branch-protection configuration                                        |
| L2 static            | ESLint, TypeScript, Prettier, gitleaks, OSV and CodeQL workflow configuration                                    | Author reports a local build pass; local OSV unavailable; no refreshed CodeQL backlog or aggregate security assurance claimed |
| L3 unit and function | Vitest package coverage floors, fast-check kernel properties, kernel-only Stryker and architecture configuration | Fresh ordinary coverage passed; mutation effectiveness and true CRAP were not measured                                        |
| L4 integration       | Real SQLite/filesystem fixtures and cross-package integration fixtures                                           | Included in the unified suite; the old 25-integration-test snapshot is not reused as a fresh count                            |
| L5 system quality    | Eval YAML, benchmark runner and manual golden-corpus workflow                                                    | No live provider, fresh performance result or model-output score executed here                                                |
| L6 artifact smoke    | Built CLI smoke and plugin script CI jobs                                                                        | Separate from ordinary Vitest counts; no live deployment inferred                                                             |
| L7 acceptance        | RTM/persona/journey declarations                                                                                 | Historical inferred mappings do not establish current acceptance percentages or human sign-off                                |

[Integration fixtures](https://github.com/jeremylongshore/bobs-big-brain-compiler/tree/9fe7f6d04ad51e9b55447b98ef240ccb41641642/tests/integration),
[kernel promotion properties](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/packages/kernel/src/promotion.property.test.ts)
and [retention properties](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/packages/kernel/src/retention.property.test.ts)
are included by the pinned ordinary-suite configuration linked above.

Current gate observations are in [tests/TESTING.md](tests/TESTING.md). Its policy
thresholds and waivers are preserved. The old claims that fast-check is absent
and Stryker config is unpinned are obsolete: kernel promotion/retention property
suites exist, and [.harness-hash](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/.harness-hash)
pins `stryker.config.js`. The current coverage configuration binds package source
globs. [REQ-063](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/tests/RTM.md)
remains unchanged; its historical missing-gate note requires owning-record
reconciliation. This report does not supersede a requirement or mark it complete.

## Classification and traceability

The author-recorded 1.5.1 root classifier run detected CLI, library, monorepo and skill signals.
Per-package classification recognized the CLI package but left benchmarks,
compiler, kernel and types unresolved. Source inspection suggests internal
performance/evaluation tooling, a compiler library with provider integration,
a kernel library with persistence integration and a schema/type library.
These are proposed refinements pending owning policy adoption; they do not
override emitted classifier data or establish accepted classifications.

Historical RTM/persona/journey ratios remain historical. This audit neither
recomputed current declarative test links nor changed requirements, MoSCoW tiers,
personas or journeys. Test success does not establish a new traceability ratio.

## Measurement gaps and handoff

- Generic deep audit reported CRAP PASS with zero scored production and test
  methods. That result is excluded and cannot establish the policy's CRAP floors.
  The runner permits writes despite its read-only description; the author reports
  observing the listed files and retaining copies outside the checkout. Proposed remediation is to reject zero-measurement verdicts and isolate output.
  Local handoff reference `compile-then-govern-8pg.1` is not a public tracker-state
  or scope attestation.
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

## Author-recorded diagnostic extracts

The following normalized extracts were recorded on 2026-10-27 UTC at `9fe7f6d`.
They are authored execution summaries, not raw signed output. Absolute host paths
are omitted; local diagnostic observations are not independent attestations.

```json
{
  "command": "pnpm exec audit-harness audit --deep",
  "runner": "audit-harness@1.5.1",
  "gate_id": "audit-harness:ci:crap-score",
  "result": "PASS",
  "input_hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "child_summary": {
    "language": "js",
    "production_methods_scored": 0,
    "test_methods_scored": 0,
    "pass": true
  },
  "generated_paths": [
    "reports/crap/crap-src.csv",
    "reports/crap/crap-test.csv",
    "reports/crap/summary.json"
  ]
}
```

The pinned [audit runner](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/.audit-harness/scripts/audit.py)
describes read-only assessment but invokes the child without an output override.
The [child scorer](https://github.com/jeremylongshore/bobs-big-brain-compiler/blob/9fe7f6d04ad51e9b55447b98ef240ccb41641642/.audit-harness/scripts/crap-score.py)
defaults to `reports/crap`. The author observed those untracked files and retained
their bytes outside the checkout; no independent custody verification is claimed.

Classification commands were `pnpm exec audit-harness classify` at root and
`pnpm exec audit-harness classify packages/<name>` for each package. The normalized
root kinds were `cli, library, monorepo, skill`, with `unresolved: []`. CLI returned
`cli, library`; benchmarks, compiler, kernel and types returned `unknown`, each
with residue kind `repo-type` because no deterministic signal matched.
“Unresolved” is classifier residue, not a failed test or accepted policy decision.

The author's local `pnpm exec audit-harness scan` result included gitleaks PASS,
README-presence PASS, and unavailable OSV/markdownlint/j-rig measurements. Its
link diagnostic mentioned experimental corpus inputs `00-README.md` and
`01-api.md`, including relative references to `api.md`, `CONTRIBUTING.md`,
`helpers.md`, `tools.md` and a provider SDK source path. The stored diagnostic
was truncated; this is an untriaged sample-corpus observation, not a complete
link inventory or compiler failure.

The generic scanner looks for a standalone `markdownlint` executable. The
separate local command was `npx --no-install markdownlint-cli2 TEST_AUDIT.md tests/TESTING.md`,
which the author observed exiting zero. These are different entry points, so
its availability does not contradict the generic scanner's missing-PATH result.
Other author-reported local exits of zero were `scripts/audit-harness verify`,
`pnpm exec audit-harness verify`, `pnpm exec audit-harness escape-scan --staged`
and `pnpm exec prettier --check TEST_AUDIT.md tests/TESTING.md`.
The patch's one-line manifest change is directly inspectable; local verification
claims are distinct from the linked hosted verification job.
