/**
 * Tests for the `ico unpromote` command logic.
 *
 * All tests exercise `runUnpromote` directly — no process spawning needed.
 * Filesystem operations are performed against real temporary directories.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@ico/kernel';
import { closeDatabase, initDatabase, initWorkspace } from '@ico/kernel';

import type { UnpromoteCommandGlobal, UnpromoteCommandOptions } from './unpromote.js';
import { runUnpromote } from './unpromote.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workspacePath: string;
let db: Database;

function writeFile(absolutePath: string, content: string): void {
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
}

function promotedContent(
  title = 'My Topic',
  promotedFrom = 'outputs/reports/my-artifact.md',
): string {
  return [
    '---',
    `title: ${title}`,
    'type: topic',
    `promoted_from: ${promotedFrom}`,
    'promoted_at: 2024-01-01T00:00:00.000Z',
    'promoted_by: user',
    '---',
    '',
    '# Body',
    '',
    'Content.',
    '',
  ].join('\n');
}

function insertPromotion(
  targetPath: string,
  sourcePath = 'outputs/reports/my-artifact.md',
  targetType = 'topic',
): void {
  db.prepare(
    `INSERT INTO promotions (id, source_path, target_path, target_type, promoted_at, promoted_by, source_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'promo-test-' + Math.random().toString(36).slice(2),
    sourcePath,
    targetPath,
    targetType,
    new Date().toISOString(),
    'user',
    'sha256:test',
  );
}

function createPromotion(slug = 'my-topic'): { targetPath: string; sourcePath: string } {
  const sourcePath = 'outputs/reports/my-artifact.md';
  const targetPath = `wiki/topics/${slug}.md`;
  writeFile(join(workspacePath, targetPath), promotedContent('My Topic', sourcePath));
  insertPromotion(targetPath, sourcePath);
  return { targetPath, sourcePath };
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-cli-unpromote-test-'));

  const wsResult = initWorkspace('ws', base);
  if (!wsResult.ok) throw wsResult.error;
  workspacePath = wsResult.value.root;

  const dbResult = initDatabase(join(workspacePath, '.ico', 'state.db'));
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;

  // Suppress stdout/stderr output during tests
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase(db);
  const base = resolve(workspacePath, '..');
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: build global opts pointing at the test workspace
// ---------------------------------------------------------------------------

function globalOpts(): UnpromoteCommandGlobal {
  return { workspace: workspacePath };
}

function commandOpts(overrides: Partial<UnpromoteCommandOptions> = {}): UnpromoteCommandOptions {
  return { ...overrides };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('runUnpromote — dry run', () => {
  it('returns ok with dryRun: true and shows preview output', () => {
    const { targetPath } = createPromotion();

    const stdoutMock = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const result = runUnpromote(targetPath, commandOpts({ dryRun: true }), globalOpts());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.dryRun).toBe(true);

    // Should have written some preview text
    const written = stdoutMock.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Dry run');
  });

  it('dry run shows the target and source paths', () => {
    const { targetPath, sourcePath } = createPromotion();

    const stdoutMock = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    runUnpromote(targetPath, commandOpts({ dryRun: true }), globalOpts());

    const written = stdoutMock.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain(targetPath);
    expect(written).toContain(sourcePath);
  });
});

// ---------------------------------------------------------------------------
// Without --yes — confirmation required
// ---------------------------------------------------------------------------

describe('runUnpromote — confirmation required', () => {
  it('returns err when --yes is not provided', () => {
    const { targetPath } = createPromotion();

    const result = runUnpromote(targetPath, commandOpts(), globalOpts());

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.message).toContain('Confirmation required');
  });

  it('outputs a warning when --yes is missing', () => {
    const { targetPath } = createPromotion();

    const stdoutMock = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    runUnpromote(targetPath, commandOpts(), globalOpts());

    const written = stdoutMock.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('--yes');
  });
});

// ---------------------------------------------------------------------------
// Successful unpromote with --yes
// ---------------------------------------------------------------------------

describe('runUnpromote — success with --yes', () => {
  it('returns ok and shows removal message', () => {
    const { targetPath } = createPromotion();

    const stdoutMock = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const result = runUnpromote(targetPath, commandOpts({ yes: true }), globalOpts());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.dryRun).toBe(false);

    const written = stdoutMock.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Removed');
    expect(written).toContain(targetPath);
  });

  it('returns err when target path is not in promotions table', () => {
    const result = runUnpromote(
      'wiki/topics/nonexistent.md',
      commandOpts({ yes: true }),
      globalOpts(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The UnpromoteError message describes the missing record; the code is NOT_PROMOTED
    expect(result.error.message).toMatch(/No promotion record found|NOT_PROMOTED/);
  });
});

// ---------------------------------------------------------------------------
// JSON output mode
// ---------------------------------------------------------------------------

describe('runUnpromote — JSON output', () => {
  it('writes JSON to stdout in dry run mode when --json is set', () => {
    const { targetPath } = createPromotion();

    const stdoutMock = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    runUnpromote(targetPath, commandOpts({ dryRun: true }), { ...globalOpts(), json: true });

    const written = stdoutMock.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(written) as Record<string, unknown>;

    expect(parsed['targetPath']).toBe(targetPath);
    expect(parsed['dryRun']).toBe(true);
  });
});
