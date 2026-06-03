/**
 * Retrieval eval handler (E10-B01, extended for B03).
 *
 * Scores FTS5 search against an expected-page list with both
 * **recall@k** and **precision@k**:
 *
 *   - `recall@k`    = (expected pages found in top-k) / (expected pages total)
 *   - `precision@k` = (expected pages found in top-k) / k
 *
 * The aggregate `score` reported back to the runner is the average of
 * the two (F-style mean without harmonic complexity — recall ÷ 2 +
 * precision ÷ 2). Pass when the aggregate ≥ threshold (default 1.0).
 *
 * The spec can override the per-metric thresholds via `min_recall` and
 * `min_precision` (both default 0) to enforce a floor on either metric
 * independently of the aggregate.
 */

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

import { searchPages } from '../../search.js';
import type { EvalResult, RetrievalEvalSpec } from '../types.js';

const DEFAULT_K = 5;

/**
 * Stop words to drop when turning a question into an FTS5 query. Mirrors
 * the kernel `search.ts` set but kept local since this handler builds
 * an OR-style query (recall-friendly) while `findRelevantPages` uses
 * AND (precision-friendly).
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'when',
  'where',
  'why',
  'how',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'and',
  'or',
  'but',
  'not',
  'with',
  'from',
  'by',
  'as',
  'if',
  'so',
  'me',
  'my',
  'you',
  'your',
  'we',
  'our',
  'they',
  'their',
  'i',
  'define',
  'explain',
  'describe',
  'tell',
  'please',
  'give',
  'show',
  'also',
  'about',
]);

export function buildOrQuery(question: string): string | null {
  const cleaned = question.replace(/[-"*()^?!]/g, ' ').toLowerCase();
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return tokens.length > 0 ? tokens.join(' OR ') : null;
}

export function runRetrievalEval(db: Database, spec: RetrievalEvalSpec): Result<EvalResult, Error> {
  const start = Date.now();
  const k = spec.k ?? DEFAULT_K;
  const threshold = spec.threshold ?? 1;

  // Recall-friendly OR query: any matching token surfaces the page.
  // Precision is measured by `expected_pages` being a subset of top-k.
  const ftsQuery = buildOrQuery(spec.question);
  if (ftsQuery === null) {
    return ok({
      spec,
      passed: false,
      score: 0,
      threshold,
      details: `question '${spec.question}' has no searchable terms after stop-word filter`,
      durationMs: Date.now() - start,
    });
  }
  const hits = searchPages(db, ftsQuery, k);
  if (!hits.ok) return err(hits.error);

  const topPaths = new Set(hits.value.map((r) => r.path));
  const found: string[] = [];
  const missing: string[] = [];
  for (const exp of spec.expected_pages) {
    if (topPaths.has(exp)) {
      found.push(exp);
    } else {
      missing.push(exp);
    }
  }

  const recall = spec.expected_pages.length === 0 ? 0 : found.length / spec.expected_pages.length;
  // precision@k counts how many of the top-k results were "relevant"
  // (in expected_pages). If fewer than k results came back, divide by
  // actual hits count instead — penalising sparse retrieval would
  // double-punish underpopulated wiki cases.
  const denominator = Math.min(k, hits.value.length);
  const precision = denominator === 0 ? 0 : found.length / denominator;
  const score = (recall + precision) / 2;

  const minRecall = spec.min_recall ?? 0;
  const minPrecision = spec.min_precision ?? 0;
  const passed = score >= threshold && recall >= minRecall && precision >= minPrecision;

  const metrics = `recall@${k}=${recall.toFixed(2)} precision@${k}=${precision.toFixed(2)} score=${score.toFixed(2)}`;
  const details = passed
    ? `${metrics} (≥ ${threshold})`
    : `${metrics} (< ${threshold})${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}${recall < minRecall ? `; recall floor ${minRecall} violated` : ''}${precision < minPrecision ? `; precision floor ${minPrecision} violated` : ''}`;

  return ok({
    spec,
    passed,
    score,
    threshold,
    details,
    durationMs: Date.now() - start,
  });
}
