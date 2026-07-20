/**
 * Deterministic source attribution for the cross-source compiler passes
 * (extract / synthesize / contradict / gap).
 *
 * Before this module the cross-source passes recorded provenance with the
 * literal sourceId `'batch'` (1,781 such records on the live brain) and never
 * populated the `compilation_sources` junction — despite two readers
 * (`incremental.ts` staleness diff + `evals/faithfulness-provenance.ts`)
 * depending on it (bead intentional-cognition-os-l13.5).
 *
 * Trust model: the model's frontmatter `source_ids` are ADVISORY — the model
 * proposes, the deterministic system decides. Attribution accepts only the
 * intersection of the advisory ids with the set of source ids that were
 * DETERMINISTICALLY in the pass's input (resolved from the `compilations`
 * table, never from model output). An empty intersection records NOTHING —
 * `incremental.ts` already treats a cross-source page with no junction rows
 * conservatively (full sweep), so an honest empty set fails toward freshness
 * rather than inventing lineage.
 *
 * ── Provenance CARDINALITY CHANGE (l13.5) — read before touching readers ──
 * Before l13.5 a cross-source pass wrote exactly ONE provenance record per
 * output page, with the literal `sourceId: 'batch'`, and `compilation_sources`
 * stayed empty. Now a cross-source page writes ONE provenance record PER
 * attributed real source id (0..N) AND N `compilation_sources` junction rows.
 * So per output_path the provenance sidecar can hold MANY records, not ≤1.
 * All current readers already tolerate this — `getProvenance`/`getDerivations`
 * return arrays, and `incremental.ts` + `evals/faithfulness-provenance.ts`
 * read the junction as a one-to-many JOIN/COUNT. Any NEW reader that assumes
 * "one provenance row per page" is wrong against post-l13.5 data.
 *
 * No SQL migration is needed (the `compilation_sources` table has existed
 * since migration 001; this is a data-population change, not a schema change).
 * There is NO backfill for pages compiled before l13.5 — their junction stays
 * empty and their provenance keeps the legacy single `'batch'` record. That is
 * intentional and self-healing: a page is re-attributed on its next compile
 * (`recordCompilationSources` DELETEs then re-inserts for the compilation id),
 * and until then `incremental.ts`'s empty-junction conservative sweep keeps
 * the staleness diff correct. A one-shot backfill is unnecessary; if one is
 * ever wanted it is a plain re-compile of the affected pages.
 *
 * @module passes/source-attribution
 */

import type { Database } from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

/** How an output page's source set was decided. */
export type AttributionMode = 'advisory-validated' | 'unattributed';

/** The deterministic attribution decision for one output page. */
export interface SourceAttribution {
  /** Source ids accepted into `compilation_sources` (possibly empty). */
  attributed: string[];
  mode: AttributionMode;
  /** Advisory ids the model emitted that were NOT in the deterministic input set. */
  advisoryDropped: number;
}

/**
 * Resolve the deterministic set of raw-source ids behind a set of summary
 * pages. Reads the `compilations` table (type = 'summary'), never model
 * output: summarize inserts `(source_id, output_path)` deterministically from
 * its caller arguments, so this is the ground-truth wiki-page → raw-source
 * mapping.
 *
 * @param db           - Open better-sqlite3 database.
 * @param summaryPaths - Optional workspace-relative summary paths to restrict
 *                       to (the pass's actual inputs). Omitted = all summaries.
 */
export function resolveSummarySourceIds(
  db: Database,
  summaryPaths?: readonly string[],
): Result<Set<string>, Error> {
  try {
    let rows: Array<{ source_id: string | null }>;
    if (summaryPaths !== undefined && summaryPaths.length > 0) {
      const placeholders = summaryPaths.map(() => '?').join(', ');
      rows = db
        .prepare<string[], { source_id: string | null }>(
          `SELECT source_id FROM compilations
           WHERE type = 'summary' AND output_path IN (${placeholders})`,
        )
        .all(...summaryPaths);
    } else {
      rows = db
        .prepare<
          [],
          { source_id: string | null }
        >(`SELECT source_id FROM compilations WHERE type = 'summary'`)
        .all();
    }
    const set = new Set<string>();
    for (const row of rows) {
      if (row.source_id !== null && row.source_id !== '') set.add(row.source_id);
    }
    return ok(set);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Decide the accepted source set for one output page: the intersection of the
 * model-emitted advisory ids with the deterministic input set. Pure function.
 */
export function attributeSources(
  advisoryIds: readonly string[],
  knownSourceIds: ReadonlySet<string>,
): SourceAttribution {
  const attributed: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const id of advisoryIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (knownSourceIds.has(id)) attributed.push(id);
    else dropped++;
  }
  return {
    attributed,
    mode: attributed.length > 0 ? 'advisory-validated' : 'unattributed',
    advisoryDropped: dropped,
  };
}

/**
 * Persist the attributed source set for a compilation into the
 * `compilation_sources` junction. Replaces any prior rows for the
 * compilation id (re-runs re-attribute; the junction reflects the LATEST
 * compile). `INSERT OR IGNORE` guards the composite primary key.
 *
 * @returns the number of junction rows now recorded for the compilation.
 */
export function recordCompilationSources(
  db: Database,
  compilationId: string,
  sourceIds: readonly string[],
): Result<number, Error> {
  try {
    const apply = db.transaction(() => {
      db.prepare<[string], void>(`DELETE FROM compilation_sources WHERE compilation_id = ?`).run(
        compilationId,
      );
      const insert = db.prepare<[string, string], void>(
        `INSERT OR IGNORE INTO compilation_sources (compilation_id, source_id) VALUES (?, ?)`,
      );
      for (const sourceId of sourceIds) {
        insert.run(compilationId, sourceId);
      }
    });
    apply();
    return ok(sourceIds.length);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
