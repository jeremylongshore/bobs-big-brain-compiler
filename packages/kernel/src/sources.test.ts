import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeFileHash,
  getSource,
  isSourceChanged,
  listSources,
  registerSource,
} from './sources.js';
import { closeDatabase, initDatabase } from './state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Opens an in-memory database with migrations applied. */
function openDb(): Database {
  const result = initDatabase(':memory:');
  if (!result.ok) throw new Error(`Failed to open test DB: ${result.error.message}`);
  return result.value;
}

/** Creates a temporary directory for file-based tests. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ico-sources-test-'));
}

/** Writes content to a temp file and returns its absolute path. */
function writeTempFile(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Computes the expected SHA-256 hex digest for a string. */
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('source registry', () => {
  let db: Database;
  let tempDir: string;

  beforeEach(() => {
    db = openDb();
    tempDir = makeTempDir();
  });

  afterEach(() => {
    closeDatabase(db);
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // -------------------------------------------------------------------------
  // registerSource
  // -------------------------------------------------------------------------

  it('registers a source and returns a valid Source record', () => {
    const hash = sha256('hello world');
    const result = registerSource(db, {
      path: 'docs/readme.md',
      type: 'markdown',
      hash,
      title: 'Readme',
      author: 'Alice',
      wordCount: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const source = result.value;
    expect(source.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(source.path).toBe('docs/readme.md');
    expect(source.type).toBe('markdown');
    expect(source.hash).toBe(hash);
    expect(source.title).toBe('Readme');
    expect(source.author).toBe('Alice');
    expect(source.word_count).toBe(2);
    expect(source.ingested_at).toBeTruthy();
    // ISO datetime format
    expect(() => new Date(source.ingested_at)).not.toThrow();
  });

  it('returns the existing record on duplicate (same path + hash)', () => {
    const hash = sha256('content');
    const first = registerSource(db, {
      path: 'raw/file.txt',
      type: 'text',
      hash,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = registerSource(db, {
      path: 'raw/file.txt',
      type: 'text',
      hash,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Must be the same record, not a new insert.
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.hash).toBe(hash);
  });

  it('creates a new record when same path has a different hash', () => {
    const hashA = sha256('version one');
    const hashB = sha256('version two');

    const first = registerSource(db, {
      path: 'raw/evolving.md',
      type: 'markdown',
      hash: hashA,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = registerSource(db, {
      path: 'raw/evolving.md',
      type: 'markdown',
      hash: hashB,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Different ids — two distinct ingestion records.
    expect(second.value.id).not.toBe(first.value.id);
    expect(second.value.hash).toBe(hashB);
  });

  it('stores metadata as JSON-serialised string', () => {
    const hash = sha256('meta content');
    const result = registerSource(db, {
      path: 'raw/meta.pdf',
      type: 'pdf',
      hash,
      metadata: { pages: 42, language: 'en' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // SourceSchema exposes metadata as a string (the raw JSON).
    expect(result.value.metadata).toBe(JSON.stringify({ pages: 42, language: 'en' }));
  });

  // -------------------------------------------------------------------------
  // computeFileHash
  // -------------------------------------------------------------------------

  it('computes the correct SHA-256 hex hash of a file', () => {
    const content = 'deterministic content for hashing';
    const filePath = writeTempFile(tempDir, 'hash-me.txt', content);
    const expected = sha256(content);

    const result = computeFileHash(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(expected);
  });

  it('returns an error for a nonexistent file path', () => {
    const result = computeFileHash(join(tempDir, 'ghost.txt'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/ENOENT/);
  });

  // -------------------------------------------------------------------------
  // isSourceChanged
  // -------------------------------------------------------------------------

  it('returns true for a path with no prior record (new file)', () => {
    const result = isSourceChanged(db, 'brand/new.md', sha256('anything'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);
  });

  it('returns false when the current hash matches the most recent record', () => {
    const hash = sha256('stable');
    registerSource(db, { path: 'stable.txt', type: 'text', hash });

    const result = isSourceChanged(db, 'stable.txt', hash);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });

  it('returns true when the current hash differs from the most recent record', () => {
    const oldHash = sha256('old content');
    const newHash = sha256('new content');
    registerSource(db, { path: 'changed.txt', type: 'text', hash: oldHash });

    const result = isSourceChanged(db, 'changed.txt', newHash);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);
  });

  // -------------------------------------------------------------------------
  // listSources
  // -------------------------------------------------------------------------

  it('returns all registered sources', () => {
    registerSource(db, { path: 'a.md', type: 'markdown', hash: sha256('a') });
    registerSource(db, { path: 'b.txt', type: 'text', hash: sha256('b') });
    registerSource(db, { path: 'c.html', type: 'html', hash: sha256('c') });

    const result = listSources(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(3);
  });

  it('returns an empty array when no sources are registered', () => {
    const result = listSources(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('filters sources by mountId', () => {
    // Register a mount so the foreign key is satisfied.
    const mountId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO mounts (id, name, path, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(mountId, 'test-mount', '/tmp', new Date().toISOString());

    registerSource(db, {
      path: 'mounted/a.md',
      type: 'markdown',
      hash: sha256('mounted-a'),
      mountId,
    });
    registerSource(db, {
      path: 'unmounted/b.txt',
      type: 'text',
      hash: sha256('unmounted-b'),
      // no mountId
    });

    const result = listSources(db, mountId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBe(1);
    expect(result.value[0]!.path).toBe('mounted/a.md');
  });

  it('returns sources ordered by ingested_at descending', async () => {
    // Insert two records with different paths, ensuring distinct timestamps.
    registerSource(db, { path: 'first.md', type: 'markdown', hash: sha256('first') });
    await new Promise((resolve) => setTimeout(resolve, 5));
    registerSource(db, { path: 'second.md', type: 'markdown', hash: sha256('second') });

    const result = listSources(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The most recently inserted record should come first.
    expect(result.value[0]!.path).toBe('second.md');
    expect(result.value[1]!.path).toBe('first.md');
  });

  // -------------------------------------------------------------------------
  // getSource
  // -------------------------------------------------------------------------

  it('retrieves a source by id', () => {
    const hash = sha256('fetchable');
    const reg = registerSource(db, {
      path: 'fetch/me.txt',
      type: 'text',
      hash,
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;

    const result = getSource(db, reg.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toBeNull();
    expect(result.value?.id).toBe(reg.value.id);
    expect(result.value?.path).toBe('fetch/me.txt');
    expect(result.value?.hash).toBe(hash);
  });

  it('returns null (not an error) for a nonexistent id', () => {
    const result = getSource(db, '00000000-0000-4000-8000-000000000000');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });
});
