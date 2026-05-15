/**
 * Tests for the `ico recall generate` command (E9-B08).
 *
 * Mocks `@ico/kernel`, `@ico/compiler`, and the workspace resolver. The
 * goal is to verify the command wires up correctly; the underlying logic
 * is covered by `compiler/src/recall/generate.test.ts`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('@ico/kernel', async () => {
  const actual = await vi.importActual<typeof import('@ico/kernel')>('@ico/kernel');
  return {
    ...actual,
    initDatabase: vi.fn(() => ({ ok: true, value: {} })),
    closeDatabase: vi.fn(),
    createSearchIndex: vi.fn(() => ({ ok: true, value: undefined })),
    indexCompiledPages: vi.fn(() => ({ ok: true, value: 3 })),
    loadConfig: vi.fn(() => ({ apiKey: 'sk-test', model: 'claude-sonnet-4-6' })),
    getWeakAreas: vi.fn(),
    getRetentionReport: vi.fn(),
  };
});

vi.mock('@ico/compiler', async () => {
  const actual = await vi.importActual<typeof import('@ico/compiler')>('@ico/compiler');
  return {
    ...actual,
    createClaudeClient: vi.fn(() => ({ createCompletion: vi.fn() })),
    generateRecall: vi.fn(),
    runQuiz: vi.fn(),
    exportRecallAnki: vi.fn(),
    calculateCost: vi.fn(() => 0.01),
  };
});

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import * as compilerModule from '@ico/compiler';
import * as kernelModule from '@ico/kernel';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { runRecallExport, runRecallGenerate, runRecallQuiz, runRecallWeak } from './recall.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ico-recall-cli-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function mockWorkspace(): void {
  vi.mocked(resolveWorkspace).mockReturnValue({
    ok: true,
    value: { root: tmpBase, dbPath: join(tmpBase, '.ico', 'state.db') },
  });
}

function mockGenerateSuccess(): void {
  vi.mocked(compilerModule.generateRecall).mockResolvedValue({
    ok: true,
    value: {
      topic: 'attention',
      cards: [
        {
          path: 'recall/cards/self-attention.md',
          conceptSlug: 'self-attention',
          concept: 'Self-Attention',
          sourcePages: ['concepts/self-attention.md'],
        },
      ],
      quiz: { path: 'recall/quizzes/attention.md', questionCount: 3 },
      sourcePages: ['concepts/self-attention.md'],
      inputTokens: 100,
      outputTokens: 50,
      tokensUsed: 150,
      model: 'claude-sonnet-4-6',
    },
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runRecallGenerate — happy path', () => {
  it('returns the generator result on success', async () => {
    mockWorkspace();
    mockGenerateSuccess();

    const result = await runRecallGenerate('attention', {}, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cards).toHaveLength(1);
    expect(result.value.quiz.questionCount).toBe(3);
  });

  it('forwards CLI flags (model, maxPages, maxTokens) to the generator', async () => {
    mockWorkspace();
    mockGenerateSuccess();

    await runRecallGenerate(
      'attention',
      { model: 'claude-opus-4-6', maxPages: 5, maxTokens: 8192 },
      {},
    );

    const [, , topic, , options] = vi.mocked(compilerModule.generateRecall).mock.calls[0]!;
    expect(topic).toBe('attention');
    expect(options).toMatchObject({
      model: 'claude-opus-4-6',
      maxPages: 5,
      maxTokens: 8192,
    });
  });

  it('falls back to config model when --model is not passed', async () => {
    mockWorkspace();
    mockGenerateSuccess();

    await runRecallGenerate('attention', {}, {});
    const options = vi.mocked(compilerModule.generateRecall).mock.calls[0]![4]!;
    expect(options.model).toBe('claude-sonnet-4-6');
  });

  it('prints JSON output when --json is passed', async () => {
    mockWorkspace();
    mockGenerateSuccess();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runRecallGenerate('attention', {}, { json: true });

    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('"topic": "attention"');
    expect(joined).toContain('"questionCount": 3');
    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('runRecallGenerate — error paths', () => {
  it('returns workspace-resolver errors verbatim', async () => {
    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: false,
      error: new Error('No workspace found'),
    });

    const r = await runRecallGenerate('x', {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('No workspace found');
  });

  it('returns generator errors verbatim', async () => {
    mockWorkspace();
    vi.mocked(compilerModule.generateRecall).mockResolvedValue({
      ok: false,
      error: new Error('No matching pages'),
    });

    const r = await runRecallGenerate('nonsense', {}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('No matching pages');
  });
});

// ---------------------------------------------------------------------------
// runRecallQuiz
// ---------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';

function mockQuizSuccess(): void {
  vi.mocked(compilerModule.runQuiz).mockResolvedValue({
    ok: true,
    value: {
      topic: 'attention',
      sessionId: 'quiz-test-001',
      mode: 'review',
      results: [
        {
          question: { index: 1, question: 'Q1', expectedAnswer: 'A1', concept: 'c1', sourcePages: [] },
          userAnswer: 'mine',
          correct: true,
          feedback: 'good',
          retentionScore: 1,
          responseTimeMs: 1234,
          resultId: 'row-1',
        },
        {
          question: { index: 2, question: 'Q2', expectedAnswer: 'A2', concept: 'c2', sourcePages: [] },
          userAnswer: 'mine',
          correct: false,
          feedback: 'missed',
          retentionScore: 0,
          responseTimeMs: 2345,
          resultId: 'row-2',
        },
      ],
      correctCount: 1,
      total: 2,
      weakConcepts: ['c2'],
      tokensUsed: 200,
      model: 'claude-sonnet-4-6',
    },
  });
}

describe('runRecallQuiz — happy path', () => {
  it('rejects when --topic is empty', async () => {
    mockWorkspace();
    const r = await runRecallQuiz({}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('--topic is required');
  });

  it('passes prepared answers from --answers-file', async () => {
    mockWorkspace();
    mockQuizSuccess();
    const answersPath = join(tmpBase, 'answers.json');
    writeFileSync(answersPath, JSON.stringify(['ans1', 'ans2']), 'utf-8');

    const r = await runRecallQuiz({ topic: 'attention', answersFile: answersPath }, {});
    expect(r.ok).toBe(true);

    const callOptions = vi.mocked(compilerModule.runQuiz).mock.calls[0]![4];
    expect(callOptions.answers).toEqual(['ans1', 'ans2']);
    expect(callOptions.prompter).toBeUndefined();
  });

  it('accepts answers in object form { answers: [...] }', async () => {
    mockWorkspace();
    mockQuizSuccess();
    const answersPath = join(tmpBase, 'answers.json');
    writeFileSync(answersPath, JSON.stringify({ answers: ['x', 'y'] }), 'utf-8');

    const r = await runRecallQuiz({ topic: 'attention', answersFile: answersPath }, {});
    expect(r.ok).toBe(true);
    const callOptions = vi.mocked(compilerModule.runQuiz).mock.calls[0]![4];
    expect(callOptions.answers).toEqual(['x', 'y']);
  });

  it('passes mode through (review|test)', async () => {
    mockWorkspace();
    mockQuizSuccess();
    const answersPath = join(tmpBase, 'a.json');
    writeFileSync(answersPath, '[]', 'utf-8');

    await runRecallQuiz({ topic: 't', mode: 'test', answersFile: answersPath }, {});
    const opts = vi.mocked(compilerModule.runQuiz).mock.calls[0]![4];
    expect(opts.mode).toBe('test');
  });

  it('defaults mode to "review" when omitted or invalid', async () => {
    mockWorkspace();
    mockQuizSuccess();
    const answersPath = join(tmpBase, 'a.json');
    writeFileSync(answersPath, '[]', 'utf-8');

    await runRecallQuiz({ topic: 't', mode: 'bogus', answersFile: answersPath }, {});
    const opts = vi.mocked(compilerModule.runQuiz).mock.calls[0]![4];
    expect(opts.mode).toBe('review');
  });

  it('slugifies the topic when looking up the quiz file', async () => {
    mockWorkspace();
    mockQuizSuccess();
    const answersPath = join(tmpBase, 'a.json');
    writeFileSync(answersPath, '[]', 'utf-8');

    await runRecallQuiz({ topic: 'Transformer Attention', answersFile: answersPath }, {});
    const slugArg = vi.mocked(compilerModule.runQuiz).mock.calls[0]![2];
    expect(slugArg).toBe('transformer-attention');
  });

  it('emits JSON output when --json is passed', async () => {
    mockWorkspace();
    mockQuizSuccess();
    const answersPath = join(tmpBase, 'a.json');
    writeFileSync(answersPath, '[]', 'utf-8');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runRecallQuiz({ topic: 'attention', answersFile: answersPath }, { json: true });

    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('"sessionId": "quiz-test-001"');
    expect(joined).toContain('"correctCount": 1');
    writeSpy.mockRestore();
  });
});

describe('runRecallQuiz — error paths', () => {
  it('returns err when answers file is missing', async () => {
    mockWorkspace();
    const r = await runRecallQuiz(
      { topic: 'attention', answersFile: join(tmpBase, 'does-not-exist.json') },
      {},
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Failed to read answers file');
  });

  it('returns err when answers file is not valid JSON', async () => {
    mockWorkspace();
    const p = join(tmpBase, 'bad.json');
    writeFileSync(p, 'not json', 'utf-8');
    const r = await runRecallQuiz({ topic: 'attention', answersFile: p }, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('not valid JSON');
  });

  it('returns err when answers file is the wrong shape', async () => {
    mockWorkspace();
    const p = join(tmpBase, 'bad.json');
    writeFileSync(p, JSON.stringify({ foo: 'bar' }), 'utf-8');
    const r = await runRecallQuiz({ topic: 'attention', answersFile: p }, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('array of strings');
  });

  it('propagates runQuiz errors verbatim', async () => {
    mockWorkspace();
    vi.mocked(compilerModule.runQuiz).mockResolvedValue({
      ok: false,
      error: new Error('Quiz file not found'),
    });
    const p = join(tmpBase, 'a.json');
    writeFileSync(p, '[]', 'utf-8');
    const r = await runRecallQuiz({ topic: 'nope', answersFile: p }, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Quiz file not found');
  });
});

// ---------------------------------------------------------------------------
// runRecallWeak
// ---------------------------------------------------------------------------

describe('runRecallWeak', () => {
  it('returns weak areas and forwards limit + minSampleSize', () => {
    mockWorkspace();
    vi.mocked(kernelModule.getWeakAreas).mockReturnValue({
      ok: true,
      value: [
        { concept: 'c1', total: 4, correct: 1, retention: 0.25, lastTestedAt: '2026-04-08T12:00:00Z' },
      ],
    });

    const r = runRecallWeak({ limit: 3, minSampleSize: 2 }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.weak).toHaveLength(1);
    expect(r.value.report).toBeNull();

    const callOpts = vi.mocked(kernelModule.getWeakAreas).mock.calls[0]![1];
    expect(callOpts).toMatchObject({ limit: 3, minSampleSize: 2 });
  });

  it('includes the full report when --report is passed', () => {
    mockWorkspace();
    vi.mocked(kernelModule.getWeakAreas).mockReturnValue({ ok: true, value: [] });
    vi.mocked(kernelModule.getRetentionReport).mockReturnValue({
      ok: true,
      value: {
        totalAnswers: 10,
        totalCorrect: 7,
        overall: 0.7,
        conceptCount: 3,
        weakest: [],
        strongest: [],
      },
    });

    const r = runRecallWeak({ report: true }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.report?.overall).toBe(0.7);
    expect(kernelModule.getRetentionReport).toHaveBeenCalledTimes(1);
  });

  it('emits JSON when --json is passed', () => {
    mockWorkspace();
    vi.mocked(kernelModule.getWeakAreas).mockReturnValue({
      ok: true,
      value: [
        { concept: 'c1', total: 2, correct: 0, retention: 0, lastTestedAt: '2026-04-08T12:00:00Z' },
      ],
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runRecallWeak({}, { json: true });
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('"weak"');
    expect(joined).toContain('"concept": "c1"');
    expect(joined).toContain('"report": null');
    writeSpy.mockRestore();
  });

  it('propagates kernel errors verbatim', () => {
    mockWorkspace();
    vi.mocked(kernelModule.getWeakAreas).mockReturnValue({
      ok: false,
      error: new Error('table corrupt'),
    });
    const r = runRecallWeak({}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('table corrupt');
  });
});

// ---------------------------------------------------------------------------
// runRecallExport
// ---------------------------------------------------------------------------

function mockExportSuccess(): void {
  vi.mocked(compilerModule.exportRecallAnki).mockReturnValue({
    ok: true,
    value: {
      tsv: 'front\tback\ttopic:t source:s\n',
      cards: [
        {
          sourcePath: 'recall/cards/c.md',
          front: 'front',
          back: 'back',
          tags: 'topic:t source:s',
          concept: 'C',
          topic: 't',
        },
      ],
      outPath: null,
    },
  });
}

describe('runRecallExport', () => {
  it('writes TSV to stdout when --out is omitted', () => {
    mockWorkspace();
    mockExportSuccess();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const r = runRecallExport({}, {});
    expect(r.ok).toBe(true);
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('front\tback\ttopic:t source:s');
    writeSpy.mockRestore();
  });

  it('forwards --topic and --out to the exporter', () => {
    mockWorkspace();
    mockExportSuccess();
    runRecallExport({ topic: 'attention', out: 'recall/exports/x.txt' }, {});
    const opts = vi.mocked(compilerModule.exportRecallAnki).mock.calls[0]![1];
    expect(opts).toMatchObject({ topic: 'attention', outPath: 'recall/exports/x.txt' });
  });

  it('emits JSON when --json is passed', () => {
    mockWorkspace();
    mockExportSuccess();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runRecallExport({}, { json: true });
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('"tsv"');
    expect(joined).toContain('"cards"');
    writeSpy.mockRestore();
  });

  it('rejects formats other than anki', () => {
    mockWorkspace();
    const r = runRecallExport({ format: 'csv' }, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("Unsupported format 'csv'");
  });

  it('propagates exporter errors verbatim', () => {
    mockWorkspace();
    vi.mocked(compilerModule.exportRecallAnki).mockReturnValue({
      ok: false,
      error: new Error('No card files'),
    });
    const r = runRecallExport({}, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('No card files');
  });
});
