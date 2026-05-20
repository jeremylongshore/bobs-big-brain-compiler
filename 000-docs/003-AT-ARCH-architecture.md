# Architecture: intentional-cognition-os

> Compile knowledge for the machine. Distill understanding for the human.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-02
**Status:** Active

## System Context

Intentional Cognition OS is a local-first knowledge operating system. It runs on the user's machine against their own files, using the filesystem as the primary storage substrate, SQLite for deterministic state, and JSONL for audit traces. The Claude API provides compilation and reasoning capabilities through a clear deterministic/probabilistic boundary.

The system is designed for local-first operation (Phases 1-4) with remote/team capabilities planned for Phase 5.

## Six-Layer Cognition Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  Layer 6: Audit & Policy                                    │
│  Provenance, traces, policy, permissions, eval execution    │
├─────────────────────────────────────────────────────────────┤
│  Layer 5: Recall                                            │
│  Flashcards, quizzes, spaced repetition, weak-area tracking │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Artifacts                                         │
│  Reports, slides, charts, briefings, study materials        │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Episodic Tasks                                    │
│  Research workspaces, evidence, drafts, critiques           │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Semantic Knowledge                                │
│  Summaries, concepts, entities, topics, backlinks           │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Raw Corpus                                        │
│  PDFs, articles, repos, notes, transcripts, datasets        │
└─────────────────────────────────────────────────────────────┘
```

| Layer                 | Responsibility                                                                         | Storage                 | Mutability                |
| --------------------- | -------------------------------------------------------------------------------------- | ----------------------- | ------------------------- |
| 1. Raw Corpus         | Preserve source-of-truth inputs with provenance                                        | `workspace/raw/`        | Append-only               |
| 2. Semantic Knowledge | Compiled markdown knowledge — summaries, concepts, entities, backlinks, contradictions | `workspace/wiki/`       | Recompilable              |
| 3. Episodic Tasks     | Temporary scoped research workspaces for complex questions                             | `workspace/tasks/<id>/` | Created/archived per task |
| 4. Artifacts          | Durable rendered outputs — reports, slides, charts, briefings                          | `workspace/outputs/`    | Promotable to Layer 2     |
| 5. Recall             | Human retention — flashcards, quizzes, spaced repetition, weak-area reports            | `workspace/recall/`     | Adaptive                  |
| 6. Audit & Policy     | Deterministic control — provenance, traces, policy, permissions, evals                 | `workspace/audit/`      | Append-only               |

## Component Design

| Component | Directory   | Responsibility                                                 |
| --------- | ----------- | -------------------------------------------------------------- |
| CLI       | `cli/`      | Command routing (`ico`), argument parsing, output formatting   |
| Kernel    | `kernel/`   | Workspace management, mount registry, state machine, lifecycle |
| Compiler  | `compiler/` | Knowledge compilation — summarize, extract, link, diff, lint   |
| Mounts    | `mounts/`   | Corpus mount points — raw source directories                   |
| Evals     | `evals/`    | Evaluation specs for compilation quality, recall accuracy      |
| Apps      | `apps/`     | Optional web UI (Phase 5+)                                     |

## Data Flow

```text
[User Sources] ──── ico ingest ────► [Raw Corpus Layer]
                                           │
                                     ico compile
                                           │
                                           ▼
                                    [Semantic Knowledge Layer]
                                           │
                              ┌─────── ico ask ────────┐
                              │                        │
                         (simple)                  (complex)
                              │                        │
                              ▼                        ▼
                      [Direct Answer]         [Episodic Task Layer]
                              │               ┌───────────────────┐
                              │               │ collectors        │
                              │               │ summarizers       │
                              │               │ skeptics          │
                              │               │ integrators       │
                              │               └────────┬──────────┘
                              │                        │
                              └────────┬───────────────┘
                                       │
                                 ico render
                                       │
                                       ▼
                               [Artifact Layer]
                                       │
                              ┌────────┴────────┐
                              │                 │
                        ico promote        ico recall
                              │                 │
                              ▼                 ▼
                   [Back to Layer 2]     [Recall Layer]
                                                │
                                          ico lint / ico eval
                                                │
                                                ▼
                                        [Audit & Policy Layer]
```

## Deterministic vs Probabilistic Boundary

This is the most important architectural constraint.

| Side              | Owns                                                                                                                                                  | Implementation          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Deterministic** | File storage, mount registry, task state, provenance, policy, permissions, audit logs, promotion rules, eval execution, lifecycle transitions         | Kernel + SQLite + JSONL |
| **Probabilistic** | Summarization, synthesis, concept extraction, topic drafting, contradiction suggestions, question decomposition, artifact drafting, recall generation | Compiler + Claude API   |

**Rule:** The model can propose. The deterministic system owns durable state and control. The model never directly writes to audit, policy, or promotion tables.

## Multi-Agent Research Pattern

For complex questions (`ico research`), the system creates a scoped task workspace:

1. **Create** task workspace at `workspace/tasks/<task-id>/`
2. **Collect** — collector agents gather evidence from compiled knowledge
3. **Summarize** — summarizer agents distill findings into working notes
4. **Critique** — skeptic agents challenge conclusions, find contradictions
5. **Integrate** — integrator agent synthesizes final answer
6. **Render** — artifact builder produces report/slides/charts
7. **Recall** — optionally generate retention material
8. **Promote** — file durable value back into Layer 2 under policy rules
9. **Archive** — archive or prune temporary workspace

## Tech Stack

| Component     | Technology                       | Rationale                                                |
| ------------- | -------------------------------- | -------------------------------------------------------- |
| Runtime       | TypeScript, Node.js 22+          | Type safety, Claude SDK native, ecosystem                |
| CLI           | Commander.js                     | Battle-tested, conventional                              |
| State         | SQLite (better-sqlite3)          | Local-first, zero infrastructure, deterministic          |
| Traces        | JSONL                            | Append-only, human-readable, greppable                   |
| AI            | Claude API via @anthropic-ai/sdk | Primary compilation and reasoning engine                 |
| Orchestration | Agent SDK                        | Multi-agent research workflows                           |
| Retrieval     | Markdown-first, full-text search | Simple before complex — no vector DB until proven needed |
| Workers       | Python (optional)                | Document parsing, plotting, heavy processing             |
| Output        | Markdown, Marp, matplotlib       | File-based, inspectable, Obsidian-compatible             |

## Security Model

| Concern             | Approach                                                                  |
| ------------------- | ------------------------------------------------------------------------- |
| Authentication      | None needed for local mode. Auth layer added in Phase 5 (remote)          |
| Data classification | All data local by default. User controls what's ingested                  |
| Secrets             | `.env` for API keys only. Never stored in workspace or audit              |
| Provenance          | Every derived artifact traces to source via audit layer                   |
| Model access        | Claude API only — no data sent except during active compilation/reasoning |

## Performance Targets

| Operation                  | Target | Max                    |
| -------------------------- | ------ | ---------------------- |
| `ico ingest` (single file) | < 2s   | 10s for large PDFs     |
| `ico compile topic`        | < 30s  | 120s for large corpora |
| `ico ask` (simple)         | < 10s  | 30s                    |
| `ico research` (complex)   | < 5min | 15min                  |
| `ico render report`        | < 5s   | 15s                    |
| `ico lint knowledge`       | < 30s  | 120s                   |

## Infrastructure

| Concern    | Phase 1-4 (Local)            | Phase 5 (Remote)                              |
| ---------- | ---------------------------- | --------------------------------------------- |
| Hosting    | User's machine               | Self-hosted or managed service                |
| CI/CD      | GitHub Actions               | GitHub Actions + deployment pipeline          |
| Monitoring | JSONL traces, SQLite queries | Structured logging, metrics, alerting         |
| Storage    | Local filesystem + SQLite    | Object storage + relational DB + search index |
