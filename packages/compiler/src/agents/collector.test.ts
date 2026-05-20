/**
 * Tests for the Collector agent (E9-B02).
 *
 * Integration-first: each test builds a real workspace, writes real wiki
 * pages, indexes them into FTS5, creates a real task, then exercises
 * `collectEvidence` end-to-end against the kernel. This mirrors the coverage
 * pattern used by ingest-pipeline.test.ts and exercises the full deterministic
 * surface (search, tasks, traces) the Collector depends on.
 *
 * @module agents/collector.test
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createSearchIndex,
  createTask,
  type Database,
  getTask,
  indexCompiledPages,
  initDatabase,
  initWorkspace,
  readTraces,
  transitionTask,
} from '@ico/kernel';

import { collectEvidence } from './collector.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface TestEnv {
  base: string;
  wsRoot: string;
  db: Database;
}

function setupEnv(): TestEnv {
  const base = mkdtempSync(join(tmpdir(), 'ico-collector-'));

  const wsResult = initWorkspace('ws', base);
  if (!wsResult.ok) throw wsResult.error;
  const wsRoot = wsResult.value.root;

  const dbResult = initDatabase(wsResult.value.dbPath);
  if (!dbResult.ok) throw dbResult.error;
  const db = dbResult.value;

  const idxResult = createSearchIndex(db);
  if (!idxResult.ok) throw idxResult.error;

  return { base, wsRoot, db };
}

function teardownEnv(env: TestEnv): void {
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
}

/**
 * Write a compiled wiki page under `wiki/<dir>/<slug>.md` with the given
 * frontmatter and body. The kernel FTS5 indexer reads `title`, `type`, and
 * `tags` from frontmatter, so each test can control match behaviour by
 * choosing these fields.
 */
function writeWikiPage(
  wsRoot: string,
  dir: string,
  slug: string,
  opts: { title: string; type: string; tags?: string; body: string },
): string {
  const relPath = `${dir}/${slug}.md`;
  const abs = resolve(wsRoot, 'wiki', dir, `${slug}.md`);
  mkdirSync(resolve(wsRoot, 'wiki', dir), { recursive: true });
  const frontmatter = [
    '---',
    `title: ${opts.title}`,
    `type: ${opts.type}`,
    `tags: ${opts.tags ?? ''}`,
    '---',
    '',
    opts.body,
    '',
  ].join('\n');
  writeFileSync(abs, frontmatter, 'utf-8');
  return relPath;
}

/**
 * Create a task in `created` state with a `brief.md` containing `briefText`.
 * Returns the task record for assertions.
 */
function createTaskWithBrief(
  db: Database,
  wsRoot: string,
  briefText: string,
): { id: string; workspacePath: string } {
  const created = createTask(db, wsRoot, briefText);
  if (!created.ok) throw created.error;
  const task = created.value;

  const briefPath = resolve(wsRoot, task.workspace_path, 'brief.md');
  writeFileSync(
    briefPath,
    [
      '---',
      `task_id: ${task.id}`,
      `created_at: ${task.created_at}`,
      `status: ${task.status}`,
      '---',
      '',
      briefText,
      '',
    ].join('\n'),
    'utf-8',
  );

  return { id: task.id, workspacePath: task.workspace_path };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let env: TestEnv;

beforeEach(() => {
  env = setupEnv();
});

afterEach(() => {
  teardownEnv(env);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('collectEvidence — happy path', () => {
  it('creates evidence files for each matched wiki page', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'attention', {
      title: 'Attention',
      type: 'concept',
      tags: 'transformer',
      body: 'Attention mechanisms allow models to weight tokens based on relevance.',
    });
    writeWikiPage(env.wsRoot, 'concepts', 'embeddings', {
      title: 'Embeddings',
      type: 'concept',
      tags: 'representation',
      body: 'Embeddings map discrete tokens into continuous vectors.',
    });
    writeWikiPage(env.wsRoot, 'topics', 'unrelated', {
      title: 'Gardening',
      type: 'topic',
      body: 'Gardening is the practice of growing plants.',
    });

    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(
      env.db,
      env.wsRoot,
      'How does attention work in transformers?',
    );

    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.newStatus).toBe('collecting');
    expect(result.value.evidenceFiles.length).toBeGreaterThanOrEqual(1);
    expect(result.value.pagesMatched).toBe(result.value.evidenceFiles.length);

    const matchedSources = result.value.evidenceFiles.map((f) => f.sourcePath);
    expect(matchedSources).toContain('concepts/attention.md');
    expect(matchedSources).not.toContain('topics/unrelated.md');
  });

  it('writes evidence files with frontmatter citing source', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'rust-ownership', {
      title: 'Rust Ownership',
      type: 'concept',
      body: 'Rust ownership enforces memory safety via compile-time borrow checking.',
    });

    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'Explain Rust ownership semantics');

    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.evidenceFiles.length).toBe(1);
    const file = result.value.evidenceFiles[0]!;

    const absPath = resolve(env.wsRoot, file.path);
    expect(existsSync(absPath)).toBe(true);

    const content = readFileSync(absPath, 'utf-8');
    expect(content).toContain('task_id: ' + task.id);
    expect(content).toContain('source_path: concepts/rust-ownership.md');
    expect(content).toContain('source_title: "Rust Ownership"');
    expect(content).toContain('source_type: concept');
    expect(content).toContain('Rust ownership enforces memory safety');
  });

  it('transitions the task from created to collecting', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'foo', {
      title: 'Foo',
      type: 'concept',
      body: 'Foo is a placeholder concept used in examples.',
    });

    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'What is foo?');

    const before = getTask(env.db, task.id);
    if (!before.ok) throw before.error;
    expect(before.value?.status).toBe('created');

    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(true);

    const after = getTask(env.db, task.id);
    if (!after.ok) throw after.error;
    expect(after.value?.status).toBe('collecting');
  });

  it('quotes source titles containing YAML-special characters (colons, quotes, backslashes)', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'tricky', {
      // Title contains a colon (would split YAML mapping), an embedded double
      // quote, and a backslash. JSON.stringify must produce a valid YAML
      // scalar that round-trips through any compliant YAML parser.
      title: 'Self-Attention: A "Primer" \\ Notes',
      type: 'concept',
      body: 'Body discussing trickytopic in detail.',
    });

    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'trickytopic');

    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const file = result.value.evidenceFiles[0]!;
    const content = readFileSync(resolve(env.wsRoot, file.path), 'utf-8');

    // The title appears as a JSON-escaped YAML flow scalar — colons are inside
    // the quoted string so YAML parsers won't mis-parse the line as a mapping.
    expect(content).toContain('source_title: "Self-Attention: A \\"Primer\\" \\\\ Notes"');
  });

  it('orders evidence files by rank with zero-padded numeric prefix', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'alpha', {
      title: 'Alpha',
      type: 'concept',
      body: 'Alpha beta gamma delta. Another sentence about alpha.',
    });
    writeWikiPage(env.wsRoot, 'concepts', 'beta', {
      title: 'Beta',
      type: 'concept',
      body: 'Beta refers to something else entirely.',
    });

    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'Alpha beta');

    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const evidenceDir = resolve(env.wsRoot, task.workspacePath, 'evidence');
    const files = readdirSync(evidenceDir).sort();
    expect(files.length).toBe(result.value.evidenceFiles.length);
    expect(files[0]).toMatch(/^01-/);
    if (files.length > 1) {
      expect(files[1]).toMatch(/^02-/);
    }
  });

  it('emits one evidence.collect trace event per file plus task.transition', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'page-a', {
      title: 'Page A',
      type: 'concept',
      body: 'Page A talks about xyzzy frobnication.',
    });
    writeWikiPage(env.wsRoot, 'concepts', 'page-b', {
      title: 'Page B',
      type: 'concept',
      body: 'Page B also mentions xyzzy frobnication.',
    });

    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'What is xyzzy frobnication?');

    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const evidenceTraces = readTraces(env.db, { eventType: 'evidence.collect' });
    if (!evidenceTraces.ok) throw evidenceTraces.error;
    expect(evidenceTraces.value.length).toBe(result.value.evidenceFiles.length);

    const transitions = readTraces(env.db, { eventType: 'task.transition' });
    if (!transitions.ok) throw transitions.error;
    expect(transitions.value.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe('collectEvidence — options', () => {
  it('caps evidence files at maxResults', () => {
    for (let i = 0; i < 5; i += 1) {
      writeWikiPage(env.wsRoot, 'concepts', `p${i}`, {
        title: `Page ${i}`,
        type: 'concept',
        body: 'Distinctive payload quokkaword appears here.',
      });
    }

    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'quokkaword');

    const result = collectEvidence(env.db, env.wsRoot, task.id, { maxResults: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.evidenceFiles.length).toBe(2);
  });

  it('truncates long bodies to maxExcerptChars and marks truncated=true', () => {
    const longBody = 'xenogloss payload '.repeat(1000);
    writeWikiPage(env.wsRoot, 'concepts', 'long-page', {
      title: 'Long Page',
      type: 'concept',
      body: longBody,
    });

    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'xenogloss');

    const result = collectEvidence(env.db, env.wsRoot, task.id, { maxExcerptChars: 200 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.evidenceFiles.length).toBe(1);
    expect(result.value.evidenceFiles[0]!.truncated).toBe(true);

    const abs = resolve(env.wsRoot, result.value.evidenceFiles[0]!.path);
    const content = readFileSync(abs, 'utf-8');
    expect(content).toContain('truncated: true');
    expect(content).toContain('[...truncated]');
  });

  it('marks truncated=false when body fits within maxExcerptChars', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'short', {
      title: 'Short',
      type: 'concept',
      body: 'Short body with specialword inside.',
    });

    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'specialword');

    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.evidenceFiles[0]!.truncated).toBe(false);
    const abs = resolve(env.wsRoot, result.value.evidenceFiles[0]!.path);
    expect(readFileSync(abs, 'utf-8')).toContain('truncated: false');
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('collectEvidence — error paths', () => {
  it('returns err when task does not exist', () => {
    const result = collectEvidence(env.db, env.wsRoot, 'nonexistent-task-id');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Task not found');
  });

  it('returns err when task is not in created state', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'thing', {
      title: 'Thing',
      type: 'concept',
      body: 'Thing payload.',
    });
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'thing');
    const firstRun = collectEvidence(env.db, env.wsRoot, task.id);
    expect(firstRun.ok).toBe(true);

    // Second run should fail — task is now 'collecting'.
    const secondRun = collectEvidence(env.db, env.wsRoot, task.id);
    expect(secondRun.ok).toBe(false);
    if (secondRun.ok) return;
    expect(secondRun.error.message).toContain("status 'collecting'");
  });

  it('returns err when brief.md is missing', () => {
    const created = createTask(env.db, env.wsRoot, 'test brief');
    if (!created.ok) throw created.error;
    // Deliberately skip writing brief.md.

    const result = collectEvidence(env.db, env.wsRoot, created.value.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Brief not found');
  });

  it('returns err when brief has no searchable terms after stop-word filter', () => {
    const task = createTaskWithBrief(env.db, env.wsRoot, 'what is the');
    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('no searchable terms');
  });

  it('returns err when no wiki pages match the brief, and leaves task in created', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'gardening', {
      title: 'Gardening',
      type: 'concept',
      body: 'Plants need water and sunlight.',
    });
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'quantum chromodynamics lattice gauge');
    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('No matching pages');

    const after = getTask(env.db, task.id);
    if (!after.ok) throw after.error;
    expect(after.value?.status).toBe('created');
  });

  it('returns err when brief body is empty after stripping frontmatter', () => {
    const created = createTask(env.db, env.wsRoot, 'placeholder');
    if (!created.ok) throw created.error;

    const briefPath = resolve(env.wsRoot, created.value.workspace_path, 'brief.md');
    writeFileSync(
      briefPath,
      ['---', `task_id: ${created.value.id}`, 'status: created', '---', '', ''].join('\n'),
      'utf-8',
    );

    const result = collectEvidence(env.db, env.wsRoot, created.value.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Brief body is empty');
  });
});

// ---------------------------------------------------------------------------
// Idempotency guard
// ---------------------------------------------------------------------------

describe('collectEvidence — idempotency guard', () => {
  it('is not callable after the task has already collected', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'thing', {
      title: 'Thing',
      type: 'concept',
      body: 'Something about thingamajig.',
    });
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'thingamajig');
    const first = collectEvidence(env.db, env.wsRoot, task.id);
    expect(first.ok).toBe(true);

    const second = collectEvidence(env.db, env.wsRoot, task.id);
    expect(second.ok).toBe(false);
  });

  it('rejects collection for tasks that have manually advanced past created', () => {
    writeWikiPage(env.wsRoot, 'concepts', 'thing', {
      title: 'Thing',
      type: 'concept',
      body: 'Body.',
    });
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const task = createTaskWithBrief(env.db, env.wsRoot, 'thing');
    const t = transitionTask(env.db, env.wsRoot, task.id, 'collecting');
    expect(t.ok).toBe(true);

    const result = collectEvidence(env.db, env.wsRoot, task.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("status 'collecting'");
  });
});
