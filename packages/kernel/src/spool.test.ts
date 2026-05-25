/**
 * Tests for the spool emitter (spool.ts).
 *
 * Each test creates a fresh temporary workspace via `initWorkspace` plus an
 * in-memory SQLite database. The workspace is seeded with compiled wiki
 * pages in the conventional subdirectories so the emitter has real input to
 * walk.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ICO_AUTHOR, SPOOL_CONTENT_MAX_BYTES, SpoolMemoryCandidateSchema } from '@ico/types';

import { dryRunSpool, emitSpool, SpoolError } from './spool.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { readTraces } from './traces.js';
import { initWorkspace } from './workspace.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workspacePath: string;
let db: Database;

function writeFile(absPath: string, content: string): void {
  mkdirSync(resolve(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
}

function seedWikiPage(
  type: 'source-summary' | 'concept' | 'topic' | 'entity' | 'contradiction' | 'open-question',
  subdir: string,
  filename: string,
  title: string,
  body: string,
): void {
  const fm = [
    '---',
    `type: ${type}`,
    `title: ${title}`,
    'id: 00000000-0000-4000-8000-000000000000',
    'compiled_at: 2026-05-23T00:00:00.000Z',
    'model: claude-sonnet-4-6',
    '---',
  ].join('\n');
  writeFile(join(workspacePath, 'wiki', subdir, filename), `${fm}\n\n${body}\n`);
}

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'ico-spool-test-'));
  const initResult = initWorkspace('workspace', tmp);
  if (!initResult.ok) {
    throw initResult.error;
  }
  workspacePath = initResult.value.root;
  // initDatabase returns Result<Database, Error> — must unwrap. Use the
  // file-backed DB from the freshly-init'd workspace so migrations apply
  // exactly once.
  const dbResult = initDatabase(join(workspacePath, '.ico', 'state.db'));
  if (!dbResult.ok) {
    throw dbResult.error;
  }
  db = dbResult.value;
});

afterEach(() => {
  closeDatabase(db);
  if (existsSync(workspacePath)) {
    rmSync(resolve(workspacePath, '..'), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitSpool', () => {
  it('refuses to emit when tenantId is absent or empty', () => {
    const r1 = emitSpool(db, workspacePath, { scope: 'wiki', tenantId: '' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error).toBeInstanceOf(SpoolError);
      expect((r1.error as SpoolError).code).toBe('NO_TENANT_ID');
    }
    // Defensive: even non-string sneaks through type checks
    const r2 = emitSpool(db, workspacePath, {
      scope: 'wiki',
      // @ts-expect-error — deliberately bad
      tenantId: undefined,
    });
    expect(r2.ok).toBe(false);
  });

  it('emits one candidate per compiled wiki page and writes manifest sidecar', () => {
    seedWikiPage(
      'source-summary',
      'sources',
      'attention.md',
      'Attention paper',
      'A source summary body.',
    );
    seedWikiPage('concept', 'concepts', 'self-attention.md', 'Self-attention', 'A concept body.');

    const r = emitSpool(db, workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.emittedCount).toBe(2);
    expect(r.value.skipped.length).toBe(0);
    expect(existsSync(r.value.spoolFile)).toBe(true);
    expect(existsSync(r.value.manifestFile)).toBe(true);

    // Each line is a valid SpoolMemoryCandidate.
    const lines = readFileSync(r.value.spoolFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const parsed = SpoolMemoryCandidateSchema.safeParse(JSON.parse(line));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.author).toEqual(ICO_AUTHOR);
        expect(parsed.data.tenantId).toBe('ico-test');
        expect(parsed.data.schemaVersion).toBe('1');
        expect(parsed.data.status).toBe('inbox');
        expect(parsed.data.source).toBe('import');
        expect(parsed.data.capturedAt).toMatch(/Z$/); // Zod 4 datetime constraint
      }
    }

    // Manifest carries the SHA-256 + count + emit timestamp.
    const manifest = JSON.parse(readFileSync(r.value.manifestFile, 'utf-8')) as {
      schemaVersion: string;
      emittedCount: number;
      spoolFileSha256: string;
      spoolFileBytes: number;
      emittedAt: string;
      candidateIds: string[];
    };
    expect(manifest.schemaVersion).toBe('1');
    expect(manifest.emittedCount).toBe(2);
    expect(manifest.spoolFileSha256).toBe(r.value.spoolFileSha256);
    expect(manifest.spoolFileBytes).toBe(r.value.spoolFileBytes);
    expect(manifest.candidateIds.length).toBe(2);

    // SHA-256 in manifest matches recomputed SHA-256 of the file body.
    const raw = readFileSync(r.value.spoolFile, 'utf-8');
    const recomputed = createHash('sha256').update(raw, 'utf-8').digest('hex');
    expect(manifest.spoolFileSha256).toBe(recomputed);
  });

  it('emits deterministic UUID v5 IDs — same content → same ID across runs', () => {
    seedWikiPage('topic', 'topics', 'transformers.md', 'Transformers', 'A topic body.');
    const r1 = emitSpool(db, workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const id1 = (
      JSON.parse(readFileSync(r1.value.spoolFile, 'utf-8').trim().split('\n')[0]!) as { id: string }
    ).id;

    // Second emit on unchanged page → same candidate ID.
    const r2 = emitSpool(db, workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const id2 = (
      JSON.parse(readFileSync(r2.value.spoolFile, 'utf-8').trim().split('\n')[0]!) as { id: string }
    ).id;
    expect(id2).toBe(id1);

    // Changing the body → different candidate ID.
    writeFile(
      join(workspacePath, 'wiki', 'topics', 'transformers.md'),
      [
        '---',
        'type: topic',
        'title: Transformers',
        'id: 00000000-0000-4000-8000-000000000000',
        'compiled_at: 2026-05-23T00:00:00.000Z',
        'model: claude-sonnet-4-6',
        '---',
        '',
        'A DIFFERENT body.',
        '',
      ].join('\n'),
    );
    const r3 = emitSpool(db, workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const id3 = (
      JSON.parse(readFileSync(r3.value.spoolFile, 'utf-8').trim().split('\n')[0]!) as { id: string }
    ).id;
    expect(id3).not.toBe(id1);
  });

  it('rejects candidates whose content body exceeds the 64 KB cap (does NOT truncate)', () => {
    const oversize = 'x'.repeat(SPOOL_CONTENT_MAX_BYTES + 1);
    seedWikiPage('topic', 'topics', 'big.md', 'Big', oversize);

    const r = emitSpool(db, workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.emittedCount).toBe(0);
    expect(r.value.skipped.length).toBe(1);
    expect(r.value.skipped[0]!.code).toBe('CONTENT_TOO_LARGE');
    expect(r.value.skipped[0]!.path).toBe('wiki/topics/big.md');
  });

  it('skips semantic-index pages with a SEMANTIC_INDEX_SKIPPED reason', () => {
    // Place a semantic-index page in the wiki root index location.
    writeFile(
      join(workspacePath, 'wiki', 'topics', 'index-fake.md'),
      ['---', 'type: semantic-index', 'title: Fake index', '---', '', 'index body'].join('\n'),
    );
    const r = emitSpool(db, workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.emittedCount).toBe(0);
    expect(r.value.skipped.find((s) => s.code === 'SEMANTIC_INDEX_SKIPPED')).toBeDefined();
  });

  it('emits both spool.emit.start and spool.emit.complete trace events', () => {
    seedWikiPage('concept', 'concepts', 'foo.md', 'Foo', 'foo body');
    const r = emitSpool(db, workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
    expect(r.ok).toBe(true);
    const tracesResult = readTraces(db);
    expect(tracesResult.ok).toBe(true);
    if (!tracesResult.ok) return;
    const eventTypes = tracesResult.value.map((t) => t.event_type);
    expect(eventTypes).toContain('spool.emit.start');
    expect(eventTypes).toContain('spool.emit.complete');
  });

  it('maps each compiled page type to the documented INTKB category', () => {
    seedWikiPage('source-summary', 'sources', 'a.md', 'a', 'body a');
    seedWikiPage('concept', 'concepts', 'b.md', 'b', 'body b');
    seedWikiPage('topic', 'topics', 'c.md', 'c', 'body c');
    seedWikiPage('entity', 'entities', 'd.md', 'd', 'body d');
    seedWikiPage('contradiction', 'contradictions', 'e.md', 'e', 'body e');
    seedWikiPage('open-question', 'open-questions', 'f.md', 'f', 'body f');

    const r = emitSpool(db, workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.emittedCount).toBe(6);

    const cats: Record<string, string> = {};
    for (const line of readFileSync(r.value.spoolFile, 'utf-8').trim().split('\n')) {
      const c = JSON.parse(line) as { category: string; metadata: { filePaths: string[] } };
      cats[c.metadata.filePaths[0]!] = c.category;
    }
    expect(cats['wiki/sources/a.md']).toBe('reference');
    expect(cats['wiki/concepts/b.md']).toBe('pattern');
    expect(cats['wiki/topics/c.md']).toBe('architecture');
    expect(cats['wiki/entities/d.md']).toBe('reference');
    expect(cats['wiki/contradictions/e.md']).toBe('troubleshooting');
    expect(cats['wiki/open-questions/f.md']).toBe('reference');
  });
});

describe('dryRunSpool', () => {
  it('returns wouldEmit + skipped without writing to disk', () => {
    seedWikiPage('topic', 'topics', 't.md', 't', 'body');
    const r = dryRunSpool(workspacePath, { scope: 'wiki', tenantId: 'ico-test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wouldEmit.length).toBe(1);
    expect(r.value.wouldEmit[0]!.contentBytes).toBeGreaterThan(0);
    // Critical: no file in the spool dir.
    expect(existsSync(join(workspacePath, 'spool'))).toBe(false);
  });

  it('refuses dry-run without tenantId', () => {
    const r = dryRunSpool(workspacePath, { scope: 'wiki', tenantId: '' });
    expect(r.ok).toBe(false);
  });
});
