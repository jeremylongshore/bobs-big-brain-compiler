# Changelog

## [v1.4.1] - 2026-05-25

- chore(beads): close zcc epic — all 5 children done (af57b3c)

## [v1.4.0] - 2026-05-25

- Merge pull request #100 from jeremylongshore/feat/zcc-followup-experiment-and-md036 (20ece87)
- fix(docs): land the 2 round-2 fixes that missed first commit (d2c0fde)
- fix(experiments): round-2 Gemini findings — fail-fast + compile warn + stale comments (ab9b192)
- fix(experiments): address Gemini review findings on run.py (PR #100) (4f71191)
- chore(docs): tighten markdownlint — enable MD036, fix 8 violations (zcc.2) (70d97f4)
- feat(experiments): compile-then-govern vs RAG v1 results (zcc.4) (426ed73)

## [v1.3.0] - 2026-05-25

- Merge pull request #83 from jeremylongshore/feat/dogfood-v0.2-paraphrases (de66f09)
- ci(docs): round 5 — Vale.Repetition off (false positives on APA citations) (4d77dc8)
- ci(docs): round 4 — disable Vale.Spelling, accept 403 in lychee (ec0df89)
- ci(docs): round 3 — Vale.Terms off + lychee include is regex, not glob (63b5613)
- chore(beads): close zcc.3 — quickstart now branches on ANTHROPIC_API_KEY (baeba5d)
- refactor(kernel,ci): shared sha256Hex helper + drop fragile markdownlint action (zcc.5) (83ac967)
- ci(audit): wire ico audit verify into CI as a post-test gate (zcc.1) (728b78e)
- ci(docs): fix Vale + lychee — round 2 of doc-quality gate hardening (66dcb95)
- fix(audit): address code-reviewer findings from PR #83 (9e3629b)
- ci(docs): fix CI gate failures from initial doc-quality install (abd9b57)
- chore(beads): file follow-ups for out-of-scope items deferred from the spool epic (20af8dd)
- feat(audit): ico audit verify SHA-256 chain verifier (ziz.4) (e22f691)
- feat(spool): ICO → INTKB writer-side spool boundary (ziz.3 v1) (3776ba8)
- ci(docs): install 4-tool doc-quality gate (20ab200)
- docs(council): Phase 5+6 — post-thesis exec council Decision Record + 3 ICO build beads (b89c29c)
- docs(thesis): Phase 3+4 — land peer-reviewed ecosystem thesis paper as 034-AT-NTRP (c61fa36)
- docs(thesis): Phase 1+2 — research handoff bundle + cross-repo bead/Plane skeleton (91ab6dd)
- chore(beads): file bd update rapid-write bug + upstream-contrib epic (71b3868)
- chore(beads): repair bd-sync cross-refs lost to rapid-write race (18135aa)
- docs(beads): plain-English bead naming convention + hygiene reset (f0324d1)
- chore(beads): sync v0.2 bead state (er2/ytq/7xp/p6w closed, nwh/x5r filed) (bc99add)
- feat(dogfood): v0.2 render-summary, docs, and production v2 bank (040a6b3)
- feat(plugin/scripts): ask-loop.py extraction + --paraphrases flag (7742467)
- feat(plugin/scripts): paraphrase_robustness metric in verify.py (3439e07)
- feat(plugin/scripts): bank.py schema library + ADRs 029-032 (c9a9b92)

## [v1.2.5] - 2026-05-23

- fix(plugin/verify): resolve wiki/ citations against workspace cache (closes h99) (#82) (2ecefc5)

## [v1.2.4] - 2026-05-22

- fix(compiler): analyzeQuestion strict-then-broad + possessive normalization (closes fmo) (#81) (50a0053)

## [v1.2.3] - 2026-05-22

- fix(cli,plugin): ask --json + run.sh orchestrator + first real dog-food run (P1 bug filed) (#80) (0fb8b00)

## [v1.2.2] - 2026-05-21

- docs(dogfood): author intent-eval-core-v1 question bank + session-1 journal (#79) (1a0cb0d)

## [v1.2.1] - 2026-05-21

- fix(release): poll for npm propagation up to 120s, not fixed sleep 5 (#78) (25596ca)

## [v1.2.0] - 2026-05-21

- feat(dogfood,plugin): scaffold dog-food trail + /ico-your-internals skill (#77) (1b32149)

## [v1.1.2] - 2026-05-20

- chore(blame): ignore prettier-formatting sweep commit in git blame (ba9e012)

## [v1.1.1] - 2026-05-20

- fix(release): build before tests, sync all workspace versions, publish to npm (OC5) (#76) (e1b7bed)

## [v1.1.0] - 2026-05-20

- docs(readme): rewrite for new readers — concrete intro + alternatives table (670405a)
- feat(test-infra): install Intent Solutions Testing SOP layers L0-L7 (e0efdee)
- chore(style): apply prettier formatting to existing files (26de1d7)

## [v1.0.7] - 2026-05-20

- docs(gate): reconcile lint perf metrics with E10-B06 bead (PR #73 follow-up) (#75) (c181452)

## [v1.0.6] - 2026-05-20

- chore(beads): file oc5 — auto-release workspace-lockstep fix (9635f52)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

Versions ≥ 1.0.0 follow strict Keep a Changelog sections (Added / Changed /
Deprecated / Removed / Fixed / Security). Pre-1.0 entries below v1.0.0 retain the
auto-generated one-line conventional-commit format from the project's
release-please workflow; they are preserved verbatim as historical record and
not reformatted retroactively.

## [Unreleased]

## [v1.0.5] - 2026-05-19

Documentation-shape release: brings CHANGELOG.md into strict Keep a
Changelog conformance, ships it inside the npm tarball, and back-fills
the auto-release patches that landed as single-line entries.

### Added

- `CHANGELOG.md` now ships in the npm tarball. `packages/cli/package.json`
  `files:` list declares it; `tsup` `onSuccess` copies it from the repo
  root into the CLI package directory alongside README + LICENSE (same
  gitignored-copy pattern).
- Keep a Changelog preamble + `[Unreleased]` section per the spec.

### Changed

- Reformatted v1.0.1, v1.0.2, v1.0.3, v1.0.4 entries into Keep a Changelog
  sectioned form (back-fill of what the auto-release / earlier manual
  cuts emitted).
- Public GitHub gist updated to embed the full CHANGELOG verbatim
  (instead of the prior summary list of "prior milestones").

### Fixed

- npm-side discoverability of changelog: users `npm install`-ing the
  package now get `CHANGELOG.md` next to `README.md` and `LICENSE`
  inside the installed directory.

## [v1.0.4] - 2026-05-19

### Added

- `000-docs/027-RL-REPT-v1.0.3-release-aar-2026-05-19.md` — release
  after-action report for the v1.0.3 ceremony cut. Documents the three
  v1.0.0 ceremony skips (Phase 1.6 `/validate-consistency`, Phase 7.5
  `/gist-auditor`, full `/repo-dress`) and how v1.0.3 closed them.

  Commit: `660e022`

## [v1.0.3] - 2026-05-19

Manual maintenance release via the full `/release` ceremony. Closes the
recurring version-drift finding from `/validate-consistency` and folds
in the post-v1.0 housekeeping that the auto-release workflow can't
handle (workspace package alignment, README install line update, formal
consistency audit doc).

### Added

- `000-docs/026-OD-CONS-validate-consistency-2026-05-19.md` — first
  formal cross-artifact consistency audit (1 Critical fixed here, 2
  Warning, 1 Info).

### Fixed

- **Version drift.** All 6 workspace `package.json` files +
  `version.txt` + `packages/kernel/src/version.ts` now aligned at the
  same released version. The auto-release workflow had been bumping
  root + `version.txt` only, leaving workspace packages at the prior
  version after each patch cut.
- README install instructions: replace the pre-publish
  `npm pack && npm install -g …-*.tgz` workaround with
  `npm install -g intentional-cognition-os` now that the package is
  live on npm.

### Changed

- Regenerated public GitHub gist
  (`gist.github.com/jeremylongshore/ea3205b…`) from the stale v0.5.0
  state to current v1.0.x state via `/gist-auditor` — operator audit
  refreshed, CHANGELOG section appended, npm badge added.

## [v1.0.2] - 2026-05-19

### Changed

- `packages/cli/tsup.config.ts` `onSuccess` now copies `README.md` and
  `LICENSE` from the repo root into `packages/cli/` so they ship in the
  npm tarball. The CLI directory does not own those files (canonical
  copies live at the repo root); copies are gitignored. Fixes the v1.0.0
  publish that was missing both (caught + fixed inline pre-publish,
  formalised in this commit).

  Commit: `6635489`

## [v1.0.1] - 2026-05-19

### Added

- `000-docs/025-RL-REPT-v1.0.0-release-aar-2026-05-19.md` — release
  after-action report for v1.0.0, documenting the ceremony, the two
  conditions raised by the gate, and lessons for future cuts.

  Commit: `d17e10e`

## [v1.0.0] - 2026-05-19

**First stable release.** All 10 epics complete. The system is operator-ready:
compiles a local-first knowledge base from raw sources, supports interactive
Q&A grounded in compiled wiki, runs multi-agent research tasks, and generates
durable artifacts — all with append-only audit traces and deterministic
control-plane invariants.

### Added

- Benchmark suite covering all 5 operator commands (ingest, lint, render,
  compile, ask) with deterministic synthetic corpus + per-scenario timing
  (E10-B06).
- 500-source large-corpus run + 3× per-unit degradation gate, opt-in via
  `ICO_BENCH_LARGE_CORPUS=1`.
- Claude-gating pattern (`ANTHROPIC_API_KEY` + `ICO_BENCH_INCLUDE_CLAUDE=1`)
  for benchmark scenarios that spend tokens.
- v1.0 release-readiness gate document in `000-docs/024-OD-GATE-…`.

### Changed

- `runLint` and helpers moved from `packages/cli/src/commands/lint.ts` into
  `packages/compiler/src/lint.ts` for cross-package reuse. CLI keeps the
  commander wiring + human-readable report.
- `extractCitations` (citation eval) and `extractWikilinks` (lint) regex
  handling: per-call construction or explicit `lastIndex = 0` reset to
  eliminate module-level `/g` lastIndex bleed.

### Fixed

- `ico --version` now reads the CLI's own `package.json` instead of the
  hardcoded kernel constant. Resolves release-gate Condition 1.
- Wiki index built once per batch in `runEvals` (citation specs); previous
  behaviour rebuilt the index per spec, an O(N²) walk on large batches.
- All five package.json files (root, cli, kernel, compiler, types,
  benchmarks) and `version.txt` and `kernel/src/version.ts` aligned at
  the same version. Prior auto-release workflow had been bumping root +
  version.txt only.

### Verified at v1.0

- 1,210 tests pass across 5 packages (types 14, kernel 312, compiler 461,
  cli 384, benchmarks 39).
- Performance targets met with substantial headroom: ingest ~10 ms/file
  (target <2 s), lint ~10 ms over 30 wiki pages (target <30 s).
- 3× degradation gate at 10× corpus scale: ingest ratio 1.25×, lint
  ratio 0.33× (system gets faster per-unit via cache amortisation).

## [v0.22.2] - 2026-05-19

- fix(cli): read version from CLI package.json (release-gate C1) (#74) (8f05f5f)

## [v0.22.1] - 2026-05-19

- docs(gate): v1.0 release readiness gate — GO with two conditions (E10-B11) (#73) (14aff8c)

## [v0.22.0] - 2026-05-19

- feat(benchmarks): 500-source large-corpus run + 3× degradation gate (E10-B06 PR 5) (#72) (f7bd287)

## [v0.21.0] - 2026-05-18

- feat(benchmarks): compile + ask scenarios (E10-B06 PR 4) (#71) (625691e)

## [v0.20.0] - 2026-05-17

- feat(benchmarks): render scenario + Claude-gating pattern (E10-B06 PR 3) (#70) (caae18b)

## [v0.19.0] - 2026-05-17

- feat(compiler+benchmarks): lint scenario + extract lint to @ico/compiler (E10-B06 PR 2) (#69) (701e9d6)

## [v0.18.0] - 2026-05-17

- feat(benchmarks): scaffold perf benchmark suite with ingest scenario (E10-B06 PR 1) (#68) (555ad0d)

## [v0.17.0] - 2026-05-17

- fix(kernel): cache wiki index per batch + scope citation regexes (#67) (b84d915)
- feat(kernel): retrieval precision + citation eval handler (E10-B03) (#66) (94c04cc)
- feat(compiler+kernel+cli): compilation-quality eval suite (E10-B02) (#64) (b9cf9d0)
- test(types+cli): coverage uplift on ask, research-archive, types barrel (E10-B09) (#63) (1b1ffba)
- docs(status): real-metrics status doc rewrite (E10-B08) (#62) (eb2c2d1)
- feat(cli)+docs: npm package preparation (E10-B10) (#61) (146b50e)

## [v0.16.3] - 2026-05-16

- docs(readme+claude-md): finalize v1 operations docs (E10-B07) (#60) (c241ae5)

## [v0.16.2] - 2026-05-16

- feat(cli)+compiler: error handling hardening (E10-B05) (#59) (292face)

## [v0.16.1] - 2026-05-16

- feat(cli)+docs: trace coverage audit (E10-B04) (#58) (3c6af76)

## [v0.16.0] - 2026-05-16

- feat(kernel+cli): eval framework + YAML spec format (E10-B01) (#57) (1ebb918)

## [v0.15.1] - 2026-05-15

- test(compiler): recall pipeline integration test (E9-B12) (#55) (5a07c59)

## [v0.15.0] - 2026-05-15

- feat(compiler+cli): recall export to Anki TSV (E9-B11) (#54) (7d953c3)

## [v0.14.0] - 2026-05-15

- feat(kernel+cli): retention scoring and weak-area tracking (E9-B10) (#56) (42d591a)

## [v0.13.0] - 2026-05-15

- feat(kernel+compiler+cli): quiz runner (E9-B09) (#52) (b2c52ea)

## [v0.12.1] - 2026-05-14

- chore(sweep): disable dependabot, gitignore .arch/ and beads export-state (#51) (dfadfdb)

## [v0.12.0] - 2026-05-14

- feat(compiler+cli): recall card generator (E9-B08) (#49) (ecb472a)

## [v0.11.3] - 2026-05-14

- docs(claude-md): sync state to v0.11.2, drop removed gemini-review workflow (d6b9618)

## [v0.11.2] - 2026-05-13

- chore(ci): remove obsolete gemini-review workflow (switching to Gemini app) (#48) (e4cab5d)

## [v0.11.1] - 2026-05-02

- chore(test): install audit-harness v0.1.0 (P6 batch) (#38) (fcd5db8)

## [v0.11.0] - 2026-04-17

- feat(kernel+cli): research task archival (E9-B07) (#30) (a211e3a)

## [v0.10.0] - 2026-04-16

- feat(compiler): research orchestrator (E9-B06) (#29) (20132e0)

## [v0.9.3] - 2026-04-15

- build(deps-dev): Bump typescript-eslint from 8.58.0 to 8.58.1 (#23) (6b3a657)
- build(deps-dev): Bump eslint-plugin-simple-import-sort (#21) (bfe3941)

## [v0.9.2] - 2026-04-15

- build(deps-dev): Bump @types/node from 25.5.2 to 25.6.0 (#22) (7119fb4)
- build(deps-dev): Bump globals from 17.4.0 to 17.5.0 (#17) (73ffaa5)
- build(deps): Bump actions/checkout from 4 to 6 (#14) (f1fa055)
- build(deps): Bump actions/setup-node from 4 to 6 (#12) (3f4f0d5)

## [v0.9.1] - 2026-04-15

- docs(claude): refresh project state and lock in agent conventions (921ec77)

## [v0.9.0] - 2026-04-15

- feat(compiler): integrator agent for episodic research (E9-B05) (#28) (1e5811a)

## [v0.8.0] - 2026-04-15

- feat(compiler): skeptic agent for episodic research (E9-B04) (#27) (b8ac4aa)

## [v0.7.0] - 2026-04-15

- feat(compiler): summarizer agent for episodic research (E9-B03) (#26) (a3d020d)

## [v0.6.0] - 2026-04-15

- feat(compiler): collector agent for episodic research (E9-B02) (#24) (d63e6ad)

## [v0.5.1] - 2026-04-15

- chore(ci): replace retired npm audit endpoint with OSV scanner (#25) (5de3267)

## [v0.5.0] - 2026-04-09

- feat(kernel): cognitive procfs + CWP adversarial review (#11) (8e1e080)

## [v0.4.0] - 2026-04-09

- feat(cli): implement ico research command (E9-B01) (#10) (0813732)

## [v0.3.1] - 2026-04-08

- docs: fix CLAUDE.md accuracy — test count, CLI count, dep status (338ea73)

## [v0.3.0] - 2026-04-08

- feat: Epic 8 — Render, Promote, and Durable Artifact Operations (#9) (87dfcce)

## [v0.2.0] - 2026-04-07

- feat: Epic 7 — Retrieval, Ask Flow, and Citation-Aware Answers (a80e70a)

## [v0.1.9] - 2026-04-06

- Epic 6: Knowledge Compiler Core (#7) (bfeae46)

## [v0.1.8] - 2026-04-06

- Epic 5: Ingest Adapters and Source Identity (#6) (1a46491)

## [v0.1.7] - 2026-04-06

- Epic 2: Repo Foundation — 4 packages, real tooling, 36 tests (#4) (a5c5b76)

## [v0.1.6] - 2026-04-06

- build(deps): Bump actions/checkout from 4 to 6 (#5) (3cb176a)

## [v0.1.5] - 2026-04-06

- Epic 1: Canonical Design Pack — 14 Standards Documents + Standards Freeze (#3) (e11585e)

## [v0.1.4] - 2026-04-06

- docs: 10-epic execution plan with 117 beads, 6-auditor review, and audit remediation (c731f14)
- bd init: initialize beads issue tracking (9b92472)

## [v0.1.3] - 2026-04-03

- docs: master blueprint V2 rewrite + idea changelog (b8734dc)

## [v0.1.2] - 2026-04-03

- docs: replace stubs with full enterprise docs and master blueprint (8108ef6)

## [v0.1.1] - 2026-04-03

- build(deps): Bump actions/setup-node from 4 to 6 (#2) (b7ca6d7)
- build(deps): Bump actions/checkout from 4 to 6 (#1) (b604b0d)

## [v0.1.0] - 2026-04-03

- chore: add pnpm-lock.yaml for CI cache (d9bed60)
- chore: add package.json with packageManager for CI (0214316)
- feat: initial project setup with full governance (015be55)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-02

### Added

- Initial project setup with full governance
- README, LICENSE, CODE_OF_CONDUCT, CONTRIBUTING, SECURITY, SUPPORT
- CI/CD workflows (lint, test, release automation)
- Enterprise documentation set (6-doc planning suite)
- GitHub issue templates and PR template
- Dependabot configuration
- EditorConfig and gitattributes

[Unreleased]: https://github.com/jeremylongshore/intentional-cognition-os/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jeremylongshore/intentional-cognition-os/releases/tag/v0.1.0
