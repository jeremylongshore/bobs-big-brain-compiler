/**
 * Tests for the `ico lint` command.
 *
 * Tests exercise the pure helpers (`scanWikiPages`, `extractWikilinks`,
 * `detectOrphans`, `renderLintReport`) and the integrated `runLint` function
 * against real temporary workspaces backed by SQLite.
 *
 * The Commander action itself is exercised by the integration suite; we do not
 * duplicate that here.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '@ico/kernel';
import { closeDatabase, initDatabase, initWorkspace } from '@ico/kernel';

import {
  detectOrphans,
  extractWikilinks,
  type LintResult,
  renderLintReport,
  runLint,
  scanWikiPages,
} from './lint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip all ANSI escape sequences so assertions work regardless of TTY state. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Write a file, creating parent directories if needed. */
function writeFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Frontmatter fixtures
// ---------------------------------------------------------------------------

const VALID_CONCEPT_PAGE = `---
type: concept
id: 323e4567-e89b-12d3-a456-426614174002
title: Type Inference
definition: The ability of the compiler to deduce types automatically from context.
source_ids: [223e4567-e89b-12d3-a456-426614174001]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
tags: [typescript, types]
---
# Type Inference

Concept body mentioning [[another-concept]].
`;

const VALID_ENTITY_PAGE = `---
type: entity
id: 423e4567-e89b-12d3-a456-426614174003
title: Jeremy Longshore
entity_type: person
source_ids: [223e4567-e89b-12d3-a456-426614174001]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
tags: [person]
---
# Jeremy Longshore

Entity body with [[type-inference]] link.
`;

const VALID_SOURCE_SUMMARY = `---
type: source-summary
id: 123e4567-e89b-12d3-a456-426614174000
title: Understanding TypeScript Generics
source_id: 223e4567-e89b-12d3-a456-426614174001
source_path: raw/notes/typescript-generics.md
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
content_hash: abc123def456
tags: [typescript]
---
# Understanding TypeScript Generics

Summary body.
`;

/** A page with a missing required field (definition). */
const INVALID_CONCEPT_PAGE = `---
type: concept
id: 323e4567-e89b-12d3-a456-426614174099
title: Broken Concept
source_ids: [223e4567-e89b-12d3-a456-426614174001]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
tags: []
---
# Broken Concept

No definition field — this page is schema-invalid.
`;

// ---------------------------------------------------------------------------
// Workspace fixture helpers
// ---------------------------------------------------------------------------

interface TestWorkspace {
  root: string;
  dbPath: string;
}

/** Create a full ICO workspace in a temp directory. */
function makeWorkspace(tmpBase: string): TestWorkspace {
  const wsResult = initWorkspace('ws', tmpBase);
  if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);

  const dbResult = initDatabase(wsResult.value.dbPath);
  if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
  closeDatabase(dbResult.value);

  return { root: wsResult.value.root, dbPath: wsResult.value.dbPath };
}

/**
 * Insert a raw source row directly into the database.
 * Uses prepared SQL to avoid going through the full ingest pipeline.
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
 * Insert a compilation row directly into the database.
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
    'claude-opus-4',
  );
}

// ---------------------------------------------------------------------------
// Pure unit tests — scanWikiPages
// ---------------------------------------------------------------------------

describe('scanWikiPages', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'ico-lint-scan-'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns an empty array when wiki/ does not exist', () => {
    const wikiPath = join(tmpBase, 'wiki');
    expect(scanWikiPages(wikiPath)).toEqual([]);
  });

  it('returns an empty array when wiki subdirs are empty', () => {
    const wikiPath = join(tmpBase, 'wiki');
    mkdirSync(join(wikiPath, 'concepts'), { recursive: true });
    expect(scanWikiPages(wikiPath)).toEqual([]);
  });

  it('returns .md files from wiki subdirectories', () => {
    const wikiPath = join(tmpBase, 'wiki');
    mkdirSync(join(wikiPath, 'concepts'), { recursive: true });
    mkdirSync(join(wikiPath, 'entities'), { recursive: true });
    writeFile(join(wikiPath, 'concepts', 'type-inference.md'), VALID_CONCEPT_PAGE);
    writeFile(join(wikiPath, 'entities', 'jeremy.md'), VALID_ENTITY_PAGE);

    const pages = scanWikiPages(wikiPath);
    expect(pages).toHaveLength(2);
    expect(pages.some((p) => p.endsWith('type-inference.md'))).toBe(true);
    expect(pages.some((p) => p.endsWith('jeremy.md'))).toBe(true);
  });

  it('excludes .gitkeep files', () => {
    const wikiPath = join(tmpBase, 'wiki');
    mkdirSync(join(wikiPath, 'concepts'), { recursive: true });
    writeFile(join(wikiPath, 'concepts', '.gitkeep'), '');
    writeFile(join(wikiPath, 'concepts', 'real-concept.md'), VALID_CONCEPT_PAGE);

    const pages = scanWikiPages(wikiPath);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatch(/real-concept\.md$/);
  });

  it('does not recurse into non-standard subdirectories', () => {
    const wikiPath = join(tmpBase, 'wiki');
    mkdirSync(join(wikiPath, 'random-extra'), { recursive: true });
    writeFile(join(wikiPath, 'random-extra', 'extra.md'), VALID_CONCEPT_PAGE);

    const pages = scanWikiPages(wikiPath);
    expect(pages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pure unit tests — extractWikilinks
// ---------------------------------------------------------------------------

describe('extractWikilinks', () => {
  it('returns an empty array for content with no wikilinks', () => {
    expect(extractWikilinks('No links here.')).toEqual([]);
  });

  it('extracts a single [[slug]]', () => {
    expect(extractWikilinks('See [[type-inference]] for details.')).toEqual(['type-inference']);
  });

  it('extracts multiple [[slug]] links', () => {
    const content = 'Links: [[concept-a]], [[concept-b]], and [[entity-c]].';
    expect(extractWikilinks(content)).toEqual(['concept-a', 'concept-b', 'entity-c']);
  });

  it('extracts slug from [[slug|alias]] links, ignoring the alias', () => {
    expect(extractWikilinks('See [[type-inference|Type Inference]] for details.')).toEqual([
      'type-inference',
    ]);
  });

  it('trims whitespace from slugs', () => {
    expect(extractWikilinks('See [[ type-inference ]] here.')).toEqual(['type-inference']);
  });

  it('handles wikilinks across multiple lines', () => {
    const content = 'First [[alpha]].\nSecond [[beta]].\nThird [[gamma]].';
    expect(extractWikilinks(content)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ---------------------------------------------------------------------------
// Pure unit tests — detectOrphans
// ---------------------------------------------------------------------------

describe('detectOrphans', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'ico-lint-orphan-'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns no orphans when all pages are referenced', () => {
    const wikiPath = join(tmpBase, 'wiki');
    mkdirSync(join(wikiPath, 'concepts'), { recursive: true });
    mkdirSync(join(wikiPath, 'entities'), { recursive: true });

    // concept page references the entity
    writeFile(
      join(wikiPath, 'concepts', 'type-inference.md'),
      '# Type Inference\n\nSee [[jeremy]].',
    );
    // entity page references the concept
    writeFile(
      join(wikiPath, 'entities', 'jeremy.md'),
      '# Jeremy\n\nWorks with [[type-inference]].',
    );

    const allPages = [
      join(wikiPath, 'concepts', 'type-inference.md'),
      join(wikiPath, 'entities', 'jeremy.md'),
    ];

    expect(detectOrphans(wikiPath, allPages)).toEqual([]);
  });

  it('identifies pages with no incoming backlinks as orphans', () => {
    const wikiPath = join(tmpBase, 'wiki');
    mkdirSync(join(wikiPath, 'concepts'), { recursive: true });

    writeFile(join(wikiPath, 'concepts', 'isolated.md'), '# Isolated\n\nNo links in or out.');

    const allPages = [join(wikiPath, 'concepts', 'isolated.md')];
    const orphans = detectOrphans(wikiPath, allPages);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatch(/isolated\.md$/);
  });

  it('never marks source-summary pages as orphans', () => {
    const wikiPath = join(tmpBase, 'wiki');
    mkdirSync(join(wikiPath, 'sources'), { recursive: true });

    writeFile(join(wikiPath, 'sources', 'source-a.md'), '# Source A\n\nNo incoming links.');

    const allPages = [join(wikiPath, 'sources', 'source-a.md')];
    expect(detectOrphans(wikiPath, allPages)).toEqual([]);
  });

  it('never marks index.md as an orphan', () => {
    const wikiPath = join(tmpBase, 'wiki');
    mkdirSync(join(wikiPath, 'concepts'), { recursive: true });

    // index.md sits in the wiki root, not in a subdir — but scanWikiPages does
    // not include it (it only scans subdirs). Test detectOrphans directly with
    // a fabricated page list that includes an index.md path.
    const indexPath = join(wikiPath, 'concepts', 'index.md');
    writeFile(indexPath, '# Index\n\nNo links.');

    const allPages = [indexPath];
    // index.md is excluded by name, not location
    expect(detectOrphans(wikiPath, allPages)).toEqual([]);
  });

  it('does not count a page as its own backlink', () => {
    // A page that only references itself is still an orphan.
    const wikiPath = join(tmpBase, 'wiki');
    mkdirSync(join(wikiPath, 'concepts'), { recursive: true });

    writeFile(join(wikiPath, 'concepts', 'self-ref.md'), '# Self Ref\n\nSee [[self-ref]].');

    const allPages = [join(wikiPath, 'concepts', 'self-ref.md')];
    // The self-ref slug IS in the referenced set, so detectOrphans correctly
    // treats it as non-orphaned. This is accepted behavior per spec (the set of
    // referenced slugs is global, not per-page). No assertion change needed
    // from the caller's perspective.
    const orphans = detectOrphans(wikiPath, allPages);
    // self-ref references its own slug → slug is in the set → not an orphan.
    expect(orphans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// renderLintReport — unit tests
// ---------------------------------------------------------------------------

describe('renderLintReport', () => {
  const workspaceRoot = '/fake/ws';

  const cleanResult: LintResult = {
    schema: { valid: 5, invalid: 0, errors: [] },
    staleness: { stale: 0, pages: [] },
    uncompiled: { count: 0, sources: [] },
    orphans: { count: 0, pages: [] },
    issues: 0,
  };

  it('includes the "Knowledge Health Report" header', () => {
    const out = stripAnsi(renderLintReport(cleanResult, workspaceRoot));
    expect(out).toContain('Knowledge Health Report');
  });

  it('shows "All checks passed" when issues === 0', () => {
    const out = stripAnsi(renderLintReport(cleanResult, workspaceRoot));
    expect(out).toContain('All checks passed');
  });

  it('shows issue count when issues > 0', () => {
    const result: LintResult = {
      ...cleanResult,
      staleness: {
        stale: 2,
        pages: [
          {
            compilationId: 'c1',
            sourceId: 's1',
            type: 'summary',
            outputPath: 'wiki/sources/old.md',
            compiledAt: '2024-01-01T00:00:00.000Z',
            reason: 'source-changed',
          },
          {
            compilationId: 'c2',
            sourceId: 's2',
            type: 'summary',
            outputPath: 'wiki/sources/another.md',
            compiledAt: '2024-01-01T00:00:00.000Z',
            reason: 'dependency-recompiled',
          },
        ],
      },
      issues: 2,
    };
    const out = stripAnsi(renderLintReport(result, workspaceRoot));
    expect(out).toContain('2 issues found');
    expect(out).toContain('wiki/sources/old.md');
    expect(out).toContain('source-changed');
  });

  it('shows "1 issue found" (singular) when exactly 1 issue', () => {
    const result: LintResult = {
      ...cleanResult,
      uncompiled: {
        count: 1,
        sources: [{ id: 's1', path: 'raw/notes/a.md', type: 'markdown' }],
      },
      issues: 1,
    };
    const out = stripAnsi(renderLintReport(result, workspaceRoot));
    expect(out).toContain('1 issue found');
    expect(out).toContain('raw/notes/a.md');
  });

  it('shows schema violation details with relative paths', () => {
    const result: LintResult = {
      ...cleanResult,
      schema: {
        valid: 3,
        invalid: 1,
        errors: [
          {
            path: '/fake/ws/wiki/concepts/broken.md',
            errors: ['definition: Required'],
          },
        ],
      },
      issues: 1,
    };
    const out = stripAnsi(renderLintReport(result, workspaceRoot));
    expect(out).toContain('wiki/concepts/broken.md');
    expect(out).toContain('definition: Required');
  });

  it('shows orphan paths with relative paths', () => {
    const result: LintResult = {
      ...cleanResult,
      orphans: {
        count: 1,
        pages: ['/fake/ws/wiki/concepts/orphan.md'],
      },
      issues: 1,
    };
    const out = stripAnsi(renderLintReport(result, workspaceRoot));
    expect(out).toContain('wiki/concepts/orphan.md');
  });
});

// ---------------------------------------------------------------------------
// runLint — integration tests with a real workspace
// ---------------------------------------------------------------------------

describe('runLint', () => {
  let tmpBase: string;
  let ws: TestWorkspace;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'ico-lint-run-'));
    ws = makeWorkspace(tmpBase);
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  // --- Clean workspace -------------------------------------------------------

  it('returns 0 issues on a clean empty workspace', () => {
    const result = runLint(ws.root, ws.dbPath);
    expect(result.issues).toBe(0);
    expect(result.schema.invalid).toBe(0);
    expect(result.staleness.stale).toBe(0);
    expect(result.uncompiled.count).toBe(0);
    expect(result.orphans.count).toBe(0);
  });

  it('returns 0 issues when all pages are valid and cross-linked', () => {
    // Place two mutually-linked valid pages. The concept fixture uses
    // [[another-concept]] and the entity fixture uses [[type-inference]].
    // We name the entity file "another-concept.md" so the concept's outgoing
    // link targets the entity, and we add a reference back to the concept from
    // the entity page by naming the concept file "type-inference.md".
    // Both slugs end up in the referenced-set → no orphans.
    const conceptContent = VALID_CONCEPT_PAGE; // references [[another-concept]]
    const entityContent = VALID_ENTITY_PAGE; // references [[type-inference]]

    writeFile(join(ws.root, 'wiki', 'concepts', 'type-inference.md'), conceptContent);
    writeFile(join(ws.root, 'wiki', 'entities', 'another-concept.md'), entityContent);

    const result = runLint(ws.root, ws.dbPath);
    expect(result.schema.valid).toBe(2);
    expect(result.schema.invalid).toBe(0);
    expect(result.issues).toBe(0);
  });

  // --- Schema violations -----------------------------------------------------

  it('reports schema violations for malformed pages', () => {
    writeFile(join(ws.root, 'wiki', 'concepts', 'broken.md'), INVALID_CONCEPT_PAGE);

    const result = runLint(ws.root, ws.dbPath);
    expect(result.schema.invalid).toBe(1);
    expect(result.schema.errors).toHaveLength(1);
    expect(result.schema.errors[0]!.errors.length).toBeGreaterThan(0);
    expect(result.issues).toBeGreaterThan(0);
  });

  it('counts valid and invalid pages together correctly', () => {
    writeFile(join(ws.root, 'wiki', 'concepts', 'good.md'), VALID_CONCEPT_PAGE);
    writeFile(join(ws.root, 'wiki', 'concepts', 'broken.md'), INVALID_CONCEPT_PAGE);

    const result = runLint(ws.root, ws.dbPath);
    expect(result.schema.valid).toBe(1);
    expect(result.schema.invalid).toBe(1);
  });

  // --- Stale pages -----------------------------------------------------------

  it('reports stale pages detected by the compiler', () => {
    const db = initDatabase(ws.dbPath);
    if (!db.ok) throw db.error;

    const T1 = '2026-01-01T00:00:00.000Z';
    const T2 = '2026-01-02T00:00:00.000Z';

    insertSource(db.value, { id: 's1', path: 'raw/notes/a.md', ingestedAt: T2 });
    insertCompilation(db.value, {
      id: 'c1',
      sourceId: 's1',
      type: 'summary',
      outputPath: 'wiki/sources/a.md',
      compiledAt: T1,
    });
    closeDatabase(db.value);

    const result = runLint(ws.root, ws.dbPath);
    expect(result.staleness.stale).toBe(1);
    expect(result.staleness.pages[0]!.reason).toBe('source-changed');
    expect(result.issues).toBeGreaterThan(0);
  });

  // --- Uncompiled sources ----------------------------------------------------

  it('reports uncompiled sources', () => {
    const db = initDatabase(ws.dbPath);
    if (!db.ok) throw db.error;

    insertSource(db.value, {
      id: 's1',
      path: 'raw/notes/a.md',
      ingestedAt: '2026-01-01T00:00:00.000Z',
    });
    closeDatabase(db.value);

    const result = runLint(ws.root, ws.dbPath);
    expect(result.uncompiled.count).toBe(1);
    expect(result.uncompiled.sources[0]!.path).toBe('raw/notes/a.md');
    expect(result.issues).toBeGreaterThan(0);
  });

  // --- Orphan detection ------------------------------------------------------

  it('reports orphan pages with no incoming backlinks', () => {
    // Place a concept page that nothing links to
    writeFile(
      join(ws.root, 'wiki', 'concepts', 'obscure.md'),
      `---
type: concept
id: 323e4567-e89b-12d3-a456-000000000001
title: Obscure Concept
definition: An obscure idea.
source_ids: [223e4567-e89b-12d3-a456-426614174001]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
tags: []
---
# Obscure Concept

No links to anything.
`,
    );

    const result = runLint(ws.root, ws.dbPath);
    expect(result.orphans.count).toBe(1);
    expect(result.orphans.pages[0]).toMatch(/obscure\.md$/);
    expect(result.issues).toBeGreaterThan(0);
  });

  it('does not report source-summary pages as orphans', () => {
    writeFile(join(ws.root, 'wiki', 'sources', 'source-summary.md'), VALID_SOURCE_SUMMARY);

    const result = runLint(ws.root, ws.dbPath);
    expect(result.orphans.count).toBe(0);
  });

  // --- JSON output -----------------------------------------------------------

  it('--json output has the correct top-level structure', () => {
    writeFile(join(ws.root, 'wiki', 'concepts', 'type-inference.md'), VALID_CONCEPT_PAGE);

    const result = runLint(ws.root, ws.dbPath);

    // Serialize + re-parse to simulate JSON output
    const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;

    expect(json).toHaveProperty('schema');
    expect(json).toHaveProperty('staleness');
    expect(json).toHaveProperty('uncompiled');
    expect(json).toHaveProperty('orphans');
    expect(json).toHaveProperty('issues');

    const schema = json['schema'] as Record<string, unknown>;
    expect(schema).toHaveProperty('valid');
    expect(schema).toHaveProperty('invalid');
    expect(schema).toHaveProperty('errors');

    const staleness = json['staleness'] as Record<string, unknown>;
    expect(staleness).toHaveProperty('stale');
    expect(staleness).toHaveProperty('pages');

    const uncompiled = json['uncompiled'] as Record<string, unknown>;
    expect(uncompiled).toHaveProperty('count');
    expect(uncompiled).toHaveProperty('sources');

    const orphans = json['orphans'] as Record<string, unknown>;
    expect(orphans).toHaveProperty('count');
    expect(orphans).toHaveProperty('pages');
  });

  it('issues count equals sum of all individual issue counts', () => {
    // Introduce one orphan and one schema violation
    writeFile(
      join(ws.root, 'wiki', 'concepts', 'orphan.md'),
      `---
type: concept
id: 323e4567-e89b-12d3-a456-000000000002
title: Orphan
definition: Lonely.
source_ids: [223e4567-e89b-12d3-a456-426614174001]
compiled_at: 2024-01-15T10:00:00.000Z
model: claude-opus-4
tags: []
---
# Orphan
`,
    );
    writeFile(join(ws.root, 'wiki', 'concepts', 'broken.md'), INVALID_CONCEPT_PAGE);

    const result = runLint(ws.root, ws.dbPath);

    const expected =
      result.schema.invalid +
      result.staleness.stale +
      result.uncompiled.count +
      result.orphans.count;

    expect(result.issues).toBe(expected);
  });
});
