/**
 * Tests for unpromote.ts — promotion reversal.
 *
 * Each test creates a fresh temporary workspace via `initWorkspace` and an
 * in-memory SQLite database via `initDatabase(':memory:')`. The workspace
 * fixture includes the complete directory tree required by the kernel.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { readTraces } from './traces.js';
import { unpromoteArtifact, UnpromoteError } from './unpromote.js';
import { initWorkspace } from './workspace.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workspacePath: string;
let db: Database;

/** Creates directories recursively and writes content to the given absolute path. */
function writeFile(absolutePath: string, content: string): void {
  mkdirSync(resolve(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
}

/** Returns a valid promoted page content string. */
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

/** Inserts a promotions record into the DB. */
function insertPromotion(
  targetPath: string,
  sourcePath = 'outputs/reports/my-artifact.md',
  targetType = 'topic',
): string {
  const id = 'promo-' + Math.random().toString(36).slice(2);
  db.prepare(
    `INSERT INTO promotions (id, source_path, target_path, target_type, promoted_at, promoted_by, source_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sourcePath, targetPath, targetType, new Date().toISOString(), 'user', 'sha256:abc');
  return id;
}

/** Creates a promoted wiki page on disk AND inserts its DB record. */
function createPromotion(
  slug = 'my-topic',
  sourcePath = 'outputs/reports/my-artifact.md',
  targetType = 'topic',
): { targetPath: string; sourcePath: string; targetType: string } {
  const dirMap: Record<string, string> = {
    topic: 'wiki/topics',
    concept: 'wiki/concepts',
    entity: 'wiki/entities',
    reference: 'wiki/sources',
  };
  const dir = dirMap[targetType] ?? 'wiki/topics';
  const targetPath = `${dir}/${slug}.md`;

  writeFile(join(workspacePath, targetPath), promotedContent('My Topic', sourcePath));
  insertPromotion(targetPath, sourcePath, targetType);

  return { targetPath, sourcePath, targetType };
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-unpromote-test-'));

  const wsResult = initWorkspace('ws', base);
  if (!wsResult.ok) throw wsResult.error;
  workspacePath = wsResult.value.root;

  const dbResult = initDatabase(':memory:');
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;
});

afterEach(() => {
  closeDatabase(db);
  const base = resolve(workspacePath, '..');
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Successful unpromote
// ---------------------------------------------------------------------------

describe('unpromoteArtifact — successful unpromote', () => {
  it('returns ok(UnpromoteResult) with dryRun: false', () => {
    const { targetPath, sourcePath, targetType } = createPromotion();

    const result = unpromoteArtifact(db, workspacePath, { targetPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.targetPath).toBe(targetPath);
    expect(result.value.sourcePath).toBe(sourcePath);
    expect(result.value.targetType).toBe(targetType);
    expect(result.value.dryRun).toBe(false);
  });

  it('deletes the file from wiki/', () => {
    const { targetPath } = createPromotion();
    const absoluteTarget = join(workspacePath, targetPath);

    expect(existsSync(absoluteTarget)).toBe(true);

    unpromoteArtifact(db, workspacePath, { targetPath });

    expect(existsSync(absoluteTarget)).toBe(false);
  });

  it('removes the promotions record from the DB', () => {
    const { targetPath } = createPromotion();

    unpromoteArtifact(db, workspacePath, { targetPath });

    const row = db
      .prepare<[string], { id: string }>('SELECT id FROM promotions WHERE target_path = ?')
      .get(targetPath);

    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NOT_PROMOTED error
// ---------------------------------------------------------------------------

describe('unpromoteArtifact — NOT_PROMOTED', () => {
  it('returns err(UnpromoteError) with code NOT_PROMOTED when path not in DB', () => {
    const result = unpromoteArtifact(db, workspacePath, {
      targetPath: 'wiki/topics/ghost.md',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(UnpromoteError);
    expect(result.error.code).toBe('NOT_PROMOTED');
  });
});

// ---------------------------------------------------------------------------
// FILE_NOT_FOUND error
// ---------------------------------------------------------------------------

describe('unpromoteArtifact — FILE_NOT_FOUND', () => {
  it('returns err with code FILE_NOT_FOUND when record exists but file is gone', () => {
    const targetPath = 'wiki/topics/phantom.md';
    const sourcePath = 'outputs/reports/phantom.md';

    // Insert DB record without creating the file
    insertPromotion(targetPath, sourcePath);

    const result = unpromoteArtifact(db, workspacePath, { targetPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(UnpromoteError);
    expect(result.error.code).toBe('FILE_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('unpromoteArtifact — dry run', () => {
  it('returns ok with dryRun: true without deleting the file', () => {
    const { targetPath } = createPromotion();
    const absoluteTarget = join(workspacePath, targetPath);

    const result = unpromoteArtifact(db, workspacePath, { targetPath, dryRun: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.dryRun).toBe(true);
    // File must still exist
    expect(existsSync(absoluteTarget)).toBe(true);
  });

  it('does not remove the promotions DB record in dry run mode', () => {
    const { targetPath } = createPromotion();

    unpromoteArtifact(db, workspacePath, { targetPath, dryRun: true });

    const row = db
      .prepare<[string], { id: string }>('SELECT id FROM promotions WHERE target_path = ?')
      .get(targetPath);

    expect(row).toBeDefined();
  });

  it('returns the correct sourcePath and targetType in dry run mode', () => {
    const { targetPath, sourcePath, targetType } = createPromotion();

    const result = unpromoteArtifact(db, workspacePath, { targetPath, dryRun: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sourcePath).toBe(sourcePath);
    expect(result.value.targetType).toBe(targetType);
  });
});

// ---------------------------------------------------------------------------
// Wiki index rebuild
// ---------------------------------------------------------------------------

describe('unpromoteArtifact — wiki index rebuild', () => {
  it('wiki/index.md exists after unpromote', () => {
    const { targetPath } = createPromotion();

    unpromoteArtifact(db, workspacePath, { targetPath });

    expect(existsSync(join(workspacePath, 'wiki', 'index.md'))).toBe(true);
  });

  it('removed page is no longer referenced in wiki/index.md after unpromote', () => {
    const { targetPath } = createPromotion('to-remove');

    unpromoteArtifact(db, workspacePath, { targetPath });

    const indexContent = readFileSync(join(workspacePath, 'wiki', 'index.md'), 'utf-8');
    expect(indexContent).not.toContain('to-remove.md');
  });
});

// ---------------------------------------------------------------------------
// Trace event
// ---------------------------------------------------------------------------

describe('unpromoteArtifact — trace event', () => {
  it('writes a trace event of type "unpromote"', () => {
    const { targetPath } = createPromotion();

    unpromoteArtifact(db, workspacePath, { targetPath });

    const traces = readTraces(db, { eventType: 'unpromote' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;

    expect(traces.value).toHaveLength(1);
    expect(traces.value[0]!.event_type).toBe('unpromote');
  });

  it('trace summary references the target path', () => {
    const { targetPath } = createPromotion();

    unpromoteArtifact(db, workspacePath, { targetPath });

    const traces = readTraces(db, { eventType: 'unpromote' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;

    const summary = traces.value[0]!.summary ?? '';
    expect(summary).toContain(targetPath);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe('unpromoteArtifact — audit log', () => {
  it('appends an entry to audit/log.md', () => {
    const { targetPath } = createPromotion();

    unpromoteArtifact(db, workspacePath, { targetPath });

    const logContent = readFileSync(join(workspacePath, 'audit', 'log.md'), 'utf-8');
    expect(logContent).toContain('unpromote');
  });
});
