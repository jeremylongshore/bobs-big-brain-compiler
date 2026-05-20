# Epic 8: Render, Promote, and Durable Artifact Operations

**Objective:** Turn answers and research into durable reusable assets. After this epic, `ico render report`, `ico render slides`, and `ico promote` work. Artifacts are durable markdown files in workspace/outputs/.

**Why it exists:** Knowledge compilation and retrieval are valuable, but the operator needs to produce deliverables — reports, presentations, reference documents. Promotion is what makes ephemeral outputs durable by moving them into the semantic knowledge layer.

**What it unlocks:** Epics 9-10 (research output rendering, v1 completion)

**Dependencies:** Epic 7

**Phase:** 2-3

---

## Scope

### Included

- Report renderer (structured markdown with citations)
- Slide deck renderer (Marp-compatible markdown)
- ico render command with report/slides subcommands
- Promotion engine enforcing all 7 rules and detecting 3 anti-patterns
- ico promote command with confirmation and --dry-run
- Rendered artifact frontmatter and metadata
- Render from research task output capability
- Artifact listing and discovery
- Post-promotion wiki index and lint refresh
- Integration test suite

### Excluded

- Research task creation and agent orchestration (Epic 9)
- Recall/flashcard generation (Epic 9)
- Evaluation framework (Epic 10)

---

## Beads

### E8-B01: Report Renderer

- **Depends on:** E6-B01, E7-B01, E3-B07
- **Produces:** `packages/compiler/src/render/report.ts`. renderReport() gathers content from completed task or compiled topic → sends to Claude → structured markdown report with title, executive summary, findings, evidence with citations, conclusion, source list. Saves to workspace/outputs/reports/<slug>.md.
- **Verification:** Report from compiled topic has all sections, citations, source list. File in workspace/outputs/reports/.

### E8-B02: Slide Deck Renderer (Marp)

- **Depends on:** E6-B01, E7-B01
- **Produces:** `packages/compiler/src/render/slides.ts`. renderSlides() → Marp-compatible markdown with YAML frontmatter (marp: true), slide separators (---), speaker notes. Saves to workspace/outputs/slides/<slug>.md.
- **Verification:** Output is Marp-compatible. Has title slide, content slides, summary slide. Marp CLI can convert to HTML/PDF.

### E8-B03: ico render Command Implementation

- **Depends on:** E8-B01, E8-B02, E4-B01
- **Produces:** `packages/cli/src/commands/render.ts`. Subcommands: `render report --task <id>`, `render report --topic <name>`, `render slides --task <id>`, `render slides --topic <name>`. Flags: --title, --output. Shows progress, token usage. Trace event. Audit log.
- **Verification:** `render report --topic X` produces file. `render slides --topic X` produces file. Both show progress. Trace written.

### E8-B04: Promotion Engine

- **Depends on:** E1-B10, E3-B02, E3-B06
- **Produces:** `packages/kernel/src/promotion.ts`. promoteArtifact() validates: (1) source in outputs/, (2) valid target type, (3) copies to wiki/<type>/ using atomic writes (write to temp file, then rename — audit M9), (4) updates frontmatter, (5) records in promotions table, (6) writes trace, (7) appends audit. Enforces 7 rules, detects 3 anti-patterns.
- **Verification:** Promote report as topic → file copied atomically, frontmatter updated, record created, trace written. Wrong directory → rejected. Invalid type → rejected. All 7 rules enforced. All 3 anti-patterns detected. Interrupted write does not leave partial file.

### E8-B05: ico promote Command Implementation

- **Depends on:** E8-B04, E4-B01
- **Produces:** `packages/cli/src/commands/promote.ts`. `ico promote <path> --as <type>`. Shows preview, asks confirmation (unless --yes). Suggests `ico lint knowledge` after. Supports --dry-run.
- **Verification:** Promote file → confirmation shown, success with new path. --dry-run previews. --yes skips confirmation. Invalid path/type → clear error.

### E8-B06: Rendered Artifact Frontmatter and Metadata

- **Depends on:** E8-B01, E8-B02, E2-B05
- **Produces:** Frontmatter on all artifacts: type, title, generated_at, generated_from, source_pages, model, tokens_used. validateArtifact() verifies.
- **Verification:** All artifacts have complete frontmatter. Validation catches missing fields. generated_from traceable.

### E8-B07: Render from Research Task Output

- **Depends on:** E8-B01, E3-B07
- **Produces:** `packages/compiler/src/render/task-renderer.ts`. gatherTaskOutput() reads task output/ directory → prepares for renderer. Non-completed task → error.
- **Verification:** Fixture task with output files → gathered correctly. Non-completed task → rejected.

### E8-B08: Artifact Listing and Discovery

- **Depends on:** E4-B05, E8-B06
- **Produces:** Enhanced `ico status --artifacts` listing all artifacts with metadata: title, type, date, source, size, promotion status.
- **Verification:** After rendering 2 artifacts: status shows both. Promoted artifacts marked.

### E8-B09: Render and Promote Integration Test Suite

- **Depends on:** E8-B01 through E8-B08
- **Produces:** `packages/cli/src/__tests__/render-promote-integration.test.ts`. Tests: (1) compile topic → render report, (2) render slides → verify Marp, (3) promote report to wiki, (4) invalid promotion → rejection.
- **Verification:** All 4 scenarios pass. Full render → promote → lint loop.

### E8-B10: Post-Promotion Wiki Index and Lint Refresh

- **Depends on:** E8-B04, E3-B08, E7-B06
- **Produces:** Post-promotion hooks: wiki index rebuild, targeted lint on promoted page.
- **Verification:** After promotion: index.md includes new page. Lint result shown. Schema issues warned.

### E8-B11: Unpromote and Promotion Reversal

- **Depends on:** E8-B04
- **Produces:** `packages/cli/src/commands/unpromote.ts`. `ico unpromote <path>` reverses a promotion: removes the file from wiki/<type>/, deletes the promotions table record, writes trace event, appends audit log. Supports --dry-run. (audit M9/M16)
- **Verification:** Unpromote previously promoted file → file removed from wiki, promotions record deleted, trace written, audit logged. --dry-run previews without changes. Unpromote of non-promoted file → clear error.

---

## Exit Criteria

1. `ico render report` produces structured markdown with citations
2. `ico render slides` produces Marp-compatible slide decks
3. `ico promote` files artifacts into wiki with full audit trail
4. All 7 promotion rules enforced
5. All 3 promotion anti-patterns detected
6. Rendered artifacts have complete frontmatter metadata
7. Post-promotion wiki index and lint refresh works
8. Integration tests cover render → promote loop
9. Promotion can be reversed with `ico unpromote`
10. All prior integration tests remain green

---

## Risks / Watch Items

- **Marp format requirements:** Claude must produce valid Marp. Mitigation: validate structure before writing, provide template.
- **Promotion is a quality gate:** operator must understand what they're promoting. Mitigation: confirmation step + --dry-run.
- **Report quality depends on compilation + prompt quality.** Mitigation: iterate prompts manually.
