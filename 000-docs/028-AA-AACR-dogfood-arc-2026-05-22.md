---
title: After-Action Critical Review — Dog-Food Arc, May 20–22 2026
date: 2026-05-22
authors:
  - Jeremy Longshore (Intent Solutions)
status: informational
filing_standard: Document Filing Standard v4.3
scope: |
  Multi-PR session that built the dog-food infrastructure for
  intentional-cognition-os, fixed the auto-release workflow end-to-end,
  authored the v0.1 question bank against intent-eval-core, executed the
  first real run, surfaced + fixed the analyzeQuestion retrieval gap, and
  closed the loop with regression tests covering every bug found.
related_beads:
  - intentional-cognition-os-oc5 (closed) — auto-release workspace-lockstep
  - intentional-cognition-os-avz (closed) — npm token rotation
  - intentional-cognition-os-zum (closed) — script tests for ico-your-internals
  - intentional-cognition-os-wie (open, P3) — benchmarks scenario-record refactor
  - intentional-cognition-os-fmo (closed via PR #81) — analyzeQuestion retrieval gap
  - intentional-cognition-os-h99 (open, P2) — verify.py paradigm gap
related_prs:
  - '#75 — docs(gate): reconcile lint perf metrics (PR #73 follow-up)'
  - '#76 — fix(release): OC5 workflow + workspace bumps + npm publish'
  - '#77 — feat(dogfood, plugin): scaffold dog-food trail + /ico-your-internals skill'
  - '#78 — fix(release): poll for npm propagation up to 120s'
  - '#79 — docs(dogfood): intent-eval-core-v1 question bank + session-1 journal'
  - '#80 — fix(cli, plugin): ask --json + run.sh orchestrator + first real run'
  - '#81 — fix(compiler): analyzeQuestion strict-then-broad (closes fmo)'
related_journal:
  - dogfood/JOURNAL.md sessions 0/1/2/3
---

# After-Action Critical Review — Dog-Food Arc, May 20–22 2026

## Executive Summary

| Field                        | Value                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| **Arc duration**             | ~24 hours, May 20 evening → May 22 early morning UTC                                     |
| **PRs landed**               | 7 (#75 through #81); all merged to `main`                                                |
| **Releases shipped to npm**  | 4 (v1.1.2 → v1.2.0 → v1.2.1 → v1.2.2 → v1.2.3 pending #81 merge)                         |
| **Beads closed**             | 5 (oc5, avz, zum, fmo, plus bk8.11 retroactive)                                          |
| **Beads filed (still open)** | 2 (h99 P2, wie P3); 3 pre-existing P3 deferred (a2m, j83, plus wie)                      |
| **Net code change**          | ~1,100 net lines across cli + compiler + plugin + dogfood + workflows                    |
| **Net test surface added**   | 31 new tests (5 fmo regression, 2 Gemini follow-up, 17 run.sh, 5 ask --json variants, +) |
| **Tests on tip of main**     | 1,216 / 1,216 across the workspace                                                       |
| **First real dog-food run**  | Engagement signal moved 0/5 → 5/5 across the v0.1 bank                                   |
| **Real ICO bugs caught**     | 1 P1 (fmo retrieval gap) — would have shipped silent without the dog-food loop           |

The arc paid for itself on its first real execution. The dog-food
infrastructure built in PRs #77/#80 surfaced a load-bearing ICO bug
(`fmo`) in its first run; the bug was fixed under TDD discipline in
PR #81; the same bank that found the bug is now the regression test
that prevents it from coming back.

## What Happened

A linear sequence of seven PRs, each scoped to one concrete piece:

```
#75  PR-comment cleanup            (lint perf metrics reconciliation)
   ↓
#76  OC5 release workflow fix      (build before tests, workspace bumps, npm publish)
   ↓
#77  Dog-food scaffold + plugin    (JOURNAL, progress, question-banks, /ico-your-internals)
   ↓
#78  Release verification timing   (120s propagation poll vs sleep 5)
   ↓
#79  Question bank v1 (no run)     (5 hand-authored Q/A against intent-eval-core)
   ↓
#80  run.sh + ask --json + run 1   (4 orchestrator bugs + 2 ICO --json bugs + first run)
   ↓
#81  fmo retrieval fix             (analyzeQuestion strict-then-broad + 7 regression tests)
```

The first three PRs landed the infrastructure. PR #78 fixed a
follow-on bug surfaced when v1.2.0's npm publish appeared to fail
but actually succeeded (verification check too aggressive). PR #79
authored the bank without running it — operator review of the
questions before any Claude tokens. PR #80 attempted the first run,
found 4 orchestrator bugs + 2 ICO `--json` bugs, fixed all six, and
committed the first run's receipts as evidence. PR #81 fixed the
real ICO retrieval bug that the first successful run surfaced.

Cross-cutting throughout: the autonomous-git rule (auto-PR on feat
branches, `/gemini-review` after every push, fix Gemini's findings
before merge) ran cleanly through six of seven PRs. Gemini went
silent on PR #77's re-reviews — handled by the rule's "persistent
silence after substantial fix push is the de-facto no-findings
state" provision.

## What Went Well

1. **TDD discipline on the fmo fix.** Tests written FIRST (3 RED,
   2 unexpectedly green), then the analyze.ts fix landed (all 5
   GREEN). The same discipline applied to Gemini's follow-up findings
   on PR #81 — 2 more failing tests, 2 more fixes, 2 more green.
   The regression coverage is now load-bearing: the bugs cannot
   silently come back.

2. **The dog-food loop is end-to-end working.** Built it in #77, ran
   it in #80, fixed what it surfaced in #81. The infrastructure
   produced its first real signal (0/5 → 5/5 engagement) within 24
   hours of being authored.

3. **The OC5 release pipeline now actually works.** Four releases
   shipped to npm successfully in the arc (v1.1.2, v1.2.0, v1.2.1,
   v1.2.2; v1.2.3 pending #81 merge). Prior to the OC5 fix in #76,
   v1.0.6 / v1.0.7 / v1.1.0 had been tagged on GitHub but silently
   dropped at the npm publish step.

4. **Bead → PR → bead-close traceability stayed honest.** Every
   merged PR closed a specific bead with concrete evidence. New bugs
   filed as new beads, NOT scope-creep'd into the active PR.

5. **The receipts trail is real proof.** `dogfood/runs/<run-id>/`
   has sanitized rollups committed for two real runs (the pre-fmo
   baseline + the post-fmo retest). The progress.md trend table has
   one row per run + human milestones at inflection points. The
   "build in public, work in private" split held — no raw answer
   content leaked into the repo.

6. **The doc-filing taxonomy delivered.** Surveyed 12+ Intent
   Solutions repos in session 1 to ground the ecosystem-coupling
   analysis. 200+ docs use the v4.3 standard across the org. This
   AAR follows it.

## What Went Wrong

1. **The first dog-food run halted at mount due to 4 run.sh bugs.**
   The orchestrator had never been exercised end-to-end before the
   dog-food session. Bugs: TARGET_SLUG trailing newline; WS path
   mismatch with `ico init`'s actual output location; `--workspace`
   placed after subcommand instead of before; `ico compile all`
   doesn't exist (six discrete pass names required). All four would
   have been caught by a single end-to-end script test that mocked
   `ico` and ran run.sh end-to-end. **None of these existed.**

2. **ICO's `--json` flag was advertised in `--help` but never
   actually emitted JSON.** Both the happy path and the no-knowledge
   fallback path were pretty-text-only. No integration test had
   asserted the documented `--json` contract.

3. **The retrieval gap (`fmo`) would have shipped silent.** No
   existing test exercised paraphrase variance against a compiled
   corpus. Unit tests on `analyzeQuestion` covered question-type
   classification but not retrieval breadth. The dog-food bank IS
   the missing test category — that's why it found the bug.

4. **CI's `Plugin Script Tests` job failed twice during the arc.**
   First because `ANTHROPIC_API_KEY` wasn't set on the CI runner
   (fixed by env-var-aware test design). Second because PyYAML wasn't
   installed on the CI runner (fixed by adding `pip install pyyaml`
   to the job). Both bugs surfaced after the test passed locally —
   the local box has a fully-provisioned shell environment that CI
   doesn't.

5. **First publish to npm post-OC5-fix appeared to fail.** v1.2.0
   `pnpm publish` succeeded but the post-publish verification check
   (`sleep 5; npm view ...`) couldn't see the new version within 5
   seconds. Released anyway (the publish itself worked) but the
   GitHub Actions UI showed `Release: failure` — exactly the
   inverted-trust signal that erodes operator confidence. Fixed in
   PR #78 by polling up to 120s with retries.

6. **`verify.py` paradigm gap surfaced after the fmo fix.** Verify
   pipeline greps the target tree (the source repo), but ICO emits
   citations rooted at the compiled wiki (in the workspace cache).
   The verify_rate metric is misleading-0% on the post-fix retest.
   Filed as `h99` (P2). The fix is small; not blocking the fmo
   PR.

## Root Causes

| Root cause                                                                                                                                                                                | Symptoms it produced                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **End-to-end testing was unit-only.** Each component (`ico ask`, `run.sh`, `verify.py`) had unit-level tests; their integration surface (the dog-food loop itself) had none.              | 4 run.sh orchestrator bugs + 2 ICO `--json` bugs all surfaced in the same minute when the loop ran for the first time. |
| **CLI flag contracts weren't tested against parsers.** `--json` was advertised but never exercised by a JSON.parse() in a test.                                                           | `ico --json ask` printed pretty text.                                                                                  |
| **Retrieval was tested for classification accuracy, not breadth.** Unit tests covered "is this a 'what is' question?" but not "does this engage the corpus when phrased sophisticatedly?" | `fmo` — 5/5 hand-authored questions hit the no-knowledge fallback.                                                     |
| **CI runners are not a superset of the dev box.** The Plugin Script Tests job assumed `ico`, `pyyaml`, and `ANTHROPIC_API_KEY` were present because they are on the author's machine.     | 2 CI failures in the arc, both about provisioning.                                                                     |
| **Verification check on release publish was too aggressive.** 5-second sleep + single check vs. registry propagation that can take 60s+.                                                  | False "Release: failure" on v1.2.0 despite successful publish.                                                         |
| **No prior incentive to ask ICO our own questions against our own docs.** Until the dog-food loop existed, retrieval breadth on sophisticated phrasing was an untested surface.           | Bug `fmo` had been latent through every release prior to v1.2.3.                                                       |

## Architectural Decisions Made During the Arc

1. **TDD as the default discipline for any new bug fix.**
   Established on the fmo fix (PR #81). Pattern: write the failing
   test that captures the bug FIRST, watch it fail (red), then fix
   until green. The failing test becomes the regression coverage so
   the bug cannot silently return.

2. **Public/private split for dog-food receipts.** Sanitized
   per-run rollups (`summary.md`, `metrics.json`, `friction.jsonl`,
   `manifest.json`) committed under `dogfood/runs/<run-id>/`; raw
   answer content + the compiled wiki itself live in
   `~/.cache/ico-your-internals/` outside the repo entirely. The
   skill enforces this split; `.gitignore` is the belt-and-suspenders
   guard. Decided because (a) raw answers can echo arbitrary source
   text including from future client repos, (b) the metrics trail is
   what makes the receipts useful as proof, not the raw content.

3. **Strict-then-broad FTS5 query fallback.** When the strict
   AND-joined query returns zero results, fall back to the broad
   OR-joined query. FTS5's bm25 ranking still surfaces the
   most-matching pages first under OR. Decided over "always OR"
   because precision is preserved on queries that do work under AND.

4. **`progress.md` as machine-data + Milestones above it.**
   Mirrors keep-a-changelog's spirit (human narrative above machine
   data) without conflating per-run rows with release notes. Two
   sections, two owners, two cadences.

5. **`/gemini-review` slash command as the deterministic Gemini
   trigger.** Forces a fresh review against current HEAD instead
   of waiting on the natural webhook (which can take 60–600+
   seconds). Updated in the global autonomous-git rule.

6. **AAR after every multi-PR arc.** This document is the
   first concrete instance — captured because the operator asked
   "are u documenting all this." Going forward: any time a
   session crosses 3+ PRs or includes load-bearing architectural
   decisions, file an AA-AACR.

## Action Items

| #   | Item                                                                                                                                                                                                                                   | Owner          | Status      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------- |
| 1   | Fix `h99` (verify.py paradigm gap). Once landed, v0.1 bank rerun will produce real verify-rate floor.                                                                                                                                  | next session   | open        |
| 2   | Cut v0.2 of the question-bank schema with paraphrase-variance built in as first-class.                                                                                                                                                 | when h99 lands | not started |
| 3   | Add end-to-end integration test for `run.sh` that mocks `ico` and runs the full pipeline. The 17 unit tests in `test_run_sh.sh` cover individual contracts; an integration test would have caught the 4 orchestrator bugs in one shot. | next session   | not started |
| 4   | Add CLI integration tests for every documented `--json` output shape (`ask`, `ingest`, `compile`, `status`, etc.). The pattern: spawn ico, `JSON.parse` stdout, assert shape.                                                          | open follow-up | not started |
| 5   | Re-document `~/.claude/CLAUDE.md` autonomous-git rule with the AAR-after-arc convention so future sessions surface this kind of doc proactively.                                                                                       | session-end    | not started |
| 6   | Consider opening a retrieval-improvements EPIC if `fmo` grows beyond one fix surface (e.g. if v0.2 bank surfaces additional retrieval gaps).                                                                                           | future         | conditional |

## Lessons Learned

1. **The dog-food loop is the missing integration-test layer.** Unit
   tests cover individual functions; behavioral evaluation against
   real corpora is what catches retrieval gaps, citation issues, and
   answer-quality drift. The bank itself IS the test. Future ICO bug
   reports should ask "would the v0.1 bank have caught this?" first.

2. **Bug-discovery rate is highest in the first real execution.**
   PR #80's first run produced 4 orchestrator bugs + 2 ICO bugs + 1
   ICO retrieval bug — 7 bugs in one session. Subsequent runs (post-
   fmo) produced 0 new orchestrator bugs but 1 new verify.py paradigm
   gap. The marginal yield per run will decrease as the loop matures,
   which is the desired curve.

3. **Operator-gated merges remain the right call on `main`.** Every
   merge in this arc went through explicit operator approval ("merge
   it"). The autonomous-git rule covers PR creation + Gemini loop
   - fix-up commits, but the merge act itself stays the operator's
     prerogative. Worked well across 7 PRs.

4. **Conventional-commit subjects must respect commitlint's line
   limit.** Two commits in the arc hit `header-max-length` violations
   because the subject went past ~70 chars. Future commits: keep
   subject ≤ 70, push detail to body.

5. **Provisioning gaps between dev box and CI runner are silent
   killers.** Two CI failures in the arc both came from "the local
   box has X installed; CI doesn't." Going forward, treat the
   `plugin-scripts` job's setup as the canonical minimum runtime
   surface — if a test needs more, the job must install it.

6. **The receipts trail is the marketing surface.** Anyone asking
   "is ICO real?" gets pointed at `dogfood/progress.md` showing the
   trend table + milestones. Anyone asking "does it actually catch
   bugs?" gets pointed at this AAR. The "build in public, work in
   private" pattern is working.

## Cross-References

- Sessions 0/1/2/3 of `dogfood/JOURNAL.md` — per-session narrative
- `dogfood/progress.md` — Milestones + Trend table
- `dogfood/runs/2026-05-22T0056Z-intent-eval-core-v1/` — pre-fmo baseline run artifacts
- `dogfood/runs/2026-05-22T0257Z-intent-eval-core-v1-postfmo/` — post-fmo retest artifacts
- `~/.claude/CLAUDE.md` § "Autonomous git on feature branches" — the rule the arc validated
- `~/.claude/skills/doc-filing/SKILL.md` v4.3 — the standard this document follows
- `019-OD-TMPL-adr-aar-templates.md` — canonical AAR template this entry inherits from
