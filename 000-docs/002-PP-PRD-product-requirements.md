# Product Requirements: intentional-cognition-os

> Compile knowledge for the machine. Distill understanding for the human.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-02
**Version:** 0.1.0
**Status:** Active

## Goals

1. Prove the cognition loop works end-to-end: ingest -> compile -> reason -> render -> refine
2. Deliver a local-first CLI (`ico`) that a single user can run against their own files
3. Establish the deterministic/probabilistic boundary as a first-class architectural concept
4. Produce durable artifacts (reports, slides) rather than disposable chat answers
5. Maintain full provenance from source material through compiled knowledge to rendered output

## Non-Goals

- Building a hosted multi-user service (deferred to Phase 5)
- Obsidian plugin (output is Obsidian-compatible markdown, but no plugin dependency)
- Real-time collaboration features
- Mobile app
- Model fine-tuning or custom model training
- Advanced graph visualization UI
- Complex vector database infrastructure (markdown-first retrieval)

## User Stories

| ID    | Story                                                                                               | Priority | Phase |
| ----- | --------------------------------------------------------------------------------------------------- | -------- | ----- |
| US-01 | As a researcher, I want to ingest PDFs, articles, and markdown so they're preserved with provenance | P0       | 1     |
| US-02 | As a researcher, I want the system to compile topic pages and source summaries from my raw corpus   | P0       | 2     |
| US-03 | As a user, I want to ask questions over compiled knowledge and get sourced, traceable answers       | P0       | 1     |
| US-04 | As a user, I want to generate markdown reports from research tasks                                  | P0       | 1     |
| US-05 | As a user, I want to generate Marp slide decks from completed research                              | P1       | 1     |
| US-06 | As a user, I want the system to extract concepts, create backlinks, and flag contradictions         | P1       | 2     |
| US-07 | As a user, I want to lint my knowledge base for gaps, staleness, and inconsistencies                | P1       | 2     |
| US-08 | As a user, I want provenance traced from any output back to its source material                     | P0       | 1     |
| US-09 | As a user, I want complex questions to spawn scoped research workspaces with evidence and drafts    | P1       | 3     |
| US-10 | As a learner, I want flashcards and quizzes generated from compiled knowledge                       | P2       | 4     |
| US-11 | As a learner, I want the system to track my weak areas and adapt future recall material             | P2       | 4     |
| US-12 | As a user, I want to mount a corpus directory and index it for compilation                          | P0       | 1     |
| US-13 | As a user, I want useful outputs promotable back into the knowledge system                          | P1       | 3     |
| US-14 | As a team member, I want shared workspaces and collaborative research environments                  | P3       | 5     |

## Functional Requirements

| ID    | Requirement                                   | Acceptance Criteria                                                               | Priority | Phase |
| ----- | --------------------------------------------- | --------------------------------------------------------------------------------- | -------- | ----- |
| FR-01 | Ingest markdown, PDF, and web-clipped sources | Sources stored in workspace/raw/ with metadata and provenance                     | P0       | 1     |
| FR-02 | Mount corpus directories for indexing         | `ico mount` registers a directory, `ico ingest` processes it                      | P0       | 1     |
| FR-03 | Compile source summaries                      | Each ingested source gets a summary in workspace/wiki/sources/                    | P0       | 2     |
| FR-04 | Extract concepts and generate topic pages     | Concepts appear in workspace/wiki/concepts/, topics in workspace/wiki/topics/     | P1       | 2     |
| FR-05 | Maintain backlinks between compiled pages     | Concept pages reference sources, topics reference concepts                        | P1       | 2     |
| FR-06 | Detect and flag contradictions                | Contradictions stored in workspace/wiki/contradictions/                           | P1       | 2     |
| FR-07 | Answer questions against compiled knowledge   | `ico ask` returns sourced answer with provenance chain                            | P0       | 1     |
| FR-08 | Create episodic research workspaces           | `ico research` creates workspace/tasks/<id>/ with evidence, notes, drafts, output | P1       | 3     |
| FR-09 | Generate markdown reports                     | `ico render report` produces a markdown report from task or compiled knowledge    | P0       | 1     |
| FR-10 | Generate Marp slide decks                     | `ico render slides` produces a Marp-compatible .md deck                           | P1       | 1     |
| FR-11 | Run knowledge lint checks                     | `ico lint knowledge` flags gaps, contradictions, stale sources, missing links     | P1       | 2     |
| FR-12 | Generate flashcards and quizzes               | `ico recall generate` produces recall material in workspace/recall/               | P2       | 4     |
| FR-13 | Track retention and weak areas                | System records quiz results and identifies weak concepts                          | P2       | 4     |
| FR-14 | Maintain deterministic audit trail            | All compilation, reasoning, and promotion events logged in workspace/audit/       | P0       | 1     |
| FR-15 | Promote outputs back into knowledge           | Outputs can be filed from workspace/outputs/ into workspace/wiki/                 | P1       | 3     |

## MVP Scope (Phase 1)

- [x] Repo scaffolded with governance
- [ ] Workspace layout (raw/, wiki/, tasks/, outputs/, recall/, audit/)
- [ ] CLI shell with Commander.js (`ico` command)
- [ ] SQLite state for deterministic tracking
- [ ] Raw ingest for markdown and PDF
- [ ] Provenance tracking from ingest through output
- [ ] Basic `ico ask` flow against ingested content
- [ ] `ico render report` for markdown reports
- [ ] `ico render slides` for Marp decks
- [ ] Task trace in workspace/audit/

## Success Metrics

| Metric                  | Target         | How Measured                                              |
| ----------------------- | -------------- | --------------------------------------------------------- |
| End-to-end loop         | Working        | Can ingest -> compile -> ask -> render in one CLI session |
| Source type coverage    | 3+             | PDF, markdown, web clip successfully ingested             |
| Compilation quality     | Human-verified | Concept pages are accurate, useful, and traceable         |
| Provenance completeness | 100%           | Every rendered output traces back to source               |
| Artifact durability     | File-based     | All outputs are markdown files in workspace/outputs/      |

## Dependencies

| Dependency                     | Purpose                                   | Required By |
| ------------------------------ | ----------------------------------------- | ----------- |
| Claude API (@anthropic-ai/sdk) | Compilation, reasoning, recall generation | Phase 1     |
| Commander.js                   | CLI framework                             | Phase 1     |
| better-sqlite3                 | Deterministic local state                 | Phase 1     |
| gray-matter                    | Frontmatter parsing for compiled pages    | Phase 2     |
| Marp CLI                       | Slide deck rendering                      | Phase 1     |
| pdf-parse or equivalent        | PDF text extraction                       | Phase 1     |
