/**
 * Tests for the incremental-compile affected-set diff (e06.5 / R12 / §6.3).
 *
 * The invariant under test is the load-bearing one: the diff must NEVER wrongly
 * mark a page unaffected (staleness), and must select a citing cross-source page
 * when the changed source contributed to it. Every ambiguity resolves to
 * "recompile" (fail toward freshness). Deterministic, zero-LLM-cost — all
 * fixtures are in-memory SQLite rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, type Database, initDatabase } from '@ico/kernel';

import { computeAffectedSet } from './incremental.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function openDb(): Database {
  const result = initDatabase(':memory:');
  if (!result.ok) throw new Error(`initDatabase failed: ${result.error.message}`);
  return result.value;
}

function insertSource(
  db: Database,
  opts: { id: string; path: string; hash: string; ingestedAt?: string },
): void {
  db.prepare(
    `INSERT INTO sources (id, path, type, ingested_at, hash) VALUES (?, ?, 'markdown', ?, ?)`,
  ).run(opts.id, opts.path, opts.ingestedAt ?? '2026-06-01T00:00:00.000Z', opts.hash);
}

function insertCompilation(
  db: Database,
  opts: {
    id: string;
    sourceId: string | null;
    type: string;
    outputPath: string;
    compiledAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model)
     VALUES (?, ?, ?, ?, ?, 0, 'deepseek-chat')`,
  ).run(
    opts.id,
    opts.sourceId,
    opts.type,
    opts.outputPath,
    opts.compiledAt ?? '2026-06-01T01:00:00.000Z',
  );
}

function linkCitation(db: Database, compilationId: string, sourceId: string): void {
  db.prepare(`INSERT INTO compilation_sources (compilation_id, source_id) VALUES (?, ?)`).run(
    compilationId,
    sourceId,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('computeAffectedSet — incremental diff', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    closeDatabase(db);
  });

  it('selects a changed source’s own single-source page', () => {
    insertSource(db, { id: 'src-a', path: 'raw/notes/a.md', hash: 'OLD' });
    insertCompilation(db, {
      id: 'cmp-a-sum',
      sourceId: 'src-a',
      type: 'summary',
      outputPath: 'wiki/sources/a.md',
    });

    const result = computeAffectedSet(db, [{ path: 'raw/notes/a.md', hash: 'NEW' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.changedSourcePaths).toEqual(['raw/notes/a.md']);
    const ids = result.value.affectedPages.map((p) => p.compilationId);
    expect(ids).toContain('cmp-a-sum');
    const own = result.value.affectedPages.find((p) => p.compilationId === 'cmp-a-sum');
    expect(own?.reason).toBe('source-changed');
  });

  it('selects a citing cross-source page via the compilation_sources junction', () => {
    // Two sources; a topic page synthesises both, recorded in the junction.
    insertSource(db, { id: 'src-a', path: 'raw/notes/a.md', hash: 'OLD-A' });
    insertSource(db, { id: 'src-b', path: 'raw/notes/b.md', hash: 'B' });
    insertCompilation(db, {
      id: 'cmp-a-sum',
      sourceId: 'src-a',
      type: 'summary',
      outputPath: 'wiki/sources/a.md',
    });
    // Cross-source topic: source_id NULL, linked to BOTH via the junction.
    insertCompilation(db, {
      id: 'cmp-topic',
      sourceId: null,
      type: 'topic',
      outputPath: 'wiki/topics/merged.md',
    });
    linkCitation(db, 'cmp-topic', 'src-a');
    linkCitation(db, 'cmp-topic', 'src-b');

    const result = computeAffectedSet(db, [{ path: 'raw/notes/a.md', hash: 'NEW-A' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.value.affectedPages.map((p) => [p.compilationId, p]));
    // The citing topic page MUST be selected — this is the "don't mark a citing
    // page unaffected" guarantee.
    expect(byId.has('cmp-topic')).toBe(true);
    expect(byId.get('cmp-topic')?.reason).toBe('cited-source-changed');
    // And the source's own summary.
    expect(byId.has('cmp-a-sum')).toBe(true);
    // With full junction coverage on the changed source, NO conservative sweep
    // is forced by this source (it has proven citations).
  });

  it('re-compiles ALL cross-source pages conservatively when junction coverage is absent', () => {
    // Production reality: the junction is empty. A changed source therefore has
    // no proven citations, so EVERY cross-source page must be swept in — we can’t
    // prove a synthesis page didn’t draw on the changed source. Fail toward
    // freshness, never toward staleness.
    insertSource(db, { id: 'src-a', path: 'raw/notes/a.md', hash: 'OLD' });
    insertCompilation(db, {
      id: 'cmp-a-sum',
      sourceId: 'src-a',
      type: 'summary',
      outputPath: 'wiki/sources/a.md',
    });
    insertCompilation(db, {
      id: 'cmp-topic',
      sourceId: null,
      type: 'topic',
      outputPath: 'wiki/topics/t.md',
    });
    insertCompilation(db, {
      id: 'cmp-contra',
      sourceId: null,
      type: 'contradiction',
      outputPath: 'wiki/contradictions/c.md',
    });
    insertCompilation(db, {
      id: 'cmp-gap',
      sourceId: null,
      type: 'open-question',
      outputPath: 'wiki/open-questions/q.md',
    });
    // NOTE: no compilation_sources rows — the empty-junction production case.

    const result = computeAffectedSet(db, [{ path: 'raw/notes/a.md', hash: 'NEW' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.conservativeSweep).toBe(true);
    const ids = new Set(result.value.affectedPages.map((p) => p.compilationId));
    // Own summary + all three cross-source pages must all be recompiled.
    expect(ids.has('cmp-a-sum')).toBe(true);
    expect(ids.has('cmp-topic')).toBe(true);
    expect(ids.has('cmp-contra')).toBe(true);
    expect(ids.has('cmp-gap')).toBe(true);
    const topic = result.value.affectedPages.find((p) => p.compilationId === 'cmp-topic');
    expect(topic?.reason).toBe('cross-source-conservative');
  });

  it('marks a page UNAFFECTED only when the hash is byte-identical (provably safe)', () => {
    // The ONLY case the diff is allowed to skip: reported changed but the hash
    // matches the DB → same bytes → nothing derived can be stale.
    insertSource(db, { id: 'src-a', path: 'raw/notes/a.md', hash: 'SAME' });
    insertCompilation(db, {
      id: 'cmp-a-sum',
      sourceId: 'src-a',
      type: 'summary',
      outputPath: 'wiki/sources/a.md',
    });
    insertCompilation(db, {
      id: 'cmp-topic',
      sourceId: null,
      type: 'topic',
      outputPath: 'wiki/topics/t.md',
    });

    const result = computeAffectedSet(db, [{ path: 'raw/notes/a.md', hash: 'SAME' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.unchangedSourcePaths).toEqual(['raw/notes/a.md']);
    expect(result.value.changedSourcePaths).toEqual([]);
    // Nothing recompiles for a byte-identical source, and NO conservative sweep.
    expect(result.value.affectedPages).toEqual([]);
    expect(result.value.conservativeSweep).toBe(false);
  });

  it('treats a brand-new source path as new and sweeps cross-source pages', () => {
    // A path with no `sources` record is new content. Its own page doesn’t exist
    // yet, but a synthesis may need to incorporate it → conservative sweep.
    insertCompilation(db, {
      id: 'cmp-topic',
      sourceId: null,
      type: 'topic',
      outputPath: 'wiki/topics/t.md',
    });

    const result = computeAffectedSet(db, [{ path: 'raw/notes/brand-new.md', hash: 'NEW' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.newSourcePaths).toEqual(['raw/notes/brand-new.md']);
    expect(result.value.conservativeSweep).toBe(true);
    const ids = result.value.affectedPages.map((p) => p.compilationId);
    expect(ids).toContain('cmp-topic');
  });

  it('is deterministic and deduplicates by compilation id with the most specific reason', () => {
    // A source that both owns a page AND is cited by a topic, with an empty
    // junction on a SECOND changed source forcing a sweep — the topic qualifies
    // via both the citation AND the sweep; the more specific reason must win.
    insertSource(db, { id: 'src-a', path: 'raw/notes/a.md', hash: 'OLD-A' });
    insertSource(db, { id: 'src-b', path: 'raw/notes/b.md', hash: 'OLD-B' });
    insertCompilation(db, {
      id: 'cmp-topic',
      sourceId: null,
      type: 'topic',
      outputPath: 'wiki/topics/t.md',
    });
    linkCitation(db, 'cmp-topic', 'src-a'); // proven citation from src-a only

    const first = computeAffectedSet(db, [
      { path: 'raw/notes/a.md', hash: 'NEW-A' },
      { path: 'raw/notes/b.md', hash: 'NEW-B' }, // src-b has NO junction → forces sweep
    ]);
    const second = computeAffectedSet(db, [
      { path: 'raw/notes/a.md', hash: 'NEW-A' },
      { path: 'raw/notes/b.md', hash: 'NEW-B' },
    ]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Deterministic: identical output for identical input.
    expect(first.value.affectedPages).toEqual(second.value.affectedPages);
    // No duplicate compilation ids.
    const ids = first.value.affectedPages.map((p) => p.compilationId);
    expect(new Set(ids).size).toBe(ids.length);
    // The topic appears once, with the proven-citation reason (rank ties with
    // source-changed at 3, both beat the conservative sweep at 1).
    const topic = first.value.affectedPages.find((p) => p.compilationId === 'cmp-topic');
    expect(topic?.reason).toBe('cited-source-changed');
  });

  it('returns an empty plan for an empty changed-file list', () => {
    insertSource(db, { id: 'src-a', path: 'raw/notes/a.md', hash: 'H' });
    const result = computeAffectedSet(db, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.affectedPages).toEqual([]);
    expect(result.value.conservativeSweep).toBe(false);
  });
});
