/**
 * Tests for the Marp slide deck renderer (E8-B02).
 *
 * All tests use a mocked ClaudeClient — no network calls are made.
 * A temporary directory is created per test suite and cleaned up afterwards.
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { err, ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import {
  renderSlides,
  type RenderSlidesOptions,
  type SlideSource,
  slugifyTitle,
} from './slides.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

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

/** A minimal but structurally valid Marp slide body (no frontmatter). */
const SAMPLE_SLIDE_BODY = `# Transformers Overview

A foundational architecture for sequence modelling.

<!-- Speaker notes: introduce the topic -->

---

## Self-Attention

- Allows each token to attend to all others
- Scaled dot-product attention
- Multi-head variant increases capacity

<!-- Speaker notes: explain the mechanism -->

---

## Feed-Forward Layers

- Applied position-wise after attention
- Two linear projections with a ReLU
- Shared weights across positions [source: Transformer Architecture]

---

## Summary

- Transformers use self-attention and feed-forward layers
- Multi-head attention captures diverse relationships
- Position-wise FFN provides non-linearity`;

const SOURCES: SlideSource[] = [
  {
    title: 'Transformer Architecture',
    content:
      '## Overview\n\nTransformers use self-attention layers stacked with feed-forward layers.',
    path: 'wiki/topics/transformers.md',
  },
  {
    title: 'Self-Attention Mechanism',
    content: '## Summary\n\nSelf-attention allows each token to attend to all other tokens.',
    path: 'wiki/concepts/self-attention.md',
  },
];

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let workspacePath: string;

beforeEach(() => {
  workspacePath = join(
    tmpdir(),
    `ico-slides-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspacePath, { recursive: true });
});

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: successful rendering
// ---------------------------------------------------------------------------

describe('renderSlides — successful rendering', () => {
  it('returns ok with a RenderSlidesResult on success', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
  });

  it('output markdown contains marp: true in frontmatter', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = matter(result.value.markdown);
    expect(parsed.data['marp']).toBe(true);
  });

  it('frontmatter includes paginate: true', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = matter(result.value.markdown);
    expect(parsed.data['paginate']).toBe(true);
  });

  it('frontmatter includes type: slides', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = matter(result.value.markdown);
    expect(parsed.data['type']).toBe('slides');
  });

  it('output markdown body contains --- slide separators', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The content after the frontmatter should contain --- separators.
    const parsed = matter(result.value.markdown);
    expect(parsed.content).toContain('---');
  });

  it('output has a title slide (# heading)', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.markdown).toMatch(/^#\s+/m);
  });

  it('output has content slides (## headings)', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.markdown).toMatch(/^##\s+/m);
  });

  it('output has a summary slide', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.markdown).toMatch(/^##\s+Summary/im);
  });

  it('returns the correct slide count', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // SAMPLE_SLIDE_BODY has 3 `---` separators → 4 slides.
    expect(result.value.slideCount).toBe(4);
  });

  it('returns input and output token counts', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.inputTokens).toBe(100);
    expect(result.value.outputTokens).toBe(200);
  });

  it('returns the model used', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.model).toBe('claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// Tests: output path
// ---------------------------------------------------------------------------

describe('renderSlides — output path', () => {
  it('saves the file to outputs/slides/<slug>.md by default', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // First source title is "Transformer Architecture" → slug "transformer-architecture"
    expect(result.value.outputPath).toMatch(
      /^outputs[\\/]slides[\\/]transformer-architecture\.md$/,
    );
  });

  it('actually writes the file to disk', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const diskContent = readFileSync(join(workspacePath, result.value.outputPath), 'utf-8');
    expect(diskContent).toBe(result.value.markdown);
  });

  it('uses a custom output path when provided', async () => {
    const customPath = 'outputs/custom/my-deck.md';
    const options: RenderSlidesOptions = {
      client: createMockClient(SAMPLE_SLIDE_BODY),
      outputPath: customPath,
    };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outputPath).toBe(customPath);
    const diskContent = readFileSync(join(workspacePath, customPath), 'utf-8');
    expect(diskContent).toBe(result.value.markdown);
  });
});

// ---------------------------------------------------------------------------
// Tests: title option
// ---------------------------------------------------------------------------

describe('renderSlides — title option', () => {
  it('uses the first source title when no explicit title is given', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.title).toBe('Transformer Architecture');
  });

  it('uses the explicit title override when provided', async () => {
    const options: RenderSlidesOptions = {
      client: createMockClient(SAMPLE_SLIDE_BODY),
      title: 'My Custom Deck',
    };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.title).toBe('My Custom Deck');
  });

  it('includes the title in the frontmatter', async () => {
    const options: RenderSlidesOptions = {
      client: createMockClient(SAMPLE_SLIDE_BODY),
      title: 'Deep Learning Fundamentals',
    };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = matter(result.value.markdown);
    expect(parsed.data['title']).toBe('Deep Learning Fundamentals');
  });

  it('slugifies custom title for default output path', async () => {
    const options: RenderSlidesOptions = {
      client: createMockClient(SAMPLE_SLIDE_BODY),
      title: 'My Custom Deck',
    };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outputPath).toMatch(/my-custom-deck\.md$/);
  });
});

// ---------------------------------------------------------------------------
// Tests: theme option
// ---------------------------------------------------------------------------

describe('renderSlides — theme option', () => {
  it('uses "default" theme when not specified', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = matter(result.value.markdown);
    expect(parsed.data['theme']).toBe('default');
  });

  it('applies custom theme when provided', async () => {
    const options: RenderSlidesOptions = {
      client: createMockClient(SAMPLE_SLIDE_BODY),
      theme: 'gaia',
    };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = matter(result.value.markdown);
    expect(parsed.data['theme']).toBe('gaia');
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe('renderSlides — error handling', () => {
  it('returns err when sources is empty', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, [], options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('sources array must not be empty');
  });

  it('propagates API errors as err', async () => {
    const options: RenderSlidesOptions = {
      client: createFailingClient('Rate limit exceeded'),
    };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Rate limit exceeded');
  });
});

// ---------------------------------------------------------------------------
// Tests: slugifyTitle
// ---------------------------------------------------------------------------

describe('slugifyTitle', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugifyTitle('Transformer Architecture')).toBe('transformer-architecture');
  });

  it('strips non-alphanumeric characters', () => {
    expect(slugifyTitle('Hello, World! (2024)')).toBe('hello-world-2024');
  });

  it('collapses multiple hyphens', () => {
    expect(slugifyTitle('foo  ---  bar')).toBe('foo-bar');
  });

  it('removes leading and trailing hyphens', () => {
    expect(slugifyTitle('  --hello--  ')).toBe('hello');
  });

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugifyTitle(long).length).toBeLessThanOrEqual(80);
  });

  it('falls back to "slides" for empty input', () => {
    expect(slugifyTitle('')).toBe('slides');
  });

  it('falls back to "slides" for all-symbol input', () => {
    expect(slugifyTitle('!!!')).toBe('slides');
  });

  it('handles underscores as word separators', () => {
    expect(slugifyTitle('my_slide_deck')).toBe('my-slide-deck');
  });
});

// ---------------------------------------------------------------------------
// Tests: frontmatter metadata
// ---------------------------------------------------------------------------

describe('renderSlides — frontmatter metadata', () => {
  it('includes generated_at timestamp in frontmatter', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = matter(result.value.markdown);
    expect(typeof parsed.data['generated_at']).toBe('string');
    // Should be a parseable ISO date string
    expect(() => new Date(parsed.data['generated_at'] as string).toISOString()).not.toThrow();
  });

  it('includes source paths in generated_from', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.markdown).toContain('wiki/topics/transformers.md');
    expect(result.value.markdown).toContain('wiki/concepts/self-attention.md');
  });

  it('includes tokens_used in frontmatter', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = matter(result.value.markdown);
    expect(parsed.data['tokens_used']).toBe(300); // 100 input + 200 output
  });

  it('includes model in frontmatter', async () => {
    const options: RenderSlidesOptions = { client: createMockClient(SAMPLE_SLIDE_BODY) };
    const result = await renderSlides(workspacePath, SOURCES, options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = matter(result.value.markdown);
    expect(parsed.data['model']).toBe('claude-sonnet-4-6');
  });
});
