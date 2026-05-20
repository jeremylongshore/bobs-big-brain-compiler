/**
 * Tests for the citation verification module (E7-B04).
 *
 * Uses a real temporary workspace on disk. No network calls are made.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Citation } from './generate.js';
import { verifyCitations } from './verify.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONCEPT_PAGE_CONTENT = `---
type: concept
id: 11111111-2222-3333-4444-555555555555
title: Self-Attention Mechanism
source_path: raw/papers/attention-paper.pdf
compiled_at: 2026-04-01T00:00:00.000Z
---

## Summary

Self-attention allows each token to attend to all other tokens.
`;

const TOPIC_PAGE_CONTENT = `---
type: topic
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
title: Transformer Architecture
source_path: raw/papers/transformer-paper.pdf
compiled_at: 2026-04-01T00:00:00.000Z
---

## Overview

Transformers use stacked self-attention layers.
`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let wsPath: string;

function setup(): void {
  wsPath = mkdtempSync(join(tmpdir(), 'ico-verify-test-'));
  mkdirSync(join(wsPath, 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(wsPath, 'wiki', 'topics'), { recursive: true });

  writeFileSync(
    join(wsPath, 'wiki', 'concepts', 'self-attention.md'),
    CONCEPT_PAGE_CONTENT,
    'utf-8',
  );
  writeFileSync(join(wsPath, 'wiki', 'topics', 'transformer.md'), TOPIC_PAGE_CONTENT, 'utf-8');
}

function teardown(): void {
  rmSync(wsPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCitation(overrides: Partial<Citation>): Citation {
  return {
    pageTitle: 'Self-Attention Mechanism',
    pagePath: 'concepts/self-attention.md',
    claim: 'Self-attention allows token interaction.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: citation verification
// ---------------------------------------------------------------------------

describe('verifyCitations — citation verification', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('marks citations whose page file exists as verified', () => {
    const citations: Citation[] = [makeCitation({})];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verified).toHaveLength(1);
    expect(result.value.unverified).toHaveLength(0);
  });

  it('marks citations with an empty pagePath as unverified', () => {
    const citations: Citation[] = [makeCitation({ pagePath: '' })];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unverified).toHaveLength(1);
    expect(result.value.verified).toHaveLength(0);
  });

  it('marks citations pointing to a non-existent file as unverified', () => {
    const citations: Citation[] = [makeCitation({ pagePath: 'concepts/does-not-exist.md' })];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unverified).toHaveLength(1);
    expect(result.value.verified).toHaveLength(0);
  });

  it('handles a mix of verified and unverified citations', () => {
    const citations: Citation[] = [
      makeCitation({}),
      makeCitation({
        pageTitle: 'Hallucinated Page',
        pagePath: 'concepts/hallucination.md',
        claim: 'Some invented claim.',
      }),
    ];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verified).toHaveLength(1);
    expect(result.value.unverified).toHaveLength(1);
  });

  it('returns ok with empty arrays when no citations are provided', () => {
    const result = verifyCitations(wsPath, []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verified).toHaveLength(0);
    expect(result.value.unverified).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: provenance chain
// ---------------------------------------------------------------------------

describe('verifyCitations — provenance chain', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('always starts the provenance chain with the "answer" level', () => {
    const citations: Citation[] = [makeCitation({})];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provenanceChain[0]?.level).toBe('answer');
  });

  it('includes the compiled-page entry for a verified citation', () => {
    const citations: Citation[] = [makeCitation({})];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const levels = result.value.provenanceChain.map((e) => e.level);
    expect(levels).toContain('compiled-page');
  });

  it('includes the raw-source entry when frontmatter contains source_path', () => {
    const citations: Citation[] = [makeCitation({})];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const levels = result.value.provenanceChain.map((e) => e.level);
    expect(levels).toContain('raw-source');
  });

  it('includes the raw-source path value from the frontmatter', () => {
    const citations: Citation[] = [makeCitation({})];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rawSource = result.value.provenanceChain.find((e) => e.level === 'raw-source');
    expect(rawSource?.path).toBe('raw/papers/attention-paper.pdf');
  });

  it('does not duplicate compiled-page entries for the same page cited twice', () => {
    const citations: Citation[] = [
      makeCitation({ claim: 'First claim about self-attention.' }),
      makeCitation({ claim: 'Second claim about self-attention.' }),
    ];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compiledPageEntries = result.value.provenanceChain.filter(
      (e) => e.level === 'compiled-page',
    );
    expect(compiledPageEntries).toHaveLength(1);
  });

  it('includes multiple compiled-page entries for different cited pages', () => {
    const citations: Citation[] = [
      makeCitation({}),
      makeCitation({
        pageTitle: 'Transformer Architecture',
        pagePath: 'topics/transformer.md',
        claim: 'Transformers use self-attention.',
      }),
    ];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compiledPageEntries = result.value.provenanceChain.filter(
      (e) => e.level === 'compiled-page',
    );
    expect(compiledPageEntries).toHaveLength(2);
  });

  it('produces a chain of only the answer level when all citations are unverified', () => {
    const citations: Citation[] = [makeCitation({ pagePath: '' })];
    const result = verifyCitations(wsPath, citations);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provenanceChain).toHaveLength(1);
    expect(result.value.provenanceChain[0]?.level).toBe('answer');
  });
});
