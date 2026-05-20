/**
 * Tests for the `ico mount` command (add / list / remove subcommands).
 *
 * Strategy: call the kernel functions via `initWorkspace` + `initDatabase` to
 * create a real on-disk workspace in a temp directory, then invoke the CLI
 * command through a fresh Commander program per invocation (so option state
 * never bleeds between runs).
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initDatabase, initWorkspace } from '@ico/kernel';

import { register } from './mount.js';

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Parse `ico mount <args>` in isolation.
 *
 * A new Commander program is created for each call so that option state from
 * previous parses cannot bleed across tests. The workspace global option is
 * pre-set to `workspacePath` before parsing.
 *
 * All console output is captured and returned; `process.exit` is intercepted
 * so tests do not actually exit the process.
 */
function runMount(workspacePath: string, args: string[], jsonMode = false): RunResult {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;

  const program = new Command();
  program
    .name('ico')
    .option('--workspace <path>', 'Workspace directory')
    .option('--verbose', 'Show debug output')
    .option('--quiet', 'Suppress non-essential output')
    .option('--json', 'Output as JSON')
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        stdout += str;
      },
      writeErr: (str) => {
        stderr += str;
      },
    });

  // Pre-set global options before parsing so action handlers see them.
  program.setOptionValue('workspace', workspacePath);
  if (jsonMode) {
    program.setOptionValue('json', true);
  }

  register(program);

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...msgs: unknown[]) => {
    stdout += msgs.join(' ') + '\n';
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...msgs: unknown[]) => {
    stderr += msgs.join(' ') + '\n';
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    exitCode = typeof code === 'number' ? code : 1;
    throw new Error(`process.exit(${exitCode})`);
  });

  try {
    program.parse(['node', 'ico', 'mount', ...args]);
  } catch (e) {
    // Swallow intentional exits; re-throw genuine test errors.
    if (e instanceof Error && !e.message.startsWith('process.exit')) {
      throw e;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ico mount command', () => {
  let tempBase: string;
  let workspaceRoot: string;
  let corpusDir: string;

  beforeEach(() => {
    // Fresh temp directory for each test.
    tempBase = mkdtempSync(join(tmpdir(), 'ico-cli-mount-'));

    // Initialize a real ICO workspace.
    const wsResult = initWorkspace('ws', tempBase);
    if (!wsResult.ok) throw new Error(`initWorkspace failed: ${wsResult.error.message}`);
    workspaceRoot = wsResult.value.root;

    // Fully migrate the database so it is ready before any command runs.
    const dbResult = initDatabase(wsResult.value.dbPath);
    if (!dbResult.ok) throw new Error(`initDatabase failed: ${dbResult.error.message}`);
    dbResult.value.close();

    // A real directory to use as the corpus mount path.
    corpusDir = join(tempBase, 'corpus');
    mkdirSync(corpusDir);
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // mount add
  // -------------------------------------------------------------------------

  it('mount add registers a mount and outputs success', () => {
    const result = runMount(workspaceRoot, ['add', 'my-corpus', corpusDir]);

    expect(result.exitCode).toBeNull();
    expect(result.stdout).toContain('my-corpus');
    expect(result.stdout).toContain(corpusDir);
    // formatSuccess uses a checkmark
    expect(result.stdout).toMatch(/✓/);
  });

  it('mount add with nonexistent path shows error and exits 1', () => {
    const badPath = join(tempBase, 'does-not-exist');

    const result = runMount(workspaceRoot, ['add', 'bad', badPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/path does not exist/i);
  });

  it('mount add with duplicate name shows error and exits 1', () => {
    // First registration — must succeed.
    const first = runMount(workspaceRoot, ['add', 'dup', corpusDir]);
    expect(first.exitCode).toBeNull();

    // Second registration with the same name — must fail.
    const second = runMount(workspaceRoot, ['add', 'dup', corpusDir]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(/already registered/i);
  });

  // -------------------------------------------------------------------------
  // mount list
  // -------------------------------------------------------------------------

  it('mount list shows registered mounts in table format', () => {
    // Register a mount first.
    const addResult = runMount(workspaceRoot, ['add', 'list-test', corpusDir]);
    expect(addResult.exitCode).toBeNull();

    const result = runMount(workspaceRoot, ['list']);

    expect(result.exitCode).toBeNull();
    // Table headers
    expect(result.stdout).toContain('Name');
    expect(result.stdout).toContain('Path');
    expect(result.stdout).toContain('Created');
    // The registered mount's name and resolved path
    expect(result.stdout).toContain('list-test');
    expect(result.stdout).toContain(resolve(corpusDir));
  });

  it('mount list with --json outputs a JSON array', () => {
    // Register a mount first.
    const addResult = runMount(workspaceRoot, ['add', 'json-test', corpusDir]);
    expect(addResult.exitCode).toBeNull();

    const result = runMount(workspaceRoot, ['list'], /* jsonMode */ true);

    expect(result.exitCode).toBeNull();
    const parsed = JSON.parse(result.stdout.trim()) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    const entry = parsed[0] as Record<string, unknown>;
    expect(entry['name']).toBe('json-test');
    expect(entry['path']).toBe(resolve(corpusDir));
  });

  it('mount list shows info message when no mounts are registered', () => {
    const result = runMount(workspaceRoot, ['list']);

    expect(result.exitCode).toBeNull();
    expect(result.stdout).toMatch(/no mounts/i);
  });

  // -------------------------------------------------------------------------
  // mount remove
  // -------------------------------------------------------------------------

  it('mount remove removes a registered mount and outputs success', () => {
    // Register then remove.
    const addResult = runMount(workspaceRoot, ['add', 'to-remove', corpusDir]);
    expect(addResult.exitCode).toBeNull();

    const result = runMount(workspaceRoot, ['remove', 'to-remove']);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toMatch(/removed|to-remove/i);

    // Confirm it is gone from list.
    const listResult = runMount(workspaceRoot, ['list']);
    expect(listResult.stdout).not.toContain('to-remove');
  });

  it('mount remove with unknown name shows error and exits 1', () => {
    const result = runMount(workspaceRoot, ['remove', 'ghost']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no mount found|ghost/i);
  });
});
