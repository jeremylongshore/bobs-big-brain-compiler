---
title: 'MCP Workspace Server Design — @ico/mcp-workspace'
date: 2026-04-09
status: draft
author: Jeremy Longshore
---

# MCP Workspace Server Design

## Overview

A thin MCP (Model Context Protocol) server that exposes any ICO workspace as a set of MCP resources and tools. Any MCP-compatible client (Claude, GPT, open-source agents) can mount and operate on a cognitive workspace without framework lock-in.

The server is an adapter layer: MCP resource URIs map to kernel file reads, MCP tool calls map to kernel function calls. Zero new business logic.

## Architecture

```
+--------------------------------------------------+
|  Any MCP Client (Claude, GPT, open-source agent)  |
+------------------------+-------------------------+
                         | MCP protocol (JSON-RPC over stdio/SSE)
                         v
+--------------------------------------------------+
|  @ico/mcp-workspace server                        |
|                                                   |
|  Resources (read-only):                           |
|    workspace://wiki/{page}       -> readFileSync() |
|    workspace://tasks/{id}/status -> computeTaskStatus() |
|    workspace://tasks/{id}/memory-map -> computeMemoryMap() |
|    workspace://audit/log         -> readFileSync() |
|    workspace://raw/{source}      -> readFileSync() |
|                                                   |
|  Tools (write):                                   |
|    workspace.research(brief)     -> createTask()  |
|    workspace.ingest(path)        -> runIngest()   |
|    workspace.promote(path, type) -> promoteArtifact() |
|    workspace.transition(id, status) -> transitionTask() |
|                                                   |
|  Prompts:                                         |
|    workspace-status              -> collectStatusData() |
|    task-briefing(id)             -> computeTaskStatus() |
|                                                   |
|  Implementation:                                  |
|    ~300-500 lines of TypeScript                   |
|    Thin adapter over @ico/kernel + @ico/compiler  |
+------------------------+-------------------------+
                         | direct function calls
                         v
+--------------------------------------------------+
|  @ico/kernel (existing)                           |
|  SQLite + workspace filesystem + traces           |
+--------------------------------------------------+
```

## Resources

Resources are read-only views into workspace state. Each resource has a URI template and maps to an existing kernel or filesystem operation.

### `workspace://wiki/{page}`

**Description:** Read a compiled wiki page (markdown with YAML frontmatter).

**Implementation:** `readFileSync(join(wsRoot, 'wiki', ...page.split('/')))` with path traversal guard.

**Response:** Text content of the wiki page.

### `workspace://tasks/{id}/status`

**Description:** Computed cognitive status for a task (\_proc/status.md equivalent).

**Implementation:** `computeTaskStatus(db, wsRoot, id)` -> `renderTaskStatusMarkdown(view)`.

**Response:** Markdown with YAML frontmatter containing phase, brief, age, file counts.

### `workspace://tasks/{id}/memory-map`

**Description:** What evidence/notes/drafts exist in a task workspace.

**Implementation:** `computeMemoryMap(wsRoot, taskRelPath)` -> `renderMemoryMapMarkdown(sections)`.

**Response:** Markdown listing files in each task subdirectory.

### `workspace://audit/log`

**Description:** Human-readable audit trail.

**Implementation:** `readFileSync(join(wsRoot, 'audit', 'log.md'))`.

**Response:** Markdown table of timestamped operations.

### `workspace://raw/{path}`

**Description:** Raw source document.

**Implementation:** `readFileSync(join(wsRoot, 'raw', ...path.split('/')))` with path guard.

**Response:** Text content of the source file.

## Tools

Tools are write operations that modify workspace state. Each maps to an existing kernel function.

### `workspace.research`

**Parameters:** `{ brief: string }`

**Implementation:** `createTask(db, wsRoot, brief)` + write `brief.md` + audit log.

**Returns:** `{ taskId, workspacePath, status }`

### `workspace.ingest`

**Parameters:** `{ path: string, mountName?: string }`

**Implementation:** Existing ingest pipeline from `@ico/compiler`.

**Returns:** `{ sourceId, path, type, wordCount }`

### `workspace.promote`

**Parameters:** `{ sourcePath: string, targetType: 'topic' | 'concept' | 'entity' | 'reference' }`

**Implementation:** `promoteArtifact(db, wsRoot, input)`.

**Returns:** `{ sourcePath, targetPath, promotedAt }`

### `workspace.transition`

**Parameters:** `{ taskId: string, targetStatus: TaskStatus }`

**Implementation:** `transitionTask(db, wsRoot, taskId, targetStatus)` + `materializeStatus()`.

**Returns:** Updated `TaskStatusView`.

## Prompts

MCP prompts provide suggested system prompts for common operations.

### `workspace-status`

Returns a formatted workspace status summary suitable for inclusion in an agent's system prompt.

### `task-briefing`

**Parameters:** `{ taskId: string }`

Returns the computed task status + memory map, formatted as context for an agent working on that task.

## Security Considerations

Per the adversarial review (Askell archetype):

1. **Path traversal:** All resource reads must validate that the resolved path stays within the workspace root. Use `path.resolve()` and check `startsWith(wsRoot)`.

2. **Agent audit scoping:** Agents should only see traces scoped to their task's `correlationId`, not the full audit trail. Use `readTraces(db, { correlationId })`.

3. **Write boundary:** Tools that modify state go through the kernel, which enforces promotion rules, state machine transitions, and audit logging. The MCP server never writes files directly.

4. **Same-process caveat:** The kernel and MCP server run in the same Node.js process. The governance boundary is enforced by code convention, not process isolation. This is adequate for a single-user local tool but should not be framed as a security boundary.

## Implementation Plan

### Package Structure

```
packages/mcp-workspace/
  src/
    index.ts          # MCP server entry point
    resources.ts      # Resource handlers
    tools.ts          # Tool handlers
    prompts.ts        # Prompt templates
    guards.ts         # Path traversal protection
  package.json        # @ico/mcp-workspace
  tsconfig.json
  tsup.config.ts
```

### Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `@ico/kernel` — workspace operations
- `@ico/compiler` — ingest pipeline (for workspace.ingest tool)

### Estimated Effort

~300-500 lines of TypeScript. The kernel already does everything. The MCP server is mapping layer only.

## Open Questions

1. **stdio vs SSE transport?** stdio is simplest for Claude Desktop integration. SSE enables remote access but adds complexity.

2. **Should workspace.compile be a tool?** Compilation invokes Claude API (costs money, takes time). Exposing it as an MCP tool means an agent can trigger compilation autonomously. This may or may not be desirable.

3. **Multi-workspace?** Should one MCP server handle multiple workspaces, or one server per workspace? One-per-workspace is simpler and aligns with the Unix model.

4. **SQLite locking?** The MCP server and CLI would share the same SQLite database. WAL mode allows concurrent reads, but only one writer. If both try to write simultaneously, the second gets `SQLITE_BUSY` after `busy_timeout` (5s). For single-user use this is acceptable.
