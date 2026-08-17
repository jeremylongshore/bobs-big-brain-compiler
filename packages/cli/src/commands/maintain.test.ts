import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeClient } from '@ico/compiler';
import { closeDatabase, initDatabase, registerMount, registerSource } from '@ico/kernel';
import { ok } from '@ico/types';

import {
  buildMaintenanceRawPath,
  createMeteredMaintenanceClient,
  type MaintenanceReceipt,
  readLatestMaintenanceReceipt,
  runMaintenance,
  scanMountedSources,
  writeMaintenanceReceipt,
} from './maintain.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('ico maintain planning', () => {
  let root: string;
  let workspace: string;
  let mounted: string;
  let savedTeamkbLock: string | undefined;
  let savedProvider: string | undefined;
  let savedMiniMaxKey: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ico-maintain-'));
    workspace = join(root, 'brain');
    mounted = join(root, 'mounted');
    mkdirSync(join(workspace, '.ico'), { recursive: true });
    mkdirSync(join(workspace, 'raw', 'notes'), { recursive: true });
    mkdirSync(mounted, { recursive: true });
    savedTeamkbLock = process.env['TEAMKB_LOCK'];
    savedProvider = process.env['ICO_PROVIDER'];
    savedMiniMaxKey = process.env['MINIMAX_API_KEY'];
    process.env['TEAMKB_LOCK'] = join(root, '.write.lock');
    process.env['ICO_PROVIDER'] = 'minimax';
    process.env['MINIMAX_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    if (savedTeamkbLock === undefined) delete process.env['TEAMKB_LOCK'];
    else process.env['TEAMKB_LOCK'] = savedTeamkbLock;
    if (savedProvider === undefined) delete process.env['ICO_PROVIDER'];
    else process.env['ICO_PROVIDER'] = savedProvider;
    if (savedMiniMaxKey === undefined) delete process.env['MINIMAX_API_KEY'];
    else process.env['MINIMAX_API_KEY'] = savedMiniMaxKey;
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers uppercase Markdown and separates policy blocks from legacy no-ops', () => {
    const dbResult = initDatabase(join(workspace, '.ico', 'state.db'));
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    const db = dbResult.value;
    try {
      const mountResult = registerMount(db, 'live-repo', mounted);
      expect(mountResult.ok).toBe(true);
      if (!mountResult.ok) return;

      writeFileSync(join(mounted, 'UPPER.MD'), '# Newly visible\n', 'utf-8');
      writeFileSync(join(mounted, 'blocked.md'), 'SSN: 123-45-6789\n', 'utf-8');
      writeFileSync(join(mounted, 'known.md'), '# Known\n', 'utf-8');
      writeFileSync(join(workspace, 'raw', 'notes', 'known.md'), '# Known\n', 'utf-8');

      const source = registerSource(db, {
        path: 'raw/notes/known.md',
        type: 'markdown',
        hash: hash('# Known\n'),
      });
      expect(source.ok).toBe(true);
      if (!source.ok) return;
      db.prepare(
        `INSERT INTO compilations
          (id, source_id, type, output_path, compiled_at, model, tokens_used)
         VALUES (?, ?, 'summary', ?, ?, 'MiniMax-M3', 100)`,
      ).run(randomUUID(), source.value.id, 'wiki/sources/known.md', new Date().toISOString());

      const scan = scanMountedSources(db, workspace);
      expect(scan.counts.files).toBe(3);
      expect(scan.counts.new).toBe(1);
      expect(scan.counts.policyBlocked).toBe(1);
      expect(scan.counts.legacyUnchanged).toBe(1);
      expect(scan.candidates).toHaveLength(1);
      expect(scan.candidates[0]?.originPath).toBe(join(mounted, 'UPPER.MD'));
      expect(scan.candidates[0]?.rawPath).toMatch(/\.md$/);
    } finally {
      closeDatabase(db);
    }
  });

  it('uses mount identity and relative path to prevent basename collisions', () => {
    const mount = { id: randomUUID(), name: 'repo' };
    const first = buildMaintenanceRawPath(mount, 'docs/README.MD');
    const second = buildMaintenanceRawPath(mount, 'examples/README.MD');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^raw\/notes\/repo-readme-[0-9a-f]{12}\.md$/);
    expect(second).toMatch(/^raw\/notes\/repo-readme-[0-9a-f]{12}\.md$/);
  });

  it('marks an old mount as stale only when the operator enables an age limit', () => {
    const dbResult = initDatabase(join(workspace, '.ico', 'state.db'));
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    const db = dbResult.value;
    try {
      const mountResult = registerMount(db, 'static-papers', mounted);
      expect(mountResult.ok).toBe(true);
      writeFileSync(join(mounted, 'paper.md'), '# Old but valid\n', 'utf-8');
      const mtime = new Date('2026-01-01T00:00:00.000Z');
      const nowMs = new Date('2026-01-20T00:00:00.000Z').getTime();
      utimesSync(join(mounted, 'paper.md'), mtime, mtime);

      expect(scanMountedSources(db, workspace, { nowMs }).staleMounts).toEqual([]);
      expect(scanMountedSources(db, workspace, { nowMs, maxInputAgeDays: 7 }).staleMounts).toEqual([
        'static-papers',
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  it('honors Git ignore rules without traversing an unreadable ignored scratch directory', () => {
    expect(spawnSync('git', ['init', '-q', mounted]).status).toBe(0);
    writeFileSync(join(mounted, '.gitignore'), 'scratch/\n', 'utf-8');
    writeFileSync(join(mounted, 'VISIBLE.MD'), '# Governed source\n', 'utf-8');
    const scratch = join(mounted, 'scratch');
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'private.md'), '# Not a source\n', 'utf-8');
    chmodSync(scratch, 0o000);

    const dbResult = initDatabase(join(workspace, '.ico', 'state.db'));
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    const db = dbResult.value;
    try {
      expect(registerMount(db, 'git-repo', mounted).ok).toBe(true);
      const scan = scanMountedSources(db, workspace);
      expect(scan.counts.files).toBe(1);
      expect(scan.counts.new).toBe(1);
      expect(scan.candidates[0]?.originPath).toBe(join(mounted, 'VISIBLE.MD'));
    } finally {
      chmodSync(scratch, 0o700);
      closeDatabase(db);
    }
  });

  it('writes latest and history receipts atomically', () => {
    const receipt: MaintenanceReceipt = {
      schemaVersion: 2,
      compileScope: 'mounted-source',
      runId: '2026-08-16T00-00-00-000Z',
      startedAt: '2026-08-16T00:00:00.000Z',
      finishedAt: '2026-08-16T00:00:01.000Z',
      status: 'verified_noop',
      workspace,
      model: null,
      scan: {
        mounts: [],
        counts: {
          mounts: 0,
          files: 0,
          unchanged: 0,
          legacyUnchanged: 0,
          policyBlocked: 0,
          governedExcluded: 0,
          new: 0,
          changed: 0,
          pending: 0,
          removed: 0,
        },
        removedOrigins: [],
        staleMounts: [],
        missingMounts: [],
      },
      rawPaths: [],
      plannedAffectedTypes: [],
      compilationRowsAdded: 0,
      projectedCostUsd: null,
      progress: {
        eligible: 0,
        selected: 0,
        processed: 0,
        governedExcluded: 0,
        failed: 0,
        remaining: 0,
      },
      inference: {
        operations: 0,
        inputTokens: 0,
        outputTokens: 0,
        actualCostUsd: 0,
        spentTodayBeforeUsd: 0,
        spentTodayAfterUsd: 0,
        dailyCeilingUsd: 1,
      },
      errorCode: null,
      error: null,
    };

    writeMaintenanceReceipt(workspace, receipt);
    expect(readLatestMaintenanceReceipt(workspace)).toEqual(receipt);
  });

  it('emits a verified_noop terminal receipt for a clean hash-complete mount', async () => {
    const dbPath = join(workspace, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    const db = dbResult.value;
    try {
      const mountResult = registerMount(db, 'live-repo', mounted);
      expect(mountResult.ok).toBe(true);
      writeFileSync(join(mounted, 'known.md'), '# Known\n', 'utf-8');
      writeFileSync(join(workspace, 'raw', 'notes', 'known.md'), '# Known\n', 'utf-8');
      const source = registerSource(db, {
        path: 'raw/notes/known.md',
        type: 'markdown',
        hash: hash('# Known\n'),
      });
      expect(source.ok).toBe(true);
      if (!source.ok) return;
      db.prepare(
        `INSERT INTO compilations
          (id, source_id, type, output_path, compiled_at, model, tokens_used)
         VALUES (?, ?, 'summary', ?, ?, 'MiniMax-M3', 100)`,
      ).run(randomUUID(), source.value.id, 'wiki/sources/known.md', new Date().toISOString());
    } finally {
      closeDatabase(db);
    }

    const receipt = await runMaintenance(workspace, dbPath, {
      scanOnly: true,
      lockWaitSeconds: '1',
    });
    expect(receipt.status).toBe('verified_noop');
    expect(receipt.errorCode).toBeNull();
    expect(receipt.scan.counts.legacyUnchanged).toBe(1);
    expect(readLatestMaintenanceReceipt(workspace)).toEqual(receipt);
  });

  it('writes an incremental raw-path manifest for clean pending work in scan-only mode', async () => {
    const dbPath = join(workspace, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    const db = dbResult.value;
    try {
      expect(registerMount(db, 'live-repo', mounted).ok).toBe(true);
      writeFileSync(join(mounted, 'NEW.MD'), '# Pending\n', 'utf-8');
    } finally {
      closeDatabase(db);
    }

    const receipt = await runMaintenance(workspace, dbPath, {
      scanOnly: true,
      lockWaitSeconds: '1',
    });
    expect(receipt.status).toBe('failure');
    expect(receipt.errorCode).toBe('scan_found_pending_work');
    expect(receipt.scan.counts.new).toBe(1);
    expect(receipt.rawPaths).toHaveLength(1);
    expect(receipt.rawPaths[0]).toMatch(/^raw\/notes\/live-repo-new-[0-9a-f]{12}\.md$/);
    expect(readLatestMaintenanceReceipt(workspace)).toEqual(receipt);
  });

  it('processes a bounded batch, receipts exact calls once, and leaves honest remaining work', async () => {
    const dbPath = join(workspace, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    try {
      expect(registerMount(dbResult.value, 'live-repo', mounted).ok).toBe(true);
      writeFileSync(join(mounted, 'a.md'), '# Alpha\nA durable alpha decision.\n', 'utf-8');
      writeFileSync(join(mounted, 'b.md'), '# Beta\nA durable beta decision.\n', 'utf-8');
    } finally {
      closeDatabase(dbResult.value);
    }

    let call = 0;
    const fakeClient: ClaudeClient = {
      createCompletion: vi.fn(() => {
        call++;
        const content = `---\ntype: source-summary\nid: 11111111-1111-4111-8111-111111111111\ntitle: Bounded Source\nsource_id: 22222222-2222-4222-8222-222222222222\nsource_path: raw/notes/source.md\ncompiled_at: 2026-08-16T00:00:00.000Z\nmodel: MiniMax-M3\ncontent_hash: abc123\n---\n\n## Summary\n\nThis source records a durable decision with enough grounded detail for deterministic validation.`;
        return Promise.resolve(
          ok({
            content,
            inputTokens: 120,
            outputTokens: 60,
            model: 'MiniMax-M3',
            stopReason: 'stop',
          }),
        );
      }),
    };

    const receipt = await runMaintenance(
      workspace,
      dbPath,
      {
        maxCandidates: '1',
        dailyCeilingUsd: '10',
        debounceSeconds: '0',
        lockWaitSeconds: '1',
      },
      { createClient: () => fakeClient },
    );

    expect(receipt.status).toBe('partial');
    expect(receipt.compileScope).toBe('mounted-source');
    expect(receipt.progress).toMatchObject({
      eligible: 2,
      selected: 1,
      processed: 1,
      failed: 0,
      remaining: 1,
    });
    expect(receipt.inference).toMatchObject({
      operations: 1,
      inputTokens: 120,
      outputTokens: 60,
    });
    expect(call).toBe(1);
    expect(receipt.inference.actualCostUsd).toBeGreaterThan(0);

    const verifyResult = initDatabase(dbPath);
    expect(verifyResult.ok).toBe(true);
    if (!verifyResult.ok) return;
    try {
      const operations = verifyResult.value
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM inference_operations')
        .get();
      expect(operations?.n).toBe(1);
      const scan = scanMountedSources(verifyResult.value, workspace);
      expect(scan.candidates).toHaveLength(1);
      expect(scan.counts.unchanged).toBe(1);
    } finally {
      closeDatabase(verifyResult.value);
    }
  });

  it('checkpoints the final source batch without aggregate extract or corpus-wide passes', async () => {
    const dbPath = join(workspace, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    try {
      expect(registerMount(dbResult.value, 'live-repo', mounted).ok).toBe(true);
      writeFileSync(join(mounted, 'only.md'), '# Only\nOne final durable source.\n', 'utf-8');
    } finally {
      closeDatabase(dbResult.value);
    }

    let call = 0;
    const fakeClient: ClaudeClient = {
      createCompletion: vi.fn(() => {
        call++;
        if (call > 1) throw new Error('unexpected aggregate provider call');
        const content = `---\ntype: source-summary\nid: 11111111-1111-4111-8111-111111111111\ntitle: Final Source\nsource_id: 22222222-2222-4222-8222-222222222222\nsource_path: raw/notes/source.md\ncompiled_at: 2026-08-16T00:00:00.000Z\nmodel: MiniMax-M3\ncontent_hash: abc123\n---\n\n## Summary\n\nThis final source records a durable decision with enough grounded detail for deterministic validation.`;
        return Promise.resolve(
          ok({
            content,
            inputTokens: 100,
            outputTokens: 50,
            model: 'MiniMax-M3',
            stopReason: 'stop',
          }),
        );
      }),
    };

    const receipt = await runMaintenance(
      workspace,
      dbPath,
      {
        maxCandidates: '10',
        dailyCeilingUsd: '10',
        debounceSeconds: '0',
        lockWaitSeconds: '1',
      },
      { createClient: () => fakeClient },
    );

    expect(receipt.status).toBe('compiled');
    expect(receipt.compileScope).toBe('mounted-source');
    expect(receipt.progress.remaining).toBe(0);
    expect(receipt.plannedAffectedTypes).toEqual(['summary', 'summary']);
    expect(receipt.inference.operations).toBe(1);
    expect(call).toBe(1);
  });

  it('resumes from an existing receipted summary without another provider call', async () => {
    const dbPath = join(workspace, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    try {
      expect(registerMount(dbResult.value, 'live-repo', mounted).ok).toBe(true);
      writeFileSync(join(mounted, 'resume.md'), '# Resume\nA durable resumable source.\n', 'utf-8');
    } finally {
      closeDatabase(dbResult.value);
    }

    const summaryClient: ClaudeClient = {
      createCompletion: vi.fn(() =>
        Promise.resolve(
          ok({
            content: `---\ntype: source-summary\nid: 11111111-1111-4111-8111-111111111111\ntitle: Resume Source\nsource_id: 22222222-2222-4222-8222-222222222222\nsource_path: raw/notes/source.md\ncompiled_at: 2026-08-16T00:00:00.000Z\nmodel: MiniMax-M3\ncontent_hash: abc123\n---\n\n## Summary\n\nThis source records a durable checkpoint that a later maintenance run can safely reuse.`,
            inputTokens: 100,
            outputTokens: 50,
            model: 'MiniMax-M3',
            stopReason: 'stop',
          }),
        ),
      ),
    };
    const first = await runMaintenance(
      workspace,
      dbPath,
      {
        maxCandidates: '1',
        dailyCeilingUsd: '10',
        debounceSeconds: '0',
        lockWaitSeconds: '1',
      },
      { createClient: () => summaryClient },
    );
    expect(first.status).toBe('compiled');

    const resetResult = initDatabase(dbPath);
    expect(resetResult.ok).toBe(true);
    if (!resetResult.ok) return;
    try {
      const row = resetResult.value
        .prepare<
          [],
          { id: string; metadata: string }
        >("SELECT id, metadata FROM sources WHERE path LIKE 'raw/notes/live-repo-resume-%'")
        .get();
      expect(row).toBeDefined();
      if (row === undefined) return;
      const metadata = JSON.parse(row.metadata) as {
        maintenance?: { completedHash?: string; excludedReason?: string };
      };
      if (metadata.maintenance !== undefined) {
        delete metadata.maintenance.completedHash;
        delete metadata.maintenance.excludedReason;
      }
      resetResult.value
        .prepare('UPDATE sources SET metadata = ? WHERE id = ?')
        .run(JSON.stringify(metadata), row.id);
    } finally {
      closeDatabase(resetResult.value);
    }

    const provider = vi.fn(() => Promise.reject(new Error('must not be called')));
    const resumed = await runMaintenance(
      workspace,
      dbPath,
      {
        maxCandidates: '1',
        dailyCeilingUsd: '10',
        debounceSeconds: '0',
        lockWaitSeconds: '1',
      },
      { createClient: () => ({ createCompletion: provider }) },
    );

    expect(resumed.status).toBe('compiled');
    expect(resumed.progress).toMatchObject({ processed: 1, failed: 0, remaining: 0 });
    expect(resumed.plannedAffectedTypes).toEqual([]);
    expect(resumed.inference.operations).toBe(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it('refuses a provider call before its worst case can cross the runtime ceiling', async () => {
    const dbPath = join(workspace, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    try {
      const provider = vi.fn(() =>
        Promise.resolve(
          ok({
            content: 'unused',
            inputTokens: 1,
            outputTokens: 1,
            model: 'MiniMax-M3',
            stopReason: 'stop',
          }),
        ),
      );
      const metered = createMeteredMaintenanceClient(
        { createCompletion: provider },
        {
          db: dbResult.value,
          runId: 'runtime-ceiling-test',
          model: 'MiniMax-M3',
          dailyCeilingUsd: 0.000001,
          spentTodayBeforeUsd: 0,
          operationType: () => 'summary',
        },
      );

      const result = await metered.client.createCompletion('system', 'prompt', {
        model: 'MiniMax-M3',
        maxTokens: 4096,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('INFERENCE_BUDGET_EXCEEDED');
      expect(provider).not.toHaveBeenCalled();
      expect(metered.state.operations).toBe(0);
      const operations = dbResult.value
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM inference_operations')
        .get();
      expect(operations?.n).toBe(0);
    } finally {
      closeDatabase(dbResult.value);
    }
  });

  it('cannot emit success when a registered mount is missing', async () => {
    const dbPath = join(workspace, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    const db = dbResult.value;
    try {
      expect(registerMount(db, 'missing-repo', mounted).ok).toBe(true);
    } finally {
      closeDatabase(db);
    }
    rmSync(mounted, { recursive: true, force: true });

    const receipt = await runMaintenance(workspace, dbPath, {
      scanOnly: true,
      lockWaitSeconds: '1',
    });
    expect(receipt.status).toBe('failure');
    expect(receipt.errorCode).toBe('missing_mount');
  });

  it('reports a scan failure distinctly from write-lock contention', async () => {
    const dbPath = join(workspace, '.ico', 'state.db');
    const dbResult = initDatabase(dbPath);
    expect(dbResult.ok).toBe(true);
    if (!dbResult.ok) return;
    const db = dbResult.value;
    try {
      expect(registerMount(db, 'unreadable', mounted).ok).toBe(true);
    } finally {
      closeDatabase(db);
    }
    chmodSync(mounted, 0o000);
    try {
      const receipt = await runMaintenance(workspace, dbPath, {
        scanOnly: true,
        lockWaitSeconds: '1',
      });
      expect(receipt.status).toBe('failure');
      expect(receipt.errorCode).toBe('scan_failed');
      expect(receipt.error).toMatch(/permission denied|EACCES/i);
    } finally {
      chmodSync(mounted, 0o700);
    }
  });
});
