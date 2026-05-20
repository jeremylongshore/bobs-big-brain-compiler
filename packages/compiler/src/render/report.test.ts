/**
 * Tests for the report renderer (E8-B01).
 *
 * All tests use a mocked ClaudeClient — no network calls are made.
 * Report files are written to a temporary directory that is cleaned up after each test.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { err, ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import type { RenderReportOptions, ReportSource } from './report.js';
import { renderReport, slugify } from './report.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a ClaudeClient mock that returns the given response text.
 */
function createMockClient(response: string): ClaudeClient {
  return {
    createCompletion() {
      return Promise.resolve(
        ok({
          content: response,
          inputTokens: 100,
          outputTokens: 200,
          model: 'claude-sonnet-4-6',
          stopReason: 'end_turn',
        }),
      );
    },
  };
}

/**
 * Build a ClaudeClient mock that always returns an error.
 */
function createFailingClient(message: string): ClaudeClient {
  return {
    createCompletion() {
      return Promise.resolve(err(new Error(message)));
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_REPORT_BODY = `## Executive Summary

This report synthesises the compiled knowledge on self-attention and transformer architecture. [source: Self-Attention Mechanism]

## Key Findings

- Self-attention enables each token to attend to all other tokens. [source: Self-Attention Mechanism]
- Transformers stack multiple self-attention layers with feed-forward layers. [source: Transformer Architecture]

## Evidence and Analysis

Self-attention was introduced as a core building block [source: Self-Attention Mechanism] and later scaled up in transformer models. [source: Transformer Architecture]

## Conclusion

Self-attention is foundational to modern neural language models.

## Sources

1. Self-Attention Mechanism — concepts/self-attention.md
2. Transformer Architecture — topics/transformers.md`;

const SOURCES: ReportSource[] = [
  {
    title: 'Self-Attention Mechanism',
    content: '## Summary\n\nSelf-attention allows each token to attend to all others.',
    path: 'concepts/self-attention.md',
  },
  {
    title: 'Transformer Architecture',
    content: '## Overview\n\nTransformers use stacked self-attention layers.',
    path: 'topics/transformers.md',
  },
];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let wsPath: string;

beforeEach(() => {
  wsPath = mkdtempSync(join(tmpdir(), 'ico-report-test-'));
});

afterEach(() => {
  rmSync(wsPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<RenderReportOptions> = {}): RenderReportOptions {
  return {
    client: createMockClient(MOCK_REPORT_BODY),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: successful render
// ---------------------------------------------------------------------------

describe('renderReport — successful render', () => {
  it('returns ok with the rendered markdown', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markdown).toContain('## Executive Summary');
  });

  it('report contains all required sections', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { markdown } = result.value;
    expect(markdown).toContain('## Executive Summary');
    expect(markdown).toContain('## Key Findings');
    expect(markdown).toContain('## Evidence and Analysis');
    expect(markdown).toContain('## Conclusion');
    expect(markdown).toContain('## Sources');
  });

  it('returns token counts from the API response', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inputTokens).toBe(100);
    expect(result.value.outputTokens).toBe(200);
  });

  it('returns the model identifier from the API response', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe('claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// Tests: frontmatter
// ---------------------------------------------------------------------------

describe('renderReport — frontmatter', () => {
  it('markdown begins with a YAML frontmatter block', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markdown.startsWith('---\n')).toBe(true);
  });

  it('frontmatter contains type: report', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markdown).toContain('type: report');
  });

  it('frontmatter contains the report title', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions({ title: 'My Custom Report' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markdown).toContain('title: "My Custom Report"');
  });

  it('frontmatter contains generated_at timestamp', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markdown).toMatch(/generated_at: "\d{4}-\d{2}-\d{2}T/);
  });

  it('frontmatter contains generated_from source paths', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markdown).toContain('"concepts/self-attention.md"');
    expect(result.value.markdown).toContain('"topics/transformers.md"');
  });

  it('frontmatter contains source_pages basenames', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markdown).toContain('"self-attention.md"');
    expect(result.value.markdown).toContain('"transformers.md"');
  });

  it('frontmatter contains the model identifier', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markdown).toContain('model: "claude-sonnet-4-6"');
  });

  it('frontmatter contains tokens_used (sum of input + output)', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.markdown).toContain('tokens_used: 300');
  });
});

// ---------------------------------------------------------------------------
// Tests: output path
// ---------------------------------------------------------------------------

describe('renderReport — output path', () => {
  it('saves the report to workspace/outputs/reports/<slug>.md by default', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions({ title: 'My Report' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outputPath).toContain('outputs/reports/my-report.md');
    expect(existsSync(result.value.outputPath)).toBe(true);
  });

  it('creates the outputs/reports directory if it does not exist', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions({ title: 'Dir Creation Test' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(result.value.outputPath)).toBe(true);
  });

  it('uses a custom output path when provided', async () => {
    const customPath = join(wsPath, 'custom', 'my-report.md');
    const result = await renderReport(wsPath, SOURCES, makeOptions({ outputPath: customPath }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outputPath).toBe(customPath);
    expect(existsSync(customPath)).toBe(true);
  });

  it('report content written to disk matches the returned markdown', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions({ title: 'Disk Verify Test' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const onDisk = readFileSync(result.value.outputPath, 'utf-8');
    expect(onDisk).toBe(result.value.markdown);
  });
});

// ---------------------------------------------------------------------------
// Tests: title handling
// ---------------------------------------------------------------------------

describe('renderReport — title handling', () => {
  it('uses a custom title when provided', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions({ title: 'My Custom Report' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('My Custom Report');
  });

  it('derives the title from the first source when no custom title given', async () => {
    const result = await renderReport(wsPath, SOURCES, makeOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('Report: Self-Attention Mechanism');
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe('renderReport — error handling', () => {
  it('returns err when sources array is empty', async () => {
    const result = await renderReport(wsPath, [], makeOptions());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('No sources provided');
  });

  it('propagates err when the API call fails', async () => {
    const result = await renderReport(
      wsPath,
      SOURCES,
      makeOptions({ client: createFailingClient('Rate limit exceeded') }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Rate limit exceeded');
  });
});

// ---------------------------------------------------------------------------
// Tests: slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases the input', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('replaces spaces with hyphens', () => {
    expect(slugify('one two three')).toBe('one-two-three');
  });

  it('replaces special characters with hyphens', () => {
    expect(slugify('Report: AI & ML!')).toBe('report-ai-ml');
  });

  it('collapses consecutive hyphens', () => {
    expect(slugify('one---two')).toBe('one-two');
  });

  it('strips leading hyphens', () => {
    expect(slugify('---leading')).toBe('leading');
  });

  it('strips trailing hyphens', () => {
    expect(slugify('trailing---')).toBe('trailing');
  });

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });

  it('does not end with a hyphen after truncation', () => {
    // Create a title where a hyphen would land at position 80 after slugification.
    // 76 a's + ' x y' (space → hyphen each) produces 'aaa...aaa-x-y' which is
    // 76 + 1 + 1 + 1 + 1 = 80 chars exactly; truncation should not leave a trailing hyphen.
    const title = 'a'.repeat(78) + ' z';
    const slug = slugify(title);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back to "report" for an all-special-character input', () => {
    expect(slugify('!@#$%^&*()')).toBe('report');
  });

  it('preserves hyphens that are already in the title', () => {
    expect(slugify('well-formed-title')).toBe('well-formed-title');
  });

  it('handles a single-word title', () => {
    expect(slugify('Transformers')).toBe('transformers');
  });
});
