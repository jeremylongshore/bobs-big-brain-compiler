# @ico/kernel

Deterministic control plane for Intentional Cognition OS. Manages workspace layout, SQLite state, mount registry, source tracking, provenance, traces, task lifecycle, and audit logging.

The kernel owns all durable state. The compiler (probabilistic layer) proposes; the kernel decides.

## Public API

### Workspace

| Function        | Signature                                  | Description                                                        |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `initWorkspace` | `(name, basePath) → Result<WorkspaceInfo>` | Creates the full directory tree, seed files, and `.ico/` directory |

### Database

| Function        | Signature                              | Description                                            |
| --------------- | -------------------------------------- | ------------------------------------------------------ |
| `initDatabase`  | `(dbPath) → Result<Database>`          | Opens SQLite with WAL mode and runs pending migrations |
| `runMigrations` | `(db, migrationsDir) → Result<number>` | Applies unapplied SQL migrations in order              |
| `closeDatabase` | `(db) → void`                          | Safely closes the database connection                  |

### Mounts

| Function         | Signature                            | Description                    |
| ---------------- | ------------------------------------ | ------------------------------ |
| `registerMount`  | `(db, name, path) → Result<Mount>`   | Registers a corpus mount point |
| `listMounts`     | `(db) → Result<Mount[]>`             | Lists all registered mounts    |
| `getMount`       | `(db, id) → Result<Mount \| null>`   | Gets a mount by ID             |
| `getMountByName` | `(db, name) → Result<Mount \| null>` | Gets a mount by name           |
| `removeMount`    | `(db, id) → Result<boolean>`         | Removes a mount                |

### Sources

| Function          | Signature                            | Description                                           |
| ----------------- | ------------------------------------ | ----------------------------------------------------- |
| `registerSource`  | `(db, params) → Result<Source>`      | Registers an ingested source with content hash        |
| `getSource`       | `(db, id) → Result<Source \| null>`  | Gets a source by ID                                   |
| `listSources`     | `(db, mountId?) → Result<Source[]>`  | Lists sources, optionally filtered by mount           |
| `isSourceChanged` | `(db, path, hash) → Result<boolean>` | Checks if a source file has changed since last ingest |
| `computeFileHash` | `(filePath) → Result<string>`        | Computes SHA-256 hex digest of a file                 |

### Provenance

| Function           | Signature                                               | Description                                        |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------- |
| `recordProvenance` | `(db, wsPath, params) → Result<ProvenanceRecord>`       | Records a source→output derivation                 |
| `getProvenance`    | `(db, wsPath, outputPath) → Result<ProvenanceRecord[]>` | Forward lookup: what sources produced this output? |
| `getDerivations`   | `(db, wsPath, sourceId) → Result<ProvenanceRecord[]>`   | Reverse lookup: what was derived from this source? |

### Traces

| Function     | Signature                                                         | Description                                       |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------- |
| `writeTrace` | `(db, wsPath, eventType, payload, opts?) → Result<TraceEnvelope>` | Writes a trace event (JSONL + SQLite + audit log) |
| `readTraces` | `(db, filters?) → Result<TraceRecord[]>`                          | Queries trace events with optional filters        |

### Tasks

| Function         | Signature                                           | Description                                |
| ---------------- | --------------------------------------------------- | ------------------------------------------ |
| `createTask`     | `(db, wsPath, brief) → Result<TaskRecord>`          | Creates an episodic research task          |
| `transitionTask` | `(db, wsPath, taskId, status) → Result<TaskRecord>` | Advances task through lifecycle states     |
| `getTask`        | `(db, taskId) → Result<TaskRecord \| null>`         | Gets a task by ID                          |
| `listTasks`      | `(db, status?) → Result<TaskRecord[]>`              | Lists tasks, optionally filtered by status |

### Wiki

| Function           | Signature                   | Description                                           |
| ------------------ | --------------------------- | ----------------------------------------------------- |
| `rebuildWikiIndex` | `(wsPath) → Result<number>` | Rebuilds wiki/index.md from compiled page frontmatter |

### Audit

| Function         | Signature                                     | Description                   |
| ---------------- | --------------------------------------------- | ----------------------------- |
| `appendAuditLog` | `(wsPath, operation, summary) → Result<void>` | Appends a row to audit/log.md |

### Configuration

| Function        | Signature                         | Description                              |
| --------------- | --------------------------------- | ---------------------------------------- |
| `loadConfig`    | `(cwd?) → IcoConfig`              | Loads config from env vars and .env file |
| `redactSecrets` | `(obj) → Record<string, unknown>` | Strips sensitive values from an object   |
| `createLogger`  | `(level?) → Logger`               | Creates a structured logger instance     |

### Types

| Type                   | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `WorkspaceInfo`        | Workspace metadata (name, root, dbPath, createdAt)        |
| `Database`             | better-sqlite3 database instance                          |
| `IcoConfig`            | Configuration object (workspace, model, logLevel, apiKey) |
| `RegisterSourceParams` | Parameters for `registerSource`                           |
| `ProvenanceRecord`     | Source-to-output derivation record                        |
| `TraceRecord`          | Trace event index record                                  |
| `TaskRecord`           | Task lifecycle record                                     |

## Error Handling

All functions return `Result<T, Error>` — never throw. Callers check `.ok` before using `.value`.

## Test Coverage

146 tests across 13 test files, including 18 integration tests covering the full kernel flow.
