import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './state.js';
import { closeDatabase, initDatabase, initDatabaseWithMigrations, runMigrations } from './state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a unique temporary file path that does not yet exist. */
function tmpDbPath(): string {
  return join(tmpdir(), `ico-test-${randomUUID()}.db`);
}

/** Returns a unique temporary directory path and creates it. */
function tmpMigrationsDir(): string {
  const dir = join(tmpdir(), `ico-migrations-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const KERNEL_MIGRATIONS_DIR = new URL('../migrations', import.meta.url).pathname;

/** All tables that the initial schema must create. */
const EXPECTED_TABLES = [
  'sources',
  'mounts',
  'compilations',
  'tasks',
  'promotions',
  'recall_results',
  'traces',
  'compilation_sources',
] as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dbPath: string;
let db: Database;

beforeEach(() => {
  dbPath = tmpDbPath();
  const result = initDatabase(dbPath);
  if (!result.ok) throw result.error;
  db = result.value;
});

afterEach(() => {
  closeDatabase(db);
  try {
    rmSync(dbPath);
  } catch {
    /* already gone */
  }
});

// ---------------------------------------------------------------------------
// Pragma tests
// ---------------------------------------------------------------------------

describe('initDatabase — pragmas', () => {
  it('enables WAL journal mode', () => {
    const mode = db.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('sets busy_timeout to 5000 ms', () => {
    const timeout = db.pragma('busy_timeout', { simple: true });
    expect(timeout).toBe(5000);
  });

  it('enables foreign key enforcement', () => {
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('initDatabase — schema', () => {
  it('creates all 8 application tables', () => {
    const rows = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\'")
      .all();
    const tableNames = new Set(rows.map((r) => r.name));

    for (const table of EXPECTED_TABLES) {
      expect(tableNames, `expected table "${table}" to exist`).toContain(table);
    }
  });

  it('creates the _migrations tracking table', () => {
    const row = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .get();
    expect(row).toBeDefined();
  });

  it('records migration 001-initial-schema.sql in _migrations', () => {
    const row = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM _migrations WHERE name='001-initial-schema.sql'")
      .get();
    expect(row).toBeDefined();
    expect(row?.name).toBe('001-initial-schema.sql');
  });
});

// ---------------------------------------------------------------------------
// Idempotency test
// ---------------------------------------------------------------------------

describe('runMigrations — idempotency', () => {
  it('is idempotent: running migrations twice returns ok(0) on the second run', () => {
    // The first run already happened in beforeEach (via initDatabase).
    const result = runMigrations(db, KERNEL_MIGRATIONS_DIR);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });

  it('does not duplicate rows in _migrations when called multiple times', () => {
    runMigrations(db, KERNEL_MIGRATIONS_DIR);
    runMigrations(db, KERNEL_MIGRATIONS_DIR);

    const rows = db.prepare<[], { name: string }>('SELECT name FROM _migrations').all();
    const names = rows.map((r) => r.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// Rollback on failure test
// ---------------------------------------------------------------------------

describe('runMigrations — rollback on failure', () => {
  it('rolls back the entire migration batch when a migration contains invalid SQL', () => {
    // Create a custom migrations directory with two files:
    //   - 001-valid.sql   — valid SQL (table creation)
    //   - 002-broken.sql  — intentionally bad SQL
    const migrationsDir = tmpMigrationsDir();
    const cleanupDir = () => rmSync(migrationsDir, { recursive: true, force: true });

    writeFileSync(
      join(migrationsDir, '001-valid.sql'),
      [
        '-- === UP ===',
        'CREATE TABLE canary (id TEXT PRIMARY KEY);',
        '-- === DOWN ===',
        'DROP TABLE IF EXISTS canary;',
      ].join('\n'),
    );

    writeFileSync(
      join(migrationsDir, '002-broken.sql'),
      ['-- === UP ===', 'THIS IS NOT VALID SQL;', '-- === DOWN ===', ''].join('\n'),
    );

    // Use an isolated database for this test.
    const isolatedPath = tmpDbPath();
    const initResult = initDatabaseWithMigrations(isolatedPath, migrationsDir);
    // initDatabaseWithMigrations opens the DB, runs pragmas, then calls
    // runMigrations — which should fail and close the DB, returning err.
    expect(initResult.ok).toBe(false);

    // Because the migration was rolled back, neither 001-valid nor 002-broken
    // should appear in _migrations. We verify by opening the DB afresh.
    const verifyResult = initDatabaseWithMigrations(isolatedPath, tmpMigrationsDir());
    expect(verifyResult.ok).toBe(true);
    if (verifyResult.ok) {
      const verifyDb = verifyResult.value;

      // _migrations should be empty (rollback succeeded).
      const migrationRows = verifyDb
        .prepare<[], { name: string }>('SELECT name FROM _migrations')
        .all();
      expect(migrationRows).toHaveLength(0);

      // The canary table must not exist — the batch was atomic.
      const tableRow = verifyDb
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type='table' AND name='canary'")
        .get();
      expect(tableRow).toBeUndefined();

      closeDatabase(verifyDb);
    }

    cleanupDir();
    try {
      rmSync(isolatedPath);
    } catch {
      /* ok */
    }
  });
});

// ---------------------------------------------------------------------------
// Constraint tests
// ---------------------------------------------------------------------------

describe('schema constraints', () => {
  it('rejects a task with an invalid status value', () => {
    const insertBadTask = () => {
      db.prepare(
        `INSERT INTO tasks (id, brief, status, created_at, updated_at, workspace_path)
         VALUES ('t1', 'test', 'invalid', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '/tmp/t1')`,
      ).run();
    };

    expect(insertBadTask).toThrow();
  });

  it('accepts a task with a valid status value', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO tasks (id, brief, status, created_at, updated_at, workspace_path)
         VALUES ('t2', 'test', 'created', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '/tmp/t2')`,
      ).run();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// closeDatabase tests
// ---------------------------------------------------------------------------

describe('closeDatabase', () => {
  it('closes an open database without throwing', () => {
    const path = tmpDbPath();
    const result = initDatabase(path);
    if (!result.ok) throw result.error;
    const testDb = result.value;

    expect(() => closeDatabase(testDb)).not.toThrow();
    expect(testDb.open).toBe(false);

    try {
      rmSync(path);
    } catch {
      /* ok */
    }
  });

  it('is safe to call on an already-closed database', () => {
    const path = tmpDbPath();
    const result = initDatabase(path);
    if (!result.ok) throw result.error;
    const testDb = result.value;

    closeDatabase(testDb);
    expect(() => closeDatabase(testDb)).not.toThrow();

    try {
      rmSync(path);
    } catch {
      /* ok */
    }
  });
});
