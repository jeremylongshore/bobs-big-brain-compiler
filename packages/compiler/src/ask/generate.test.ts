/**
 * Tests for the answer generation module (E7-B03).
 *
 * All tests use a mocked ClaudeClient — no network calls are made.
 */

import { describe, expect, it } from 'vitest';

import { err, ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import { generateAnswer } from './generate.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a ClaudeClient mock that returns the given response text.
 */
function mockClient(response: string): ClaudeClient {
  return {
    createCompletion() {
      return Promise.resolve(
        ok({
          content: response,
          inputTokens: 500,
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
function failingClient(message: string): ClaudeClient {
  return {
    createCompletion() {
      return Promise.resolve(err(new Error(message)));
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGES = [
  {
    path: 'concepts/self-attention.md',
    title: 'Self-Attention Mechanism',
    content: '## Summary\n\nSelf-attention allows each token to attend to all other tokens.',
  },
  {
    path: 'topics/transformers.md',
    title: 'Transformer Architecture',
    content:
      '## Overview\n\nTransformers use self-attention layers stacked with feed-forward layers.',
  },
];

// ---------------------------------------------------------------------------
// Tests: successful generation
// ---------------------------------------------------------------------------

describe('generateAnswer — successful generation', () => {
  it('returns the answer text from the API response', async () => {
    const response =
      'Self-attention is a mechanism. [source: Self-Attention Mechanism] It is core to Transformers. [source: Transformer Architecture]';

    const result = await generateAnswer(mockClient(response), 'What is self-attention?', PAGES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.answer).toBe(response);
  });

  it('returns token counts from the API response', async () => {
    const result = await generateAnswer(mockClient('Some answer.'), 'Question?', PAGES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inputTokens).toBe(500);
    expect(result.value.outputTokens).toBe(200);
  });

  it('returns an empty citations array when no [source:] markers are present', async () => {
    const result = await generateAnswer(
      mockClient('The answer contains no citations.'),
      'Question?',
      PAGES,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: citation parsing
// ---------------------------------------------------------------------------

describe('generateAnswer — citation parsing', () => {
  it('parses a single citation from the response', async () => {
    const response = 'Self-attention enables token interaction. [source: Self-Attention Mechanism]';

    const result = await generateAnswer(mockClient(response), 'What is self-attention?', PAGES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations).toHaveLength(1);
    expect(result.value.citations[0]?.pageTitle).toBe('Self-Attention Mechanism');
  });

  it('resolves the page path for a known citation title', async () => {
    const response = 'Transformers are powerful. [source: Transformer Architecture]';

    const result = await generateAnswer(mockClient(response), 'Tell me about Transformers', PAGES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations[0]?.pagePath).toBe('topics/transformers.md');
  });

  it('leaves pagePath empty for an unknown citation title (hallucination)', async () => {
    const response = 'Some claim. [source: Nonexistent Page]';

    const result = await generateAnswer(mockClient(response), 'Some question', PAGES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations[0]?.pagePath).toBe('');
  });

  it('parses multiple distinct citations on separate lines', async () => {
    const response = [
      'Self-attention is a mechanism. [source: Self-Attention Mechanism]',
      'Transformers stack these layers. [source: Transformer Architecture]',
    ].join('\n');

    const result = await generateAnswer(mockClient(response), 'Question?', PAGES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations).toHaveLength(2);

    const titles = result.value.citations.map((c) => c.pageTitle);
    expect(titles).toContain('Self-Attention Mechanism');
    expect(titles).toContain('Transformer Architecture');
  });

  it('deduplicates citations of the same page on the same line', async () => {
    const response =
      'Both concepts relate. [source: Self-Attention Mechanism] [source: Self-Attention Mechanism]';

    const result = await generateAnswer(mockClient(response), 'Question?', PAGES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should be deduplicated to one entry.
    const selfAttnCitations = result.value.citations.filter(
      (c) => c.pageTitle === 'Self-Attention Mechanism',
    );
    expect(selfAttnCitations).toHaveLength(1);
  });

  it('is case-insensitive when resolving citation titles to paths', async () => {
    const response = 'The mechanism is described. [source: self-attention mechanism]';

    const result = await generateAnswer(mockClient(response), 'Question?', PAGES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations[0]?.pagePath).toBe('concepts/self-attention.md');
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe('generateAnswer — error handling', () => {
  it('returns err when the API call fails', async () => {
    const result = await generateAnswer(
      failingClient('Rate limit exceeded'),
      'What is self-attention?',
      PAGES,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Rate limit exceeded');
  });

  it('returns ok with empty citations when pages array is empty', async () => {
    const result = await generateAnswer(mockClient('Answer with no context.'), 'Question?', []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.citations).toHaveLength(0);
  });
});
