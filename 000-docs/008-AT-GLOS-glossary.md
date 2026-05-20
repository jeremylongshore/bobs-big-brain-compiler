# Canonical Glossary and Terminology Lock

> One name per concept. No synonyms. Every term traced to its source.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Purpose

This glossary is the single source of truth for all terminology used in Intentional Cognition OS. Every standards document, code comment, CLI help text, and agent instruction must use these canonical terms exactly. Synonyms are listed only to redirect to the canonical name.

**Rule:** If a term is not in this glossary, it is not part of the system vocabulary. Add it here first, then use it.

---

## 2. Core System Terms

| Term                                     | Definition                                                                                                                                                                                                                                                                | Source                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Intentional Cognition OS**             | The product. A local-first knowledge operating system that ingests raw corpus, compiles semantic knowledge, creates episodic task workspaces, generates durable artifacts, and improves both machine reasoning and human understanding over time.                         | Blueprint Section 1   |
| **ICO**                                  | Shorthand for Intentional Cognition OS. Used in prose and documentation.                                                                                                                                                                                                  | Blueprint Section 16  |
| **`ico`**                                | The CLI binary name. Used in command examples and code.                                                                                                                                                                                                                   | Blueprint Section 16  |
| **Operating Loop**                       | The core product cycle: `ingest → compile → reason → render → refine`. Everything the system does is an elaboration of this loop.                                                                                                                                         | Blueprint Section 2   |
| **Schema Contract**                      | The set of rules files, frontmatter conventions, file policies, and lifecycle constraints that govern agent behavior. The agent reads the schema before operating; it does not invent conventions.                                                                        | Blueprint Section 5.4 |
| **Deterministic/Probabilistic Boundary** | The most important architectural constraint. The deterministic system (Kernel + SQLite + JSONL) owns durable state and control. The probabilistic system (Compiler + Claude API) proposes content. The model never directly writes to audit, policy, or promotion tables. | Blueprint Section 5.3 |

---

## 3. Six-Layer Architecture

| Term                        | Definition                                                                                                                                                                                                                                   | Source                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Layer (L1–L6)**           | One of six data layers in the architecture stack. Each layer has a defined storage path, mutability classification, and lifecycle.                                                                                                           | Blueprint Section 5.1 |
| **Raw Corpus (L1)**         | Source-of-truth inputs: PDFs, articles, papers, repos, notes, transcripts, datasets. Append-only. Never modified after ingestion. Stored in `workspace/raw/`.                                                                                | Blueprint Section 5.1 |
| **Semantic Knowledge (L2)** | Compiled markdown derived from L1. Includes source summaries, concept pages, topic pages, entity pages, backlinks, contradiction notes, open questions, and semantic indexes. Recompilable from L1 at any time. Stored in `workspace/wiki/`. | Blueprint Section 5.1 |
| **Episodic Tasks (L3)**     | Temporary scoped workspaces created for complex questions. Each task has evidence, notes, drafts, critiques, and output directories. Created on demand, archived on completion. Stored in `workspace/tasks/<task-id>/`.                      | Blueprint Section 5.1 |
| **Artifacts (L4)**          | Durable rendered outputs: markdown reports, Marp slides, charts, briefings, study materials. Promotable to L2 under explicit rules. Stored in `workspace/outputs/`.                                                                          | Blueprint Section 5.1 |
| **Recall (L5)**             | Human retention materials: flashcards, quizzes, spaced repetition decks, weak-area reports. Generated from L2, adapted based on test results. Stored in `workspace/recall/`.                                                                 | Blueprint Section 5.1 |
| **Audit & Policy (L6)**     | Deterministic control layer: provenance logs, task traces, policy decisions, promotion history, eval results. Append-only. Stored in `workspace/audit/`.                                                                                     | Blueprint Section 5.1 |

---

## 4. Data Classification

| Term          | Definition                                                                                                                                                                                 | Source                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| **Canonical** | Data classification for source-of-truth inputs that the system never modifies. Raw corpus files (L1). Lifecycle: append-only, never mutated.                                               | Blueprint Section 5.2 |
| **Compiled**  | Data classification for outputs derived from canonical sources via compilation. Wiki pages, summaries, concept pages (L2). Lifecycle: recompilable from L1.                                | Blueprint Section 5.2 |
| **Ephemeral** | Data classification for temporary working data scoped to a task. Evidence folders, drafts, critiques (L3). Lifecycle: archived or pruned after task completion.                            | Blueprint Section 5.2 |
| **Durable**   | Data classification for rendered outputs intended for reuse. Reports, slides, briefings (L4). Lifecycle: permanent unless user deletes.                                                    | Blueprint Section 5.2 |
| **Adaptive**  | Data classification for content generated from compiled knowledge and modified by feedback. Flashcards, quiz results, retention data (L5). Lifecycle: updated based on recall performance. | Blueprint Section 5.2 |
| **Audit**     | Data classification for system events and policy decisions. Traces, provenance, promotions (L6). Lifecycle: append-only, never mutated.                                                    | Blueprint Section 5.2 |

---

## 5. Compilation Terms

| Term                 | Definition                                                                                                                                                                                               | Source                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Compilation**      | The core differentiator. The process of transforming raw corpus into structured semantic knowledge through defined passes. Compilation produces structured outputs — it does not index content.          | Blueprint Section 6   |
| **Compiled Page**    | Any markdown page in L2 produced by the compiler. Has YAML frontmatter conforming to its type schema. Seven types: source summary, concept, topic, entity, contradiction, open question, semantic index. | Blueprint Section 6.1 |
| **Compilation Pass** | A single transform step in the compiler. Six passes: Summarize, Extract, Synthesize, Link, Contradict, Gap.                                                                                              | Blueprint Section 6.1 |
| **Summarize Pass**   | Compilation pass that takes a raw source file and produces a source summary page. Extracts key claims, methods, conclusions, metadata.                                                                   | Blueprint Section 6.1 |
| **Extract Pass**     | Compilation pass that takes source summaries and produces concept pages. Identifies discrete concepts, defines them, cites sources.                                                                      | Blueprint Section 6.1 |
| **Synthesize Pass**  | Compilation pass that takes multiple source summaries and concepts and produces topic pages. Cross-source synthesis on a named topic.                                                                    | Blueprint Section 6.1 |
| **Link Pass**        | Compilation pass that takes all compiled pages and produces backlink annotations. Adds bidirectional references between related pages.                                                                   | Blueprint Section 6.1 |
| **Contradict Pass**  | Compilation pass that takes source summaries and topic pages and produces contradiction notes. Flags claims that conflict across sources.                                                                | Blueprint Section 6.1 |
| **Gap Pass**         | Compilation pass that takes all compiled knowledge and produces open-question files. Identifies referenced-but-undefined concepts and missing evidence.                                                  | Blueprint Section 6.1 |

---

## 6. Compiled Page Types

| Term                   | Definition                                                                                                                                                                                 | Source                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| **Source Summary**     | Compiled page type. Produced by the Summarize pass from a single raw source. Contains key claims, methods, conclusions, and metadata from the source. Stored in `workspace/wiki/sources/`. | Blueprint Section 6.1           |
| **Concept Page**       | Compiled page type. Produced by the Extract pass from source summaries. Defines a discrete concept with citations to sources. Stored in `workspace/wiki/concepts/`.                        | Blueprint Section 6.1           |
| **Topic Page**         | Compiled page type. Produced by the Synthesize pass from multiple summaries and concepts. Cross-source synthesis on a named topic. Stored in `workspace/wiki/topics/`.                     | Blueprint Section 6.1           |
| **Entity Page**        | Compiled page type. Describes a named entity (person, organization, tool, framework) referenced across sources. Stored in `workspace/wiki/entities/`.                                      | Blueprint Section 4.1, Audit C4 |
| **Contradiction Note** | Compiled page type. Produced by the Contradict pass. Flags claims that conflict across sources. Stored in `workspace/wiki/contradictions/`.                                                | Blueprint Section 6.1           |
| **Open Question**      | Compiled page type. Produced by the Gap pass. Identifies referenced-but-undefined concepts or missing evidence. Stored in `workspace/wiki/open-questions/`.                                | Blueprint Section 6.1           |
| **Semantic Index**     | Auto-generated catalog pages that list and link compiled knowledge by type or topic. Includes `workspace/wiki/index.md`.                                                                   | Blueprint Section 5.5           |

---

## 7. Workspace and Storage Terms

| Term                    | Definition                                                                                                                                                                                                          | Source                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Workspace**           | The root directory containing all six data layers. Default: `./workspace`. Configurable via `ICO_WORKSPACE` env var.                                                                                                | Blueprint Section 11, Tech Spec  |
| **Mount**               | A registered corpus source directory. Mounts are tracked in the `mounts` SQLite table and referenced by name. Configured via `ico mount`.                                                                           | Blueprint Section 5.1, Tech Spec |
| **Mount Registry**      | The `mounts` table in SQLite that tracks all registered corpus mount points with name, path, creation time, and last-indexed time.                                                                                  | Tech Spec                        |
| **Semantic Filesystem** | The design principle that knowledge is mounted and operable, not hidden in a vector blob. Operations like mount, index, compile, lint, diff, and inspect expose the knowledge layer as a filesystem-like substrate. | Blueprint Section 4.2            |
| **Fixture Workspace**   | A pre-populated workspace used for testing. Contains known raw sources, compiled pages, task snapshots, and eval QA pairs.                                                                                          | Tech Spec, Testing Strategy      |

---

## 8. State and Lifecycle Terms

| Term                 | Definition                                                                                                                                                                                                                                        | Source                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Task**             | A scoped research operation tracked in the `tasks` SQLite table. Created by `ico research`. Has a lifecycle: created → collecting → synthesizing → critiquing → rendering → completed → archived.                                                 | Blueprint Section 8.1               |
| **Task Lifecycle**   | The seven-state progression of a research task: `created → collecting → synthesizing → critiquing → rendering → completed → archived`. Transitions are deterministic (kernel-owned).                                                              | Blueprint Section 8.1, Audit C8     |
| **Staleness**        | A compiled page is stale when: (a) any source it derived from has been re-ingested with a different content hash, (b) a new source matches its topic/concepts, or (c) a dependent backlinked page has been recompiled since it was last compiled. | Blueprint Section 6.3               |
| **Provenance**       | The chain linking every derived artifact back to its source. Tracked in `workspace/audit/provenance/` and the `compilations` table. Source → compiled → rendered.                                                                                 | Blueprint Section 5.3, Architecture |
| **Provenance Chain** | The full trace from a rendered artifact back through its compiled intermediates to the original raw source(s). Every derived output must have a complete provenance chain.                                                                        | Blueprint Section 5.3               |

---

## 9. Promotion Terms

| Term                        | Definition                                                                                                                                                                                                 | Source                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Promotion**               | The act of filing a durable output (L4 artifact) back into the semantic knowledge layer (L2). Always explicit (`ico promote`), never automatic. Copy-not-move semantics.                                   | Blueprint Section 7   |
| **Promotion Rules**         | Seven rules governing promotion. Only L4 artifacts are eligible. Requires explicit command with `--as <type>`. Logged in `workspace/audit/promotions/`. Promoted pages enter normal compilation lifecycle. | Blueprint Section 7.1 |
| **Promotion Anti-patterns** | Three prohibited practices: promoting raw task drafts (use final outputs only), promoting without review (promotion is a quality gate), promoting ephemeral evidence (evidence stays in L3).               | Blueprint Section 7.2 |

---

## 10. Agent and Research Terms

| Term           | Definition                                                                                                      | Source                |
| -------------- | --------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Collector**  | Agent role in multi-agent research. Gathers relevant evidence from L2 into `tasks/<id>/evidence/`.              | Blueprint Section 8.2 |
| **Summarizer** | Agent role in multi-agent research. Distills evidence into working notes in `tasks/<id>/notes/`.                | Blueprint Section 8.2 |
| **Skeptic**    | Agent role in multi-agent research. Challenges conclusions, flags weak evidence, writes `tasks/<id>/critique/`. | Blueprint Section 8.2 |
| **Integrator** | Agent role in multi-agent research. Synthesizes final answer from notes and critiques.                          | Blueprint Section 8.2 |
| **Builder**    | Agent role in multi-agent research. Renders final artifact (report, slides, etc.) to `tasks/<id>/output/`.      | Blueprint Section 8.2 |

---

## 11. Recall Terms

| Term                  | Definition                                                                                                                                                           | Source                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Recall**            | The system layer (L5) that helps the human retain what the machine compiled. Generates flashcards, quizzes, and spaced repetition materials from compiled knowledge. | Blueprint Section 9   |
| **Retention Score**   | Per-concept metric updated by quiz results. Low-scoring concepts are surfaced by `ico recall weak` and prioritized in future generation.                             | Blueprint Section 9.3 |
| **Machine Knowledge** | L2 compiled knowledge optimized for retrieval, context efficiency, and linkage. Audience: agents and retrieval pipelines.                                            | Blueprint Section 9.1 |
| **Human Knowledge**   | L5 recall materials optimized for recall, understanding, and transfer. Format: flashcards, quizzes, explanations. Audience: the user.                                | Blueprint Section 9.1 |

---

## 12. Audit and Trace Terms

| Term                 | Definition                                                                                                                                                          | Source                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Trace**            | A JSONL event record in L6. Standard envelope: timestamp, event_type, event_id, correlation_id, payload, prev_hash. Every meaningful system event produces a trace. | Blueprint Section 5.5, 5.6          |
| **Trace Envelope**   | The standard fields wrapping every JSONL trace event: `timestamp`, `event_type`, `event_id`, `correlation_id`, `payload`, `prev_hash`.                              | Architecture, Blueprint Section 5.6 |
| **Integrity Chain**  | The `prev_hash` field in each trace event that links to the hash of the previous event, forming a tamper-evident chain.                                             | Audit H4                            |
| **Correlation ID**   | A shared identifier linking all trace events belonging to the same logical operation (e.g., a single compilation run or research task).                             | Architecture                        |
| **Secret Deny-List** | Fields that must never appear in trace payloads: `apiKey`, `authorization`, `token`, patterns matching `sk-ant-*`, `Bearer`. Enforced by `redactSecrets()`.         | Audit C2                            |
| **`index.md`**       | Operational control file at `workspace/wiki/index.md`. Catalog of compiled knowledge, auto-rebuilt on compilation. Human-readable table of contents for L2.         | Blueprint Section 5.5               |
| **`log.md`**         | Operational control file at `workspace/audit/log.md`. Chronological digest of meaningful operations. Human-readable sequential log. Complements JSONL traces.       | Blueprint Section 5.5               |

---

## 13. Component Terms

| Term         | Definition                                                                                                                                          | Source                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Kernel**   | Core runtime component. Manages workspace, mount registry, state machine, lifecycle transitions. Deterministic side. Directory: `packages/kernel/`. | Architecture, Blueprint Section 5.3 |
| **Compiler** | Knowledge compilation component. Implements the six compilation passes. Probabilistic side (uses Claude API). Directory: `packages/compiler/`.      | Architecture, Blueprint Section 6   |
| **CLI**      | Command routing component. Entry point (`ico`), argument parsing, output formatting. Directory: `packages/cli/`.                                    | Architecture, Tech Spec             |
| **Types**    | Shared TypeScript interfaces and Zod schemas used across all packages. Directory: `packages/types/`.                                                | Architecture                        |
| **Evals**    | Evaluation specs for compilation quality, recall accuracy, and provenance completeness. Directory: `evals/`.                                        | Architecture, Tech Spec             |

---

## 14. Learning Model Terms

| Term              | Definition                                                                                                                                                                                                                              | Source                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Context Layer** | Learning model layer. Configurable knowledge outside the harness: `CLAUDE.md`, agent rules, skills, compiled wiki, topic instructions, user memory, recall history. Updated per-session or per-corpus. Cheapest and fastest to iterate. | Blueprint Section 5.6 |
| **Harness Layer** | Learning model layer. The runtime around the model: CLI, kernel, compiler passes, task orchestration, provenance system, promotion rules, audit, default behavior. Improved offline using traces and evals, shipped as code changes.    | Blueprint Section 5.6 |
| **Model Layer**   | Learning model layer. Foundation model weights (Claude, etc.). Fine-tuned or swapped only when justified by stable evidence from harness and context layers. Explicitly deferred.                                                       | Blueprint Section 5.6 |

---

## 15. Evaluation Terms

| Term             | Definition                                                                                                                                                                                    | Source                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Eval**         | An evaluation spec that tests system quality. Run via `ico eval run`. Distinct from unit/integration tests — evals measure compilation quality, recall accuracy, and provenance completeness. | Tech Spec, Blueprint Section 5.6 |
| **Eval Harness** | The custom eval runner (not Vitest). Used for quality assessments that require model judgment or corpus-level analysis.                                                                       | Tech Spec                        |
| **Fixture**      | Pre-constructed test data for deterministic testing. Four tiers: raw sources, compiled wiki pages, research task snapshots, eval QA pairs.                                                    | Tech Spec                        |

---

## 16. Deprecated Synonyms

These terms have been used in drafts or discussions. They are **not canonical**. Use the canonical term instead.

| Deprecated Term             | Canonical Term              | Notes                                                                                  |
| --------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| Semantic Memory             | Semantic Knowledge (L2)     | "Memory" implies runtime state; "knowledge" is the correct term for compiled markdown  |
| Compiled Pages (table name) | `compilations` (table name) | Tech spec uses `compilations` as the SQLite table name; do not use `compiled_pages`    |
| Knowledge Base              | Semantic Knowledge (L2)     | "Knowledge base" is generic; use the specific layer name                               |
| Research Session            | Episodic Task (L3)          | Tasks are the formal term; "session" is ambiguous with agent sessions                  |
| Agent Memory                | Recall (L5)                 | "Agent memory" conflates machine state with human retention                            |
| Logs                        | Traces (L6)                 | "Logs" is informal; "traces" is the canonical term for JSONL audit events              |
| Wiki                        | Semantic Knowledge (L2)     | "Wiki" is the directory name (`workspace/wiki/`) but the layer is "Semantic Knowledge" |
| Stale Page                  | Staleness (condition)       | "Stale" is an adjective describing a condition, not a page type                        |

---

## 17. Versioning

This glossary is frozen for Phase 1. Changes require:

1. An entry in `000-docs/IDEA-CHANGELOG.md` with rationale
2. Update to this document with new version number
3. Review of all documents referencing the changed term

**Cross-references:** Blueprint Section 2, Architecture, Tech Spec, all 000-docs standards documents.
