/**
 * Tests for staleness detection.
 *
 * Each test builds its own `:memory:` database via `initDatabase`, inserts
 * fixtures directly via prepared statements, then exercises the three
 * staleness functions.  No filesystem I/O is required.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, type Database, initDatabase } from '@ico/kernel';

import { detectStalePages, getUncompiledSources, markStale } from './staleness.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a fresh in-memory database with the full ICO schema applied. */
function openDb(): Database {
  const result = initDatabase(':memory:');
  if (!result.ok) throw new Error(`initDatabase failed: ${result.error.message}`);
  return result.value;
}

/**
 * Insert a row into `sources`.
 * `ingestedAt` must be a full ISO timestamp string.
 */
function insertSource(
  db: Database,
  opts: { id: string; path: string; type?: string; ingestedAt: string },
): void {
  db.prepare(
    `INSERT INTO sources (id, path, type, ingested_at, hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.id, opts.path, opts.type ?? 'markdown', opts.ingestedAt, `hash-${opts.id}`);
}

/**
 * Insert a row into `compilations`.
 * `stale` defaults to 0 (false).
 */
function insertCompilation(
  db: Database,
  opts: {
    id: string;
    sourceId: string | null;
    type?: string;
    outputPath: string;
    compiledAt: string;
    stale?: 0 | 1;
  },
): void {
  db.prepare(
    `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.sourceId,
    opts.type ?? 'summary',
    opts.outputPath,
    opts.compiledAt,
    opts.stale ?? 0,
    'claude-3-5-haiku-20241022',
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Fixed timestamps used across tests.
const T1 = '2026-01-01T00:00:00.000Z'; // older
const T2 = '2026-01-02T00:00:00.000Z'; // newer

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('detectStalePages', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    closeDatabase(db);
  });

  it('returns an empty array when there are no compilations', () => {
    const result = detectStalePages(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('does not flag a fresh compilation (compiled_at after ingested_at)', () => {
    // Source ingested at T1, compiled at T2 (compilation is newer).
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T1 });
    insertCompilation(db, {
      id: 'c1',
      sourceId: 's1',
      outputPath: 'wiki/a.md',
      compiledAt: T2,
    });

    const result = detectStalePages(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('flags a compilation as source-changed when source was re-ingested after compilation', () => {
    // Source ingested at T2 (newer), compiled at T1 (older).
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T2 });
    insertCompilation(db, {
      id: 'c1',
      sourceId: 's1',
      outputPath: 'wiki/a.md',
      compiledAt: T1,
    });

    const result = detectStalePages(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    // Non-null assertion is safe: we asserted length is 1 above.
    const page = result.value[0]!;
    expect(page.compilationId).toBe('c1');
    expect(page.sourceId).toBe('s1');
    expect(page.reason).toBe('source-changed');
    expect(page.outputPath).toBe('wiki/a.md');
    expect(page.compiledAt).toBe(T1);
  });

  it('includes already-stale compilations (stale=1) with reason dependency-recompiled', () => {
    // Source and compilation timestamps do NOT trigger source-changed.
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T1 });
    insertCompilation(db, {
      id: 'c1',
      sourceId: 's1',
      outputPath: 'wiki/a.md',
      compiledAt: T2,
      stale: 1,
    });

    const result = detectStalePages(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const page = result.value[0]!;
    expect(page.compilationId).toBe('c1');
    expect(page.reason).toBe('dependency-recompiled');
  });

  it('prefers source-changed reason when a row is both stale=1 and source-changed', () => {
    // Both signals fire: source re-ingested AND stale flag set.
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T2 });
    insertCompilation(db, {
      id: 'c1',
      sourceId: 's1',
      outputPath: 'wiki/a.md',
      compiledAt: T1,
      stale: 1,
    });

    const result = detectStalePages(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should appear exactly once.
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.reason).toBe('source-changed');
  });
});

describe('getUncompiledSources', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    closeDatabase(db);
  });

  it('returns sources that have no summary compilation', () => {
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T1 });

    const result = getUncompiledSources(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.id).toBe('s1');
    expect(result.value[0]!.path).toBe('raw/notes/a.md');
  });

  it('returns an empty array when all sources have a summary compilation', () => {
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T1 });
    insertCompilation(db, {
      id: 'c1',
      sourceId: 's1',
      type: 'summary',
      outputPath: 'wiki/a.md',
      compiledAt: T2,
    });

    const result = getUncompiledSources(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('does not exclude sources that have a non-summary compilation only', () => {
    // A source compiled as 'concept' but never as 'summary' is still uncompiled.
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T1 });
    insertCompilation(db, {
      id: 'c1',
      sourceId: 's1',
      type: 'concept',
      outputPath: 'wiki/concepts/a.md',
      compiledAt: T2,
    });

    const result = getUncompiledSources(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.id).toBe('s1');
  });
});

describe('markStale', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    closeDatabase(db);
  });

  it('returns 0 when given an empty array', () => {
    const result = markStale(db, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(0);
  });

  it('sets stale=1 and returns the updated row count', () => {
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T1 });
    insertCompilation(db, {
      id: 'c1',
      sourceId: 's1',
      outputPath: 'wiki/a.md',
      compiledAt: T2,
      stale: 0,
    });

    const markResult = markStale(db, ['c1']);
    expect(markResult.ok).toBe(true);
    if (!markResult.ok) return;
    expect(markResult.value).toBe(1);

    // Verify the flag was actually set.
    const row = db
      .prepare<[string], { stale: number }>('SELECT stale FROM compilations WHERE id = ?')
      .get('c1');
    expect(row!.stale).toBe(1);
  });

  it('silently skips IDs that do not exist and counts only real updates', () => {
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T1 });
    insertCompilation(db, {
      id: 'c1',
      sourceId: 's1',
      outputPath: 'wiki/a.md',
      compiledAt: T2,
    });

    const result = markStale(db, ['c1', 'nonexistent-uuid']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only 'c1' exists, so only 1 row updated.
    expect(result.value).toBe(1);
  });

  it('marks multiple compilations stale in a single call', () => {
    insertSource(db, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T1 });
    insertSource(db, { id: 's2', path: 'raw/notes/b.md', ingestedAt: T1 });
    insertCompilation(db, {
      id: 'c1',
      sourceId: 's1',
      outputPath: 'wiki/a.md',
      compiledAt: T2,
    });
    insertCompilation(db, {
      id: 'c2',
      sourceId: 's2',
      outputPath: 'wiki/b.md',
      compiledAt: T2,
    });

    const result = markStale(db, ['c1', 'c2']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(2);

    const rows = db
      .prepare<[], { id: string; stale: number }>('SELECT id, stale FROM compilations')
      .all();
    expect(rows.every((r: { id: string; stale: number }) => r.stale === 1)).toBe(true);
  });
});
