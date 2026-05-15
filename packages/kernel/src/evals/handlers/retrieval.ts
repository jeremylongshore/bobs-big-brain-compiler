/**
 * Retrieval eval handler (E10-B01).
 *
 * Scores FTS5 search recall against an expected-page list. Given:
 *   - `question` — natural-language query
 *   - `expected_pages` — wiki-relative paths that the question should surface
 *   - `k` — top-k considered (default 5)
 *
 * Score = (expected pages found in top-k) / (expected pages total).
 * Pass when score ≥ threshold (default 1.0 — every expected page must hit).
 *
 * Future work (B03 — citation eval): extend with precision@k and answer
 * grounding. B01 keeps it to plain recall so the framework can land
 * before the heavier metrics arrive.
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
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'that', 'this', 'these', 'those', 'it', 'its', 'in', 'on', 'at', 'to',
  'for', 'of', 'and', 'or', 'but', 'not', 'with', 'from', 'by', 'as', 'if',
  'so', 'me', 'my', 'you', 'your', 'we', 'our', 'they', 'their', 'i',
  'define', 'explain', 'describe', 'tell', 'please', 'give', 'show',
  'also', 'about',
]);

function buildOrQuery(question: string): string | null {
  const cleaned = question.replace(/[-"*()^?!]/g, ' ').toLowerCase();
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return tokens.length > 0 ? tokens.join(' OR ') : null;
}

export function runRetrievalEval(
  db: Database,
  spec: RetrievalEvalSpec,
): Result<EvalResult, Error> {
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

  const score = spec.expected_pages.length === 0 ? 0 : found.length / spec.expected_pages.length;
  const passed = score >= threshold;

  const details = passed
    ? `recall@${k} = ${found.length}/${spec.expected_pages.length} = ${score.toFixed(2)} (≥ ${threshold})`
    : `recall@${k} = ${found.length}/${spec.expected_pages.length} = ${score.toFixed(2)} (< ${threshold})${
        missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''
      }`;

  return ok({
    spec,
    passed,
    score,
    threshold,
    details,
    durationMs: Date.now() - start,
  });
}
