import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBoundInputCustody, recordInputCustody } from './input-custody.js';
import {
  type CaptureEvidence,
  captureSource,
  readSourceCaptureBindings,
} from './source-capture.js';
import { registerSource } from './sources.js';
import { type Database, initDatabase } from './state.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

describe('trusted-host source capture', () => {
  let base: string;
  let catalogPath: string;
  let db: Database;
  let catalog: {
    version: number;
    id: string;
    revision: number;
    roots: Array<{
      id: string;
      path: string;
      device: string;
      inode: string;
      repositoryId: string;
      profileId: string;
      profileRevision: number;
      profileDigest: string;
    }>;
  };
  const save = () => writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
  function file(root = 0, text = 'Neutral shared source', name = 'source.txt') {
    const path = join(catalog.roots[root]!.path, name);
    writeFileSync(path, text);
    return path;
  }
  function capture(path: string) {
    const result = captureSource(path, catalogPath);
    if (!result.ok) throw result.error;
    return result.value;
  }
  function persist(path: string, destination = 'raw/shared.txt') {
    const captured = capture(path);
    const hash = sha(captured.bytes);
    const result = registerSource(db, {
      path: destination,
      type: 'text',
      hash,
      capture: captured.evidence,
    });
    if (!result.ok) throw result.error;
    writeFileSync(join(base, destination), captured.bytes);
    return result.value;
  }
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ico-trusted-capture-'));
    catalogPath = join(base, 'catalog.json');
    mkdirSync(join(base, 'raw'));
    catalog = {
      version: 1,
      id: 'synthetic-operator',
      revision: 1,
      roots: ['alpha', 'beta'].map((id, i) => {
        const path = join(base, id);
        mkdirSync(path);
        const st = statSync(path, { bigint: true });
        return {
          id,
          path,
          device: String(st.dev),
          inode: String(st.ino),
          repositoryId: `repo:${id}`,
          profileId: `profile:${id}`,
          profileRevision: 1,
          profileDigest: (i === 0 ? 'a' : 'b').repeat(64),
        };
      }),
    };
    save();
    const opened = initDatabase(':memory:');
    if (!opened.ok) throw opened.error;
    db = opened.value;
  });
  it('refuses duplicate-key catalogs instead of silently selecting the last value', () => {
    const source = file();
    writeFileSync(
      catalogPath,
      JSON.stringify(catalog).replace('"version":1', '"version":2,"version":1'),
    );
    expect(captureSource(source, catalogPath).ok).toBe(false);
  });

  afterEach(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('binds exact bytes to the operator catalog, not embedded metadata', () => {
    const source = persist(
      file(0, '---\nrepository: repo:beta\nprofile: profile:beta\n---\nNeutral source'),
    );
    const result = readSourceCaptureBindings(db, source.id, source.hash, catalogPath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      rootId: 'alpha',
      repositoryId: 'repo:alpha',
      profileId: 'profile:alpha',
    });
    expect(JSON.stringify(result.value)).not.toContain(base);
  });

  it('preserves both origins when identical bytes and names deduplicate', () => {
    const a = persist(file(0));
    const b = persist(file(1));
    expect(b.id).toBe(a.id);
    const result = readSourceCaptureBindings(db, a.id, a.hash, catalogPath);
    if (!result.ok) throw result.error;
    expect(result.value.map((r) => r.profileId).sort()).toEqual(['profile:alpha', 'profile:beta']);
    const before = db.serialize();
    persist(file(1));
    expect(db.serialize().equals(before)).toBe(true);
  });

  it.each(['before', 'after'] as const)(
    'keeps unknown origin permanent when an untracked registration occurs %s capture',
    (order) => {
      const path = file();
      const params = {
        path: 'raw/shared.txt',
        type: 'text' as const,
        hash: sha('Neutral shared source'),
      };
      if (order === 'before') expect(registerSource(db, params).ok).toBe(true);
      const source = persist(path);
      if (order === 'after') expect(registerSource(db, params).ok).toBe(true);
      persist(path);
      expect(readSourceCaptureBindings(db, source.id, source.hash, catalogPath).ok).toBe(false);
      const row = db
        .prepare(
          'SELECT unknown_origin, bindings_json FROM source_capture_custody WHERE source_id=?',
        )
        .get(source.id) as { unknown_origin: number; bindings_json: string };
      expect(row.unknown_origin).toBe(1);
      expect(JSON.parse(row.bindings_json)).toHaveLength(1);
    },
  );

  it('does not backfill a legacy row from a later trusted duplicate', () => {
    db.prepare(
      "INSERT INTO sources(id,path,type,ingested_at,hash) VALUES ('00000000-0000-4000-8000-000000000001','raw/shared.txt','text','2026-11-22T00:00:00.000Z',?)",
    ).run(sha('Neutral shared source'));
    const source = persist(file());
    expect(source.id).toBe('00000000-0000-4000-8000-000000000001');
    expect(readSourceCaptureBindings(db, source.id, source.hash, catalogPath).ok).toBe(false);
  });

  it('refuses forged tickets and changed captured bytes with transaction rollback', () => {
    const captured = capture(file());
    const before = db.serialize();
    for (const token of [
      { kind: 'ico-captured-source-v1' } as CaptureEvidence,
      captured.evidence,
    ]) {
      expect(
        registerSource(db, {
          path: 'raw/forged.txt',
          type: 'text',
          hash: sha('Changed bytes'),
          capture: token,
        }).ok,
      ).toBe(false);
      expect(db.serialize().equals(before)).toBe(true);
    }
  });

  it('refuses catalog drift between capture and registration without partial rows', () => {
    const captured = capture(file());
    catalog.revision++;
    save();
    const before = db.serialize();
    expect(
      registerSource(db, {
        path: 'raw/new.txt',
        type: 'text',
        hash: sha(captured.bytes),
        capture: captured.evidence,
      }).ok,
    ).toBe(false);
    expect(db.serialize().equals(before)).toBe(true);
  });

  it('refuses missing roots and cross-root symlink escapes', () => {
    const outside = join(base, 'outside.txt');
    writeFileSync(outside, 'Neutral');
    expect(captureSource(outside, catalogPath).ok).toBe(false);
    const link = join(catalog.roots[0]!.path, 'link.txt');
    symlinkSync(file(1), link);
    expect(captureSource(link, catalogPath).ok).toBe(false);
  });

  it.each(['overlap', 'duplicate', 'inode', 'extra', 'permission'] as const)(
    'refuses invalid catalog: %s',
    (fault) => {
      const path = file();
      if (fault === 'overlap') {
        const nested = join(catalog.roots[0]!.path, 'nested');
        mkdirSync(nested);
        const st = statSync(nested, { bigint: true });
        catalog.roots[1] = {
          ...catalog.roots[1]!,
          path: nested,
          device: String(st.dev),
          inode: String(st.ino),
        };
      }
      if (fault === 'duplicate') catalog.roots[1]!.id = catalog.roots[0]!.id;
      if (fault === 'inode') catalog.roots[0]!.inode = '0';
      save();
      if (fault === 'extra')
        writeFileSync(catalogPath, JSON.stringify({ ...catalog, callerOverride: true }));
      if (fault === 'permission') chmodSync(catalogPath, 0o666);
      expect(captureSource(path, catalogPath).ok).toBe(false);
    },
  );

  it('refuses a replaced enrolled root even if its pathname is unchanged', () => {
    const source = persist(file());
    const root = catalog.roots[0]!.path;
    renameSync(root, `${root}-old`);
    mkdirSync(root);
    expect(captureSource(file(), catalogPath).ok).toBe(false);
    expect(readSourceCaptureBindings(db, source.id, source.hash, catalogPath).ok).toBe(false);
  });

  it('refuses a weakened or revised profile instead of rewriting earlier restrictions', () => {
    const source = persist(file());
    const before = db.serialize();
    catalog.roots[0]!.profileId = 'weaker-profile';
    catalog.revision++;
    save();
    expect(readSourceCaptureBindings(db, source.id, source.hash, catalogPath).ok).toBe(false);
    expect(db.serialize().equals(before)).toBe(true);
  });

  it('refuses malformed or tampered stored capture records', () => {
    const source = persist(file());
    db.prepare("UPDATE source_capture_custody SET bindings_json='[]' WHERE source_id=?").run(
      source.id,
    );
    expect(readSourceCaptureBindings(db, source.id, source.hash, catalogPath).ok).toBe(false);
    expect(registerSource(db, { path: source.path, type: 'text', hash: source.hash }).ok).toBe(
      false,
    );
  });

  it('resolves all deterministic inputs without model attribution, and refuses changed bytes/output', () => {
    const a = persist(file(0, 'First neutral source'), 'raw/first.txt');
    const b = persist(file(1, 'Second neutral source'), 'raw/second.txt');
    expect(
      recordInputCustody(db, 'wiki/combined.md', 'Combined output', [
        { sourceId: a.id, contentHash: a.hash },
        { sourceId: b.id, contentHash: b.hash },
      ]).ok,
    ).toBe(true);
    expect(db.prepare('SELECT * FROM compilation_sources').all()).toEqual([]);
    const result = readBoundInputCustody(
      db,
      'wiki/combined.md',
      'Combined output',
      base,
      catalogPath,
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.flatMap((r) => r.bindings.map((binding) => binding.profileId)).sort(),
    ).toEqual(['profile:alpha', 'profile:beta']);
    expect(
      readBoundInputCustody(db, 'wiki/combined.md', 'Changed output', base, catalogPath).ok,
    ).toBe(false);
    writeFileSync(join(base, b.path), 'Changed source');
    expect(
      readBoundInputCustody(db, 'wiki/combined.md', 'Combined output', base, catalogPath).ok,
    ).toBe(false);
  });
});
