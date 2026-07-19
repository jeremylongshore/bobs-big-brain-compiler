/**
 * Tests for the workspace reconciler (receipts-precede-visibility floor, G1).
 *
 * The reconciler's contract:
 *  - a visible wiki page with NO matching compilations/promotions receipt
 *    row is MOVED to `quarantine/<rel-path>` (never deleted);
 *  - receipted pages are untouched;
 *  - stale `.tmp` crash orphans are swept into quarantine, fresh ones kept;
 *  - the reconciliation itself is receipted (an `audit.reconcile` trace).
 *
 * The hand-planted orphan below is exactly what the OLD write ordering
 * (rename before receipts) could leave behind after a crash — this test
 * demonstrates that reconcile catches that historical failure mode.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconcileWorkspace } from './reconcile.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { readTraces } from './traces.js';
import { initWorkspace } from './workspace.js';

let workspacePath: string;
let tmpRoot: string;
let db: Database;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ico-reconcile-'));
  const initResult = initWorkspace('workspace', tmpRoot);
  if (!initResult.ok) throw initResult.error;
  workspacePath = initResult.value.root;
  const dbResult = initDatabase(join(workspacePath, '.ico', 'state.db'));
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Plant a visible wiki page AND its compilations receipt row. */
function plantReceiptedPage(relPath: string, type: string): void {
  const abs = join(workspacePath, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `---\ntitle: Receipted\n---\nbody\n`, 'utf-8');
  db.prepare(
    `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model, tokens_used)
     VALUES (?, NULL, ?, ?, ?, 0, 'test-model', 1)`,
  ).run(`comp-${relPath}`, type, relPath, new Date().toISOString());
}

/** Plant a visible wiki page with NO receipt row — the laundering direction. */
function plantOrphanPage(relPath: string): void {
  const abs = join(workspacePath, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `---\ntitle: Orphan\n---\nunreceipted content\n`, 'utf-8');
}

describe('reconcileWorkspace — unreceipted visible pages', () => {
  it('quarantines a hand-planted orphan page with a report entry (never deletes)', () => {
    plantOrphanPage('wiki/topics/orphan.md');

    const r = reconcileWorkspace(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.quarantined).toHaveLength(1);
    expect(r.value.quarantined[0]!.path).toBe('wiki/topics/orphan.md');
    expect(r.value.quarantined[0]!.quarantinedTo).toBe('quarantine/wiki/topics/orphan.md');
    expect(r.value.quarantined[0]!.reason).toMatch(/no matching/);

    // Moved, not deleted: gone from wiki/, present (byte-identical) in quarantine/.
    expect(existsSync(join(workspacePath, 'wiki', 'topics', 'orphan.md'))).toBe(false);
    const quarantinedAbs = join(workspacePath, 'quarantine', 'wiki', 'topics', 'orphan.md');
    expect(existsSync(quarantinedAbs)).toBe(true);
    expect(readFileSync(quarantinedAbs, 'utf-8')).toContain('unreceipted content');
  });

  it('leaves compilations-receipted and promotions-receipted pages untouched', () => {
    plantReceiptedPage('wiki/topics/compiled.md', 'topic');

    // Promotion-receipted page.
    const promotedRel = 'wiki/concepts/promoted.md';
    writeFileSync(join(workspacePath, promotedRel), `---\ntitle: P\n---\nx\n`, 'utf-8');
    db.prepare(
      `INSERT INTO promotions (id, source_path, target_path, target_type, promoted_at, promoted_by)
       VALUES ('promo-1', 'outputs/reports/p.md', ?, 'concept', ?, 'user')`,
    ).run(promotedRel, new Date().toISOString());

    const r = reconcileWorkspace(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.quarantined).toEqual([]);
    expect(r.value.scanned).toBe(2);
    expect(existsSync(join(workspacePath, 'wiki', 'topics', 'compiled.md'))).toBe(true);
    expect(existsSync(join(workspacePath, promotedRel))).toBe(true);
  });

  it('suffixes rather than overwrites when quarantining a same-named file twice', () => {
    plantOrphanPage('wiki/topics/dup.md');
    const r1 = reconcileWorkspace(db, workspacePath);
    expect(r1.ok && r1.value.quarantined.length === 1).toBe(true);

    plantOrphanPage('wiki/topics/dup.md');
    const r2 = reconcileWorkspace(db, workspacePath);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.quarantined[0]!.quarantinedTo).toBe('quarantine/wiki/topics/dup.md.1');
    expect(existsSync(join(workspacePath, 'quarantine', 'wiki', 'topics', 'dup.md'))).toBe(true);
    expect(existsSync(join(workspacePath, 'quarantine', 'wiki', 'topics', 'dup.md.1'))).toBe(true);
  });

  it('receipts the reconciliation itself with an audit.reconcile trace', () => {
    plantOrphanPage('wiki/topics/orphan.md');
    const r = reconcileWorkspace(db, workspacePath);
    expect(r.ok).toBe(true);

    const traces = readTraces(db, { eventType: 'audit.reconcile' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;
    expect(traces.value).toHaveLength(1);
  });

  it('writes no trace when the corpus is already consistent', () => {
    plantReceiptedPage('wiki/topics/compiled.md', 'topic');
    const r = reconcileWorkspace(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.quarantined).toEqual([]);
    expect(r.value.tmpSwept).toEqual([]);

    const traces = readTraces(db, { eventType: 'audit.reconcile' });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;
    expect(traces.value).toEqual([]);
  });
});

describe('reconcileWorkspace — stale tmp sweep', () => {
  it('sweeps a stale .tmp crash orphan into quarantine', () => {
    const tmpRel = 'wiki/topics/crashed.md.tmp';
    writeFileSync(join(workspacePath, tmpRel), 'half-written', 'utf-8');

    // tmpMaxAgeMs: 0 → any tmp is stale.
    const r = reconcileWorkspace(db, workspacePath, { tmpMaxAgeMs: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tmpSwept).toHaveLength(1);
    expect(r.value.tmpSwept[0]!.path).toBe(tmpRel);
    expect(existsSync(join(workspacePath, tmpRel))).toBe(false);
    expect(existsSync(join(workspacePath, 'quarantine', tmpRel))).toBe(true);
  });

  it('leaves fresh .tmp files alone — a writer may be mid-operation', () => {
    const tmpRel = 'wiki/topics/inflight.md.tmp';
    writeFileSync(join(workspacePath, tmpRel), 'being written right now', 'utf-8');

    const r = reconcileWorkspace(db, workspacePath); // default one-hour threshold
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tmpSwept).toEqual([]);
    expect(existsSync(join(workspacePath, tmpRel))).toBe(true);
  });

  it('sweeps stale tmps in outputs/ as well', () => {
    mkdirSync(join(workspacePath, 'outputs', 'reports'), { recursive: true });
    const tmpRel = 'outputs/reports/report.md.tmp';
    writeFileSync(join(workspacePath, tmpRel), 'half-written report', 'utf-8');

    const r = reconcileWorkspace(db, workspacePath, { tmpMaxAgeMs: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tmpSwept).toHaveLength(1);
    expect(existsSync(join(workspacePath, 'quarantine', tmpRel))).toBe(true);
  });
});

describe('reconcileWorkspace — outputs/ visible files are NOT receipt-gated (v1)', () => {
  it('does not quarantine rendered artifacts in outputs/ (no receipt substrate yet)', () => {
    mkdirSync(join(workspacePath, 'outputs', 'reports'), { recursive: true });
    const reportRel = 'outputs/reports/legit-report.md';
    writeFileSync(join(workspacePath, reportRel), `---\ntitle: R\n---\nrendered\n`, 'utf-8');

    const r = reconcileWorkspace(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.quarantined).toEqual([]);
    expect(existsSync(join(workspacePath, reportRel))).toBe(true);
  });
});
