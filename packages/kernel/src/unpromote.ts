/**
 * Promotion reversal — removes a promoted wiki page and its DB record.
 *
 * Reverses the effects of `promoteArtifact`: deletes the file from wiki/,
 * removes the promotions table record, writes a trace event and audit log
 * entry, then rebuilds the wiki index.
 *
 * All functions return `Result<T, Error>` — never throw.
 *
 * @module unpromote
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

import { appendAuditLog } from './audit-log.js';
import { writeTrace } from './traces.js';
import { rebuildWikiIndex } from './wiki-index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated error codes for unpromote failures.
 */
export type UnpromoteErrorCode =
  | 'NOT_PROMOTED' // No promotions record for this target path
  | 'FILE_NOT_FOUND' // Promotions record exists but file is gone
  | 'DELETE_FAILED' // unlinkSync or DB delete failed
  | 'AUDIT_WRITE_FAILED' // Trace write or audit log append failed
  | 'INDEX_REBUILD_FAILED'; // Wiki index rebuild failed after unpromote

/**
 * Typed error raised by the unpromote engine.
 * Extends `Error` so it is compatible with `Result<T, Error>`.
 */
export class UnpromoteError extends Error {
  constructor(
    public readonly code: UnpromoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UnpromoteError';
  }
}

/** Input parameters for a single unpromote request. */
export interface UnpromoteInput {
  /** Workspace-relative path of the promoted page to remove (e.g. `wiki/topics/foo.md`). */
  targetPath: string;
  /** When `true`, preview the reversal without making any changes. */
  dryRun?: boolean;
}

/** Successful unpromote result. */
export interface UnpromoteResult {
  /** The workspace-relative path that was (or would be) removed. */
  targetPath: string;
  /** The original source path from the promotions record. */
  sourcePath: string;
  /** The promotion type from the promotions record. */
  targetType: string;
  /** Whether this was a dry run — no changes were made if `true`. */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Internal DB row type
// ---------------------------------------------------------------------------

interface PromotionRecord {
  id: string;
  source_path: string;
  target_path: string;
  target_type: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reverse a promotion:
 *  1. Look up the promotions record by target_path.
 *  2. If dry run, return a preview without making any changes.
 *  3. Verify the file exists on disk.
 *  4. Delete the file from wiki/.
 *  5. Delete the promotions table record.
 *  6. Write a trace event (event_type: 'unpromote').
 *  7. Append to the audit log.
 *  8. Rebuild the wiki index.
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param input         - Unpromote request parameters.
 * @returns `ok(UnpromoteResult)` on success, or `err(UnpromoteError)` on any
 *          failure.
 */
export function unpromoteArtifact(
  db: Database,
  workspacePath: string,
  input: UnpromoteInput,
): Result<UnpromoteResult, UnpromoteError> {
  const { targetPath, dryRun = false } = input;

  // -------------------------------------------------------------------------
  // Step 1: Look up the promotions record
  // -------------------------------------------------------------------------

  const record = db
    .prepare<
      [string],
      PromotionRecord
    >('SELECT id, source_path, target_path, target_type FROM promotions WHERE target_path = ?')
    .get(targetPath);

  if (record === undefined) {
    return err(
      new UnpromoteError(
        'NOT_PROMOTED',
        `No promotion record found for target path: ${targetPath}`,
      ),
    );
  }

  const { source_path: sourcePath, target_type: targetType } = record;

  // -------------------------------------------------------------------------
  // Step 2: Dry run — return preview without making changes
  // -------------------------------------------------------------------------

  if (dryRun) {
    return ok({ targetPath, sourcePath, targetType, dryRun: true });
  }

  // -------------------------------------------------------------------------
  // Step 3: Verify the file exists on disk
  // -------------------------------------------------------------------------

  const absoluteTarget = join(workspacePath, targetPath);

  if (!existsSync(absoluteTarget)) {
    return err(
      new UnpromoteError('FILE_NOT_FOUND', `Promoted file not found on disk: ${targetPath}`),
    );
  }

  // -------------------------------------------------------------------------
  // Step 4: Delete the file from wiki/
  // -------------------------------------------------------------------------

  try {
    unlinkSync(absoluteTarget);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(
      new UnpromoteError('DELETE_FAILED', `Failed to delete promoted file ${targetPath}: ${msg}`),
    );
  }

  // -------------------------------------------------------------------------
  // Step 5: Delete the DB record
  // -------------------------------------------------------------------------

  try {
    db.prepare<[string], void>('DELETE FROM promotions WHERE target_path = ?').run(targetPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(
      new UnpromoteError(
        'DELETE_FAILED',
        `Failed to delete promotions record for ${targetPath}: ${msg}`,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Step 6: Write trace event
  // -------------------------------------------------------------------------

  const traceResult = writeTrace(
    db,
    workspacePath,
    'unpromote',
    { targetPath, sourcePath, targetType },
    { summary: `Unpromoted ${targetPath} (was promoted from ${sourcePath})` },
  );

  if (!traceResult.ok) {
    return err(
      new UnpromoteError(
        'AUDIT_WRITE_FAILED',
        `Failed to write trace event: ${traceResult.error.message}`,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Step 7: Append audit log
  // -------------------------------------------------------------------------

  const auditResult = appendAuditLog(
    workspacePath,
    'unpromote',
    `Unpromoted ${targetPath} (was promoted from ${sourcePath})`,
  );

  if (!auditResult.ok) {
    return err(
      new UnpromoteError(
        'AUDIT_WRITE_FAILED',
        `Failed to append audit log: ${auditResult.error.message}`,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Step 8: Rebuild wiki index
  // -------------------------------------------------------------------------

  const indexResult = rebuildWikiIndex(workspacePath);
  if (!indexResult.ok) {
    return err(
      new UnpromoteError(
        'INDEX_REBUILD_FAILED',
        `Failed to rebuild wiki index: ${indexResult.error.message}`,
      ),
    );
  }

  return ok({ targetPath, sourcePath, targetType, dryRun: false });
}
