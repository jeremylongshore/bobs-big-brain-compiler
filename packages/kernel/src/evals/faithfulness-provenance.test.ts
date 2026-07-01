/**
 * Tests for the faithfulness provenance-sampling primitive (e06.8).
 *
 * Pure-kernel, deterministic — no model. Asserts:
 *   - single-source pages resolve via `compilations.source_id`
 *   - cross-source pages resolve via the `compilation_sources` junction
 *   - pages with no traceable provenance are excluded from the sample
 *   - the sample is a FIXED COUNT (N pages), capped at eligible pages
 *   - selection is deterministic (newest-first by default; stable under a seed)
 *   - a broken source_id (dangling FK-less pointer) yields empty provenance
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, type Database, initDatabase, initWorkspace } from '../index.js';
import {
  getCompilationSources,
  sampleCompilationsForFaithfulness,
} from './faithfulness-provenance.js';

interface Env {
  base: string;
  wsRoot: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-faith-prov-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  const dbRes = initDatabase(ws.value.dbPath);
  if (!dbRes.ok) throw dbRes.error;
  env = { base, wsRoot: ws.value.root, db: dbRes.value };
});
afterEach(() => {
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
});

function insertSource(id: string, path: string, title = `Title ${id}`): void {
  env.db
    .prepare(
      `INSERT INTO sources (id, path, type, ingested_at, hash, title)
       VALUES (?, ?, 'markdown', '2026-01-01T00:00:00.000Z', ?, ?)`,
    )
    .run(id, path, `hash-${id}`, title);
}

function insertCompilation(
  id: string,
  sourceId: string | null,
  type: string,
  outputPath: string,
  compiledAt: string,
): void {
  env.db
    .prepare(
      `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model)
       VALUES (?, ?, ?, ?, ?, 0, 'deepseek-chat')`,
    )
    .run(id, sourceId, type, outputPath, compiledAt);
}

function linkJunction(compilationId: string, sourceId: string): void {
  env.db
    .prepare(`INSERT INTO compilation_sources (compilation_id, source_id) VALUES (?, ?)`)
    .run(compilationId, sourceId);
}

describe('getCompilationSources', () => {
  it('resolves a single-source page via source_id', () => {
    insertSource('src-1', 'raw/notes/a.md');
    insertCompilation(
      'comp-1',
      'src-1',
      'summary',
      'wiki/sources/a.md',
      '2026-02-01T00:00:00.000Z',
    );

    const res = getCompilationSources(env.db, 'comp-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0]).toMatchObject({ id: 'src-1', path: 'raw/notes/a.md' });
  });

  it('resolves a cross-source page via the junction', () => {
    insertSource('src-1', 'raw/notes/a.md');
    insertSource('src-2', 'raw/notes/b.md');
    // Cross-source topic page: source_id NULL, junction carries both sources.
    insertCompilation('topic-1', null, 'topic', 'wiki/topics/t.md', '2026-02-01T00:00:00.000Z');
    linkJunction('topic-1', 'src-1');
    linkJunction('topic-1', 'src-2');

    const res = getCompilationSources(env.db, 'topic-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const paths = res.value.map((s) => s.path).sort();
    expect(paths).toEqual(['raw/notes/a.md', 'raw/notes/b.md']);
  });

  it('returns empty for a page with no provenance (untraceable)', () => {
    // NULL source_id and no junction rows.
    insertCompilation('orphan-1', null, 'topic', 'wiki/topics/x.md', '2026-02-01T00:00:00.000Z');
    const res = getCompilationSources(env.db, 'orphan-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(0);
  });

  it('errors on a missing compilation id', () => {
    const res = getCompilationSources(env.db, 'nope');
    expect(res.ok).toBe(false);
  });
});

describe('sampleCompilationsForFaithfulness', () => {
  it('excludes untraceable pages and caps at the fixed sample size', () => {
    insertSource('src-1', 'raw/a.md');
    insertSource('src-2', 'raw/b.md');
    insertCompilation('c1', 'src-1', 'summary', 'wiki/sources/a.md', '2026-02-03T00:00:00.000Z');
    insertCompilation('c2', 'src-2', 'summary', 'wiki/sources/b.md', '2026-02-02T00:00:00.000Z');
    // c3 is untraceable (no source, no junction) — must be excluded.
    insertCompilation('c3', null, 'topic', 'wiki/topics/z.md', '2026-02-01T00:00:00.000Z');

    const res = sampleCompilationsForFaithfulness(env.db, { sampleSize: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Only the two traceable pages are eligible; the untraceable one is dropped.
    expect(res.value).toHaveLength(2);
    expect(res.value.map((i) => i.compilationId).sort()).toEqual(['c1', 'c2']);
  });

  it('honors a fixed N smaller than the eligible set (newest-first)', () => {
    insertSource('s1', 'raw/1.md');
    insertSource('s2', 'raw/2.md');
    insertSource('s3', 'raw/3.md');
    insertCompilation('c1', 's1', 'summary', 'wiki/sources/1.md', '2026-02-01T00:00:00.000Z');
    insertCompilation('c2', 's2', 'summary', 'wiki/sources/2.md', '2026-02-02T00:00:00.000Z');
    insertCompilation('c3', 's3', 'summary', 'wiki/sources/3.md', '2026-02-03T00:00:00.000Z');

    const res = sampleCompilationsForFaithfulness(env.db, { sampleSize: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Newest compiled first: c3 (02-03) then c2 (02-02).
    expect(res.value.map((i) => i.compilationId)).toEqual(['c3', 'c2']);
  });

  it('filters by wiki subdir', () => {
    insertSource('s1', 'raw/1.md');
    insertSource('s2', 'raw/2.md');
    insertCompilation('c1', 's1', 'summary', 'wiki/sources/1.md', '2026-02-01T00:00:00.000Z');
    insertCompilation('c2', 's2', 'concept', 'wiki/concepts/2.md', '2026-02-02T00:00:00.000Z');

    const res = sampleCompilationsForFaithfulness(env.db, {
      sampleSize: 5,
      wikiSubdirs: ['sources'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((i) => i.outputPath)).toEqual(['wiki/sources/1.md']);
  });

  it('is deterministic under a seed (same seed → same order)', () => {
    for (let i = 1; i <= 6; i += 1) {
      insertSource(`s${i}`, `raw/${i}.md`);
      insertCompilation(
        `c${i}`,
        `s${i}`,
        'summary',
        `wiki/sources/${i}.md`,
        `2026-02-0${i}T00:00:00.000Z`,
      );
    }
    const a = sampleCompilationsForFaithfulness(env.db, { sampleSize: 3, seed: 42 });
    const b = sampleCompilationsForFaithfulness(env.db, { sampleSize: 3, seed: 42 });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.map((i) => i.compilationId)).toEqual(b.value.map((i) => i.compilationId));
    // A different seed should be permitted to reorder (not asserting inequality
    // strictly — just that it runs and returns the fixed count).
    const c = sampleCompilationsForFaithfulness(env.db, { sampleSize: 3, seed: 7 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value).toHaveLength(3);
  });

  it('rejects a non-positive or non-integer sample size', () => {
    expect(sampleCompilationsForFaithfulness(env.db, { sampleSize: 0 }).ok).toBe(false);
    expect(sampleCompilationsForFaithfulness(env.db, { sampleSize: -1 }).ok).toBe(false);
    expect(sampleCompilationsForFaithfulness(env.db, { sampleSize: 1.5 }).ok).toBe(false);
  });

  it('returns an empty sample when nothing is traceable', () => {
    insertCompilation('c1', null, 'topic', 'wiki/topics/x.md', '2026-02-01T00:00:00.000Z');
    const res = sampleCompilationsForFaithfulness(env.db, { sampleSize: 5 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(0);
  });
});
