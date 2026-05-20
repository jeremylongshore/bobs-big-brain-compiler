# Document Consistency Audit Report

**Project:** intentional-cognition-os
**Date:** 2026-05-19
**Trigger:** Post-release verification (skipped from /release Phase 1.6, run as remediation)
**Project Type:** Engineering repo
**Hierarchy Applied:** Code is truth → tests → CHANGELOG → package.json → README/CLAUDE.md → planning docs

## Executive Summary

| Severity    | Count |
| ----------- | ----- |
| 🔴 Critical | 1     |
| 🟡 Warning  | 2     |
| 🔵 Info     | 1     |
| **Total**   | **4** |

## Findings

### Category 1: Status Drift

**Finding 1.1 — 🔴 Critical — Version drift between root and workspace packages**

- **What's true:** npm published `intentional-cognition-os@1.0.0` (cli/package.json says 1.0.0)
- **What root says:** `version.txt` and root `package.json` both report 1.0.1 (auto-release cut on the AAR doc commit, no code change)
- **What workspace packages say:** All five sub-packages (cli, kernel, compiler, types, benchmarks) and `kernel/src/version.ts` still at 1.0.0
- **Latest git tag:** v1.0.1
- **CHANGELOG head:** v1.0.1 with a docs-only AAR entry

**Recurring issue:** the auto-release workflow bumps root + version.txt only, leaves workspace packages behind. Documented in `025-RL-REPT-v1.0.0-release-aar` Lessons section. Manifest at `f1a627b` was 0.22.2; cut at `52fa7a4` aligned everything at 1.0.0; auto-release at `796d309` re-drifted root → 1.0.1 while leaving the rest.

**Auto-fixable:** Yes — either (a) extend the release workflow to bump `packages/*/package.json` in lock-step, or (b) accept that root's `version.txt` is process-bookkeeping for auto-release and the _published_ version is whatever `packages/cli/package.json` says.

**Recommended fix:** Option (a) in a follow-up PR. The release workflow lives at `.github/workflows/release.yml`.

### Category 2: API/Interface Drift

No issues found.

### Category 3: Capability/Behavior Drift

**Finding 3.1 — 🔵 Info — README features list matches code**

All 14 commands registered in `packages/cli/src/index.ts` are documented in the README's CLI surface table. Every README feature claim (compile, ask, research, render, recall, lint, eval) has a corresponding `commands/*.ts` file. No overclaims.

### Category 4: CI/Validation Drift

No issues found. CI workflow (`ci.yml`) runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` — same commands a developer runs locally per the README.

### Category 5: Planning-vs-Implementation Confusion

No issues found. The `000-docs/epics/epic-*.md` directory contains 10 epic specs; all 10 epics are now closed in beads. The "current state" line in CLAUDE.md was updated as part of the v1.0 cut.

### Category 6: Cross-Doc Contradiction

No issues found. License: MIT consistently across README, LICENSE, all 6 package.json files. Repository URL: matches between cli/package.json `.repository.url` and git remote origin.

### Category 7: Index/Reference Drift

**Finding 7.1 — 🟡 Warning — README install instructions don't mention npm publish**

- **What's true:** Package is now published — `npm install -g intentional-cognition-os` works
- **What README says (line 46):** `npm pack && npm install -g intentional-cognition-os-*.tgz` (the pre-publish workaround)
- **Auto-fixable:** Yes — one-line replacement

**Finding 7.2 — 🟡 Warning — No `000-INDEX.md` in `000-docs/`**

- **What's there:** 27 files in `000-docs/` (specs, epics, audits, this report, etc.)
- **What's missing:** An index/TOC file (`000-INDEX.md`) listing them per the Document Filing Standard
- **Impact:** No automated way for the consistency-auditor (or a new contributor) to know if a file is misnamed or orphaned. Pure operational hygiene — not blocking.
- **Auto-fixable:** Yes — generate from `ls 000-docs/`

## Priority Actions

1. **🔴 Decide on version-lockstep strategy** for the auto-release workflow (extend it to bump workspace packages, OR document that `version.txt` is process-only and CLI package.json is the source of truth). Recurring drift will keep happening otherwise.
2. **🟡 Update README install step** to use `npm install -g intentional-cognition-os` now that the package is live.
3. **🟡 Add `000-INDEX.md`** to `000-docs/` to enable future index-vs-filesystem drift checks.
4. **🔵 (No action)** — features, CI commands, license, repo URLs all consistent.

## Skipped Checks

| Check                          | Reason                                                        |
| ------------------------------ | ------------------------------------------------------------- |
| 3.1 Index vs filesystem        | `000-docs/000-INDEX.md` doesn't exist (logged as Finding 7.2) |
| 3.9 Planning vs implementation | No `planning/` dir; epics in `000-docs/epics/` all closed     |

---

Audit complete: **1 critical**, **2 warning**, **1 info** finding across the v1.0 documentation surface.

⚠️ Critical issue (version drift) recommended for follow-up bead. Not regenerating the npm artifact — the npm release is internally consistent at 1.0.0.
