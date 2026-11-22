/**
 * Tests for the `ico ingest` command logic.
 *
 * All tests exercise `runIngest` directly — no process spawning needed.
 * Filesystem operations are performed against real temporary directories
 * so we validate actual side-effects (file copies, database records, traces).
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@ico/kernel';
import {
  closeDatabase,
  getMountByName,
  initDatabase,
  initWorkspace,
  readTraces,
  registerMount,
} from '@ico/kernel';

import * as writeLock from '../lib/write-lock.js';
import {
  detectSourceType,
  type GlobalOptions,
  type IngestOptions,
  runBatchIngest,
  runIngest,
  scanDirectory,
  showPreview,
  slugify,
} from './ingest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), 'ico-ingest-test-'));
}

/** Create a file at `filePath` with the given text content. */
function writeFile(filePath: string, content = 'test content'): void {
  writeFileSync(filePath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

/** A real PDF with hex-encoded text: raw UTF-8 scanning cannot see its words. */
function hexTextPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 100 700 Td <${Buffer.from(text).toString('hex')}> Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /MediaBox [0 0 612 792] /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

/** Include every file and directory, including SQLite, raw, trace and audit surfaces. */
function snapshot(root: string, prefix = ''): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      result.set(`${relative}/`, Buffer.alloc(0));
      for (const [name, bytes] of snapshot(root, relative)) result.set(name, bytes);
    } else result.set(relative, readFileSync(join(root, relative)));
  }
  return result;
}

function expectUnchanged(root: string, before: Map<string, Buffer>): void {
  const after = snapshot(root);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [name, bytes] of before) expect(after.get(name)?.equals(bytes), name).toBe(true);
}

describe('runIngest', () => {
  let tempBase: string;
  let workspaceRoot: string;
  let db: Database;

  const globalOpts = (): GlobalOptions => ({ workspace: workspaceRoot, json: false });
  const ingestOpts = (): IngestOptions => ({});

  beforeEach(() => {
    tempBase = tmpBase();

    // Initialize a real ICO workspace.
    const wsResult = initWorkspace('ws', tempBase);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    workspaceRoot = wsResult.value.root;

    // Migrate the database.
    const dbResult = initDatabase(wsResult.value.dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    db = dbResult.value;
    // Close here — runIngest will open its own connection.
    closeDatabase(db);

    // Suppress stdout/stderr output during tests.
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempBase, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path — text file
  // -------------------------------------------------------------------------

  it.each(['replace', 'remove'] as const)(
    'persists the scanned snapshot when the source changes before mutation: %s',
    async (change) => {
      const path = join(tempBase, 'snapshot.txt');
      const captured = Buffer.from('Synthetic captured text that passed disclosure checks.\n');
      writeFileSync(path, captured);
      chmodSync(path, 0o600);
      if (change === 'replace') {
        const destination = join(workspaceRoot, 'raw/notes/snapshot.txt');
        writeFileSync(destination, 'Earlier synthetic destination');
        chmodSync(destination, 0o644);
      }
      const originalLock = writeLock.withBrainWriteLock;
      vi.spyOn(writeLock, 'withBrainWriteLock').mockImplementation(async (fn) => {
        if (change === 'replace') {
          writeFileSync(path, 'Different bytes that were never scanned.');
          chmodSync(path, 0o644);
        } else rmSync(path);
        return originalLock(fn);
      });
      const result = await runIngest(path, ingestOpts(), globalOpts());
      if (!result.ok) throw result.error;
      const expectedHash = createHash('sha256').update(captured).digest('hex');
      expect(readFileSync(join(workspaceRoot, result.value.path))).toEqual(captured);
      expect(result.value.hash).toBe(expectedHash);
      expect(statSync(join(workspaceRoot, result.value.path)).mode & 0o777).toBe(0o600);
      const opened = initDatabase(join(workspaceRoot, '.ico/state.db'));
      if (!opened.ok) throw opened.error;
      try {
        expect(
          opened.value.prepare('SELECT hash FROM sources WHERE id = ?').get(result.value.id),
        ).toEqual({ hash: expectedHash });
      } finally {
        closeDatabase(opened.value);
      }
    },
  );

  it('ingests a text file and copies it to raw/notes/', async () => {
    const srcFile = join(tempBase, 'notes.txt');
    writeFile(srcFile);

    const result = await runIngest(srcFile, ingestOpts(), globalOpts());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.type).toBe('text');
    expect(result.value.path).toBe('raw/notes/notes.txt');
    expect(existsSync(join(workspaceRoot, 'raw', 'notes', 'notes.txt'))).toBe(true);
  });

  it('registers the text file in the database', async () => {
    const srcFile = join(tempBase, 'notes.txt');
    writeFile(srcFile);

    const result = await runIngest(srcFile, ingestOpts(), globalOpts());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(typeof result.value.id).toBe('string');
    expect(result.value.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // -------------------------------------------------------------------------
  // Happy path — markdown file
  // -------------------------------------------------------------------------

  it('ingests a markdown file and copies it to raw/notes/', async () => {
    const srcFile = join(tempBase, 'my-note.md');
    writeFile(srcFile, '# Hello\n\nSome content.');

    const result = await runIngest(srcFile, ingestOpts(), globalOpts());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.type).toBe('markdown');
    expect(result.value.path).toBe('raw/notes/my-note.md');
    expect(existsSync(join(workspaceRoot, 'raw', 'notes', 'my-note.md'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // No-op re-ingest (same hash)
  // -------------------------------------------------------------------------

  it('returns alreadyIngested=true and no duplicate when re-ingesting the same file', async () => {
    const srcFile = join(tempBase, 'doc.txt');
    writeFile(srcFile, 'stable content');

    // First ingest
    const first = await runIngest(srcFile, ingestOpts(), globalOpts());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Second ingest — same file, same content
    const second = await runIngest(srcFile, ingestOpts(), globalOpts());
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.alreadyIngested).toBe(true);
    expect(second.value.id).toBe(first.value.id);
  });

  it('does not create a second database record on re-ingest', async () => {
    const srcFile = join(tempBase, 'doc.txt');
    writeFile(srcFile, 'stable content');

    await runIngest(srcFile, ingestOpts(), globalOpts());
    await runIngest(srcFile, ingestOpts(), globalOpts());

    // Open DB and count sources at the same relative path.
    const wsResult = initWorkspace('ws', tempBase);
    if (!wsResult.ok) throw wsResult.error;
    const dbPath = join(workspaceRoot, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const localDb = dbResult.value;

    try {
      const rows = localDb
        .prepare<
          [string],
          { count: number }
        >('SELECT COUNT(*) as count FROM sources WHERE path = ?')
        .get('raw/notes/doc.txt');
      expect(rows?.count).toBe(1);
    } finally {
      closeDatabase(localDb);
    }
  });

  it('does not mark prior compilations stale when the content hash is unchanged', async () => {
    const srcFile = join(tempBase, 'stable-with-compilation.txt');
    writeFile(srcFile, 'stable content');

    const first = await runIngest(srcFile, ingestOpts(), globalOpts());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const dbPath = join(workspaceRoot, '.ico', 'state.db');
    const beforeNoOp = initDatabase(dbPath);
    if (!beforeNoOp.ok) throw beforeNoOp.error;
    beforeNoOp.value
      .prepare(
        `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, model)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'stable-compilation',
        first.value.id,
        'summary',
        'wiki/sources/stable-with-compilation.txt.md',
        first.value.ingestedAt,
        'test-model',
      );
    closeDatabase(beforeNoOp.value);

    const second = await runIngest(srcFile, ingestOpts(), globalOpts());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.alreadyIngested).toBe(true);

    const afterNoOp = initDatabase(dbPath);
    if (!afterNoOp.ok) throw afterNoOp.error;
    try {
      const row = afterNoOp.value
        .prepare<[string], { stale: number }>('SELECT stale FROM compilations WHERE id = ?')
        .get('stable-compilation');
      expect(row?.stale).toBe(0);
    } finally {
      closeDatabase(afterNoOp.value);
    }
  });

  it('marks superseded direct and cross-source compilations stale on changed ingest', async () => {
    const srcFile = join(tempBase, 'stale-chain.txt');
    writeFile(srcFile, 'version one');

    const first = await runIngest(srcFile, ingestOpts(), globalOpts());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const dbPath = join(workspaceRoot, '.ico', 'state.db');
    const beforeChange = initDatabase(dbPath);
    if (!beforeChange.ok) throw beforeChange.error;
    beforeChange.value
      .prepare(
        `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, model)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'stale-direct',
        first.value.id,
        'summary',
        'wiki/sources/stale-chain.txt.md',
        first.value.ingestedAt,
        'test-model',
      );
    beforeChange.value
      .prepare(
        `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, model)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'stale-cross',
        null,
        'topic',
        'wiki/topics/stale-chain.md',
        first.value.ingestedAt,
        'test-model',
      );
    beforeChange.value
      .prepare('INSERT INTO compilation_sources (compilation_id, source_id) VALUES (?, ?)')
      .run('stale-cross', first.value.id);
    closeDatabase(beforeChange.value);

    writeFile(srcFile, 'version two');
    const second = await runIngest(srcFile, ingestOpts(), globalOpts());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.id).not.toBe(first.value.id);

    const afterChange = initDatabase(dbPath);
    if (!afterChange.ok) throw afterChange.error;
    try {
      const rows = afterChange.value
        .prepare<
          [],
          { id: string; stale: number }
        >('SELECT id, stale FROM compilations ORDER BY id')
        .all();
      expect(rows).toEqual([
        { id: 'stale-cross', stale: 1 },
        { id: 'stale-direct', stale: 1 },
      ]);
    } finally {
      closeDatabase(afterChange.value);
    }
  });

  it('records mount provenance and advances last_indexed_at after successful ingest', async () => {
    const mountRoot = join(tempBase, 'mounted-corpus');
    mkdirSync(mountRoot, { recursive: true });

    const setupDb = initDatabase(join(workspaceRoot, '.ico', 'state.db'));
    if (!setupDb.ok) throw setupDb.error;
    const mount = registerMount(setupDb.value, 'mounted-corpus', mountRoot);
    expect(mount.ok).toBe(true);
    closeDatabase(setupDb.value);

    const srcFile = join(mountRoot, 'mounted-note.txt');
    writeFile(srcFile, 'mounted content');
    const result = await runIngest(srcFile, ingestOpts(), globalOpts());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verifyDb = initDatabase(join(workspaceRoot, '.ico', 'state.db'));
    if (!verifyDb.ok) throw verifyDb.error;
    try {
      const source = verifyDb.value
        .prepare<[string], { mount_id: string | null }>('SELECT mount_id FROM sources WHERE id = ?')
        .get(result.value.id);
      expect(source?.mount_id).toBe(mount.ok ? mount.value.id : null);

      const storedMount = getMountByName(verifyDb.value, 'mounted-corpus');
      expect(storedMount.ok).toBe(true);
      if (!storedMount.ok) return;
      expect(storedMount.value?.last_indexed_at).toBeTruthy();
    } finally {
      closeDatabase(verifyDb.value);
    }
  });

  // -------------------------------------------------------------------------
  // --title option
  // -------------------------------------------------------------------------

  it('sets title in the source record when --title is provided', async () => {
    const srcFile = join(tempBase, 'paper.txt');
    writeFile(srcFile, 'research content');

    const result = await runIngest(srcFile, { title: 'My Paper Title' }, globalOpts());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dbPath = join(workspaceRoot, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const localDb = dbResult.value;

    try {
      const row = localDb
        .prepare<[string], { title: string | null }>('SELECT title FROM sources WHERE id = ?')
        .get(result.value.id);
      expect(row?.title).toBe('My Paper Title');
    } finally {
      closeDatabase(localDb);
    }
  });

  // -------------------------------------------------------------------------
  // File not found
  // -------------------------------------------------------------------------

  it('returns an error when the file does not exist', async () => {
    const missingFile = join(tempBase, 'ghost.txt');

    const result = await runIngest(missingFile, ingestOpts(), globalOpts());

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.message).toMatch(/not found/i);
    expect(result.error.message).toContain('ghost.txt');
  });

  // -------------------------------------------------------------------------
  // Disclosure guard — reject comp/PII at the source, before any write
  // -------------------------------------------------------------------------

  it.each([
    ['body.html', '<html><body><p>s&#97;lary</p></body></html>', {}, 'salary'],
    [
      'author.html',
      '<html><head><meta name="author" content="s&#97;lary"></head><body>Neutral body</body></html>',
      {},
      'salary',
    ],
    [
      'lines.html',
      '<html><head><meta name="author" content="50&#47;50&#10;split"></head><body>Neutral body</body></html>',
      {},
      '50/50',
    ],
    ['encoded.pdf', hexTextPdf('salary'), {}, 'salary'],
    ['salary.md', 'Neutral source', {}, 'salary'],
    ['sa!lary.md', 'Neutral source', {}, 'salary'],
    ['salary/source.md', 'Neutral source', {}, 'salary'],
    ['title.txt', 'Neutral source', { title: 'salary' }, 'salary'],
    ['author.txt', 'Neutral source', { author: 'salary' }, 'salary'],
    ['raw.txt', 'salary', {}, 'salary'],
  ] as const)(
    'refuses disclosure without workspace mutation or echoed matches: %s',
    async (name, content, overrides, forbidden) => {
      const seed = join(tempBase, 'seed.txt');
      writeFile(seed, 'Existing neutral knowledge');
      const seeded = await runIngest(seed, {}, globalOpts());
      expect(seeded.ok).toBe(true);
      const path = join(tempBase, name);
      mkdirSync(join(tempBase, 'salary'), { recursive: true });
      writeFileSync(path, content);
      const before = snapshot(workspaceRoot);
      const lock = vi.spyOn(writeLock, 'withBrainWriteLock');
      vi.spyOn(process.stdout, 'write').mockClear();
      vi.spyOn(process.stderr, 'write').mockClear();
      const result = await runIngest(path, { ...overrides, force: true }, globalOpts());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/disclosure check failed/i);
      expect(result.error.message).not.toContain(forbidden);
      expect(result.error.cause).toBeUndefined();
      expect(lock).not.toHaveBeenCalled();
      expect(vi.spyOn(process.stdout, 'write')).not.toHaveBeenCalled();
      expect(vi.spyOn(process.stderr, 'write')).not.toHaveBeenCalled();
      expectUnchanged(workspaceRoot, before);
    },
  );

  it.each([
    ['preview.html', '<html><head><title>s&#97;lary</title></head><body>Neutral</body></html>'],
    ['preview.pdf', hexTextPdf('salary')],
    ['salary.txt', 'Neutral source'],
  ] as const)(
    'refuses preview before printing decoded or path content: %s',
    async (name, content) => {
      const path = join(tempBase, name);
      writeFileSync(path, content);
      const before = snapshot(workspaceRoot);
      const error = await showPreview(path, detectSourceType(path), Buffer.byteLength(content));
      expect(error?.message).toMatch(/disclosure check failed/i);
      expect(error?.message).not.toContain('salary');
      expect(vi.spyOn(process.stdout, 'write')).not.toHaveBeenCalled();
      expect(vi.spyOn(process.stderr, 'write')).not.toHaveBeenCalled();
      expectUnchanged(workspaceRoot, before);
    },
  );

  it.each([
    [
      'clean.html',
      '<html><head><title>Useful notes</title></head><body>Neutral facts</body></html>',
    ],
    ['clean.pdf', hexTextPdf('Neutral facts')],
  ] as const)('preserves clean decoded formats: %s', async (name, content) => {
    const path = join(tempBase, name);
    const bytes = Buffer.from(content);
    writeFileSync(path, bytes);
    expect(await showPreview(path, detectSourceType(path), bytes.length)).toBeUndefined();
    const result = await runIngest(path, {}, globalOpts());
    if (!result.ok) throw result.error;
    expect(readFileSync(join(workspaceRoot, result.value.path)).equals(bytes)).toBe(true);
  });

  it('persists the screened override snapshot if the caller changes options at the lock', async () => {
    const path = join(tempBase, 'stable.txt');
    writeFile(path, 'Neutral source');
    const options: IngestOptions = { title: 'Approved title', author: 'Approved author' };
    const originalLock = writeLock.withBrainWriteLock;
    vi.spyOn(writeLock, 'withBrainWriteLock').mockImplementation(async (fn) => {
      options.title = 'salary';
      options.author = 'salary';
      return originalLock(fn);
    });
    const result = await runIngest(path, options, globalOpts());
    if (!result.ok) throw result.error;
    const opened = initDatabase(join(workspaceRoot, '.ico/state.db'));
    if (!opened.ok) throw opened.error;
    try {
      expect(
        opened.value.prepare('SELECT title, author FROM sources WHERE id = ?').get(result.value.id),
      ).toEqual({ title: 'Approved title', author: 'Approved author' });
    } finally {
      closeDatabase(opened.value);
    }
  });

  it('redacts prohibited paths in batch errors', async () => {
    const directory = join(tempBase, 'batch');
    mkdirSync(directory);
    writeFile(join(directory, 'salary.txt'), 'Neutral source');
    const result = await runBatchIngest(directory, {}, globalOpts());
    expect(result.errors).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('salary');
  });

  it('rejects a source containing compensation content and writes nothing', async () => {
    const srcFile = join(tempBase, 'offer.md');
    writeFile(srcFile, 'The package includes a 4-year vesting schedule and stock options.');

    const result = await runIngest(srcFile, ingestOpts(), globalOpts());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/disclosure check failed/i);
    expect(result.error.message).toMatch(/compensation/i);

    // No copy into the workspace and no DB row — the guard ran before any write.
    expect(existsSync(join(workspaceRoot, 'raw', 'notes', 'offer.md'))).toBe(false);
    const dbResult = initDatabase(join(workspaceRoot, '.ico', 'state.db'));
    if (!dbResult.ok) throw dbResult.error;
    const localDb = dbResult.value;
    try {
      const row = localDb.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sources').get();
      expect(row?.n).toBe(0);
    } finally {
      closeDatabase(localDb);
    }
  });

  it('rejects a source containing PII (SSN) at the source', async () => {
    const srcFile = join(tempBase, 'contractor.txt');
    writeFile(srcFile, 'Contractor SSN 123-45-6789 on file for the engagement.');

    const result = await runIngest(srcFile, ingestOpts(), globalOpts());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/disclosure check failed/i);
    expect(result.error.message).toMatch(/PII/);
    expect(existsSync(join(workspaceRoot, 'raw', 'notes', 'contractor.txt'))).toBe(false);
  });

  it('ingests a governance doc that merely names "compensation" in policy text', async () => {
    // The disclosure-tier rule NAMES the forbidden category to forbid it — that bare
    // word must not be rejected, or the brain could never ingest its own doctrine.
    const srcFile = join(tempBase, 'doctrine.md');
    writeFile(
      srcFile,
      'Disclosure tiers: never write compensation or anyone’s pay into this repo.',
    );

    const result = await runIngest(srcFile, ingestOpts(), globalOpts());

    expect(result.ok).toBe(true);
    expect(existsSync(join(workspaceRoot, 'raw', 'notes', 'doctrine.md'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Trace event written
  // -------------------------------------------------------------------------

  it('writes a trace event after successful ingest', async () => {
    const srcFile = join(tempBase, 'traced.txt');
    writeFile(srcFile, 'traceable content');

    const ingestResult = await runIngest(srcFile, ingestOpts(), globalOpts());
    expect(ingestResult.ok).toBe(true);
    if (!ingestResult.ok) return;

    const dbPath = join(workspaceRoot, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    if (!dbResult.ok) throw dbResult.error;
    const localDb = dbResult.value;

    try {
      const tracesResult = readTraces(localDb, { eventType: 'source.ingest' });
      expect(tracesResult.ok).toBe(true);
      if (!tracesResult.ok) return;

      expect(tracesResult.value.length).toBeGreaterThanOrEqual(1);
      const trace = tracesResult.value[0]!;
      expect(trace.event_type).toBe('source.ingest');
    } finally {
      closeDatabase(localDb);
    }
  });

  // -------------------------------------------------------------------------
  // Audit log entry
  // -------------------------------------------------------------------------

  it('appends an entry to audit/log.md after ingest', async () => {
    const srcFile = join(tempBase, 'audited.txt');
    writeFile(srcFile, 'auditable content');

    const result = await runIngest(srcFile, ingestOpts(), globalOpts());
    expect(result.ok).toBe(true);

    const logPath = join(workspaceRoot, 'audit', 'log.md');
    expect(existsSync(logPath)).toBe(true);

    const logContent = readFileSync(logPath, 'utf-8');
    expect(logContent).toContain('source.ingest');
    expect(logContent).toContain('audited.txt');
  });

  // -------------------------------------------------------------------------
  // JSON output mode
  // -------------------------------------------------------------------------

  it('writes JSON to stdout when globalOpts.json is true', async () => {
    const stdoutMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const srcFile = join(tempBase, 'jsonout.txt');
    writeFile(srcFile, 'json output test');

    const result = await runIngest(srcFile, ingestOpts(), { ...globalOpts(), json: true });

    expect(result.ok).toBe(true);

    const written = stdoutMock.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(written.trim()) as Record<string, unknown>;

    expect(typeof parsed['id']).toBe('string');
    expect(parsed['type']).toBe('text');
    expect(typeof parsed['hash']).toBe('string');
    expect(typeof parsed['path']).toBe('string');
    expect(typeof parsed['ingestedAt']).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Hash is recorded
  // -------------------------------------------------------------------------

  it('records the SHA-256 hash in the result', async () => {
    const srcFile = join(tempBase, 'hashed.txt');
    writeFile(srcFile, 'hashed content');

    const result = await runIngest(srcFile, ingestOpts(), globalOpts());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // Slug and type detection covered by unit tests below
  // -------------------------------------------------------------------------
});

// ---------------------------------------------------------------------------
// Unit tests for pure helpers
// ---------------------------------------------------------------------------

describe('detectSourceType', () => {
  it('maps .pdf to pdf', () => {
    expect(detectSourceType('paper.pdf')).toBe('pdf');
    expect(detectSourceType('/abs/path/file.PDF')).toBe('pdf');
  });

  it('maps .md and .mdx to markdown', () => {
    expect(detectSourceType('note.md')).toBe('markdown');
    expect(detectSourceType('page.mdx')).toBe('markdown');
  });

  it('maps .html and .htm to html', () => {
    expect(detectSourceType('index.html')).toBe('html');
    expect(detectSourceType('page.htm')).toBe('html');
  });

  it('maps unknown extensions to text', () => {
    expect(detectSourceType('file.csv')).toBe('text');
    expect(detectSourceType('file.rs')).toBe('text');
    expect(detectSourceType('file')).toBe('text');
  });
});

describe('slugify', () => {
  it('lowercases and preserves the extension', () => {
    expect(slugify('MyFile.PDF')).toBe('myfile.pdf');
  });

  it('replaces spaces with hyphens', () => {
    expect(slugify('my file.txt')).toBe('my-file.txt');
  });

  it('replaces underscores with hyphens', () => {
    expect(slugify('my_file.txt')).toBe('my-file.txt');
  });

  it('strips non-alphanumeric characters from the stem', () => {
    expect(slugify('hello! world?.txt')).toBe('hello-world.txt');
  });

  it('collapses multiple hyphens into one', () => {
    expect(slugify('my--file.txt')).toBe('my-file.txt');
  });

  it('trims leading and trailing hyphens from the stem', () => {
    expect(slugify('-leading.txt')).toBe('leading.txt');
    expect(slugify('trailing-.txt')).toBe('trailing.txt');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for scanDirectory
// ---------------------------------------------------------------------------

describe('scanDirectory', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ico-scan-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns only supported file types', () => {
    writeFileSync(join(tempDir, 'note.md'), '# note');
    writeFileSync(join(tempDir, 'paper.pdf'), 'pdf content');
    writeFileSync(join(tempDir, 'data.csv'), 'csv,data'); // unsupported
    writeFileSync(join(tempDir, 'code.ts'), 'const x = 1'); // unsupported

    const files = scanDirectory(tempDir);
    const names = files.map((f) => f.split('/').pop()!);
    expect(names).toContain('note.md');
    expect(names).toContain('paper.pdf');
    expect(names).not.toContain('data.csv');
    expect(names).not.toContain('code.ts');
  });

  it('returns files sorted alphabetically', () => {
    writeFileSync(join(tempDir, 'zebra.txt'), 'z');
    writeFileSync(join(tempDir, 'apple.txt'), 'a');
    writeFileSync(join(tempDir, 'mango.md'), 'm');

    const files = scanDirectory(tempDir);
    const names = files.map((f) => f.split('/').pop()!);
    expect(names).toEqual([...names].sort());
  });

  it('recurses into subdirectories', () => {
    const sub = join(tempDir, 'subdir');
    mkdirSync(sub);
    writeFileSync(join(sub, 'nested.txt'), 'nested');

    const files = scanDirectory(tempDir);
    const names = files.map((f) => f.split('/').pop()!);
    expect(names).toContain('nested.txt');
  });

  it('skips hidden files (starting with .)', () => {
    writeFileSync(join(tempDir, '.hidden.md'), 'hidden');
    writeFileSync(join(tempDir, 'visible.md'), 'visible');

    const files = scanDirectory(tempDir);
    const names = files.map((f) => f.split('/').pop()!);
    expect(names).not.toContain('.hidden.md');
    expect(names).toContain('visible.md');
  });

  it('skips node_modules directories', () => {
    const nm = join(tempDir, 'node_modules');
    mkdirSync(nm);
    writeFileSync(join(nm, 'package.md'), 'should be ignored');

    const files = scanDirectory(tempDir);
    const names = files.map((f) => f.split('/').pop()!);
    expect(names).not.toContain('package.md');
  });

  it('returns empty array for an empty directory', () => {
    expect(scanDirectory(tempDir)).toEqual([]);
  });

  it('skips hidden subdirectories', () => {
    const hiddenDir = join(tempDir, '.git');
    mkdirSync(hiddenDir);
    writeFileSync(join(hiddenDir, 'config.md'), 'should be ignored');

    const files = scanDirectory(tempDir);
    const names = files.map((f) => f.split('/').pop()!);
    expect(names).not.toContain('config.md');
  });
});

// ---------------------------------------------------------------------------
// Integration tests for runBatchIngest
// ---------------------------------------------------------------------------

describe('runBatchIngest', () => {
  let tempBase: string;
  let workspaceRoot: string;
  let sourceDir: string;
  let db: Database;

  const globalOpts = (): GlobalOptions => ({ workspace: workspaceRoot, json: false });
  const ingestOpts = (): IngestOptions => ({});

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'ico-batch-test-'));
    sourceDir = join(tempBase, 'sources');
    mkdirSync(sourceDir);

    const wsResult = initWorkspace('ws', tempBase);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    workspaceRoot = wsResult.value.root;

    const dbResult = initDatabase(wsResult.value.dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    db = dbResult.value;
    closeDatabase(db);

    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempBase, { recursive: true, force: true });
  });

  it('ingests all supported files in a directory', async () => {
    writeFileSync(join(sourceDir, 'alpha.md'), '# Alpha');
    writeFileSync(join(sourceDir, 'beta.txt'), 'beta');
    writeFileSync(join(sourceDir, 'gamma.html'), '<p>gamma</p>');

    const summary = await runBatchIngest(sourceDir, ingestOpts(), globalOpts());

    expect(summary.total).toBe(3);
    expect(summary.ingested).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.alreadyIngested).toBe(0);
    expect(summary.errors).toHaveLength(0);
  });

  it('skips unsupported file types and only ingests supported ones', async () => {
    writeFileSync(join(sourceDir, 'note.md'), '# note');
    writeFileSync(join(sourceDir, 'data.csv'), 'a,b,c'); // unsupported — not returned by scan
    writeFileSync(join(sourceDir, 'code.rs'), 'fn main()'); // unsupported — not returned by scan
    writeFileSync(join(sourceDir, 'page.html'), '<p>hi</p>');

    const summary = await runBatchIngest(sourceDir, ingestOpts(), globalOpts());

    // scanDirectory only returns .md and .html here — csv/rs are not included
    expect(summary.total).toBe(2);
    expect(summary.ingested).toBe(2);
    expect(summary.errors).toHaveLength(0);
  });

  it('returns total=0 for an empty directory', async () => {
    const summary = await runBatchIngest(sourceDir, ingestOpts(), globalOpts());

    expect(summary.total).toBe(0);
    expect(summary.ingested).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it('skips hidden files and node_modules', async () => {
    writeFileSync(join(sourceDir, '.hidden.md'), '# hidden');
    const nm = join(sourceDir, 'node_modules');
    mkdirSync(nm);
    writeFileSync(join(nm, 'readme.md'), '# pkg readme');
    writeFileSync(join(sourceDir, 'visible.txt'), 'visible');

    const summary = await runBatchIngest(sourceDir, ingestOpts(), globalOpts());

    expect(summary.total).toBe(1);
    expect(summary.ingested).toBe(1);
  });

  it('reports alreadyIngested count when re-running on the same directory', async () => {
    writeFileSync(join(sourceDir, 'doc.txt'), 'same content');

    // First batch
    await runBatchIngest(sourceDir, ingestOpts(), globalOpts());

    // Second batch — same file, same content
    const summary = await runBatchIngest(sourceDir, ingestOpts(), globalOpts());

    expect(summary.total).toBe(1);
    expect(summary.ingested).toBe(0);
    expect(summary.alreadyIngested).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('collects errors without aborting the whole batch', async () => {
    // One valid file, one that will fail because it references a non-existent path
    // We can simulate a failure by removing a file mid-scan by writing an oversized file
    // when force is not set. Use a separate file that exceeds the markdown limit.
    const bigContent = 'x'.repeat(6 * 1024 * 1024); // 6 MiB > 5 MiB markdown limit
    writeFileSync(join(sourceDir, 'toobig.md'), bigContent);
    writeFileSync(join(sourceDir, 'small.txt'), 'small content');

    const summary = await runBatchIngest(sourceDir, ingestOpts(), globalOpts());

    // toobig.md fails size check; small.txt succeeds
    expect(summary.total).toBe(2);
    expect(summary.ingested).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.message).toMatch(/size limit/i);
  });
});
