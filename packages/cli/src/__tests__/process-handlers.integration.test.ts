/**
 * Integration tests for the top-level process error / signal handlers
 * installed by `index.ts::installProcessHandlers` (E10-B05).
 *
 * Spawns the built CLI as a child process and provokes each failure
 * mode (unhandled rejection, SIGINT) to verify the operator never sees
 * a Node stack trace and that the exit code follows convention.
 *
 * These tests are skipped on Windows because the SIGINT semantics
 * differ (`tree-kill` / job objects) and the friendly-errors message is
 * the same one our cross-platform-coverage tests already exercise.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = resolve(__dirname, '../../dist/index.js');

let tmpBase: string;
beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'ico-proc-'));
});
afterEach(async () => {
  await cleanupOwnedChildren();
  rmSync(tmpBase, { recursive: true, force: true });
});

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface OwnedChild {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  closed: boolean;
  error?: Error;
  completion: Promise<SpawnResult>;
}

const ownedChildren = new Map<ChildProcessWithoutNullStreams, OwnedChild>();

function spawnOwned(args: string[], env: NodeJS.ProcessEnv = process.env): OwnedChild {
  const child = spawn(process.execPath, args, {
    env: { ...env, NO_COLOR: '1' },
  });
  let complete!: (result: SpawnResult) => void;
  const owned: OwnedChild = {
    child,
    stdout: '',
    stderr: '',
    closed: false,
    completion: new Promise((resolve_) => {
      complete = resolve_;
    }),
  };
  // Register close/error tracking before any test can trigger a signal or exit.
  child.stdout.on('data', (data: Buffer) => {
    owned.stdout += data.toString('utf8');
  });
  child.stderr.on('data', (data: Buffer) => {
    owned.stderr += data.toString('utf8');
  });
  child.once('error', (error) => {
    owned.error = error;
  });
  child.once('close', (code, signal) => {
    owned.closed = true;
    complete({ stdout: owned.stdout, stderr: owned.stderr, code, signal });
  });
  ownedChildren.set(child, owned);
  return owned;
}

async function resultOf(owned: OwnedChild): Promise<SpawnResult> {
  const result = await owned.completion;
  if (owned.error) throw owned.error;
  return result;
}

async function cleanupOwnedChildren(): Promise<void> {
  const outcomes = await Promise.allSettled(
    [...ownedChildren.values()].map(async (owned) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!owned.closed) {
          if (owned.child.exitCode === null && owned.child.signalCode === null) {
            owned.child.kill('SIGKILL');
          }
          // Bound teardown separately; never silently claim an unreaped child is gone.
          await Promise.race([
            owned.completion,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error('owned fixture child did not close during teardown')),
                2000,
              );
            }),
          ]);
        }
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (owned.closed) ownedChildren.delete(owned.child);
      }
    }),
  );
  const errors = outcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome): unknown => outcome.reason);
  if (errors.length > 0) throw new AggregateError(errors, 'failed to reap owned fixture children');
}

function waitForReady(owned: OwnedChild, marker = 'READY', timeoutMs = 5000): Promise<void> {
  return new Promise((resolve_, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      owned.child.stdout.off('data', check);
      owned.child.off('close', onClose);
      owned.child.off('error', onError);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve_();
    };
    const check = () => {
      if (owned.stdout.includes(marker)) finish();
    };
    const onClose = () => finish(new Error(`child closed before ${marker}`));
    const onError = (error: Error) => finish(error);
    owned.child.stdout.on('data', check);
    owned.child.once('close', onClose);
    owned.child.once('error', onError);
    const timeout = setTimeout(() => finish(new Error(`child never wrote ${marker}`)), timeoutMs);
    if (owned.error) onError(owned.error);
    else if (owned.closed) onClose();
    else check();
  });
}

function spawnCli(
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<SpawnResult> {
  return resultOf(spawnOwned([CLI_PATH, ...args], { ...process.env, ...opts.env }));
}

function spawnScript(code: string, args: string[] = []): Promise<SpawnResult> {
  return resultOf(spawnOwned(['--input-type=module', '-e', code, ...args]));
}

// Failure-path fixtures are plain Node scripts, independent of CLI build/startup.
describe('owned process fixture cleanup', () => {
  it('reaps a looping child when readiness times out and removes readiness listeners', async () => {
    const owned = spawnOwned([
      '-e',
      `process.stdout.write('BOOTED\\n'); setInterval(() => {}, 1000);`,
    ]);
    await waitForReady(owned, 'BOOTED');
    const listeners = {
      data: owned.child.stdout.listenerCount('data'),
      close: owned.child.listenerCount('close'),
      error: owned.child.listenerCount('error'),
    };
    try {
      const readiness = waitForReady(owned, 'READY', 30);
      await expect(readiness).rejects.toThrow('child never wrote READY');
      expect(owned.child.stdout.listenerCount('data')).toBe(listeners.data);
      expect(owned.child.listenerCount('close')).toBe(listeners.close);
      expect(owned.child.listenerCount('error')).toBe(listeners.error);
    } finally {
      // Same teardown path as afterEach, including when an assertion above fails.
      await cleanupOwnedChildren();
    }
    expect(owned.closed).toBe(true);
    expect(ownedChildren.size).toBe(0);
    expect((await owned.completion).signal).toBe('SIGKILL');
  });

  it('rejects early close immediately and reaps another owned looping child', async () => {
    const exiting = spawnOwned([
      '-e',
      `process.stdin.once('data', () => process.exit(7)); process.stdout.write('BOOTED\\n');`,
    ]);
    const looping = spawnOwned([
      '-e',
      `process.stdout.write('BOOTED\\n'); setInterval(() => {}, 1000);`,
    ]);
    await Promise.all([waitForReady(exiting, 'BOOTED'), waitForReady(looping, 'BOOTED')]);
    const readiness = waitForReady(exiting, 'READY');
    // completion and readiness close listeners both exist before provoking exit.
    exiting.child.stdin.end('exit');
    try {
      await expect(readiness).rejects.toThrow('child closed before READY');
    } finally {
      await cleanupOwnedChildren();
    }
    expect((await exiting.completion).code).toBe(7);
    expect(exiting.closed).toBe(true);
    expect(looping.closed).toBe(true);
    expect((await looping.completion).signal).toBe('SIGKILL');
    expect(ownedChildren.size).toBe(0);
    expect(exiting.child.listenerCount('close')).toBe(0);
    expect(exiting.child.stdout.listenerCount('data')).toBe(1);
  });
});

describe('top-level process handlers — SIGINT', () => {
  it('SIGINT during a hanging operation produces a friendly message and exits 130', async () => {
    // Child writes "READY" to stdout after installing handlers, then loops.
    // We wait for READY before sending SIGINT so the test isn't racy on
    // slow CI runners.
    const code = `
      import('${CLI_PATH}').then(({ installProcessHandlers }) => {
        installProcessHandlers();
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1000);
      });
    `;
    const owned = spawnOwned(['--input-type=module', '-e', code]);
    await waitForReady(owned);
    const completion = resultOf(owned);
    owned.child.kill('SIGINT');
    const result = await completion;

    expect(result.stderr).toMatch(/interrupted \(SIGINT\)/);
    expect(result.code).toBe(130);
  });
});

describe('top-level process handlers — unhandled rejection', () => {
  it('an unhandled rejection produces a [ico] prefix and exits 1', async () => {
    const code = `
      import('${CLI_PATH}').then(({ installProcessHandlers }) => {
        installProcessHandlers();
        // Defer the rejection so the handler is in place.
        setImmediate(() => {
          Promise.reject(new Error('synthetic rejection for testing'));
        });
      });
    `;
    await spawnCli([], {});
    const result = await spawnScript(code);

    expect(result.stderr).toMatch(/\[ico\] unhandled rejection/);
    expect(result.stderr).toContain('synthetic rejection for testing');
    expect(result.code).toBe(1);
  });

  it('maps a Claude API rate_limit_error through friendlyError', async () => {
    const code = `
      import('${CLI_PATH}').then(({ installProcessHandlers }) => {
        installProcessHandlers();
        setImmediate(() => {
          Promise.reject(new Error('Claude API rate_limit_error (HTTP 429): too many'));
        });
      });
    `;
    const result = await spawnScript(code);

    expect(result.stderr).toMatch(/rate limit/i);
    expect(result.code).toBe(1);
  });
});

describe('top-level process handlers — stack traces', () => {
  it('emits a stack trace for unknown errors (friendlyError fall-through)', async () => {
    const code = `
      import('${CLI_PATH}').then(({ installProcessHandlers }) => {
        installProcessHandlers();
        setImmediate(() => {
          Promise.reject(new Error('UNIQUE_UNKNOWN_ERROR_MARKER_ZXY'));
        });
      });
    `;
    const result = await spawnScript(code);
    // Friendly message present.
    expect(result.stderr).toContain('UNIQUE_UNKNOWN_ERROR_MARKER_ZXY');
    // Stack trace present (friendlyError didn't recognize it → fell through to verbatim).
    expect(result.stderr).toMatch(/at\s+/);
    expect(result.code).toBe(1);
  });

  it('suppresses the stack trace for known errors by default (no --verbose)', async () => {
    const code = `
      import('${CLI_PATH}').then(({ installProcessHandlers }) => {
        installProcessHandlers();
        setImmediate(() => {
          Promise.reject(new Error('Claude API rate_limit_error (HTTP 429): too many'));
        });
      });
    `;
    const result = await spawnScript(code);
    expect(result.stderr).toMatch(/rate limit/i);
    // No stack frames — known category mapped to a clean hint.
    expect(result.stderr).not.toMatch(/^\s+at\s+/m);
    expect(result.code).toBe(1);
  });

  it('emits the stack trace for known errors when --verbose is set', async () => {
    const code = `
      import('${CLI_PATH}').then(({ installProcessHandlers }) => {
        installProcessHandlers();
        setImmediate(() => {
          Promise.reject(new Error('Claude API rate_limit_error (HTTP 429): too many'));
        });
      });
    `;
    // Forward --verbose after -- so Node leaves it in the script argv.
    const result = await spawnScript(code, ['--', '--verbose']);
    expect(result.stderr).toMatch(/rate limit/i);
    // Stack frames in `node -e` scripts are reported as `[stdin]:line:col`
    // not `*.js:line:col`. Match the `at ` marker instead.
    expect(result.stderr).toMatch(/^\s+at\s+/m);
    expect(result.code).toBe(1);
  });
});
