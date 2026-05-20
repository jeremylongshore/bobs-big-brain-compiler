/**
 * Tests for the question analysis module (E7-B02).
 *
 * Uses a real in-memory SQLite database with the FTS5 table created and
 * populated with fixture pages. No network calls are made.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '@ico/kernel';
import { closeDatabase, createSearchIndex, indexCompiledPages, initDatabase } from '@ico/kernel';

import { analyzeQuestion } from './analyze.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONCEPT_PAGE = `---
type: concept
id: 11111111-2222-3333-4444-555555555555
title: Self-Attention Mechanism
compiled_at: 2026-04-01T00:00:00.000Z
---

## Summary

Self-attention allows each token to attend to all other tokens in the sequence.
It is the core building block of the Transformer architecture.
The mechanism works by computing scaled dot-product scores between queries and keys.
Self-attention explains how each position can gather information from all other positions.
Researchers analyze self-attention patterns to understand model behavior.
`;

const TOPIC_PAGE = `---
type: topic
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
title: Transformer Architecture
compiled_at: 2026-04-01T00:00:00.000Z
---

## Overview

The Transformer architecture uses self-attention and feed-forward layers.
BERT and GPT are both Transformer-based models with different training objectives.
Researchers compare BERT and GPT because they differ in their pretraining approach.
The architecture scales well to large datasets and long sequences.
Analyzing Transformer architectures reveals differences between encoder and decoder designs.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let wsPath: string;
let db: Database;

function setup(): void {
  wsPath = mkdtempSync(join(tmpdir(), 'ico-analyze-test-'));

  // Create wiki directories and write fixture pages.
  mkdirSync(join(wsPath, 'wiki', 'concepts'), { recursive: true });
  mkdirSync(join(wsPath, 'wiki', 'topics'), { recursive: true });

  writeFileSync(join(wsPath, 'wiki', 'concepts', 'self-attention.md'), CONCEPT_PAGE, 'utf-8');
  writeFileSync(join(wsPath, 'wiki', 'topics', 'transformer.md'), TOPIC_PAGE, 'utf-8');

  const dbResult = initDatabase(':memory:');
  if (!dbResult.ok) throw new Error(dbResult.error.message);
  db = dbResult.value;

  const idxResult = createSearchIndex(db);
  if (!idxResult.ok) throw new Error(idxResult.error.message);

  const popResult = indexCompiledPages(db, wsPath);
  if (!popResult.ok) throw new Error(popResult.error.message);
}

function teardown(): void {
  closeDatabase(db);
  rmSync(wsPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests: question type classification
// ---------------------------------------------------------------------------

describe('analyzeQuestion — question type classification', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('classifies "what is" questions as factual', () => {
    const result = analyzeQuestion(db, wsPath, 'What is self-attention?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('factual');
  });

  it('classifies "define" questions as factual', () => {
    const result = analyzeQuestion(db, wsPath, 'Define self-attention mechanism');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('factual');
  });

  it('classifies "compare" questions as comparative', () => {
    const result = analyzeQuestion(db, wsPath, 'Compare BERT and GPT architectures');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('comparative');
  });

  it('classifies "vs" questions as comparative', () => {
    const result = analyzeQuestion(db, wsPath, 'BERT vs GPT — what are the differences?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('comparative');
  });

  it('classifies "why" questions as analytical', () => {
    const result = analyzeQuestion(db, wsPath, 'Why does self-attention work?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('analytical');
  });

  it('classifies "how does" questions as analytical', () => {
    const result = analyzeQuestion(db, wsPath, 'How does the Transformer architecture scale?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('analytical');
  });

  it('classifies unrecognised questions as open-ended', () => {
    const result = analyzeQuestion(db, wsPath, 'Tell me about knowledge graphs');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('open-ended');
  });
});

// ---------------------------------------------------------------------------
// Tests: relevant page retrieval
// ---------------------------------------------------------------------------

describe('analyzeQuestion — relevant page retrieval', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns relevant pages for a known topic', () => {
    const result = analyzeQuestion(db, wsPath, 'What is self-attention?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relevantPages.length).toBeGreaterThan(0);
    const titles = result.value.relevantPages.map((p) => p.title);
    expect(titles).toContain('Self-Attention Mechanism');
  });

  it('returns an empty array when no pages match', () => {
    const result = analyzeQuestion(db, wsPath, 'quantum chromodynamics lattice gauge');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relevantPages).toHaveLength(0);
  });

  it('preserves the original question unchanged', () => {
    const q = 'What is self-attention?';
    const result = analyzeQuestion(db, wsPath, q);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.originalQuestion).toBe(q);
  });
});

// ---------------------------------------------------------------------------
// Tests: complexity / suggestResearch flag
// ---------------------------------------------------------------------------

describe('analyzeQuestion — suggestResearch flag', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('sets suggestResearch when "and also" is present', () => {
    // Use tokens that appear in the fixture pages so the FTS query succeeds.
    const result = analyzeQuestion(
      db,
      wsPath,
      'Explain self-attention mechanism and also compare BERT architectures',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestResearch).toBe(true);
  });

  it('sets suggestResearch when "additionally" is present', () => {
    const result = analyzeQuestion(
      db,
      wsPath,
      'Analyze Transformer architecture. Additionally, compare BERT and GPT.',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestResearch).toBe(true);
  });

  it('does not set suggestResearch for simple questions', () => {
    const result = analyzeQuestion(db, wsPath, 'What is self-attention?');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestResearch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe('analyzeQuestion — error handling', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns err when the question is empty after sanitization', () => {
    // A string of only FTS5 special characters sanitizes to empty.
    const result = analyzeQuestion(db, wsPath, '"""***');
    expect(result.ok).toBe(false);
  });
});
