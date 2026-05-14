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
  };
});

vi.mock('@ico/compiler', async () => {
  const actual = await vi.importActual<typeof import('@ico/compiler')>('@ico/compiler');
  return {
    ...actual,
    createClaudeClient: vi.fn(() => ({ createCompletion: vi.fn() })),
    generateRecall: vi.fn(),
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

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { runRecallGenerate } from './recall.js';

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
