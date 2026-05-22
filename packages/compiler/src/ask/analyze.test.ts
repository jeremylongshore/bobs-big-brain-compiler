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

// Fixture for the fmo bead (dashed-identifier / paraphrase-variance bug
// surfaced by the v0.1 dog-food run against intent-eval-core). The bank
// asked 5 sophisticated questions and all hit the no-knowledge fallback
// even though the corpus contained the answers. The tests below pin the
// retrieval contract: a single page mentioning a dashed identifier and
// its core concepts must be findable via any reasonable phrasing.
const INTENT_EVAL_CORE_PAGE = `---
type: source
id: cccccccc-dddd-eeee-ffff-000000000000
title: intent-eval-core — contracts kernel
compiled_at: 2026-04-01T00:00:00.000Z
---

## Summary

\`intent-eval-core\` is the canonical contracts kernel for the Intent Eval Platform.
It defines TypeScript types, JSON Schemas, and Zod validators for 13 canonical
platform entities. The kernel has zero runtime execution — no judges, no
orchestration, no queues, no provider adapters. The role separation is binding.

## License

Published under Apache 2.0 so every downstream consumer (commercial, OSS,
internal) can depend on it without friction.

## Boundaries

The kernel is a leaf node in the dependency graph. Consumers depend on it;
it depends on nothing in the platform. Breaking changes require a MAJOR
version bump and a Class-2 pair Decision Record.
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
  mkdirSync(join(wsPath, 'wiki', 'sources'), { recursive: true });
  writeFileSync(
    join(wsPath, 'wiki', 'sources', 'intent-eval-core.md'),
    INTENT_EVAL_CORE_PAGE,
    'utf-8',
  );

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

// ---------------------------------------------------------------------------
// Tests: paraphrase variance / dashed identifiers / compound questions
//
// These are the fmo bead regression tests. The v0.1 dog-food run against
// intent-eval-core surfaced that sophisticated multi-clause questions
// returned ZERO relevant pages even when the compiled corpus contained
// the answers. Root cause: buildFtsQuery joined tokens with implicit AND,
// so any question whose residual tokens didn't ALL appear in a single page
// returned empty. These tests pin the broader contract:
//
//   - Paraphrases of the same intent retrieve overlapping page sets
//   - Dashed identifiers (intent-eval-core) match pages mentioning them
//   - Compound questions with multiple clauses don't bail to empty
//   - Possessives ("X's role") don't degrade into wrong-stem matches
//
// Test setup uses the INTENT_EVAL_CORE_PAGE fixture above.
// ---------------------------------------------------------------------------

describe('analyzeQuestion — fmo regression (paraphrase variance + dashed identifiers)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('retrieves the intent-eval-core page for paraphrases of the same intent', () => {
    // Five phrasings of "what does intent-eval-core do?" — every one should
    // retrieve at least one page, and the intent-eval-core page should be
    // findable in at least 4 of 5 (allowing one off-target retrieval for
    // FTS5 ranking noise).
    const paraphrases = [
      'What is intent-eval-core?',
      "What is intent-eval-core's role?",
      'Describe the purpose of intent-eval-core',
      'Explain what intent-eval-core does',
      'What does intent-eval-core do exactly?',
    ];

    const hits = paraphrases.map((q) => {
      const r = analyzeQuestion(db, wsPath, q);
      if (!r.ok) return false;
      return r.value.relevantPages.some((p) => p.path.toLowerCase().includes('intent-eval-core'));
    });

    const successCount = hits.filter(Boolean).length;
    expect(successCount).toBeGreaterThanOrEqual(4);
  });

  it('does not bail to empty on compound multi-clause questions', () => {
    // Q01 verbatim from the v0.1 bank — exactly the question that failed
    // in the first real dog-food run.
    const compound =
      "What is intent-eval-core's role inside the Intent Eval Platform, and what does it explicitly not do?";
    const result = analyzeQuestion(db, wsPath, compound);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relevantPages.length).toBeGreaterThan(0);
  });

  it('matches dashed identifiers ("intent-eval-core") in FTS5 query', () => {
    // The bare slug query — the operator literal-pastes the project name.
    const result = analyzeQuestion(db, wsPath, 'intent-eval-core');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relevantPages.length).toBeGreaterThan(0);
    expect(
      result.value.relevantPages.some((p) => p.path.toLowerCase().includes('intent-eval-core')),
    ).toBe(true);
  });

  it('handles possessive forms without degrading to wrong stems', () => {
    // Bug subtlety: "core's" was being stripped to "cores" (plural form)
    // because [^\w] removed the apostrophe but left no normalization.
    const result = analyzeQuestion(db, wsPath, "intent-eval-core's license");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relevantPages.length).toBeGreaterThan(0);
    expect(
      result.value.relevantPages.some((p) => p.path.toLowerCase().includes('intent-eval-core')),
    ).toBe(true);
  });

  it('normalizes smart-quote possessives (U+2019) the same as ASCII apostrophe', () => {
    // Gemini PR #81 review: the prior regex looked like it covered smart
    // quotes but actually had two ASCII apostrophes. Real prose almost
    // always uses U+2019 (’), so this matters in practice.
    const smartQuote = 'intent-eval-core’s license';
    const result = analyzeQuestion(db, wsPath, smartQuote);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relevantPages.length).toBeGreaterThan(0);
    expect(
      result.value.relevantPages.some((p) => p.path.toLowerCase().includes('intent-eval-core')),
    ).toBe(true);
  });

  it('does not merge tokens across punctuation (foo,bar → foo + bar, not foobar)', () => {
    // Gemini PR #81 review: splitting on whitespace before stripping
    // punctuation merged `foo,bar` into `foobar`. Now we replace
    // punctuation with whitespace FIRST, then split.
    const punctuated = 'intent-eval-core,Apache,license';
    const result = analyzeQuestion(db, wsPath, punctuated);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.relevantPages.length).toBeGreaterThan(0);
    // The intent-eval-core page is the most relevant hit.
    expect(
      result.value.relevantPages.some((p) => p.path.toLowerCase().includes('intent-eval-core')),
    ).toBe(true);
  });

  it('retrieves at least one page for the full v0.1 bank Q01-Q05 set', () => {
    // The v0.1 dog-food bank's exact 5 questions. Each must retrieve > 0
    // pages — the integration confirmation that the fmo fix resolves the
    // dog-food signal that produced this bead.
    const bankQuestions = [
      "What is intent-eval-core's role inside the Intent Eval Platform, and what does it explicitly not do?",
      'How many canonical platform entities does intent-eval-core define?',
      'Which document carries the NORMATIVE gate-result/v1 predicate contract, and which section is it in?',
      'What license is intent-eval-core published under, and why was that choice made?',
      "What is the source-of-truth hierarchy intent-eval-core's CLAUDE.md prescribes when sources disagree, listed from highest to lowest authority?",
    ];

    const engagedCount = bankQuestions
      .map((q) => analyzeQuestion(db, wsPath, q))
      .filter((r) => r.ok && r.value.relevantPages.length > 0).length;

    // All 5 questions should engage. The fixture page mentions "intent-eval-core",
    // "13", "kernel", "Apache", "license", "downstream" — keywords present
    // across the bank. Strict 5/5 because any single failure means the
    // dog-food retrieval gap hasn't actually closed.
    expect(engagedCount).toBe(5);
  });
});
