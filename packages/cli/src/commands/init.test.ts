/**
 * Tests for the `ico init` command logic.
 *
 * All tests exercise `runInit` directly — no process spawning needed.
 * Filesystem operations are performed against real temporary directories
 * so we validate actual side-effects (directories, database file, etc.).
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type GlobalOptions, type InitOptions, runInit } from './init.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpBase(): string {
  return join(tmpdir(), `ico-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe('runInit', () => {
  let basePath: string;
  const name = 'my-kb';

  const opts = (): InitOptions => ({ path: basePath });
  const global = (): GlobalOptions => ({ json: false });

  beforeEach(() => {
    basePath = tmpBase();
    // Suppress stdout/stderr during tests
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(basePath, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns ok on success', () => {
    const result = runInit(name, opts(), global());
    expect(result.ok).toBe(true);
  });

  it('returns the correct workspace name and absolute paths', () => {
    const result = runInit(name, opts(), global());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { value } = result;
    expect(value.name).toBe(name);
    expect(value.root).toBe(resolve(basePath, name));
    expect(value.root.startsWith('/')).toBe(true);
    expect(value.dbPath).toBe(resolve(basePath, name, '.ico', 'state.db'));
    expect(value.dbPath.startsWith('/')).toBe(true);
  });

  it('creates the workspace directory tree', () => {
    const result = runInit(name, opts(), global());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const root = result.value.root;

    // Spot-check a representative set of subdirectories
    const spotCheck = [
      'raw/articles',
      'wiki/concepts',
      'tasks',
      'outputs/reports',
      'recall/cards',
      'audit/traces',
      '.ico',
    ];

    for (const dir of spotCheck) {
      expect(existsSync(resolve(root, dir)), `expected dir to exist: ${dir}`).toBe(true);
    }
  });

  it('creates the SQLite database file', () => {
    const result = runInit(name, opts(), global());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(result.value.dbPath)).toBe(true);
  });

  it('createdAt is a valid ISO 8601 timestamp', () => {
    const result = runInit(name, opts(), global());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { createdAt } = result.value;
    expect(() => new Date(createdAt).toISOString()).not.toThrow();
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('is idempotent — running twice on the same path succeeds both times', () => {
    const first = runInit(name, opts(), global());
    expect(first.ok).toBe(true);

    const second = runInit(name, opts(), global());
    expect(second.ok).toBe(true);

    if (!first.ok || !second.ok) return;
    // Both runs must point at the same workspace root
    expect(second.value.root).toBe(first.value.root);
    expect(second.value.dbPath).toBe(first.value.dbPath);
    // Database file must still exist after the second run
    expect(existsSync(second.value.dbPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // JSON output mode
  // -------------------------------------------------------------------------

  it('writes JSON to stdout when global.json is true', () => {
    const stdoutMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = runInit(name, opts(), { json: true });

    expect(result.ok).toBe(true);

    // Collect all stdout writes and join them
    const written = stdoutMock.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(written) as Record<string, unknown>;

    expect(parsed['name']).toBe(name);
    expect(typeof parsed['root']).toBe('string');
    expect(typeof parsed['dbPath']).toBe('string');
    expect(typeof parsed['createdAt']).toBe('string');
  });

  it('writes human output to stdout when global.json is false', () => {
    const stdoutMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = runInit(name, opts(), { json: false });

    expect(result.ok).toBe(true);

    const written = stdoutMock.mock.calls.map((c) => c[0]).join('');
    // Human output includes the workspace name and path
    expect(written).toContain(name);
    expect(written).toContain(resolve(basePath, name));
  });

  // -------------------------------------------------------------------------
  // Error path
  // -------------------------------------------------------------------------

  it('returns err when the parent path is not writable', () => {
    // Pass a path that cannot be created (deep inside a non-existent root
    // that we make unwritable via a null-byte in the path — actually just
    // pass a file as the basePath after creating it).
    //
    // Simplest reliable approach: use a path that contains an invalid
    // component on Linux (\0 byte triggers ENOENT / EINVAL from the kernel).
    const badPath = join(basePath, '\0invalid');
    const result = runInit(name, { path: badPath }, global());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(Error);
  });
});
