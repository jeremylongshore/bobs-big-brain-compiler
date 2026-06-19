/**
 * Command-level tests for `ico unpromote <path>` — drives the registered
 * Commander action's failure branches (the action sets `process.exitCode = 1`
 * rather than throwing), which the direct `runUnpromote` unit tests don't reach.
 *
 * Part of bead `intentional-cognition-os-0wy.7` (CLI coverage climb).
 *
 * @module commands/unpromote.command.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { closeDatabase, initDatabase, initWorkspace } from '@ico/kernel';

import { register } from './unpromote.js';

let base: string;
let wsRoot: string;
let errSpy: MockInstance;
let stderr: string;
let origExitCode: typeof process.exitCode;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ico-unpromote-cmd-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  wsRoot = ws.value.root;
  const db = initDatabase(ws.value.dbPath);
  if (!db.ok) throw db.error;
  closeDatabase(db.value);

  origExitCode = process.exitCode;
  stderr = '';
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr += String(c);
    return true;
  });
});
afterEach(() => {
  errSpy.mockRestore();
  process.exitCode = origExitCode; // never leak a failing exit code to vitest
  rmSync(base, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function runUnpromote(args: string[]): Promise<number | undefined> {
  process.exitCode = 0;
  const program = new Command();
  program
    .name('ico')
    .option('--workspace <path>', 'Workspace directory')
    .option('--json', 'JSON output')
    .exitOverride();
  register(program);
  await program.parseAsync(['node', 'ico', '--workspace', wsRoot, 'unpromote', ...args]);
  return process.exitCode;
}

describe('ico unpromote — command action', () => {
  it('a non-existent target reports an error and sets exit code 1', async () => {
    const code = await runUnpromote(['wiki/topics/ghost.md']);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('--yes on a non-existent target still fails with exit code 1', async () => {
    const code = await runUnpromote(['wiki/topics/ghost.md', '--yes']);
    expect(code).toBe(1);
  });

  it('--dry-run on a non-existent target fails with exit code 1', async () => {
    const code = await runUnpromote(['wiki/topics/ghost.md', '--dry-run']);
    expect(code).toBe(1);
  });
});
