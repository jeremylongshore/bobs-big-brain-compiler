/**
 * Crash-window fault-injection test for the receipts-precede-visibility
 * floor (GSB G1).
 *
 * A child process runs `promoteArtifact` with `ICO_CRASH_AFTER` set so the
 * kernel SIGKILLs itself mid-write (see packages/kernel/src/crash-hook.ts —
 * a hard kill, no exit handlers, exactly like a power loss). The parent
 * then inspects the workspace and asserts the invariant:
 *
 *   NO crash point can leave a VISIBLE wiki page without a receipt.
 *
 * With the new ordering (tmp → receipts → rename) the only possible
 * residues are:
 *   - crash after tmp-write:     orphan `.tmp`, nothing visible, no receipt
 *                                → reconcile sweeps the tmp; corpus consistent.
 *   - crash after receipts:      receipt row + trace exist, page never
 *                                appeared (receipt-without-file — the chosen,
 *                                auditable direction) → re-promotable.
 *
 * The OLD ordering (rename before receipts) could leave a visible page with
 * no receipt — content laundering. That residue is demonstrated by
 * hand-planting exactly such an orphan and showing reconcile quarantines it.
 *
 * Pre-requisite: the kernel package must be built (workers import
 * `packages/kernel/dist/index.js`). Run `pnpm -F @ico/kernel build` first —
 * the beforeAll throws a clear error otherwise.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { reconcileWorkspace } from '../../packages/kernel/src/reconcile.js';
import { closeDatabase, initDatabase } from '../../packages/kernel/src/state.js';
import { initWorkspace } from '../../packages/kernel/src/workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerScript = resolve(__dirname, '_workers', 'promotion-crash-worker.mjs');
const kernelDistEntry = resolve(__dirname, '..', '..', 'packages', 'kernel', 'dist', 'index.js');

const VISIBLE_TARGET = join('wiki', 'topics', 'crash-artifact.md');
const TMP_TARGET = `${VISIBLE_TARGET}.tmp`;

describe('promotion crash windows — receipts precede visibility (G1)', () => {
  let tmpRoot: string;
  let workspacePath: string;
  let dbPath: string;

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
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'ico-g1-crash-'));
    const initResult = initWorkspace('g1-crash', tmpRoot);
    expect(initResult.ok).toBe(true);
    if (!initResult.ok) throw initResult.error;
    workspacePath = initResult.value.root;
    dbPath = initResult.value.dbPath;

    // Apply migrations up front so the child only exercises the promotion path.
    const dbInit = initDatabase(dbPath);
    expect(dbInit.ok).toBe(true);
    if (!dbInit.ok) throw dbInit.error;
    closeDatabase(dbInit.value);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Spawn the promotion worker. `crashPhase` (if set) is injected via
   * ICO_CRASH_AFTER. Resolves with the exit code / signal.
   */
  function runWorker(
    crashPhase?: string,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [workerScript, workspacePath, dbPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(crashPhase !== undefined ? { ICO_CRASH_AFTER: crashPhase } : {}),
        },
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('exit', (code, signal) => resolvePromise({ code, signal, stderr }));
      child.on('error', (e) => rejectPromise(e));
    });
  }

  function promotionRowCount(): number {
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) throw dbResult.error;
    try {
      const row = dbResult.value
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM promotions')
        .get();
      return row?.n ?? 0;
    } finally {
      closeDatabase(dbResult.value);
    }
  }

  /** Assert the G1 invariant: every VISIBLE wiki page has a receipt. */
  function assertNoUnreceiptedVisiblePages(): void {
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) throw dbResult.error;
    try {
      // Future-shifted clock avoids the mtime-rounding flake a bare
      // tmpMaxAgeMs: 0 has when a tmp was written a moment ago.
      const r = reconcileWorkspace(dbResult.value, workspacePath, {
        tmpMaxAgeMs: 0,
        now: Date.now() + 60_000,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Nothing visible needed quarantining — the corpus never contained an
      // unreceipted page (tmp sweeps are fine; tmps are not visible).
      expect(r.value.quarantined).toEqual([]);
    } finally {
      closeDatabase(dbResult.value);
    }
  }

  it('control: without a crash phase the promotion completes visible AND receipted', async () => {
    const { code } = await runWorker();
    expect(code).toBe(0);
    expect(existsSync(join(workspacePath, VISIBLE_TARGET))).toBe(true);
    expect(promotionRowCount()).toBe(1);
    assertNoUnreceiptedVisiblePages();
    // The completed promotion's page survives reconcile (it is receipted).
    expect(existsSync(join(workspacePath, VISIBLE_TARGET))).toBe(true);
  }, 30_000);

  it('SIGKILL after tmp-write: nothing visible, no receipt — reconcile sweeps the orphan tmp', async () => {
    const { signal } = await runWorker('promotion:after-tmp');
    expect(signal).toBe('SIGKILL');

    // Residue: the tmp exists, nothing is visible, no receipt was written.
    expect(existsSync(join(workspacePath, TMP_TARGET))).toBe(true);
    expect(existsSync(join(workspacePath, VISIBLE_TARGET))).toBe(false);
    expect(promotionRowCount()).toBe(0);

    // Reconcile leaves the corpus consistent and removes the crash orphan.
    assertNoUnreceiptedVisiblePages();
    expect(existsSync(join(workspacePath, TMP_TARGET))).toBe(false);
    expect(existsSync(join(workspacePath, 'quarantine', TMP_TARGET))).toBe(true);
  }, 30_000);

  it('SIGKILL after receipts, before rename: receipt-without-file — auditable, never laundering', async () => {
    const { signal } = await runWorker('promotion:after-receipts');
    expect(signal).toBe('SIGKILL');

    // Residue: the receipt exists but the page never became visible. This is
    // the deliberately chosen crash direction — the promotions row + trace
    // document exactly what was attempted, and re-running the promotion
    // succeeds (source artifact untouched, target path still vacant).
    expect(promotionRowCount()).toBe(1);
    expect(existsSync(join(workspacePath, VISIBLE_TARGET))).toBe(false);

    assertNoUnreceiptedVisiblePages();

    // Recovery: a clean re-run completes the promotion.
    const rerun = await runWorker();
    expect(rerun.code).toBe(0);
    expect(existsSync(join(workspacePath, VISIBLE_TARGET))).toBe(true);
  }, 30_000);

  it('demonstrates the OLD ordering failure: a visible-but-unreceipted page is caught by reconcile', () => {
    // Under the pre-G1 ordering (rename BEFORE receipts), a crash in the
    // receipt phase left exactly this residue: a fully visible wiki page
    // with no promotions/compilations row. Plant that residue by hand and
    // show the quarantine-by-move floor catches it — which is also what
    // shields emitSpool (the page is no longer in wiki/ to be ingested).
    writeFileSync(
      join(workspacePath, VISIBLE_TARGET),
      '---\ntitle: Crash Artifact\n---\n\nPromotable body.\n',
      'utf-8',
    );

    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) throw dbResult.error;
    try {
      const r = reconcileWorkspace(dbResult.value, workspacePath);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.quarantined).toHaveLength(1);
      expect(r.value.quarantined[0]!.path).toBe(VISIBLE_TARGET);
    } finally {
      closeDatabase(dbResult.value);
    }

    expect(existsSync(join(workspacePath, VISIBLE_TARGET))).toBe(false);
    expect(existsSync(join(workspacePath, 'quarantine', VISIBLE_TARGET))).toBe(true);
  }, 30_000);
});
