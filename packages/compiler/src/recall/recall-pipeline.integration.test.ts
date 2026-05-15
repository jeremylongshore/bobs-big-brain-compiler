/**
 * Integration test for the Epic 9 recall pipeline (E9-B12).
 *
 * Exercises the cross-feature path:
 *
 *   wiki/ →  generateRecall  →  recall/cards/* + recall/quizzes/*
 *                                    │
 *                                    ↓
 *                                runQuiz  →  recall_results rows + recall.* traces
 *                                                    │
 *                                                    ↓
 *                          getRetentionByConcept / getWeakAreas / getRetentionReport
 *                                                    │
 *                                                    ↓
 *                                          exportRecallAnki  →  TSV
 *
 * Each step uses real filesystem and real SQLite; only the Claude API is
 * mocked. The test is the contract that B08 → B09 → B10 → B11 actually
 * compose end-to-end on the same workspace state.
 *
 * Audit handoff (epic-09.md §B12): "Cards generated from compiled
 * knowledge. Quiz scoring updates retention. All tests pass."
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  createSearchIndex,
  type Database,
  getRetentionByConcept,
  getRetentionReport,
  getWeakAreas,
  indexCompiledPages,
  initDatabase,
  initWorkspace,
  listRecallResults,
  readTraces,
} from '@ico/kernel';
import { ok, type Result } from '@ico/types';

import type { ClaudeClient, CompletionResult } from '../api/claude-client.js';
import { exportRecallAnki } from './export.js';
import { generateRecall } from './generate.js';
import { runQuiz } from './quiz.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Env {
  base: string;
  wsRoot: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-recall-e2e-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  const dbRes = initDatabase(ws.value.dbPath);
  if (!dbRes.ok) throw dbRes.error;
  const idx = createSearchIndex(dbRes.value);
  if (!idx.ok) throw idx.error;
  env = { base, wsRoot: ws.value.root, db: dbRes.value };
});

afterEach(() => {
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
});

function seedWiki(dir: string, slug: string, title: string, body: string): void {
  const abs = resolve(env.wsRoot, 'wiki', dir, `${slug}.md`);
  mkdirSync(resolve(env.wsRoot, 'wiki', dir), { recursive: true });
  writeFileSync(
    abs,
    ['---', `title: ${title}`, 'type: concept', '---', '', body, ''].join('\n'),
    'utf-8',
  );
}

function reindex(): void {
  const r = indexCompiledPages(env.db, env.wsRoot);
  if (!r.ok) throw r.error;
}

/** Mock Claude client that pops queued responses in order. */
function queuedClient(responses: ReadonlyArray<unknown>): ClaudeClient & { spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn();
  for (const r of responses) {
    const content = typeof r === 'string' ? r : JSON.stringify(r);
    spy.mockResolvedValueOnce(
      ok<CompletionResult>({
        content,
        inputTokens: 80,
        outputTokens: 40,
        model: 'claude-sonnet-4-6',
        stopReason: 'end_turn',
      }),
    );
  }
  const tail: Result<CompletionResult, Error> = {
    ok: false,
    error: new Error('queuedClient: call past end of queue'),
  };
  spy.mockResolvedValue(tail);
  return { createCompletion: spy, spy };
}

// ---------------------------------------------------------------------------
// End-to-end test
// ---------------------------------------------------------------------------

describe('recall pipeline — end-to-end (E9-B12)', () => {
  it('generate → quiz → retention → export composes on one workspace', async () => {
    // -----------------------------------------------------------------------
    // 1. Seed compiled wiki pages the generator can search via FTS5.
    // -----------------------------------------------------------------------
    seedWiki(
      'concepts',
      'self-attention',
      'Self-Attention',
      'Self-attention computes a weighted sum over all input positions using query-key similarity.',
    );
    seedWiki(
      'topics',
      'transformer-attention',
      'Transformer Attention',
      'Transformer attention scales quadratically with sequence length in both memory and compute.',
    );
    reindex();

    // -----------------------------------------------------------------------
    // 2. generateRecall — Claude returns a deterministic cards+quiz payload.
    //    Two cards (one per concept), three quiz questions.
    // -----------------------------------------------------------------------
    const generatorResponse = {
      cards: [
        {
          concept: 'Self-Attention Mechanism',
          question: 'What does self-attention compute?',
          answer: 'A weighted sum over all input positions using query-key similarity.',
          source_pages: ['concepts/self-attention.md'],
        },
        {
          concept: 'Quadratic Scaling',
          question: 'How does attention scale with sequence length?',
          answer: 'Quadratically in both memory and compute.',
          source_pages: ['topics/transformer-attention.md'],
        },
      ],
      quiz: [
        {
          question: 'Why is naive self-attention expensive on long sequences?',
          answer: 'Quadratic memory and compute in sequence length.',
          source_pages: ['topics/transformer-attention.md'],
        },
        {
          question: 'What weights are applied to attention pairs?',
          answer: 'Softmax over query-key dot products.',
          source_pages: ['concepts/self-attention.md'],
        },
        {
          question: 'Does each attention head share weights?',
          answer: 'No — each head has independent Q, K, V projection matrices.',
          source_pages: ['concepts/self-attention.md'],
        },
      ],
    };

    const genClient = queuedClient([generatorResponse]);
    const genResult = await generateRecall(env.db, env.wsRoot, 'transformer attention', genClient);
    expect(genResult.ok).toBe(true);
    if (!genResult.ok) return;

    expect(genResult.value.cards).toHaveLength(2);
    expect(genResult.value.quiz.questionCount).toBe(3);
    // Card files exist on disk.
    const cardFiles = readdirSync(resolve(env.wsRoot, 'recall', 'cards'))
      .filter((f) => f.endsWith('.md'))
      .sort();
    expect(cardFiles).toEqual(['quadratic-scaling.md', 'self-attention-mechanism.md']);
    expect(existsSync(resolve(env.wsRoot, 'recall', 'quizzes', 'transformer-attention.md'))).toBe(true);

    // -----------------------------------------------------------------------
    // 3. runQuiz — three answers, two correct + one wrong. Mock scorer
    //    returns one JSON per call (3 calls = 3 questions).
    // -----------------------------------------------------------------------
    const quizClient = queuedClient([
      { correct: true, feedback: 'Right — quadratic.' },
      { correct: true, feedback: 'Right — softmax over QK.' },
      { correct: false, feedback: 'Wrong — heads have independent projections.' },
    ]);
    const quizResult = await runQuiz(env.db, env.wsRoot, 'transformer-attention', quizClient, {
      answers: ['quadratic mem & compute', 'softmax', 'they share weights'],
    });
    expect(quizResult.ok).toBe(true);
    if (!quizResult.ok) return;

    expect(quizResult.value.total).toBe(3);
    expect(quizResult.value.correctCount).toBe(2);
    expect(quizResult.value.weakConcepts).toHaveLength(1);

    // recall_results rows actually landed in SQLite.
    const rows = listRecallResults(env.db);
    if (!rows.ok) throw rows.error;
    expect(rows.value).toHaveLength(3);

    // recall.quiz start trace + recall.result per answer.
    const startTraces = readTraces(env.db, { eventType: 'recall.quiz' });
    if (!startTraces.ok) throw startTraces.error;
    expect(startTraces.value).toHaveLength(1);
    const resultTraces = readTraces(env.db, { eventType: 'recall.result' });
    if (!resultTraces.ok) throw resultTraces.error;
    expect(resultTraces.value).toHaveLength(3);

    // -----------------------------------------------------------------------
    // 4. getRetentionByConcept / getWeakAreas / getRetentionReport — the
    //    aggregator reads the rows the quiz wrote.
    // -----------------------------------------------------------------------
    // The wrong-answer concept (Q3 cites concepts/self-attention.md → 'self-attention').
    // Q2 also cites that page (correct), so retention for 'self-attention' = 1/2 = 0.5.
    // Q1 cites topics/transformer-attention.md (correct), so 'transformer-attention' = 1/1.
    const wrongConcept = quizResult.value.weakConcepts[0]!;
    expect(wrongConcept).toBe('self-attention');
    const wrongRetention = getRetentionByConcept(env.db, wrongConcept);
    if (!wrongRetention.ok) throw wrongRetention.error;
    expect(wrongRetention.value).not.toBeNull();
    expect(wrongRetention.value!.retention).toBe(0.5);

    const weak = getWeakAreas(env.db);
    if (!weak.ok) throw weak.error;
    expect(weak.value[0]!.concept).toBe('self-attention');
    expect(weak.value[0]!.retention).toBe(0.5);

    const report = getRetentionReport(env.db);
    if (!report.ok) throw report.error;
    expect(report.value.totalAnswers).toBe(3);
    expect(report.value.totalCorrect).toBe(2);
    expect(report.value.overall).toBeCloseTo(2 / 3, 5);
    // Weakest concept is the one with the wrong answer.
    expect(report.value.weakest[0]!.concept).toBe('self-attention');

    // -----------------------------------------------------------------------
    // 5. exportRecallAnki — pulls the cards B08 wrote and produces a valid
    //    TSV with three columns per row.
    // -----------------------------------------------------------------------
    const exportResult = exportRecallAnki(env.wsRoot);
    expect(exportResult.ok).toBe(true);
    if (!exportResult.ok) return;
    expect(exportResult.value.cards).toHaveLength(2);
    const tsvLines = exportResult.value.tsv.trimEnd().split('\n');
    expect(tsvLines).toHaveLength(2);
    for (const line of tsvLines) {
      expect(line.split('\t')).toHaveLength(3);
    }
    // Each row references a real source page in the tags column.
    expect(exportResult.value.tsv).toContain('source:concepts-self-attention');
    expect(exportResult.value.tsv).toContain('source:topics-transformer-attention');
  });

  it('staleness signal: source_pages frontmatter survives generation', async () => {
    // B08 spec requires each card record which compiled pages it was
    // generated from so a future staleness pass can invalidate cards on
    // source recompile (audit M7). This test pins the contract.
    seedWiki('concepts', 'embeddings', 'Embeddings', 'Embeddings map tokens to vectors.');
    reindex();

    const client = queuedClient([
      {
        cards: [
          {
            concept: 'Embedding Lookup',
            question: 'q',
            answer: 'a',
            source_pages: ['concepts/embeddings.md'],
          },
        ],
        quiz: [{ question: 'q', answer: 'a', source_pages: ['concepts/embeddings.md'] }],
      },
    ]);
    const r = await generateRecall(env.db, env.wsRoot, 'embeddings', client);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const cardContent = readFileSync(resolve(env.wsRoot, r.value.cards[0]!.path), 'utf-8');
    expect(cardContent).toContain('source_pages:');
    expect(cardContent).toContain('- concepts/embeddings.md');
    expect(cardContent).toContain('generated_at:');
  });

  it('multi-session retention: two quiz runs on the same topic accumulate', async () => {
    seedWiki('concepts', 'tokens', 'Tokens', 'Tokens are discrete units fed to the model.');
    reindex();

    const gen = queuedClient([
      {
        cards: [
          {
            concept: 'Token Splitting',
            question: 'q1',
            answer: 'a1',
            source_pages: ['concepts/tokens.md'],
          },
        ],
        quiz: [
          { question: 'session-q1', answer: 'a1', source_pages: ['concepts/tokens.md'] },
          { question: 'session-q2', answer: 'a2', source_pages: ['concepts/tokens.md'] },
        ],
      },
    ]);
    const gr = await generateRecall(env.db, env.wsRoot, 'tokens', gen);
    expect(gr.ok).toBe(true);

    // Session 1: both wrong.
    const session1 = queuedClient([{ correct: false }, { correct: false }]);
    const q1 = await runQuiz(env.db, env.wsRoot, 'tokens', session1, { answers: ['x', 'y'] });
    expect(q1.ok).toBe(true);

    // Session 2: both right.
    const session2 = queuedClient([{ correct: true }, { correct: true }]);
    const q2 = await runQuiz(env.db, env.wsRoot, 'tokens', session2, { answers: ['x', 'y'] });
    expect(q2.ok).toBe(true);

    const report = getRetentionReport(env.db);
    if (!report.ok) throw report.error;
    expect(report.value.totalAnswers).toBe(4);
    expect(report.value.totalCorrect).toBe(2);
    expect(report.value.overall).toBe(0.5);

    // Two recall.quiz start traces and four recall.result traces total.
    const starts = readTraces(env.db, { eventType: 'recall.quiz' });
    if (!starts.ok) throw starts.error;
    expect(starts.value).toHaveLength(2);
    const results = readTraces(env.db, { eventType: 'recall.result' });
    if (!results.ok) throw results.error;
    expect(results.value).toHaveLength(4);
  });
});
