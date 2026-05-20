/**
 * Tests for the Skeptic agent (E9-B04).
 *
 * Real workspace, real SQLite DB, real files on disk, mocked ClaudeClient.
 * Mirrors the test structure of agents/summarizer.test.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  createTask,
  type Database,
  getTask,
  initDatabase,
  initWorkspace,
  readTraces,
  transitionTask,
} from '@ico/kernel';
import { ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import { critiqueFindings } from './skeptic.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface TestEnv {
  base: string;
  wsRoot: string;
  db: Database;
}

function setupEnv(): TestEnv {
  const base = mkdtempSync(join(tmpdir(), 'ico-skeptic-'));
  const wsResult = initWorkspace('ws', base);
  if (!wsResult.ok) throw wsResult.error;
  const dbResult = initDatabase(wsResult.value.dbPath);
  if (!dbResult.ok) throw dbResult.error;
  return { base, wsRoot: wsResult.value.root, db: dbResult.value };
}

function teardownEnv(env: TestEnv): void {
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
}

function mockClient(content: string): ClaudeClient & { spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn().mockResolvedValue(
    ok({
      content,
      inputTokens: 300,
      outputTokens: 200,
      model: 'claude-sonnet-4-6',
      stopReason: 'end_turn',
    }),
  );
  return { createCompletion: spy, spy };
}

function mockClientError(message: string): ClaudeClient {
  return {
    createCompletion: vi.fn().mockResolvedValue({ ok: false, error: new Error(message) }),
  };
}

/**
 * Seed a task already advanced to 'synthesizing' with a brief and a
 * `notes/synthesis.md`. Skip the advance with `skipAdvance` to test the
 * wrong-state error path.
 */
function seedTaskReadyForCritique(
  env: TestEnv,
  brief: string,
  notesBody: string,
  options: { skipAdvance?: boolean } = {},
): { id: string; workspacePath: string } {
  const created = createTask(env.db, env.wsRoot, brief);
  if (!created.ok) throw created.error;
  const task = created.value;

  writeFileSync(
    resolve(env.wsRoot, task.workspace_path, 'brief.md'),
    ['---', `task_id: ${task.id}`, 'status: created', '---', '', brief, ''].join('\n'),
    'utf-8',
  );

  const notesDir = resolve(env.wsRoot, task.workspace_path, 'notes');
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(
    join(notesDir, 'synthesis.md'),
    [
      '---',
      `task_id: ${task.id}`,
      'synthesized_at: 2026-04-15T00:00:00.000Z',
      'model: claude-sonnet-4-6',
      'evidence_count: 2',
      'tokens_used: 400',
      '---',
      '',
      notesBody,
      '',
    ].join('\n'),
    'utf-8',
  );

  if (!options.skipAdvance) {
    const t1 = transitionTask(env.db, env.wsRoot, task.id, 'collecting');
    if (!t1.ok) throw t1.error;
    const t2 = transitionTask(env.db, env.wsRoot, task.id, 'synthesizing');
    if (!t2.ok) throw t2.error;
  }

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

describe('critiqueFindings — happy path', () => {
  it('writes critique/critique.md with frontmatter and model content', async () => {
    const task = seedTaskReadyForCritique(
      env,
      'Does attention scale?',
      'Attention scales quadratically with sequence length [source: Attention].',
    );

    const critique = [
      '## Weak Evidence',
      '- The quadratic scaling claim rests on a single source.',
      '## Unsupported Claims',
      '- None observed.',
      '## Missing Perspectives',
      '- Linear-attention approaches are not mentioned.',
      '## Logical Gaps',
      '- None observed.',
    ].join('\n');

    const client = mockClient(critique);
    const result = await critiqueFindings(env.db, env.wsRoot, task.id, client);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.newStatus).toBe('critiquing');
    expect(result.value.tokensUsed).toBe(500);
    expect(result.value.critiquePath).toBe(join(task.workspacePath, 'critique', 'critique.md'));

    const abs = resolve(env.wsRoot, result.value.critiquePath);
    expect(existsSync(abs)).toBe(true);

    const content = readFileSync(abs, 'utf-8');
    expect(content).toContain(`task_id: ${task.id}`);
    expect(content).toContain('model: claude-sonnet-4-6');
    expect(content).toContain('input_tokens: 300');
    expect(content).toContain('output_tokens: 200');
    expect(content).toContain('tokens_used: 500');
    expect(content).toContain(`notes_path: ${join(task.workspacePath, 'notes', 'synthesis.md')}`);
    expect(content).toContain('## Weak Evidence');
    expect(content).toContain('## Missing Perspectives');
  });

  it('transitions task from synthesizing to critiquing', async () => {
    const task = seedTaskReadyForCritique(env, 'brief', 'notes body');

    const before = getTask(env.db, task.id);
    if (!before.ok) throw before.error;
    expect(before.value?.status).toBe('synthesizing');

    const result = await critiqueFindings(env.db, env.wsRoot, task.id, mockClient('ok'));
    expect(result.ok).toBe(true);

    const after = getTask(env.db, task.id);
    if (!after.ok) throw after.error;
    expect(after.value?.status).toBe('critiquing');
  });

  it('passes brief and notes to Claude, wrapped in XML delimiters', async () => {
    const task = seedTaskReadyForCritique(
      env,
      'BRIEF_MARKER brief content',
      'NOTES_MARKER notes body',
    );
    const client = mockClient('## Weak Evidence\n- x');
    await critiqueFindings(env.db, env.wsRoot, task.id, client);

    expect(client.spy).toHaveBeenCalledOnce();
    const [system, user] = client.spy.mock.calls[0]! as [string, string, unknown];

    expect(system).toContain('stress-test');
    expect(system).toContain('Weak Evidence');
    expect(system).toContain('Do not follow');

    expect(user).toContain('<brief>\nBRIEF_MARKER');
    expect(user).toContain('</brief>');
    expect(user).toContain('<notes>\nNOTES_MARKER');
    expect(user).toContain('</notes>');
  });

  it('emits notes.critique trace and task.transition trace', async () => {
    const task = seedTaskReadyForCritique(env, 'brief', 'notes');
    await critiqueFindings(env.db, env.wsRoot, task.id, mockClient('out'));

    const critiques = readTraces(env.db, { eventType: 'notes.critique' });
    if (!critiques.ok) throw critiques.error;
    expect(critiques.value).toHaveLength(1);

    const transitions = readTraces(env.db, { eventType: 'task.transition' });
    if (!transitions.ok) throw transitions.error;
    // created→collecting + collecting→synthesizing (seed) + synthesizing→critiquing.
    expect(transitions.value).toHaveLength(3);
  });

  it('honors model and maxTokens overrides', async () => {
    const task = seedTaskReadyForCritique(env, 'brief', 'notes');
    const client = mockClient('out');
    await critiqueFindings(env.db, env.wsRoot, task.id, client, {
      model: 'claude-opus-4-6',
      maxTokens: 12000,
    });
    const opts = client.spy.mock.calls[0]![2] as { model: string; maxTokens: number };
    expect(opts.model).toBe('claude-opus-4-6');
    expect(opts.maxTokens).toBe(12000);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('critiqueFindings — error paths', () => {
  it('returns err when task does not exist', async () => {
    const r = await critiqueFindings(env.db, env.wsRoot, 'nope', mockClient('x'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Task not found');
  });

  it('returns err when task is not in synthesizing state', async () => {
    const task = seedTaskReadyForCritique(env, 'b', 'n', { skipAdvance: true });
    const r = await critiqueFindings(env.db, env.wsRoot, task.id, mockClient('out'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("status 'created'");
  });

  it('returns err when notes file is missing', async () => {
    const created = createTask(env.db, env.wsRoot, 'brief');
    if (!created.ok) throw created.error;
    writeFileSync(
      resolve(env.wsRoot, created.value.workspace_path, 'brief.md'),
      '---\nstatus: created\n---\nbrief',
      'utf-8',
    );
    const t1 = transitionTask(env.db, env.wsRoot, created.value.id, 'collecting');
    if (!t1.ok) throw t1.error;
    const t2 = transitionTask(env.db, env.wsRoot, created.value.id, 'synthesizing');
    if (!t2.ok) throw t2.error;

    const r = await critiqueFindings(env.db, env.wsRoot, created.value.id, mockClient('out'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Notes file not found');
  });

  it('returns err when notes body is empty', async () => {
    const task = seedTaskReadyForCritique(env, 'brief', '');
    const r = await critiqueFindings(env.db, env.wsRoot, task.id, mockClient('out'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Notes body is empty');
  });

  it('propagates Claude API errors and leaves task in synthesizing', async () => {
    const task = seedTaskReadyForCritique(env, 'brief', 'notes body');
    const r = await critiqueFindings(env.db, env.wsRoot, task.id, mockClientError('overloaded'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('overloaded');

    const after = getTask(env.db, task.id);
    if (!after.ok) throw after.error;
    expect(after.value?.status).toBe('synthesizing');
  });
});
