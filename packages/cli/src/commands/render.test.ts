/**
 * Unit tests for the `ico render` command (E8-B03).
 *
 * Tests exercise `runRender` and `findTopicPages` directly — no child process
 * is spawned. All external dependencies (@ico/compiler, @ico/kernel) are mocked.
 *
 * @module commands/render.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('@ico/compiler', async () => {
  const actual = await vi.importActual<typeof import('@ico/compiler')>('@ico/compiler');
  return {
    ...actual,
    renderReport: vi.fn(),
    renderSlides: vi.fn(),
    createClaudeClient: vi.fn(() => ({ createCompletion: vi.fn() })),
    calculateCost: vi.fn(() => 0.0012),
  };
});

vi.mock('@ico/kernel', async () => {
  const actual = await vi.importActual<typeof import('@ico/kernel')>('@ico/kernel');
  return {
    ...actual,
    loadConfig: vi.fn(() => ({ apiKey: 'test-api-key', model: 'claude-sonnet-4-6' })),
    initDatabase: vi.fn(() => ({ ok: true, value: {} })),
    closeDatabase: vi.fn(),
    writeTrace: vi.fn(),
  };
});

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks are set up
// ---------------------------------------------------------------------------

import * as compilerModule from '@ico/compiler';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { findTopicPages, runRender } from './render.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOPIC_PAGE = `---
type: topic
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
title: "Transformer Architecture"
source_ids: [ffffffff-0000-1111-2222-333333333333]
compiled_at: 2026-01-01T00:00:00.000Z
model: claude-sonnet-4-6
tags: [ml, transformers]
---

## Summary

The transformer architecture uses self-attention for sequence processing.
`;

const CONCEPT_PAGE = `---
type: concept
id: bbbbbbbb-cccc-dddd-eeee-ffffffffffff
title: "Self-Attention"
definition: A mechanism allowing tokens to attend to each other.
source_ids: [ffffffff-0000-1111-2222-333333333333]
compiled_at: 2026-01-01T00:00:00.000Z
model: claude-sonnet-4-6
tags: [ml, attention]
---

## Body

Self-attention is the core of transformers.
`;

// ---------------------------------------------------------------------------
// Per-test workspace setup
// ---------------------------------------------------------------------------

let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ico-render-test-'));
  // Reset all mocks before each test
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findTopicPages unit tests
// ---------------------------------------------------------------------------

describe('findTopicPages', () => {
  it('returns an empty array when wiki directory does not exist', () => {
    const result = findTopicPages(join(tmpBase, 'wiki'), 'anything');
    expect(result).toHaveLength(0);
  });

  it('finds a page by exact slug match in topics/', () => {
    const topicsDir = join(tmpBase, 'wiki', 'topics');
    mkdirSync(topicsDir, { recursive: true });
    writeFileSync(join(topicsDir, 'transformer-architecture.md'), TOPIC_PAGE, 'utf-8');

    const result = findTopicPages(join(tmpBase, 'wiki'), 'transformer architecture');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('transformer-architecture.md');
  });

  it('finds a page by frontmatter title fuzzy match in concepts/', () => {
    const conceptsDir = join(tmpBase, 'wiki', 'concepts');
    mkdirSync(conceptsDir, { recursive: true });
    // Filename slug does NOT match "self-attention" but title does
    writeFileSync(join(conceptsDir, 'sa-mechanism.md'), CONCEPT_PAGE, 'utf-8');

    const result = findTopicPages(join(tmpBase, 'wiki'), 'self-attention');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('sa-mechanism.md');
  });

  it('finds pages across multiple subdirectories', () => {
    const topicsDir = join(tmpBase, 'wiki', 'topics');
    const conceptsDir = join(tmpBase, 'wiki', 'concepts');
    mkdirSync(topicsDir, { recursive: true });
    mkdirSync(conceptsDir, { recursive: true });

    // Both pages have "transformer" in their title
    writeFileSync(join(topicsDir, 'transformer-architecture.md'), TOPIC_PAGE, 'utf-8');
    writeFileSync(
      join(conceptsDir, 'transformer-encoder.md'),
      CONCEPT_PAGE.replace('Self-Attention', 'Transformer Encoder'),
      'utf-8',
    );

    const result = findTopicPages(join(tmpBase, 'wiki'), 'transformer');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array when no pages match', () => {
    const topicsDir = join(tmpBase, 'wiki', 'topics');
    mkdirSync(topicsDir, { recursive: true });
    writeFileSync(join(topicsDir, 'transformer-architecture.md'), TOPIC_PAGE, 'utf-8');

    const result = findTopicPages(join(tmpBase, 'wiki'), 'completely-unrelated-topic');
    expect(result).toHaveLength(0);
  });

  it('skips .gitkeep files', () => {
    const topicsDir = join(tmpBase, 'wiki', 'topics');
    mkdirSync(topicsDir, { recursive: true });
    writeFileSync(join(topicsDir, '.gitkeep'), '', 'utf-8');

    const result = findTopicPages(join(tmpBase, 'wiki'), '.gitkeep');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runRender — --task stub
// ---------------------------------------------------------------------------

describe('runRender — --task stub', () => {
  it('prints not-yet-implemented message and sets exitCode=1 for --task', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    const stdoutMessages: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
      stdoutMessages.push(String(msg));
      return true;
    });

    await runRender('report', { task: 'abc-123' }, {});

    spy.mockRestore();
    expect(process.exitCode).toBe(1);
    expect(stdoutMessages.join('')).toContain('Epic 9');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// runRender — missing --topic
// ---------------------------------------------------------------------------

describe('runRender — missing --topic', () => {
  it('writes an error and sets exitCode=1 when neither --topic nor --task provided', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    const stderrMessages: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrMessages.push(String(msg));
      return true;
    });

    await runRender('report', {}, {});

    spy.mockRestore();
    expect(process.exitCode).toBe(1);
    expect(stderrMessages.join('')).toContain('required');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// runRender — workspace resolution failure
// ---------------------------------------------------------------------------

describe('runRender — workspace resolution failure', () => {
  it('writes an error and sets exitCode=1 when workspace cannot be resolved', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: false,
      error: new Error('No workspace found'),
    });

    const stderrMessages: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrMessages.push(String(msg));
      return true;
    });

    await runRender('report', { topic: 'transformers' }, {});

    spy.mockRestore();
    expect(process.exitCode).toBe(1);
    expect(stderrMessages.join('')).toContain('No workspace found');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// runRender — no pages found for topic
// ---------------------------------------------------------------------------

describe('runRender — no pages found for topic', () => {
  it('writes an error and sets exitCode=1 when no wiki pages match the topic', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    // Create a workspace with an empty wiki
    mkdirSync(join(tmpBase, '.ico'), { recursive: true });
    writeFileSync(join(tmpBase, '.ico', 'state.db'), '');
    mkdirSync(join(tmpBase, 'wiki', 'topics'), { recursive: true });

    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: true,
      value: { root: tmpBase, dbPath: join(tmpBase, '.ico', 'state.db') },
    });

    const stderrMessages: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrMessages.push(String(msg));
      return true;
    });

    await runRender('report', { topic: 'nonexistent-topic' }, {});

    spy.mockRestore();
    expect(process.exitCode).toBe(1);
    expect(stderrMessages.join('')).toContain('No compiled pages found');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// runRender — successful report render
// ---------------------------------------------------------------------------

describe('runRender — successful report render', () => {
  it('calls renderReport and displays success with output path and token info', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    // Set up workspace with a matching wiki page
    mkdirSync(join(tmpBase, '.ico'), { recursive: true });
    writeFileSync(join(tmpBase, '.ico', 'state.db'), '');
    const topicsDir = join(tmpBase, 'wiki', 'topics');
    mkdirSync(topicsDir, { recursive: true });
    writeFileSync(join(topicsDir, 'transformer-architecture.md'), TOPIC_PAGE, 'utf-8');

    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: true,
      value: { root: tmpBase, dbPath: join(tmpBase, '.ico', 'state.db') },
    });

    vi.mocked(compilerModule.renderReport).mockResolvedValue({
      ok: true,
      value: {
        markdown: '# Report\n\nContent.',
        outputPath: join(tmpBase, 'outputs', 'reports', 'report.md'),
        title: 'Report: Transformer Architecture',
        inputTokens: 800,
        outputTokens: 400,
        model: 'claude-sonnet-4-6',
      },
    });

    const stdoutMessages: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
      stdoutMessages.push(String(msg));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRender('report', { topic: 'transformer architecture' }, {});

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(process.exitCode).toBe(0);
    expect(compilerModule.renderReport).toHaveBeenCalledOnce();
    const output = stdoutMessages.join('');
    expect(output).toContain('Report Generated');
    expect(output).toContain('Saved:');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// runRender — successful slides render
// ---------------------------------------------------------------------------

describe('runRender — successful slides render', () => {
  it('calls renderSlides and displays success with slide count info', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    // Set up workspace with a matching wiki page
    mkdirSync(join(tmpBase, '.ico'), { recursive: true });
    writeFileSync(join(tmpBase, '.ico', 'state.db'), '');
    const conceptsDir = join(tmpBase, 'wiki', 'concepts');
    mkdirSync(conceptsDir, { recursive: true });
    writeFileSync(join(conceptsDir, 'self-attention.md'), CONCEPT_PAGE, 'utf-8');

    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: true,
      value: { root: tmpBase, dbPath: join(tmpBase, '.ico', 'state.db') },
    });

    vi.mocked(compilerModule.renderSlides).mockResolvedValue({
      ok: true,
      value: {
        markdown: '---\nmarp: true\n---\n# Title',
        outputPath: 'outputs/slides/self-attention.md',
        title: 'Self-Attention',
        slideCount: 5,
        inputTokens: 600,
        outputTokens: 300,
        model: 'claude-sonnet-4-6',
      },
    });

    const stdoutMessages: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((msg) => {
      stdoutMessages.push(String(msg));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRender('slides', { topic: 'self-attention' }, {});

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(process.exitCode).toBe(0);
    expect(compilerModule.renderSlides).toHaveBeenCalledOnce();
    const output = stdoutMessages.join('');
    expect(output).toContain('Slide Deck Generated');
    expect(output).toContain('Saved:');

    process.exitCode = originalExitCode as number | undefined;
  });
});

// ---------------------------------------------------------------------------
// runRender — render API failure
// ---------------------------------------------------------------------------

describe('runRender — render API failure', () => {
  it('sets exitCode=1 and writes error when renderReport returns err', async () => {
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    mkdirSync(join(tmpBase, '.ico'), { recursive: true });
    writeFileSync(join(tmpBase, '.ico', 'state.db'), '');
    const topicsDir = join(tmpBase, 'wiki', 'topics');
    mkdirSync(topicsDir, { recursive: true });
    writeFileSync(join(topicsDir, 'transformer-architecture.md'), TOPIC_PAGE, 'utf-8');

    vi.mocked(resolveWorkspace).mockReturnValue({
      ok: true,
      value: { root: tmpBase, dbPath: join(tmpBase, '.ico', 'state.db') },
    });

    vi.mocked(compilerModule.renderReport).mockResolvedValue({
      ok: false,
      error: new Error('API rate limit exceeded'),
    });

    const stderrMessages: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrMessages.push(String(msg));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runRender('report', { topic: 'transformer architecture' }, {});

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();

    expect(process.exitCode).toBe(1);
    expect(stderrMessages.join('')).toContain('Render failed');
    expect(stderrMessages.join('')).toContain('API rate limit exceeded');

    process.exitCode = originalExitCode as number | undefined;
  });
});
