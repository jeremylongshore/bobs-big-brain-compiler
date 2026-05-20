# Epic 3: Kernel Core — Workspace, State, Mounts, and Provenance

**Objective:** Build the deterministic substrate. After this epic, the system can initialize workspaces, manage SQLite state, register mounts, track provenance, and enforce lifecycle rules. No AI calls yet — purely the deterministic side of the boundary.

**Why it exists:** The deterministic control plane is the most important architectural constraint. Every operation that touches durable state (files, database, audit logs) must go through the kernel. Without a solid kernel, the compiler and CLI have nothing to build on.

**What it unlocks:** Epics 4-10 (CLI, ingest, compiler, and everything above)

**Dependencies:** Epic 2

**Phase:** 1

---

## Scope

### Included

- Workspace initialization (full directory tree creation)
- SQLite database initialization and migration runner
- Mount registry (register, list, get, remove)
- Source registry with content hashing and change detection
- Provenance tracking (dual-write: SQLite + JSONL)
- Trace event writer (JSONL + SQLite + audit log.md)
- Task state machine with lifecycle enforcement
- Wiki index rebuilder (deterministic, no AI)
- Audit log writer (human-readable log.md)
- Integration test suite for full kernel flow
- API surface review and barrel export

### Excluded

- CLI command implementations (Epic 4)
- Ingest adapters (Epic 5)
- Any AI/Claude API calls (Epic 6+)

---

## Beads

### E3-B01: Workspace Initialization (ico init)

- **Depends on:** E2-B02, E1-B04
- **Produces:** `packages/kernel/src/workspace.ts` with `initWorkspace()`. Creates full directory tree: raw/{articles,papers,repos,notes}, wiki/{index.md,sources,concepts,entities,topics,contradictions,open-questions,indexes}, tasks/, outputs/{reports,slides,charts,briefings}, recall/{cards,decks,quizzes,retention}, audit/{log.md,traces,provenance,policy,promotions}
- **Verification:** All 25+ directories created. index.md and log.md have valid markdown. Idempotent (no data destruction on re-init).

### E3-B02: SQLite Database Initialization and Migrations

- **Depends on:** E2-B02, E1-B02
- **Produces:** `packages/kernel/src/state.ts`, `packages/kernel/migrations/001-init.sql`. All tables: sources, mounts, compilations, tasks, promotions, recall_results, traces. Migration runner tracks applied migrations. Database opens with `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000` for concurrent access safety (audit C7/L2). Migration runner implements rollback on failure — if any migration statement fails, the entire migration is rolled back and the database remains at the prior version. Task status column must support all 7 states per E1-B02: created, collecting, synthesizing, critiquing, rendering, completed, archived.
- **Verification:** All tables exist with correct columns. Running init twice doesn't duplicate. Migration runner works. `PRAGMA journal_mode` returns 'wal'. `PRAGMA busy_timeout` returns 5000. Failed migration leaves database unchanged. Task status CHECK constraint rejects invalid states.

### E3-B03: Mount Registry (ico mount)

- **Depends on:** E3-B02
- **Produces:** `packages/kernel/src/mounts.ts` with registerMount, listMounts, getMount, removeMount. Mount types: 'local-dir', 'single-file'.
- **Verification:** Full CRUD cycle works. Nonexistent path returns error. Duplicate names rejected.

### E3-B04: Source Registry and Content Hashing

- **Depends on:** E3-B02, E3-B03
- **Produces:** `packages/kernel/src/sources.ts` with registerSource (SHA-256), getSource, listSources, isSourceChanged
- **Verification:** Hash computed on register. isSourceChanged detects modifications. Duplicate (same hash) returns existing record.

### E3-B05: Provenance Tracking

- **Depends on:** E3-B02, E3-B04
- **Produces:** `packages/kernel/src/provenance.ts` with recordProvenance, getProvenance, getDerivations. Dual-write to SQLite + JSONL.
- **Verification:** Record chain (source → summary → topic), query back to original. JSONL file exists. Both forward and reverse lookups work.

### E3-B06: Trace Event Writer

- **Depends on:** E3-B01, E3-B02, E1-B03
- **Produces:** `packages/kernel/src/traces.ts` with writeTrace, readTraces. Writes to JSONL + SQLite + log.md. Apply secret deny-list to every trace payload before writing — run `redactSecrets()` (from E2-B11) on the payload object so API keys, tokens, and credentials never appear in trace files (audit C2). Implement `prev_hash` integrity chain per E1-B03: each trace event includes SHA-256 hash of the previous event, enabling tamper detection across the JSONL file (audit H4).
- **Verification:** Write event, read back with filters. JSONL valid. log.md has new line. Envelope format matches schema. Trace payload containing an API key has it replaced with '[REDACTED]'. Each JSONL line's prev_hash matches SHA-256 of the preceding line. First event has prev_hash of null/genesis.

### E3-B07: Task State Machine

- **Depends on:** E3-B01, E3-B02, E3-B06
- **Produces:** `packages/kernel/src/tasks.ts` with createTask, transitionTask, getTask, listTasks. Lifecycle: created → collecting → synthesizing → critiquing → rendering → completed → archived.
- **Verification:** Directory structure created. All valid transitions work. Invalid transitions rejected. Each transition emits trace.

### E3-B08: Wiki Index Rebuilder

- **Depends on:** E3-B01, E1-B01
- **Produces:** `packages/kernel/src/wiki-index.ts` with rebuildWikiIndex. Scans compiled pages, regenerates wiki/index.md as categorized TOC. Use atomic write pattern (write to index.md.tmp, then rename to index.md) to prevent partial/corrupted index.md if the process crashes mid-write (audit M9).
- **Verification:** Fixture with 3 pages → index lists all 3. Add a page → re-run → new page appears. No .tmp file remains after successful rebuild. Simulated crash during write does not corrupt existing index.md.

### E3-B09: Audit Log Writer

- **Depends on:** E3-B01
- **Produces:** `packages/kernel/src/audit-log.ts` with appendAuditLog. Format: `| YYYY-MM-DD HH:mm:ss | OPERATION_TYPE | one-line summary |`
- **Verification:** 3 entries appear chronologically. Correct format. No corruption on concurrent appends.

### E3-B10: Kernel Integration Test Suite

- **Depends on:** E3-B01 through E3-B09
- **Produces:** `packages/kernel/src/__tests__/integration.test.ts` — full kernel flow: init → db → mount → source → provenance → trace → task → transition → rebuild index. Add corruption recovery scenarios: corrupted SQLite file (detect and report, not silently fail), missing wiki files with existing database records (detect orphans), partially applied migration (verify rollback left DB clean) (audit H9). Add concurrent access test: two processes opening the same workspace simultaneously — must either succeed via WAL mode or produce a clean 'workspace locked' error (audit C7).
- **Verification:** Passes end-to-end. Exercises every module. Temp workspace created and cleaned up. Corrupted SQLite produces actionable error message. Orphaned records detected and reported. Concurrent access test passes without data corruption.

### E3-B11: Kernel Package Barrel Export and API Surface Review

- **Depends on:** E3-B01 through E3-B10
- **Produces:** Clean `packages/kernel/src/index.ts` barrel export. `packages/kernel/README.md` with all public functions.
- **Verification:** Barrel compiles. Other packages can import all needed functions. No internal types leak.

---

## Exit Criteria

1. `initWorkspace()` creates complete directory tree with all subdirectories, index.md, and log.md
2. SQLite database initializes with all tables and migration tracking
3. Mounts can be registered, listed, and removed
4. Sources registered with content hashing and change detection
5. Provenance tracked in both SQLite and JSONL
6. Trace events written in correct envelope format
7. Task state machine enforces valid lifecycle transitions
8. Wiki index rebuilds from compiled page frontmatter
9. Audit log.md maintained as human-readable digest
10. Integration test covers full kernel flow
11. SQLite uses WAL mode with busy timeout. Concurrent access either succeeds (WAL) or produces clean 'workspace locked' error.

---

## Risks / Watch Items

- **better-sqlite3 native module:** may cause CI/platform issues. Mitigation: test in CI early.
- **File system operations:** need error handling for permissions, disk space. Mitigation: wrap all fs ops in try/catch.
- **Task state machine strictness:** any bug corrupts workflow integrity. Mitigation: exhaustive test coverage of all valid and invalid transitions.
