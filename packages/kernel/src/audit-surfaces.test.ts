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
  it('reports malformed records while continuing to check healthy sidecars', () => {
    expect(
      recordProvenance(db, workspacePath, {
        sourceId: 'healthy',
        outputPath: 'wiki/healthy.md',
        outputType: 'summary',
        operation: 'compile.summarize',
      }).ok,
    ).toBe(true);
    const malformed = [
      JSON.stringify({ outputPath: 'wiki/a.md', operation: 'compile.summarize' }),
      JSON.stringify({ sourceId: 'bad', outputPath: 42, operation: 'compile.summarize' }),
      JSON.stringify({ sourceId: 'bad', outputPath: 'wiki/a.md', operation: null }),
      '{invalid JSON',
    ];
    writeFileSync(
      join(workspacePath, 'audit', 'provenance', 'bad.jsonl'),
      malformed.join('\n') + '\n',
    );
    const result = verifyAuditSurfaces(db, workspacePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provenanceFiles).toBe(2);
    expect(result.value.provenanceRecords).toBe(1);
    expect(result.value.provenanceTraceEvents).toBe(1);
    expect(result.value.unreceiptedProvenance).toBe(0);
    expect(result.value.breaks).toEqual(
      malformed.map((_, index) => ({
        surface: 'provenance',
        code: 'PROVENANCE_MALFORMED',
        file: 'bad.jsonl',
        detail:
          index === 3
            ? 'line 3: not valid JSON'
            : `line ${index}: record is missing sourceId/outputPath/operation`,
      })),
    );
  });

  it('counts a sidecar without a chained receipt as unreceipted crash evidence', () => {
    const dir = join(workspacePath, 'audit', 'provenance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'pending.jsonl'),
      JSON.stringify({
        sourceId: 'pending',
        outputPath: 'wiki/pending.md',
        operation: 'compile.summarize',
      }) + '\n',
    );
    const result = verifyAuditSurfaces(db, workspacePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provenanceRecords).toBe(1);
    expect(result.value.provenanceTraceEvents).toBe(0);
    expect(result.value.unreceiptedProvenance).toBe(1);
    expect(result.value.breaks).toEqual([]);
  });

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

  it('detects a consistent spool and manifest rewrite against the chained digest', () => {
    const name = 'spool-rewrite.jsonl';
    const original = writeSpool(name, ['{"original":1}']);
    writeManifest(name, { spoolFileSha256: original, emittedCount: 1 });
    expect(
      writeTrace(db, workspacePath, 'spool.emit.complete', {
        spoolFile: name,
        spoolFileSha256: original,
      }).ok,
    ).toBe(true);
    const before = verifyAuditSurfaces(db, workspacePath);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.breaks).toEqual([]);

    const rewritten = writeSpool(name, ['{"replacement":1}', '{"replacement":2}']);
    writeManifest(name, { spoolFileSha256: rewritten, emittedCount: 2 });
    const after = verifyAuditSurfaces(db, workspacePath);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.breaks).toEqual([
      {
        surface: 'spool',
        code: 'SPOOL_TRACE_MISMATCH',
        file: name,
        detail: `manifest digest ${rewritten} != chained spool.emit.complete digest ${original}`,
      },
    ]);
  });

  it('allows consumption of a receipted spool when file and manifest move together', () => {
    const name = 'spool-consumed.jsonl';
    const digest = writeSpool(name, ['{"candidate":1}']);
    writeManifest(name, { spoolFileSha256: digest, emittedCount: 1 });
    expect(
      writeTrace(db, workspacePath, 'spool.emit.complete', {
        spoolFile: name,
        spoolFileSha256: digest,
      }).ok,
    ).toBe(true);
    unlinkSync(join(spoolDir(), name));
    unlinkSync(join(spoolDir(), `${name}.manifest.json`));
    const result = verifyAuditSurfaces(db, workspacePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.breaks).toEqual([]);
    expect(result.value.spoolFilesChecked).toBe(0);
    expect(result.value.spoolManifestsChecked).toBe(0);
  });

  it('reports an invalid manifest and continues checking other spool batches', () => {
    writeSpool('spool-bad.jsonl', ['{"candidate":1}']);
    writeFileSync(join(spoolDir(), 'spool-bad.jsonl.manifest.json'), '{invalid JSON');
    const healthy = writeSpool('spool-healthy.jsonl', ['{"candidate":2}']);
    writeManifest('spool-healthy.jsonl', { spoolFileSha256: healthy, emittedCount: 1 });
    const result = verifyAuditSurfaces(db, workspacePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.spoolFilesChecked).toBe(2);
    expect(result.value.spoolManifestsChecked).toBe(2);
    expect(result.value.breaks).toEqual([
      {
        surface: 'spool',
        code: 'SPOOL_MANIFEST_MALFORMED',
        file: 'spool-bad.jsonl.manifest.json',
        detail: 'manifest is not valid JSON',
      },
    ]);
  });

  it('returns an error when a spool entry cannot be read rather than reporting success', () => {
    const name = 'spool-unreadable.jsonl';
    mkdirSync(join(spoolDir(), name));
    writeManifest(name, { spoolFileSha256: 'unreadable', emittedCount: 0 });
    const manifest = readFileSync(join(spoolDir(), `${name}.manifest.json`), 'utf-8');
    const result = verifyAuditSurfaces(db, workspacePath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/EISDIR/);
    expect(readFileSync(join(spoolDir(), `${name}.manifest.json`), 'utf-8')).toBe(manifest);
  });

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
