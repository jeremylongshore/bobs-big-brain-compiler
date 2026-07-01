/**
 * Incremental compile — "regenerate only affected" page selection (bead
 * `compile-then-govern-e06.5`; risk 010-AT-RISK R12; umbrella #27).
 *
 * Given a set of changed raw files (by path + content hash vs the `sources`
 * table), this module computes the CONSERVATIVE set of compiled pages that a
 * fresh compile must regenerate, instead of recompiling the whole corpus. It is
 * the correctness core of governed freshness-on-push.
 *
 * ## Why the diff — not the id — is the correctness risk
 *
 * The spool candidate id is `uuidV5(namespace, workspaceId\x00relPath\x00
 * bodySha256)` (packages/kernel/src/uuid.ts). It is derived from the on-disk
 * page bytes, so regenerating an *unchanged* page reproduces a byte-identical
 * id automatically — there is no id-divergence risk to guard here. The real
 * hazard (master-blueprint §6.3 staleness, R12) is the diff wrongly marking a
 * page UNAFFECTED when a source it depends on changed: that page then never
 * recompiles and the brain silently goes stale.
 *
 * ## The rule: fail toward freshness, never toward staleness
 *
 * Every ambiguity resolves to "recompile". Concretely:
 *
 *   1. A changed source's OWN single-source pages (`compilations.source_id`
 *      match) are always affected.
 *   2. Cross-source pages (topics / contradictions / open-questions, where
 *      `compilations.source_id IS NULL`) that CITE the changed source via the
 *      `compilation_sources` junction are affected.
 *   3. Because the junction is not yet populated by the passes in production
 *      (010-AT-DBSC §3.8 defines it; no writer fills it today), a changed source
 *      whose cross-source citations are UNKNOWN must conservatively mark ALL
 *      cross-source pages affected — we cannot prove a synthesis page did not
 *      draw on the changed source, so we recompile it. This is the load-bearing
 *      "when unsure, re-compile" guarantee.
 *   4. A changed path with no `sources` record at all is a NEW source: its
 *      summary does not exist yet, and any cross-source synthesis may need to
 *      incorporate it — so new sources also trigger the conservative
 *      cross-source sweep.
 *
 * The output is a plan the caller feeds to the SAME pass pipeline + spool +
 * govern handoff — deltas enter at candidates, run the full pipeline, and get a
 * govern receipt per page. There is NO fast-path that skips govern.
 *
 * PURE-KERNEL-STYLE, DETERMINISTIC, NO MODEL. Never throws — all error paths
 * return `err(Error)`.
 *
 * @module incremental
 */

import type { Database } from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Compilation types that are single-source (one `source_id`). */
const SINGLE_SOURCE_TYPES = ['summary', 'concept', 'entity'] as const;

/** Compilation types that synthesise across many sources (`source_id IS NULL`). */
const CROSS_SOURCE_TYPES = ['topic', 'contradiction', 'open-question'] as const;

/** A raw file reported as changed by the trigger (path + its new content hash). */
export interface ChangedFile {
  /** Workspace-relative raw path (e.g. `raw/notes/foo.md`). */
  path: string;
  /** SHA-256 hex digest of the file's CURRENT content. */
  hash: string;
}

/** Why a compiled page was selected for recompilation. */
export type AffectedReason =
  /** A source this page derives from changed content (hash differs). */
  | 'source-changed'
  /** A brand-new source path appeared (no prior `sources` record). */
  | 'new-source'
  /** Cross-source page swept in conservatively — citations unknown, cannot
   *  prove it is unaffected, so we recompile (fail toward freshness). */
  | 'cross-source-conservative'
  /** Cross-source page proven affected via the `compilation_sources` junction. */
  | 'cited-source-changed';

/** One compiled page the incremental compile must regenerate. */
export interface AffectedPage {
  /** `compilations.id` of the page to recompile. */
  compilationId: string;
  /** Wiki-relative output path (e.g. `wiki/sources/foo.md`). */
  outputPath: string;
  /** Compilation pass type. */
  type: string;
  /** Reason it was selected — drives audit/log messaging. */
  reason: AffectedReason;
}

/** The full plan produced by {@link computeAffectedSet}. */
export interface AffectedSet {
  /** Sources whose content actually changed (hash differs from the DB). */
  changedSourcePaths: string[];
  /** Paths reported changed that have no `sources` record yet (new content). */
  newSourcePaths: string[];
  /** Paths reported changed whose hash already matches the DB (no-op — skipped). */
  unchangedSourcePaths: string[];
  /** The compiled pages to regenerate, deduplicated by `compilationId`. */
  affectedPages: AffectedPage[];
  /**
   * True when a conservative cross-source sweep was applied because at least
   * one changed/new source had no proven junction coverage. Surfaced so the
   * caller (and tests) can assert the fail-toward-freshness path fired.
   */
  conservativeSweep: boolean;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface SourceRow {
  id: string;
  path: string;
  hash: string;
}

interface CompilationRow {
  id: string;
  output_path: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the conservative set of compiled pages to regenerate for a set of
 * changed raw files.
 *
 * Determinism: the same `(db state, changedFiles)` always yields the same plan.
 * Ordering of `affectedPages` is stable (`type ASC, output_path ASC`).
 *
 * @param db           - Open better-sqlite3 database (migrations applied).
 * @param changedFiles - Raw files the trigger flagged as changed (path + hash).
 * @returns `ok(AffectedSet)` or `err(Error)` on any query failure.
 */
export function computeAffectedSet(
  db: Database,
  changedFiles: ChangedFile[],
): Result<AffectedSet, Error> {
  const changedSourcePaths: string[] = [];
  const newSourcePaths: string[] = [];
  const unchangedSourcePaths: string[] = [];

  // Deduplicate affected pages by compilation id; keep the MOST SPECIFIC reason
  // (proven citation > conservative sweep; source-changed > new-source) so the
  // audit message is informative when a page qualifies via multiple paths.
  const byId = new Map<string, AffectedPage>();
  const reasonRank: Record<AffectedReason, number> = {
    'source-changed': 3,
    'cited-source-changed': 3,
    'new-source': 2,
    'cross-source-conservative': 1,
  };
  const upsert = (page: AffectedPage): void => {
    const existing = byId.get(page.compilationId);
    if (existing === undefined || reasonRank[page.reason] > reasonRank[existing.reason]) {
      byId.set(page.compilationId, page);
    }
  };

  // The changed/new source ids that require a cross-source recompile. Populated
  // as we classify each changed file below.
  const impactedSourceIds: string[] = [];
  // Does any impacted source lack proven junction coverage? If so we must sweep
  // ALL cross-source pages (fail toward freshness).
  let needConservativeSweep = false;

  try {
    const findSource = db.prepare<[string], SourceRow>(
      // Most-recent record for this path (a re-ingest inserts a new row with the
      // new hash; §3.1 keeps the (path, hash) pair unique, so ORDER BY the
      // ingest time picks the current one).
      `SELECT id, path, hash FROM sources WHERE path = ? ORDER BY ingested_at DESC LIMIT 1`,
    );
    const findSingleSourcePages = db.prepare<[string], CompilationRow>(
      `SELECT id, output_path, type FROM compilations WHERE source_id = ?`,
    );
    const findCitingPages = db.prepare<[string], CompilationRow>(
      `SELECT c.id AS id, c.output_path AS output_path, c.type AS type
         FROM compilation_sources cs
         JOIN compilations c ON c.id = cs.compilation_id
        WHERE cs.source_id = ?`,
    );
    const countJunctionCoverage = db.prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM compilation_sources WHERE source_id = ?`,
    );

    // ---- 1. Classify each changed file -----------------------------------
    for (const cf of changedFiles) {
      const src = findSource.get(cf.path);

      if (src === undefined) {
        // No record → brand-new source. It has no pages of its own yet, but a
        // cross-source synthesis may need to incorporate it.
        newSourcePaths.push(cf.path);
        needConservativeSweep = true;
        continue;
      }

      if (src.hash === cf.hash) {
        // Reported changed but hash matches the DB — content is identical, so
        // nothing derived from it can be stale. Skip (this is the ONLY case
        // where we mark unaffected, and it is provably safe: same bytes).
        unchangedSourcePaths.push(cf.path);
        continue;
      }

      // Content genuinely changed.
      changedSourcePaths.push(cf.path);
      impactedSourceIds.push(src.id);

      // 1a. Direct single-source pages — always affected.
      for (const page of findSingleSourcePages.all(src.id)) {
        upsert({
          compilationId: page.id,
          outputPath: page.output_path,
          type: page.type,
          reason: 'source-changed',
        });
      }

      // 1b. Cross-source pages proven to cite this source via the junction.
      for (const page of findCitingPages.all(src.id)) {
        upsert({
          compilationId: page.id,
          outputPath: page.output_path,
          type: page.type,
          reason: 'cited-source-changed',
        });
      }

      // 1c. If the junction has NO coverage for this changed source, we cannot
      //     prove which cross-source pages drew on it → conservative sweep.
      const coverage = countJunctionCoverage.get(src.id);
      if (coverage === undefined || coverage.n === 0) {
        needConservativeSweep = true;
      }
    }

    // ---- 2. Conservative cross-source sweep ------------------------------
    // When any impacted source lacks proven junction citations, recompile
    // EVERY cross-source page rather than risk leaving one stale. This is the
    // §6.3 "when unsure, re-compile" guarantee and the reason a page is NEVER
    // wrongly marked unaffected.
    if (needConservativeSweep) {
      const placeholders = CROSS_SOURCE_TYPES.map(() => '?').join(', ');
      const crossPages = db
        .prepare<
          string[],
          CompilationRow
        >(`SELECT id, output_path, type FROM compilations WHERE source_id IS NULL AND type IN (${placeholders})`)
        .all(...CROSS_SOURCE_TYPES);
      for (const page of crossPages) {
        upsert({
          compilationId: page.id,
          outputPath: page.output_path,
          type: page.type,
          reason: 'cross-source-conservative',
        });
      }
    }
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const affectedPages = Array.from(byId.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.outputPath < b.outputPath ? -1 : a.outputPath > b.outputPath ? 1 : 0;
  });

  return ok({
    changedSourcePaths,
    newSourcePaths,
    unchangedSourcePaths,
    affectedPages,
    conservativeSweep: needConservativeSweep,
  });
}

/** Exposed for tests/consumers that need the canonical type partitions. */
export const INCREMENTAL_TYPE_SETS = {
  singleSource: SINGLE_SOURCE_TYPES,
  crossSource: CROSS_SOURCE_TYPES,
} as const;
