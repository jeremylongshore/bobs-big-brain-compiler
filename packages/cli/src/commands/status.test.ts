/**
 * Tests for the `ico status` command data-collection and rendering logic.
 *
 * We test at two levels:
 *   1. Pure functions (`countSources`, `countTasks`, `renderStatusNormal`) —
 *      no I/O required.
 *   2. `collectStatusData` — opens a real in-memory SQLite database seeded
 *      with kernel functions, then asserts the returned `StatusData`.
 *
 * The Commander action itself is exercised by the integration suite in
 * `src/index.test.ts`; we do not duplicate that here.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '@ico/kernel';
import {
  closeDatabase,
  createTask,
  initDatabase,
  initWorkspace,
  registerMount,
  registerSource,
  writeTrace,
} from '@ico/kernel';

import type { StatusData } from './status.js';
import {
  collectStatusData,
  countSources,
  countTasks,
  renderSourcesTable,
  renderStatusNormal,
} from './status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip all ANSI escape sequences from a string. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

describe('countSources', () => {
  it('returns all-zero counts for an empty array', () => {
    const result = countSources([]);
    expect(result.total).toBe(0);
    expect(result.pdf).toBe(0);
    expect(result.markdown).toBe(0);
    expect(result.html).toBe(0);
    expect(result.text).toBe(0);
  });

  it('tallies each type correctly', () => {
    const sources = [
      {
        type: 'pdf' as const,
        id: 'a',
        path: 'a',
        title: null,
        author: null,
        ingested_at: '',
        word_count: null,
        hash: 'x',
        metadata: null,
      },
      {
        type: 'pdf' as const,
        id: 'b',
        path: 'b',
        title: null,
        author: null,
        ingested_at: '',
        word_count: null,
        hash: 'y',
        metadata: null,
      },
      {
        type: 'markdown' as const,
        id: 'c',
        path: 'c',
        title: null,
        author: null,
        ingested_at: '',
        word_count: null,
        hash: 'z',
        metadata: null,
      },
      {
        type: 'html' as const,
        id: 'd',
        path: 'd',
        title: null,
        author: null,
        ingested_at: '',
        word_count: null,
        hash: 'w',
        metadata: null,
      },
    ];
    const result = countSources(sources);
    expect(result.total).toBe(4);
    expect(result.pdf).toBe(2);
    expect(result.markdown).toBe(1);
    expect(result.html).toBe(1);
    expect(result.text).toBe(0);
  });
});

describe('countTasks', () => {
  it('returns all-zero counts for an empty array', () => {
    const result = countTasks([]);
    expect(result.created).toBe(0);
    expect(result.collecting).toBe(0);
    expect(result.synthesizing).toBe(0);
    expect(result.critiquing).toBe(0);
    expect(result.rendering).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.archived).toBe(0);
  });

  it('tallies each status correctly', () => {
    const tasks = [
      { status: 'created' },
      { status: 'created' },
      { status: 'completed' },
      { status: 'archived' },
    ];
    const result = countTasks(tasks);
    expect(result.created).toBe(2);
    expect(result.completed).toBe(1);
    expect(result.archived).toBe(1);
    expect(result.collecting).toBe(0);
  });

  it('ignores unknown status values without throwing', () => {
    const tasks = [{ status: 'unknown-status' }, { status: 'created' }];
    const result = countTasks(tasks);
    expect(result.created).toBe(1);
  });
});

describe('renderStatusNormal', () => {
  const minimal: StatusData = {
    sources: { total: 0, pdf: 0, markdown: 0, html: 0, text: 0 },
    mounts: 0,
    tasks: {
      created: 0,
      collecting: 0,
      synthesizing: 0,
      critiquing: 0,
      rendering: 0,
      completed: 0,
      archived: 0,
    },
    lastOperation: null,
    compilationTokens: null,
  };

  it('contains "Workspace Status" header', () => {
    const out = stripAnsi(renderStatusNormal(minimal));
    expect(out).toContain('Workspace Status');
  });

  it('contains "Tasks" header', () => {
    const out = stripAnsi(renderStatusNormal(minimal));
    expect(out).toContain('Tasks');
  });

  it('renders zero source totals', () => {
    const out = stripAnsi(renderStatusNormal(minimal));
    expect(out).toContain('Sources:');
    // total should be 0
    expect(out).toMatch(/Sources:\s+0/);
  });

  it('renders "none" when there is no last operation', () => {
    const out = stripAnsi(renderStatusNormal(minimal));
    expect(out).toContain('Last Operation:');
    expect(out).toContain('none');
  });

  it('renders the last operation timestamp and type', () => {
    const data: StatusData = {
      ...minimal,
      lastOperation: { timestamp: '2026-04-06T14:30:00.000Z', type: 'source.ingest' },
    };
    const out = stripAnsi(renderStatusNormal(data));
    expect(out).toContain('2026-04-06T14:30:00.000Z');
    expect(out).toContain('source.ingest');
  });

  it('renders correct source type breakdown', () => {
    const data: StatusData = {
      ...minimal,
      sources: { total: 23, pdf: 12, markdown: 8, html: 3, text: 0 },
    };
    const out = stripAnsi(renderStatusNormal(data));
    expect(out).toMatch(/Sources:\s+23/);
    expect(out).toMatch(/pdf:\s+12/);
    expect(out).toMatch(/markdown:\s+8/);
    expect(out).toMatch(/html:\s+3/);
    expect(out).toMatch(/text:\s+0/);
  });
});

// ---------------------------------------------------------------------------
// collectStatusData — integration tests against a real SQLite database
// ---------------------------------------------------------------------------

describe('collectStatusData', () => {
  let tmpDir: string;
  let workspacePath: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ico-status-test-'));
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

  it('returns all-zero counts on a fresh workspace', () => {
    const data = collectStatusData(db);

    expect(data.sources.total).toBe(0);
    expect(data.sources.pdf).toBe(0);
    expect(data.mounts).toBe(0);
    expect(data.tasks.created).toBe(0);
    expect(data.lastOperation).toBeNull();
  });

  it('counts sources by type after registering several', () => {
    const baseSource = { path: '', type: 'pdf' as const, hash: '0000', wordCount: 1 };

    registerSource(db, { ...baseSource, path: 'a.pdf', hash: 'h1' });
    registerSource(db, { ...baseSource, path: 'b.pdf', hash: 'h2' });
    registerSource(db, { ...baseSource, path: 'c.md', type: 'markdown', hash: 'h3' });
    registerSource(db, { ...baseSource, path: 'd.html', type: 'html', hash: 'h4' });

    const data = collectStatusData(db);

    expect(data.sources.total).toBe(4);
    expect(data.sources.pdf).toBe(2);
    expect(data.sources.markdown).toBe(1);
    expect(data.sources.html).toBe(1);
    expect(data.sources.text).toBe(0);
  });

  it('counts mounts correctly', () => {
    registerMount(db, 'papers', tmpDir);

    const data = collectStatusData(db);

    expect(data.mounts).toBe(1);
  });

  it('counts tasks by status after creating tasks', () => {
    createTask(db, workspacePath, 'First task');
    createTask(db, workspacePath, 'Second task');

    const data = collectStatusData(db);

    expect(data.tasks.created).toBe(2);
    expect(data.tasks.collecting).toBe(0);
    expect(data.tasks.completed).toBe(0);
    expect(data.tasks.archived).toBe(0);
  });

  it('reflects last operation from trace events', () => {
    writeTrace(db, workspacePath, 'source.ingest', { path: 'test.pdf' });

    const data = collectStatusData(db);

    expect(data.lastOperation).not.toBeNull();
    expect(data.lastOperation!.type).toBe('source.ingest');
    expect(typeof data.lastOperation!.timestamp).toBe('string');
  });

  it('reflects the most recent trace when multiple exist', () => {
    writeTrace(db, workspacePath, 'source.ingest', { path: 'a.pdf' });
    writeTrace(db, workspacePath, 'task.create', { taskId: 'x' });
    writeTrace(db, workspacePath, 'source.ingest', { path: 'b.pdf' });

    const data = collectStatusData(db);

    // The last written trace is `source.ingest` with path b.pdf — the type should match.
    expect(data.lastOperation!.type).toBe('source.ingest');
  });

  it('JSON output has the expected top-level keys', () => {
    const data = collectStatusData(db);
    const json = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;

    expect(json).toHaveProperty('sources');
    expect(json).toHaveProperty('mounts');
    expect(json).toHaveProperty('tasks');
    expect(json).toHaveProperty('lastOperation');
    expect(json).toHaveProperty('compilationTokens');

    const sources = json['sources'] as Record<string, unknown>;
    expect(sources).toHaveProperty('total');
    expect(sources).toHaveProperty('pdf');
    expect(sources).toHaveProperty('markdown');
    expect(sources).toHaveProperty('html');
    expect(sources).toHaveProperty('text');

    const tasks = json['tasks'] as Record<string, unknown>;
    for (const key of [
      'created',
      'collecting',
      'synthesizing',
      'critiquing',
      'rendering',
      'completed',
      'archived',
    ]) {
      expect(tasks).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// renderSourcesTable — unit tests
// ---------------------------------------------------------------------------

describe('renderSourcesTable', () => {
  it('shows "No sources ingested yet." when the array is empty', () => {
    const out = stripAnsi(renderSourcesTable([]));
    expect(out).toContain('No sources ingested yet.');
  });

  it('contains "Sources" header', () => {
    const out = stripAnsi(renderSourcesTable([]));
    expect(out).toContain('Sources');
  });

  it('renders column headers when sources are present', () => {
    const sources = [
      {
        id: 'abc',
        path: 'raw/papers/paper.pdf',
        type: 'pdf' as const,
        title: 'Attention Is All You Need',
        author: 'Vaswani et al.',
        hash: '9f86d08188bef50e0dbc4b27e77e47c7' + '0123456789abcdef',
        ingested_at: '2026-04-06T12:00:00.000Z',
        word_count: 8400,
        metadata: null,
      },
    ];
    const out = stripAnsi(renderSourcesTable(sources));
    expect(out).toContain('Type');
    expect(out).toContain('Title');
    expect(out).toContain('Hash (short)');
    expect(out).toContain('Ingested');
  });

  it('renders source data rows correctly', () => {
    const sources = [
      {
        id: 'abc',
        path: 'raw/papers/paper.pdf',
        type: 'pdf' as const,
        title: 'Attention Is All You Need',
        author: 'Vaswani et al.',
        hash: '9f86d08188bef50e0dbc4b27e77e47c70123456789abcdef0123456789abcdef',
        ingested_at: '2026-04-06T12:00:00.000Z',
        word_count: 8400,
        metadata: null,
      },
      {
        id: 'def',
        path: 'raw/notes/meeting.md',
        type: 'markdown' as const,
        title: 'Meeting Notes',
        author: null,
        hash: 'e3b0c44298fc1c149afbf4c8996fb92400000000000000000000000000000000',
        ingested_at: '2026-04-06T14:00:00.000Z',
        word_count: 120,
        metadata: null,
      },
    ];
    const out = stripAnsi(renderSourcesTable(sources));
    expect(out).toContain('pdf');
    expect(out).toContain('Attention Is All You Need');
    expect(out).toContain('9f86d081');
    expect(out).toContain('2026-04-06');
    expect(out).toContain('markdown');
    expect(out).toContain('Meeting Notes');
    expect(out).toContain('e3b0c442');
  });

  it('shows (untitled) for sources with no title', () => {
    const sources = [
      {
        id: 'xyz',
        path: 'raw/notes/unnamed.txt',
        type: 'text' as const,
        title: null,
        author: null,
        hash: 'aaaa'.repeat(16),
        ingested_at: '2026-04-06T10:00:00.000Z',
        word_count: 50,
        metadata: null,
      },
    ];
    const out = stripAnsi(renderSourcesTable(sources));
    expect(out).toContain('(untitled)');
  });
});
