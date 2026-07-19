/**
 * Cross-day trace chaining tests (G3).
 *
 * The writer seeds each new day file's FIRST event with `prev_hash` =
 * SHA-256 of the previous day file's LAST line; the verifier asserts the
 * link at every day boundary. Deleting a mid-chain day file therefore
 * becomes detectable by a pure file-walk — no SQLite index comparison
 * needed. Legacy day files written before the rule (first line
 * `prev_hash: null`) are carried as a documented exception, never breaks.
 */

import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyAuditChain } from './audit-verify.js';
import { sha256Hex } from './crypto.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { writeTrace } from './traces.js';
import { initWorkspace } from './workspace.js';

let workspacePath: string;
let tmpRoot: string;
let db: Database;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ico-crossday-'));
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

/** Write `count` events with the system clock pinned to `isoDate`T12:00Z. */
function writeEventsOn(isoDate: string, count: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${isoDate}T12:00:00.000Z`));
  for (let i = 0; i < count; i++) {
    const w = writeTrace(db, workspacePath, 'test.event', { day: isoDate, i });
    expect(w.ok).toBe(true);
  }
  vi.useRealTimers();
}

function dayFilePath(isoDate: string): string {
  return join(workspacePath, 'audit', 'traces', `${isoDate}.jsonl`);
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

describe('writeTrace — cross-day chain seeding', () => {
  it("seeds a new day's first event from the previous day's last line; genesis stays null", () => {
    writeEventsOn('2026-07-01', 2);
    writeEventsOn('2026-07-02', 2);

    const day1Lines = readLines(dayFilePath('2026-07-01'));
    const day2Lines = readLines(dayFilePath('2026-07-02'));

    // Genesis: very first event of the very first day is unlinked.
    const first = JSON.parse(day1Lines[0]!) as { prev_hash: string | null };
    expect(first.prev_hash).toBeNull();

    // Day 2's first event links to day 1's last line.
    const boundary = JSON.parse(day2Lines[0]!) as { prev_hash: string | null };
    expect(boundary.prev_hash).toBe(sha256Hex(day1Lines[day1Lines.length - 1]!));
  });
});

describe('verifyAuditChain — cross-day boundaries', () => {
  it('walks 3 linked day files clean and counts the linked boundaries', () => {
    writeEventsOn('2026-07-01', 2);
    writeEventsOn('2026-07-02', 2);
    writeEventsOn('2026-07-03', 2);

    const r = verifyAuditChain(workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks).toEqual([]);
    expect(r.value.totalEvents).toBe(6);
    expect(r.value.linkedBoundaries).toBe(2);
    expect(r.value.legacyBoundaries).toBe(0);
  });

  it('detects deletion of a mid-chain day file by file-walk alone', () => {
    writeEventsOn('2026-07-01', 2);
    writeEventsOn('2026-07-02', 2);
    writeEventsOn('2026-07-03', 2);

    // Delete the whole middle day. Pre-G3 this was invisible to a file-walk
    // (each day restarted at null); now day 3's boundary link points at the
    // vanished day 2 tail and no longer matches day 1's tail.
    unlinkSync(dayFilePath('2026-07-02'));

    const r = verifyAuditChain(workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.length).toBeGreaterThanOrEqual(1);
    const boundaryBreak = r.value.breaks.find(
      (b) => b.file === '2026-07-03.jsonl' && b.lineIndex === 0,
    );
    expect(boundaryBreak).toBeDefined();
  });

  it('detects deletion of the FIRST day file (successor links to a vanished predecessor)', () => {
    writeEventsOn('2026-07-01', 2);
    writeEventsOn('2026-07-02', 2);

    unlinkSync(dayFilePath('2026-07-01'));

    const r = verifyAuditChain(workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const boundaryBreak = r.value.breaks.find(
      (b) => b.file === '2026-07-02.jsonl' && b.lineIndex === 0,
    );
    expect(boundaryBreak).toBeDefined();
  });

  it('carries a legacy (pre-chaining) unlinked boundary as a documented exception, not a break', () => {
    // Simulate a pre-G3 corpus: two hand-built day files whose in-file
    // chains are valid but whose second day starts at null (the old writer
    // behavior). The verifier must count it, not fail it, and must never
    // rewrite the files.
    const tracesDir = join(workspacePath, 'audit', 'traces');
    mkdirSync(tracesDir, { recursive: true });

    const d1e1 = JSON.stringify({ event_id: 'a', prev_hash: null });
    const d1e2 = JSON.stringify({ event_id: 'b', prev_hash: sha256Hex(d1e1) });
    writeFileSync(dayFilePath('2026-01-01'), `${d1e1}\n${d1e2}\n`, 'utf-8');

    const d2e1 = JSON.stringify({ event_id: 'c', prev_hash: null }); // legacy boundary
    const d2e2 = JSON.stringify({ event_id: 'd', prev_hash: sha256Hex(d2e1) });
    writeFileSync(dayFilePath('2026-01-02'), `${d2e1}\n${d2e2}\n`, 'utf-8');

    const before1 = readFileSync(dayFilePath('2026-01-01'), 'utf-8');
    const before2 = readFileSync(dayFilePath('2026-01-02'), 'utf-8');

    const r = verifyAuditChain(workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks).toEqual([]);
    expect(r.value.legacyBoundaries).toBe(1);
    expect(r.value.linkedBoundaries).toBe(0);

    // Never silently re-hash or rewrite old files.
    expect(readFileSync(dayFilePath('2026-01-01'), 'utf-8')).toBe(before1);
    expect(readFileSync(dayFilePath('2026-01-02'), 'utf-8')).toBe(before2);
  });

  it('mixed corpus: legacy boundary followed by a linked boundary both verify clean', () => {
    // Legacy day pair (hand-built, unlinked boundary) ...
    const tracesDir = join(workspacePath, 'audit', 'traces');
    mkdirSync(tracesDir, { recursive: true });
    const d1e1 = JSON.stringify({ event_id: 'a', prev_hash: null });
    writeFileSync(dayFilePath('2026-01-01'), `${d1e1}\n`, 'utf-8');
    const d2e1 = JSON.stringify({ event_id: 'b', prev_hash: null });
    writeFileSync(dayFilePath('2026-01-02'), `${d2e1}\n`, 'utf-8');

    // ... then the new writer takes over and links its boundary.
    writeEventsOn('2026-01-03', 1);

    const r = verifyAuditChain(workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks).toEqual([]);
    expect(r.value.legacyBoundaries).toBe(1);
    expect(r.value.linkedBoundaries).toBe(1);
  });
});
