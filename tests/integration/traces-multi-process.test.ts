/**
 * Multi-process trace-write race test (bead intentional-cognition-os-lhm).
 *
 * Spawns N concurrent Node child processes, each opening its own
 * better-sqlite3 connection to the same DB and writing M trace events via
 * `writeTrace`. Asserts that `verifyAuditChain` returns no breaks
 * afterward — i.e., the SHA-256 audit chain remained intact across the
 * concurrent appends.
 *
 * Pre-fix behavior (before the .exclusive() transaction wrap in traces.ts):
 *   readLastLine → compute prev_hash → appendFileSync had a TOCTOU window
 *   where two concurrent writers would both compute the same prev_hash off
 *   the same last line, breaking the chain.
 *
 * Post-fix:
 *   The read-compute-append-INSERT sequence runs inside `db.transaction(...)
 *   .exclusive()`, holding SQLite's cross-process EXCLUSIVE lock for the
 *   full critical section. Other writers block until commit.
 *
 * Pre-requisite: the kernel package must be built. Workers import from
 * `packages/kernel/dist/index.js`. The test's beforeAll throws a clear
 * error if the build is stale or missing — run `pnpm -F @ico/kernel build`
 * before invoking.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../../packages/kernel/src/audit-verify.js';
import { closeDatabase, initDatabase } from '../../packages/kernel/src/state.js';
import { initWorkspace } from '../../packages/kernel/src/workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerScript = resolve(__dirname, '_workers', 'trace-writer-worker.mjs');
const kernelDistEntry = resolve(__dirname, '..', '..', 'packages', 'kernel', 'dist', 'index.js');

describe('traces — multi-process race (bead lhm)', () => {
  let tmpRoot: string;

  beforeAll(() => {
    if (!existsSync(kernelDistEntry)) {
      throw new Error(
        `Kernel dist not found at ${kernelDistEntry}. Run \`pnpm -F @ico/kernel build\` before this test.`,
      );
    }
    if (!existsSync(workerScript)) {
      throw new Error(`Worker script not found at ${workerScript}.`);
    }
  });

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'ico-lhm-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Spawn N workers each writing M events. Returns once all have exited.
   * Throws if any worker exits non-zero.
   */
  async function spawnWriters(opts: {
    workspacePath: string;
    dbPath: string;
    workers: number;
    iterations: number;
  }): Promise<void> {
    const promises: Promise<void>[] = [];
    for (let id = 0; id < opts.workers; id += 1) {
      promises.push(
        new Promise<void>((resolveChild, rejectChild) => {
          const child = spawn(
            process.execPath,
            [workerScript, opts.workspacePath, opts.dbPath, `w${id}`, String(opts.iterations)],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stderr = '';
          child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
          });
          child.on('exit', (code) => {
            if (code === 0) {
              resolveChild();
            } else {
              rejectChild(new Error(`worker w${id} exited ${code}: ${stderr}`));
            }
          });
          child.on('error', (e) => rejectChild(e));
        }),
      );
    }
    await Promise.all(promises);
  }

  it('preserves the audit-chain across N=5 concurrent writers × M=10 events', async () => {
    const initResult = initWorkspace('lhm-multi-process', tmpRoot);
    expect(initResult.ok).toBe(true);
    if (!initResult.ok) return;

    const { root, dbPath } = initResult.value;

    // Pre-initialize the DB so workers don't race on CREATE TABLE migrations.
    // initWorkspace lays out the directory tree but doesn't open the DB;
    // first writeTrace call creates the .db file. We want migrations applied
    // before workers start so the only contention is the writeTrace
    // critical section itself.
    const dbInit = initDatabase(dbPath);
    expect(dbInit.ok).toBe(true);
    if (!dbInit.ok) return;
    closeDatabase(dbInit.value);

    // Heavy concurrency: 5 child processes each writing 10 events = 50 total
    // appends to the same JSONL. Pre-fix this race fails on most runs;
    // post-fix it passes reliably.
    await spawnWriters({
      workspacePath: root,
      dbPath,
      workers: 5,
      iterations: 10,
    });

    const verifyResult = verifyAuditChain(root);
    expect(verifyResult.ok).toBe(true);
    if (!verifyResult.ok) {
      throw new Error(`verifyAuditChain failed: ${verifyResult.error.message}`);
    }
    // verifyAuditChain returns a result describing chain state — assert
    // no breaks reported.
    const summary = verifyResult.value;
    expect(summary.breaks).toEqual([]);
    // 50 events written total — every one accounted for in the chain.
    expect(summary.totalEvents).toBe(50);
  }, 30_000); // Allow up to 30s — child-process spawn + better-sqlite3 init is slow.
});
