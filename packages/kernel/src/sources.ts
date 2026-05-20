/**
 * Source registry — CRUD operations over the `sources` table, plus
 * content-hashing utilities for change detection.
 *
 * All functions return `Result<T, Error>` — never throw. The caller is
 * responsible for inspecting `.ok` before using `.value`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';
import { type Source, SourceSchema } from '@ico/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parameters for registering a new source record.
 *
 * `hash` must be computed by the caller (e.g. via `computeFileHash`) before
 * calling `registerSource` so the caller controls when I/O occurs.
 */
export interface RegisterSourceParams {
  /** Relative path within `workspace/raw/`. */
  path: string;
  /** Optional association to a registered mount. */
  mountId?: string;
  /** File type — drives compilation pass selection. */
  type: 'pdf' | 'markdown' | 'html' | 'text';
  title?: string;
  author?: string;
  wordCount?: number;
  /** Arbitrary key/value metadata stored as JSON. */
  metadata?: Record<string, unknown>;
  /** Pre-computed SHA-256 hex digest of the file content. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Raw row shape returned by better-sqlite3 for the `sources` table. */
interface SourceRow {
  id: string;
  path: string;
  mount_id: string | null;
  type: string;
  title: string | null;
  author: string | null;
  ingested_at: string;
  word_count: number | null;
  hash: string;
  metadata: string | null;
}

/**
 * Validates a raw database row through the `SourceSchema` Zod validator.
 * Guards against schema drift between the SQLite DDL and the type definitions.
 */
function parseRow(row: SourceRow): Result<Source, Error> {
  const parsed = SourceSchema.safeParse(row);
  if (!parsed.success) {
    return err(new Error(`Source row failed validation: ${parsed.error.message}`));
  }
  return ok(parsed.data);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a source record in the database.
 *
 * Generates a UUID via `crypto.randomUUID()` and sets `ingested_at` to the
 * current ISO timestamp. If the `(path, hash)` unique constraint fires — i.e.
 * the exact same content is already recorded at the same path — the existing
 * record is returned instead of an error, making this call idempotent for
 * unchanged files.
 *
 * @param db     - Open better-sqlite3 database instance.
 * @param params - Source registration parameters including the pre-computed hash.
 * @returns `ok(source)` on success or on duplicate, `err(error)` on unexpected failures.
 */
export function registerSource(db: Database, params: RegisterSourceParams): Result<Source, Error> {
  const id = crypto.randomUUID();
  const ingested_at = new Date().toISOString();
  const metadataJson = params.metadata != null ? JSON.stringify(params.metadata) : null;

  try {
    db.prepare<
      [
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
        string,
        number | null,
        string,
        string | null,
      ],
      void
    >(
      `INSERT INTO sources
         (id, path, mount_id, type, title, author, ingested_at, word_count, hash, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      params.path,
      params.mountId ?? null,
      params.type,
      params.title ?? null,
      params.author ?? null,
      ingested_at,
      params.wordCount ?? null,
      params.hash,
      metadataJson,
    );
  } catch (e) {
    // UNIQUE constraint on (path, hash) means this exact content is already
    // recorded — return the existing record instead of failing.
    if (
      e instanceof Error &&
      e.message.includes('UNIQUE constraint failed') &&
      e.message.includes('sources.path')
    ) {
      const existing = db
        .prepare<[string, string], SourceRow>('SELECT * FROM sources WHERE path = ? AND hash = ?')
        .get(params.path, params.hash);

      if (!existing) {
        return err(new Error('Duplicate source detected but existing record not found'));
      }
      return parseRow(existing);
    }
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const row = db.prepare<[string], SourceRow>('SELECT * FROM sources WHERE id = ?').get(id);

  if (!row) {
    return err(new Error('Source was inserted but could not be retrieved'));
  }

  return parseRow(row);
}

/**
 * Retrieve a source record by its UUID.
 *
 * @param db - Open better-sqlite3 database instance.
 * @param id - UUID of the source to look up.
 * @returns `ok(source)` if found, `ok(null)` if not found, or `err(error)` on
 *          a query failure.
 */
export function getSource(db: Database, id: string): Result<Source | null, Error> {
  let row: SourceRow | undefined;
  try {
    row = db.prepare<[string], SourceRow>('SELECT * FROM sources WHERE id = ?').get(id);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (!row) return ok(null);
  return parseRow(row);
}

/**
 * Return all registered sources, optionally filtered to a specific mount.
 *
 * @param db      - Open better-sqlite3 database instance.
 * @param mountId - When provided, only sources associated with this mount are
 *                  returned.
 * @returns `ok(sources)` — an empty array when no sources match.
 */
export function listSources(db: Database, mountId?: string): Result<Source[], Error> {
  let rows: SourceRow[];
  try {
    if (mountId !== undefined) {
      rows = db
        .prepare<
          [string],
          SourceRow
        >('SELECT * FROM sources WHERE mount_id = ? ORDER BY ingested_at DESC')
        .all(mountId);
    } else {
      rows = db.prepare<[], SourceRow>('SELECT * FROM sources ORDER BY ingested_at DESC').all();
    }
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const sources: Source[] = [];
  for (const row of rows) {
    const result = parseRow(row);
    if (!result.ok) return result;
    sources.push(result.value);
  }

  return ok(sources);
}

/**
 * Determine whether the content at `path` has changed since it was last
 * ingested.
 *
 * - If no record exists for `path`, returns `true` (treat as new).
 * - If the most recent record's hash matches `currentHash`, returns `false`.
 * - If the hash differs, returns `true` (content has changed).
 *
 * @param db          - Open better-sqlite3 database instance.
 * @param path        - Relative path within `workspace/raw/`.
 * @param currentHash - SHA-256 hex digest of the current file content.
 * @returns `ok(true)` if the source is new or changed, `ok(false)` if unchanged.
 */
export function isSourceChanged(
  db: Database,
  path: string,
  currentHash: string,
): Result<boolean, Error> {
  let row: Pick<SourceRow, 'hash'> | undefined;
  try {
    row = db
      .prepare<[string], Pick<SourceRow, 'hash'>>(
        `SELECT hash FROM sources
         WHERE path = ?
         ORDER BY ingested_at DESC
         LIMIT 1`,
      )
      .get(path);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // No record for this path — treat as new.
  if (!row) return ok(true);

  return ok(row.hash !== currentHash);
}

/**
 * Compute the SHA-256 hex digest of a file's content.
 *
 * Reads the file synchronously. For very large files callers may prefer a
 * streaming approach, but synchronous reads keep the result type simple and
 * match the rest of the kernel's synchronous SQLite API.
 *
 * @param filePath - Absolute or resolvable filesystem path to the file.
 * @returns `ok(hexHash)` on success, or `err(error)` if the file cannot be read.
 */
export function computeFileHash(filePath: string): Result<string, Error> {
  let content: Buffer;
  try {
    content = readFileSync(filePath);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  try {
    const hash = createHash('sha256').update(content).digest('hex');
    return ok(hash);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
