/**
 * Tests for the `ico inspect` command (traces and audit subcommands).
 *
 * Strategy: create a real ICO workspace in a temp directory, seed it with
 * trace events and audit log entries, then invoke each subcommand through a
 * fresh Commander program per invocation (no option bleed between runs).
 *
 * The Commander action itself drives all side-effects; we capture stdout /
 * stderr via spies and assert on the captured output.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, type Database, initDatabase, initWorkspace, writeTrace } from '@ico/kernel';

import { buildTraceRows, parseAuditLog } from './inspect.js';
import { register } from './inspect.js';

// ---------------------------------------------------------------------------
// Test-harness helpers
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Strip ANSI escape sequences for plain-text assertions. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Invoke `ico inspect <subcommand> [...args]` in an isolated Commander context.
 *
 * `workspacePath` is injected as the `--workspace` global option so commands
 * resolve the correct workspace without affecting the process cwd.
 */
function runInspect(workspacePath: string, args: string[], jsonMode = false): RunResult {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;

  const program = new Command();
  program
    .name('ico')
    .option('--workspace <path>', 'Workspace directory')
    .option('--verbose', 'Show debug output')
    .option('--quiet', 'Suppress non-essential output')
    .option('--json', 'Output as JSON')
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        stdout += str;
      },
      writeErr: (str) => {
        stderr += str;
      },
    });

  program.setOptionValue('workspace', workspacePath);
  if (jsonMode) {
    program.setOptionValue('json', true);
  }

  register(program);

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...msgs: unknown[]) => {
    stdout += msgs.join(' ') + '\n';
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...msgs: unknown[]) => {
    stderr += msgs.join(' ') + '\n';
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    exitCode = typeof code === 'number' ? code : 1;
    throw new Error(`process.exit(${exitCode})`);
  });

  try {
    program.parse(['node', 'ico', 'inspect', ...args]);
  } catch (e) {
    if (e instanceof Error && !e.message.startsWith('process.exit')) {
      throw e;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('ico inspect command', () => {
  let tempBase: string;
  let workspaceRoot: string;
  let db: Database;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'ico-cli-inspect-'));

    const wsResult = initWorkspace('ws', tempBase);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    workspaceRoot = wsResult.value.root;

    const dbResult = initDatabase(wsResult.value.dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    db = dbResult.value;
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tempBase, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // parseAuditLog — pure-function unit tests
  // -------------------------------------------------------------------------

  describe('parseAuditLog', () => {
    it('returns an empty array for a file with only header rows', () => {
      const content = [
        '# ICO Audit Log',
        '',
        '| Timestamp | Operation | Summary |',
        '|-----------|-----------|---------|',
        '',
      ].join('\n');
      expect(parseAuditLog(content)).toEqual([]);
    });

    it('parses data rows and skips header/separator', () => {
      const content = [
        '# ICO Audit Log',
        '',
        '| Timestamp | Operation | Summary |',
        '|-----------|-----------|---------|',
        '| 2026-04-06T10:00:00.000Z | workspace.init | Workspace initialized |',
        '| 2026-04-06T11:00:00.000Z | source.ingest | Ingested a.pdf |',
        '',
      ].join('\n');
      const entries = parseAuditLog(content);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        timestamp: '2026-04-06T10:00:00.000Z',
        operation: 'workspace.init',
        summary: 'Workspace initialized',
      });
      expect(entries[1]).toEqual({
        timestamp: '2026-04-06T11:00:00.000Z',
        operation: 'source.ingest',
        summary: 'Ingested a.pdf',
      });
    });

    it('skips lines that are not table rows', () => {
      const content = [
        '# ICO Audit Log',
        'Some prose text.',
        '',
        '| Timestamp | Operation | Summary |',
        '|-----------|-----------|---------|',
        '| 2026-04-06T10:00:00.000Z | task.create | Created task |',
        '',
      ].join('\n');
      const entries = parseAuditLog(content);
      expect(entries).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // buildTraceRows — pure-function unit tests
  // -------------------------------------------------------------------------

  describe('buildTraceRows', () => {
    it('maps TraceRecord fields into the expected column order', () => {
      const record = {
        id: 'abc-123',
        event_type: 'source.ingest',
        correlation_id: null,
        timestamp: '2026-04-06T10:00:00.000Z',
        file_path: 'audit/traces/2026-04-06.jsonl',
        line_offset: 0,
        summary: 'Ingested doc',
      };
      const rows = buildTraceRows([record]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual([
        '2026-04-06T10:00:00.000Z',
        'source.ingest',
        'Ingested doc',
        'abc-123',
      ]);
    });

    it('replaces null summary with an empty string', () => {
      const record = {
        id: 'def-456',
        event_type: 'task.create',
        correlation_id: null,
        timestamp: '2026-04-06T12:00:00.000Z',
        file_path: 'audit/traces/2026-04-06.jsonl',
        line_offset: 100,
        summary: null,
      };
      const rows = buildTraceRows([record]);
      expect(rows[0]![2]).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // inspect traces — integration tests
  // -------------------------------------------------------------------------

  describe('inspect traces', () => {
    it('prints "No trace events found." on an empty workspace', () => {
      const result = runInspect(workspaceRoot, ['traces']);
      expect(result.exitCode).toBeNull();
      const plain = stripAnsi(result.stdout);
      expect(plain).toContain('No trace events found.');
    });

    it('shows trace events in table format', () => {
      writeTrace(
        db,
        workspaceRoot,
        'source.ingest',
        { path: 'a.pdf' },
        { summary: 'Ingested a.pdf' },
      );
      writeTrace(db, workspaceRoot, 'task.create', { taskId: 'x' }, { summary: 'Task created' });

      const result = runInspect(workspaceRoot, ['traces']);
      expect(result.exitCode).toBeNull();

      const plain = stripAnsi(result.stdout);
      expect(plain).toContain('Timestamp');
      expect(plain).toContain('Type');
      expect(plain).toContain('source.ingest');
      expect(plain).toContain('task.create');
      expect(plain).toContain('Ingested a.pdf');
      expect(plain).toContain('Task created');
    });

    it('filters by --type', () => {
      writeTrace(
        db,
        workspaceRoot,
        'source.ingest',
        { path: 'a.pdf' },
        { summary: 'Ingested a.pdf' },
      );
      writeTrace(db, workspaceRoot, 'task.create', { taskId: 'x' }, { summary: 'Task created' });

      const result = runInspect(workspaceRoot, ['traces', '--type', 'source.ingest']);
      expect(result.exitCode).toBeNull();

      const plain = stripAnsi(result.stdout);
      expect(plain).toContain('source.ingest');
      expect(plain).toContain('Ingested a.pdf');
      expect(plain).not.toContain('task.create');
      expect(plain).not.toContain('Task created');
    });

    it('outputs a valid JSON array with --json', () => {
      writeTrace(
        db,
        workspaceRoot,
        'source.ingest',
        { path: 'b.pdf' },
        { summary: 'Ingested b.pdf' },
      );

      const result = runInspect(workspaceRoot, ['traces'], /* jsonMode */ true);
      expect(result.exitCode).toBeNull();

      const parsed = JSON.parse(result.stdout.trim()) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(1);

      const entry = parsed[0] as Record<string, unknown>;
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('event_type');
      expect(entry).toHaveProperty('timestamp');
    });

    it('respects --last to cap the number of returned rows', () => {
      // Write 5 events
      for (let i = 0; i < 5; i++) {
        writeTrace(db, workspaceRoot, 'source.ingest', { path: `file-${i}.pdf` });
      }

      // Ask for only 2
      const result = runInspect(workspaceRoot, ['traces', '--last', '2'], true);
      expect(result.exitCode).toBeNull();

      const parsed = JSON.parse(result.stdout.trim()) as unknown[];
      expect(parsed).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // inspect audit — integration tests
  // -------------------------------------------------------------------------

  describe('inspect audit', () => {
    it('shows audit log entries from an initialized workspace', () => {
      // initWorkspace seeds one workspace.init row
      const result = runInspect(workspaceRoot, ['audit']);
      expect(result.exitCode).toBeNull();

      const plain = stripAnsi(result.stdout);
      expect(plain).toContain('Audit Log');
      expect(plain).toContain('workspace.init');
    });

    it('limits output with --last', () => {
      // Seed extra trace events (writeTrace also appends to audit/log.md)
      for (let i = 0; i < 5; i++) {
        writeTrace(db, workspaceRoot, 'source.ingest', { path: `x${i}.pdf` });
      }

      // Total rows: 1 (workspace.init) + 5 (source.ingest) = 6; ask for 2
      const result = runInspect(workspaceRoot, ['audit', '--last', '2'], true);
      expect(result.exitCode).toBeNull();

      const parsed = JSON.parse(result.stdout.trim()) as unknown[];
      expect(parsed).toHaveLength(2);
    });

    it('outputs a valid JSON array with --json', () => {
      const result = runInspect(workspaceRoot, ['audit'], /* jsonMode */ true);
      expect(result.exitCode).toBeNull();

      const parsed = JSON.parse(result.stdout.trim()) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(1);

      const entry = parsed[0] as Record<string, unknown>;
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('operation');
      expect(entry).toHaveProperty('summary');
    });

    it('outputs table with Timestamp / Operation / Summary columns', () => {
      const result = runInspect(workspaceRoot, ['audit']);
      expect(result.exitCode).toBeNull();

      const plain = stripAnsi(result.stdout);
      expect(plain).toContain('Timestamp');
      expect(plain).toContain('Operation');
      expect(plain).toContain('Summary');
    });

    it('exits with error when audit log does not exist', () => {
      // Point workspace at a directory that has no audit/log.md
      const result = runInspect(tempBase, ['audit']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/audit log not found/i);
    });
  });
});
