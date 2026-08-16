import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, initDatabase, registerMount, registerSource } from '@ico/kernel';

import {
  buildMaintenanceRawPath,
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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ico-maintain-'));
    workspace = join(root, 'brain');
    mounted = join(root, 'mounted');
    mkdirSync(join(workspace, '.ico'), { recursive: true });
    mkdirSync(join(workspace, 'raw', 'notes'), { recursive: true });
    mkdirSync(mounted, { recursive: true });
    savedTeamkbLock = process.env['TEAMKB_LOCK'];
    process.env['TEAMKB_LOCK'] = join(root, '.write.lock');
  });

  afterEach(() => {
    if (savedTeamkbLock === undefined) delete process.env['TEAMKB_LOCK'];
    else process.env['TEAMKB_LOCK'] = savedTeamkbLock;
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
      schemaVersion: 1,
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
