/**
 * Mount registry — CRUD operations over the `mounts` table.
 *
 * All functions return `Result<T, Error>` — never throw. The caller is
 * responsible for inspecting `.ok` before using `.value`.
 */

import { existsSync } from 'node:fs';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';
import { type Mount, MountSchema } from '@ico/types';

/** Row shape returned directly from better-sqlite3 for the mounts table. */
interface MountRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_indexed_at: string | null;
}

/**
 * Parses a raw database row through the MountSchema Zod validator.
 * Returns `err` if the row fails validation (guards against schema drift).
 */
function parseRow(row: MountRow): Result<Mount, Error> {
  const parsed = MountSchema.safeParse(row);
  if (!parsed.success) {
    return err(new Error(`Mount row failed validation: ${parsed.error.message}`));
  }
  return ok(parsed.data);
}

/**
 * Register a new mount by name and filesystem path.
 *
 * Generates a UUID via `crypto.randomUUID()`, verifies the path exists on
 * disk, rejects duplicate names, inserts the record, and returns the
 * persisted Mount.
 *
 * @param db   - Open better-sqlite3 database instance.
 * @param name - Human-readable label; must be unique across all mounts.
 * @param path - Absolute filesystem path to the directory being mounted.
 * @returns `ok(mount)` on success, or `err(error)` if the path does not
 *          exist, the name is already registered, or the insert fails.
 */
export function registerMount(db: Database, name: string, path: string): Result<Mount, Error> {
  // Verify the path exists before touching the database.
  if (!existsSync(path)) {
    return err(new Error(`Path does not exist: ${path}`));
  }

  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();

  try {
    db.prepare<[string, string, string, string], void>(
      'INSERT INTO mounts (id, name, path, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, name, path, created_at);
  } catch (e) {
    // SQLite UNIQUE constraint on `name` produces an error message that
    // contains "UNIQUE constraint failed". Surface a clearer message.
    if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
      return err(new Error(`A mount with name "${name}" is already registered`));
    }
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const row = db.prepare<[string], MountRow>('SELECT * FROM mounts WHERE id = ?').get(id);

  if (!row) {
    return err(new Error('Mount was inserted but could not be retrieved'));
  }

  return parseRow(row);
}

/**
 * Return all registered mounts ordered alphabetically by name.
 *
 * @param db - Open better-sqlite3 database instance.
 * @returns `ok(mounts)` — an empty array when no mounts are registered.
 */
export function listMounts(db: Database): Result<Mount[], Error> {
  let rows: MountRow[];
  try {
    rows = db.prepare<[], MountRow>('SELECT * FROM mounts ORDER BY name').all();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const mounts: Mount[] = [];
  for (const row of rows) {
    const result = parseRow(row);
    if (!result.ok) return result;
    mounts.push(result.value);
  }

  return ok(mounts);
}

/**
 * Retrieve a mount by its UUID.
 *
 * @param db - Open better-sqlite3 database instance.
 * @param id - UUID of the mount to look up.
 * @returns `ok(mount)` if found, `ok(null)` if not found, or `err(error)`
 *          on a query failure.
 */
export function getMount(db: Database, id: string): Result<Mount | null, Error> {
  let row: MountRow | undefined;
  try {
    row = db.prepare<[string], MountRow>('SELECT * FROM mounts WHERE id = ?').get(id);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (!row) return ok(null);
  return parseRow(row);
}

/**
 * Retrieve a mount by its unique name.
 *
 * @param db   - Open better-sqlite3 database instance.
 * @param name - Unique name of the mount to look up.
 * @returns `ok(mount)` if found, `ok(null)` if not found, or `err(error)`
 *          on a query failure.
 */
export function getMountByName(db: Database, name: string): Result<Mount | null, Error> {
  let row: MountRow | undefined;
  try {
    row = db.prepare<[string], MountRow>('SELECT * FROM mounts WHERE name = ?').get(name);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (!row) return ok(null);
  return parseRow(row);
}

/**
 * Remove a mount by its UUID.
 *
 * @param db - Open better-sqlite3 database instance.
 * @param id - UUID of the mount to delete.
 * @returns `ok(true)` if the mount was deleted, `ok(false)` if no mount with
 *          that id existed, or `err(error)` on a query failure.
 */
export function removeMount(db: Database, id: string): Result<boolean, Error> {
  let changes: number;
  try {
    const info = db.prepare<[string], void>('DELETE FROM mounts WHERE id = ?').run(id);
    changes = info.changes;
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  return ok(changes > 0);
}
