# Epic 9: Episodic Research, Stewardship, and Recall

**Objective:** Move beyond static query/answer into scoped research and human retention. After this epic, `ico research` creates multi-agent task workspaces, and `ico recall` generates flashcards and quizzes.

**Why it exists:** Simple Q&A is not enough for hard problems. Research tasks need structured working memory — evidence collection, synthesis, criticism, integration. Recall ensures the human actually retains what the system compiles. Together, these close the loop on the "improve human understanding over time" part of the product thesis.

**What it unlocks:** Epic 10 (hardening and release — all features now exist)

**Dependencies:** Epics 6, 7, and 8

**Phase:** 3-4

---

## Scope

### Included

- Research task creation with directory structure and brief
- Four agent roles: Collector, Summarizer, Skeptic, Integrator
- Research orchestrator sequencing all agents
- Task archival
- Recall card generator from compiled knowledge
- Interactive quiz runner with scoring
- Retention scoring and weak-area tracking
- Anki export
- Integration test suite

### Excluded

- Remote collaboration (future scope)
- External tool integration (browsing, code execution — future)
- Adaptive spaced repetition scheduling (future — only basic retention tracking)

---

## Beads

### E9-B01: Research Task Creation

- **Depends on:** E3-B07, E4-B01
- **Produces:** `packages/cli/src/commands/research.ts`. `ico research <brief>` creates task workspace: ID (task-YYYYMMDD-NNN), directory structure (evidence/, notes/, drafts/, critique/, output/), SQLite record, brief.md, trace event, audit log.
- **Verification:** Creates directory structure. SQLite record with status 'created'. brief.md exists. Trace event written.

### E9-B02: Collector Agent

- **Depends on:** E9-B01, E7-B01, E3-B07
- **Produces:** `packages/compiler/src/agents/collector.ts`. collectEvidence() searches compiled knowledge for relevant pages → copies excerpts to tasks/<id>/evidence/ as individual files with source citations → transitions to 'collecting'.
- **Verification:** Brief + compiled wiki → relevant evidence files. Each file cites source. Task status → 'collecting'. Trace events recorded.

### E9-B03: Summarizer Agent

- **Depends on:** E9-B02, E6-B01
- **Produces:** `packages/compiler/src/agents/summarizer.ts`. summarizeEvidence() reads evidence/ → synthesizes into working notes in notes/ → transitions to 'synthesizing'.
- **Verification:** Evidence files → coherent working notes with citations. Non-redundant. Task → 'synthesizing'.

### E9-B04: Skeptic Agent

- **Depends on:** E9-B03, E6-B01
- **Produces:** `packages/compiler/src/agents/skeptic.ts`. critiqueFindings() reads notes/ → identifies weak evidence, unsupported claims, missing perspectives, logical gaps → writes to critique/ → transitions to 'critiquing'.
- **Verification:** Working notes → critique with at least one concern. References specific claims. Task → 'critiquing'.

### E9-B05: Integrator Agent

- **Depends on:** E9-B04, E6-B01
- **Produces:** `packages/compiler/src/agents/integrator.ts`. integrateFindings() reads notes + critique → synthesizes final answer addressing critique → writes to output/ → transitions to 'rendering'.
- **Verification:** Incorporates critique feedback. Output addresses skeptic's concerns. Task → 'rendering'.

### E9-B06: Research Orchestrator

- **Depends on:** E9-B01 through E9-B05
- **Produces:** `packages/compiler/src/agents/orchestrator.ts`. executeResearch() sequences: Collector → Summarizer → Skeptic → Integrator. Supports --step mode that pauses between agents for operator review (audit M16). Enforces token budget via ICO_MAX_RESEARCH_TOKENS env var with hard limit; displays estimated cost before starting and aborts gracefully if budget exceeded (audit M4). Displays running token count at each phase transition. Does NOT copy directly to workspace/outputs/ — instead triggers E8 render pipeline for the L3→L4 transition (audit M8). Error recovery: if an agent fails, task transitions to a recoverable state (e.g., 'failed_collecting'), not stuck forever; operator can retry from that phase (audit M9).
- **Verification:** Full cycle: created → collecting → synthesizing → critiquing → rendering → completed. Output rendered through E8 pipeline. All agent outputs exist. Trace events for each transition. --step mode pauses correctly. Budget exceeded → graceful abort. Agent failure → recoverable state, not stuck.

### E9-B07: Research Task Archival

- **Depends on:** E9-B06, E3-B07
- **Produces:** `packages/kernel/src/archive.ts`, CLI subcommand. archiveTask() transitions completed → archived. Directory preserved but marked. `ico research archive <taskId>`. Archived tasks preserve the full directory (evidence/, notes/, drafts/, critique/, output/) for audit purposes — no files are deleted.
- **Verification:** Archived task → status 'archived'. Not in active status counts. Full directory exists intact but flagged. Non-completed → rejected.

### E9-B08: Recall Card Generator

- **Depends on:** E6-B01, E7-B01, E4-B01
- **Produces:** `packages/compiler/src/recall/generate.ts`. `ico recall generate --topic <name>`. Reads compiled knowledge → generates flashcards + quiz questions → saves to recall/cards/ and recall/quizzes/. Cards reference source pages. Provenance tracking: each card records which compiled pages it was generated from and generation timestamp, enabling staleness detection when source pages are recompiled (audit M7).
- **Verification:** Cards generated with questions, answers, source references. Frontmatter includes topic, generated_at, source_pages (with page IDs). Recompiling a source page → cards from that page detected as stale.

### E9-B09: Quiz Runner

- **Depends on:** E9-B08, E6-B01
- **Produces:** `packages/cli/src/commands/recall.ts`. `ico recall quiz [--topic <name>]`. Interactive: presents questions, accepts answers, AI-scores short answers, records results in recall_results table. Final score and weak areas. Supports --non-interactive / --answers-file <path> option for CI testing (audit M13): reads answers from a JSON file to exercise the full quiz flow in automated tests without human input.
- **Verification:** Questions display, answers accepted, scoring works. Results in SQLite. Final score shown. --answers-file with JSON fixture → full quiz completes non-interactively with correct scoring.

### E9-B10: Retention Scoring and Weak-Area Tracking

- **Depends on:** E9-B09, E3-B02
- **Produces:** `packages/kernel/src/retention.ts`. updateRetention(), getWeakAreas(), getRetentionReport(). `ico recall weak` shows lowest-scoring concepts. Weak concepts prioritized in future generation.
- **Verification:** Wrong answers → lower retention scores. `ico recall weak` shows lowest. Overall stats reported.

### E9-B11: Recall Export (Anki Format)

- **Depends on:** E9-B08
- **Produces:** `packages/compiler/src/recall/export.ts`. `ico recall export --format anki`. Tab-separated text: front, back, tags (topic, source). Anki-importable.
- **Verification:** Valid tab-separated file. Cards have front, back, tags. Importable into Anki.

### E9-B12: Research and Recall Integration Test Suite

- **Depends on:** E9-B01 through E9-B11
- **Produces:** Integration tests: (1) full research pipeline, (2) recall card generation quality, (3) quiz scoring and retention tracking.
- **Exit gate:** All prior integration tests remain green (audit H11).
- **Verification:** Research completes all stages. Cards generated from compiled knowledge. Quiz scoring updates retention. All tests pass. All prior epic integration tests (E3-E8) still pass.

---

## Exit Criteria

1. `ico research` creates scoped task and runs full agent pipeline
2. Task lifecycle follows state machine through all stages
3. Research output appears in workspace/outputs/ for promotion
4. `ico recall generate` produces flashcards and quiz questions
5. `ico recall quiz` runs interactive quiz with scoring
6. `ico recall weak` shows lowest retention concepts
7. `ico recall export` produces Anki-compatible output
8. Integration tests cover full research and recall loops

---

## Risks / Watch Items

- **Multi-agent quality cascade:** bad collector output ruins everything. Mitigation: --step mode for review between agents.
- **Quiz scoring subjectivity** for open-ended answers. Mitigation: strict rubric for AI scoring.
- **Recall card quality:** AI cards can be trivial or too complex. Mitigation: generate more, let operator curate.
- **Research pipeline cost:** 4+ API calls per task. Mitigation: token budget (ICO_MAX_RESEARCH_TOKENS), estimated cost displayed before starting, --step mode for manual review. Use sonnet for collection/summarization, opus for integration.

## Design Notes

- **Builder agent role:** The Builder agent role from blueprint Section 8.2 is fulfilled by piping Integrator output through the Epic 8 render pipeline (E8-B07). This reduces from 5 to 4 agent roles — a deliberate design decision.
