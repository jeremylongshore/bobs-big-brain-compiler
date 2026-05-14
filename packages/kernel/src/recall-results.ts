/**
 * Recall result persistence (L5 — Recall) for the ICO kernel.
 *
 * Owns the `recall_results` SQLite table defined in migration 001 and
 * specified in 010-AT-DBSC §3.6. Each row records the outcome of a
 * single quiz question (correct / incorrect, concept, optional
 * confidence, optional source-card path).
 *
 * Quiz state and per-session statistics live downstream (the quiz
 * runner in `@ico/compiler` aggregates results before display); the
 * kernel only stores rows and supports basic queries for B09 and the
 * future B10 retention analyzer.
 *
 * All functions return `Result<T, Error>` — never throw.
 *
 * @module recall-results
 */

import { randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single row from the `recall_results` table. */
export interface RecallResultRow {
  id: string;
  concept: string;
  topic: string | null;
  /** 0 = incorrect, 1 = correct. */
  correct: 0 | 1;
  tested_at: string;
  confidence: number | null;
  /** Workspace-relative path to the source flashcard, when known. */
  source_card: string | null;
}

/** Inputs accepted by {@link recordRecallResult}. */
export interface RecordRecallInput {
  concept: string;
  topic?: string | null;
  correct: boolean;
  /** Optional self-reported confidence in `[0.0, 1.0]`. */
  confidence?: number | null;
  /** Optional workspace-relative path to the originating card. */
  sourceCard?: string | null;
  /** ISO 8601 timestamp. Defaults to `new Date().toISOString()`. */
  testedAt?: string;
  /** Optional pre-generated row id. Defaults to a fresh UUIDv4. */
  id?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert one row into `recall_results`.
 *
 * Generates a UUID and defaults `tested_at` to now when those fields are
 * omitted. Validates `confidence` against the schema's `[0.0, 1.0]`
 * range before inserting so a Result-typed error is returned instead of
 * a noisy CHECK-constraint exception.
 */
export function recordRecallResult(
  db: Database,
  input: RecordRecallInput,
): Result<RecallResultRow, Error> {
  const concept = input.concept.trim();
  if (concept === '') {
    return err(new Error('concept is required'));
  }
  const confidence = input.confidence ?? null;
  if (confidence !== null && (confidence < 0 || confidence > 1 || Number.isNaN(confidence))) {
    return err(new Error(`confidence must be in [0.0, 1.0], received ${String(confidence)}`));
  }

  const row: RecallResultRow = {
    id: input.id ?? randomUUID(),
    concept,
    topic: input.topic ?? null,
    correct: input.correct ? 1 : 0,
    tested_at: input.testedAt ?? new Date().toISOString(),
    confidence,
    source_card: input.sourceCard ?? null,
  };

  try {
    db.prepare(
      `INSERT INTO recall_results (id, concept, topic, correct, tested_at, confidence, source_card)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.concept,
      row.topic,
      row.correct,
      row.tested_at,
      row.confidence,
      row.source_card,
    );
    return ok(row);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Fetch every result, newest first, optionally narrowed by concept or topic.
 *
 * Used by B09's per-session summary (`topic` filter) and the future B10
 * retention analyzer (`concept` filter). The full-table query is
 * intentionally LIMIT-less — recall_results is expected to stay small
 * (one row per question answered) and downstream callers may want
 * everything for analysis.
 */
export function listRecallResults(
  db: Database,
  filters: { concept?: string; topic?: string; limit?: number } = {},
): Result<RecallResultRow[], Error> {
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.concept !== undefined) {
      conditions.push('concept = ?');
      params.push(filters.concept);
    }
    if (filters.topic !== undefined) {
      conditions.push('topic = ?');
      params.push(filters.topic);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filters.limit !== undefined ? 'LIMIT ?' : '';
    if (filters.limit !== undefined) params.push(filters.limit);

    const rows = db
      .prepare<(string | number)[], RecallResultRow>(
        `SELECT id, concept, topic, correct, tested_at, confidence, source_card
         FROM recall_results
         ${where}
         ORDER BY tested_at DESC
         ${limitClause}`,
      )
      .all(...params);
    return ok(rows);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
