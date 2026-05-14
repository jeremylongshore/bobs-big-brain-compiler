/**
 * Per-concept retention scoring (E9-B10).
 *
 * Aggregates `recall_results` rows into retention scores so the operator
 * can see what they've actually internalized vs what needs more review.
 * Pure-kernel — no Claude calls, no filesystem writes, no traces. Just
 * reads `recall_results` and returns numbers.
 *
 * Retention is the simple ratio `correct / total` per concept. We do NOT
 * decay by time-since-last-test in B10 — that is a richer spaced-
 * repetition model and belongs in a later iteration. The trace contract
 * already established by B09's `recall.result.retention_score` is the
 * same formula, so B09 and B10 agree without a migration.
 *
 * All functions return `Result<T, Error>` — never throw.
 *
 * @module retention
 */

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Retention summary for a single concept. */
export interface ConceptRetention {
  concept: string;
  /** Total questions seen for this concept. */
  total: number;
  /** Questions answered correctly. */
  correct: number;
  /** correct / total in the range `[0, 1]`. Defined when `total > 0`. */
  retention: number;
  /** Most recent ISO timestamp this concept was tested at. */
  lastTestedAt: string;
}

/** Options for {@link getWeakAreas}. */
export interface WeakAreasOptions {
  /**
   * Maximum number of weak concepts to return. Defaults to 10.
   * The list is sorted ascending by retention so weakest concepts come first.
   */
  limit?: number;
  /**
   * Minimum sample size — concepts with fewer rows than this are excluded.
   * Prevents a single wrong answer from making a one-shot concept appear
   * worse than concepts with real data. Defaults to 1.
   */
  minSampleSize?: number;
  /**
   * Maximum retention to include. Concepts with retention strictly above
   * this threshold are dropped. Defaults to 1.0 (include everything).
   */
  maxRetention?: number;
}

/** Aggregate report across the entire workspace. */
export interface RetentionReport {
  /** Total `recall_results` rows considered. */
  totalAnswers: number;
  /** Total correct answers (correct=1). */
  totalCorrect: number;
  /** Overall ratio `correct / total`. Zero when `totalAnswers === 0`. */
  overall: number;
  /** Number of distinct concepts seen. */
  conceptCount: number;
  /** Concepts sorted ascending by retention (weakest first). */
  weakest: ConceptRetention[];
  /** Concepts sorted descending by retention (strongest first). */
  strongest: ConceptRetention[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface AggregateRow {
  concept: string;
  total: number;
  correct: number;
  last_tested_at: string;
}

function aggregateAll(db: Database): Result<ConceptRetention[], Error> {
  try {
    const rows = db
      .prepare<[], AggregateRow>(
        `SELECT
           concept,
           COUNT(*) AS total,
           SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct,
           MAX(tested_at) AS last_tested_at
         FROM recall_results
         GROUP BY concept`,
      )
      .all();

    const out: ConceptRetention[] = rows.map((r) => ({
      concept: r.concept,
      total: r.total,
      correct: r.correct,
      retention: r.total === 0 ? 0 : r.correct / r.total,
      lastTestedAt: r.last_tested_at,
    }));
    return ok(out);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the retention score for a single concept.
 *
 * Reads every `recall_results` row for the concept and returns
 * `correct / total`. Returns `null` when the concept has no rows so
 * callers can distinguish "never tested" from "always wrong".
 */
export function getRetentionByConcept(
  db: Database,
  concept: string,
): Result<ConceptRetention | null, Error> {
  try {
    const row = db
      .prepare<[string], { total: number; correct: number; last_tested_at: string | null }>(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct,
           MAX(tested_at) AS last_tested_at
         FROM recall_results
         WHERE concept = ?`,
      )
      .get(concept);

    if (row === undefined || row.total === 0 || row.last_tested_at === null) {
      return ok(null);
    }
    return ok({
      concept,
      total: row.total,
      correct: row.correct,
      retention: row.correct / row.total,
      lastTestedAt: row.last_tested_at,
    });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * List the lowest-retention concepts.
 *
 * Sorted ascending by retention; ties broken by larger sample size first
 * (more evidence = more confidence) and then by alphabetical concept
 * name for determinism.
 */
export function getWeakAreas(
  db: Database,
  options: WeakAreasOptions = {},
): Result<ConceptRetention[], Error> {
  const limit = options.limit ?? 10;
  const minSampleSize = options.minSampleSize ?? 1;
  const maxRetention = options.maxRetention ?? 1;

  const all = aggregateAll(db);
  if (!all.ok) return err(all.error);

  const filtered = all.value.filter(
    (c) => c.total >= minSampleSize && c.retention <= maxRetention,
  );
  filtered.sort((a, b) => {
    if (a.retention !== b.retention) return a.retention - b.retention;
    if (a.total !== b.total) return b.total - a.total;
    return a.concept.localeCompare(b.concept);
  });
  return ok(filtered.slice(0, limit));
}

/**
 * Produce the full retention report covering every concept seen.
 */
export function getRetentionReport(
  db: Database,
  options: { topN?: number; minSampleSize?: number } = {},
): Result<RetentionReport, Error> {
  const topN = options.topN ?? 5;
  const minSampleSize = options.minSampleSize ?? 1;

  const all = aggregateAll(db);
  if (!all.ok) return err(all.error);
  const concepts = all.value;

  const totalAnswers = concepts.reduce((acc, c) => acc + c.total, 0);
  const totalCorrect = concepts.reduce((acc, c) => acc + c.correct, 0);
  const overall = totalAnswers === 0 ? 0 : totalCorrect / totalAnswers;

  const qualifying = concepts.filter((c) => c.total >= minSampleSize);

  const weakest = [...qualifying]
    .sort((a, b) => {
      if (a.retention !== b.retention) return a.retention - b.retention;
      if (a.total !== b.total) return b.total - a.total;
      return a.concept.localeCompare(b.concept);
    })
    .slice(0, topN);

  const strongest = [...qualifying]
    .sort((a, b) => {
      if (a.retention !== b.retention) return b.retention - a.retention;
      if (a.total !== b.total) return b.total - a.total;
      return a.concept.localeCompare(b.concept);
    })
    .slice(0, topN);

  return ok({
    totalAnswers,
    totalCorrect,
    overall,
    conceptCount: concepts.length,
    weakest,
    strongest,
  });
}
