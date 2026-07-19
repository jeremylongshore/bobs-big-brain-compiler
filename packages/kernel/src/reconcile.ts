/**
 * Workspace reconciler — enforces the receipts-precede-visibility floor
 * after the fact (G1).
 *
 * Even with the reordered write path (tmp → receipts → rename), history can
 * contain artifacts that became visible without receipts: crashes under the
 * OLD ordering, hand-copied files, or partial restores. This module walks
 * the compiled-page directories and QUARANTINES (never deletes) any visible
 * `.md` file that has no matching receipt row:
 *
 *   - `wiki/{sources,concepts,entities,topics,contradictions,open-questions}/`
 *     is checked against `compilations.output_path` ∪ `promotions.target_path`.
 *     These are exactly the directories `emitSpool` treats as compiled
 *     knowledge, so quarantining here shields the spool without touching
 *     `spool.ts` — a quarantined file is simply no longer there to ingest.
 *
 *   - `outputs/{reports,slides}/` is NOT receipt-gated in v1: the render
 *     layer writes no queryable receipt row (no DB table keys rendered
 *     artifacts by path), so gating it would quarantine every legitimate
 *     report/slide deck. Outputs are still gated at the L4→L2 boundary by
 *     the promotion engine. Receipting renders (schema migration) and then
 *     extending the gate to outputs/ is a documented follow-up.
 *
 * The reconciler also sweeps stale `*.tmp` files (orphans from crashes in
 * the write path) older than a safe age into quarantine. Fresh tmp files
 * are left alone — another process may be mid-write.
 *
 * Quarantined files land at `quarantine/<original-workspace-relative-path>`,
 * preserving directory structure. Nothing is ever deleted: quarantine is
 * reversible by a human, deletion is not.
 *
 * All functions return `Result<T, Error>` — never throw.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

import { appendAuditLog } from './audit-log.js';
import { writeTrace } from './traces.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One reconcile action taken on a file. */
export interface ReconcileEntry {
  /** Workspace-relative path of the offending file. */
  path: string;
  /** Workspace-relative path it was moved to under `quarantine/`. */
  quarantinedTo: string;
  /** Human-readable reason for the action. */
  reason: string;
}

/** Aggregate result of a reconcile pass. */
export interface ReconcileResult {
  /** Number of visible `.md` files examined across the gated directories. */
  scanned: number;
  /** Visible pages moved to quarantine because no receipt row matched. */
  quarantined: ReconcileEntry[];
  /** Stale `.tmp` files moved to quarantine. */
  tmpSwept: ReconcileEntry[];
}

/** Options for `reconcileWorkspace`. */
export interface ReconcileOptions {
  /**
   * A `.tmp` file must be at least this old (mtime, in ms) to be swept.
   * Defaults to one hour — far longer than any single pass or promotion
   * takes, so an in-flight writer's tmp is never stolen.
   */
  tmpMaxAgeMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  now?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Workspace-relative wiki subdirectories that hold compiled pages. Must stay
 * in sync with the promotion targets (`TYPE_DIRECTORY_MAP` in promotion.ts)
 * and the spool's compiled-page discovery (`WIKI_DIRS` in spool.ts).
 */
const GATED_WIKI_DIRS = [
  'wiki/sources',
  'wiki/concepts',
  'wiki/entities',
  'wiki/topics',
  'wiki/contradictions',
  'wiki/open-questions',
] as const;

/** Directories swept for stale `.tmp` files (gated wiki dirs + outputs). */
const TMP_SWEEP_DIRS = [...GATED_WIKI_DIRS, 'outputs/reports', 'outputs/slides'] as const;

/** Default stale-tmp threshold: one hour. */
const DEFAULT_TMP_MAX_AGE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect workspace-relative paths of files under `dirRel` whose
 * name matches `predicate`. Returns [] when the directory does not exist.
 */
function collectFiles(
  workspacePath: string,
  dirRel: string,
  predicate: (name: string) => boolean,
): string[] {
  const dirAbs = join(workspacePath, dirRel);
  if (!existsSync(dirAbs)) return [];

  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const relPath = join(dirRel, entry);
    const absPath = join(workspacePath, relPath);
    try {
      if (statSync(absPath).isDirectory()) {
        results.push(...collectFiles(workspacePath, relPath, predicate));
      } else if (predicate(entry)) {
        results.push(relPath);
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return results;
}

/**
 * Move `relPath` into `quarantine/<relPath>`, creating parent directories.
 * If the destination already exists (repeat quarantine of a same-named
 * file), a numeric suffix is appended rather than overwriting — quarantine
 * must never destroy evidence.
 */
function quarantineFile(workspacePath: string, relPath: string): Result<string, Error> {
  const sourceAbs = join(workspacePath, relPath);
  let destRel = join('quarantine', relPath);
  let destAbs = join(workspacePath, destRel);

  let suffix = 1;
  while (existsSync(destAbs)) {
    destRel = join('quarantine', `${relPath}.${suffix}`);
    destAbs = join(workspacePath, destRel);
    suffix += 1;
  }

  try {
    mkdirSync(dirname(destAbs), { recursive: true });
    renameSync(sourceAbs, destAbs);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  return ok(destRel);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconcile a workspace against its receipts.
 *
 * 1. Loads the receipted-path set: every `compilations.output_path` plus
 *    every `promotions.target_path`.
 * 2. Walks the gated wiki directories; any visible `.md` with no receipt
 *    row is MOVED to `quarantine/<rel-path>` (never deleted).
 * 3. Sweeps `*.tmp` files older than `tmpMaxAgeMs` in the gated wiki dirs
 *    and `outputs/{reports,slides}` into quarantine.
 * 4. If anything moved, writes an `audit.reconcile` trace + log.md entry so
 *    the reconciliation itself is receipted.
 *
 * Callable at startup by any entry point that is about to treat wiki/ as
 * receipted knowledge (the `ico spool emit` command runs it by default),
 * and directly via `ico audit reconcile`.
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param options       - Optional tmp-age threshold and clock override.
 */
export function reconcileWorkspace(
  db: Database,
  workspacePath: string,
  options?: ReconcileOptions,
): Result<ReconcileResult, Error> {
  const tmpMaxAgeMs = options?.tmpMaxAgeMs ?? DEFAULT_TMP_MAX_AGE_MS;
  const now = options?.now ?? Date.now();

  // 1. Receipted-path set. Paths are stored workspace-relative by both
  // writers (see promotion.ts / the compiler passes), matching the relative
  // paths produced by the directory walk below.
  let receipted: Set<string>;
  try {
    const compRows = db
      .prepare<[], { output_path: string }>('SELECT output_path FROM compilations')
      .all();
    const promoRows = db
      .prepare<[], { target_path: string }>('SELECT target_path FROM promotions')
      .all();
    receipted = new Set<string>([
      ...compRows.map((r) => r.output_path),
      ...promoRows.map((r) => r.target_path),
    ]);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const quarantined: ReconcileEntry[] = [];
  const tmpSwept: ReconcileEntry[] = [];
  let scanned = 0;

  // 2. Quarantine unreceipted visible pages.
  for (const dirRel of GATED_WIKI_DIRS) {
    const mdFiles = collectFiles(workspacePath, dirRel, (name) => name.endsWith('.md'));
    for (const relPath of mdFiles) {
      scanned += 1;
      if (receipted.has(relPath)) continue;

      const moved = quarantineFile(workspacePath, relPath);
      if (!moved.ok) {
        return err(moved.error);
      }
      quarantined.push({
        path: relPath,
        quarantinedTo: moved.value,
        reason: 'visible page has no matching compilations/promotions receipt row',
      });
    }
  }

  // 3. Sweep stale tmp files (crash orphans from the tmp→receipts→rename
  // write path). Fresh ones are skipped — a writer may be mid-operation.
  for (const dirRel of TMP_SWEEP_DIRS) {
    const tmpFiles = collectFiles(workspacePath, dirRel, (name) => name.endsWith('.tmp'));
    for (const relPath of tmpFiles) {
      let mtimeMs: number;
      try {
        mtimeMs = statSync(join(workspacePath, relPath)).mtimeMs;
      } catch {
        continue; // Raced away — nothing to sweep.
      }
      if (now - mtimeMs < tmpMaxAgeMs) continue;

      const moved = quarantineFile(workspacePath, relPath);
      if (!moved.ok) {
        return err(moved.error);
      }
      tmpSwept.push({
        path: relPath,
        quarantinedTo: moved.value,
        reason: `stale tmp file (older than ${String(tmpMaxAgeMs)}ms) — crash orphan`,
      });
    }
  }

  // 4. Receipt the reconciliation itself.
  if (quarantined.length > 0 || tmpSwept.length > 0) {
    const traceResult = writeTrace(
      db,
      workspacePath,
      'audit.reconcile',
      {
        quarantined: quarantined.map((q) => q.path),
        tmpSwept: tmpSwept.map((t) => t.path),
      },
      {
        summary: `Reconcile quarantined ${String(quarantined.length)} page(s), swept ${String(tmpSwept.length)} tmp file(s)`,
      },
    );
    if (!traceResult.ok) {
      return err(traceResult.error);
    }

    const logResult = appendAuditLog(
      workspacePath,
      'audit.reconcile',
      `Quarantined ${String(quarantined.length)} unreceipted page(s), swept ${String(tmpSwept.length)} stale tmp file(s)`,
    );
    if (!logResult.ok) {
      return err(logResult.error);
    }
  }

  return ok({ scanned, quarantined, tmpSwept });
}
