import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendAuditLog } from './audit-log.js';

const INITIAL_LOG = [
  '# ICO Audit Log',
  '',
  '| Timestamp | Operation | Summary |',
  '|-----------|-----------|---------|',
  '| 2026-01-01T00:00:00.000Z | workspace.init | Workspace "test" initialized |',
  '',
].join('\n');

function createTmpWorkspace(): string {
  const dir = resolve(
    tmpdir(),
    `ico-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(resolve(dir, 'audit'), { recursive: true });
  writeFileSync(resolve(dir, 'audit', 'log.md'), INITIAL_LOG, 'utf-8');
  return dir;
}

describe('appendAuditLog', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = createTmpWorkspace();
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('appends a new row and the file contains it in the correct format', () => {
    const result = appendAuditLog(
      workspacePath,
      'ingest.start',
      'Ingestion started for article.md',
    );

    expect(result.ok).toBe(true);

    const contents = readFileSync(resolve(workspacePath, 'audit', 'log.md'), 'utf-8');
    const rows = contents.split('\n').filter((line) => line.startsWith('|'));

    // Header row + separator row + seeded row + new row = 4
    expect(rows).toHaveLength(4);

    const newRow = rows[3];
    expect(newRow).toMatch(
      /^\| \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| ingest\.start \| Ingestion started for article\.md \|$/,
    );
  });

  it('multiple entries appear in chronological order', () => {
    appendAuditLog(workspacePath, 'ingest.start', 'First operation');
    appendAuditLog(workspacePath, 'ingest.end', 'Second operation');

    const contents = readFileSync(resolve(workspacePath, 'audit', 'log.md'), 'utf-8');
    const dataRows = contents
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('|') && !line.startsWith('| Timestamp') && !line.startsWith('|---'),
      );

    expect(dataRows).toHaveLength(3);
    expect(dataRows[1]).toContain('ingest.start');
    expect(dataRows[2]).toContain('ingest.end');

    const ts1 = dataRows[1]!.split('|')[1]!.trim();
    const ts2 = dataRows[2]!.split('|')[1]!.trim();
    expect(new Date(ts1).getTime()).toBeLessThanOrEqual(new Date(ts2).getTime());
  });

  it('returns an error when audit/log.md does not exist', () => {
    rmSync(resolve(workspacePath, 'audit', 'log.md'));

    const result = appendAuditLog(workspacePath, 'any.op', 'summary');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toMatch(/not found/i);
    }
  });

  it('row matches the expected pipe-delimited table format', () => {
    appendAuditLog(workspacePath, 'compile.pass', 'Compile pass 1 complete');

    const contents = readFileSync(resolve(workspacePath, 'audit', 'log.md'), 'utf-8');
    const lastRow = contents.trimEnd().split('\n').at(-1) ?? '';

    // Must start and end with a pipe
    expect(lastRow).toMatch(/^\|.*\|$/);

    const cells = lastRow
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    expect(cells).toHaveLength(3);

    const [timestamp, operation, summary] = cells;
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(operation).toBe('compile.pass');
    expect(summary).toBe('Compile pass 1 complete');
  });
});
