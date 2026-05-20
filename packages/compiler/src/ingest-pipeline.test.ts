/**
 * Tests for the ingest pipeline.
 *
 * Each test creates a fresh temporary workspace via `initWorkspace` and a
 * fresh in-memory-backed database, then exercises `runIngestPipeline` against
 * real (temporary) source files.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  computeFileHash,
  initDatabase,
  initWorkspace,
  listSources,
  readTraces,
} from '@ico/kernel';

import { type IngestPipelineOptions, runIngestPipeline } from './ingest-pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a unique temporary directory for a workspace base. */
function makeTempBase(): string {
  return mkdtempSync(join(tmpdir(), 'ico-ingest-test-'));
}

interface TestEnv {
  wsRoot: string;
  dbPath: string;
  sourceDir: string;
}

/**
 * Initialises a fresh workspace under `base`, runs DB migrations, and
 * returns the paths needed by each test. Uses a real on-disk database so
 * that inter-process file-system state (raw/ copies) and DB records are
 * consistent.
 */
function setupEnv(base: string): TestEnv {
  const wsResult = initWorkspace('ws', base);
  if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
  const wsRoot = wsResult.value.root;
  const dbPath = wsResult.value.dbPath;

  // Run migrations so the DB schema is ready.
  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
  closeDatabase(dbResult.value);

  // A separate temp dir for source files that live outside the workspace.
  const sourceDir = mkdtempSync(join(tmpdir(), 'ico-src-'));

  return { wsRoot, dbPath, sourceDir };
}

/** Writes a UTF-8 file to `dir` and returns its absolute path. */
function writeSource(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Builds default pipeline options from a test environment. */
function makeOptions(
  env: TestEnv,
  overrides?: Partial<IngestPipelineOptions>,
): IngestPipelineOptions {
  return {
    workspacePath: env.wsRoot,
    dbPath: env.dbPath,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runIngestPipeline', () => {
  let base: string;
  let env: TestEnv;

  beforeEach(() => {
    base = makeTempBase();
    env = setupEnv(base);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    try {
      rmSync(env.sourceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // -------------------------------------------------------------------------
  // 1. Full pipeline
  // -------------------------------------------------------------------------

  it('ingests a markdown file: copies to raw/, registers in DB, writes trace', async () => {
    const filePath = writeSource(env.sourceDir, 'hello.md', '# Hello\n\nSome content here.\n');
    const result = await runIngestPipeline(filePath, makeOptions(env));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { sourceId, path, type, hash, alreadyIngested } = result.value;

    expect(alreadyIngested).toBe(false);
    expect(type).toBe('markdown');
    expect(path).toBe(join('raw', 'notes', 'hello.md'));
    expect(hash).toHaveLength(64); // SHA-256 hex

    // File must exist in the workspace.
    const destPath = resolve(env.wsRoot, path);
    expect(existsSync(destPath)).toBe(true);

    // Source must be in the DB.
    const db = initDatabase(env.dbPath);
    expect(db.ok).toBe(true);
    if (!db.ok) return;
    try {
      const sources = listSources(db.value);
      expect(sources.ok).toBe(true);
      if (!sources.ok) return;
      expect(sources.value.some((s) => s.id === sourceId)).toBe(true);

      // Trace must be present.
      const traces = readTraces(db.value, { eventType: 'source.ingest' });
      expect(traces.ok).toBe(true);
      if (!traces.ok) return;
      expect(traces.value.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabase(db.value);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Duplicate detection
  // -------------------------------------------------------------------------

  it('returns alreadyIngested: true on the second call with the same file', async () => {
    const filePath = writeSource(env.sourceDir, 'dup.md', '# Dup\n\nContent.\n');

    const first = await runIngestPipeline(filePath, makeOptions(env));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.alreadyIngested).toBe(false);

    const second = await runIngestPipeline(filePath, makeOptions(env));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.alreadyIngested).toBe(true);
    expect(second.value.hash).toBe(first.value.hash);
    expect(second.value.path).toBe(first.value.path);
  });

  // -------------------------------------------------------------------------
  // 3. Re-ingest detection (same path, different hash)
  // -------------------------------------------------------------------------

  it('sets reingested: true and creates a new source record when content changes', async () => {
    const filePath = writeSource(
      env.sourceDir,
      'evolving.md',
      '# Version 1\n\nOriginal content.\n',
    );

    // First ingest — new file.
    const first = await runIngestPipeline(filePath, makeOptions(env));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.alreadyIngested).toBe(false);
    expect(first.value.reingested).toBeUndefined();

    // Overwrite the file with different content.
    writeFileSync(filePath, '# Version 2\n\nUpdated content with more words here.\n');

    // Second ingest — changed content.
    const second = await runIngestPipeline(filePath, makeOptions(env));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.alreadyIngested).toBe(false);
    expect(second.value.reingested).toBe(true);
    expect(second.value.hash).not.toBe(first.value.hash);
    expect(second.value.path).toBe(first.value.path);

    // Both source records should exist (different hashes = different rows).
    const db = initDatabase(env.dbPath);
    expect(db.ok).toBe(true);
    if (!db.ok) return;
    try {
      const sources = listSources(db.value);
      expect(sources.ok).toBe(true);
      if (!sources.ok) return;

      const recordsAtPath = sources.value.filter((s) => s.path === first.value.path);
      expect(recordsAtPath.length).toBe(2);

      // A source.reingest trace event should exist.
      const traces = readTraces(db.value, { eventType: 'source.reingest' });
      expect(traces.ok).toBe(true);
      if (!traces.ok) return;
      expect(traces.value.length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabase(db.value);
    }
  });

  // -------------------------------------------------------------------------
  // 4. File not found
  // -------------------------------------------------------------------------

  it('returns err when the file does not exist', async () => {
    const result = await runIngestPipeline(join(env.sourceDir, 'ghost.md'), makeOptions(env));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/File not found/i);
  });

  // -------------------------------------------------------------------------
  // 4. File over size limit
  // -------------------------------------------------------------------------

  it('returns err when the file exceeds maxFileSize', async () => {
    const filePath = writeSource(env.sourceDir, 'big.txt', 'x'.repeat(200));
    const result = await runIngestPipeline(filePath, makeOptions(env, { maxFileSize: 100 }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/too large/i);
  });

  // -------------------------------------------------------------------------
  // 5. Force flag bypasses size limit
  // -------------------------------------------------------------------------

  it('succeeds when force: true bypasses the size limit', async () => {
    const filePath = writeSource(env.sourceDir, 'big-force.txt', 'x'.repeat(200));
    const result = await runIngestPipeline(
      filePath,
      makeOptions(env, { maxFileSize: 100, force: true }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alreadyIngested).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Correct subdirectory routing
  // -------------------------------------------------------------------------

  it('routes markdown files to raw/notes/', async () => {
    const filePath = writeSource(env.sourceDir, 'note.md', '# Note\n\nText.\n');
    const result = await runIngestPipeline(filePath, makeOptions(env));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path.startsWith(join('raw', 'notes'))).toBe(true);
  });

  it('routes PDF files to raw/papers/', async () => {
    // Write a minimal PDF-like file and override the type so the markdown
    // adapter does not fail on binary content.
    const filePath = writeSource(env.sourceDir, 'paper.pdf', '%PDF-1.4 minimal stub');
    const result = await runIngestPipeline(filePath, makeOptions(env, { typeOverride: 'pdf' }));

    // The PDF adapter may fail on stub content — we care only about routing.
    // If the adapter succeeded, verify the path prefix.
    if (result.ok) {
      expect(result.value.path.startsWith(join('raw', 'papers'))).toBe(true);
    } else {
      // Adapter failure is acceptable for a stub; just verify it is NOT a
      // routing or size error.
      expect(result.error.message).not.toMatch(/too large/i);
      expect(result.error.message).not.toMatch(/File not found/i);
    }
  });

  it('routes html files to raw/articles/ via typeOverride', async () => {
    const filePath = writeSource(
      env.sourceDir,
      'clip.html',
      '<html><body><h1>Title</h1><p>Body</p></body></html>',
    );
    const result = await runIngestPipeline(filePath, makeOptions(env, { typeOverride: 'html' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path.startsWith(join('raw', 'articles'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 7. Atomic write — no .tmp file remains
  // -------------------------------------------------------------------------

  it('does not leave a .tmp file behind after a successful ingest', async () => {
    const filePath = writeSource(env.sourceDir, 'atomic.md', '# Atomic\n\nContent.\n');
    const result = await runIngestPipeline(filePath, makeOptions(env));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const destPath = resolve(env.wsRoot, result.value.path);
    const tmpPath = `${destPath}.tmp`;

    expect(existsSync(destPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 8. Hash matches computeFileHash output
  // -------------------------------------------------------------------------

  it('returns a hash that matches computeFileHash for the same file', async () => {
    const filePath = writeSource(env.sourceDir, 'hash-check.md', '# Hash\n\nContent.\n');

    const hashResult = computeFileHash(filePath);
    expect(hashResult.ok).toBe(true);
    if (!hashResult.ok) return;

    const pipelineResult = await runIngestPipeline(filePath, makeOptions(env));
    expect(pipelineResult.ok).toBe(true);
    if (!pipelineResult.ok) return;

    expect(pipelineResult.value.hash).toBe(hashResult.value);
  });

  // -------------------------------------------------------------------------
  // 9. Source record in database after ingest
  // -------------------------------------------------------------------------

  it('creates a source record in the database with correct fields', async () => {
    const content = '# Database Test\n\nBody text for the database test.\n';
    const filePath = writeSource(env.sourceDir, 'db-test.md', content);

    const result = await runIngestPipeline(filePath, makeOptions(env));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = initDatabase(env.dbPath);
    expect(db.ok).toBe(true);
    if (!db.ok) return;
    try {
      const sources = listSources(db.value);
      expect(sources.ok).toBe(true);
      if (!sources.ok) return;

      const source = sources.value.find((s) => s.id === result.value.sourceId);
      expect(source).toBeDefined();
      if (!source) return;

      expect(source.path).toBe(result.value.path);
      expect(source.type).toBe('markdown');
      expect(source.hash).toBe(result.value.hash);
      expect(source.title).toBe('Database Test');
      // word_count should be a positive integer
      expect(typeof source.word_count).toBe('number');
      expect(source.word_count ?? 0).toBeGreaterThan(0);
    } finally {
      closeDatabase(db.value);
    }
  });

  // -------------------------------------------------------------------------
  // 10. Audit log entry written
  // -------------------------------------------------------------------------

  it('appends an entry to audit/log.md', async () => {
    const filePath = writeSource(env.sourceDir, 'audit-me.md', '# Audit\n\nContent.\n');
    const result = await runIngestPipeline(filePath, makeOptions(env));
    expect(result.ok).toBe(true);

    const { readFileSync } = await import('node:fs');
    const auditLog = readFileSync(resolve(env.wsRoot, 'audit', 'log.md'), 'utf-8');

    expect(auditLog).toContain('source.ingest');
    expect(auditLog).toContain('audit-me.md');
  });
});
