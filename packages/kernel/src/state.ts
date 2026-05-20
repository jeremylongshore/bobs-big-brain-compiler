/**
 * Database initialization and migration runner for the ICO kernel.
 *
 * All functions return `Result<T, Error>` — never throw. The caller is
 * responsible for inspecting `.ok` before using `.value`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { err, ok, type Result } from '@ico/types';

// better-sqlite3 uses `export = Database` (CJS-style). With verbatimModuleSyntax
// and esModuleInterop:false, a direct ESM import of the constructor is not
// straightforward. We obtain the constructor at runtime via createRequire (which
// bypasses Vite's SSR transform mangling), and derive the instance type from it.
export type { Database } from 'better-sqlite3';

// `require('better-sqlite3')` returns the constructor function directly because
// the module does `module.exports = DatabaseConstructor`. The `Database` type
// exported from '@types/better-sqlite3' is the namespace's `Database` instance
// interface; we re-export it above and use it as the instance type below.
import type { Database } from 'better-sqlite3';

/**
 * Loads the better-sqlite3 CJS constructor via `createRequire` so that:
 *   - Vitest's SSR transform does not mangle the callable constructor.
 *   - tsup (ESM output) correctly resolves the native addon at runtime.
 *
 * `better-sqlite3` does `module.exports = DatabaseConstructor`, so
 * `require('better-sqlite3')` returns the constructor directly.
 */
const _require = createRequire(import.meta.url);
const DatabaseCtor = _require('better-sqlite3') as {
  new (filename: string): Database;
  new (filename: string, options: Record<string, unknown>): Database;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the migrations directory.
 *
 * Search order:
 *   1. `ICO_MIGRATIONS_DIR` env var — explicit operator override
 *   2. `<__dirname>/../migrations` — workspace dev layout
 *      (packages/kernel/dist/state.js → packages/kernel/migrations/)
 *   3. `<__dirname>/migrations` — bundled CLI layout where tsup's
 *      `onSuccess` step copied migrations next to `dist/index.js`
 *
 * The last path makes the kernel work when bundled into the published
 * `intentional-cognition-os` CLI tarball; the first two cover dev runs.
 */
function resolveMigrationsDir(): string {
  const envOverride = process.env['ICO_MIGRATIONS_DIR'];
  if (envOverride !== undefined && envOverride !== '') return envOverride;
  const devLayout = join(__dirname, '..', 'migrations');
  const bundledLayout = join(__dirname, 'migrations');
  return existsSync(devLayout) ? devLayout : bundledLayout;
}

const DEFAULT_MIGRATIONS_DIR = resolveMigrationsDir();

/** Separator tokens used to split UP and DOWN sections in migration files. */
const UP_MARKER = '-- === UP ===';
const DOWN_MARKER = '-- === DOWN ===';

/**
 * DDL for the internal migration tracking table.
 * Created once; idempotent due to `IF NOT EXISTS`.
 */
const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    applied_at  TEXT    NOT NULL
  )
`;

/**
 * Opens a SQLite database at `dbPath`, applies WAL-mode pragmas, and runs
 * all pending migrations from the default migrations directory.
 *
 * @param dbPath - Absolute or relative filesystem path for the SQLite file.
 *                 Pass `':memory:'` for an in-memory database.
 * @returns `ok(db)` on success, or `err(error)` if the database cannot be
 *          opened or migrations fail.
 */
export function initDatabase(dbPath: string): Result<Database, Error> {
  return initDatabaseWithMigrations(dbPath, DEFAULT_MIGRATIONS_DIR);
}

/**
 * Opens a SQLite database at `dbPath` and runs migrations from
 * `migrationsDir`. Exposed so tests can point at a custom migrations
 * directory (e.g. containing intentionally bad SQL).
 *
 * @param dbPath       - Filesystem path for the SQLite file.
 * @param migrationsDir - Directory containing `*.sql` migration files.
 */
export function initDatabaseWithMigrations(
  dbPath: string,
  migrationsDir: string,
): Result<Database, Error> {
  let db: Database;

  try {
    db = new DatabaseCtor(dbPath);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Apply pragmas immediately after open, before any other operations.
  try {
    db.pragma('journal_mode=WAL');
    db.pragma('foreign_keys=ON');
    db.pragma('busy_timeout=5000');
    db.pragma('synchronous=NORMAL');
  } catch (e) {
    db.close();
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const migrationResult = runMigrations(db, migrationsDir);
  if (!migrationResult.ok) {
    db.close();
    return err(migrationResult.error);
  }

  return ok(db);
}

/**
 * Reads `.sql` files from `migrationsDir`, applies any that have not yet been
 * recorded in the `_migrations` tracking table, and commits them atomically.
 *
 * Each SQL file must contain `-- === UP ===` followed by DDL to apply, and
 * optionally `-- === DOWN ===` followed by rollback DDL (not executed here).
 *
 * @param db            - An open `better-sqlite3` database instance.
 * @param migrationsDir - Directory containing `*.sql` migration files.
 * @returns `ok(count)` where `count` is the number of newly applied
 *          migrations, or `err(error)` if reading files or executing SQL
 *          fails. On failure the migration transaction is fully rolled back.
 */
export function runMigrations(db: Database, migrationsDir: string): Result<number, Error> {
  // Ensure the tracking table exists before we query it.
  try {
    db.exec(CREATE_MIGRATIONS_TABLE_SQL);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Collect the names of already-applied migrations.
  let appliedNames: Set<string>;
  try {
    const rows = db.prepare<[], { name: string }>('SELECT name FROM _migrations ORDER BY id').all();
    appliedNames = new Set(rows.map((r) => r.name));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Read and sort migration files.
  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // Determine which migrations are pending.
  const pending = files.filter((f) => !appliedNames.has(f));
  if (pending.length === 0) {
    return ok(0);
  }

  // Parse each pending file into its UP section.
  type PendingMigration = { name: string; upSql: string };
  const migrations: PendingMigration[] = [];

  for (const file of pending) {
    const filePath = join(migrationsDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    const upIndex = content.indexOf(UP_MARKER);
    if (upIndex === -1) {
      return err(new Error(`Migration file "${file}" is missing the "${UP_MARKER}" marker`));
    }

    const afterUp = content.slice(upIndex + UP_MARKER.length);
    const downIndex = afterUp.indexOf(DOWN_MARKER);
    const upSql = (downIndex === -1 ? afterUp : afterUp.slice(0, downIndex)).trim();

    if (upSql === '') {
      return err(new Error(`Migration file "${file}" has an empty UP section`));
    }

    migrations.push({ name: file, upSql });
  }

  // Apply all pending migrations inside a single transaction so that a
  // partial failure leaves the schema at the last clean checkpoint.
  const insertStmt = db.prepare<[string, string], void>(
    'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
  );

  const applyAll = db.transaction(() => {
    for (const migration of migrations) {
      db.exec(migration.upSql);
      insertStmt.run(migration.name, new Date().toISOString());
    }
  });

  try {
    applyAll();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  return ok(migrations.length);
}

/**
 * Closes the database connection. Safe to call on an already-closed database.
 *
 * @param db - The database instance to close.
 */
export function closeDatabase(db: Database): void {
  if (db.open) {
    db.close();
  }
}
