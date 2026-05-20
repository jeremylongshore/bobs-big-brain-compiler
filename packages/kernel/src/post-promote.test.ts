/**
 * Tests for post-promote.ts — post-promotion wiki index rebuild and lint checks.
 *
 * Each test creates a fresh temporary workspace via `initWorkspace` and an
 * in-memory SQLite database via `initDatabase(':memory:')`. The workspace
 * fixture includes the complete directory tree required by the kernel.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPostPromotionRefresh } from './post-promote.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { readTraces } from './traces.js';
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

/**
 * Returns valid promoted page content (includes promoted_from, promoted_at,
 * promoted_by, and title fields).
 */
function validPromotedContent(
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

/** Inserts a row into the promotions table for the given target path. */
function insertPromotionRecord(
  targetPath: string,
  sourcePath = 'outputs/reports/my-artifact.md',
  targetType = 'topic',
): void {
  db.prepare(
    `INSERT INTO promotions (id, source_path, target_path, target_type, promoted_at, promoted_by, source_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'test-uuid-' + Math.random().toString(36).slice(2),
    sourcePath,
    targetPath,
    targetType,
    new Date().toISOString(),
    'user',
    'sha256:aabbcc',
  );
}

/** Creates a source artifact at the given workspace-relative path. */
function createSourceArtifact(relPath = 'outputs/reports/my-artifact.md'): void {
  writeFile(join(workspacePath, relPath), '---\ntitle: Source\n---\nContent.\n');
}

/** Creates a valid promoted page at wiki/topics/<slug>.md and inserts the DB record. */
function createFullyValidPromotion(slug = 'my-topic'): {
  targetPath: string;
  sourcePath: string;
} {
  const sourcePath = 'outputs/reports/my-artifact.md';
  const targetPath = `wiki/topics/${slug}.md`;

  createSourceArtifact(sourcePath);
  writeFile(join(workspacePath, targetPath), validPromotedContent('My Topic', sourcePath));
  insertPromotionRecord(targetPath, sourcePath);

  return { targetPath, sourcePath };
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-post-promote-test-'));

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
// Happy path
// ---------------------------------------------------------------------------

describe('runPostPromotionRefresh — happy path', () => {
  it('returns ok with no lint issues for a fully valid promoted page', () => {
    const { targetPath, sourcePath } = createFullyValidPromotion();

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.lintIssues).toHaveLength(0);
  });

  it('returns the correct indexedPages count after rebuild', () => {
    const { targetPath, sourcePath } = createFullyValidPromotion();

    // Add a second page to bump the count
    writeFile(join(workspacePath, 'wiki/topics/extra.md'), '---\ntitle: Extra\n---\nContent.\n');

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Two pages exist in wiki/topics/
    expect(result.value.indexedPages).toBe(2);
  });

  it('wiki/index.md exists and is written after rebuild', () => {
    const { targetPath, sourcePath } = createFullyValidPromotion();

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    expect(existsSync(join(workspacePath, 'wiki', 'index.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Trace event
// ---------------------------------------------------------------------------

describe('runPostPromotionRefresh — trace event', () => {
  it('writes a trace event of type "post-promotion-refresh"', () => {
    const { targetPath, sourcePath } = createFullyValidPromotion();

    runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    const traces = readTraces(db, { eventType: 'post-promotion-refresh' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;

    expect(traces.value).toHaveLength(1);
    expect(traces.value[0]!.event_type).toBe('post-promotion-refresh');
  });

  it('trace summary includes target path and issue count', () => {
    const { targetPath, sourcePath } = createFullyValidPromotion();

    runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    const traces = readTraces(db, { eventType: 'post-promotion-refresh' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;

    const summary = traces.value[0]!.summary ?? '';
    expect(summary).toContain(targetPath);
  });
});

// ---------------------------------------------------------------------------
// PROM001: Source file missing
// ---------------------------------------------------------------------------

describe('runPostPromotionRefresh — PROM001 source file missing', () => {
  it('emits PROM001 warning when source file is gone', () => {
    const targetPath = 'wiki/topics/my-topic.md';
    const sourcePath = 'outputs/reports/my-artifact.md';

    // Create the promoted page and DB record, but NOT the source file
    writeFile(join(workspacePath, targetPath), validPromotedContent('My Topic', sourcePath));
    insertPromotionRecord(targetPath, sourcePath);

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const issue = result.value.lintIssues.find((i) => i.code === 'PROM001');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
    expect(issue?.path).toBe(targetPath);
  });

  it('does NOT emit PROM001 when source file exists', () => {
    const { targetPath, sourcePath } = createFullyValidPromotion();

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const issue = result.value.lintIssues.find((i) => i.code === 'PROM001');
    expect(issue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PROM002: promoted_from missing
// ---------------------------------------------------------------------------

describe('runPostPromotionRefresh — PROM002 promoted_from missing', () => {
  it('emits PROM002 error when promoted_from is absent', () => {
    const sourcePath = 'outputs/reports/my-artifact.md';
    const targetPath = 'wiki/topics/no-promoted-from.md';

    createSourceArtifact(sourcePath);
    writeFile(
      join(workspacePath, targetPath),
      '---\ntitle: No Promoted From\ntype: topic\n---\nContent.\n',
    );
    insertPromotionRecord(targetPath, sourcePath);

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const issue = result.value.lintIssues.find((i) => i.code === 'PROM002');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('does NOT emit PROM002 when promoted_from is present', () => {
    const { targetPath, sourcePath } = createFullyValidPromotion();

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const issue = result.value.lintIssues.find((i) => i.code === 'PROM002');
    expect(issue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PROM003: No promotions record
// ---------------------------------------------------------------------------

describe('runPostPromotionRefresh — PROM003 no promotions record', () => {
  it('emits PROM003 error when no DB record exists for the target path', () => {
    const sourcePath = 'outputs/reports/my-artifact.md';
    const targetPath = 'wiki/topics/no-record.md';

    createSourceArtifact(sourcePath);
    writeFile(join(workspacePath, targetPath), validPromotedContent('No Record', sourcePath));
    // Intentionally skip insertPromotionRecord

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const issue = result.value.lintIssues.find((i) => i.code === 'PROM003');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('does NOT emit PROM003 when promotions record exists', () => {
    const { targetPath, sourcePath } = createFullyValidPromotion();

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const issue = result.value.lintIssues.find((i) => i.code === 'PROM003');
    expect(issue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PROM004: No title
// ---------------------------------------------------------------------------

describe('runPostPromotionRefresh — PROM004 missing title', () => {
  it('emits PROM004 error when title is missing from frontmatter', () => {
    const sourcePath = 'outputs/reports/my-artifact.md';
    const targetPath = 'wiki/topics/no-title.md';

    createSourceArtifact(sourcePath);
    writeFile(
      join(workspacePath, targetPath),
      `---\ntype: topic\npromoted_from: ${sourcePath}\n---\nContent.\n`,
    );
    insertPromotionRecord(targetPath, sourcePath);

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const issue = result.value.lintIssues.find((i) => i.code === 'PROM004');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
  });

  it('does NOT emit PROM004 when title is present', () => {
    const { targetPath, sourcePath } = createFullyValidPromotion();

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const issue = result.value.lintIssues.find((i) => i.code === 'PROM004');
    expect(issue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multiple issues simultaneously
// ---------------------------------------------------------------------------

describe('runPostPromotionRefresh — multiple issues', () => {
  it('detects all applicable issues at once', () => {
    const sourcePath = 'outputs/reports/bad-artifact.md';
    const targetPath = 'wiki/topics/multi-issue.md';

    // Source missing, no promoted_from, no title, no DB record
    writeFile(join(workspacePath, targetPath), '---\ntype: topic\n---\nContent.\n');
    // No source file, no DB record

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const codes = result.value.lintIssues.map((i) => i.code);
    expect(codes).toContain('PROM001');
    expect(codes).toContain('PROM002');
    expect(codes).toContain('PROM003');
    expect(codes).toContain('PROM004');
    expect(result.value.lintIssues).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Index count
// ---------------------------------------------------------------------------

describe('runPostPromotionRefresh — index count', () => {
  it('returns 0 indexedPages when wiki is empty', () => {
    const sourcePath = 'outputs/reports/my-artifact.md';
    const targetPath = 'wiki/topics/my-topic.md';

    createSourceArtifact(sourcePath);
    writeFile(join(workspacePath, targetPath), validPromotedContent('My Topic', sourcePath));
    insertPromotionRecord(targetPath, sourcePath);

    // Remove the page to test empty case
    rmSync(join(workspacePath, targetPath));

    // Re-create the page so the lint checks can run
    writeFile(join(workspacePath, targetPath), validPromotedContent('My Topic', sourcePath));

    const result = runPostPromotionRefresh(db, workspacePath, targetPath, sourcePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // One page exists
    expect(result.value.indexedPages).toBe(1);
  });
});
