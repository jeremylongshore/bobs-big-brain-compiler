/**
 * Staleness detection for compiled pages.
 *
 * Provides three functions:
 *   - `detectStalePages`    — find compilations that need to be rerun
 *   - `markStale`           — explicitly flag compilations as stale
 *   - `getUncompiledSources` — find sources with no compilation record at all
 *
 * All functions return `Result<T, Error>` — never throw. The caller is
 * responsible for inspecting `.ok` before using `.value`.
 */

import type { Database } from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Describes a compiled page that is out-of-date and requires recompilation. */
export interface StalePageInfo {
  /** UUID of the compilation record. */
  compilationId: string;
  /** UUID of the source this compilation was derived from, or `null` for
   *  dependency-only compilations (e.g. topic pages). */
  sourceId: string | null;
  /** Compilation type: `'summary'`, `'concept'`, `'topic'`, etc. */
  type: string;
  /** Relative path to the compiled output file. */
  outputPath: string;
  /** ISO timestamp when the compilation was last run. */
  compiledAt: string;
  /** Why this compilation is considered stale. */
  reason: 'source-changed' | 'dependency-recompiled' | 'new-source';
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface StaleRow {
  id: string;
  source_id: string | null;
  type: string;
  output_path: string;
  compiled_at: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect stale compiled pages that need recompilation.
 *
 * Two staleness signals are checked and merged (deduplication by
 * `compilationId`):
 *
 * 1. **source-changed** — the source was re-ingested after the compilation was
 *    run (`sources.ingested_at > compilations.compiled_at`).
 *
 * 2. **already-stale** — the `stale` flag is already `1` in the database
 *    (set by a prior `markStale` call or dependency cascade).
 *
 * @param db - Open better-sqlite3 database instance.
 * @returns `ok(pages)` — may be empty when everything is current.
 *          `err(error)` on any query failure.
 */
export function detectStalePages(db: Database): Result<StalePageInfo[], Error> {
  // ---- Signal 1: source-changed -------------------------------------------
  let sourceChangedRows: StaleRow[];
  try {
    sourceChangedRows = db
      .prepare<[], StaleRow>(
        `SELECT c.id, c.source_id, c.type, c.output_path, c.compiled_at
         FROM compilations c
         JOIN sources s ON c.source_id = s.id
         WHERE s.ingested_at > c.compiled_at`,
      )
      .all();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // ---- Signal 2: already marked stale -------------------------------------
  let alreadyStaleRows: StaleRow[];
  try {
    alreadyStaleRows = db
      .prepare<[], StaleRow>(
        `SELECT id, source_id, type, output_path, compiled_at
         FROM compilations
         WHERE stale = 1`,
      )
      .all();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Merge, deduplicating by compilationId. source-changed takes priority over
  // the generic already-stale reason so the caller gets the most informative
  // reason when both signals fire for the same row.
  const seen = new Map<string, StalePageInfo>();

  for (const row of alreadyStaleRows) {
    seen.set(row.id, {
      compilationId: row.id,
      sourceId: row.source_id,
      type: row.type,
      outputPath: row.output_path,
      compiledAt: row.compiled_at,
      reason: 'dependency-recompiled',
    });
  }

  for (const row of sourceChangedRows) {
    // Overwrite any already-stale entry with the more specific reason.
    seen.set(row.id, {
      compilationId: row.id,
      sourceId: row.source_id,
      type: row.type,
      outputPath: row.output_path,
      compiledAt: row.compiled_at,
      reason: 'source-changed',
    });
  }

  return ok(Array.from(seen.values()));
}

/**
 * Mark specific compilations as stale in the database.
 *
 * Sets `stale = 1` for each ID in `compilationIds`. IDs that do not exist are
 * silently skipped — the returned count reflects only rows actually updated.
 *
 * @param db             - Open better-sqlite3 database instance.
 * @param compilationIds - UUIDs of the compilations to mark as stale.
 * @returns `ok(count)` — number of rows updated; `err(error)` on failure.
 */
export function markStale(db: Database, compilationIds: string[]): Result<number, Error> {
  if (compilationIds.length === 0) {
    return ok(0);
  }

  let stmt: ReturnType<Database['prepare']>;
  try {
    stmt = db.prepare<[string], void>('UPDATE compilations SET stale = 1 WHERE id = ?');
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  let updated = 0;
  try {
    const runAll = db.transaction(() => {
      for (const id of compilationIds) {
        const info = stmt.run(id);
        updated += info.changes;
      }
    });
    runAll();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  return ok(updated);
}

/**
 * Get all uncompiled sources — sources that have no `summary` compilation
 * record yet.
 *
 * These are not technically "stale" (they were never compiled), but they
 * represent work that needs to be done before any downstream compilation
 * (topics, concepts) can proceed.
 *
 * @param db - Open better-sqlite3 database instance.
 * @returns `ok(sources)` — may be empty when all sources have been compiled.
 *          `err(error)` on any query failure.
 */
export function getUncompiledSources(
  db: Database,
): Result<Array<{ id: string; path: string; type: string }>, Error> {
  interface SourceRow {
    id: string;
    path: string;
    type: string;
  }

  let rows: SourceRow[];
  try {
    rows = db
      .prepare<[], SourceRow>(
        `SELECT s.id, s.path, s.type
         FROM sources s
         LEFT JOIN compilations c ON c.source_id = s.id AND c.type = 'summary'
         WHERE c.id IS NULL`,
      )
      .all();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  return ok(rows);
}
