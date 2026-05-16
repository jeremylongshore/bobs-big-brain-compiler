# Changelog

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
