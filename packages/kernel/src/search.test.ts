import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSearchIndex, indexCompiledPages, searchPages } from './search.js';
import { closeDatabase, initDatabase } from './state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Opens an in-memory database and asserts it succeeded. */
function openDb(): Database {
  const result = initDatabase(':memory:');
  if (!result.ok) throw new Error(`Failed to open test DB: ${result.error.message}`);
  return result.value;
}

/** Build a temporary workspace with the full wiki directory tree. */
function makeTempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ico-search-test-'));
  for (const dir of [
    'sources',
    'concepts',
    'entities',
    'topics',
    'contradictions',
    'open-questions',
  ]) {
    mkdirSync(resolve(root, 'wiki', dir), { recursive: true });
  }
  return root;
}

/**
 * Write a compiled markdown page with YAML frontmatter and a body.
 *
 * @param workspacePath - Workspace root.
 * @param subdir        - Wiki subdirectory (e.g. 'concepts').
 * @param filename      - File name including `.md` extension.
 * @param type          - Page type for the `type:` frontmatter field.
 * @param title         - Page title.
 * @param body          - Optional body text after the frontmatter block.
 * @param tags          - Optional tags string for frontmatter.
 */
function writeFixturePage(
  workspacePath: string,
  subdir: string,
  filename: string,
  type: string,
  title: string,
  body = 'This is the default body content.',
  tags = '',
): void {
  const filePath = resolve(workspacePath, 'wiki', subdir, filename);
  const lines = [
    '---',
    `type: ${type}`,
    `title: ${title}`,
    `id: 00000000-0000-0000-0000-000000000001`,
    `compiled_at: 2026-01-01T00:00:00.000Z`,
    `model: claude-sonnet-4-6`,
  ];
  if (tags !== '') {
    lines.push(`tags: ${tags}`);
  }
  lines.push('---', '', `# ${title}`, '', body, '');
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('search', () => {
  let db: Database;
  let workspacePath: string;

  beforeEach(() => {
    db = openDb();
    workspacePath = makeTempWorkspace();
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(workspacePath, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // createSearchIndex
  // -------------------------------------------------------------------------

  describe('createSearchIndex', () => {
    it('creates the FTS5 virtual table without error', () => {
      const result = createSearchIndex(db);
      expect(result.ok).toBe(true);
    });

    it('is idempotent — calling twice does not error', () => {
      const first = createSearchIndex(db);
      expect(first.ok).toBe(true);

      const second = createSearchIndex(db);
      expect(second.ok).toBe(true);
    });

    it('creates a table named pages_fts that accepts inserts', () => {
      const init = createSearchIndex(db);
      expect(init.ok).toBe(true);

      // If the table was not created this would throw and the test would fail.
      expect(() => {
        db.prepare(
          'INSERT INTO pages_fts(path, title, type, tags, body) VALUES (?, ?, ?, ?, ?)',
        ).run('wiki/test.md', 'Test', 'concept', '', 'Some body text');
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // indexCompiledPages
  // -------------------------------------------------------------------------

  describe('indexCompiledPages', () => {
    beforeEach(() => {
      const init = createSearchIndex(db);
      if (!init.ok) throw new Error('createSearchIndex failed in beforeEach');
    });

    it('indexes fixture pages and returns the correct count', () => {
      writeFixturePage(workspacePath, 'sources', 'src.md', 'source-summary', 'My Source');
      writeFixturePage(workspacePath, 'concepts', 'cpt.md', 'concept', 'My Concept');
      writeFixturePage(workspacePath, 'topics', 'tpc.md', 'topic', 'My Topic');

      const result = indexCompiledPages(db, workspacePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(3);
    });

    it('returns 0 when the wiki directories are empty', () => {
      const result = indexCompiledPages(db, workspacePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });

    it('re-indexing replaces old entries (count stays accurate)', () => {
      writeFixturePage(workspacePath, 'concepts', 'a.md', 'concept', 'Alpha');

      const first = indexCompiledPages(db, workspacePath);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value).toBe(1);

      // Add another page and re-index.
      writeFixturePage(workspacePath, 'concepts', 'b.md', 'concept', 'Beta');

      const second = indexCompiledPages(db, workspacePath);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value).toBe(2);
    });

    it('indexes pages from all six wiki subdirectories', () => {
      writeFixturePage(workspacePath, 'sources', 's.md', 'source-summary', 'S');
      writeFixturePage(workspacePath, 'concepts', 'c.md', 'concept', 'C');
      writeFixturePage(workspacePath, 'entities', 'e.md', 'entity', 'E');
      writeFixturePage(workspacePath, 'topics', 't.md', 'topic', 'T');
      writeFixturePage(workspacePath, 'contradictions', 'x.md', 'contradiction', 'X');
      writeFixturePage(workspacePath, 'open-questions', 'q.md', 'open-question', 'Q');

      const result = indexCompiledPages(db, workspacePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // searchPages
  // -------------------------------------------------------------------------

  describe('searchPages', () => {
    beforeEach(() => {
      const init = createSearchIndex(db);
      if (!init.ok) throw new Error('createSearchIndex failed in beforeEach');
    });

    it('finds a page by a keyword present in the body', () => {
      writeFixturePage(
        workspacePath,
        'concepts',
        'photosynthesis.md',
        'concept',
        'Photosynthesis',
        'Plants convert sunlight into glucose through photosynthesis.',
      );
      indexCompiledPages(db, workspacePath);

      const result = searchPages(db, 'photosynthesis');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value[0]!.path).toBe('concepts/photosynthesis.md');
    });

    it('finds a page by a keyword present in the title', () => {
      writeFixturePage(
        workspacePath,
        'topics',
        'quantum.md',
        'topic',
        'Quantum Computing',
        'An overview of qubit-based computation.',
      );
      indexCompiledPages(db, workspacePath);

      const result = searchPages(db, 'quantum');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value[0]!.title).toBe('Quantum Computing');
    });

    it('returns SearchResult objects with the expected shape', () => {
      writeFixturePage(
        workspacePath,
        'concepts',
        'entropy.md',
        'concept',
        'Entropy',
        'Entropy measures disorder in a thermodynamic system.',
      );
      indexCompiledPages(db, workspacePath);

      const result = searchPages(db, 'entropy');

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [hit] = result.value;
      expect(hit).toBeDefined();
      if (!hit) return;

      expect(typeof hit.path).toBe('string');
      expect(typeof hit.title).toBe('string');
      expect(typeof hit.type).toBe('string');
      expect(typeof hit.snippet).toBe('string');
      expect(typeof hit.rank).toBe('number');
    });

    it('returns ranked results — snippet contains the highlighted term', () => {
      writeFixturePage(
        workspacePath,
        'concepts',
        'evolution.md',
        'concept',
        'Evolution',
        'Natural selection drives evolution in biological populations.',
      );
      indexCompiledPages(db, workspacePath);

      const result = searchPages(db, 'evolution');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeGreaterThan(0);

      const snippet = result.value[0]!.snippet;
      // FTS5 snippet wraps matched tokens in <b>…</b>
      expect(snippet).toMatch(/<b>/);
    });

    it('returns an empty array when no pages match the query', () => {
      writeFixturePage(
        workspacePath,
        'concepts',
        'biology.md',
        'concept',
        'Biology',
        'The study of living organisms.',
      );
      indexCompiledPages(db, workspacePath);

      const result = searchPages(db, 'xyzzy_nonexistent_token_12345');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it('phrase search matches exact multi-word sequences', () => {
      writeFixturePage(
        workspacePath,
        'topics',
        'climate.md',
        'topic',
        'Climate Change',
        'Global warming accelerates climate change across all biomes.',
      );
      writeFixturePage(
        workspacePath,
        'topics',
        'change-mgmt.md',
        'topic',
        'Change Management',
        'Organizational change requires strong leadership and communication.',
      );
      indexCompiledPages(db, workspacePath);

      const result = searchPages(db, '"climate change"');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Should match the climate page but not the change-management page
      expect(result.value.length).toBeGreaterThan(0);
      const paths = result.value.map((r) => r.path);
      expect(paths).toContain('topics/climate.md');
    });

    it('respects the limit parameter', () => {
      // Create 5 pages all containing the keyword 'cosmos'
      for (let i = 1; i <= 5; i++) {
        writeFixturePage(
          workspacePath,
          'concepts',
          `cosmos-${i}.md`,
          'concept',
          `Cosmos ${i}`,
          `The cosmos is vast and cosmos ${i} is a unique exploration of space.`,
        );
      }
      indexCompiledPages(db, workspacePath);

      const result = searchPages(db, 'cosmos', 3);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeLessThanOrEqual(3);
    });

    it('default limit caps results at 20', () => {
      // Create 25 pages all containing the keyword 'nebula'
      for (let i = 1; i <= 25; i++) {
        writeFixturePage(
          workspacePath,
          'concepts',
          `nebula-${i}.md`,
          'concept',
          `Nebula ${i}`,
          `A nebula is an interstellar cloud. Instance ${i}.`,
        );
      }
      indexCompiledPages(db, workspacePath);

      const result = searchPages(db, 'nebula');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeLessThanOrEqual(20);
    });
  });
});
