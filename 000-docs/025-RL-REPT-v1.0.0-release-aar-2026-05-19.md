# Release After-Action Report — intentional-cognition-os v1.0.0

## Executive Summary

| Field              | Value                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| **Version**        | v1.0.0 (first stable release)                                                   |
| **Release Date**   | 2026-05-19                                                                      |
| **Release Type**   | MAJOR                                                                           |
| **Approved By**    | jeremylongshore (SHA approval: `f1a627b`)                                       |
| **Release Commit** | `52fa7a4`                                                                       |
| **Tag SHA**        | `f8c3331`                                                                       |
| **GitHub Release** | https://github.com/jeremylongshore/intentional-cognition-os/releases/tag/v1.0.0 |
| **Closes Beads**   | `intentional-cognition-os-2rd.11`, `2rd.12`, `2rd` (Epic 10 umbrella)           |

This release closes Epic 10 and all 10 planned epics. Released via
the `/release` ceremony with explicit SHA approval per the skill's
gate.

## Pre-Release State

### Pull Requests

- Open at start of ceremony: 0
- Merged in immediate run-up: 8 (PRs #66 through #74 — Epic 10 final
  bead set, plus the release-gate C1 fix #74)

### Branch State

- All feature branches merged + deleted post-merge
- `main` was the only active branch at release time

### Security

- escape-scan: REFUSE=0 CHALLENGE=0 FLAG=0 (verified twice — Phase 3
  - final pre-commit gate)
- CI security audit (OSV-Scanner) green on the merge commit
- No secrets detected in staged diff

## Changes Included

This release rolled up all work from v0.16.3 → v1.0.0. The
sub-release timeline:

| Sub-release | Highlight                                                            |
| ----------- | -------------------------------------------------------------------- |
| v0.17.0     | E10-B03 review fixes: wiki-index batch cache + regex isolation (#67) |
| v0.18.0     | E10-B06 PR 1 — benchmark scaffold + ingest scenario (#68)            |
| v0.19.0     | E10-B06 PR 2 — lint scenario + extract lint to @ico/compiler (#69)   |
| v0.20.0     | E10-B06 PR 3 — Claude-gating pattern + render scenario (#70)         |
| v0.21.0     | E10-B06 PR 4 — compile + ask scenarios (#71)                         |
| v0.22.0     | E10-B06 PR 5 — 500-source large-corpus + 3× degradation gate (#72)   |
| v0.22.1     | E10-B11 release gate doc (#73)                                       |
| v0.22.2     | C1 fix — `ico --version` reads CLI package.json (#74)                |
| **v1.0.0**  | Version alignment cut (commit `52fa7a4`)                             |

### Features (since v0.16.3)

- Benchmark suite covering all 5 operator commands at moderate + large
  corpus, with deterministic synthetic fixtures + 3× degradation gate.
- Claude-gating pattern (`ANTHROPIC_API_KEY` + `ICO_BENCH_INCLUDE_CLAUDE=1`)
  for API-spending benchmark scenarios.

### Fixes

- `ico --version` now reads CLI's own `package.json` (was hardcoded
  kernel constant).
- Wiki index built once per batch in `runEvals` (citation specs) —
  prior O(N²) walk on large batches.
- All 6 workspace package.json + version.txt + kernel version
  constant aligned at 1.0.0 — prior auto-release only bumped root.

### Refactors

- `runLint` and helpers moved from `packages/cli/src/commands/lint.ts`
  to `packages/compiler/src/lint.ts` for cross-package reuse.
- `extractCitations` (citation eval) and `extractWikilinks` (lint)
  switched to per-call regex construction or explicit `lastIndex = 0`
  reset to eliminate module-level `/g` lastIndex bleed.

## Documentation Updates

- `CHANGELOG.md` — v1.0.0 entry with Added/Changed/Fixed/Verified
  sections, prepended to the existing auto-generated history.
- `CLAUDE.md` — "Current state" line updated from v0.16.3 to v1.0.0,
  reflecting full 10-epic completion + benchmark suite + 1,210 tests.
- `000-docs/024-OD-GATE-v1-release-readiness-2026-05-19.md` — formal
  release-gate record (lands via PR #73).
- `packages/benchmarks/README.md` — full target table + Claude-gating
  - large-corpus methodology (multiple PRs).

## Metrics

| Metric                                     | Value                           |
| ------------------------------------------ | ------------------------------- |
| Commits in v1.0 release                    | 1 (`52fa7a4`)                   |
| Commits since v0.16.3 (parent of this run) | ~20                             |
| Files changed in cut commit                | 11                              |
| Lines added in cut commit                  | +54                             |
| Lines removed in cut commit                | -10                             |
| Days from v0.16.3 to v1.0.0                | ~3 (intense focus session)      |
| Tests at v1.0                              | 1,210 passing across 5 packages |
| Lint failures                              | 0                               |
| Typecheck failures                         | 0                               |
| `ico --version` reports                    | `1.0.0` ✓                       |

## Quality Gates at Release

| Gate                             | Status                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| All tests passing                | ✓ 1,210 / 1,210                                            |
| Lint clean                       | ✓ 5 packages                                               |
| Typecheck clean                  | ✓ 5 packages                                               |
| escape-scan                      | ✓ REFUSE=0 CHALLENGE=0 FLAG=0                              |
| CI on merge commit               | ✓ Lint + Test + Typecheck + Security all green             |
| Performance targets              | ✓ ingest 200× headroom, lint 3000× headroom                |
| 3× degradation gate (500-source) | ✓ ingest 1.25×, lint 0.33× — both PASS                     |
| Release-gate checklist (E10-B11) | ✓ GO with 2 conditions, both resolved                      |
| Version alignment                | ✓ all 6 package.json + version.txt + kernel const at 1.0.0 |
| SHA approval                     | ✓ `f1a627b` explicit confirmation                          |

## External Artifacts

| Artifact         | Status                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Git tag `v1.0.0` | ✓ pushed to origin                                                                                       |
| GitHub Release   | ✓ created with formatted notes                                                                           |
| npm publication  | ⚠ NOT YET — manual `npm publish` step (or CI publish workflow if configured) is the operator's next move |

## Conditions Resolved During Cut

From `000-docs/024-OD-GATE...`:

- **C1** (`ico --version` wrong) → resolved in PR #74; verified at
  v1.0 to report `1.0.0`.
- **C2** (coverage shortfall on kernel/compiler/cli) → documented as
  post-v1 follow-up, not blocking. Recommend opening a new bead in
  the next planning cycle to add mocked-Claude-SDK integration tests.

## Lessons / Notes for Next Release

1. **Beads JSONL/Dolt sync flapping** during multi-PR sessions —
   repeated need to re-close beads after merges. Worth investigating:
   does `bd dolt push` between sessions help? Or should the
   `.beads/issues.jsonl` be `.gitattributes`-merged differently?
2. **Auto-release workflow bumps root + version.txt only**, leaves
   internal package.json files behind. Worth a small workflow update
   that also bumps `packages/*/package.json` in lock-step.
3. **`/release` skill execution** worked as designed — Phase 0
   surfaced no blockers, Phases 1-3 caught the version drift, Phase 5
   required explicit SHA approval before any push, Phases 6-8 ran
   atomically.

## Rollback Procedure

If a regression surfaces:

```bash
# Remove published release artifacts
gh release delete v1.0.0 --yes
git push origin --delete v1.0.0
git tag -d v1.0.0

# Revert the cut commit
git revert 52fa7a4
git push origin main
```

The npm package, if published, would need `npm deprecate` (npm doesn't
allow unpublishing within 72 hours per its policy) — but at the time
of this AAR, npm publish hasn't happened yet, so this is not a
concern unless the operator triggers it.

## Post-Release Checklist

- [x] Tag pushed
- [x] GitHub Release created
- [x] Beads B11, B12, Epic 10 umbrella closed
- [x] CHANGELOG + CLAUDE.md current
- [x] AAR written (this document)
- [ ] `npm publish` (operator action)
- [ ] Open follow-up bead for C2 coverage uplift (next planning cycle)
- [ ] Investigate beads sync flapping (operational concern)

---

**Verdict: v1.0.0 SHIPPED cleanly. All planned epics complete. The
system is ready for operator use.**
