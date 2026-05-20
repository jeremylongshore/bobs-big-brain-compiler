/**
 * Tests for artifact listing and discovery (E8-B08).
 *
 * Uses an in-memory SQLite database via initDatabase(':memory:') and temporary
 * workspace directories to avoid any filesystem side effects.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listArtifacts } from './artifacts.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let wsPath: string;
let db: Database;

beforeEach(() => {
  wsPath = mkdtempSync(join(tmpdir(), 'ico-artifacts-test-'));
  const dbResult = initDatabase(':memory:');
  if (!dbResult.ok) {
    throw new Error(`Failed to init DB: ${dbResult.error.message}`);
  }
  db = dbResult.value;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(wsPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Ensure a directory exists at `absolutePath`. */
function ensureDir(absolutePath: string): void {
  mkdirSync(absolutePath, { recursive: true });
}

/** Write `content` to `absolutePath`, creating parent dirs. */
function writeFile(absolutePath: string, content: string): void {
  ensureDir(join(absolutePath, '..'));
  writeFileSync(absolutePath, content, 'utf-8');
}

/** Build a minimal valid report markdown string. */
function reportMd(opts: {
  title: string;
  generatedAt: string;
  model?: string;
  tokensUsed?: number;
}): string {
  return [
    '---',
    'type: report',
    `title: "${opts.title}"`,
    `generated_at: "${opts.generatedAt}"`,
    'generated_from:',
    '  - "wiki/topics/foo.md"',
    `model: "${opts.model ?? 'claude-sonnet-4-6'}"`,
    `tokens_used: ${opts.tokensUsed ?? 300}`,
    '---',
    '',
    '## Executive Summary',
    '',
    'Body.',
  ].join('\n');
}

/** Build a minimal valid slides markdown string. */
function slidesMd(opts: {
  title: string;
  generatedAt: string;
  model?: string;
  tokensUsed?: number;
}): string {
  return [
    '---',
    'marp: true',
    'type: slides',
    `title: "${opts.title}"`,
    `generated_at: "${opts.generatedAt}"`,
    'generated_from:',
    '  - "wiki/topics/bar.md"',
    `model: "${opts.model ?? 'claude-sonnet-4-6'}"`,
    `tokens_used: ${opts.tokensUsed ?? 200}`,
    '---',
    '',
    '# Slide 1',
  ].join('\n');
}

/** Insert a promotion record directly into the DB. */
function insertPromotion(database: Database, sourcePath: string, targetPath: string): void {
  database
    .prepare(
      `INSERT INTO promotions (id, source_path, target_path, target_type, promoted_at, promoted_by)
     VALUES (?, ?, ?, 'topic', '2024-01-15T10:00:00.000Z', 'user')`,
    )
    .run(`promo-${Date.now()}-${Math.random()}`, sourcePath, targetPath);
}

// ---------------------------------------------------------------------------
// Empty workspace
// ---------------------------------------------------------------------------

describe('listArtifacts — empty workspace', () => {
  it('returns an empty array when outputs directories do not exist', () => {
    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('returns an empty array when outputs exists but has no .md files', () => {
    ensureDir(join(wsPath, 'outputs', 'reports'));
    ensureDir(join(wsPath, 'outputs', 'slides'));

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Listing reports and slides
// ---------------------------------------------------------------------------

describe('listArtifacts — listing artifacts', () => {
  it('lists a single report', () => {
    writeFile(
      join(wsPath, 'outputs', 'reports', 'my-report.md'),
      reportMd({ title: 'My Report', generatedAt: '2024-01-15T10:00:00.000Z' }),
    );

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.title).toBe('My Report');
    expect(result.value[0]?.type).toBe('report');
  });

  it('lists a single slides deck', () => {
    writeFile(
      join(wsPath, 'outputs', 'slides', 'my-slides.md'),
      slidesMd({ title: 'My Slides', generatedAt: '2024-01-15T11:00:00.000Z' }),
    );

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.type).toBe('slides');
  });

  it('lists both reports and slides together', () => {
    writeFile(
      join(wsPath, 'outputs', 'reports', 'report-a.md'),
      reportMd({ title: 'Report A', generatedAt: '2024-01-15T09:00:00.000Z' }),
    );
    writeFile(
      join(wsPath, 'outputs', 'slides', 'slides-b.md'),
      slidesMd({ title: 'Slides B', generatedAt: '2024-01-15T10:00:00.000Z' }),
    );

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
  });

  it('populates all ArtifactInfo fields correctly', () => {
    writeFile(
      join(wsPath, 'outputs', 'reports', 'detailed.md'),
      reportMd({
        title: 'Detailed Report',
        generatedAt: '2024-06-01T08:00:00.000Z',
        model: 'claude-opus-4',
        tokensUsed: 1500,
      }),
    );

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value[0]!;
    expect(info.title).toBe('Detailed Report');
    expect(info.type).toBe('report');
    expect(info.generatedAt).toBe('2024-06-01T08:00:00.000Z');
    expect(info.model).toBe('claude-opus-4');
    expect(info.tokensUsed).toBe(1500);
    expect(info.sizeBytes).toBeGreaterThan(0);
    expect(info.path).toMatch(/outputs\/reports\/detailed\.md$/);
  });
});

// ---------------------------------------------------------------------------
// Promotion status
// ---------------------------------------------------------------------------

describe('listArtifacts — promotion status', () => {
  it('marks unpromoted artifacts as promoted: false', () => {
    writeFile(
      join(wsPath, 'outputs', 'reports', 'unpromoted.md'),
      reportMd({ title: 'Unpromoted', generatedAt: '2024-01-15T10:00:00.000Z' }),
    );

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.promoted).toBe(false);
  });

  it('marks promoted artifacts as promoted: true', () => {
    const reportPath = join(wsPath, 'outputs', 'reports', 'promoted.md');
    writeFile(reportPath, reportMd({ title: 'Promoted', generatedAt: '2024-01-15T10:00:00.000Z' }));

    // Insert a promotion record using the workspace-relative path.
    insertPromotion(db, 'outputs/reports/promoted.md', 'wiki/topics/promoted.md');

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.promoted).toBe(true);
  });

  it('correctly distinguishes promoted from unpromoted in a mixed list', () => {
    writeFile(
      join(wsPath, 'outputs', 'reports', 'promoted.md'),
      reportMd({ title: 'Promoted', generatedAt: '2024-01-15T12:00:00.000Z' }),
    );
    writeFile(
      join(wsPath, 'outputs', 'reports', 'unpromoted.md'),
      reportMd({ title: 'Unpromoted', generatedAt: '2024-01-15T11:00:00.000Z' }),
    );

    insertPromotion(db, 'outputs/reports/promoted.md', 'wiki/topics/promoted.md');

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);

    const promotedEntry = result.value.find((a) => a.title === 'Promoted');
    const unpromotedEntry = result.value.find((a) => a.title === 'Unpromoted');

    expect(promotedEntry?.promoted).toBe(true);
    expect(unpromotedEntry?.promoted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

describe('listArtifacts — sort order', () => {
  it('returns artifacts sorted newest first by generatedAt', () => {
    writeFile(
      join(wsPath, 'outputs', 'reports', 'old.md'),
      reportMd({ title: 'Old Report', generatedAt: '2024-01-10T10:00:00.000Z' }),
    );
    writeFile(
      join(wsPath, 'outputs', 'reports', 'new.md'),
      reportMd({ title: 'New Report', generatedAt: '2024-01-20T10:00:00.000Z' }),
    );
    writeFile(
      join(wsPath, 'outputs', 'reports', 'mid.md'),
      reportMd({ title: 'Mid Report', generatedAt: '2024-01-15T10:00:00.000Z' }),
    );

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.title).toBe('New Report');
    expect(result.value[1]?.title).toBe('Mid Report');
    expect(result.value[2]?.title).toBe('Old Report');
  });
});

// ---------------------------------------------------------------------------
// Skipping files without frontmatter
// ---------------------------------------------------------------------------

describe('listArtifacts — incomplete frontmatter', () => {
  it('skips files with no parseable frontmatter', () => {
    writeFile(
      join(wsPath, 'outputs', 'reports', 'no-frontmatter.md'),
      '## Just Markdown\n\nNo YAML here.\n',
    );
    writeFile(
      join(wsPath, 'outputs', 'reports', 'good.md'),
      reportMd({ title: 'Good', generatedAt: '2024-01-15T10:00:00.000Z' }),
    );

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the good file should be included.
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.title).toBe('Good');
  });

  it('skips files missing required frontmatter fields', () => {
    const incomplete = '---\ntitle: "Incomplete"\n---\nNo other fields.\n';
    writeFile(join(wsPath, 'outputs', 'reports', 'incomplete.md'), incomplete);
    writeFile(
      join(wsPath, 'outputs', 'reports', 'complete.md'),
      reportMd({ title: 'Complete', generatedAt: '2024-01-15T10:00:00.000Z' }),
    );

    const result = listArtifacts(db, wsPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.title).toBe('Complete');
  });
});
