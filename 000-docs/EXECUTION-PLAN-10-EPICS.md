# Intentional Cognition OS — 10-Epic Execution Plan

**Date:** 2026-04-05
**Blueprint version:** v2.2.0
**Repo version:** v0.1.2 (documentation only, zero application code)
**Total beads:** 117 across 10 epics (post-audit revision)

---

## Epic Summary

| Epic      | Name                                                      | Beads   | Phase | Primary Focus                                                                                                                                                                                                                                               |
| --------- | --------------------------------------------------------- | ------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Canonical Design Pack, Standards, and Execution Templates | 16      | 0.5   | Lock repo canon: frontmatter schemas, DB schema, trace schema, workspace policy, coding standards, bead conventions, testing strategy, CI/CD spec, prompt templates, promotion spec, glossary, ADR/AAR templates, diagram prompts, security+scope standards |
| 2         | Repo Foundation, Packages, and Local Runtime Skeleton     | 12      | 1     | pnpm workspace, kernel/cli/compiler/types packages, ESLint, Vitest, tsup, fixtures, CI upgrade, config loading, structured logger                                                                                                                           |
| 3         | Kernel Core: Workspace, State, Mounts, and Provenance     | 11      | 1     | Workspace init, SQLite migrations, mount registry, source registry+hashing, provenance, trace writer, task state machine, wiki index rebuilder, audit log writer                                                                                            |
| 4         | CLI Surface and Operator Workflow                         | 11      | 1     | Command router, ico init/mount/ingest/status, output formatting, error handling, workspace discovery, trace/audit inspection                                                                                                                                |
| 5         | Ingest Adapters and Source Identity                       | 10      | 1     | Markdown/PDF/web-clip adapters, adapter registry, ingest pipeline, dedup/re-ingest, human-in-the-loop, batch ingest                                                                                                                                         |
| 6         | Knowledge Compiler Core                                   | 12      | 2     | Claude API wrapper, all 6 passes (Summarize, Extract, Synthesize, Link, Contradict, Gap), ico compile, staleness, frontmatter validation, token tracking                                                                                                    |
| 7         | Retrieval, Ask Flow, and Citation-Aware Answers           | 10      | 2     | FTS5 search, question analysis, answer generation+citations, citation verification, ico ask, ico lint knowledge, search tuning                                                                                                                              |
| 8         | Render, Promote, and Durable Artifact Operations          | 11      | 2-3   | Report renderer, Marp slides, ico render/promote, promotion engine (7 rules, 3 anti-patterns), artifact metadata, unpromote reversal                                                                                                                        |
| 9         | Episodic Research, Stewardship, and Recall                | 12      | 3-4   | Research task creation, 4 agent roles (Collector, Summarizer, Skeptic, Integrator), orchestrator, recall cards, quiz runner, retention, Anki export                                                                                                         |
| 10        | Traces, Evals, Hardening, Remote Readiness, and v1 Gate   | 12      | 4     | Eval framework, compilation+retrieval evals, trace audit, error hardening, performance profiling, coverage closure, npm prep, v1 gate+release                                                                                                               |
| **Total** |                                                           | **117** |       |                                                                                                                                                                                                                                                             |

---

## Dependency Spine

```
E1 ──► E2 ──► E3 ──┬──► E4 ──┬──► E5 ──► E6 ──► E7 ──► E8 ──┬──► E9 ──► E10
                    │         │                                │         ▲
                    └─────────┘                                └─────────┘
                  (E4 needs E2+E3)                          (E9 needs E6+E7+E8)
                                                             (E10 needs all)
```

### Epic-Level Dependencies

| Epic | Depends On            |
| ---- | --------------------- |
| 1    | — (root)              |
| 2    | E1                    |
| 3    | E2                    |
| 4    | E2, E3                |
| 5    | E3, E4                |
| 6    | E5                    |
| 7    | E6                    |
| 8    | E7                    |
| 9    | E6, E7, E8            |
| 10   | E9 (transitively all) |

---

## Critical Path (Longest Dependency Chain)

```
E1-B01 (frontmatter schemas)
  → E2-B05 (shared types with Zod)
    → E3-B04 (source registry + hashing)
      → E5-B05 (ingest pipeline)
        → E6-B02 (summarize pass)
          → E6-B03 (extract pass)
            → E7-B01 (FTS5 search)
              → E7-B05 (ico ask)
                → E8-B01 (report render)
                  → E9-B06 (research orchestrator)
                    → E10-B11 (v1 gate)
```

This traces the core operating loop: **schema → types → state → ingest → compile → search → ask → render → research → release**.

---

## Package Structure

```
packages/
  types/       — Shared TypeScript interfaces and Zod schemas
  kernel/      — Deterministic substrate: workspace, state, mounts, provenance, traces, tasks
  compiler/    — Probabilistic layer: adapters, compiler passes, ask flow, render, agents
  cli/         — Commander.js CLI: all ico commands
```

Uses `packages/` prefix for pnpm workspace convention (standard monorepo practice).

---

## Parallelization Opportunities

### Epic 1 (16 beads)

B00-B07, B13, B14, B15 have **no internal dependencies** — can be done in parallel across sessions.

### Epics 3 + 4 (after E2)

E3-B01 (workspace) and E3-B09 (audit log) have no intra-E3 deps beyond E2. Can start immediately after E2.

### Within any epic

Most epics have 4-6 beads that can start as soon as the epic's prerequisites are met. Only integration tests and reviews require all prior beads.

---

## Recommended Execution Order

### Start with Epic 1

Every later epic references standards from Epic 1. Starting implementation before schemas and conventions are locked risks rework. Epic 1's parallel beads (B00-B07, B13, B14, B15) provide natural session boundaries.

### Then Epic 2

Repo foundation is purely mechanical — package scaffolding, tooling config. Low risk, high unlock value.

### Then Epics 3 + 4 (overlap possible)

E3 builds the kernel (deterministic substrate). E4 needs E3 complete for real commands, but E4-B01 (command router) and E4-B06 (output formatting) can start from E2 alone.

### Then Epic 5 → 6 → 7 → 8 (sequential)

Each builds on the previous. This is the core implementation chain.

### Then Epic 9

Multi-agent research and recall. Highest complexity, highest API cost.

### Finally Epic 10

Hardening, evals, release gate. Only after all features exist.

---

## Post-Audit Revision (2026-04-05)

A 6-auditor review (architecture, security, risk/dependency, test strategy, product management, doc consistency) identified 53 findings across CRITICAL/HIGH/MEDIUM/LOW severity. All findings were addressed:

**Structural fixes:**

- ~75 cross-epic bead-to-bead dependencies wired (previously only intra-epic + epic-level)
- 3 new beads added: E1-B15 (security+scope standards), E4-B11 (trace inspection), E8-B11 (unpromote)
- Total beads: 114 → 117

**Security hardening (woven into existing beads):**

- Prompt injection defense in E1-B09, E6-B01, E6-B02
- API key redaction in E2-B11, E2-B12, E3-B06
- SQL injection prevention in E1-B05
- Path traversal/symlink defense in E5-B05
- Audit trail integrity (hash chain) in E1-B03, E3-B06
- Dependency supply chain audit in E2-B10

**Architecture fixes:**

- Entity pages added to E6-B03 (Extract pass produces concepts + entities)
- Task lifecycle expanded to 7 states in E1-B02
- Builder agent role documented as absorbed into orchestrator + E8 render pipeline
- Compile pass ordering specified in E6-B08
- Concurrency policy (WAL + lockfile) added to E1-B02, E3-B02

**Test strategy improvements:**

- Cross-package integration test requirement in E1-B07
- Fixture tier system (raw, compiled, task, eval) in E1-B07
- Deterministic quality guards in E6-B12 (run in CI without API key)
- Non-interactive test modes for E5-B07 and E9-B09
- Corruption recovery tests in E3-B10
- Regression checkpoint: "all prior integration tests pass" in every epic exit criteria

**Doc consistency fixes:**

- Terminology drift fixed: "semantic memory" → "semantic knowledge" in CLAUDE.md and README.md
- 5-stage operating loop restored in README.md
- `packages/` paths updated in CLAUDE.md component table
- Missing blueprint and execution plan references added

---

## Verification Checklist

After this plan is fully registered:

- [ ] `bd list --type epic` shows 10 epics
- [ ] `bd count` shows 127 total (10 epics + 117 child beads)
- [ ] `ls 000-docs/epics/` shows 10 epic reference docs
- [ ] `000-docs/EXECUTION-PLAN-10-EPICS.md` exists (this file)
- [ ] `000-docs/IDEA-CHANGELOG.md` has the planning milestone entry
- [ ] `bd ready` shows Epic 1 beads as first available work
- [ ] Cross-epic dependencies wired (bd dep list on key beads shows cross-epic links)

---

## Reference

- Epic reference docs: `000-docs/epics/epic-{01..10}.md`
- Master blueprint: `000-docs/007-PP-PLAN-master-blueprint.md`
- Architecture: `000-docs/003-AT-ARCH-architecture.md`
- Technical spec: `000-docs/005-AT-SPEC-technical-spec.md`
- Product requirements: `000-docs/002-PP-PRD-product-requirements.md`
