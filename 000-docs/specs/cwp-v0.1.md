# Cognitive Workspace Protocol v0.1 (Experimental)

**Status:** Draft
**Date:** 2026-04-09
**License:** CC-BY-4.0
**Reference implementation:** [intentional-cognition-os](https://github.com/jeremylongshore/intentional-cognition-os)

---

## Abstract

The Cognitive Workspace Protocol (CWP) describes workspace conventions for AI agent systems that ingest sources, compile knowledge, execute episodic research tasks, and produce durable artifacts. It defines a directory layout, file schemas, governance model, and lifecycle for local-first knowledge workspaces.

CWP is extracted from one implementation (ICO, Intentional Cognition OS). It is not yet a standard. It has one conforming implementation and zero interoperability testing. This document captures conventions that have proven useful in practice with the intent that other agent systems may adopt, adapt, or challenge them.

---

## 1. Directory Layout

A CWP workspace is a directory tree rooted at an arbitrary path. The root directory MUST contain a `.cwp/` directory for workspace state and SHOULD contain the following top-level directories.

```
workspace/
├── .cwp/
│   └── state.db              # MUST: SQLite state database
├── raw/                       # MUST: immutable source corpus
│   ├── articles/
│   ├── papers/
│   ├── repos/
│   └── notes/
├── wiki/                      # SHOULD: compiled semantic knowledge
│   ├── sources/
│   ├── concepts/
│   ├── entities/
│   ├── topics/
│   ├── contradictions/
│   ├── open-questions/
│   └── indexes/
├── tasks/                     # MUST: episodic task workspaces
│   └── tsk-<uuid>/
│       ├── brief.md           # MUST: task description
│       ├── evidence/          # MUST: gathered sources
│       ├── notes/             # SHOULD: working observations
│       ├── drafts/            # SHOULD: attempted outputs
│       ├── critique/          # MAY: evaluation and challenges
│       ├── output/            # MUST: final deliverables
│       └── _proc/             # EXPERIMENTAL: computed state
│           └── status.md      # EXPERIMENTAL: phase + progress
├── outputs/                   # MAY: promoted artifacts
│   ├── reports/
│   ├── slides/
│   ├── charts/
│   └── briefings/
├── audit/                     # MUST: append-only trail
│   ├── log.md                 # MUST: human-readable log
│   └── traces/                # SHOULD: JSONL event stream
└── recall/                    # MAY: spaced repetition materials
```

**Requirement levels.** MUST directories are required for a conforming workspace. SHOULD directories are expected in most deployments. MAY directories are optional and may be omitted without affecting core operation.

**Mutability rules.** `raw/` and `audit/` are append-only after initial write -- files in these directories are never modified or deleted by the system. `wiki/` is recompilable -- files are overwritten when recompilation occurs. `tasks/` follows a per-task lifecycle. `outputs/` contents are permanent until explicitly removed by the operator.

**Naming.** The reference implementation uses `.ico/` rather than `.cwp/` for the state directory. A conforming workspace MAY use either name. This spec uses `.cwp/` as the canonical name for portability across implementations.

---

## 2. File Schemas

### 2.1 brief.md

Every task workspace MUST contain a `brief.md` at its root. This file describes the task and carries YAML frontmatter for machine readability.

```yaml
---
task_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
created_at: '2026-04-09T14:32:00Z'
status: 'created'
---
What are the tradeoffs between RAG and fine-tuning for domain-specific QA?
```

| Field        | Required | Type              | Description                     |
| ------------ | -------- | ----------------- | ------------------------------- |
| `task_id`    | Yes      | string (UUID)     | Unique identifier for this task |
| `created_at` | Yes      | string (ISO 8601) | When the task was created       |
| `status`     | Yes      | string            | Initial lifecycle state         |

The body of `brief.md` is the human-readable task description or research question.

### 2.2 status.md (EXPERIMENTAL)

See Section 5 (Computed Views). This file does not exist in the reference implementation today.

### 2.3 Compiled page frontmatter

Files in `wiki/` carry YAML frontmatter with a `type` discriminator field. The reference implementation defines seven page types: `source-summary`, `concept`, `topic`, `entity`, `contradiction`, `open-question`, and `semantic-index`. Each type has its own schema. At minimum, all compiled pages SHOULD include:

| Field         | Type              | Description                 |
| ------------- | ----------------- | --------------------------- |
| `type`        | string            | Page type discriminator     |
| `id`          | string (UUID)     | Unique identifier           |
| `title`       | string            | Human-readable title        |
| `compiled_at` | string (ISO 8601) | When this page was compiled |

Full schemas for all seven types are defined in the reference implementation's frontmatter spec (009-AT-FMSC).

---

## 3. Governance Model

CWP separates _who writes what_ to prevent agent systems from corrupting their own control state. This is the most important convention in the protocol.

| Directory           | Writer                                    | Enforcement                                        |
| ------------------- | ----------------------------------------- | -------------------------------------------------- |
| `raw/`              | Ingest pipeline only                      | Code convention. Files set to `0444` after write.  |
| `wiki/`             | Compiler only                             | Code convention. Overwrites only on recompilation. |
| `tasks/*/evidence/` | Collector agents                          | Code convention.                                   |
| `tasks/*/notes/`    | Summarizer agents                         | Code convention.                                   |
| `tasks/*/drafts/`   | Integrator agents                         | Code convention.                                   |
| `tasks/*/critique/` | Skeptic agents                            | Code convention.                                   |
| `tasks/*/output/`   | Builder agents                            | Code convention.                                   |
| `outputs/`          | Render pipeline                           | Code convention.                                   |
| `audit/`            | Kernel (deterministic control plane) only | Code convention. Files set to `0444` after write.  |
| `.cwp/state.db`     | Kernel only                               | Code convention. SQLite WAL mode with file lock.   |

**Honesty note.** Enforcement is entirely by code convention in the reference implementation, not by OS-level ACLs or capability systems. The file permission bits (`0444`) provide a safety net against accidental overwrites but are not a security boundary. Any process with user-level access can bypass them.

**Core invariant.** The model (probabilistic component) proposes; the deterministic control plane (kernel + SQLite) owns durable state. The model never directly writes to `audit/`, policy tables, or promotion records.

---

## 4. Lifecycle

A CWP workspace progresses through these phases:

1. **Initialize.** Create the directory tree and SQLite database. Seed `audit/log.md` and default policy files.

2. **Ingest.** Copy source files into `raw/`. Register each source in the `sources` table with a content hash for deduplication and staleness detection. Files in `raw/` are immutable after write.

3. **Compile.** Run compilation passes over ingested sources to produce semantic knowledge in `wiki/`. The reference implementation runs six passes: summarize, extract (concepts + entities), synthesize (topics), contradict, and gap (open questions). Each pass writes compiled markdown with YAML frontmatter and records provenance in SQLite.

4. **Research.** Create episodic task workspaces under `tasks/tsk-<uuid>/`. Write a `brief.md`. Agents populate `evidence/`, `notes/`, `drafts/`, `critique/`, and `output/`. Task state transitions through: `created` -> `collecting` -> `synthesizing` -> `critiquing` -> `rendering` -> `completed` -> `archived`.

5. **Render.** Produce durable artifacts (reports, slides) in `outputs/`.

6. **Promote.** File valuable artifacts from `outputs/` back into `wiki/` as permanent knowledge. Promotion is operator-initiated, not automatic.

7. **Archive.** Completed tasks transition to `archived`. The task directory may be compressed or relocated but is never deleted by the system.

All state transitions are recorded in `audit/log.md` and, when tracing is enabled, as JSONL events in `audit/traces/`.

---

## 5. Computed Views (EXPERIMENTAL)

The `_proc/` directory inside a task workspace is a proposed location for computed state files -- views derived from SQLite and filesystem state rather than written by agents.

**This section is experimental.** The `_proc/` directory does not exist in the reference implementation today. It is included here to document the design intent and invite feedback.

### 5.1 status.md

A computed view showing the current phase and progress of a task.

```yaml
---
task_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
phase: 'synthesizing'
evidence_count: 4
draft_count: 1
updated_at: '2026-04-09T16:00:00Z'
---
Phase: synthesizing (3 of 7)
Evidence files: 4
Draft files: 1
```

| Field            | Type              | Description                                         |
| ---------------- | ----------------- | --------------------------------------------------- |
| `task_id`        | string (UUID)     | Task identifier                                     |
| `phase`          | string            | Current lifecycle phase from the task state machine |
| `evidence_count` | integer           | Number of files in `evidence/`                      |
| `draft_count`    | integer           | Number of files in `drafts/`                        |
| `updated_at`     | string (ISO 8601) | When this view was last computed                    |

**Key constraint.** `_proc/` files are always computed, never agent-written. They are regenerated on demand and may be deleted without data loss. They exist to make task state inspectable without querying SQLite directly.

---

## 6. Future Work

These capabilities are planned or under consideration but are not part of CWP v0.1:

- **MCP server mapping.** Expose workspace directories as MCP tool resources, enabling IDE and agent framework integration.
- **FUSE mount.** Mount the semantic knowledge layer as a virtual filesystem for read-only browsing.
- **Multi-agent coordination.** Structured handoff protocols between collector, summarizer, skeptic, and integrator agents within a task workspace.
- **Time travel.** Restore workspace state from SQLite checkpoints and audit traces to replay or branch research timelines.

---

## Acknowledgments

CWP is extracted from the Intentional Cognition OS project by Jeremy Longshore / Intent Solutions. The conventions described here emerged from building one system, not from cross-implementation consensus. Feedback, criticism, and alternative implementations are welcome.
