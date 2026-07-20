/**
 * Tests for external chain-head anchoring of the ICO compile-trace chains
 * (l13.8). The point of anchoring: catch a silent FULL rewrite of history
 * (which verifyAuditChain re-verifies clean) and trailing-file truncation.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendIcoAnchor,
  computeIcoAnchorHash,
  readIcoAnchors,
  verifyIcoAnchors,
} from './audit-anchor.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { writeTrace } from './traces.js';
import { initWorkspace } from './workspace.js';

let workspacePath: string;
let tmpRoot: string;
let anchorPath: string;
let db: Database;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ico-anchor-'));
  const initResult = initWorkspace('workspace', tmpRoot);
  if (!initResult.ok) throw initResult.error;
  workspacePath = initResult.value.root;
  anchorPath = join(tmpRoot, 'ico-anchors.jsonl');
  const dbResult = initDatabase(join(workspacePath, '.ico', 'state.db'));
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;
});

afterEach(() => {
  vi.useRealTimers();
  closeDatabase(db);
  rmSync(tmpRoot, { recursive: true, force: true });
});

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

describe('appendIcoAnchor', () => {
  it('appends a linked record and cleanly verifies', () => {
    writeEventsOn('2026-07-01', 3);
    const r = appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.appended).toBe(true);
    expect(r.value.record.totalEvents).toBe(3);
    expect(r.value.record.prevAnchorHash).toBeNull();

    const v = verifyIcoAnchors(workspacePath, anchorPath);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.ok).toBe(true);
  });

  it('links successive anchors into a hash chain', () => {
    writeEventsOn('2026-07-01', 2);
    const first = appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });
    writeEventsOn('2026-07-02', 2);
    const second = appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.record.prevAnchorHash).toBe(first.value.record.anchorHash);
    const anchors = readIcoAnchors(anchorPath);
    expect(anchors).toHaveLength(2);
  });

  it('no-ops when the chain head is unchanged (idempotent re-anchor)', () => {
    writeEventsOn('2026-07-01', 2);
    const first = appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });
    const again = appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });
    expect(first.ok && again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.appended).toBe(false);
    expect(readIcoAnchors(anchorPath)).toHaveLength(1);
  });

  it('errors when the anchor directory does not exist', () => {
    writeEventsOn('2026-07-01', 1);
    const r = appendIcoAnchor(workspacePath, join(tmpRoot, 'nope', 'a.jsonl'));
    expect(r.ok).toBe(false);
  });
});

describe('verifyIcoAnchors — tamper detection', () => {
  it('detects a silent full rewrite that verifyAuditChain would pass', () => {
    writeEventsOn('2026-07-01', 3);
    appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });

    // Rewrite the whole day file with a fresh, internally-consistent chain
    // (genesis null, no prev links) — the in-file walk stays clean, but the
    // head at the anchored position no longer matches.
    const forged = [
      JSON.stringify({ event_type: 'forged', prev_hash: null, n: 1 }),
      JSON.stringify({ event_type: 'forged', prev_hash: null, n: 2 }),
      JSON.stringify({ event_type: 'forged', prev_hash: null, n: 3 }),
    ].join('\n');
    writeFileSync(dayFilePath('2026-07-01'), forged + '\n');

    const v = verifyIcoAnchors(workspacePath, anchorPath);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.ok).toBe(false);
    expect(v.value.anchorBreaks.some((b) => b.reason === 'HISTORY_REWRITTEN')).toBe(true);
  });

  it('detects trailing-file truncation (events removed below the anchored count)', () => {
    writeEventsOn('2026-07-01', 4);
    appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });
    // Truncate to 2 lines.
    const twoLines = [
      JSON.stringify({ event_type: 't', prev_hash: null, n: 1 }),
      JSON.stringify({ event_type: 't', prev_hash: 'x', n: 2 }),
    ].join('\n');
    writeFileSync(dayFilePath('2026-07-01'), twoLines + '\n');

    const v = verifyIcoAnchors(workspacePath, anchorPath);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.anchorBreaks.some((b) => b.reason === 'HISTORY_TRUNCATED')).toBe(true);
  });

  it('detects an edited anchor record (anchorHash mismatch)', () => {
    writeEventsOn('2026-07-01', 2);
    appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });
    const anchors = readIcoAnchors(anchorPath).filter((a) => a !== null);
    const tampered = { ...anchors[0]!, totalEvents: 999 };
    writeFileSync(anchorPath, JSON.stringify(tampered) + '\n');

    const v = verifyIcoAnchors(workspacePath, anchorPath);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.anchorBreaks.some((b) => b.reason === 'ANCHOR_HASH_MISMATCH')).toBe(true);
  });

  it('detects a reordered / spliced anchor log (link mismatch)', () => {
    writeEventsOn('2026-07-01', 2);
    appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });
    writeEventsOn('2026-07-02', 2);
    appendIcoAnchor(workspacePath, anchorPath, { workspaceId: 'ws' });
    const anchors = readIcoAnchors(anchorPath).filter((a) => a !== null);
    // Write them in REVERSE order — the first line's prevAnchorHash is now wrong.
    writeFileSync(
      anchorPath,
      [anchors[1]!, anchors[0]!].map((a) => JSON.stringify(a)).join('\n') + '\n',
    );
    const v = verifyIcoAnchors(workspacePath, anchorPath);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.anchorBreaks.some((b) => b.reason === 'ANCHOR_LINK_MISMATCH')).toBe(true);
  });

  it('flags a malformed anchor line', () => {
    writeFileSync(anchorPath, 'not json\n');
    const v = verifyIcoAnchors(workspacePath, anchorPath);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.anchorBreaks.some((b) => b.reason === 'ANCHOR_MALFORMED')).toBe(true);
  });

  it('is clean with no anchor file present', () => {
    writeEventsOn('2026-07-01', 2);
    const v = verifyIcoAnchors(workspacePath, join(tmpRoot, 'absent.jsonl'));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.ok).toBe(true);
  });
});

describe('computeIcoAnchorHash', () => {
  it('is stable for a fixed body and changes with content', () => {
    const body = {
      schemaVersion: 1 as const,
      anchoredAt: '2026-07-01T00:00:00.000Z',
      workspaceId: 'ws',
      totalEvents: 5,
      chainHead: 'abc',
      prevAnchorHash: null,
    };
    expect(computeIcoAnchorHash(body)).toBe(computeIcoAnchorHash(body));
    expect(computeIcoAnchorHash({ ...body, totalEvents: 6 })).not.toBe(computeIcoAnchorHash(body));
  });
});
