/**
 * Tests for the Research Orchestrator (E9-B06).
 *
 * Integration-first: each test builds a real workspace, real SQLite DB,
 * seeds compiled wiki pages for the Collector to search, creates a real
 * task, and mocks the ClaudeClient to produce deterministic stage
 * outputs. Covers the full happy path, resume-from-mid-pipeline,
 * step-mode pausing, stage failure / recoverable state, budget
 * exceeded, retry-from-failure, and terminal-status no-ops.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { ok, type Result } from '@ico/types';

import type { ClaudeClient, CompletionResult } from '../api/claude-client.js';
import { executeResearch, type Stage } from './orchestrator.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface TestEnv {
  base: string;
  wsRoot: string;
  db: Database;
}

function setupEnv(): TestEnv {
  const base = mkdtempSync(join(tmpdir(), 'ico-orchestrator-'));
  const wsResult = initWorkspace('ws', base);
  if (!wsResult.ok) throw wsResult.error;
  const dbResult = initDatabase(wsResult.value.dbPath);
  if (!dbResult.ok) throw dbResult.error;
  const idxResult = createSearchIndex(dbResult.value);
  if (!idxResult.ok) throw idxResult.error;
  return { base, wsRoot: wsResult.value.root, db: dbResult.value };
}

function teardownEnv(env: TestEnv): void {
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
}

/** Seed a compiled wiki page the Collector's FTS5 search can find. */
function writeWikiPage(
  wsRoot: string,
  dir: string,
  slug: string,
  title: string,
  body: string,
): void {
  const abs = resolve(wsRoot, 'wiki', dir, `${slug}.md`);
  mkdirSync(resolve(wsRoot, 'wiki', dir), { recursive: true });
  const content = [
    '---',
    `title: ${title}`,
    'type: concept',
    'tags: attention,transformer',
    '---',
    '',
    body,
    '',
  ].join('\n');
  writeFileSync(abs, content, 'utf-8');
}

/** Create a task and its brief.md (the Collector reads brief.md). */
function createTaskWithBrief(
  env: TestEnv,
  briefText: string,
): { id: string; workspacePath: string } {
  const created = createTask(env.db, env.wsRoot, briefText);
  if (!created.ok) throw created.error;
  const task = created.value;

  writeFileSync(
    resolve(env.wsRoot, task.workspace_path, 'brief.md'),
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

interface StagedResponse {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * ClaudeClient mock that returns the next staged response per call.
 * The Collector is deterministic and never hits the client; the
 * Summarizer, Skeptic, Integrator, and Render stages all do, in that
 * order. So a four-response queue covers the happy path.
 */
function stagedClient(
  responses: StagedResponse[],
): ClaudeClient & { spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn();
  for (const r of responses) {
    spy.mockResolvedValueOnce(
      ok<CompletionResult>({
        content: r.content,
        inputTokens: r.inputTokens ?? 100,
        outputTokens: r.outputTokens ?? 50,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      }),
    );
  }
  // Any extra calls beyond the staged queue fail loudly.
  spy.mockResolvedValue({ ok: false, error: new Error('stagedClient: call past end of queue') });
  return { createCompletion: spy, spy };
}

/**
 * Client that returns ok for the first N calls, then err on call N+1.
 * Used to exercise stage failure at a specific pipeline position.
 */
function failAfterClient(okCount: number, failMessage: string): ClaudeClient {
  const spy = vi.fn();
  for (let i = 0; i < okCount; i++) {
    spy.mockResolvedValueOnce(
      ok<CompletionResult>({
        content: `stage ${i} content`,
        inputTokens: 100,
        outputTokens: 50,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      }),
    );
  }
  const failResult: Result<CompletionResult, Error> = { ok: false, error: new Error(failMessage) };
  spy.mockResolvedValue(failResult);
  return { createCompletion: spy };
}

/**
 * A "big tokens" client that returns large input_tokens per call — used to
 * drive the cumulative total past a small budget within a few stages.
 */
function bigTokensClient(tokensPerCall: number): ClaudeClient {
  const spy = vi.fn().mockResolvedValue(
    ok<CompletionResult>({
      content: 'large response',
      inputTokens: tokensPerCall,
      outputTokens: 0,
      model: 'claude-sonnet-4-6',
      stopReason: 'end_turn',
    }),
  );
  return { createCompletion: spy };
}

/** Seed a standard wiki corpus that the Collector can find the brief in. */
function seedCorpus(env: TestEnv): void {
  writeWikiPage(
    env.wsRoot,
    'concepts',
    'attention',
    'Self-Attention',
    'Self-attention scales quadratically with sequence length.',
  );
  writeWikiPage(
    env.wsRoot,
    'concepts',
    'transformer',
    'Transformer Architecture',
    'The transformer architecture uses multi-head self-attention.',
  );
  const idxR = indexCompiledPages(env.db, env.wsRoot);
  if (!idxR.ok) throw idxR.error;
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
  delete process.env['ICO_MAX_RESEARCH_TOKENS'];
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('executeResearch — happy path', () => {
  it('runs all four stages + render and transitions to completed', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'How does self-attention scale?');

    const client = stagedClient([
      { content: 'Notes: attention scales quadratically [source: Self-Attention].' },
      { content: '## Weak Evidence\n- Single source.\n\n## Unsupported Claims\n- None.' },
      { content: '## Direct Answer\nIt scales quadratically [source: Self-Attention].' },
      { content: '# Report\n\nSelf-attention scales quadratically.' },
    ]);

    const r = await executeResearch(env.db, env.wsRoot, task.id, {
      client,
      maxTokens: 10_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if ('currentStatus' in r.value) throw new Error('expected completed result, got paused');

    expect(r.value.finalStatus).toBe('completed');
    expect(r.value.stagesRun).toEqual(['collect', 'summarize', 'critique', 'integrate', 'render']);
    expect(r.value.tokensUsed).toBeGreaterThan(0);
    // Collector does not bill tokens.
    expect(r.value.stageTokens.collect).toBe(0);
    // Every Claude stage billed the same 150 tokens (100 input + 50 output).
    expect(r.value.stageTokens.summarize).toBe(150);
    expect(r.value.stageTokens.critique).toBe(150);
    expect(r.value.stageTokens.integrate).toBe(150);
    expect(r.value.stageTokens.render).toBe(150);

    // Task record is in `completed`.
    const post = getTask(env.db, task.id);
    expect(post.ok && post.value?.status).toBe('completed');

    // Integrator final.md and renderReport report both exist.
    expect(existsSync(resolve(env.wsRoot, task.workspacePath, 'output', 'final.md'))).toBe(true);
    expect(r.value.reportPath).toMatch(/^outputs\/reports\//);
    expect(existsSync(resolve(env.wsRoot, r.value.reportPath))).toBe(true);

    // Orchestrator traces cover start, every stage_start/complete, complete.
    const traces = readTraces(env.db);
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;
    const events = traces.value.map((e) => e.event_type);
    expect(events).toContain('orchestrator.start');
    expect(events).toContain('orchestrator.complete');
    expect(events.filter((e) => e === 'orchestrator.stage_start')).toHaveLength(5);
    expect(events.filter((e) => e === 'orchestrator.stage_complete')).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Resume from mid-pipeline
// ---------------------------------------------------------------------------

describe('executeResearch — resume', () => {
  it('picks up from critique when the task is already in synthesizing', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'Resume attention transformer test');

    // Pre-advance to synthesizing and seed the prerequisite files the
    // Skeptic expects (notes/synthesis.md) and everything downstream.
    for (const s of ['collecting', 'synthesizing'] as const) {
      const tr = transitionTask(env.db, env.wsRoot, task.id, s);
      if (!tr.ok) throw tr.error;
    }
    const notesDir = resolve(env.wsRoot, task.workspacePath, 'notes');
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(
      join(notesDir, 'synthesis.md'),
      [
        '---',
        `task_id: ${task.id}`,
        'synthesized_at: 2026-04-15T00:00:00.000Z',
        'model: claude-sonnet-4-6',
        'tokens_used: 150',
        '---',
        '',
        'Pre-seeded notes body.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const client = stagedClient([
      { content: '## Weak Evidence\n- seed only.' },
      { content: '## Direct Answer\nBased on seed.' },
      { content: '# Report\nFrom resumed run.' },
    ]);

    const r = await executeResearch(env.db, env.wsRoot, task.id, {
      client,
      maxTokens: 10_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if ('currentStatus' in r.value) throw new Error('expected completed');

    expect(r.value.stagesRun).toEqual(['critique', 'integrate', 'render']);
    expect(r.value.finalStatus).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Step mode
// ---------------------------------------------------------------------------

describe('executeResearch — step mode', () => {
  it('runs exactly one stage when step is true and no confirmStep is supplied', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'Step mode attention test');

    const client = stagedClient([{ content: 'summarizer output' }]);

    const r = await executeResearch(env.db, env.wsRoot, task.id, {
      client,
      step: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (!('currentStatus' in r.value)) throw new Error('expected paused result');

    expect(r.value.stagesRun).toEqual(['collect']);
    expect(r.value.reason).toBe('step');
    expect(r.value.currentStatus).toBe('collecting');

    // Task should be in 'collecting' on disk.
    const post = getTask(env.db, task.id);
    expect(post.ok && post.value?.status).toBe('collecting');
  });

  it('advances until confirmStep returns false', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'Confirm step attention test');

    const client = stagedClient([{ content: 'summarizer output' }, { content: 'skeptic output' }]);

    let callCount = 0;
    const confirmStep = vi.fn(() => {
      callCount += 1;
      // Allow summarize (1) and critique (2), reject integrate (3).
      return Promise.resolve(callCount < 3);
    });

    const r = await executeResearch(env.db, env.wsRoot, task.id, {
      client,
      step: true,
      confirmStep,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (!('currentStatus' in r.value)) throw new Error('expected paused result');

    expect(r.value.stagesRun).toEqual(['collect', 'summarize', 'critique']);
    expect(r.value.reason).toBe('operator_aborted');
    expect(r.value.currentStatus).toBe('critiquing');
    expect(confirmStep).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Stage failure
// ---------------------------------------------------------------------------

describe('executeResearch — stage failure', () => {
  it('transitions to failed_synthesizing when the summarizer fails', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'Failure attention test');

    // Collector is deterministic (runs OK); summarizer fails on call 1.
    const client = failAfterClient(0, 'simulated rate limit');

    const r = await executeResearch(env.db, env.wsRoot, task.id, {
      client,
      maxTokens: 10_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/simulated rate limit/);

    const post = getTask(env.db, task.id);
    expect(post.ok && post.value?.status).toBe('failed_synthesizing');

    const traces = readTraces(env.db);
    if (!traces.ok) throw traces.error;
    const abortEvent = traces.value.find((e) => e.event_type === 'orchestrator.abort');
    expect(abortEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

describe('executeResearch — budget', () => {
  it('aborts mid-pipeline and emits an abort trace when tokens exceed the budget', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'Budget attention test');

    // Summarizer alone will return 10_000 input tokens, which exceeds a
    // tight 5_000 budget.
    const client = bigTokensClient(10_000);

    const r = await executeResearch(env.db, env.wsRoot, task.id, {
      client,
      maxTokens: 5_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/budget exceeded/i);

    // The completed stage's work is real — the orchestrator deliberately
    // leaves the task in its post-stage status so a later invocation with
    // a larger budget can resume from the next stage.
    const post = getTask(env.db, task.id);
    expect(post.ok && post.value?.status).toBe('synthesizing');

    const traces = readTraces(env.db);
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;
    const abort = traces.value.find((e) => e.event_type === 'orchestrator.abort');
    expect(abort).toBeDefined();
  });

  it('reads the budget from ICO_MAX_RESEARCH_TOKENS when options.maxTokens is unset', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'Env budget attention test');
    process.env['ICO_MAX_RESEARCH_TOKENS'] = '5000';

    const client = bigTokensClient(10_000);
    const r = await executeResearch(env.db, env.wsRoot, task.id, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/budget exceeded/i);
  });
});

// ---------------------------------------------------------------------------
// Retry from failure
// ---------------------------------------------------------------------------

describe('executeResearch — retry', () => {
  it('refuses to run on a failed_* task unless retry:true is set', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'Retry gate attention test');

    // Manually push the task into failed_critiquing via kernel edges.
    for (const s of ['collecting', 'synthesizing', 'failed_critiquing'] as const) {
      const tr = transitionTask(env.db, env.wsRoot, task.id, s);
      if (!tr.ok) throw tr.error;
    }

    const client = stagedClient([]);
    const r = await executeResearch(env.db, env.wsRoot, task.id, { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/failed_critiquing/);
    expect(r.error.message).toMatch(/retry: true/);

    // Status unchanged.
    const post = getTask(env.db, task.id);
    expect(post.ok && post.value?.status).toBe('failed_critiquing');
  });

  it('rolls back and resumes when retry:true is set', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'Retry resume attention test');

    // Manually advance + seed notes so the skeptic has input on retry.
    for (const s of ['collecting', 'synthesizing'] as const) {
      const tr = transitionTask(env.db, env.wsRoot, task.id, s);
      if (!tr.ok) throw tr.error;
    }
    const notesDir = resolve(env.wsRoot, task.workspacePath, 'notes');
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(
      join(notesDir, 'synthesis.md'),
      [
        '---',
        `task_id: ${task.id}`,
        'synthesized_at: 2026-04-15T00:00:00.000Z',
        'model: claude-sonnet-4-6',
        'tokens_used: 150',
        '---',
        '',
        'Seed notes.',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Now push into failed_critiquing.
    const tr = transitionTask(env.db, env.wsRoot, task.id, 'failed_critiquing');
    if (!tr.ok) throw tr.error;

    const client = stagedClient([
      { content: '## Weak Evidence\n- retry.' },
      { content: '## Direct Answer\nRetry worked.' },
      { content: '# Report\nRetry produced this report.' },
    ]);

    const r = await executeResearch(env.db, env.wsRoot, task.id, {
      client,
      retry: true,
      maxTokens: 10_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if ('currentStatus' in r.value) throw new Error('expected completed');
    expect(r.value.stagesRun).toEqual(['critique', 'integrate', 'render']);

    const post = getTask(env.db, task.id);
    expect(post.ok && post.value?.status).toBe('completed');

    const traces = readTraces(env.db);
    if (!traces.ok) throw traces.error;
    const retryEvent = traces.value.find((e) => e.event_type === 'orchestrator.retry');
    expect(retryEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Terminal state no-op + missing task
// ---------------------------------------------------------------------------

describe('executeResearch — terminal & missing', () => {
  it('returns ok with no stages run when the task is already completed', async () => {
    seedCorpus(env);
    const task = createTaskWithBrief(env, 'Already done attention task');

    for (const s of [
      'collecting',
      'synthesizing',
      'critiquing',
      'rendering',
      'completed',
    ] as const) {
      const tr = transitionTask(env.db, env.wsRoot, task.id, s);
      if (!tr.ok) throw tr.error;
    }

    const client = stagedClient([]);
    const r = await executeResearch(env.db, env.wsRoot, task.id, { client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if ('currentStatus' in r.value) throw new Error('expected completed');
    expect(r.value.stagesRun).toEqual([]);
    expect(r.value.finalStatus).toBe('completed');
  });

  it('returns err for a nonexistent task', async () => {
    const client = stagedClient([]);
    const r = await executeResearch(env.db, env.wsRoot, 'no-such-task', { client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Stage type sanity
// ---------------------------------------------------------------------------

describe('Stage type', () => {
  it('exports the five pipeline stages', () => {
    const stages: Stage[] = ['collect', 'summarize', 'critique', 'integrate', 'render'];
    expect(stages).toHaveLength(5);
  });
});
