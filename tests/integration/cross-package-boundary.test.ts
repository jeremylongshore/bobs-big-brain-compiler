/**
 * Cross-package boundary integration test.
 *
 * Exercises the types → kernel layering with a real SQLite workspace and
 * verifies that artifacts flow across package boundaries without leaking
 * implementation details upward.
 *
 * Imports go through package source paths rather than workspace names — this
 * file runs against source via the root `vitest.config.ts`, so resolving the
 * built `dist/` is not required (and would be wrong: the contract being tested
 * is the source surface, not the bundler output).
 *
 * This is the canonical L4-integration starter test — additional cross-package
 * flows belong in this directory.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initWorkspace } from '../../packages/kernel/src/workspace.js';

describe('cross-package boundary — types ↔ kernel', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ico-integ-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('initWorkspace returns a Result<WorkspaceInfo, Error> with the expected envelope', () => {
    const result = initWorkspace('integration-test', tmpRoot);

    // Result envelope from @ico/types — verifies the type contract surfaces
    // through @ico/kernel without leaking implementation specifics.
    expect(result).toHaveProperty('ok');

    if (!result.ok) {
      throw new Error(`initWorkspace returned err: ${JSON.stringify(result.error)}`);
    }

    const info = result.value;
    expect(info.name).toBe('integration-test');
    expect(typeof info.root).toBe('string');
    expect(typeof info.dbPath).toBe('string');
    expect(typeof info.createdAt).toBe('string');
    expect(info.root.startsWith(tmpRoot)).toBe(true);
  });
});
