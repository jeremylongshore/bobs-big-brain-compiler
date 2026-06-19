/**
 * Command-level tests for `ico init <name>` — drives the registered Commander
 * action (success + the failure → exit 1 branch) that the direct `runInit`
 * unit tests in `init.test.ts` don't reach.
 *
 * Part of bead `intentional-cognition-os-0wy.7` (CLI coverage climb).
 *
 * @module commands/init.command.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { register } from './init.js';

let base: string;
let exitSpy: MockInstance;

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ico-init-cmd-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
});
afterEach(() => {
  exitSpy.mockRestore();
  rmSync(base, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function runInitCmd(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout += String(c);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr += String(c);
    return true;
  });

  const program = new Command();
  program.name('ico').option('--json', 'JSON output').exitOverride();
  register(program);
  try {
    await program.parseAsync(['node', 'ico', 'init', ...args]);
  } catch (e) {
    if (e instanceof ExitError) exitCode = e.code;
    else if (e && typeof e === 'object' && 'exitCode' in e)
      exitCode = (e as { exitCode: number }).exitCode;
    else throw e;
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout, stderr, exitCode };
}

describe('ico init — command action', () => {
  it('initializes a workspace at --path and reports success', async () => {
    const r = await runInitCmd(['demo', '--path', base]);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toMatch(/demo|workspace|initial/i);
  });

  it('exits 1 when the workspace cannot be created (parent path is a file)', async () => {
    // Use a regular FILE where a directory is required → mkdir fails fast with
    // ENOTDIR. Do NOT use a /proc-style path: procfs has special kernel semantics
    // that make mkdirSync block indefinitely instead of erroring (the original
    // `/proc/...` path hung this test for the full CI timeout).
    const filePath = join(base, 'not-a-directory');
    writeFileSync(filePath, 'x');
    const r = await runInitCmd(['demo', '--path', join(filePath, 'sub')]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
