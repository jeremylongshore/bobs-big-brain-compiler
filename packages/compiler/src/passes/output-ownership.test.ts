import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, type Database, initDatabase } from '@ico/kernel';

import { assertWikiOutputOwnership } from './output-ownership.js';

const io = vi.hoisted(() => ({
  afterOpen: undefined as (() => void) | undefined,
  beforeRead: undefined as (() => void) | undefined,
  opened: [] as number[],
  closed: [] as number[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      io.opened.push(fd);
      const hook = io.afterOpen;
      io.afterOpen = undefined;
      hook?.();
      return fd;
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (typeof args[0] === 'number') {
        const hook = io.beforeRead;
        io.beforeRead = undefined;
        hook?.();
      }
      return actual.readFileSync(...args);
    },
    closeSync: (fd: number) => {
      io.closed.push(fd);
      return actual.closeSync(fd);
    },
  };
});

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

describe('wiki output ownership before staging', () => {
  let root: string;
  let db: Database;
  let target: string;
  const path = 'wiki/concepts/owned.md';
  const header = (id = ID) => `---\ntype: concept\nid: ${id}\n---\n\nPreserved body.\n`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ico-output-owner-'));
    const result = initDatabase(join(root, 'fixture.db'));
    if (!result.ok) throw result.error;
    db = result.value;
    mkdirSync(join(root, 'wiki/concepts'), { recursive: true });
    target = join(root, path);
  });

  afterEach(() => {
    io.afterOpen = undefined;
    io.beforeRead = undefined;
    io.opened = [];
    io.closed = [];
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  function record(id: string, kind = 'concept', sourceId: string | null = null) {
    db.prepare(
      `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model)
      VALUES (?, ?, ?, ?, ?, 0, 'fixture-model')`,
    ).run(id, sourceId, kind, path, '2026-10-25T00:00:00.000Z');
  }

  it('allows an unclaimed absent target without creating it or modifying the database', () => {
    const before = db.serialize();
    assertWikiOutputOwnership(db, path, target, 'concept', ID);
    expect(existsSync(target)).toBe(false);
    expect(db.serialize()).toEqual(before);
  });

  it('allows its own existing header and compilation owner without rewriting body edits', () => {
    writeFileSync(target, header());
    record(ID);
    const before = db.serialize();
    assertWikiOutputOwnership(db, path, target, 'concept', ID);
    expect(readFileSync(target, 'utf8')).toBe(header());
    expect(db.serialize()).toEqual(before);
  });

  it('refuses a conflicting database owner even when the target is missing', () => {
    record(OTHER);
    expect(() => assertWikiOutputOwnership(db, path, target, 'concept', ID)).toThrow(
      'compilation owner',
    );
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a derived ID already owned by a different kind at another path', () => {
    record(ID);
    writeFileSync(target, header());
    const before = db.serialize();
    const otherPath = 'wiki/entities/other.md';
    const otherTarget = join(root, otherPath);
    expect(() => assertWikiOutputOwnership(db, otherPath, otherTarget, 'entity', ID)).toThrow(
      'compilation identity',
    );
    expect(db.serialize()).toEqual(before);
    expect(readFileSync(target, 'utf8')).toBe(header());
    expect(existsSync(otherTarget)).toBe(false);
    expect(existsSync(otherTarget + '.tmp')).toBe(false);
  });

  it('refuses a conflicting file identity despite a matching database owner', () => {
    record(ID);
    writeFileSync(target, header(OTHER));
    expect(() => assertWikiOutputOwnership(db, path, target, 'concept', ID)).toThrow(
      'header owner',
    );
    expect(readFileSync(target, 'utf8')).toBe(header(OTHER));
  });

  it('does not authorize ownership from a body line or ambiguous duplicate fields', () => {
    const bodySpoof = `---\ntype: concept\n---\n\nid: ${ID}\nBody sentinel.\n`;
    writeFileSync(target, bodySpoof);
    expect(() => assertWikiOutputOwnership(db, path, target, 'concept', ID)).toThrow(
      'header owner',
    );
    expect(readFileSync(target, 'utf8')).toBe(bodySpoof);
    const duplicate = header().replace(`id: ${ID}`, `id: ${ID}\nid: ${OTHER}`);
    writeFileSync(target, duplicate);
    expect(() => assertWikiOutputOwnership(db, path, target, 'concept', ID)).toThrow(
      'header owner',
    );
    expect(readFileSync(target, 'utf8')).toBe(duplicate);
  });

  it('uses logical source identity for summary reruns rather than per-run compilation IDs', () => {
    db.prepare(
      `INSERT INTO sources (id, path, type, ingested_at, hash)
      VALUES (?, 'raw/source.md', 'markdown', '2026-10-25T00:00:00.000Z', ?)`,
    ).run(ID, 'a'.repeat(64));
    record(OTHER, 'summary', ID);
    writeFileSync(
      target,
      `---\ntype: source-summary\nsource_id: ${ID}\n---\n\nExisting summary.\n`,
    );
    expect(() => assertWikiOutputOwnership(db, path, target, 'summary', ID)).not.toThrow();
    expect(() => assertWikiOutputOwnership(db, path, target, 'summary', OTHER)).toThrow(
      'compilation owner',
    );
  });

  it('refuses a leaf swapped to a symlink after opening its original descriptor', () => {
    writeFileSync(target, header());
    const outside = join(root, 'outside-race.md');
    writeFileSync(outside, header());
    io.afterOpen = () => {
      renameSync(target, target + '.preserved');
      symlinkSync(outside, target);
    };
    expect(() => assertWikiOutputOwnership(db, path, target, 'concept', ID)).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe(header());
    expect(readFileSync(target + '.preserved', 'utf8')).toBe(header());
    expect(io.closed).toEqual(io.opened);
  });

  it('refuses a replaced regular leaf and closes its descriptor after open and before reading', () => {
    writeFileSync(target, header());
    io.afterOpen = () => {
      renameSync(target, target + '.preserved');
      writeFileSync(target, header());
    };
    expect(() => assertWikiOutputOwnership(db, path, target, 'concept', ID)).toThrow('changed');
    expect(io.opened).toHaveLength(1);
    expect(io.closed).toEqual(io.opened);
  });

  it('closes the descriptor on a read failure and leaves the original bytes unchanged', () => {
    writeFileSync(target, header());
    io.beforeRead = () => {
      throw new Error('Injected read failure');
    };
    expect(() => assertWikiOutputOwnership(db, path, target, 'concept', ID)).toThrow(
      'Injected read failure',
    );
    expect(io.opened).toHaveLength(1);
    expect(io.closed).toEqual(io.opened);
    expect(readFileSync(target, 'utf8')).toBe(header());
  });

  it('closes the descriptor after successful identity verification', () => {
    writeFileSync(target, header());
    assertWikiOutputOwnership(db, path, target, 'concept', ID);
    expect(io.opened).toHaveLength(1);
    expect(io.closed).toEqual(io.opened);
  });

  it('refuses nonregular targets without following or modifying an outside file', () => {
    const outside = join(root, 'outside.md');
    writeFileSync(outside, header());
    symlinkSync(outside, target);
    expect(() => assertWikiOutputOwnership(db, path, target, 'concept', ID)).toThrow('nonregular');
    expect(readFileSync(outside, 'utf8')).toBe(header());
  });
});
