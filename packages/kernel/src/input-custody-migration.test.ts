import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { readInputCustody } from './input-custody.js';
import { initDatabaseWithMigrations, runMigrations } from './state.js';

it('upgrades a populated pre-custody database without backfilling or rewriting legacy lineage', () => {
  const oldDirectory = mkdtempSync(join(tmpdir(), 'ico-custody-upgrade-'));
  const migrations = fileURLToPath(new URL('../migrations', import.meta.url));
  try {
    for (const name of readdirSync(migrations).filter(
      (name) => /^[0-9]{3}-.*\.sql$/.test(name) && name < '006-',
    )) {
      copyFileSync(join(migrations, name), join(oldDirectory, name));
    }
    const opened = initDatabaseWithMigrations(':memory:', oldDirectory);
    if (!opened.ok) throw opened.error;
    const db = opened.value;
    try {
      db.prepare(
        "INSERT INTO sources (id,path,type,ingested_at,hash) VALUES ('legacy-source','raw/legacy.md','text','2026-11-22T00:00:00.000Z',?)",
      ).run('a'.repeat(64));
      db.exec(`INSERT INTO compilations (id,source_id,type,output_path,compiled_at,model)
        VALUES ('legacy-page','legacy-source','summary','wiki/sources/legacy.md','2026-11-22T00:00:00.000Z','fixture');
        INSERT INTO compilation_sources VALUES ('legacy-page','legacy-source');`);
      const before = ['sources', 'compilations', 'compilation_sources'].map((table) =>
        db.prepare(`SELECT * FROM ${table}`).all(),
      );
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='compilation_input_custody'").all(),
      ).toEqual([]);
      expect(runMigrations(db, migrations).ok).toBe(true);
      expect(
        ['sources', 'compilations', 'compilation_sources'].map((table) =>
          db.prepare(`SELECT * FROM ${table}`).all(),
        ),
      ).toEqual(before);
      expect(db.prepare('SELECT * FROM compilation_input_custody').all()).toEqual([]);
      expect(readInputCustody(db, 'wiki/sources/legacy.md', 'legacy output').ok).toBe(false);
      const upgraded = db.serialize();
      expect(runMigrations(db, migrations).ok).toBe(true);
      expect(db.serialize()).toEqual(upgraded);
    } finally {
      db.close();
    }
  } finally {
    rmSync(oldDirectory, { recursive: true, force: true });
  }
});
