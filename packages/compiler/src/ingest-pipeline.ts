/**
 * Ingest pipeline — end-to-end orchestration for ingesting a raw source file
 * into the ICO workspace.
 *
 * Coordinates: file validation → type detection → adapter ingestion → hashing
 * → duplicate detection → atomic copy to raw/ → database registration →
 * provenance recording → trace writing → audit logging.
 *
 * Never throws — all failures are returned as `err(Error)`.
 */

import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  appendAuditLog,
  closeDatabase,
  computeFileHash,
  initDatabase,
  isSourceChanged,
  listSources,
  recordProvenance,
  registerSource,
  writeTrace,
} from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

import { detectSourceType, ingestSource, type SourceType } from './adapters/registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum file size (50 MiB). */
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Maps each {@link SourceType} to its subdirectory under `raw/`.
 *
 * - `pdf`      → `raw/papers`
 * - `markdown` → `raw/notes`
 * - `html`     → `raw/articles`
 * - `text`     → `raw/notes`
 */
const TYPE_SUBDIRS: Record<SourceType, string> = {
  pdf: 'papers',
  markdown: 'notes',
  html: 'articles',
  text: 'notes',
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for a single pipeline run. */
export interface IngestPipelineOptions {
  /** Absolute path to the workspace root directory. */
  workspacePath: string;
  /** Absolute path to the SQLite state database (typically `<workspace>/.ico/state.db`). */
  dbPath: string;
  /** Force a specific source type rather than auto-detecting from the file extension. */
  typeOverride?: SourceType;
  /** When `true`, bypasses the file-size guard. Defaults to `false`. */
  force?: boolean;
  /** Maximum allowed file size in bytes. Defaults to 50 MiB. */
  maxFileSize?: number;
}

/** The normalised result returned on a successful pipeline run. */
export interface IngestPipelineResult {
  /** UUID of the newly registered (or pre-existing) source record. */
  sourceId: string;
  /** Relative path within `raw/` where the file was copied. */
  path: string;
  /** Detected or overridden source type. */
  type: SourceType;
  /** SHA-256 hex digest of the source file content. */
  hash: string;
  /** Title extracted by the adapter, or `null` when absent. */
  title: string | null;
  /** Word count of the body content. */
  wordCount: number;
  /**
   * `true` when the file was already registered with an identical hash.
   * In this case the file is not re-copied and no new records are written.
   */
  alreadyIngested: boolean;
  /**
   * `true` when the same path was previously ingested with a different hash.
   * A new source record is created for the updated content.
   */
  reingested?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Converts an arbitrary filename into a safe slug suitable for the `raw/`
 * directory.
 *
 * - Lowercases the stem.
 * - Collapses whitespace and underscores to hyphens.
 * - Strips any character that is not alphanumeric or a hyphen.
 * - Trims leading/trailing hyphens.
 * - Falls back to `"source"` when the stem is empty after transformation.
 * - Lowercases the extension.
 *
 * @param filename - Basename of the original file (may include an extension).
 * @returns A filename safe for use in the raw/ content store.
 */
function slugify(filename: string): string {
  const ext = extname(filename);
  const stem = basename(filename, ext);
  const slug = stem
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug ? `${slug}${ext.toLowerCase()}` : `source${ext.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full ingest pipeline for a single source file.
 *
 * Steps:
 *  1.  Validate the file exists on disk.
 *  2.  Resolve symlinks and verify the resolved path stays within the file's
 *      parent directory (symlink-escape guard).
 *  3.  Check file size against `maxFileSize` (skipped when `force` is `true`).
 *  4.  Detect the source type (or use `typeOverride`).
 *  5.  Run the appropriate adapter to extract content and metadata.
 *  6.  Compute the SHA-256 hash of the resolved file.
 *  7.  Open the SQLite database.
 *  8.  Determine the destination relative path: `raw/<subdir>/<slugified-name>`.
 *      If `isSourceChanged` returns `false`, the file is already registered at
 *      that path with the same hash — return early with `alreadyIngested: true`.
 *  9.  Copy the file atomically to the destination (write to a `.tmp` file,
 *      then `renameSync` into place).
 * 10.  Register the source in the database.
 * 11.  Record a provenance entry.
 * 12.  Write a `source.ingest` trace event.
 * 13.  Append an entry to `audit/log.md`.
 * 14.  Close the database (always, in a `finally` block).
 * 15.  Return the {@link IngestPipelineResult}.
 *
 * @param filePath - Absolute path to the file to ingest.
 * @param options  - Pipeline configuration.
 * @returns `ok(result)` on success, `err(Error)` on any failure.
 */
export async function runIngestPipeline(
  filePath: string,
  options: IngestPipelineOptions,
): Promise<Result<IngestPipelineResult, Error>> {
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  // 1. Validate the file exists.
  if (!existsSync(filePath)) {
    return err(new Error(`File not found: ${filePath}`));
  }

  // 2. Resolve symlinks and apply symlink-escape guard.
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(filePath);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // The resolved symlink target must remain inside the original file's parent
  // directory to prevent directory-traversal attacks via symlinks.
  const parentDir = dirname(resolve(filePath));
  const rel = relative(parentDir, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return err(
      new Error(`Symlink escape detected: "${filePath}" resolves outside its parent directory`),
    );
  }

  // 3. Check file size.
  let fileSize: number;
  try {
    fileSize = statSync(resolvedPath).size;
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (options.force !== true && fileSize > maxFileSize) {
    return err(
      new Error(
        `File too large: ${fileSize} bytes exceeds limit of ${maxFileSize} bytes. ` +
          `Pass force: true to bypass.`,
      ),
    );
  }

  // 4. Detect source type.
  const type: SourceType = options.typeOverride ?? detectSourceType(resolvedPath);

  // 5. Run the adapter.
  const ingestResult = await ingestSource(resolvedPath, type);
  if (!ingestResult.ok) {
    return err(ingestResult.error);
  }

  const { metadata } = ingestResult.value;

  // 6. Compute file hash.
  const hashResult = computeFileHash(resolvedPath);
  if (!hashResult.ok) {
    return err(hashResult.error);
  }
  const hash = hashResult.value;

  // 7. Open the database.
  const dbResult = initDatabase(options.dbPath);
  if (!dbResult.ok) {
    return err(dbResult.error);
  }
  const db = dbResult.value;

  try {
    // 8. Determine destination relative path and check for duplicate.
    const subdir = TYPE_SUBDIRS[type];
    const slug = slugify(basename(filePath));
    const relPath = join('raw', subdir, slug);

    const changedResult = isSourceChanged(db, relPath, hash);
    if (!changedResult.ok) {
      return err(changedResult.error);
    }

    if (!changedResult.value) {
      // Already ingested — call registerSource which is idempotent on (path, hash)
      // and returns the existing record, giving us a guaranteed valid sourceId.
      const existingResult = registerSource(db, {
        path: relPath,
        type,
        hash,
        wordCount: metadata.wordCount,
        ...(metadata.title !== null && { title: metadata.title }),
        ...(metadata.author !== null && { author: metadata.author }),
      });
      if (!existingResult.ok) {
        return err(existingResult.error);
      }

      return ok({
        sourceId: existingResult.value.id,
        path: relPath,
        type,
        hash,
        title: metadata.title,
        wordCount: metadata.wordCount,
        alreadyIngested: true,
      });
    }

    // Determine whether this is a re-ingest (same path, different hash) by
    // checking if any prior record exists at the canonical path.
    const allSourcesResult = listSources(db);
    if (!allSourcesResult.ok) {
      return err(allSourcesResult.error);
    }
    const oldRecord = allSourcesResult.value.find((s) => s.path === relPath);
    const isReingest = oldRecord !== undefined;
    const oldHash = oldRecord?.hash;

    // 9. Atomic copy to raw/<subdir>/<slug>.
    const destDir = resolve(options.workspacePath, 'raw', subdir);
    try {
      mkdirSync(destDir, { recursive: true });
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    const absoluteDest = resolve(destDir, slug);
    const tmpPath = `${absoluteDest}.tmp`;

    try {
      copyFileSync(resolvedPath, tmpPath);
      renameSync(tmpPath, absoluteDest);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    // 10. Register source in the database.
    const extraMetadata: Record<string, unknown> = {};
    if (metadata.pageCount !== undefined) {
      extraMetadata['pageCount'] = metadata.pageCount;
    }

    const sourceResult = registerSource(db, {
      path: relPath,
      type,
      hash,
      wordCount: metadata.wordCount,
      ...(metadata.title !== null && { title: metadata.title }),
      ...(metadata.author !== null && { author: metadata.author }),
      ...(Object.keys(extraMetadata).length > 0 && { metadata: extraMetadata }),
    });
    if (!sourceResult.ok) {
      return err(sourceResult.error);
    }
    const source = sourceResult.value;

    // 11. Record provenance.
    const provenanceResult = recordProvenance(db, options.workspacePath, {
      sourceId: source.id,
      outputPath: relPath,
      outputType: 'raw',
      operation: 'ingest',
    });
    if (!provenanceResult.ok) {
      return err(provenanceResult.error);
    }

    // 12. Write trace event.
    const traceEventType = isReingest ? 'source.reingest' : 'source.ingest';
    const tracePayload = isReingest
      ? { sourceId: source.id, path: relPath, oldHash, newHash: hash }
      : { sourceId: source.id, path: relPath, hash, type };
    const traceResult = writeTrace(db, options.workspacePath, traceEventType, tracePayload);
    if (!traceResult.ok) {
      return err(traceResult.error);
    }

    // 13. Append audit log entry.
    const auditMessage = isReingest
      ? `Re-ingested ${basename(filePath)} (updated content)`
      : `Ingested ${basename(filePath)}`;
    const auditResult = appendAuditLog(options.workspacePath, traceEventType, auditMessage);
    if (!auditResult.ok) {
      return err(auditResult.error);
    }

    // 15. Return the result.
    return ok({
      sourceId: source.id,
      path: relPath,
      type,
      hash,
      title: metadata.title,
      wordCount: metadata.wordCount,
      alreadyIngested: false,
      ...(isReingest && { reingested: true }),
    });
  } finally {
    // 14. Always close the database.
    closeDatabase(db);
  }
}
