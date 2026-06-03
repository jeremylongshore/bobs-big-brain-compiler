/**
 * Command-level tests for `ico ingest <path>` — drives the registered
 * Commander action over a real temp workspace, covering the single-file +
 * batch (directory) paths, `showPreview`, and the non-TTY confirmation guards
 * that the direct `runIngest` unit tests in `ingest.test.ts` don't reach.
 *
 * Part of bead `intentional-cognition-os-0wy.7` (CLI coverage climb).
 *
 * @module commands/ingest.command.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { closeDatabase, initDatabase, initWorkspace } from '@ico/kernel';

import { register } from './ingest.js';

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

let tempBase: string;
let wsRoot: string;
let exitSpy: MockInstance;

beforeEach(() => {
  tempBase = mkdtempSync(join(tmpdir(), 'ico-ingest-cmd-'));
  const ws = initWorkspace('ws', tempBase);
  if (!ws.ok) throw ws.error;
  wsRoot = ws.value.root;
  const db = initDatabase(ws.value.dbPath);
  if (!db.ok) throw db.error;
  closeDatabase(db.value); // the command opens its own connection

  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  rmSync(tempBase, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function runIngestCmd(args: string[]): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;

  const writeOut = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  const writeErr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });

  const program = new Command();
  program
    .name('ico')
    .option('--workspace <path>', 'Workspace directory')
    .option('--json', 'JSON output')
    .option('--verbose', 'Verbose')
    .exitOverride();
  register(program);

  try {
    await program.parseAsync(['node', 'ico', '--workspace', wsRoot, 'ingest', ...args]);
  } catch (e) {
    if (e instanceof ExitError) exitCode = e.code;
    else if (e && typeof e === 'object' && 'exitCode' in e)
      exitCode = (e as { exitCode: number }).exitCode;
    else throw e;
  } finally {
    writeOut.mockRestore();
    writeErr.mockRestore();
  }
  return { stdout, stderr, exitCode };
}

/** Write a markdown file under tempBase and return its absolute path. */
function srcFile(name: string, content = '# Title\n\nbody text here\n'): string {
  const p = join(tempBase, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

// ---------------------------------------------------------------------------
// Single-file mode
// ---------------------------------------------------------------------------

describe('ico ingest — single file', () => {
  it('--yes ingests a markdown file', async () => {
    const f = srcFile('notes.md');
    const r = await runIngestCmd([f, '--yes']);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toMatch(/Ingested|Registered|notes\.md/i);
  });

  it('without --yes on non-TTY shows a preview then refuses (exit 1)', async () => {
    const f = srcFile('paper.md');
    const r = await runIngestCmd([f]);
    expect(r.exitCode).toBe(1);
    // showPreview ran...
    expect(r.stdout).toContain('Source:');
    // ...then the non-TTY guard fired
    expect(r.stderr).toContain('Non-TTY input detected');
  });

  it('without --yes, a missing file is reported (exit 1)', async () => {
    const r = await runIngestCmd([join(tempBase, 'nope.md')]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('File not found');
  });

  it('--yes on a missing file fails (exit 1)', async () => {
    const r = await runIngestCmd([join(tempBase, 'ghost.md'), '--yes']);
    expect(r.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Batch (directory) mode
// ---------------------------------------------------------------------------

describe('ico ingest — directory (batch)', () => {
  it('--yes ingests every supported file and prints a summary', async () => {
    const dir = join(tempBase, 'corpus');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), '# A\n\nalpha\n', 'utf-8');
    writeFileSync(join(dir, 'b.md'), '# B\n\nbeta\n', 'utf-8');

    const r = await runIngestCmd([dir, '--yes']);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('Found 2 supported file(s)');
    expect(r.stdout).toMatch(/Ingested 2 of 2 files/);
  });

  it('an empty directory reports no supported files', async () => {
    const dir = join(tempBase, 'empty');
    mkdirSync(dir, { recursive: true });
    const r = await runIngestCmd([dir, '--yes']);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('No supported files found');
  });

  it('a directory without --yes on non-TTY refuses (exit 1)', async () => {
    const dir = join(tempBase, 'corpus2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), '# A\n\nalpha\n', 'utf-8');
    const r = await runIngestCmd([dir]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Non-TTY input detected');
  });
});
