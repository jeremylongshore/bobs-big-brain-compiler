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

import { spawn } from 'node:child_process';
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
afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function spawnCli(args: string[], opts: { env?: Record<string, string> } = {}): Promise<SpawnResult> {
  return new Promise((resolve_) => {
    const child = spawn('node', [CLI_PATH, ...args], {
      env: { ...process.env, ...opts.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
    child.on('close', (code, signal) => {
      resolve_({ stdout, stderr, code, signal });
    });
  });
}

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
    const child = spawn('node', ['--input-type=module', '-e', code], {
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));

    // Wait until the child writes READY before sending the signal.
    await new Promise<void>((resolve_, reject) => {
      const timeout = setTimeout(() => reject(new Error('child never wrote READY')), 5000);
      const check = setInterval(() => {
        if (stdout.includes('READY')) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve_();
        }
      }, 25);
    });

    child.kill('SIGINT');

    const result = await new Promise<SpawnResult>((r) => {
      child.on('close', (code_, signal) => r({ stdout, stderr, code: code_, signal }));
    });

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
    const result = await spawnCli([], {}).then(() =>
      new Promise<SpawnResult>((r) => {
        const child = spawn('node', ['--input-type=module', '-e', code], {
          env: { ...process.env, NO_COLOR: '1' },
        });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
        child.on('close', (c, s) => r({ stdout: '', stderr, code: c, signal: s }));
      }),
    );

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
    const result = await new Promise<SpawnResult>((r) => {
      const child = spawn('node', ['--input-type=module', '-e', code], {
        env: { ...process.env, NO_COLOR: '1' },
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      child.on('close', (c, s) => r({ stdout: '', stderr, code: c, signal: s }));
    });

    expect(result.stderr).toMatch(/rate limit/i);
    expect(result.code).toBe(1);
  });
});
