/**
 * Tests for the extended audit-surface verifier (l13.7): trace-index vs disk
 * (whole-file deletion + truncation), provenance sidecars vs chained events,
 * spool manifests vs bytes vs chained emit traces, and the log.md
 * convenience-only declaration.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyAuditSurfaces } from './audit-surfaces.js';
import { recordProvenance } from './provenance.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { writeTrace } from './traces.js';
import { initWorkspace } from './workspace.js';

let workspacePath: string;
let tmpRoot: string;
let db: Database;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ico-surfaces-'));
  const initResult = initWorkspace('workspace', tmpRoot);
  if (!initResult.ok) throw initResult.error;
  workspacePath = initResult.value.root;
  const dbResult = initDatabase(join(workspacePath, '.ico', 'state.db'));
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;
});

afterEach(() => {
  vi.useRealTimers();
  closeDatabase(db);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function tracesDir(): string {
  return join(workspacePath, 'audit', 'traces');
}

function writeEvents(count: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-01T12:00:00.000Z'));
  for (let i = 0; i < count; i++) {
    const w = writeTrace(db, workspacePath, 'test.event', { i });
    expect(w.ok).toBe(true);
  }
  vi.useRealTimers();
}

describe('verifyAuditSurfaces — trace index', () => {
  it('is clean when index and disk agree', () => {
    writeEvents(3);
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks).toEqual([]);
    expect(r.value.indexedEvents).toBe(3);
  });

  it('detects whole-file deletion of an indexed day file', () => {
    writeEvents(3);
    unlinkSync(join(tracesDir(), '2026-07-01.jsonl'));
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.some((b) => b.code === 'TRACE_FILE_MISSING')).toBe(true);
  });

  it('detects truncation of an indexed day file', () => {
    writeEvents(4);
    // Keep only 1 line on disk; the index still has 4 rows.
    const path = join(tracesDir(), '2026-07-01.jsonl');
    const firstLine = readFileSync(path, 'utf-8').split('\n')[0];
    writeFileSync(path, firstLine + '\n');
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.some((b) => b.code === 'TRACE_FILE_TRUNCATED')).toBe(true);
  });

  it('carries unindexed extra day files as an exception, not a break', () => {
    writeEvents(2);
    writeFileSync(
      join(tracesDir(), '2026-07-05.jsonl'),
      JSON.stringify({ event_type: 'x', prev_hash: null }) + '\n',
    );
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks).toEqual([]);
    expect(r.value.unindexedEvents).toBeGreaterThanOrEqual(1);
  });
});

describe('verifyAuditSurfaces — provenance sidecars', () => {
  it('is clean when sidecars match chained provenance.record events', () => {
    const p = recordProvenance(db, workspacePath, {
      sourceId: 'src-1',
      outputPath: 'wiki/sources/a.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    expect(p.ok).toBe(true);
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks).toEqual([]);
    expect(r.value.provenanceTraceEvents).toBe(1);
    expect(r.value.provenanceRecords).toBe(1);
  });

  it('detects a deleted sidecar record whose chained event survives', () => {
    recordProvenance(db, workspacePath, {
      sourceId: 'src-1',
      outputPath: 'wiki/sources/a.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    // Blank the sidecar file — the chained provenance.record trace remains.
    writeFileSync(join(workspacePath, 'audit', 'provenance', 'src-1.jsonl'), '');
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.some((b) => b.code === 'PROVENANCE_SIDECAR_MISSING')).toBe(true);
  });
});

describe('verifyAuditSurfaces — spool manifests', () => {
  function spoolDir(): string {
    const dir = join(workspacePath, 'spool');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  function writeSpool(name: string, lines: string[]): string {
    const body = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    writeFileSync(join(spoolDir(), name), body);
    return createHash('sha256').update(body, 'utf-8').digest('hex');
  }
  function writeManifest(name: string, obj: Record<string, unknown>): void {
    writeFileSync(join(spoolDir(), `${name}.manifest.json`), JSON.stringify(obj, null, 2) + '\n');
  }

  it('is clean when spool bytes match the manifest digest and count', () => {
    const sha = writeSpool('spool-x.jsonl', ['{"a":1}', '{"b":2}']);
    writeManifest('spool-x.jsonl', { spoolFileSha256: sha, emittedCount: 2 });
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks).toEqual([]);
    expect(r.value.spoolManifestsChecked).toBe(1);
  });

  it('detects a spool file whose bytes no longer match the manifest hash', () => {
    writeSpool('spool-x.jsonl', ['{"a":1}']);
    writeManifest('spool-x.jsonl', { spoolFileSha256: 'deadbeef', emittedCount: 1 });
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.some((b) => b.code === 'SPOOL_HASH_MISMATCH')).toBe(true);
  });

  it('detects a count mismatch', () => {
    const sha = writeSpool('spool-x.jsonl', ['{"a":1}', '{"b":2}']);
    writeManifest('spool-x.jsonl', { spoolFileSha256: sha, emittedCount: 5 });
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.some((b) => b.code === 'SPOOL_COUNT_MISMATCH')).toBe(true);
  });

  it('detects a manifest whose spool file vanished', () => {
    writeManifest('spool-gone.jsonl', { spoolFileSha256: 'x', emittedCount: 0 });
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.some((b) => b.code === 'SPOOL_FILE_MISSING')).toBe(true);
  });

  it('detects a spool file with no manifest', () => {
    writeSpool('spool-orphan.jsonl', ['{"a":1}']);
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.some((b) => b.code === 'SPOOL_MANIFEST_MISSING')).toBe(true);
  });
});

describe('verifyAuditSurfaces — log.md', () => {
  it('reports log.md as convenience-only, never a break', () => {
    writeEvents(1); // writeTrace appends to audit/log.md
    const r = verifyAuditSurfaces(db, workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.logMd.convenienceOnly).toBe(true);
    expect(r.value.logMd.present).toBe(true);
    // Editing log.md must NOT produce a break.
    writeFileSync(join(workspacePath, 'audit', 'log.md'), '# tampered\n');
    const r2 = verifyAuditSurfaces(db, workspacePath);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.breaks).toEqual([]);
  });
});
