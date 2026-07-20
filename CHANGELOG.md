# Changelog

## [1.23.0](https://github.com/jeremylongshore/bobs-big-brain-compiler/compare/v1.22.0...v1.23.0) (2026-07-20)


### Features

* **compile:** gate model output, attribute sources, and extend audit verification (l13.1/.5/.7/.8) ([#181](https://github.com/jeremylongshore/bobs-big-brain-compiler/issues/181)) ([7927204](https://github.com/jeremylongshore/bobs-big-brain-compiler/commit/79272047ffaa7fb22483060b9080a8d0a0f5cf2a))
* MiniMax-M3 distiller with groundedness eval + scheduled faithfulness floor (l13.9/l13.10) ([#180](https://github.com/jeremylongshore/bobs-big-brain-compiler/issues/180)) ([fb96c06](https://github.com/jeremylongshore/bobs-big-brain-compiler/commit/fb96c0669a1e12bf54b4051627637e23bf2d5c44))
* receipts-precede-visibility floor (G1) + cross-day trace chaining (G3) ([#176](https://github.com/jeremylongshore/bobs-big-brain-compiler/issues/176)) ([a4b7922](https://github.com/jeremylongshore/bobs-big-brain-compiler/commit/a4b79225fa849a5880ce77b537a33cff65c8f683))

## [Unreleased]

### Changed

- The GitHub repository was renamed from `intentional-cognition-os` to `bobs-big-brain-compiler` on 2026-07-19 (public product name: **Bob's Big Brain Compiler**). GitHub 301-redirects the old URLs. The npm package name `intentional-cognition-os`, the `@ico/*` scope, and the bead prefixes are unchanged.

## [v1.22.0] - 2026-07-18

### Changed

- **Releases are now PR-gated.** The auto-release workflow used to push a `chore(release)` commit directly to `main`, which the branch-protection required-check gate (CodeQL) now correctly declines — leaving orphan tags. The `push: [main]` auto-trigger is removed; releases go through a version-bump PR (which passes CodeQL like any change) + a tag, matching the rest of the stack. The `workflow_dispatch` path is retained. (see `.github/workflows/release.yml`)

### Added

- `ico spool emit --bulk` stamps every emitted candidate `source: bulk_import` + `trustLevel: untrusted`, so a whole-machine digestion is distinguishable from a curated import and INTKB's `source_trust` policy can flag it for review (default emit stays `import`/`medium`). (#168)
- Advisory-only MiniMax-M3 PR reviewer with two independent lanes (defect + claims); non-blocking, fork-safe (runs on `pull_request`, never hands the API key to forked code), gated behind `ENABLE_MINIMAX_REVIEW`. (#166)
- On any merge that touches `CHANGELOG.md`, dispatch a `changelog-updated` event to the umbrella so its aggregated changelog mirror refreshes immediately instead of waiting for the weekly cron. (#155)

### Fixed

- README corrected for the current compile engine: the model backend is a pluggable provider registry (Claude by default, or any OpenAI-/Anthropic-wire provider / local server via `ICO_PROVIDER`), not Claude-only; and the ecosystem link repointed to the renamed umbrella repo `intent-solutions-io/bobs-big-brain-umbrella`. (#167)

## [v1.21.0] - 2026-07-01

- feat(compile): governed freshness via incremental compile + DeepSeek cost gate (e06.5 / R12) (#154) (af3a7eb)

## [v1.20.0] - 2026-07-01

- feat(evals): sampled compile-faithfulness (groundedness) eval (#153) (f428ab5)

## [v1.19.1] - 2026-06-25

- fix(compiler,kernel): address review feedback on #149/#150 (#151) (decc7f1)

## [v1.19.0] - 2026-06-24

- feat(compiler): model-agnostic provider registry (anthropic/openai/local) (#149) (22914b0)

## [v1.18.0] - 2026-06-24

- feat(compiler): cross-batch contradiction detection via reduce pass (v2) (#150) (25498cf)

## [v1.17.3] - 2026-06-24

- fix(cli): read spool.tenantId from .ico/config.json (was a dead path) (#148) (ed2ef9d)

## [v1.17.2] - 2026-06-24

- fix(compiler): auto-scale the per-batch token ceiling + warn on truncation (#147) (f0d997f)

## [v1.17.1] - 2026-06-24

- fix(compiler): default DeepSeek to deepseek-chat + read reasoning_content (#146) (03786a3)

## [v1.17.0] - 2026-06-23

- feat(compiler): batch the cross-source compile passes (scale to large corpora) (#145) (c4062d4)

## [v1.16.1] - 2026-06-22

- EPIC 0 — ICO->INTKB spool write side (#142) (1aa9f74)
- chore(beads): close cze.1 — ingest disclosure guard merged (#144) (3d5ff4f)

## [v1.16.0] - 2026-06-21

- feat(ingest): reject comp/PII at the source with an ico ingest disclosure guard (cze.1) (#144) (051fc1c)

## [v1.15.0] - 2026-06-21

- feat(kernel): extract canonical content-derived UUID v5 derivation (EPIC 1) (#143) (a55a9d9)
- docs(readme): fix stale MIT license, version 1.0.5→1.14.0, 14→16 commands (#141) (e755fa2)
- chore(beads): link epic cze ↔ GH #140 ↔ Plane ICOS-24 (three-layer mirror) (2c5679b)
- chore(beads): track ICO ingest-time disclosure enforcement (epic cze) (6da4526)
- test(cli): command coverage for init/status/unpromote + index handlers (#139) (4ed5f62)
- docs: settle DECR 035 license to Apache-2.0 + canonicalize umbrella name (#138) (56f200c)

## [v1.14.0] - 2026-06-17

- feat(compiler): DeepSeek (OpenAI-compatible) LLM provider via ICO_PROVIDER (#137) (3226000)
- docs: fix ICO version drift in CLAUDE.md (1.6.1 → 1.12.0) (#136) (c55c297)
- docs(evals): cc-workflow-tools evaluation (gstack/superpowers/last30days) (f748949)
- chore(deps): bump @intentsolutions/audit-harness ^0.1.0 → ^1.1.5 (#134) (c9afc7b)

## [v1.13.0] - 2026-06-03

- feat(evals): add first-class functional-quality eval type (#133) (1192ad7)
- chore(beads): close 0wy.7 — CLI coverage past 80% (#132) (df666e9)
- test(cli): climb CLI coverage past 80% via command-driven tests (0wy.7) (#132) (9d6b685)
- chore(beads): close 0wy.8 — property tests merged (#131) (556843a)
- test(kernel): property-based tests for the deterministic core (0wy.8) (#131) (de802aa)

## [v1.12.0] - 2026-06-03

- feat(eval): emit canonical Evidence Bundle from ico eval run (--emit-bundle) (#130) (b03d011)
- chore: relicense MIT -> Apache-2.0 (match the IEP ecosystem) (#129) (bf33d6a)

## [v1.11.0] - 2026-06-03

- feat(deps): add @intentsolutions/core as a dependency (Evidence Bundle prerequisite) (#128) (7ee7b81)
- docs: add README banner (compile-layer, house style) (#127) (cb72417)
- docs: cross-link the Compile-Then-Govern ecosystem umbrella (#126) (de2605e)
- chore(beads): close 8rl — nightly smoke inherits INTKB's pinned qmd (#125) (7c7aed4)
- ci(nightly-smoke): inherit INTKB's pinned qmd, drop bun-global (intentional-cognition-os-8rl) (#125) (3a5a59f)

## [v1.10.0] - 2026-05-31

- chore(beads): close lz2 — key-free nightly smoke merged (#124) (20902f8)
- feat(ci): key-free nightly smoke of the deterministic cross-repo chain (lz2) (#124) (c81483a)
- docs(dogfood): record first full-green demo-e2e run (real key) (#123) (96a3d92)

## [v1.9.0] - 2026-05-31

- feat(demo): wire stages 5-6 (export → qmd index → search citation) in demo-e2e.sh (#122) (87c9231)

## [v1.8.1] - 2026-05-30

- fix(cli/compile): fail loudly on auth errors + all-source failures (u0j) (#121) (bb15953)
- chore(beads): file u0j — ico compile silent-fail on bad ANTHROPIC_API_KEY (23db8bd)
- chore(demo): wire scripts/demo-e2e.sh stage 4 to INTKB curator-cli (#120) (9b0bb58)

## [v1.8.0] - 2026-05-29

- feat(cli/audit): add --json mode + CLI handler tests + wire into demo (bvf) (#119) (7c551d5)

## [v1.7.0] - 2026-05-29

- feat(demo): add scripts/demo-e2e.sh — cross-repo proof-of-work orchestrator (1at) (#118) (aaca71b)
- ci(codecov): add Test Analytics + Components baseline customization (#117) (a1b79b8)
- ci(codecov): wire up Codecov coverage upload + project + patch gates (#116) (062e295)
- test(cli/spool): add handler tests for ico spool emit (zp6) (#115) (6d4ebc5)
- chore(beads,docs): file Q1 cross-repo proof-of-work demo epic + CLAUDE.md pointer (832ca87)
- docs(claude-md): refresh project state to v1.6.1 + bd race warning (b2c3403)
- chore(beads): re-close lhm (rapid-write race clobbered prior close) (d380fdc)

## [v1.6.1] - 2026-05-27

- Merge pull request #113 from jeremylongshore/docs/readme-tagline-version-align (78082c5)
- docs(readme): add v1.6.0 version suffix + align tagline with gist (8470685)
- chore(beads): final state — nwh closed, three epics closed, 11 deferred (e7e8c62)
- Merge pull request #112 from jeremylongshore/feat/plugin-scripts-lint-nwh (246b801)
- chore(beads): defer 11 P3 beads to 2026-07-01 + close 3 epics (39ee882)
- ci(plugin-lint): add shellcheck + ruff CI job for plugin scripts (nwh) (7ecebc7)
- Merge pull request #111 from jeremylongshore/feat/docs-sweep-dsn-55q.3 (1965501)
- docs(037): tighten GFM table-cell + YAML escape rationale (closes dsn) (19577e1)

## [v1.6.0] - 2026-05-27

- Merge pull request #110 from jeremylongshore/feat/test-hygiene-quickwins-0wy.2-wie (b910839)
- feat(test-hygiene): rename stryker config to ESM + extract scenario helper (491292d)
- chore(beads): close 7xp — paraphrase_robustness metric verified end-to-end (9e7af64)

## [v1.5.2] - 2026-05-26

- Merge pull request #109 from jeremylongshore/feat/audit-chain-race-fix-lhm (312c2e0)
- fix(kernel/audit): use FD-based open+fstat+write (CodeQL canonical safe pattern) (d32460a)
- fix(kernel/audit): drop existsSync check-then-use pattern in writeTrace (ad08dac)
- fix(kernel/audit): serialize writeTrace under SQLite EXCLUSIVE lock (lhm) (d09d62c)

## [v1.5.1] - 2026-05-26

- chore(beads): file P4 sweep bead for doc 037 prose polish (GFM table-cell escape semantics) (d870d64)
- Merge pull request #108 from jeremylongshore/fix/codeql-triage-corrections (2974682)
- fix(docs/security): correct CodeQL triage — hash-chain race is real, alert #13 reopened (fb11fb1)
- chore(beads): close 0wy.3 (CodeQL triage), file lhm (reliability follow-up) (d98b0d6)
- Merge pull request #107 from jeremylongshore/feat/codeql-triage-0wy.3 (96f69e0)
- docs(security): CodeQL alert triage — 31 dismissed, 1 follow-up bead (1613593)
- chore(beads): nhj.1 + 0wy.1 closed, 2v4 filed (compiler mutation deferral) (8e14ed8)

## [v1.5.0] - 2026-05-26

- Merge pull request #106 from jeremylongshore/feat/stryker-baseline-lock-0wy.1 (01490d8)
- feat(mutation): lock Stryker kernel baseline at 55% floor + wire to PR gate (e083c51)
- chore(beads): nhj.1 — upstream comment posted on gastownhall/beads#4135 (b03a2f0)
- chore(beads): close nhj.1 — dossier + candidate staged for upstream beads (4f6f6f0)
- Merge pull request #105 from jeremylongshore/chore/steveyegge-to-gastownhall-and-nhj.1-dossier (eda7f63)
- chore(beads): update upstream repo references steveyegge → gastownhall (b590258)
- chore(beads): sync state — close 55q.4 + cross-layer mirror evidence (916b005)

## [v1.4.4] - 2026-05-25

- Merge pull request #104 from jeremylongshore/feat/bd-sync-race-gemini-followups (43699e6)
- fix(bd-sync-repro): address PR #103 Gemini review findings (0e60ba5)

## [v1.4.3] - 2026-05-25

- Merge pull request #103 from jeremylongshore/feat/bd-sync-rapid-write-race-55q.4 (bf57454)
- fix(bd-sync): flush JSONL after every bead-side write (55q.4) (dbb3f87)
- Merge pull request #102 from jeremylongshore/feat/release-filter-nul-records (880ccbe)
- ci(release): fix commit-type filter — NUL records + line-anchored regex (19e0d22)

## [v1.4.2] - 2026-05-25

- Merge pull request #101 from jeremylongshore/feat/release-skip-chore-only (f242602)
- ci(release): emit single trailing newline + clean existing CHANGELOG (6d868d8)
- ci(release): skip release when commits since last tag are chore-only (0934483)

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

[Unreleased]: https://github.com/jeremylongshore/bobs-big-brain-compiler/compare/v1.22.0...HEAD
[0.1.0]: https://github.com/jeremylongshore/bobs-big-brain-compiler/releases/tag/v0.1.0
