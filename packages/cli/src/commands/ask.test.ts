/**
 * Tests for `runAsk` (E10-B09 — coverage gap closure).
 *
 * The compiler-layer functions (`analyzeQuestion`, `generateAnswer`,
 * `verifyCitations`) are already covered by their own tests and by
 * `ask-integration.test.ts`. What was missing was direct coverage of
 * `runAsk` itself — the CLI orchestrator that wires those together,
 * handles the no-knowledge fallback, prints output, writes the trace,
 * and surfaces token usage. Before this file, `ask.ts` sat at 0.8%
 * coverage.
 *
 * Strategy: mock at the `@ico/kernel` and `@ico/compiler` package
 * boundaries so the test never touches the network and never opens a
 * real database. Each test exercises one branch of `runAsk`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
    indexCompiledPages: vi.fn(() => ({ ok: true, value: 5 })),
    findRelevantPages: vi.fn(),
    loadConfig: vi.fn(() => ({ apiKey: 'sk-test', model: 'claude-sonnet-4-6' })),
    writeTrace: vi.fn(() => ({ ok: true, value: undefined })),
  };
});

vi.mock('@ico/compiler', async () => {
  const actual = await vi.importActual<typeof import('@ico/compiler')>('@ico/compiler');
  return {
    ...actual,
    createClaudeClient: vi.fn(() => ({ createCompletion: vi.fn() })),
    analyzeQuestion: vi.fn(),
    generateAnswer: vi.fn(),
    verifyCitations: vi.fn(),
    calculateCost: vi.fn(() => 0.012),
  };
});

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

import * as compilerModule from '@ico/compiler';
import * as kernelModule from '@ico/kernel';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { runAsk } from './ask.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpBase: string;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ico-ask-cli-'));
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
  process.exitCode = originalExitCode;
});

function mockWorkspace(): void {
  vi.mocked(resolveWorkspace).mockReturnValue({
    ok: true,
    value: { root: tmpBase, dbPath: join(tmpBase, '.ico', 'state.db') },
  });
}

function mockAnalysis(opts: {
  pages?: Array<{ path: string; title: string; type: string; rank: number; snippet: string }>;
  type?: 'factual' | 'comparative' | 'analytical' | 'open-ended';
  suggestResearch?: boolean;
  question?: string;
}): void {
  vi.mocked(compilerModule.analyzeQuestion).mockReturnValue({
    ok: true,
    value: {
      originalQuestion: opts.question ?? 'test question',
      type: opts.type ?? 'factual',
      relevantPages: opts.pages ?? [],
      suggestResearch: opts.suggestResearch ?? false,
    },
  });
}

function mockBoost(pages: ReadonlyArray<{ path: string; title: string; type: string; rank: number; snippet: string }>): void {
  vi.mocked(kernelModule.findRelevantPages).mockReturnValue({ ok: true, value: [...pages] });
}

function seedWikiPage(relPath: string, body = 'Body content for the page.'): void {
  const abs = resolve(tmpBase, 'wiki', relPath);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
}

function mockGenerate(
  answer: string,
  citations: Array<{ pagePath: string; pageTitle: string; claim: string }> = [],
): void {
  vi.mocked(compilerModule.generateAnswer).mockResolvedValue({
    ok: true,
    value: {
      answer,
      citations,
      inputTokens: 800,
      outputTokens: 200,
    },
  });
}

function mockVerify(verified: number, unverified = 0): void {
  vi.mocked(compilerModule.verifyCitations).mockReturnValue({
    ok: true,
    value: {
      verified: Array.from({ length: verified }, (_, i) => ({
        pagePath: `p${i}.md`,
        pageTitle: `Page ${i}`,
        claim: `claim ${i}`,
      })),
      unverified: Array.from({ length: unverified }, (_, i) => ({
        pagePath: `u${i}.md`,
        pageTitle: `Unverified ${i}`,
        claim: `unverified claim ${i}`,
      })),
      provenanceChain: [
        { level: 'answer', path: 'answer', title: 'Answer' },
        { level: 'compiled-page', path: 'p0.md', title: 'Page 0' },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runAsk — happy path', () => {
  it('runs the full pipeline and writes a trace event', async () => {
    mockWorkspace();
    const pages = [
      { path: 'concepts/x.md', title: 'X', type: 'concept', rank: 0.5, snippet: '<b>X</b>' },
    ];
    mockAnalysis({ pages });
    mockBoost(pages);
    seedWikiPage('concepts/x.md', '# X\n\nDetails.');
    mockGenerate('X is a thing [Page 0].', [
      { pagePath: 'p0.md', pageTitle: 'Page 0', claim: 'X is a thing' },
    ]);
    mockVerify(1, 0);

    await runAsk('What is X?', {}, {});

    expect(compilerModule.analyzeQuestion).toHaveBeenCalledTimes(1);
    expect(compilerModule.generateAnswer).toHaveBeenCalledTimes(1);
    expect(compilerModule.verifyCitations).toHaveBeenCalledTimes(1);
    expect(kernelModule.writeTrace).toHaveBeenCalledTimes(1);
    const [, , eventType, payload] = vi.mocked(kernelModule.writeTrace).mock.calls[0]!;
    expect(eventType).toBe('ask');
    expect(payload['question']).toBe('What is X?');
    expect(payload['verifiedCitations']).toBe(1);
  });

  it('forwards --model and --max-tokens to generateAnswer', async () => {
    mockWorkspace();
    const pages = [
      { path: 'concepts/x.md', title: 'X', type: 'concept', rank: 0.5, snippet: '<b>X</b>' },
    ];
    mockAnalysis({ pages });
    mockBoost(pages);
    seedWikiPage('concepts/x.md');
    mockGenerate('answer');
    mockVerify(0);

    await runAsk('Q?', { model: 'claude-opus-4-6', maxTokens: 8192 }, {});

    const opts = vi.mocked(compilerModule.generateAnswer).mock.calls[0]![3] as {
      model?: string;
      maxTokens?: number;
    };
    expect(opts.model).toBe('claude-opus-4-6');
    expect(opts.maxTokens).toBe(8192);
  });

  it('emits the suggest-research hint when analysis flags it', async () => {
    mockWorkspace();
    const pages = [
      { path: 'concepts/x.md', title: 'X', type: 'concept', rank: 0.5, snippet: '<b>X</b>' },
    ];
    mockAnalysis({ pages, suggestResearch: true });
    mockBoost(pages);
    seedWikiPage('concepts/x.md');
    mockGenerate('answer');
    mockVerify(0);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAsk('A deep question', {}, {});
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('ico research');
    writeSpy.mockRestore();
  });

  it('falls back gracefully when verifyCitations reports unverified entries', async () => {
    mockWorkspace();
    const pages = [
      { path: 'concepts/x.md', title: 'X', type: 'concept', rank: 0.5, snippet: '<b>X</b>' },
    ];
    mockAnalysis({ pages });
    mockBoost(pages);
    seedWikiPage('concepts/x.md');
    // Citations section is gated on `citations.length > 0` — pass a citation
    // so the unverified loop downstream gets a chance to print.
    mockGenerate('answer with one good, one bad citation', [
      { pagePath: 'p0.md', pageTitle: 'Page 0', claim: 'something' },
    ]);
    mockVerify(1, 2);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAsk('Q', {}, {});
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('unverified');
    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// No-knowledge fallback
// ---------------------------------------------------------------------------

describe('runAsk — no-knowledge fallback', () => {
  it('emits the fallback message when analysis returns zero pages', async () => {
    mockWorkspace();
    mockAnalysis({ pages: [] });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAsk('What is X?', {}, {});

    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toMatch(/No compiled knowledge found/);
    expect(joined).toContain('ico ingest');
    expect(joined).toContain('ico compile');
    // generateAnswer should NOT have been called — short-circuit branch.
    expect(compilerModule.generateAnswer).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('emits the fallback when all relevant pages fail to load from disk', async () => {
    mockWorkspace();
    // Analysis claims there's a relevant page, but the file isn't on disk;
    // pagesWithContent ends up empty and runAsk falls back.
    const pages = [
      { path: 'concepts/missing.md', title: 'Missing', type: 'concept', rank: 0.5, snippet: '...' },
    ];
    mockAnalysis({ pages });
    mockBoost(pages);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runAsk('Q?', {}, {});
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toMatch(/No compiled knowledge found/);
    expect(compilerModule.generateAnswer).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('runAsk — error paths', () => {
  it('sets exit code 1 when workspace cannot be resolved', async () => {
    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: false,
      error: new Error('No workspace found'),
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runAsk('Q?', {}, {});

    expect(process.exitCode).toBe(1);
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('No workspace found');
    errSpy.mockRestore();
  });

  it('sets exit code 1 when loadConfig throws', async () => {
    mockWorkspace();
    // `mockImplementationOnce` so we don't leak the throwing implementation
    // into subsequent tests (vi.clearAllMocks clears call history but not
    // implementations set via mockImplementation).
    vi.mocked(kernelModule.loadConfig).mockImplementationOnce(() => {
      throw new Error('Missing ANTHROPIC_API_KEY');
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runAsk('Q?', {}, {});
    expect(process.exitCode).toBe(1);
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('Config error');
    errSpy.mockRestore();
  });

  it('sets exit code 1 when initDatabase fails', async () => {
    mockWorkspace();
    vi.mocked(kernelModule.initDatabase).mockReturnValueOnce({
      ok: false,
      error: new Error('DB unreachable'),
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runAsk('Q?', {}, {});
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('Database error');
    errSpy.mockRestore();
  });

  it('sets exit code 1 when generateAnswer errors', async () => {
    mockWorkspace();
    const pages = [
      { path: 'concepts/x.md', title: 'X', type: 'concept', rank: 0.5, snippet: '<b>X</b>' },
    ];
    mockAnalysis({ pages });
    mockBoost(pages);
    seedWikiPage('concepts/x.md');
    vi.mocked(compilerModule.generateAnswer).mockResolvedValue({
      ok: false,
      error: new Error('Claude API rate_limit_error (HTTP 429)'),
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runAsk('Q?', {}, {});
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('Generation failed');
    errSpy.mockRestore();
  });

  it('sets exit code 1 when analyzeQuestion errors', async () => {
    mockWorkspace();
    vi.mocked(compilerModule.analyzeQuestion).mockReturnValue({
      ok: false,
      error: new Error('FTS5 index missing'),
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runAsk('Q?', {}, {});
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('Analysis failed');
    errSpy.mockRestore();
  });
});
