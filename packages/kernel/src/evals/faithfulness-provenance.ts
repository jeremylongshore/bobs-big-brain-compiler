/**
 * Provenance-sampling primitive for the compile-faithfulness eval (e06.8).
 *
 * PURE-KERNEL, DETERMINISTIC. This module answers the deterministic half of
 * the faithfulness question — "which compiled pages have traceable provenance,
 * what are their raw sources, and which fixed-size sample do we score this
 * run?" — WITHOUT touching a model. The probabilistic half (does the raw text
 * SUPPORT the page's claims?) lives in the compiler-side judge. Keeping the
 * split here is the 003-AT-ARCH boundary in miniature: the kernel owns the
 * provenance graph + the deterministic sample selection; the compiler owns the
 * LLM call.
 *
 * A compiled page traces to its raw source(s) through the SAME provenance the
 * schema already records (010-AT-DBSC §3.3/§3.8):
 *   - single-source pages: `compilations.source_id` → `sources.path`
 *   - cross-source pages (topics, contradictions, open-questions):
 *     `compilation_sources` junction → many `sources.path`
 * Both resolve to raw files under `raw/` — the corpus source of truth.
 *
 * The sample is a FIXED COUNT (N pages, never a percentage), selected
 * deterministically so a run is reproducible: by default newest-compiled
 * first (`compiled_at DESC, id ASC`); with a `seed`, a stable seeded shuffle
 * over that same base ordering. No randomness that isn't reproducible.
 *
 * @module evals/faithfulness-provenance
 */

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One raw source a compiled page derives from. */
export interface FaithfulnessSource {
  /** `sources.id`. */
  id: string;
  /** Relative path within `raw/` (the corpus source of truth). */
  path: string;
  /** `sources.title`, when recorded. */
  title: string | null;
}

/** A single compiled page selected for faithfulness scoring, with its sources. */
export interface FaithfulnessSampleItem {
  /** `compilations.id`. */
  compilationId: string;
  /** Wiki-relative output path of the compiled page (e.g. `wiki/sources/foo.md`). */
  outputPath: string;
  /** Compilation pass type (`summary`, `topic`, …). */
  type: string;
  /** ISO 8601 compile timestamp. */
  compiledAt: string;
  /** Every raw source this page traces to, via source_id or the junction. */
  sources: FaithfulnessSource[];
}

/** Options for {@link sampleCompilationsForFaithfulness}. */
export interface FaithfulnessSampleOptions {
  /** FIXED number of pages to select (N pages, NOT a percentage). */
  sampleSize: number;
  /** Restrict eligible pages to those under these wiki subdirs (e.g. `sources`). */
  wikiSubdirs?: string[];
  /** Reproducible seed for a stable shuffle. Omit for newest-first ordering. */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface CompilationRow {
  id: string;
  source_id: string | null;
  type: string;
  output_path: string;
  compiled_at: string;
}

interface SourceJoinRow {
  id: string;
  path: string;
  title: string | null;
}

// ---------------------------------------------------------------------------
// Deterministic shuffle
// ---------------------------------------------------------------------------

/**
 * A small, dependency-free deterministic PRNG (mulberry32). Given the same
 * seed it yields the same sequence — so a seeded sample is reproducible across
 * runs and machines. Used only for sample SELECTION, never for scoring.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic in-place Fisher–Yates shuffle driven by a seeded PRNG.
 * Returns a NEW array; the input is not mutated.
 */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trace one compiled page (by `compilations.id`) to all of its raw sources.
 *
 * Resolution:
 *   1. If the compilation row has a non-NULL `source_id`, that single source
 *      is the provenance.
 *   2. Otherwise (cross-source page), read the `compilation_sources` junction.
 *
 * Returns `ok([])` only when a page genuinely has no recorded provenance — the
 * caller treats that as "not traceable" and excludes it from the sample rather
 * than scoring it against nothing.
 *
 * @param db            - Open better-sqlite3 database.
 * @param compilationId - The `compilations.id` to resolve.
 */
export function getCompilationSources(
  db: Database,
  compilationId: string,
): Result<FaithfulnessSource[], Error> {
  try {
    const comp = db
      .prepare<
        [string],
        { source_id: string | null }
      >(`SELECT source_id FROM compilations WHERE id = ?`)
      .get(compilationId);
    if (comp === undefined) {
      return err(new Error(`No compilation row for id '${compilationId}'`));
    }

    if (comp.source_id !== null) {
      const row = db
        .prepare<[string], SourceJoinRow>(`SELECT id, path, title FROM sources WHERE id = ?`)
        .get(comp.source_id);
      // A source_id pointing at a missing source is a provenance break — surface
      // it as empty (untraceable) rather than throwing.
      if (row === undefined) return ok([]);
      return ok([{ id: row.id, path: row.path, title: row.title }]);
    }

    const rows = db
      .prepare<[string], SourceJoinRow>(
        `SELECT s.id AS id, s.path AS path, s.title AS title
           FROM compilation_sources cs
           JOIN sources s ON s.id = cs.source_id
          WHERE cs.compilation_id = ?
          ORDER BY s.path ASC`,
      )
      .all(compilationId);
    return ok(rows.map((r) => ({ id: r.id, path: r.path, title: r.title })));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Select a FIXED-SIZE, deterministic sample of compiled pages that have
 * traceable provenance, each resolved to its raw source(s).
 *
 * Only pages that resolve to at least one raw source are eligible — a page
 * with no provenance cannot be scored for groundedness, so it is excluded (not
 * counted against the sample budget).
 *
 * The returned list length is `min(sampleSize, eligiblePages)`; `sampleSize`
 * is an integer count, enforced by the loader to never be a percentage.
 *
 * @param db      - Open better-sqlite3 database.
 * @param options - Fixed sample size, optional subdir filter, optional seed.
 */
export function sampleCompilationsForFaithfulness(
  db: Database,
  options: FaithfulnessSampleOptions,
): Result<FaithfulnessSampleItem[], Error> {
  const { sampleSize, wikiSubdirs, seed } = options;
  if (!Number.isInteger(sampleSize) || sampleSize < 1) {
    return err(new Error(`sampleSize must be a positive integer, got ${String(sampleSize)}`));
  }

  let candidates: CompilationRow[];
  try {
    // Base ordering is deterministic: newest compile first, id as tiebreak.
    candidates = db
      .prepare<[], CompilationRow>(
        `SELECT id, source_id, type, output_path, compiled_at
           FROM compilations
          WHERE stale = 0
          ORDER BY compiled_at DESC, id ASC`,
      )
      .all();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Optional wiki-subdir filter. Paths are `wiki/<subdir>/<slug>.md`; match on
  // the second path segment so `sources` filters `wiki/sources/*`.
  const subdirFilter =
    wikiSubdirs && wikiSubdirs.length > 0 ? new Set(wikiSubdirs.map((s) => s.trim())) : null;
  const filtered = subdirFilter
    ? candidates.filter((c) => {
        const parts = c.output_path.split('/');
        // Expect wiki/<subdir>/...; guard shorter paths.
        const subdir = parts.length >= 2 ? parts[1] : undefined;
        return subdir !== undefined && subdirFilter.has(subdir);
      })
    : candidates;

  // Resolve provenance and keep only traceable pages.
  const eligible: FaithfulnessSampleItem[] = [];
  for (const c of filtered) {
    const sourcesResult = getCompilationSources(db, c.id);
    if (!sourcesResult.ok) return err(sourcesResult.error);
    const sources = sourcesResult.value;
    if (sources.length === 0) continue; // untraceable — cannot score groundedness
    eligible.push({
      compilationId: c.id,
      outputPath: c.output_path,
      type: c.type,
      compiledAt: c.compiled_at,
      sources,
    });
  }

  // Deterministic selection. With a seed, a stable seeded shuffle over the
  // already-deterministic base ordering; without one, newest-first as ordered.
  const ordered = seed === undefined ? eligible : seededShuffle(eligible, seed);
  return ok(ordered.slice(0, sampleSize));
}
