/**
 * Tests for deterministic cross-source attribution (l13.5). The invariant:
 * only model-emitted source ids that were PROVABLY in the pass's input set
 * (resolved from the compilations table, never from model output) are
 * accepted into compilation_sources; everything else is dropped.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, type Database, initDatabase } from '@ico/kernel';

import {
  attributeSources,
  recordCompilationSources,
  resolveSummarySourceIds,
} from './source-attribution.js';

function openDb(): Database {
  const result = initDatabase(':memory:');
  if (!result.ok) throw new Error(`initDatabase failed: ${result.error.message}`);
  return result.value;
}

function insertSource(db: Database, id: string, path: string): void {
  db.prepare(
    `INSERT INTO sources (id, path, type, ingested_at, hash) VALUES (?, ?, 'markdown', '2026-06-01T00:00:00.000Z', ?)`,
  ).run(id, path, `hash-${id}`);
}

function insertSummary(db: Database, id: string, sourceId: string, outputPath: string): void {
  db.prepare(
    `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model)
     VALUES (?, ?, 'summary', ?, '2026-06-01T01:00:00.000Z', 0, 'deepseek-chat')`,
  ).run(id, sourceId, outputPath);
}

function insertCrossSource(db: Database, id: string, outputPath: string): void {
  db.prepare(
    `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model)
     VALUES (?, NULL, 'concept', ?, '2026-06-01T02:00:00.000Z', 0, 'deepseek-chat')`,
  ).run(id, outputPath);
}

const SRC_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SRC_B = 'aaaaaaaa-0000-0000-0000-000000000002';

describe('attributeSources (pure)', () => {
  it('keeps only advisory ids present in the known set', () => {
    const known = new Set([SRC_A, SRC_B]);
    const r = attributeSources([SRC_A, 'ghost-id'], known);
    expect(r.attributed).toEqual([SRC_A]);
    expect(r.advisoryDropped).toBe(1);
    expect(r.mode).toBe('advisory-validated');
  });

  it('deduplicates repeated advisory ids', () => {
    const r = attributeSources([SRC_A, SRC_A, SRC_B], new Set([SRC_A, SRC_B]));
    expect(r.attributed).toEqual([SRC_A, SRC_B]);
  });

  it('returns unattributed mode when nothing intersects', () => {
    const r = attributeSources(['x', 'y'], new Set([SRC_A]));
    expect(r.attributed).toEqual([]);
    expect(r.mode).toBe('unattributed');
    expect(r.advisoryDropped).toBe(2);
  });

  it('is empty for an empty advisory list', () => {
    const r = attributeSources([], new Set([SRC_A]));
    expect(r.attributed).toEqual([]);
    expect(r.mode).toBe('unattributed');
  });
});

describe('resolveSummarySourceIds', () => {
  let db: Database;
  beforeEach(() => {
    db = openDb();
    insertSource(db, SRC_A, 'raw/a.md');
    insertSource(db, SRC_B, 'raw/b.md');
    insertSummary(db, 'comp-a', SRC_A, 'wiki/sources/a.md');
    insertSummary(db, 'comp-b', SRC_B, 'wiki/sources/b.md');
  });
  afterEach(() => closeDatabase(db));

  it('returns every summary source id when unrestricted', () => {
    const r = resolveSummarySourceIds(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(new Set([SRC_A, SRC_B]));
  });

  it('restricts to the given summary paths', () => {
    const r = resolveSummarySourceIds(db, ['wiki/sources/a.md']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(new Set([SRC_A]));
  });

  it('ignores cross-source rows (only type=summary contributes)', () => {
    insertCrossSource(db, 'comp-topic', 'wiki/topics/t.md');
    const r = resolveSummarySourceIds(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(new Set([SRC_A, SRC_B]));
  });
});

describe('recordCompilationSources', () => {
  let db: Database;
  beforeEach(() => {
    db = openDb();
    insertSource(db, SRC_A, 'raw/a.md');
    insertSource(db, SRC_B, 'raw/b.md');
    insertSummary(db, 'comp-a', SRC_A, 'wiki/sources/a.md');
    insertSummary(db, 'comp-b', SRC_B, 'wiki/sources/b.md');
    insertCrossSource(db, 'comp-topic', 'wiki/topics/t.md');
  });
  afterEach(() => closeDatabase(db));

  it('persists the junction rows', () => {
    const r = recordCompilationSources(db, 'comp-topic', [SRC_A, SRC_B]);
    expect(r.ok).toBe(true);
    const rows = db
      .prepare<
        [string],
        { source_id: string }
      >(`SELECT source_id FROM compilation_sources WHERE compilation_id = ? ORDER BY source_id`)
      .all('comp-topic');
    expect(rows.map((x) => x.source_id)).toEqual([SRC_A, SRC_B]);
  });

  it('replaces prior rows on re-attribution (latest compile wins)', () => {
    recordCompilationSources(db, 'comp-topic', [SRC_A, SRC_B]);
    const r = recordCompilationSources(db, 'comp-topic', [SRC_A]);
    expect(r.ok).toBe(true);
    const rows = db
      .prepare<
        [string],
        { source_id: string }
      >(`SELECT source_id FROM compilation_sources WHERE compilation_id = ?`)
      .all('comp-topic');
    expect(rows.map((x) => x.source_id)).toEqual([SRC_A]);
  });

  it('is idempotent on the composite key', () => {
    const r = recordCompilationSources(db, 'comp-topic', [SRC_A, SRC_A]);
    expect(r.ok).toBe(true);
    const rows = db
      .prepare<
        [string],
        { source_id: string }
      >(`SELECT source_id FROM compilation_sources WHERE compilation_id = ?`)
      .all('comp-topic');
    expect(rows).toHaveLength(1);
  });
});
