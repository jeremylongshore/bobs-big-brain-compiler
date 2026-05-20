# SQLite Database Schema and Migration Strategy

> Deterministic state for a knowledge operating system — every table, constraint, index, and migration in one document.

**Author:** Jeremy Longshore — Intent Solutions
**Date:** 2026-04-06
**Version:** 1.0.0
**Status:** Frozen for Phase 1

---

## 1. Overview

Intentional Cognition OS uses SQLite (via `better-sqlite3`) as the deterministic state database. SQLite owns structured state: source registry, mount registry, compilation records, task lifecycle, promotion log, recall results, and trace index. It does not store raw content, compiled markdown, or JSONL trace payloads — those live on the filesystem. The database is the index and state machine; the filesystem is the content store.

The database file lives at `workspace/.ico/state.db`. It is created by `ico init` and managed exclusively by the kernel. No other component writes to it directly.

**Naming reconciliation.** The tech spec (v0.1.0) used `compilations` as the table name. The blueprint (v2.2) occasionally references "compiled pages" as a concept. The canonical table name is **`compilations`**. All code, queries, and documentation must use this name. "Compiled page" remains valid as a prose term for the wiki markdown files that compilation produces.

---

## 2. Pragmas and Concurrency Policy

All connections must set these pragmas immediately after opening. See blueprint Section 5.3 (deterministic side owns state).

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

| Pragma         | Value    | Rationale                                                               |
| -------------- | -------- | ----------------------------------------------------------------------- |
| `journal_mode` | `WAL`    | Allows concurrent reads during writes. Required for CLI responsiveness. |
| `foreign_keys` | `ON`     | Enforces referential integrity at the database level.                   |
| `busy_timeout` | `5000`   | Waits up to 5 seconds for a write lock before returning SQLITE_BUSY.    |
| `synchronous`  | `NORMAL` | Balanced durability — safe with WAL mode, avoids fsync on every commit. |

### 2.1 Workspace Lockfile

SQLite WAL mode handles read/write concurrency within a single process. For multi-process protection (e.g., two `ico` commands running simultaneously), the kernel acquires a lockfile at `workspace/.ico/state.lock` before any write transaction.

**Protocol:**

1. Attempt to acquire exclusive lock on `workspace/.ico/state.lock` using `flock()` (non-blocking).
2. If lock acquired: proceed with the write transaction, release lock on completion.
3. If lock not acquired: wait up to 5 seconds with retry, then fail with `ICO_LOCK_TIMEOUT` error.
4. Read-only operations do not acquire the lockfile — WAL mode handles concurrent reads natively.

This is a cooperative lock. It protects against accidental concurrent writes from the CLI, not against adversarial access.

---

## 3. Schema DDL

All tables are created in migration `001-initial-schema.sql`. The DDL below is the complete, executable schema.

### 3.1 sources

Tracks every ingested source file. Maps to L1 (Raw Corpus). See blueprint Section 5.1.

```sql
CREATE TABLE sources (
    id          TEXT    PRIMARY KEY,
    path        TEXT    NOT NULL,
    mount_id    TEXT    REFERENCES mounts(id),
    type        TEXT    NOT NULL CHECK (type IN ('pdf', 'markdown', 'html', 'text')),
    title       TEXT,
    author      TEXT,
    ingested_at TEXT    NOT NULL,
    word_count  INTEGER,
    hash        TEXT    NOT NULL,
    metadata    TEXT,
    UNIQUE (path, hash)
);
```

| Column        | Type    | Constraints                | Description                                                   |
| ------------- | ------- | -------------------------- | ------------------------------------------------------------- |
| `id`          | TEXT    | PRIMARY KEY                | ULID or UUID. Generated at ingest time.                       |
| `path`        | TEXT    | NOT NULL                   | Relative path within `workspace/raw/`.                        |
| `mount_id`    | TEXT    | FK -> mounts(id), nullable | Mount that sourced this file, if any.                         |
| `type`        | TEXT    | NOT NULL, CHECK            | Source file type. One of: pdf, markdown, html, text.          |
| `title`       | TEXT    | nullable                   | Extracted or user-provided title.                             |
| `author`      | TEXT    | nullable                   | Extracted or user-provided author.                            |
| `ingested_at` | TEXT    | NOT NULL                   | ISO 8601 timestamp. When the source was ingested.             |
| `word_count`  | INTEGER | nullable                   | Approximate word count of extracted text.                     |
| `hash`        | TEXT    | NOT NULL                   | SHA-256 content hash for dedup and staleness detection.       |
| `metadata`    | TEXT    | nullable                   | JSON blob for type-specific metadata (page count, URL, etc.). |

**Unique constraint:** `(path, hash)` prevents duplicate ingestion of the same content at the same path. Re-ingestion with changed content produces a new row (new hash).

### 3.2 mounts

Tracks registered corpus mount points. See blueprint Section 4.2 (semantic filesystem) and tech spec CLI commands.

```sql
CREATE TABLE mounts (
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL UNIQUE,
    path            TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    last_indexed_at TEXT
);
```

| Column            | Type | Constraints      | Description                                                               |
| ----------------- | ---- | ---------------- | ------------------------------------------------------------------------- |
| `id`              | TEXT | PRIMARY KEY      | ULID or UUID.                                                             |
| `name`            | TEXT | NOT NULL, UNIQUE | Human-readable mount name (e.g., "research-papers").                      |
| `path`            | TEXT | NOT NULL         | Absolute or workspace-relative path to the mount directory.               |
| `created_at`      | TEXT | NOT NULL         | ISO 8601 timestamp.                                                       |
| `last_indexed_at` | TEXT | nullable         | ISO 8601 timestamp of last `ico mount` index scan. NULL if never indexed. |

### 3.3 compilations

Tracks every compilation output produced by the compiler. Maps compiled wiki pages back to their source(s). See blueprint Section 6 (The Compiler) and tech spec schema.

```sql
CREATE TABLE compilations (
    id          TEXT    PRIMARY KEY,
    source_id   TEXT    REFERENCES sources(id),
    type        TEXT    NOT NULL CHECK (type IN (
                            'summary', 'concept', 'topic',
                            'entity', 'contradiction', 'open-question'
                        )),
    output_path TEXT    NOT NULL,
    compiled_at TEXT    NOT NULL,
    stale       INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
    model       TEXT    NOT NULL,
    tokens_used INTEGER,
    UNIQUE (source_id, type, output_path)
);
```

| Column        | Type    | Constraints                 | Description                                                                            |
| ------------- | ------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `id`          | TEXT    | PRIMARY KEY                 | ULID or UUID.                                                                          |
| `source_id`   | TEXT    | FK -> sources(id), nullable | Source that was compiled. NULL for cross-source compilations (topics, contradictions). |
| `type`        | TEXT    | NOT NULL, CHECK             | Compilation pass type. All six blueprint passes represented.                           |
| `output_path` | TEXT    | NOT NULL                    | Relative path within `workspace/wiki/` to the compiled page.                           |
| `compiled_at` | TEXT    | NOT NULL                    | ISO 8601 timestamp.                                                                    |
| `stale`       | INTEGER | NOT NULL, DEFAULT 0, CHECK  | 0 = current, 1 = stale. Set by staleness detection (blueprint Section 6.3).            |
| `model`       | TEXT    | NOT NULL                    | Model identifier used for this compilation (e.g., "claude-sonnet-4-6").                |
| `tokens_used` | INTEGER | nullable                    | Total tokens consumed (input + output). NULL if not tracked.                           |

**Unique constraint:** `(source_id, type, output_path)` prevents duplicate compilation records for the same source-type-path combination. Recompilation replaces the existing row.

**Note on cross-source compilations:** Topic pages, contradiction notes, and open-question files may synthesize across multiple sources. For these, `source_id` is NULL. A separate junction table (`compilation_sources`) links them to their inputs — see Section 3.8.

### 3.4 tasks

Tracks episodic research task lifecycle. Maps to L3 (Episodic Tasks). See blueprint Section 8.1 (task lifecycle).

```sql
CREATE TABLE tasks (
    id              TEXT    PRIMARY KEY,
    brief           TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'created' CHECK (status IN (
                                'created', 'collecting', 'synthesizing',
                                'critiquing', 'rendering', 'completed', 'archived'
                            )),
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    completed_at    TEXT,
    archived_at     TEXT,
    workspace_path  TEXT    NOT NULL
);
```

| Column           | Type | Constraints                        | Description                                                            |
| ---------------- | ---- | ---------------------------------- | ---------------------------------------------------------------------- |
| `id`             | TEXT | PRIMARY KEY                        | ULID or UUID. Also used as the task directory name.                    |
| `brief`          | TEXT | NOT NULL                           | User-provided research question or task description.                   |
| `status`         | TEXT | NOT NULL, DEFAULT 'created', CHECK | Current lifecycle state. Seven valid states per blueprint Section 8.1. |
| `created_at`     | TEXT | NOT NULL                           | ISO 8601 timestamp.                                                    |
| `updated_at`     | TEXT | NOT NULL                           | ISO 8601 timestamp. Updated on every status transition.                |
| `completed_at`   | TEXT | nullable                           | ISO 8601 timestamp. Set when status transitions to 'completed'.        |
| `archived_at`    | TEXT | nullable                           | ISO 8601 timestamp. Set when status transitions to 'archived'.         |
| `workspace_path` | TEXT | NOT NULL                           | Relative path to the task workspace (e.g., "tasks/01JQXYZ...").        |

**Task state machine.** Valid transitions are enforced by the kernel, not the database. The CHECK constraint validates the value domain; the kernel validates transition legality:

```
created -> collecting -> synthesizing -> critiquing -> rendering -> completed -> archived
```

Each transition updates `updated_at`. The `completed` -> `archived` transition sets `archived_at`. The `rendering` -> `completed` transition sets `completed_at`.

### 3.5 promotions

Logs every promotion event (L4 artifact filed back into L2). See blueprint Section 7.

```sql
CREATE TABLE promotions (
    id              TEXT    PRIMARY KEY,
    source_path     TEXT    NOT NULL,
    target_path     TEXT    NOT NULL,
    target_type     TEXT    NOT NULL CHECK (target_type IN (
                                'topic', 'concept', 'entity', 'reference'
                            )),
    promoted_at     TEXT    NOT NULL,
    promoted_by     TEXT    NOT NULL CHECK (promoted_by IN ('user', 'system'))
);
```

| Column        | Type | Constraints     | Description                                                                                         |
| ------------- | ---- | --------------- | --------------------------------------------------------------------------------------------------- |
| `id`          | TEXT | PRIMARY KEY     | ULID or UUID.                                                                                       |
| `source_path` | TEXT | NOT NULL        | Path in `workspace/outputs/` of the promoted artifact.                                              |
| `target_path` | TEXT | NOT NULL        | Destination path in `workspace/wiki/<type>/`.                                                       |
| `target_type` | TEXT | NOT NULL, CHECK | Target wiki type. Must match the `--as` flag from `ico promote`.                                    |
| `promoted_at` | TEXT | NOT NULL        | ISO 8601 timestamp.                                                                                 |
| `promoted_by` | TEXT | NOT NULL, CHECK | Actor. Currently always 'user' — automatic promotion is not allowed (blueprint Section 7.1 rule 7). |

### 3.6 recall_results

Tracks quiz and recall test outcomes for adaptive learning. Maps to L5 (Recall). See blueprint Section 9.3.

```sql
CREATE TABLE recall_results (
    id          TEXT    PRIMARY KEY,
    concept     TEXT    NOT NULL,
    topic       TEXT,
    correct     INTEGER NOT NULL CHECK (correct IN (0, 1)),
    tested_at   TEXT    NOT NULL,
    confidence  REAL    CHECK (confidence >= 0.0 AND confidence <= 1.0),
    source_card TEXT
);
```

| Column        | Type    | Constraints     | Description                                                           |
| ------------- | ------- | --------------- | --------------------------------------------------------------------- |
| `id`          | TEXT    | PRIMARY KEY     | ULID or UUID.                                                         |
| `concept`     | TEXT    | NOT NULL        | Concept name being tested. Should match a concept page title in wiki. |
| `topic`       | TEXT    | nullable        | Topic context for the question, if applicable.                        |
| `correct`     | INTEGER | NOT NULL, CHECK | 0 = incorrect, 1 = correct.                                           |
| `tested_at`   | TEXT    | NOT NULL        | ISO 8601 timestamp.                                                   |
| `confidence`  | REAL    | CHECK range     | Self-reported confidence (0.0 to 1.0). NULL if not collected.         |
| `source_card` | TEXT    | nullable        | Path to the flashcard file that generated this question.              |

### 3.7 traces

Index table for JSONL trace files. Provides structured queryability over the append-only audit log. See blueprint Section 5.5 (operational control files) and Section 5.6 (traces as learning substrate). Full trace payloads live in JSONL files at `workspace/audit/traces/`; this table stores enough metadata to query without parsing every line.

```sql
CREATE TABLE traces (
    id              TEXT    PRIMARY KEY,
    event_type      TEXT    NOT NULL,
    correlation_id  TEXT,
    timestamp       TEXT    NOT NULL,
    file_path       TEXT    NOT NULL,
    line_offset     INTEGER NOT NULL,
    summary         TEXT
);
```

| Column           | Type    | Constraints | Description                                                                                             |
| ---------------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `id`             | TEXT    | PRIMARY KEY | Matches `event_id` in the JSONL envelope.                                                               |
| `event_type`     | TEXT    | NOT NULL    | Event type string (e.g., "ingest", "compile", "task.transition", "promote", "recall.test", "eval.run"). |
| `correlation_id` | TEXT    | nullable    | Groups related events (e.g., all events in a single research task share a correlation_id).              |
| `timestamp`      | TEXT    | NOT NULL    | ISO 8601 timestamp. Matches the JSONL envelope timestamp.                                               |
| `file_path`      | TEXT    | NOT NULL    | Relative path to the JSONL trace file (e.g., "audit/traces/2026-04-06.jsonl").                          |
| `line_offset`    | INTEGER | NOT NULL    | Zero-based byte offset within the JSONL file for direct seek.                                           |
| `summary`        | TEXT    | nullable    | One-line human-readable summary of the event. Used by `log.md` generation.                              |

### 3.8 compilation_sources (junction table)

Links cross-source compilations (topics, contradictions, open-questions) to their input sources. A compilation with a non-NULL `source_id` in the `compilations` table has a single source; cross-source compilations use this junction table instead.

```sql
CREATE TABLE compilation_sources (
    compilation_id  TEXT    NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
    source_id       TEXT    NOT NULL REFERENCES sources(id),
    PRIMARY KEY (compilation_id, source_id)
);
```

| Column           | Type | Constraints      | Description                                              |
| ---------------- | ---- | ---------------- | -------------------------------------------------------- |
| `compilation_id` | TEXT | NOT NULL, FK, PK | The cross-source compilation record.                     |
| `source_id`      | TEXT | NOT NULL, FK, PK | One of the sources that contributed to this compilation. |

---

## 4. Index Definitions

Indexes support the query patterns used by CLI commands and the kernel.

```sql
-- sources: lookup by hash for dedup check during ingest
CREATE INDEX idx_sources_hash ON sources(hash);

-- sources: filter by type for selective compilation
CREATE INDEX idx_sources_type ON sources(type);

-- sources: lookup by mount for mount-scoped operations
CREATE INDEX idx_sources_mount_id ON sources(mount_id);

-- compilations: find all compilations for a source
CREATE INDEX idx_compilations_source_id ON compilations(source_id);

-- compilations: filter by type for pass-specific queries
CREATE INDEX idx_compilations_type ON compilations(type);

-- compilations: find stale compilations for recompilation queue
CREATE INDEX idx_compilations_stale ON compilations(stale) WHERE stale = 1;

-- compilations: lookup by output path for reverse mapping (wiki page -> compilation record)
CREATE INDEX idx_compilations_output_path ON compilations(output_path);

-- tasks: filter by status for dashboard and lifecycle queries
CREATE INDEX idx_tasks_status ON tasks(status);

-- tasks: sort by creation date for chronological listing
CREATE INDEX idx_tasks_created_at ON tasks(created_at);

-- recall_results: aggregate by concept for retention scoring
CREATE INDEX idx_recall_results_concept ON recall_results(concept);

-- recall_results: sort by test date for recent activity
CREATE INDEX idx_recall_results_tested_at ON recall_results(tested_at);

-- traces: filter by event type for targeted audit queries
CREATE INDEX idx_traces_event_type ON traces(event_type);

-- traces: filter by correlation_id to follow event chains
CREATE INDEX idx_traces_correlation_id ON traces(correlation_id)
    WHERE correlation_id IS NOT NULL;

-- traces: sort by timestamp for chronological audit
CREATE INDEX idx_traces_timestamp ON traces(timestamp);

-- compilation_sources: reverse lookup — find all compilations that used a given source
CREATE INDEX idx_compilation_sources_source_id ON compilation_sources(source_id);
```

---

## 5. Query Pattern Reference

Common queries the kernel and CLI execute against this schema. Provided as implementation guidance.

| Operation                               | Query Pattern                                                                                                         | Indexes Used                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `ico ingest` dedup check                | `SELECT id FROM sources WHERE hash = ?`                                                                               | `idx_sources_hash`                                  |
| `ico compile sources` — find uncompiled | `SELECT s.id FROM sources s LEFT JOIN compilations c ON c.source_id = s.id AND c.type = 'summary' WHERE c.id IS NULL` | `idx_compilations_source_id`                        |
| `ico compile all` — find stale          | `SELECT * FROM compilations WHERE stale = 1`                                                                          | `idx_compilations_stale`                            |
| `ico status` — task summary             | `SELECT status, COUNT(*) FROM tasks GROUP BY status`                                                                  | `idx_tasks_status`                                  |
| `ico recall weak` — lowest retention    | `SELECT concept, AVG(correct) AS rate FROM recall_results GROUP BY concept ORDER BY rate ASC LIMIT 20`                | `idx_recall_results_concept`                        |
| `ico lint knowledge` — staleness check  | `SELECT c.output_path FROM compilations c JOIN sources s ON c.source_id = s.id WHERE c.compiled_at < s.ingested_at`   | `idx_compilations_source_id`                        |
| Trace audit — event chain               | `SELECT * FROM traces WHERE correlation_id = ? ORDER BY timestamp`                                                    | `idx_traces_correlation_id`, `idx_traces_timestamp` |
| Provenance — wiki page to source        | `SELECT s.* FROM sources s JOIN compilations c ON c.source_id = s.id WHERE c.output_path = ?`                         | `idx_compilations_output_path`                      |

---

## 6. Data Integrity Rules

These rules are enforced by the kernel, not by database constraints alone. The database provides the structural foundation; the kernel provides semantic validation.

| Rule                                    | Enforcement                                                                           | Reference                              |
| --------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| Sources are append-only after ingestion | Kernel refuses UPDATE on sources rows (except metadata corrections)                   | Blueprint Section 5.1                  |
| Compilations track provenance           | Every compilation row links to its source(s) via `source_id` or `compilation_sources` | Blueprint Section 5.3                  |
| Task state transitions are ordered      | Kernel validates transition legality before UPDATE                                    | Blueprint Section 8.1                  |
| Promotions are user-initiated only      | `promoted_by` defaults to 'user'; system-initiated promotion is blocked at the kernel | Blueprint Section 7.1 rule 7           |
| Traces are append-only                  | Kernel never issues UPDATE or DELETE on traces rows                                   | Blueprint Section 5.1 (L6 append-only) |
| Recall results are append-only          | Each quiz attempt creates a new row; results are never modified                       | Blueprint Section 9.3                  |
| All timestamps are ISO 8601             | Kernel formats all dates as `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC)                          | Project convention                     |
| All SQL uses prepared statements        | No string interpolation in queries — parameterized only                               | Security standard (audit H1)           |

---

## 7. Migration Strategy

Migrations use numbered SQL files stored at `kernel/src/migrations/`. Each file contains both `up` and `down` sections separated by a comment marker. The kernel applies migrations sequentially on database open.

### 7.1 Migration File Format

```
kernel/src/migrations/
  001-initial-schema.sql
  002-add-foo-column.sql
  003-add-bar-table.sql
  ...
```

Each migration file follows this format:

```sql
-- Migration: 001-initial-schema
-- Description: Create all initial tables, indexes, and pragmas
-- Date: 2026-04-06

-- === UP ===

<forward DDL statements here>

-- === DOWN ===

<rollback DDL statements here>
```

### 7.2 Migration Tracking Table

The kernel maintains a `_migrations` table to track which migrations have been applied:

```sql
CREATE TABLE IF NOT EXISTS _migrations (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    applied_at  TEXT    NOT NULL
);
```

On database open, the kernel:

1. Creates `_migrations` if it does not exist.
2. Reads all migration files from the `migrations/` directory.
3. Compares file names against `_migrations` rows.
4. Applies any unapplied migrations in numeric order within a transaction.
5. Records each applied migration in `_migrations`.

### 7.3 Rollback Protocol

Rollback is manual and deliberate. The kernel provides a `rollback` function but it is not exposed via the CLI in Phase 1.

**Rollback procedure:**

1. Identify the target migration number to roll back to.
2. Execute the `DOWN` section of each migration in reverse order, from current to target + 1.
3. Remove the corresponding `_migrations` rows.
4. All rollback steps execute within a single transaction — if any step fails, the entire rollback is aborted.

**Rollback constraints:**

- Rollback of `001-initial-schema` drops all tables and indexes. This is a full database reset.
- Rollback across data-destructive migrations (column drops, table drops) may lose data. The kernel logs a warning before executing destructive rollbacks.
- Production rollbacks (Phase 5) will require backup-before-rollback. Phase 1 local mode accepts data loss risk on rollback.

### 7.4 Migration 001: Initial Schema

This is the complete initial migration. It creates all tables and indexes defined in Sections 3 and 4.

```sql
-- Migration: 001-initial-schema
-- Description: Create all initial tables, indexes, and pragmas
-- Date: 2026-04-06

-- === UP ===

CREATE TABLE sources (
    id          TEXT    PRIMARY KEY,
    path        TEXT    NOT NULL,
    mount_id    TEXT    REFERENCES mounts(id),
    type        TEXT    NOT NULL CHECK (type IN ('pdf', 'markdown', 'html', 'text')),
    title       TEXT,
    author      TEXT,
    ingested_at TEXT    NOT NULL,
    word_count  INTEGER,
    hash        TEXT    NOT NULL,
    metadata    TEXT,
    UNIQUE (path, hash)
);

CREATE TABLE mounts (
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL UNIQUE,
    path            TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    last_indexed_at TEXT
);

CREATE TABLE compilations (
    id          TEXT    PRIMARY KEY,
    source_id   TEXT    REFERENCES sources(id),
    type        TEXT    NOT NULL CHECK (type IN (
                            'summary', 'concept', 'topic',
                            'entity', 'contradiction', 'open-question'
                        )),
    output_path TEXT    NOT NULL,
    compiled_at TEXT    NOT NULL,
    stale       INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
    model       TEXT    NOT NULL,
    tokens_used INTEGER,
    UNIQUE (source_id, type, output_path)
);

CREATE TABLE tasks (
    id              TEXT    PRIMARY KEY,
    brief           TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'created' CHECK (status IN (
                                'created', 'collecting', 'synthesizing',
                                'critiquing', 'rendering', 'completed', 'archived'
                            )),
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    completed_at    TEXT,
    archived_at     TEXT,
    workspace_path  TEXT    NOT NULL
);

CREATE TABLE promotions (
    id              TEXT    PRIMARY KEY,
    source_path     TEXT    NOT NULL,
    target_path     TEXT    NOT NULL,
    target_type     TEXT    NOT NULL CHECK (target_type IN (
                                'topic', 'concept', 'entity', 'reference'
                            )),
    promoted_at     TEXT    NOT NULL,
    promoted_by     TEXT    NOT NULL CHECK (promoted_by IN ('user', 'system'))
);

CREATE TABLE recall_results (
    id          TEXT    PRIMARY KEY,
    concept     TEXT    NOT NULL,
    topic       TEXT,
    correct     INTEGER NOT NULL CHECK (correct IN (0, 1)),
    tested_at   TEXT    NOT NULL,
    confidence  REAL    CHECK (confidence >= 0.0 AND confidence <= 1.0),
    source_card TEXT
);

CREATE TABLE traces (
    id              TEXT    PRIMARY KEY,
    event_type      TEXT    NOT NULL,
    correlation_id  TEXT,
    timestamp       TEXT    NOT NULL,
    file_path       TEXT    NOT NULL,
    line_offset     INTEGER NOT NULL,
    summary         TEXT
);

CREATE TABLE compilation_sources (
    compilation_id  TEXT    NOT NULL REFERENCES compilations(id) ON DELETE CASCADE,
    source_id       TEXT    NOT NULL REFERENCES sources(id),
    PRIMARY KEY (compilation_id, source_id)
);

-- Indexes

CREATE INDEX idx_sources_hash ON sources(hash);
CREATE INDEX idx_sources_type ON sources(type);
CREATE INDEX idx_sources_mount_id ON sources(mount_id);

CREATE INDEX idx_compilations_source_id ON compilations(source_id);
CREATE INDEX idx_compilations_type ON compilations(type);
CREATE INDEX idx_compilations_stale ON compilations(stale) WHERE stale = 1;
CREATE INDEX idx_compilations_output_path ON compilations(output_path);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at);

CREATE INDEX idx_recall_results_concept ON recall_results(concept);
CREATE INDEX idx_recall_results_tested_at ON recall_results(tested_at);

CREATE INDEX idx_traces_event_type ON traces(event_type);
CREATE INDEX idx_traces_correlation_id ON traces(correlation_id)
    WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_traces_timestamp ON traces(timestamp);

CREATE INDEX idx_compilation_sources_source_id ON compilation_sources(source_id);

-- === DOWN ===

DROP INDEX IF EXISTS idx_compilation_sources_source_id;
DROP INDEX IF EXISTS idx_traces_timestamp;
DROP INDEX IF EXISTS idx_traces_correlation_id;
DROP INDEX IF EXISTS idx_traces_event_type;
DROP INDEX IF EXISTS idx_recall_results_tested_at;
DROP INDEX IF EXISTS idx_recall_results_concept;
DROP INDEX IF EXISTS idx_tasks_created_at;
DROP INDEX IF EXISTS idx_tasks_status;
DROP INDEX IF EXISTS idx_compilations_output_path;
DROP INDEX IF EXISTS idx_compilations_stale;
DROP INDEX IF EXISTS idx_compilations_type;
DROP INDEX IF EXISTS idx_compilations_source_id;
DROP INDEX IF EXISTS idx_sources_mount_id;
DROP INDEX IF EXISTS idx_sources_type;
DROP INDEX IF EXISTS idx_sources_hash;

DROP TABLE IF EXISTS compilation_sources;
DROP TABLE IF EXISTS traces;
DROP TABLE IF EXISTS recall_results;
DROP TABLE IF EXISTS promotions;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS compilations;
DROP TABLE IF EXISTS mounts;
DROP TABLE IF EXISTS sources;
```

---

## 8. Schema Evolution Guidelines

Rules for future migrations (002+).

1. **One concern per migration.** Each migration file addresses a single change: add a column, add a table, add an index. Do not bundle unrelated changes.
2. **Backward compatibility preferred.** New columns should have DEFAULT values or be nullable. Avoid renaming columns — add a new column and deprecate the old one.
3. **No data migrations in DDL files.** If a migration requires data transformation (e.g., backfilling a new column), write a separate TypeScript migration script that runs after the DDL migration.
4. **Test before ship.** Every migration must be tested by running the full migration sequence (001 through N) on a fresh database, then running the full rollback sequence (N through 001).
5. **SQLite limitations.** SQLite does not support `DROP COLUMN` (before 3.35.0), `ALTER COLUMN`, or `ADD CONSTRAINT`. Workarounds require creating a new table, copying data, dropping the old table, and renaming. Document these workarounds in the migration file's header comment.

---

## 9. Cross-Reference Map

| Table                 | Blueprint Section                               | Tech Spec Section                         | CLI Commands                                      |
| --------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| `sources`             | 5.1 (L1 Raw Corpus)                             | SQLite Schema                             | `ico ingest`, `ico status`                        |
| `mounts`              | 4.2 (Semantic Filesystem)                       | SQLite Schema                             | `ico mount`, `ico status`                         |
| `compilations`        | 6 (The Compiler), 6.3 (Staleness)               | SQLite Schema                             | `ico compile`, `ico lint knowledge`, `ico status` |
| `tasks`               | 8.1 (Task Lifecycle)                            | SQLite Schema                             | `ico research`, `ico status`                      |
| `promotions`          | 7 (Promotion Rules)                             | SQLite Schema                             | `ico promote`                                     |
| `recall_results`      | 9.3 (Feedback Loop)                             | SQLite Schema                             | `ico recall quiz`, `ico recall weak`              |
| `traces`              | 5.5 (Operational Control), 5.6 (Learning Model) | Not in original spec (added per audit C8) | `ico status`, internal audit queries              |
| `compilation_sources` | 6.1 (cross-source passes)                       | Not in original spec                      | Internal provenance queries                       |
| `_migrations`         | N/A (infrastructure)                            | N/A                                       | Internal kernel use                               |
