/**
 * `ico inspect` — inspect trace events and audit log entries.
 *
 * Subcommands:
 *   ico inspect traces [--type TYPE] [--last N] [--correlation-id ID]
 *   ico inspect audit  [--last N]
 *
 * Both subcommands support `--json` (inherited from the root program) for
 * machine-readable output.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import type { TraceRecord } from '@ico/kernel';
import {
  closeDatabase,
  computeMemoryMap,
  computeTaskStatus,
  getTask,
  initDatabase,
  readTraces,
  renderMemoryMapMarkdown,
  renderTaskStatusMarkdown,
} from '@ico/kernel';

import { formatError, formatHeader, formatInfo, formatJSON, formatTable } from '../lib/output.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A single parsed row from the `audit/log.md` markdown table. */
interface AuditEntry {
  timestamp: string;
  operation: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/**
 * Derive the path to `state.db` from the `--workspace` global option or the
 * current working directory.
 */
function resolveWorkspaceDb(globalOpts: { workspace?: string }): string {
  const wsPath = globalOpts.workspace ?? '.';
  return resolve(wsPath, '.ico', 'state.db');
}

/**
 * Derive the workspace root from the `--workspace` global option or cwd.
 */
function resolveWorkspaceRoot(globalOpts: { workspace?: string }): string {
  const wsPath = globalOpts.workspace ?? '.';
  return resolve(wsPath);
}

// ---------------------------------------------------------------------------
// Audit log parsing
// ---------------------------------------------------------------------------

/**
 * Parse the Markdown table rows from `audit/log.md`.
 *
 * The file has this structure:
 *   # ICO Audit Log
 *
 *   | Timestamp | Operation | Summary |
 *   |-----------|-----------|---------|
 *   | <ts> | <op> | <summary> |
 *
 * Only data rows (not the header or separator row) are returned.
 * Rows with fewer than 3 pipe-delimited cells are silently skipped.
 */
export function parseAuditLog(content: string): AuditEntry[] {
  const entries: AuditEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Must start and end with a pipe to be a table row
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;

    // Split on | and strip surrounding whitespace from each cell
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());

    if (cells.length < 3) continue;

    const [timestamp, operation, summary] = cells as [string, string, string];

    // Skip the header row (cell values match column names exactly)
    if (timestamp === 'Timestamp' && operation === 'Operation') continue;

    // Skip the separator row (cells contain only dashes)
    if (/^[-]+$/.test(timestamp)) continue;

    entries.push({ timestamp, operation, summary });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Subcommand: traces
// ---------------------------------------------------------------------------

/**
 * Build table rows from a `TraceRecord[]` array.
 * Columns: Timestamp | Type | Summary | ID
 */
export function buildTraceRows(records: TraceRecord[]): string[][] {
  return records.map((r) => [r.timestamp, r.event_type, r.summary ?? '', r.id]);
}

/**
 * Handle `ico inspect traces`.
 *
 * Reads trace records from SQLite with optional filters and renders them as
 * a table (or JSON when the global `--json` flag is set).
 */
function handleTraces(
  opts: { type?: string; last: string; correlationId?: string },
  globalOpts: { workspace?: string; json?: boolean },
): void {
  const dbPath = resolveWorkspaceDb(globalOpts);
  const dbResult = initDatabase(dbPath);

  if (!dbResult.ok) {
    console.error(formatError(`Failed to open database: ${dbResult.error.message}`));
    process.exit(1);
  }

  const db = dbResult.value;

  try {
    const limit = parseInt(opts.last, 10);
    const filters = {
      ...(opts.type !== undefined ? { eventType: opts.type } : {}),
      ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
      limit: Number.isFinite(limit) ? limit : 20,
    };

    const result = readTraces(db, filters);

    if (!result.ok) {
      console.error(formatError(`Failed to read traces: ${result.error.message}`));
      process.exit(1);
    }

    const records = result.value;

    if (globalOpts.json === true) {
      console.log(formatJSON(records));
      return;
    }

    if (records.length === 0) {
      console.log(formatInfo('No trace events found.'));
      return;
    }

    console.log(formatHeader('Trace Events'));
    console.log('');
    const rows = buildTraceRows(records);
    console.log(formatTable(['Timestamp', 'Type', 'Summary', 'ID'], rows));
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: audit
// ---------------------------------------------------------------------------

/**
 * Handle `ico inspect audit`.
 *
 * Reads `audit/log.md` from the workspace root, parses the markdown table,
 * and renders the last N entries as a table (or JSON array).
 */
function handleAudit(
  opts: { last: string },
  globalOpts: { workspace?: string; json?: boolean },
): void {
  const workspaceRoot = resolveWorkspaceRoot(globalOpts);
  const logPath = join(workspaceRoot, 'audit', 'log.md');

  let content: string;
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch {
    console.error(formatError(`Audit log not found at ${logPath}. Is the workspace initialized?`));
    process.exit(1);
    return; // unreachable, but satisfies type-checker after the exit mock
  }

  const allEntries = parseAuditLog(content);

  const limit = parseInt(opts.last, 10);
  const n = Number.isFinite(limit) ? limit : 20;
  const entries = allEntries.slice(-n);

  if (globalOpts.json === true) {
    console.log(formatJSON(entries));
    return;
  }

  if (entries.length === 0) {
    console.log(formatInfo('No audit log entries found.'));
    return;
  }

  console.log(formatHeader('Audit Log'));
  console.log('');
  const rows = entries.map((e) => [e.timestamp, e.operation, e.summary]);
  console.log(formatTable(['Timestamp', 'Operation', 'Summary'], rows));
}

// ---------------------------------------------------------------------------
// Subcommand: task (cognitive procfs)
// ---------------------------------------------------------------------------

/**
 * Handle `ico inspect task <id> [--proc <view>]`.
 *
 * Computes and displays cognitive procfs views for a task.
 * Available views: `status` (default), `memory-map`.
 */
function handleTask(
  taskId: string,
  opts: { proc: string },
  globalOpts: { workspace?: string; json?: boolean },
): void {
  const dbPath = resolveWorkspaceDb(globalOpts);
  const workspaceRoot = resolveWorkspaceRoot(globalOpts);
  const dbResult = initDatabase(dbPath);

  if (!dbResult.ok) {
    console.error(formatError(`Failed to open database: ${dbResult.error.message}`));
    process.exit(1);
  }

  const db = dbResult.value;

  try {
    const view = opts.proc;

    if (view === 'status') {
      const result = computeTaskStatus(db, workspaceRoot, taskId);
      if (!result.ok) {
        console.error(formatError(result.error.message));
        process.exit(1);
      }

      if (globalOpts.json === true) {
        console.log(formatJSON(result.value));
      } else {
        console.log(renderTaskStatusMarkdown(result.value));
      }
    } else if (view === 'memory-map') {
      // Use getTask directly — cheaper than computing full status.
      const taskResult = getTask(db, taskId);
      if (!taskResult.ok) {
        console.error(formatError(taskResult.error.message));
        process.exit(1);
      }
      if (taskResult.value === null) {
        console.error(formatError(`Task not found: ${taskId}`));
        process.exit(1);
      }

      const taskRelPath = taskResult.value.workspace_path;
      const mmResult = computeMemoryMap(workspaceRoot, taskRelPath);
      if (!mmResult.ok) {
        console.error(formatError(mmResult.error.message));
        process.exit(1);
      }

      if (globalOpts.json === true) {
        console.log(formatJSON(mmResult.value));
      } else {
        console.log(renderMemoryMapMarkdown(mmResult.value));
      }
    } else {
      console.error(formatError(`Unknown proc view: "${view}". Available: status, memory-map`));
      process.exit(1);
    }
  } finally {
    closeDatabase(db);
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/**
 * Register `ico inspect` and its subcommands onto the root Commander program.
 *
 * @param program - The root Commander Command instance.
 */
export function register(program: Command): void {
  const inspect = program
    .command('inspect')
    .description('Inspect traces, audit logs, and task state');

  inspect
    .command('traces')
    .description('View trace events')
    .option('--type <type>', 'Filter by event type')
    .option('--last <n>', 'Show last N events', '20')
    .option('--correlation-id <id>', 'Filter by correlation ID')
    .action((opts: { type?: string; last: string; correlationId?: string }) => {
      const globalOpts = program.opts<{ workspace?: string; json?: boolean }>();
      handleTraces(opts, globalOpts);
    });

  inspect
    .command('audit')
    .description('View audit log entries')
    .option('--last <n>', 'Show last N entries', '20')
    .action((opts: { last: string }) => {
      const globalOpts = program.opts<{ workspace?: string; json?: boolean }>();
      handleAudit(opts, globalOpts);
    });

  inspect
    .command('task <id>')
    .description('View computed cognitive state for a task (procfs)')
    .option('--proc <view>', 'Computed view to display: status, memory-map', 'status')
    .addHelpText(
      'after',
      '\nExamples:\n  $ ico inspect task <uuid>\n  $ ico inspect task <uuid> --proc memory-map\n  $ ico inspect task <uuid> --proc status --json',
    )
    .action((taskId: string, opts: { proc: string }) => {
      const globalOpts = program.opts<{ workspace?: string; json?: boolean }>();
      handleTask(taskId, opts, globalOpts);
    });
}
