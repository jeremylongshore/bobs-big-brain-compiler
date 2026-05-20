# Intentional Cognition OS — Master Blueprint v2.2

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-05
**Version:** 2.2.0
**Repo:** `intentional-cognition-os`
**Product:** Intentional Cognition OS
**CLI:** `ico`

---

## 1. Thesis

Intentional Cognition OS is a knowledge operating system.

It ingests raw source material, compiles that material into structured semantic knowledge, reasons over that knowledge through agent workflows, renders durable artifacts, and strengthens human understanding through recall-aware loops.

**Compile knowledge for the machine. Distill understanding for the human.**

This is not chat-with-docs, not a wiki generator, not RAG-with-branding, not a generic agent shell. It is a system where raw files become compiled knowledge, hard questions become scoped research operations, and answers become durable assets that compound over time.

The agent does not operate freely. It operates under a schema contract — governed by rules files, frontmatter conventions, file policies, and lifecycle constraints that evolve with the repo and corpus.

---

## 2. Operating Loop

The product is one loop:

```
ingest → compile → reason → render → refine
```

| Stage       | What happens                                                                                                  | Owner                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Ingest**  | Collect raw sources into corpus storage. Preserve provenance. Source-by-source, human-in-the-loop by default. | Deterministic                                 |
| **Compile** | Transform sources into structured semantic knowledge.                                                         | Probabilistic (model proposes, system stores) |
| **Reason**  | Answer questions or conduct scoped research over compiled knowledge.                                          | Probabilistic                                 |
| **Render**  | Produce durable artifacts — reports, slides, charts, briefings.                                               | Probabilistic                                 |
| **Refine**  | Lint knowledge, test recall, promote useful outputs, improve the base.                                        | Both                                          |

This loop is stated once. Everything else in this document is an elaboration of how each stage works, where the boundaries are, and what the system stores.

**Default ingest posture.** Early and default ingest is source-by-source: one document at a time, human-aware, quality-first. The operator chooses what to ingest, reviews summaries, and approves compilation. Batch ingest exists as a capability but is not the default mode — it is unlocked once the operator trusts the pipeline's output quality on their corpus.

---

## 3. Product Shape

Three operating surfaces under one identity.

**Local mode.** Runs on a laptop against local files. Personal research vaults, private analysis, sensitive source work. No infrastructure required. This is the primary surface for Phases 1-4.

**Remote mode.** Hosted or self-hosted service for teams. Shared corpora, collaborative research, org memory. Planned for Phase 5.

**Repo-native mode.** The repository itself is the operating environment. Source-controlled knowledge, auditable outputs, repeatable agent workflows. Works in both local and remote contexts.

All three surfaces share the same workspace layout, CLI vocabulary, and architectural layers. The difference is where the data lives and who can access it.

---

## 4. Differentiators

### 4.1 Knowledge compilation

The system does not index content. It compiles it.

Compilation produces structured outputs: source summaries, concept pages, topic pages, entity pages, backlinks, contradiction notes, and open-question files. The compiled knowledge layer is the semantic intermediate representation of the corpus — analogous to object code produced from source files.

### 4.2 Semantic filesystem

Knowledge is mounted and operable, not hidden in a vector blob.

Operations like `mount`, `index`, `compile`, `lint`, `diff`, and `inspect` expose the knowledge layer as a filesystem-like substrate. Users can see what was compiled, from what sources, at what time, and trace any derived output back to its origin.

### 4.3 Episodic research workspaces

Hard questions create temporary, scoped task environments.

Each research task gets its own workspace with evidence, notes, drafts, critiques, and outputs. Multiple agents can work a single task. When the task completes, durable value is promoted and temporary work is archived.

### 4.4 Recall-aware cognition

The system supports both machine retrieval and human retention.

Machine-facing knowledge is optimized for context efficiency, linkage, and structured reuse. Human-facing knowledge is optimized for recall, understanding, and transfer — flashcards, quizzes, spaced repetition, weak-area tracking. These are two distinct output layers from the same compiled base.

### 4.5 Audit-first operation

Every meaningful event leaves a trace: ingestion, compilation, retrieval hits, task creation, promotion decisions, policy checks, eval results. This is required for trust, debugging, and quality control.

---

## 5. Architecture

### 5.1 Six-layer stack

```
┌─────────────────────────────────────────────┐
│  L6  Audit & Policy    (deterministic)      │
├─────────────────────────────────────────────┤
│  L5  Recall            (human-facing)       │
├─────────────────────────────────────────────┤
│  L4  Artifacts         (durable outputs)    │
├─────────────────────────────────────────────┤
│  L3  Episodic Tasks    (temporary)          │
├─────────────────────────────────────────────┤
│  L2  Semantic Knowledge (compiled)          │
├─────────────────────────────────────────────┤
│  L1  Raw Corpus        (source-of-truth)    │
└─────────────────────────────────────────────┘
```

**L1 — Raw Corpus.** Source-of-truth inputs. PDFs, articles, papers, repos, notes, transcripts, datasets. Append-only. Never modified after ingestion. Stored in `workspace/raw/`.

**L2 — Semantic Knowledge.** Compiled markdown derived from L1. Source summaries, concept pages, topic pages, entity pages, backlinks, contradiction notes, open questions, semantic indexes. Recompilable — can be regenerated from L1 at any time. Stored in `workspace/wiki/`.

**L3 — Episodic Tasks.** Temporary scoped workspaces created for complex questions. Each task has evidence, notes, drafts, critiques, and output directories. Created on demand, archived on completion. Stored in `workspace/tasks/<task-id>/`.

**L4 — Artifacts.** Durable rendered outputs. Markdown reports, Marp slides, charts, briefings, study materials. Promotable to L2 under explicit rules. Stored in `workspace/outputs/`.

**L5 — Recall.** Human retention materials. Flashcards, quizzes, spaced repetition decks, weak-area reports. Generated from L2, adapted based on test results. Stored in `workspace/recall/`.

**L6 — Audit & Policy.** Deterministic control layer. Provenance logs, task traces, policy decisions, promotion history, eval results. Append-only. Stored in `workspace/audit/`.

### 5.2 Data classification

Every piece of data in the system has exactly one classification:

| Classification | Definition                                              | Examples                                      | Lifecycle                                |
| -------------- | ------------------------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| **Canonical**  | Source-of-truth inputs that the system never modifies   | Raw corpus files (L1)                         | Append-only, never mutated               |
| **Compiled**   | Derived from canonical sources via compilation          | Wiki pages, summaries, concept pages (L2)     | Recompilable from L1                     |
| **Ephemeral**  | Temporary working data scoped to a task                 | Evidence folders, drafts, critiques (L3)      | Archived or pruned after task completion |
| **Durable**    | Rendered outputs intended for reuse                     | Reports, slides, briefings (L4)               | Permanent unless user deletes            |
| **Adaptive**   | Generated from compiled knowledge, modified by feedback | Flashcards, quiz results, retention data (L5) | Updated based on recall performance      |
| **Audit**      | System events and policy decisions                      | Traces, provenance, promotions (L6)           | Append-only, never mutated               |

### 5.3 Deterministic vs probabilistic boundary

This is the most important architectural constraint.

**Deterministic side** (system-owned logic):

- File storage and workspace layout
- Mount registry
- Task state machine (created → active → completed → archived)
- Provenance chain (source → compiled → rendered)
- Policy enforcement
- Promotion rules
- Audit log writes
- Eval execution
- Lifecycle transitions

**Probabilistic side** (model-driven logic):

- Summarization
- Concept extraction
- Topic synthesis
- Contradiction detection
- Question decomposition
- Artifact drafting
- Recall item generation

**Rule:** The model proposes content. The deterministic system owns state, provenance, policy, and lifecycle. The model never writes directly to audit, policy, or promotion tables.

### 5.4 Schema & agent contract

The agent does not operate freestyle. Its behavior is governed by a schema contract layer that is part of the architecture, not documentation bolted on afterward.

**Components of the schema contract:**

| Component               | Location                  | Governs                                                                 |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `CLAUDE.md`             | Repo root                 | Agent behavior, conventions, architectural constraints                  |
| Frontmatter conventions | All compiled wiki pages   | Required fields, type classification, provenance references             |
| File policies           | Workspace layout rules    | Where each data type lives, naming, allowed operations per directory    |
| Lifecycle rules         | Kernel + promotion rules  | Valid state transitions, staleness definitions, archival criteria       |
| Compilation schemas     | Compiler pass definitions | Required output structure for each pass (summary, concept, topic, etc.) |

**Contract rules:**

1. The agent reads the schema before operating. It does not invent conventions.
2. Every compiled page must conform to the frontmatter schema for its type (source summary, concept, topic, entity, contradiction, open question).
3. File placement follows workspace layout rules — the agent does not create directories or files outside the defined structure without explicit operator approval.
4. The schema evolves with the repo and corpus. When a new pass or page type is added, the schema is updated first, then the compiler implements it.
5. Linting validates schema conformance. A page that compiles but violates the schema is a lint failure.

The schema layer sits between the deterministic and probabilistic sides. It is owned deterministically (checked into the repo, versioned, linted) but informs probabilistic behavior (what the model produces and how it structures output).

### 5.5 Operational control files

Two lightweight operator-facing files provide running situational awareness without requiring database queries or tool invocations.

**`workspace/wiki/index.md`** — Catalog of compiled knowledge. Lists all compiled pages by type (sources, concepts, topics, entities) with links and last-compiled dates. Rebuilt automatically on compilation. This is the navigational entry point for the semantic knowledge layer — a table of contents for what the system knows.

**`workspace/audit/log.md`** — Chronological digest of meaningful operations. Records ingests, compilation passes, queries, lint results, promotions, and task lifecycle events as a human-readable sequential log. Each entry includes timestamp, operation type, and a one-line summary.

These are plain markdown files. They complement the structured audit traces (JSONL) and SQLite state — they do not replace them. Their purpose is operator visibility: open them in any editor and see what happened, what exists, and what changed.

### 5.6 Learning model

Intentional Cognition OS improves over time at three distinct layers. Each layer has different cost, inspectability, and velocity characteristics.

| Layer       | What it is                                                                                                                                                     | What changes                                                                                 | When                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Context** | Configurable knowledge and instructions outside the harness — `CLAUDE.md`, agent rules, skills, compiled wiki, topic instructions, user memory, recall history | Updated per-session or per-corpus by the operator or by governed system behavior             | Now (Phases 1-4)                       |
| **Harness** | The runtime around the model — CLI, kernel, compiler passes, task orchestration, provenance system, promotion rules, audit, default behavior                   | Improved offline using traces and evals, shipped as code changes under review                | Later (Phase 3+, as traces accumulate) |
| **Model**   | Foundation model weights (Claude, etc.)                                                                                                                        | Fine-tuned or swapped only when justified by stable evidence from harness and context layers | Much later, if ever                    |

**Project stance.** Early versions of the product learn primarily through context. The operator curates `CLAUDE.md`, refines compilation schemas, builds the wiki, adjusts agent instructions, and accumulates recall data. This is deliberate — context is the cheapest, most inspectable, and fastest-to-iterate learning surface. Harness improvements come later, driven by patterns visible in traces and eval results. Model adaptation is explicitly deferred until the context and harness layers are stable enough to produce reliable training signal.

**Traces are the substrate.** Every meaningful system event produces a trace (Section 5.5, L6). These traces are not just for debugging — they are the shared substrate for all future learning:

- **Context refinement** — Which compilation schemas produce good summaries? Which topics have high retrieval hit rates? Which recall items are retained vs forgotten? Traces answer these questions and inform schema/wiki/recall updates.
- **Harness improvement** — Which compiler passes produce stale output? Where do task workflows stall? Which promotion decisions get reversed? Traces identify harness-level patterns that justify code changes.
- **Future learning analysis** — If model adaptation ever becomes justified, traces provide the structured evidence base. No traces, no signal, no adaptation.

Relevant trace types: ingest events, compilation events, retrieval hits, ask flows, render flows, promotion decisions, task lifecycle events, recall results, eval outcomes.

**Governance alignment.** This learning model is consistent with the project's audit-first, governed design:

- Context updates are governed by the schema contract (Section 5.4) — the agent does not self-modify its own rules without operator review.
- Harness changes are code changes — they go through version control, review, and testing like any other code.
- Model adaptation, if it ever happens, requires stable evidence from both context and harness layers, not speculation.
- No layer mutates trust-critical state (audit, policy, provenance) as part of learning. The control plane is not a learning surface.

The point is auditable improvement under stewardship, not unconstrained self-modification.

**Adjacent patterns.** This three-layer model is validated by patterns emerging in the open-source agent ecosystem: durable execution and human-in-the-loop runtime patterns (LangGraph), persistent memory and stateful agent patterns (Letta), trace/eval infrastructure (Langfuse, Opik), repo-native markdown rule and config patterns (Continue), agent runtime/harness separation (OpenHands), and explicit context files as first-class architecture (SOUL.md). These are reference points for architectural direction, not dependencies.

---

## 6. The Compiler

The compiler is the core differentiator. It transforms raw corpus into structured semantic knowledge through defined passes.

### 6.1 Compilation passes

| Pass           | Input                                | Output               | Description                                                    |
| -------------- | ------------------------------------ | -------------------- | -------------------------------------------------------------- |
| **Summarize**  | Raw source file                      | Source summary page  | Extracts key claims, methods, conclusions, metadata            |
| **Extract**    | Source summaries                     | Concept pages        | Identifies discrete concepts, defines them, cites sources      |
| **Synthesize** | Multiple source summaries + concepts | Topic pages          | Cross-source synthesis on a named topic                        |
| **Link**       | All compiled pages                   | Backlink annotations | Adds bidirectional references between related pages            |
| **Contradict** | Source summaries + topic pages       | Contradiction notes  | Flags claims that conflict across sources                      |
| **Gap**        | All compiled knowledge               | Open-question files  | Identifies referenced-but-undefined concepts, missing evidence |

### 6.2 Compilation triggers

| Trigger                           | What happens                                       |
| --------------------------------- | -------------------------------------------------- |
| `ico compile sources`             | Runs Summarize pass on all uncompiled sources      |
| `ico compile topic <name>`        | Runs Synthesize + Link for a named topic           |
| `ico compile concepts`            | Runs Extract + Link across all summaries           |
| `ico compile all`                 | Runs all passes in order                           |
| Source re-ingested (hash changed) | Marks existing summary stale, queues recompilation |
| `ico lint knowledge`              | Runs Contradict + Gap passes, reports findings     |

### 6.3 Staleness model

A compiled page is **stale** when:

- Any source it was derived from has been re-ingested with a different content hash
- A new source has been added that matches the page's topic or concepts
- A dependent page (backlinked) has been recompiled since this page was last compiled

Stale pages are flagged by `ico lint knowledge` and queued for recompilation by `ico compile all`.

---

## 7. Promotion Rules

Promotion is the act of filing a durable output (L4) back into the semantic knowledge layer (L2).

### 7.1 Rules

1. Only artifacts in `workspace/outputs/` are eligible for promotion.
2. Promotion requires an explicit command: `ico promote <path> --as <type>`.
3. The `--as` flag specifies the target type: `topic`, `concept`, `entity`, or `reference`.
4. Promoted content is copied (not moved) to `workspace/wiki/<type>/`.
5. The promotion event is logged in `workspace/audit/promotions/` with source path, target path, timestamp, and actor (user or system).
6. Promoted pages enter the normal compilation lifecycle — they can be linked, contradicted, and linted.
7. Automatic promotion is never allowed. Promotion is always explicit.

### 7.2 Anti-patterns

- Promoting raw task drafts (use only final outputs)
- Promoting without review (promotion is a quality gate, not a shortcut)
- Promoting ephemeral evidence (evidence stays in L3, only synthesis goes to L2)

---

## 8. Multi-Agent Research

For complex questions, the system creates a scoped research workspace and assigns agent roles.

### 8.1 Task lifecycle

```
created → collecting → synthesizing → critiquing → rendering → completed → archived
```

### 8.2 Agent roles

| Role           | Responsibility                                                             |
| -------------- | -------------------------------------------------------------------------- |
| **Collector**  | Gathers relevant evidence from L2 into `tasks/<id>/evidence/`              |
| **Summarizer** | Distills evidence into working notes in `tasks/<id>/notes/`                |
| **Skeptic**    | Challenges conclusions, flags weak evidence, writes `tasks/<id>/critique/` |
| **Integrator** | Synthesizes final answer from notes + critiques                            |
| **Builder**    | Renders final artifact (report, slides, etc.) to `tasks/<id>/output/`      |

### 8.3 Task completion

When a research task completes:

1. Final artifact is copied to `workspace/outputs/`
2. Task workspace is archived (retained but no longer active)
3. User may promote the artifact to L2 via `ico promote`
4. Task trace is closed in `workspace/audit/traces/`

---

## 9. Recall Model

The recall layer helps the human retain what the machine compiled.

### 9.1 Machine knowledge vs human knowledge

| Dimension     | Machine-facing (L2)                    | Human-facing (L5)                 |
| ------------- | -------------------------------------- | --------------------------------- |
| Optimized for | Retrieval, context efficiency, linkage | Recall, understanding, transfer   |
| Format        | Structured markdown with frontmatter   | Flashcards, quizzes, explanations |
| Updates       | Recompiled from sources                | Adapted from test results         |
| Audience      | Agents and retrieval pipelines         | The user                          |

### 9.2 Recall operations

| Command                              | What it does                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `ico recall generate --topic <name>` | Generates flashcards and quiz questions from compiled knowledge on that topic |
| `ico recall quiz`                    | Runs an interactive quiz session                                              |
| `ico recall weak`                    | Shows concepts with lowest retention scores                                   |
| `ico recall export --format anki`    | Exports to Anki-compatible format                                             |

### 9.3 Feedback loop

Quiz results update retention scores per concept. Low-scoring concepts are:

- Surfaced by `ico recall weak`
- Prioritized in future `ico recall generate` runs
- Optionally flagged for recompilation with simpler language

---

## 10. CLI

```bash
ico init <name>                         # Initialize workspace
ico ingest <path> [--type TYPE]         # Ingest source material
ico mount <path> --name NAME            # Register corpus mount
ico compile sources                     # Compile source summaries
ico compile topic <name>                # Compile topic page
ico compile concepts                    # Extract concept pages
ico compile all                         # Run all compilation passes
ico ask <question>                      # Query compiled knowledge
ico research <brief>                    # Create research workspace
ico render report --task ID|--topic N   # Generate markdown report
ico render slides --task ID|--topic N   # Generate Marp slides
ico lint knowledge                      # Run health checks
ico recall generate --topic <name>      # Generate recall material
ico recall quiz                         # Run recall quiz
ico promote <path> --as <type>          # Promote output to L2
ico status                              # Show workspace state
ico eval run                            # Run evaluation specs
```

The CLI should feel operational — like running a build system, not chatting with a bot.

---

## 11. Workspace Layout

```text
intentional-cognition-os/
├── cli/                    # CLI entry point (ico)
├── kernel/                 # Core runtime (workspace, state, mounts, provenance)
├── compiler/               # Knowledge compilation (summarize, extract, link, lint)
├── workspace/
│   ├── raw/                # L1: Canonical source material
│   │   ├── articles/
│   │   ├── papers/
│   │   ├── repos/
│   │   └── notes/
│   ├── wiki/               # L2: Compiled semantic knowledge
│   │   ├── index.md        # Catalog of all compiled pages (auto-rebuilt)
│   │   ├── sources/        # Per-source summaries
│   │   ├── concepts/       # Extracted concept pages
│   │   ├── entities/       # Entity pages
│   │   ├── topics/         # Topic synthesis pages
│   │   ├── contradictions/ # Flagged conflicts
│   │   ├── open-questions/ # Identified gaps
│   │   └── indexes/        # Semantic indexes
│   ├── tasks/              # L3: Episodic research workspaces
│   │   └── <task-id>/
│   │       ├── evidence/
│   │       ├── notes/
│   │       ├── drafts/
│   │       ├── critique/
│   │       └── output/
│   ├── outputs/            # L4: Durable rendered artifacts
│   │   ├── reports/
│   │   ├── slides/
│   │   ├── charts/
│   │   └── briefings/
│   ├── recall/             # L5: Human retention materials
│   │   ├── cards/
│   │   ├── decks/
│   │   ├── quizzes/
│   │   └── retention/
│   └── audit/              # L6: Deterministic control data
│       ├── log.md          # Chronological operation digest (human-readable)
│       ├── traces/
│       ├── provenance/
│       ├── policy/
│       └── promotions/
├── mounts/                 # Corpus mount configs
├── evals/                  # Evaluation specs
├── apps/                   # Optional web UI (Phase 5+)
└── 000-docs/               # Enterprise documentation
```

---

## 12. Tech Stack

| Component     | Technology                              | Rationale                                       |
| ------------- | --------------------------------------- | ----------------------------------------------- |
| Language      | TypeScript, Node.js 22+                 | Type safety, Claude SDK native                  |
| CLI           | Commander.js                            | Conventional, battle-tested                     |
| State         | SQLite (better-sqlite3)                 | Local-first, zero infrastructure                |
| Traces        | JSONL                                   | Append-only, greppable                          |
| AI            | Claude API via @anthropic-ai/sdk        | Compilation and reasoning engine                |
| Orchestration | Agent SDK                               | Multi-agent research (Phase 3)                  |
| Retrieval     | Full-text search over compiled markdown | Simple first — no vector DB until proven needed |
| Output        | Markdown, Marp, matplotlib              | File-based, inspectable                         |

**Obsidian posture.** Obsidian is a strong local inspection and browsing surface for the compiled wiki. Its graph view, backlink panel, and metadata querying are useful for navigating compiled knowledge. However, the architecture does not depend on Obsidian-specific behavior. Output is standard markdown with YAML frontmatter — compatible with Obsidian, any markdown editor, and `cat`. Obsidian is a preferred viewer, not an architectural dependency.

---

## 13. What This Is Not

Do not let this collapse into:

- A coding agent (this is a knowledge system, not a code generator)
- A vector database wrapper (knowledge is compiled markdown, not embeddings)
- An Obsidian plugin (Obsidian is a preferred inspection surface, not a dependency — the system is frontend-agnostic)
- A search bar with branding (the value is compilation, not retrieval)
- An opaque memory blob (everything is inspectable, traceable, file-based)
- A one-shot research bot (outputs are durable, research compounds)
- A shell demo pretending to be an OS (the metaphor is only valid if the operations are real: mount, compile, lint, promote, audit)

---

## 14. MVP

### 14.1 Goal

Prove the operating loop works end to end on a single user's local machine.

### 14.2 Operating assumptions

The MVP assumes small-to-moderate scale and local-first operation:

- **Corpus size:** Tens to low hundreds of source documents. Not internet-scale.
- **Retrieval:** Full-text search over compiled markdown summaries. No vector database required.
- **Ingest mode:** Source-by-source, human-in-the-loop. The operator selects what to ingest, reviews compilation output, and approves before the next source. Batch ingest is a later capability, not the default.
- **Infrastructure:** Local filesystem + SQLite. No cloud services, containers, or external databases.
- **Inspection:** Compiled wiki is browsable in any markdown editor. Obsidian is preferred but not required.

These assumptions hold through Phases 1-4. Remote and scale requirements are Phase 5 concerns.

### 14.3 Scope

- Ingest markdown, PDF, and web-clipped sources with provenance
- Compile source summaries and concept pages
- Answer questions against compiled knowledge with citations
- Generate markdown reports
- Generate Marp slide decks
- Run basic lint checks (staleness, gaps, schema conformance)
- File outputs back into workspace
- Show provenance and task trace
- Maintain `index.md` and `log.md` as operator-visible control surfaces

### 14.4 Explicitly deferred

- Remote infrastructure
- Multi-user collaboration
- Graph visualization
- Model fine-tuning
- Vector search
- Batch ingest as default mode
- Complex agent orchestration beyond single-task research

---

## 15. Phase Plan

| Phase | Name                   | Scope                                                                                                 |
| ----- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| 1     | **Local Foundation**   | Repo scaffold, workspace layout, CLI skeleton, SQLite state, raw ingest, provenance, basic ask/render |
| 2     | **Knowledge Compiler** | Summarize, Extract, Synthesize, Link, Contradict, Gap passes; knowledge linting                       |
| 3     | **Episodic Research**  | Task workspaces, multi-agent roles, structured report generation, promotion rules                     |
| 4     | **Recall Loop**        | Flashcards, quizzes, retention tracking, weak-area feedback, adaptive generation                      |
| 5     | **Remote Mode**        | Shared workspaces, auth, remote jobs, team memory, hosted artifact pipelines                          |

---

## 16. Naming

| Surface   | Name                       |
| --------- | -------------------------- |
| Product   | Intentional Cognition OS   |
| Repo      | `intentional-cognition-os` |
| CLI       | `ico`                      |
| Shorthand | ICO                        |

One identity across all surfaces.
