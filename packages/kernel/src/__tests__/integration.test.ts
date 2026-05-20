/**
 * Kernel integration test suite (E3-B10).
 *
 * Exercises the full kernel flow end-to-end by chaining multiple modules
 * against a real filesystem and SQLite database. Each test group uses a
 * shared beforeEach/afterEach fixture that creates an isolated temp workspace.
 *
 * These tests focus on cross-module integration — not the per-function edge
 * cases already covered by the unit tests next to each source file.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendAuditLog } from '../audit-log.js';
import { redactSecrets } from '../config.js';
import { registerMount } from '../mounts.js';
import { getDerivations, getProvenance, recordProvenance } from '../provenance.js';
import { computeFileHash, isSourceChanged, registerSource } from '../sources.js';
import type { Database } from '../state.js';
import { closeDatabase, initDatabase } from '../state.js';
import { createTask, getTask, listTasks, transitionTask } from '../tasks.js';
import { readTraces, writeTrace } from '../traces.js';
import { rebuildWikiIndex } from '../wiki-index.js';
import { initWorkspace } from '../workspace.js';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/** Returns today's JSONL trace file path inside the workspace. */
function todayJsonlPath(workspacePath: string): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  return join(workspacePath, 'audit', 'traces', `${dateStr}.jsonl`);
}

/** SHA-256 of a raw UTF-8 string, matching the implementation. */
function sha256Hex(line: string): string {
  return createHash('sha256').update(line, 'utf-8').digest('hex');
}

/**
 * Create a minimal compiled markdown page with YAML frontmatter in `dir`.
 * Used by the wiki-index tests.
 */
function createMockCompiledPage(dir: string, filename: string, type: string, title: string): void {
  writeFileSync(
    join(dir, filename),
    [
      '---',
      `type: ${type}`,
      `title: ${title}`,
      `source_id: test-source`,
      `compiled_at: ${new Date().toISOString()}`,
      '---',
      '',
      `# ${title}`,
      '',
      'Mock compiled content.',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Fixture state — reset per test
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspacePath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ico-integration-'));
  const wsResult = initWorkspace('test', tmpDir);
  if (!wsResult.ok) throw wsResult.error;
  workspacePath = wsResult.value.root;

  const dbResult = initDatabase(wsResult.value.dbPath);
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Full kernel flow — happy path
// ---------------------------------------------------------------------------

describe('full kernel flow — happy path', () => {
  it('chains init → mount → source → provenance → trace → task lifecycle → wiki → audit', () => {
    // Workspace and DB were initialized in beforeEach.
    expect(existsSync(workspacePath)).toBe(true);
    expect(db.open).toBe(true);

    // Register a mount pointing to the raw/articles directory.
    const articlesDir = join(workspacePath, 'raw', 'articles');
    const mountResult = registerMount(db, 'articles', articlesDir);
    expect(mountResult.ok).toBe(true);
    if (!mountResult.ok) return;
    const mount = mountResult.value;

    // Write a test source file inside the mount.
    const sourceFile = join(articlesDir, 'test-article.md');
    writeFileSync(sourceFile, '# Test Article\n\nContent here.\n', 'utf-8');

    // Compute its SHA-256 hash.
    const hashResult = computeFileHash(sourceFile);
    expect(hashResult.ok).toBe(true);
    if (!hashResult.ok) return;
    const fileHash = hashResult.value;
    expect(fileHash).toHaveLength(64);

    // Register the source.
    const sourceResult = registerSource(db, {
      path: 'raw/articles/test-article.md',
      mountId: mount.id,
      type: 'markdown',
      title: 'Test Article',
      hash: fileHash,
    });
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) return;
    const source = sourceResult.value;

    // Record provenance: source → compiled output.
    const provenanceResult = recordProvenance(db, workspacePath, {
      sourceId: source.id,
      outputPath: 'wiki/sources/test-article.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    expect(provenanceResult.ok).toBe(true);

    // Write an additional trace event.
    const traceResult = writeTrace(db, workspacePath, 'integration.test', {
      step: 'full-flow',
      sourceId: source.id,
    });
    expect(traceResult.ok).toBe(true);

    // Create a task and drive it through the full lifecycle.
    const taskResult = createTask(db, workspacePath, 'Integration flow task');
    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;
    const taskId = taskResult.value.id;

    for (const status of [
      'collecting',
      'synthesizing',
      'critiquing',
      'rendering',
      'completed',
      'archived',
    ] as const) {
      const t = transitionTask(db, workspacePath, taskId, status);
      expect(t.ok, `transition to ${status} should succeed`).toBe(true);
    }

    // Verify the task reached the terminal state.
    const finalTask = getTask(db, taskId);
    expect(finalTask.ok).toBe(true);
    if (!finalTask.ok) return;
    expect(finalTask.value?.status).toBe('archived');
    expect(finalTask.value?.completed_at).not.toBeNull();
    expect(finalTask.value?.archived_at).not.toBeNull();

    // Rebuild the wiki index (no pages exist yet — should return 0).
    const indexResult = rebuildWikiIndex(workspacePath);
    expect(indexResult.ok).toBe(true);
    if (!indexResult.ok) return;
    expect(indexResult.value).toBe(0);

    // Append an audit log entry.
    const auditResult = appendAuditLog(
      workspacePath,
      'integration.complete',
      'Full flow test finished',
    );
    expect(auditResult.ok).toBe(true);

    // Verify the audit log now has the new entry.
    const logContent = readFileSync(join(workspacePath, 'audit', 'log.md'), 'utf-8');
    expect(logContent).toContain('integration.complete');
    expect(logContent).toContain('Full flow test finished');
  });
});

// ---------------------------------------------------------------------------
// 2. Workspace + DB integration
// ---------------------------------------------------------------------------

describe('workspace + DB integration', () => {
  it('initWorkspace creates all required directories', () => {
    const expectedDirs = [
      'raw/articles',
      'raw/papers',
      'raw/repos',
      'raw/notes',
      'wiki/sources',
      'wiki/concepts',
      'wiki/entities',
      'wiki/topics',
      'wiki/contradictions',
      'wiki/open-questions',
      'wiki/indexes',
      'tasks',
      'outputs/reports',
      'outputs/slides',
      'outputs/charts',
      'outputs/briefings',
      'recall/cards',
      'recall/decks',
      'recall/quizzes',
      'recall/retention',
      'audit/traces',
      'audit/provenance',
      'audit/policy',
      'audit/promotions',
      '.ico',
    ];

    for (const dir of expectedDirs) {
      expect(existsSync(join(workspacePath, dir)), `expected directory ${dir} to exist`).toBe(true);
    }
  });

  it('initWorkspace seeds wiki/index.md and audit/log.md', () => {
    expect(existsSync(join(workspacePath, 'wiki', 'index.md'))).toBe(true);
    expect(existsSync(join(workspacePath, 'audit', 'log.md'))).toBe(true);
  });

  it('initDatabase at the workspace dbPath opens successfully', () => {
    expect(db.open).toBe(true);
  });

  it('all application tables are queryable after init', () => {
    const expectedTables = [
      'sources',
      'mounts',
      'compilations',
      'tasks',
      'promotions',
      'recall_results',
      'traces',
      'compilation_sources',
    ] as const;

    const rows = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\'")
      .all();
    const tableNames = new Set(rows.map((r) => r.name));

    for (const table of expectedTables) {
      expect(tableNames, `expected table "${table}" to exist`).toContain(table);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Mount → Source → Provenance chain
// ---------------------------------------------------------------------------

describe('mount → source → provenance chain', () => {
  it('registers a mount, source, and records + retrieves provenance', () => {
    // Register mount.
    const rawArticlesDir = join(workspacePath, 'raw', 'articles');
    const mountResult = registerMount(db, 'raw-articles', rawArticlesDir);
    expect(mountResult.ok).toBe(true);
    if (!mountResult.ok) return;
    const mount = mountResult.value;
    expect(mount.name).toBe('raw-articles');
    expect(mount.path).toBe(rawArticlesDir);

    // Create test file and register source.
    const filePath = join(rawArticlesDir, 'article.md');
    writeFileSync(filePath, '# Article\n\nContent.\n', 'utf-8');

    const hashResult = computeFileHash(filePath);
    expect(hashResult.ok).toBe(true);
    if (!hashResult.ok) return;

    const sourceResult = registerSource(db, {
      path: 'raw/articles/article.md',
      mountId: mount.id,
      type: 'markdown',
      title: 'Article',
      hash: hashResult.value,
    });
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) return;
    const source = sourceResult.value;

    // The Source type (from @ico/types SourceSchema) does not expose mount_id.
    // Verify the association persisted correctly by querying the raw row.
    const rawRow = db
      .prepare<[string], { mount_id: string | null }>('SELECT mount_id FROM sources WHERE id = ?')
      .get(source.id);
    expect(rawRow?.mount_id).toBe(mount.id);

    // Record provenance.
    const outputPath = 'wiki/sources/article.md';
    const provResult = recordProvenance(db, workspacePath, {
      sourceId: source.id,
      outputPath,
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    expect(provResult.ok).toBe(true);
    if (!provResult.ok) return;
    const prov = provResult.value;
    expect(prov.sourceId).toBe(source.id);
    expect(prov.outputPath).toBe(outputPath);

    // Forward lookup: getProvenance returns the chain.
    const getProvResult = getProvenance(db, workspacePath, outputPath);
    expect(getProvResult.ok).toBe(true);
    if (!getProvResult.ok) return;
    expect(getProvResult.value).toHaveLength(1);
    expect(getProvResult.value[0]?.sourceId).toBe(source.id);
    expect(getProvResult.value[0]?.outputPath).toBe(outputPath);

    // Reverse lookup: getDerivations returns the derivation.
    const derivResult = getDerivations(db, workspacePath, source.id);
    expect(derivResult.ok).toBe(true);
    if (!derivResult.ok) return;
    expect(derivResult.value).toHaveLength(1);
    expect(derivResult.value[0]?.outputPath).toBe(outputPath);
    expect(derivResult.value[0]?.operation).toBe('compile.summarize');
  });
});

// ---------------------------------------------------------------------------
// 4. Task lifecycle integration
// ---------------------------------------------------------------------------

describe('task lifecycle integration', () => {
  it('creates task directory, transitions all states, sets timestamps', () => {
    const taskResult = createTask(db, workspacePath, 'Research quantum entanglement');
    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;

    const task = taskResult.value;
    const taskRoot = join(workspacePath, 'tasks', `tsk-${task.id}`);

    // Task directory and subdirs must exist.
    expect(existsSync(taskRoot)).toBe(true);
    for (const subdir of ['evidence', 'notes', 'drafts', 'critique', 'output']) {
      expect(existsSync(join(taskRoot, subdir)), `subdir ${subdir} must exist`).toBe(true);
    }

    // Initial status.
    expect(task.status).toBe('created');
    expect(task.completed_at).toBeNull();
    expect(task.archived_at).toBeNull();

    // Transition through all states.
    const transitions = [
      'collecting',
      'synthesizing',
      'critiquing',
      'rendering',
      'completed',
      'archived',
    ] as const;

    for (const status of transitions) {
      const t = transitionTask(db, workspacePath, task.id, status);
      expect(t.ok, `transition to ${status} should succeed`).toBe(true);
      if (!t.ok) return;
      expect(t.value.status).toBe(status);
    }

    // Verify completed_at and archived_at are set.
    const finalResult = getTask(db, task.id);
    expect(finalResult.ok).toBe(true);
    if (!finalResult.ok) return;
    const final = finalResult.value;
    expect(final?.completed_at).not.toBeNull();
    expect(final?.archived_at).not.toBeNull();
    // ISO timestamps must be parseable.
    expect(new Date(final!.completed_at!).toISOString()).toBe(final!.completed_at);
    expect(new Date(final!.archived_at!).toISOString()).toBe(final!.archived_at);
  });

  it('each state transition emits a task.transition trace event', () => {
    const taskResult = createTask(db, workspacePath, 'Trace transition task');
    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;
    const taskId = taskResult.value.id;

    const transitions = ['collecting', 'synthesizing', 'critiquing'] as const;
    for (const status of transitions) {
      transitionTask(db, workspacePath, taskId, status);
    }

    const traceResult = readTraces(db, { eventType: 'task.transition' });
    expect(traceResult.ok).toBe(true);
    if (!traceResult.ok) return;
    // One trace per transition.
    expect(traceResult.value).toHaveLength(transitions.length);
    for (const record of traceResult.value) {
      expect(record.event_type).toBe('task.transition');
    }
  });

  it('listTasks filters by status correctly after lifecycle progression', () => {
    const r1 = createTask(db, workspacePath, 'Task stays created');
    const r2 = createTask(db, workspacePath, 'Task advances to collecting');
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    transitionTask(db, workspacePath, r2.value.id, 'collecting');

    const created = listTasks(db, 'created');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toHaveLength(1);
    expect(created.value[0]?.id).toBe(r1.value.id);

    const collecting = listTasks(db, 'collecting');
    expect(collecting.ok).toBe(true);
    if (!collecting.ok) return;
    expect(collecting.value).toHaveLength(1);
    expect(collecting.value[0]?.id).toBe(r2.value.id);
  });
});

// ---------------------------------------------------------------------------
// 5. Trace integrity chain
// ---------------------------------------------------------------------------

describe('trace integrity chain', () => {
  it('first event has prev_hash null, subsequent events chain correctly', () => {
    const e1 = writeTrace(db, workspacePath, 'chain.a', { seq: 1 });
    const e2 = writeTrace(db, workspacePath, 'chain.b', { seq: 2 });
    const e3 = writeTrace(db, workspacePath, 'chain.c', { seq: 3 });

    expect(e1.ok && e2.ok && e3.ok).toBe(true);
    if (!e1.ok || !e2.ok || !e3.ok) return;

    // Read the JSONL file directly.
    const filePath = todayJsonlPath(workspacePath);
    const rawLines = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(rawLines).toHaveLength(3);

    const parsed = rawLines.map((l) => JSON.parse(l) as Record<string, unknown>);

    // First event — no previous line.
    expect(parsed[0]?.['prev_hash']).toBeNull();

    // Second event — hash of first raw line.
    expect(parsed[1]?.['prev_hash']).toBe(sha256Hex(rawLines[0]!));

    // Third event — hash of second raw line.
    expect(parsed[2]?.['prev_hash']).toBe(sha256Hex(rawLines[1]!));
  });
});

// ---------------------------------------------------------------------------
// 6. Secret redaction in traces
// ---------------------------------------------------------------------------

describe('secret redaction in traces', () => {
  it('payload containing apiKey with sk-ant- prefix is persisted as [REDACTED]', () => {
    const result = writeTrace(db, workspacePath, 'api.call', {
      model: 'claude-opus-4-6',
      apiKey: 'sk-ant-secret123',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Returned envelope must already be redacted.
    const payload = result.value.payload;
    expect(payload['apiKey']).toBe('[REDACTED]');
    expect(payload['model']).toBe('claude-opus-4-6');

    // JSONL file must not contain the raw secret.
    const raw = readFileSync(todayJsonlPath(workspacePath), 'utf-8');
    expect(raw).not.toContain('sk-ant-secret123');
    expect(raw).toContain('[REDACTED]');
  });

  it('redactSecrets handles nested objects', () => {
    const input = {
      outer: 'safe',
      inner: { apiKey: 'sk-ant-nested-secret' },
    };
    const redacted = redactSecrets(input);
    const inner = redacted['inner'] as Record<string, unknown>;
    expect(inner['apiKey']).toBe('[REDACTED]');
    expect(redacted['outer']).toBe('safe');
  });
});

// ---------------------------------------------------------------------------
// 7. Wiki index after mock compilation
// ---------------------------------------------------------------------------

describe('wiki index after mock compilation', () => {
  it('lists pages in correct sections after creating mock compiled pages', () => {
    const wikiDir = join(workspacePath, 'wiki');

    createMockCompiledPage(
      join(wikiDir, 'sources'),
      'source-a.md',
      'source-summary',
      'Source Alpha',
    );
    createMockCompiledPage(
      join(wikiDir, 'sources'),
      'source-b.md',
      'source-summary',
      'Source Beta',
    );
    createMockCompiledPage(join(wikiDir, 'concepts'), 'concept-a.md', 'concept', 'Concept Alpha');

    const result = rebuildWikiIndex(workspacePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(3);

    const indexContent = readFileSync(join(wikiDir, 'index.md'), 'utf-8');

    // Correct page counts in section headings.
    expect(indexContent).toContain('## Sources (2)');
    expect(indexContent).toContain('## Concepts (1)');

    // Alphabetically sorted links within Sources.
    const sourceAlphaPos = indexContent.indexOf('[Source Alpha]');
    const sourceBetaPos = indexContent.indexOf('[Source Beta]');
    expect(sourceAlphaPos).toBeGreaterThan(-1);
    expect(sourceBetaPos).toBeGreaterThan(-1);
    expect(sourceAlphaPos).toBeLessThan(sourceBetaPos);

    // Correct relative link paths.
    expect(indexContent).toContain('[Source Alpha](sources/source-a.md)');
    expect(indexContent).toContain('[Source Beta](sources/source-b.md)');
    expect(indexContent).toContain('[Concept Alpha](concepts/concept-a.md)');

    // Frontmatter values.
    expect(indexContent).toContain('page_count: 3');
    expect(indexContent).toContain('type: index');
  });
});

// ---------------------------------------------------------------------------
// 8. Audit log accumulation
// ---------------------------------------------------------------------------

describe('audit log accumulation', () => {
  it('accumulates entries correctly: init row + 3 appended = 4 data rows', () => {
    appendAuditLog(workspacePath, 'op.one', 'First operation');
    appendAuditLog(workspacePath, 'op.two', 'Second operation');
    appendAuditLog(workspacePath, 'op.three', 'Third operation');

    const logContent = readFileSync(join(workspacePath, 'audit', 'log.md'), 'utf-8');

    // Count pipe-delimited data rows (exclude header and separator rows).
    const dataRows = logContent
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('|') && !line.startsWith('| Timestamp') && !line.startsWith('|---'),
      );

    // 1 init row (seeded by initWorkspace) + 3 appended rows = 4.
    expect(dataRows).toHaveLength(4);
    expect(dataRows.some((r) => r.includes('workspace.init'))).toBe(true);
    expect(dataRows.some((r) => r.includes('op.one'))).toBe(true);
    expect(dataRows.some((r) => r.includes('op.two'))).toBe(true);
    expect(dataRows.some((r) => r.includes('op.three'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Concurrent database access (WAL mode)
// ---------------------------------------------------------------------------

describe('concurrent database access (WAL mode)', () => {
  it('two connections to the same file can write and read without SQLITE_BUSY', () => {
    // The primary DB is already open in WAL mode (from beforeEach).
    // Open a second connection to the same file.
    const _require = createRequire(import.meta.url);
    const DatabaseCtor = _require('better-sqlite3') as {
      new (filename: string): Database;
    };

    const dbPath = join(workspacePath, '.ico', 'state.db');
    const db2 = new DatabaseCtor(dbPath);

    try {
      // Write from the primary connection.
      writeTrace(db, workspacePath, 'wal.write.primary', { conn: 1 });

      // Read from the secondary connection — must not throw SQLITE_BUSY.
      const rows = db2.prepare<[], { id: string }>('SELECT id FROM traces').all();

      // The trace we just wrote must be visible from the second connection.
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Corrupted database detection
// ---------------------------------------------------------------------------

describe('corrupted database detection', () => {
  it('initDatabase on a garbage file returns err rather than crashing', () => {
    const corruptPath = join(tmpDir, 'corrupted.db');
    // Write clearly invalid content that is not a valid SQLite file.
    writeFileSync(corruptPath, 'THIS IS NOT A VALID SQLITE DATABASE FILE\x00\xFF', 'utf-8');

    const result = initDatabase(corruptPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Orphan detection scenario
// ---------------------------------------------------------------------------

describe('orphan detection scenario', () => {
  it('isSourceChanged returns true and computeFileHash returns err for a deleted file', () => {
    const rawDir = join(workspacePath, 'raw', 'articles');
    const filePath = join(rawDir, 'orphan.md');
    writeFileSync(filePath, '# Orphan\n\nContent.\n', 'utf-8');

    // Hash and register the source.
    const hashResult = computeFileHash(filePath);
    expect(hashResult.ok).toBe(true);
    if (!hashResult.ok) return;

    const sourceResult = registerSource(db, {
      path: 'raw/articles/orphan.md',
      type: 'markdown',
      title: 'Orphan Source',
      hash: hashResult.value,
    });
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) return;

    // Verify source is unchanged before deletion.
    const beforeDelete = isSourceChanged(db, 'raw/articles/orphan.md', hashResult.value);
    expect(beforeDelete.ok).toBe(true);
    if (!beforeDelete.ok) return;
    expect(beforeDelete.value).toBe(false);

    // Delete the file to simulate an orphan.
    rmSync(filePath);

    // computeFileHash on a missing file returns err.
    const hashAfter = computeFileHash(filePath);
    expect(hashAfter.ok).toBe(false);
    if (!hashAfter.ok) {
      expect(hashAfter.error).toBeInstanceOf(Error);
    }

    // isSourceChanged with a different hash returns true — content has changed.
    const changedResult = isSourceChanged(
      db,
      'raw/articles/orphan.md',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(changedResult.ok).toBe(true);
    if (!changedResult.ok) return;
    expect(changedResult.value).toBe(true);
  });

  it('isSourceChanged returns true for a path with no registered source', () => {
    const result = isSourceChanged(db, 'raw/articles/nonexistent.md', 'aaaa'.repeat(16));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No record for this path — treated as new.
    expect(result.value).toBe(true);
  });
});
