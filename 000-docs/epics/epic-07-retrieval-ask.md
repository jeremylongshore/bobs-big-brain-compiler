# Epic 7: Retrieval, Ask Flow, and Citation-Aware Answers

**Objective:** Make compiled knowledge queryable in a trustworthy way. After this epic, `ico ask` returns sourced, traceable answers over compiled knowledge. Retrieval is markdown-first (full-text search, no vector DB).

**Why it exists:** Without retrieval, compiled knowledge sits idle. The ask flow is how the operator gets answers from their knowledge base. Citation awareness and provenance tracing are what make the answers trustworthy rather than hallucinated.

**What it unlocks:** Epics 8-10 (render, research, release all depend on queryable knowledge)

**Dependencies:** Epic 6

**Phase:** 2

---

## Scope

### Included

- FTS5 full-text search over compiled pages
- Question analysis and decomposition
- Answer generation with inline citations
- Citation verification against real compiled pages
- Provenance chain from answer back to raw source
- ico ask command implementation
- ico lint knowledge command
- Ask flow trace logging with retrieval hits
- Search quality tuning and relevance scoring
- No-knowledge fallback handling
- Integration test suite

### Excluded

- Vector database / embeddings (explicitly deferred per blueprint)
- Report/slide rendering from answers (Epic 8)
- Multi-agent research (Epic 9)

---

## Beads

### E7-B01: Full-Text Search over Compiled Pages

- **Depends on:** E3-B02, E6-B02 through E6-B07
- **Produces:** `packages/kernel/src/search.ts`. FTS5 indexing of compiled page content and frontmatter (title, tags, type). Functions: indexCompiledPages(), searchPages() with ranked results and snippets, findRelevantPages() for natural language questions.
- **Verification:** Index 10 fixture pages. Known term search → correct pages. Phrase search → ranked results. FTS5 snippets work.

### E7-B02: Question Analysis and Decomposition

- **Depends on:** E6-B01, E7-B01
- **Produces:** `packages/compiler/src/ask/analyze.ts`. analyzeQuestion() classifies question (factual, comparative, analytical, open-ended), determines relevant pages, decomposes complex questions, recommends direct answer vs research task.
- **Verification:** "What is X?" → factual, concept page found. "Compare X and Y" → comparative, both pages found. Complex → research recommendation.

### E7-B03: Answer Generation with Citations

- **Depends on:** E6-B01, E7-B01, E7-B02
- **Produces:** `packages/compiler/src/ask/generate.ts`. generateAnswer() constructs prompt with question + relevant compiled page content → answer with inline citations [source: <page-title>] + provenance section. Uses content-delimiting envelope (structured delimiters around each compiled page's content) when sending context to the model to defend against prompt injection in compiled content (audit C1).
- **Verification:** Answer includes inline citations referencing real pages. Provenance section lists all pages used. Answer grounded in compiled knowledge. Envelope delimiters present in prompt construction.

### E7-B04: Citation Verification and Provenance Chain

- **Depends on:** E7-B03, E3-B05
- **Produces:** `packages/compiler/src/ask/verify.ts`. verifyCitations() parses citations, verifies each refers to a real compiled page, traces back to original source via provenance chain.
- **Verification:** Valid citations → all verify. Hallucinated citation → caught in unverifiable list. Provenance chain: answer → compiled page → source summary → raw source.

### E7-B05: ico ask Command Implementation

- **Depends on:** E7-B01 through E7-B04, E4-B01
- **Produces:** `packages/cli/src/commands/ask.ts`. Full flow: search → analyze → generate → verify → display. Shows answer, citations, provenance, token usage. --json support. Trace event recorded. Complex questions suggest `ico research`.
- **Verification:** Question about compiled content → cited answer. Citations are file paths. Provenance shown. Trace written. Complex → research suggestion.

### E7-B06: ico lint knowledge Command

- **Depends on:** E6-B06, E6-B07, E6-B09, E6-B10, E4-B01
- **Produces:** `packages/cli/src/commands/lint.ts`. Checks: schema conformance (verifying schema contract compliance per blueprint Section 5.4 — audit H5), staleness, orphans (no backlinks), gaps (missing concepts), contradictions (unresolved), knowledge health metrics. Structured health report.
- **Note:** This bead is large — consider splitting into lint-schema, lint-staleness, lint-knowledge-health if implementation complexity warrants.
- **Verification:** Healthy wiki → "All checks passed." Stale pages → flagged. Schema violations → listed. Schema contract compliance verified against Section 5.4. Matches user journey Step 9 format.

### E7-B07: Ask Flow Trace and Retrieval Hit Logging

- **Depends on:** E7-B05, E3-B06
- **Produces:** Enhanced trace events: question, retrieved pages with relevance scores, answer, citations, tokens, latency. Feeds learning model (blueprint Section 5.6).
- **Verification:** After ask: trace contains question, page IDs, answer length, citation count, tokens, latency. Conforms to E1-B03 schema.

### E7-B08: Search Quality Tuning and Relevance Scoring

- **Depends on:** E7-B01, E7-B05
- **Produces:** Enhanced search: title boosting, type-weighted scoring (concepts for definitional, topics for synthesis), recency weighting. --debug mode shows search results and scores.
- **Verification:** Definitional question → concept pages first. Synthesis question → topic pages first. --debug shows ranked results with scores.

### E7-B09: No-Knowledge Fallback Handling

- **Depends on:** E7-B05, E7-B01
- **Produces:** Fallback handling: "No relevant compiled knowledge found" + actionable suggestions ("Try ingesting sources on this topic") + optional raw corpus fallback with "uncompiled source" qualifier.
- **Verification:** No compiled pages on topic → fallback message with suggestions. Raw sources exist but not compiled → "uncompiled sources available" suggestion.

### E7-B10: Ask and Lint Integration Test Suite

- **Depends on:** E7-B05, E7-B06
- **Produces:** `packages/cli/src/__tests__/ask-integration.test.ts`. Tests: (1) ingest → compile → ask → verify citations, (2) ingest → compile → modify → re-ingest → lint detects staleness, (3) ask about uncompiled topic → fallback, (4) empty-workspace scenario — `ico ask` with no compiled pages triggers fallback with actionable guidance (audit M6).
- **Exit gate:** All four scenarios pass. All prior integration tests (E3-E6) still pass (audit H11).
- **Verification:** All four scenarios pass. Full ingest → compile → ask loop demonstrated. Empty workspace handled gracefully. Prior epic tests remain green.

---

## Exit Criteria

1. `ico ask` returns cited answers grounded in compiled knowledge
2. Citations verified against real compiled pages
3. Provenance chain traces answer → raw source
4. `ico lint knowledge` reports schema violations, staleness, gaps, contradictions
5. Full-text search retrieves relevant pages with reasonable ranking
6. No-knowledge fallback provides actionable suggestions
7. Ask traces include retrieval hits, citations, token usage
8. Integration tests verify the ingest → compile → ask loop
9. All prior epic integration tests remain green

---

## Risks / Watch Items

- **FTS5 ranking may be insufficient** for complex queries. Mitigation: can enhance or add vector search later.
- **Citation hallucination:** Claude may cite nonexistent pages. Mitigation: E7-B04 verification catches this.
- **Answer quality depends on compilation quality.** Mitigation: compiler quality gate (E6-B12) must pass first.
