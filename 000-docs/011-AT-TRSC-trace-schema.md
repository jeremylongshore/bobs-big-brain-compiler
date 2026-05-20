# JSONL Trace Event Schema and Envelope Format

> Every meaningful event leaves a trace. Every trace tells a story.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Purpose

This document defines the standard envelope format for all JSONL trace events emitted by Intentional Cognition OS. Every event written to `workspace/audit/traces/` conforms to this schema. No exceptions.

Traces are the substrate for all future learning (Blueprint Section 5.6). They enable context refinement, harness improvement, and future learning analysis. Without structured, consistent traces, the system cannot improve.

---

## 2. Storage Layout

Trace files live in `workspace/audit/traces/`. One file per calendar day.

```
workspace/audit/traces/
  2026-04-06.jsonl
  2026-04-07.jsonl
  2026-04-08.jsonl
```

**File naming:** `YYYY-MM-DD.jsonl` — UTC date of the first event written to the file.

**Encoding:** UTF-8, one JSON object per line, LF line endings. No pretty-printing. No trailing commas. No comments.

**Rotation:** A new file starts at midnight UTC. The kernel never appends to a previous day's file.

---

## 3. Envelope Schema

Every trace event is a single JSON object occupying exactly one line. All events share the same envelope structure.

| Field            | Type                         | Required | Description                                                                                                                                                                        |
| ---------------- | ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timestamp`      | string (ISO 8601)            | Yes      | UTC timestamp with millisecond precision. Format: `YYYY-MM-DDTHH:mm:ss.sssZ`                                                                                                       |
| `event_type`     | string                       | Yes      | Dot-free identifier from the enumerated event type list (Section 5)                                                                                                                |
| `event_id`       | string (UUIDv4)              | Yes      | Unique identifier for this event                                                                                                                                                   |
| `correlation_id` | string (UUIDv4)              | No       | Groups related events. All events in a single `ico ask` flow share one correlation_id. All events in a task lifecycle share one correlation_id. Omit when the event is standalone. |
| `payload`        | object                       | Yes      | Typed payload specific to the event_type. Schema defined per type in Section 6.                                                                                                    |
| `prev_hash`      | string (SHA-256 hex) or null | Yes      | SHA-256 hex digest of the previous event line in the same file. `null` for the first event of each file (chain anchor).                                                            |

**Field ordering:** Fields must appear in the order listed above. This is not enforced at parse time but is enforced at write time for consistent hashing.

**Example envelope:**

```json
{
  "timestamp": "2026-04-06T14:30:00.000Z",
  "event_type": "ingest",
  "event_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "correlation_id": null,
  "payload": {
    "source_path": "workspace/raw/articles/attention-is-all-you-need.pdf",
    "source_type": "pdf",
    "content_hash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "byte_size": 1048576
  },
  "prev_hash": null
}
```

---

## 4. Integrity Chain

Each trace file forms an independent hash chain. The chain provides tamper evidence and ordering guarantees.

**Algorithm:** SHA-256 of the raw JSON line bytes (UTF-8 encoded), excluding the trailing newline character.

**Chain rules:**

1. The first event in each daily file has `prev_hash: null`. This is the chain anchor.
2. Every subsequent event's `prev_hash` is the SHA-256 hex digest of the complete previous line (the raw bytes of the JSON object, before the LF).
3. To verify the chain, read the file line by line, compute SHA-256 of each line, and confirm the next line's `prev_hash` matches.
4. A broken chain indicates tampering, corruption, or a write failure. The kernel logs a warning and starts a new anchor at the break point.

**Verification example:**

```
Line 1: {"timestamp":"2026-04-06T00:00:01.000Z","event_type":"ingest",...,"prev_hash":null}
         SHA-256 of line 1 → "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

Line 2: {"timestamp":"2026-04-06T00:05:12.000Z","event_type":"compilation.start",...,"prev_hash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}
         SHA-256 of line 2 → "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"

Line 3: {"timestamp":"2026-04-06T00:05:44.000Z","event_type":"compilation.complete",...,"prev_hash":"d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"}
```

---

## 5. Event Type Enumeration

All valid event types. The kernel rejects any event with an `event_type` not in this list.

| Event Type             | Layer | Description                                          |
| ---------------------- | ----- | ---------------------------------------------------- |
| `ingest`               | L1    | Source file ingested into raw corpus                 |
| `compilation.start`    | L2    | Compilation pass initiated                           |
| `compilation.complete` | L2    | Compilation pass finished                            |
| `retrieval`            | L2    | Knowledge retrieved to answer a query or feed a task |
| `ask.start`            | L2/L3 | User question received, processing begins            |
| `ask.complete`         | L2/L3 | Answer delivered to user                             |
| `render.start`         | L4    | Artifact rendering initiated                         |
| `render.complete`      | L4    | Artifact rendering finished                          |
| `promotion`            | L2/L4 | Artifact promoted from L4 to L2                      |
| `task.created`         | L3    | Episodic research task workspace created             |
| `task.transition`      | L3    | Task moved between lifecycle states                  |
| `task.completed`       | L3    | Task reached completed state                         |
| `task.archived`        | L3    | Task workspace archived                              |
| `recall.generate`      | L5    | Recall material generated from compiled knowledge    |
| `recall.quiz`          | L5    | Quiz session initiated                               |
| `recall.result`        | L5    | Quiz answer recorded with retention score            |
| `eval.run`             | L6    | Evaluation spec execution started                    |
| `eval.result`          | L6    | Evaluation spec result recorded                      |
| `lint.run`             | L6    | Knowledge lint check started                         |
| `lint.result`          | L6    | Knowledge lint check result recorded                 |

---

## 6. Payload Schemas and Examples

Each event type has a typed payload. The payload object contains only the fields listed for that type. Unknown fields are stripped at write time.

All example JSONL lines below use realistic but fictional data. SHA-256 hashes are abbreviated for readability in descriptions but shown in full in examples.

### 6.1 ingest

Records the ingestion of a source file into the raw corpus.

| Field          | Type    | Required | Description                                                 |
| -------------- | ------- | -------- | ----------------------------------------------------------- |
| `source_path`  | string  | Yes      | Workspace-relative path to the ingested file                |
| `source_type`  | string  | Yes      | File type: `pdf`, `markdown`, `html`, `text`, `json`, `csv` |
| `content_hash` | string  | Yes      | `sha256:<hex>` digest of the raw file content               |
| `byte_size`    | integer | Yes      | File size in bytes                                          |
| `mount_name`   | string  | No       | Name of the corpus mount, if applicable                     |
| `title`        | string  | No       | Extracted or user-provided title                            |

```jsonl
{
  "timestamp": "2026-04-06T08:00:01.123Z",
  "event_type": "ingest",
  "event_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "correlation_id": null,
  "payload": {
    "source_path": "workspace/raw/papers/attention-is-all-you-need.pdf",
    "source_type": "pdf",
    "content_hash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "byte_size": 2103456,
    "title": "Attention Is All You Need"
  },
  "prev_hash": null
}
```

### 6.2 compilation.start

Records the start of a compilation pass.

| Field          | Type    | Required | Description                                                                         |
| -------------- | ------- | -------- | ----------------------------------------------------------------------------------- |
| `pass_type`    | string  | Yes      | Compilation pass: `summarize`, `extract`, `synthesize`, `link`, `contradict`, `gap` |
| `target`       | string  | Yes      | What is being compiled: source path, topic name, or `all`                           |
| `source_count` | integer | No       | Number of source documents feeding this pass                                        |

```jsonl
{
  "timestamp": "2026-04-06T08:01:00.000Z",
  "event_type": "compilation.start",
  "event_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "correlation_id": "c9bf9e57-1685-4c89-bafb-ff5af830be8a",
  "payload": {
    "pass_type": "summarize",
    "target": "workspace/raw/papers/attention-is-all-you-need.pdf",
    "source_count": 1
  },
  "prev_hash": "a3c2f1e8d94b56a7c3e8f1d2b4a6c8e0f1d3b5a7c9e1f3d5b7a9c1e3f5d7b9a1"
}
```

### 6.3 compilation.complete

Records the completion of a compilation pass.

| Field          | Type     | Required | Description                                 |
| -------------- | -------- | -------- | ------------------------------------------- |
| `pass_type`    | string   | Yes      | Same as compilation.start                   |
| `target`       | string   | Yes      | Same as compilation.start                   |
| `output_paths` | string[] | Yes      | Workspace-relative paths of files produced  |
| `duration_ms`  | integer  | Yes      | Wall-clock duration in milliseconds         |
| `tokens_used`  | integer  | No       | Total tokens consumed (prompt + completion) |

```jsonl
{
  "timestamp": "2026-04-06T08:01:22.456Z",
  "event_type": "compilation.complete",
  "event_id": "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  "correlation_id": "c9bf9e57-1685-4c89-bafb-ff5af830be8a",
  "payload": {
    "pass_type": "summarize",
    "target": "workspace/raw/papers/attention-is-all-you-need.pdf",
    "output_paths": [
      "workspace/wiki/sources/attention-is-all-you-need.md"
    ],
    "duration_ms": 22456,
    "tokens_used": 4821
  },
  "prev_hash": "b4d3e2f1a5c6b7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2"
}
```

### 6.4 retrieval

Records a knowledge retrieval event during query answering or task execution.

| Field          | Type     | Required | Description                                                      |
| -------------- | -------- | -------- | ---------------------------------------------------------------- |
| `query`        | string   | Yes      | The search query or question fragment that triggered retrieval   |
| `results`      | object[] | Yes      | Array of `{path: string, score: number}` for each retrieved page |
| `result_count` | integer  | Yes      | Number of pages retrieved                                        |
| `context`      | string   | Yes      | Where retrieval was triggered: `ask`, `research`, `compile`      |

```jsonl
{
  "timestamp": "2026-04-06T09:15:03.789Z",
  "event_type": "retrieval",
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "correlation_id": "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a",
  "payload": {
    "query": "transformer self-attention mechanism",
    "results": [
      {
        "path": "workspace/wiki/sources/attention-is-all-you-need.md",
        "score": 0.95
      },
      {
        "path": "workspace/wiki/concepts/self-attention.md",
        "score": 0.88
      }
    ],
    "result_count": 2,
    "context": "ask"
  },
  "prev_hash": "c5e4f3d2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4"
}
```

### 6.5 ask.start

Records the start of a user question flow.

| Field      | Type   | Required | Description                                                    |
| ---------- | ------ | -------- | -------------------------------------------------------------- |
| `question` | string | Yes      | The user's question                                            |
| `mode`     | string | Yes      | `simple` (direct answer) or `research` (creates episodic task) |

```jsonl
{
  "timestamp": "2026-04-06T09:15:00.000Z",
  "event_type": "ask.start",
  "event_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "correlation_id": "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a",
  "payload": {
    "question": "How does the transformer self-attention mechanism compare to recurrent approaches?",
    "mode": "simple"
  },
  "prev_hash": "d6f5e4c3b2a1d0c9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5"
}
```

### 6.6 ask.complete

Records the completion of a user question flow.

| Field           | Type     | Required | Description                                             |
| --------------- | -------- | -------- | ------------------------------------------------------- |
| `question`      | string   | Yes      | The user's question (repeated for grep-ability)         |
| `mode`          | string   | Yes      | `simple` or `research`                                  |
| `duration_ms`   | integer  | Yes      | Wall-clock duration from ask.start                      |
| `tokens_used`   | integer  | No       | Total tokens consumed                                   |
| `sources_cited` | string[] | Yes      | Workspace-relative paths of sources cited in the answer |
| `task_id`       | string   | No       | Task ID if mode was `research`                          |

```jsonl
{
  "timestamp": "2026-04-06T09:15:08.234Z",
  "event_type": "ask.complete",
  "event_id": "7c9e6680-7425-40de-944b-e07fc1f90ae7",
  "correlation_id": "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a",
  "payload": {
    "question": "How does the transformer self-attention mechanism compare to recurrent approaches?",
    "mode": "simple",
    "duration_ms": 8234,
    "tokens_used": 3150,
    "sources_cited": [
      "workspace/wiki/sources/attention-is-all-you-need.md",
      "workspace/wiki/concepts/self-attention.md"
    ]
  },
  "prev_hash": "e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3c2b1a0d9c8b7a6"
}
```

### 6.7 render.start

Records the start of artifact rendering.

| Field      | Type   | Required | Description                                   |
| ---------- | ------ | -------- | --------------------------------------------- |
| `format`   | string | Yes      | Output format: `markdown`, `marp`, `chart`    |
| `source`   | string | Yes      | What is being rendered: task ID or topic name |
| `template` | string | No       | Template name if applicable                   |

```jsonl
{
  "timestamp": "2026-04-06T10:00:00.000Z",
  "event_type": "render.start",
  "event_id": "8a4f3c2e-1b5d-4e6f-9a7b-8c0d1e2f3a4b",
  "correlation_id": "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b",
  "payload": {
    "format": "markdown",
    "source": "task-20260406-001",
    "template": "research-report"
  },
  "prev_hash": "f8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7"
}
```

### 6.8 render.complete

Records the completion of artifact rendering.

| Field         | Type    | Required | Description                                  |
| ------------- | ------- | -------- | -------------------------------------------- |
| `format`      | string  | Yes      | Same as render.start                         |
| `source`      | string  | Yes      | Same as render.start                         |
| `output_path` | string  | Yes      | Workspace-relative path to rendered artifact |
| `duration_ms` | integer | Yes      | Wall-clock duration                          |
| `tokens_used` | integer | No       | Total tokens consumed                        |

```jsonl
{
  "timestamp": "2026-04-06T10:00:04.567Z",
  "event_type": "render.complete",
  "event_id": "8a4f3c2f-1b5d-4e6f-9a7b-8c0d1e2f3a4b",
  "correlation_id": "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b",
  "payload": {
    "format": "markdown",
    "source": "task-20260406-001",
    "output_path": "workspace/outputs/reports/transformer-comparison-20260406.md",
    "duration_ms": 4567,
    "tokens_used": 2890
  },
  "prev_hash": "a9c8b7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8"
}
```

### 6.9 promotion

Records the promotion of an artifact from L4 to L2.

| Field         | Type   | Required | Description                                                            |
| ------------- | ------ | -------- | ---------------------------------------------------------------------- |
| `source_path` | string | Yes      | Workspace-relative path of the artifact being promoted                 |
| `target_path` | string | Yes      | Workspace-relative path in wiki where the page lands                   |
| `target_type` | string | Yes      | Wiki page type: `topic`, `concept`, `entity`, `reference`              |
| `actor`       | string | Yes      | Who triggered: `user` or `system` (system is never allowed in Phase 1) |

```jsonl
{
  "timestamp": "2026-04-06T11:00:00.000Z",
  "event_type": "promotion",
  "event_id": "9b5e4d3c-2a1f-4b0e-8d9c-7a6b5c4d3e2f",
  "correlation_id": null,
  "payload": {
    "source_path": "workspace/outputs/reports/transformer-comparison-20260406.md",
    "target_path": "workspace/wiki/topics/transformer-attention-comparison.md",
    "target_type": "topic",
    "actor": "user"
  },
  "prev_hash": "b0d9c8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9"
}
```

### 6.10 task.created

Records the creation of an episodic research task workspace.

| Field            | Type   | Required | Description                               |
| ---------------- | ------ | -------- | ----------------------------------------- |
| `task_id`        | string | Yes      | Unique task identifier                    |
| `brief`          | string | Yes      | The research brief or question            |
| `workspace_path` | string | Yes      | Workspace-relative path to task directory |

```jsonl
{
  "timestamp": "2026-04-06T12:00:00.000Z",
  "event_type": "task.created",
  "event_id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "correlation_id": "f3a4b5c6-d7e8-4f9a-0b1c-2d3e4f5a6b7c",
  "payload": {
    "task_id": "task-20260406-001",
    "brief": "Compare transformer architectures for long-context processing",
    "workspace_path": "workspace/tasks/task-20260406-001/"
  },
  "prev_hash": "c1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0"
}
```

### 6.11 task.transition

Records a state transition in the task lifecycle.

| Field        | Type   | Required | Description                                                                                              |
| ------------ | ------ | -------- | -------------------------------------------------------------------------------------------------------- |
| `task_id`    | string | Yes      | Task identifier                                                                                          |
| `from_state` | string | Yes      | Previous state: `created`, `collecting`, `synthesizing`, `critiquing`, `rendering`                       |
| `to_state`   | string | Yes      | New state: `collecting`, `synthesizing`, `critiquing`, `rendering`, `completed`                          |
| `agent_role` | string | No       | Agent role responsible for the transition: `collector`, `summarizer`, `skeptic`, `integrator`, `builder` |

```jsonl
{
  "timestamp": "2026-04-06T12:00:30.000Z",
  "event_type": "task.transition",
  "event_id": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
  "correlation_id": "f3a4b5c6-d7e8-4f9a-0b1c-2d3e4f5a6b7c",
  "payload": {
    "task_id": "task-20260406-001",
    "from_state": "created",
    "to_state": "collecting",
    "agent_role": "collector"
  },
  "prev_hash": "d2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1"
}
```

### 6.12 task.completed

Records the completion of a research task.

| Field            | Type     | Required | Description                                 |
| ---------------- | -------- | -------- | ------------------------------------------- |
| `task_id`        | string   | Yes      | Task identifier                             |
| `output_paths`   | string[] | Yes      | Workspace-relative paths to final outputs   |
| `duration_ms`    | integer  | Yes      | Total wall-clock duration from task.created |
| `evidence_count` | integer  | Yes      | Number of evidence files collected          |
| `sources_used`   | integer  | Yes      | Number of compiled wiki pages used          |

```jsonl
{
  "timestamp": "2026-04-06T12:15:00.000Z",
  "event_type": "task.completed",
  "event_id": "3c4d5e6f-7a8b-4c9d-0e1f-2a3b4c5d6e7f",
  "correlation_id": "f3a4b5c6-d7e8-4f9a-0b1c-2d3e4f5a6b7c",
  "payload": {
    "task_id": "task-20260406-001",
    "output_paths": [
      "workspace/tasks/task-20260406-001/output/report.md"
    ],
    "duration_ms": 900000,
    "evidence_count": 12,
    "sources_used": 8
  },
  "prev_hash": "e3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2"
}
```

### 6.13 task.archived

Records the archival of a completed task workspace.

| Field            | Type    | Required | Description                           |
| ---------------- | ------- | -------- | ------------------------------------- |
| `task_id`        | string  | Yes      | Task identifier                       |
| `workspace_path` | string  | Yes      | Path that was archived                |
| `promoted`       | boolean | Yes      | Whether any output was promoted to L2 |

```jsonl
{
  "timestamp": "2026-04-06T12:30:00.000Z",
  "event_type": "task.archived",
  "event_id": "4d5e6f7a-8b9c-4d0e-1f2a-3b4c5d6e7f8a",
  "correlation_id": "f3a4b5c6-d7e8-4f9a-0b1c-2d3e4f5a6b7c",
  "payload": {
    "task_id": "task-20260406-001",
    "workspace_path": "workspace/tasks/task-20260406-001/",
    "promoted": true
  },
  "prev_hash": "f4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3"
}
```

### 6.14 recall.generate

Records the generation of recall material from compiled knowledge.

| Field          | Type     | Required | Description                                   |
| -------------- | -------- | -------- | --------------------------------------------- |
| `topic`        | string   | Yes      | Topic name the recall material covers         |
| `card_count`   | integer  | Yes      | Number of flashcards generated                |
| `quiz_count`   | integer  | Yes      | Number of quiz questions generated            |
| `source_pages` | string[] | Yes      | Wiki pages used to generate recall material   |
| `output_path`  | string   | Yes      | Workspace-relative path to generated material |

```jsonl
{
  "timestamp": "2026-04-06T13:00:00.000Z",
  "event_type": "recall.generate",
  "event_id": "5e6f7a8b-9c0d-4e1f-2a3b-4c5d6e7f8a9b",
  "correlation_id": null,
  "payload": {
    "topic": "transformer-attention",
    "card_count": 15,
    "quiz_count": 5,
    "source_pages": [
      "workspace/wiki/topics/transformer-attention-comparison.md",
      "workspace/wiki/concepts/self-attention.md"
    ],
    "output_path": "workspace/recall/decks/transformer-attention.json"
  },
  "prev_hash": "a5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4"
}
```

### 6.15 recall.quiz

Records the start of an interactive quiz session.

| Field        | Type    | Required | Description                                              |
| ------------ | ------- | -------- | -------------------------------------------------------- |
| `session_id` | string  | Yes      | Unique session identifier                                |
| `topic`      | string  | No       | Topic filter, or omit for mixed review                   |
| `card_count` | integer | Yes      | Number of cards in this session                          |
| `mode`       | string  | Yes      | `review` (spaced repetition) or `test` (full assessment) |

```jsonl
{
  "timestamp": "2026-04-06T14:00:00.000Z",
  "event_type": "recall.quiz",
  "event_id": "6f7a8b9c-0d1e-4f2a-3b4c-5d6e7f8a9b0c",
  "correlation_id": "a4b5c6d7-e8f9-4a0b-1c2d-3e4f5a6b7c8d",
  "payload": {
    "session_id": "quiz-20260406-001",
    "topic": "transformer-attention",
    "card_count": 10,
    "mode": "review"
  },
  "prev_hash": "b6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5"
}
```

### 6.16 recall.result

Records the result of a single quiz answer.

| Field              | Type    | Required | Description                                           |
| ------------------ | ------- | -------- | ----------------------------------------------------- |
| `session_id`       | string  | Yes      | Quiz session identifier                               |
| `card_id`          | string  | Yes      | Flashcard identifier                                  |
| `concept`          | string  | Yes      | Concept being tested                                  |
| `correct`          | boolean | Yes      | Whether the answer was correct                        |
| `retention_score`  | number  | Yes      | Updated retention score for this concept (0.0 to 1.0) |
| `response_time_ms` | integer | Yes      | Time taken to answer in milliseconds                  |

```jsonl
{
  "timestamp": "2026-04-06T14:00:15.000Z",
  "event_type": "recall.result",
  "event_id": "7a8b9c0d-1e2f-4a3b-4c5d-6e7f8a9b0c1d",
  "correlation_id": "a4b5c6d7-e8f9-4a0b-1c2d-3e4f5a6b7c8d",
  "payload": {
    "session_id": "quiz-20260406-001",
    "card_id": "card-sa-003",
    "concept": "self-attention",
    "correct": true,
    "retention_score": 0.85,
    "response_time_ms": 4200
  },
  "prev_hash": "c7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6"
}
```

### 6.17 eval.run

Records the start of an evaluation spec execution.

| Field       | Type   | Required | Description                                                     |
| ----------- | ------ | -------- | --------------------------------------------------------------- |
| `eval_id`   | string | Yes      | Evaluation spec identifier                                      |
| `eval_name` | string | Yes      | Human-readable evaluation name                                  |
| `target`    | string | Yes      | What is being evaluated: compilation pass name, topic, or `all` |

```jsonl
{
  "timestamp": "2026-04-06T15:00:00.000Z",
  "event_type": "eval.run",
  "event_id": "8b9c0d1e-2f3a-4b4c-5d6e-7f8a9b0c1d2e",
  "correlation_id": "b5c6d7e8-f9a0-4b1c-2d3e-4f5a6b7c8d9e",
  "payload": {
    "eval_id": "eval-summarize-001",
    "eval_name": "Summarization quality check",
    "target": "summarize"
  },
  "prev_hash": "d8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7"
}
```

### 6.18 eval.result

Records the result of an evaluation spec execution.

| Field         | Type    | Required | Description                              |
| ------------- | ------- | -------- | ---------------------------------------- |
| `eval_id`     | string  | Yes      | Same as eval.run                         |
| `eval_name`   | string  | Yes      | Same as eval.run                         |
| `passed`      | boolean | Yes      | Whether the evaluation passed            |
| `score`       | number  | No       | Numeric score if applicable (0.0 to 1.0) |
| `details`     | string  | Yes      | Human-readable summary of results        |
| `duration_ms` | integer | Yes      | Wall-clock duration                      |

```jsonl
{
  "timestamp": "2026-04-06T15:01:30.000Z",
  "event_type": "eval.result",
  "event_id": "9c0d1e2f-3a4b-4c5d-6e7f-8a9b0c1d2e3f",
  "correlation_id": "b5c6d7e8-f9a0-4b1c-2d3e-4f5a6b7c8d9e",
  "payload": {
    "eval_id": "eval-summarize-001",
    "eval_name": "Summarization quality check",
    "passed": true,
    "score": 0.92,
    "details": "18/20 summaries met quality threshold. 2 flagged for review: sources/legacy-rnn-survey.md, sources/bert-original.md",
    "duration_ms": 90000
  },
  "prev_hash": "e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8"
}
```

### 6.19 lint.run

Records the start of a knowledge lint check.

| Field       | Type   | Required | Description                                                               |
| ----------- | ------ | -------- | ------------------------------------------------------------------------- |
| `lint_type` | string | Yes      | Lint category: `staleness`, `schema`, `gaps`, `contradictions`, `orphans` |
| `scope`     | string | Yes      | What is being linted: `all`, specific type directory, or specific file    |

```jsonl
{
  "timestamp": "2026-04-06T16:00:00.000Z",
  "event_type": "lint.run",
  "event_id": "0d1e2f3a-4b5c-4d6e-7f8a-9b0c1d2e3f4a",
  "correlation_id": "c6d7e8f9-a0b1-4c2d-3e4f-5a6b7c8d9e0f",
  "payload": {
    "lint_type": "staleness",
    "scope": "all"
  },
  "prev_hash": "f0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9"
}
```

### 6.20 lint.result

Records the result of a knowledge lint check.

| Field          | Type     | Required | Description                                                                                         |
| -------------- | -------- | -------- | --------------------------------------------------------------------------------------------------- |
| `lint_type`    | string   | Yes      | Same as lint.run                                                                                    |
| `scope`        | string   | Yes      | Same as lint.run                                                                                    |
| `issues_found` | integer  | Yes      | Number of issues detected                                                                           |
| `issues`       | object[] | Yes      | Array of `{path: string, severity: string, message: string}`. Severity: `error`, `warning`, `info`. |
| `duration_ms`  | integer  | Yes      | Wall-clock duration                                                                                 |

```jsonl
{
  "timestamp": "2026-04-06T16:00:45.000Z",
  "event_type": "lint.result",
  "event_id": "1e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b",
  "correlation_id": "c6d7e8f9-a0b1-4c2d-3e4f-5a6b7c8d9e0f",
  "payload": {
    "lint_type": "staleness",
    "scope": "all",
    "issues_found": 3,
    "issues": [
      {
        "path": "workspace/wiki/sources/old-nlp-survey.md",
        "severity": "warning",
        "message": "Source re-ingested 2026-04-05; summary not recompiled"
      },
      {
        "path": "workspace/wiki/topics/rnn-architectures.md",
        "severity": "warning",
        "message": "Dependent source updated; topic synthesis stale"
      },
      {
        "path": "workspace/wiki/concepts/beam-search.md",
        "severity": "info",
        "message": "No backlinks from any topic page"
      }
    ],
    "duration_ms": 45000
  },
  "prev_hash": "a1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0"
}
```

---

## 7. Secret Field Deny-List

Trace payloads must never contain secrets, credentials, or authentication material. The kernel enforces a deny-list at write time. Any event containing a denied field or value pattern is rejected — the field is stripped and a warning is logged.

### 7.1 Denied field names

The following field names are prohibited at any depth within the `payload` object:

| Field Name      | Reason                               |
| --------------- | ------------------------------------ |
| `apiKey`        | API credentials                      |
| `api_key`       | API credentials (snake_case variant) |
| `authorization` | Auth headers                         |
| `token`         | Session or API tokens                |
| `secret`        | Generic secret storage               |
| `password`      | User credentials                     |
| `credential`    | Generic credential storage           |
| `private_key`   | Cryptographic material               |
| `access_token`  | OAuth tokens                         |
| `refresh_token` | OAuth refresh tokens                 |

### 7.2 Denied value patterns

The following regex patterns are matched against all string values in the payload. If any value matches, the field is stripped.

| Pattern                  | Matches                       |
| ------------------------ | ----------------------------- |
| `^sk-ant-[a-zA-Z0-9-]+$` | Anthropic API keys            |
| `^Bearer .+$`            | Bearer token values           |
| `^sk-[a-zA-Z0-9-]+$`     | OpenAI-style API keys         |
| `^ghp_[a-zA-Z0-9]+$`     | GitHub personal access tokens |
| `^ghu_[a-zA-Z0-9]+$`     | GitHub user tokens            |
| `^xoxb-[a-zA-Z0-9-]+$`   | Slack bot tokens              |

### 7.3 Enforcement behavior

1. Before writing an event, the kernel walks all fields in the `payload` object recursively.
2. Any field whose name matches the denied field list (case-insensitive) is removed.
3. Any string value matching a denied pattern is removed (the containing field is stripped).
4. The event is written with the stripped payload.
5. A separate warning event is appended to the same trace file recording what was stripped.

### 7.4 Rejection examples

**Input event with denied fields:**

```json
{
  "timestamp": "2026-04-06T17:00:00.000Z",
  "event_type": "compilation.start",
  "event_id": "2f3a4b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
  "correlation_id": null,
  "payload": {
    "pass_type": "summarize",
    "target": "workspace/raw/papers/example.pdf",
    "source_count": 1,
    "apiKey": "sk-ant-api03-REDACTED",
    "authorization": "Bearer eyJhbGciOiJIUzI1NiIs..."
  },
  "prev_hash": "b2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1"
}
```

**What gets written (denied fields stripped):**

```json
{
  "timestamp": "2026-04-06T17:00:00.000Z",
  "event_type": "compilation.start",
  "event_id": "2f3a4b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
  "correlation_id": null,
  "payload": {
    "pass_type": "summarize",
    "target": "workspace/raw/papers/example.pdf",
    "source_count": 1
  },
  "prev_hash": "b2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1"
}
```

**Warning event appended immediately after:**

```json
{
  "timestamp": "2026-04-06T17:00:00.001Z",
  "event_type": "_deny_list_violation",
  "event_id": "3a4b5c6d-7e8f-4a9b-0c1d-2e3f4a5b6c7d",
  "correlation_id": null,
  "payload": {
    "original_event_id": "2f3a4b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c",
    "stripped_fields": ["apiKey", "authorization"],
    "reason": "Secret field deny-list enforcement"
  },
  "prev_hash": "<hash of the stripped event line>"
}
```

**Input event with denied value pattern:**

```json
{
  "timestamp": "2026-04-06T17:01:00.000Z",
  "event_type": "ingest",
  "event_id": "4b5c6d7e-8f9a-4b0c-1d2e-3f4a5b6c7d8e",
  "correlation_id": null,
  "payload": {
    "source_path": "workspace/raw/notes/meeting.md",
    "source_type": "markdown",
    "content_hash": "sha256:abc123",
    "byte_size": 2048,
    "notes": "Used token sk-ant-api03-abc123def456 to fetch this"
  },
  "prev_hash": "c3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2"
}
```

**What gets written (value-matched field stripped):**

```json
{
  "timestamp": "2026-04-06T17:01:00.000Z",
  "event_type": "ingest",
  "event_id": "4b5c6d7e-8f9a-4b0c-1d2e-3f4a5b6c7d8e",
  "correlation_id": null,
  "payload": {
    "source_path": "workspace/raw/notes/meeting.md",
    "source_type": "markdown",
    "content_hash": "sha256:abc123",
    "byte_size": 2048
  },
  "prev_hash": "c3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2"
}
```

---

## 8. Learning Model Support

Traces are the shared substrate for all three learning layers defined in Blueprint Section 5.6. This section maps trace events to learning uses.

### 8.1 Context refinement (Now — Phases 1-4)

| Question                                                    | Answered by                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Which compilation schemas produce good summaries?           | `compilation.complete` duration + `eval.result` scores correlated by topic |
| Which topics have high retrieval hit rates?                 | `retrieval` events grouped by result paths                                 |
| Which recall items are retained vs forgotten?               | `recall.result` events grouped by concept, tracked over time               |
| Which sources are most-cited?                               | `ask.complete` `sources_cited` fields aggregated                           |
| Where do users ask questions the system cannot answer well? | `ask.complete` events with low source counts or long durations             |

### 8.2 Harness improvement (Later — Phase 3+)

| Question                                            | Answered by                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Which compiler passes produce stale output?         | `lint.result` staleness issues correlated with `compilation.complete` timestamps |
| Where do task workflows stall?                      | `task.transition` events — long gaps between transitions or missing transitions  |
| Which promotion decisions get reversed?             | `promotion` events followed by re-ingestion or re-compilation of the same target |
| What is the cost (tokens, time) per operation type? | `*.complete` events with `tokens_used` and `duration_ms` aggregated by type      |

### 8.3 Future learning analysis (Much later, if ever)

| Question                                | Answered by                                                           |
| --------------------------------------- | --------------------------------------------------------------------- |
| Training signal for compilation quality | `compilation.complete` paired with `eval.result` for the same targets |
| Retrieval relevance signal              | `retrieval` scores correlated with downstream `ask.complete` quality  |
| End-to-end workflow effectiveness       | Full correlation chains from `ingest` through `task.completed`        |

---

## 9. Internal Event Types

The following event types are reserved for system-internal use. They are not triggered by user commands.

| Event Type             | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `_deny_list_violation` | Secret field deny-list enforcement triggered (see Section 7.4) |
| `_chain_break`         | Integrity chain break detected during verification             |
| `_schema_violation`    | Event payload failed schema validation                         |

Internal event types are prefixed with `_` and are never exposed in user-facing summaries. They are included in trace files for operational debugging.

---

## 10. Implementation Notes

### 10.1 Write path

1. Caller constructs an event object with all required envelope fields except `prev_hash`.
2. Kernel reads the last line of today's trace file (or determines this is the first event).
3. Kernel computes SHA-256 of the last line, or sets `null` for chain anchor.
4. Kernel sets `prev_hash` on the event.
5. Kernel walks `payload` for deny-list violations, strips as needed.
6. Kernel serializes the event to a single JSON line (deterministic key order, no whitespace).
7. Kernel appends the line + LF to the trace file.
8. If deny-list fields were stripped, kernel appends a `_deny_list_violation` event immediately after.

### 10.2 Read path

Trace files are plain JSONL. Consumers read them with:

- `cat workspace/audit/traces/2026-04-06.jsonl | jq .` — Pretty-print all events
- `grep '"event_type":"compilation.complete"' workspace/audit/traces/*.jsonl` — Find all compilation completions
- `jq 'select(.correlation_id == "c9bf9e57-...")' workspace/audit/traces/2026-04-06.jsonl` — Follow a correlation chain

### 10.3 Retention

Trace files are never deleted by the system. Retention policy is operator-controlled. The system does not auto-prune, archive, or rotate trace files beyond the daily file split.

### 10.4 Concurrency

In local mode (Phases 1-4), writes are serialized through the kernel. One writer, append-only. No locking required beyond single-process guarantees from Node.js event loop.

In remote mode (Phase 5), write serialization becomes a distributed concern. This is deferred.

---

## 11. Zod Schema Reference

The following is the planned Zod schema structure for implementation in `packages/types/`. This is a reference — the actual implementation will live in code, not in this document.

```typescript
import { z } from 'zod';

// Envelope
const TraceEnvelope = z.object({
  timestamp: z.string().datetime(),
  event_type: z.string(),
  event_id: z.string().uuid(),
  correlation_id: z.string().uuid().nullable(),
  payload: z.record(z.unknown()),
  prev_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});

// Example payload schema: ingest
const IngestPayload = z.object({
  source_path: z.string(),
  source_type: z.enum(['pdf', 'markdown', 'html', 'text', 'json', 'csv']),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  byte_size: z.number().int().positive(),
  mount_name: z.string().optional(),
  title: z.string().optional(),
});

// Example payload schema: compilation.complete
const CompilationCompletePayload = z.object({
  pass_type: z.enum(['summarize', 'extract', 'synthesize', 'link', 'contradict', 'gap']),
  target: z.string(),
  output_paths: z.array(z.string()),
  duration_ms: z.number().int().nonnegative(),
  tokens_used: z.number().int().nonnegative().optional(),
});

// Deny-list field names (case-insensitive match)
const DENIED_FIELD_NAMES = [
  'apikey',
  'api_key',
  'authorization',
  'token',
  'secret',
  'password',
  'credential',
  'private_key',
  'access_token',
  'refresh_token',
] as const;

// Deny-list value patterns
const DENIED_VALUE_PATTERNS = [
  /^sk-ant-[a-zA-Z0-9-]+$/,
  /^Bearer .+$/,
  /^sk-[a-zA-Z0-9-]+$/,
  /^ghp_[a-zA-Z0-9]+$/,
  /^ghu_[a-zA-Z0-9]+$/,
  /^xoxb-[a-zA-Z0-9-]+$/,
];
```

---

## 12. Complete Chain Example

A minimal but complete trace file showing the integrity chain across three events.

**File: `workspace/audit/traces/2026-04-06.jsonl`**

```jsonl
{"timestamp":"2026-04-06T08:00:01.123Z","event_type":"ingest","event_id":"f47ac10b-58cc-4372-a567-0e02b2c3d479","correlation_id":null,"payload":{"source_path":"workspace/raw/papers/attention-is-all-you-need.pdf","source_type":"pdf","content_hash":"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","byte_size":2103456,"title":"Attention Is All You Need"},"prev_hash":null}
{"timestamp":"2026-04-06T08:01:00.000Z","event_type":"compilation.start","event_id":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","correlation_id":"c9bf9e57-1685-4c89-bafb-ff5af830be8a","payload":{"pass_type":"summarize","target":"workspace/raw/papers/attention-is-all-you-need.pdf","source_count":1},"prev_hash":"8b3e0a7f1c2d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f"}
{"timestamp":"2026-04-06T08:01:22.456Z","event_type":"compilation.complete","event_id":"6ba7b811-9dad-11d1-80b4-00c04fd430c8","correlation_id":"c9bf9e57-1685-4c89-bafb-ff5af830be8a","payload":{"pass_type":"summarize","target":"workspace/raw/papers/attention-is-all-you-need.pdf","output_paths":["workspace/wiki/sources/attention-is-all-you-need.md"],"duration_ms":22456,"tokens_used":4821},"prev_hash":"4a2c8e1f3b5d7a9c0e2f4b6d8a1c3e5f7b9d0a2c4e6f8b1d3a5c7e9f0b2d4a6c"}
```

**Chain verification:**

1. Line 1: `prev_hash` is `null` (chain anchor, first event of the day).
2. Line 2: `prev_hash` equals SHA-256 of the raw bytes of Line 1.
3. Line 3: `prev_hash` equals SHA-256 of the raw bytes of Line 2.

To verify programmatically:

```bash
# Read lines, compute hashes, compare
node -e "
const crypto = require('crypto');
const fs = require('fs');
const lines = fs.readFileSync('workspace/audit/traces/2026-04-06.jsonl', 'utf8').trim().split('\n');
let prevHash = null;
for (const line of lines) {
  const event = JSON.parse(line);
  if (event.prev_hash !== prevHash) {
    console.error('CHAIN BREAK at', event.event_id);
    process.exit(1);
  }
  prevHash = crypto.createHash('sha256').update(line).digest('hex');
}
console.log('Chain intact:', lines.length, 'events verified');
"
```

---

## Appendix A: Event Type Quick Reference

For grep and tooling. All event types on one line:

```
ingest compilation.start compilation.complete retrieval ask.start ask.complete render.start render.complete promotion task.created task.transition task.completed task.archived recall.generate recall.quiz recall.result eval.run eval.result lint.run lint.result
```

Internal types (prefixed with `_`):

```
_deny_list_violation _chain_break _schema_violation
```
