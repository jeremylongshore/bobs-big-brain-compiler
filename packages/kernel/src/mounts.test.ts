import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMount, getMountByName, listMounts, registerMount, removeMount } from './mounts.js';
import { closeDatabase, initDatabase } from './state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Opens an in-memory database and asserts it succeeded. */
function openDb(): Database {
  const result = initDatabase(':memory:');
  if (!result.ok) throw new Error(`Failed to open test DB: ${result.error.message}`);
  return result.value;
}

/** Creates a real temporary directory on disk (required by registerMount). */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ico-mount-test-'));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mount registry', () => {
  let db: Database;
  let tempDir: string;

  beforeEach(() => {
    db = openDb();
    tempDir = makeTempDir();
  });

  afterEach(() => {
    closeDatabase(db);
    // Best-effort cleanup of the temp directory.
    try {
      rmdirSync(tempDir);
    } catch {
      /* ignore */
    }
  });

  // -------------------------------------------------------------------------
  // registerMount
  // -------------------------------------------------------------------------

  it('registers a mount and returns the correct record', () => {
    const result = registerMount(db, 'my-corpus', tempDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mount = result.value;
    expect(mount.name).toBe('my-corpus');
    expect(mount.path).toBe(tempDir);
    expect(mount.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(mount.created_at).toBeTruthy();
    expect(mount.last_indexed_at).toBeNull();
  });

  it('returns an error when the path does not exist', () => {
    const result = registerMount(db, 'bad-path', '/nonexistent/path/that/does/not/exist');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/path does not exist/i);
  });

  it('returns an error when the name is a duplicate', () => {
    const first = registerMount(db, 'dup', tempDir);
    expect(first.ok).toBe(true);

    const second = registerMount(db, 'dup', tempDir);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.message).toMatch(/already registered/i);
  });

  // -------------------------------------------------------------------------
  // listMounts
  // -------------------------------------------------------------------------

  it('lists all registered mounts', () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();

    try {
      registerMount(db, 'alpha', dirA);
      registerMount(db, 'beta', dirB);

      const result = listMounts(db);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const names = result.value.map((m) => m.name);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(result.value.length).toBe(2);
    } finally {
      try {
        rmdirSync(dirA);
      } catch {
        /* ignore */
      }
      try {
        rmdirSync(dirB);
      } catch {
        /* ignore */
      }
    }
  });

  it('returns an empty array when no mounts are registered', () => {
    const result = listMounts(db);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // getMount
  // -------------------------------------------------------------------------

  it('retrieves a mount by id', () => {
    const reg = registerMount(db, 'find-me', tempDir);
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;

    const result = getMount(db, reg.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toBeNull();
    expect(result.value?.id).toBe(reg.value.id);
    expect(result.value?.name).toBe('find-me');
  });

  it('returns null (not an error) for a nonexistent id', () => {
    const result = getMount(db, '00000000-0000-4000-8000-000000000000');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  // -------------------------------------------------------------------------
  // getMountByName
  // -------------------------------------------------------------------------

  it('retrieves a mount by name', () => {
    registerMount(db, 'named-mount', tempDir);

    const result = getMountByName(db, 'named-mount');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toBeNull();
    expect(result.value?.name).toBe('named-mount');
    expect(result.value?.path).toBe(tempDir);
  });

  it('returns null for an unknown name', () => {
    const result = getMountByName(db, 'ghost');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  // -------------------------------------------------------------------------
  // removeMount
  // -------------------------------------------------------------------------

  it('removes a mount and returns true', () => {
    const reg = registerMount(db, 'to-remove', tempDir);
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;

    const remove = removeMount(db, reg.value.id);
    expect(remove.ok).toBe(true);
    if (!remove.ok) return;
    expect(remove.value).toBe(true);

    // Confirm it is no longer in the list.
    const list = listMounts(db);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.find((m) => m.id === reg.value.id)).toBeUndefined();
  });

  it('returns false when removing a nonexistent id', () => {
    const result = removeMount(db, '00000000-0000-4000-8000-000000000000');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });
});
