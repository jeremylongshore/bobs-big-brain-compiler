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
  it('without --yes, requires confirmation (warns on stdout, not stderr) and exits 1', async () => {
    // The no-flags path hits the confirmation gate *before* any existence check:
    // it prints a prompt to stdout and returns "Confirmation required", which the
    // action intentionally does NOT echo to stderr (it's a prompt, not an error).
    let stdout = '';
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdout += String(c);
      return true;
    });
    const code = await runUnpromote(['wiki/topics/ghost.md']);
    outSpy.mockRestore();
    expect(code).toBe(1);
    expect(stdout).toMatch(/--yes|confirm/i); // confirmation prompt on stdout
    expect(stderr).toBe(''); // confirmation is not an error → nothing on stderr
  });

  it('--yes on a non-existent target reports the error to stderr and exits 1', async () => {
    const code = await runUnpromote(['wiki/topics/ghost.md', '--yes']);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0); // the real "not found" error lands on stderr
  });

  it('--dry-run on a non-existent target fails with exit code 1', async () => {
    const code = await runUnpromote(['wiki/topics/ghost.md', '--dry-run']);
    expect(code).toBe(1);
  });
});
