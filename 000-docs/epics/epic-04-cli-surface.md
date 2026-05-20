# Epic 4: CLI Surface and Operator Workflow

**Objective:** Make the system operable through a serious CLI. After this epic, the operator can run `ico init`, `ico mount`, `ico ingest`, `ico status`, and see real output.

**Why it exists:** The CLI is the primary user interface. Without proper command routing, error handling, output formatting, and workspace discovery, the kernel is usable only as a library. Operators need a polished CLI to interact with the system.

**What it unlocks:** Epics 5-10 (all user-facing functionality)

**Dependencies:** Epics 2 and 3

**Phase:** 1

---

## Scope

### Included

- Command router with all planned commands registered (stubs for unimplemented)
- ico init, ico mount, ico ingest (deterministic layer only), ico status
- Terminal output formatting (tables, colors, JSON mode)
- Error handling with user-friendly messages and resolution suggestions
- Workspace discovery from subdirectories
- CLI integration test suite
- Help text and documentation

### Excluded

- AI-powered ingest (Epic 5+)
- Compile, ask, research, render, promote commands (Epics 6-9)
- Eval commands (Epic 10)

---

## Beads

### E4-B01: CLI Framework and Command Router

- **Depends on:** E2-B03, E3-B01
- **Produces:** `packages/cli/src/index.ts` with full command routing. All planned commands registered: init, ingest, mount, compile, ask, research, render, lint, recall, promote, status, eval. Unimplemented commands show which epic implements them. Global options: --workspace, --verbose, --quiet, --json.
- **Verification:** `ico --help` shows all commands. `ico compile --help` shows "Not yet implemented (Epic 6)". Global options parse correctly.

### E4-B02: ico init Command

- **Depends on:** E4-B01, E3-B01, E3-B02
- **Produces:** `packages/cli/src/commands/init.ts`. Calls initWorkspace() and initDatabase(). Creates directory tree, SQLite, initial index.md/log.md, .env.example.
- **Verification:** `ico init test-workspace` creates tree. Existing workspace warns without data destruction. Output shows created directories.

### E4-B03: ico mount Command

- **Depends on:** E4-B01, E3-B03
- **Produces:** `packages/cli/src/commands/mount.ts` with mount/list/remove subcommands.
- **Verification:** Mount a directory, list mounts, remove. Error on nonexistent path. Error on duplicate name.

### E4-B04: ico ingest Command (Deterministic Layer)

- **Depends on:** E4-B01, E3-B04, E3-B05, E3-B06
- **Produces:** `packages/cli/src/commands/ingest.ts`. Copies file to workspace/raw/, registers source in SQLite with hash, records provenance, writes trace, appends audit log. No AI summarization yet.
- **Verification:** File appears in workspace/raw/. Source record in SQLite. Provenance recorded. Trace written. Re-ingest same hash is no-op.

### E4-B05: ico status Command

- **Depends on:** E4-B01, E3-B02, E3-B01
- **Produces:** `packages/cli/src/commands/status.ts`. Shows: source counts by type, compiled page counts, task counts by status, mount count, last operation timestamp. Supports --json.
- **Verification:** Fresh workspace: "0 sources, 0 compiled". After ingesting 3 files: "3 sources". JSON matches text data.

### E4-B06: Terminal Output Formatting Library

- **Depends on:** E2-B03
- **Produces:** `packages/cli/src/lib/output.ts` with formatTable, formatSuccess/Error/Warning, formatProgress, formatJSON. Uses chalk for colors.
- **Verification:** Tables render aligned. Colors suppressed when not TTY. JSON mode outputs valid JSON.

### E4-B07: Error Handling and User-Friendly Messages

- **Depends on:** E4-B01, E4-B06, E2-B12
- **Produces:** `packages/cli/src/lib/errors.ts` with ConfigError, FileError, DatabaseError, ValidationError. Each has distinct message and resolution suggestion.
- **Verification:** Missing workspace shows "Run 'ico init' first". Missing API key shows "Set ANTHROPIC_API_KEY". Stack traces only in verbose mode.

### E4-B08: Workspace Discovery and Resolution

- **Depends on:** E4-B01, E2-B11
- **Produces:** `packages/cli/src/lib/workspace-resolver.ts`. Priority: --workspace flag > ICO_WORKSPACE env > upward directory discovery > error.
- **Verification:** From subdirectory finds workspace. Flag overrides. Env overrides. No workspace gives clear error.

### E4-B09: CLI Integration Test Suite

- **Depends on:** E4-B02 through E4-B08
- **Produces:** `packages/cli/src/__tests__/integration.test.ts`. Tests init, mount, ingest, status, mount list, mount remove via subprocess execution.
- **Verification:** All tests pass. Real file system operations in temp directories. Tests clean up.

### E4-B10: CLI Help Text and Man-Page Quality Documentation

- **Depends on:** E4-B01 through E4-B09
- **Produces:** Polished help text for all commands. `ico help` overview with operating loop diagram.
- **Verification:** Every command's --help has description, arguments, options, and 1+ example. Consistent terminology.

### E4-B11: Trace and Audit Inspection Commands

- **Depends on:** E4-B01, E3-B06, E3-B09
- **Produces:** `packages/cli/src/commands/inspect.ts` with two subcommands: `ico inspect traces [--type TYPE] [--last N]` for viewing trace events and `ico inspect audit [--last N]` for viewing audit log entries from the CLI without manually reading JSONL files (audit M16). Supports --json output mode.
- **Verification:** `ico inspect traces --last 5` shows 5 most recent trace events. `ico inspect traces --type compilation` filters by type. `ico inspect audit --last 10` shows last 10 audit entries. --json produces valid JSON array. Empty workspace shows "No trace events found."

---

## Exit Criteria

1. `ico init`, `ico mount`, `ico ingest`, `ico status` work end-to-end
2. All planned commands registered (unimplemented show which epic implements them)
3. Terminal output formatted, colored, and supports --json mode
4. Error messages user-friendly with resolution suggestions
5. Workspace discovery works from subdirectories
6. CLI integration tests pass
7. Help text complete and consistent
8. Trace and audit events can be inspected from CLI

---

## Risks / Watch Items

- **Commander.js subcommand nesting** needs careful design. Mitigation: prototype command tree in E4-B01.
- **Child process testing** can be flaky. Mitigation: generous timeouts.
- **Workspace discovery traversal** could be slow on deep trees. Mitigation: limit to 10 levels.
