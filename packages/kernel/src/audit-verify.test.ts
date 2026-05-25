/**
 * Tests for the audit-chain verifier.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyAuditChain } from './audit-verify.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { writeTrace } from './traces.js';
import { initWorkspace } from './workspace.js';

let workspacePath: string;
let tmpRoot: string;
let db: Database;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ico-audit-verify-'));
  const initResult = initWorkspace('workspace', tmpRoot);
  if (!initResult.ok) throw initResult.error;
  workspacePath = initResult.value.root;
  const dbResult = initDatabase(join(workspacePath, '.ico', 'state.db'));
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;
});

afterEach(() => {
  closeDatabase(db);
  // Use the captured mkdtemp root directly — earlier path arithmetic
  // (split('/').slice(0,-1).join('/')) was fragile and could leak temp
  // dirs or delete the wrong directory if initWorkspace's return shape
  // ever changed. Per code-reviewer subagent finding 2026-05-24.
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('verifyAuditChain', () => {
  it('returns clean result on a fresh workspace with no traces', () => {
    const r = verifyAuditChain(workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filesScanned).toBeGreaterThanOrEqual(0);
    expect(r.value.breaks).toEqual([]);
  });

  it('passes after writing several legitimate trace events', () => {
    for (let i = 0; i < 5; i++) {
      const w = writeTrace(db, workspacePath, 'test.event', { i }, { summary: `Event ${i}` });
      expect(w.ok).toBe(true);
    }
    const r = verifyAuditChain(workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.totalEvents).toBe(5);
    expect(r.value.cleanFiles).toBeGreaterThan(0);
    expect(r.value.breaks).toEqual([]);
  });

  it('detects a tampered middle line', () => {
    for (let i = 0; i < 3; i++) {
      const w = writeTrace(db, workspacePath, 'test.event', { i });
      expect(w.ok).toBe(true);
    }
    // Tamper line 1 (middle) by editing the JSONL file directly.
    const today = new Date().toISOString().slice(0, 10);
    const filepath = join(workspacePath, 'audit', 'traces', `${today}.jsonl`);
    const original = readFileSync(filepath, 'utf-8');
    const lines = original.split('\n').filter((l: string) => l.trim() !== '');
    // Replace one character in the middle line's payload — invalidates the
    // recomputed SHA against line 2's prev_hash.
    const tampered = lines[1]!.replace(/"i":1/, '"i":99');
    lines[1] = tampered;
    writeFileSync(filepath, lines.join('\n') + '\n', 'utf-8');

    const r = verifyAuditChain(workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.length).toBeGreaterThanOrEqual(1);
    // The break is reported on line index 2 — the line whose `prev_hash`
    // no longer matches the tampered line 1's recomputed SHA.
    expect(r.value.breaks[0]!.lineIndex).toBe(2);
  });

  it('detects an unparseable line', () => {
    const w = writeTrace(db, workspacePath, 'test.event', { x: 1 });
    expect(w.ok).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const filepath = join(workspacePath, 'audit', 'traces', `${today}.jsonl`);
    const orig = readFileSync(filepath, 'utf-8');
    writeFileSync(filepath, orig + 'NOT_JSON_GARBAGE\n', 'utf-8');

    const r = verifyAuditChain(workspacePath);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.breaks.length).toBeGreaterThanOrEqual(1);
    expect(r.value.breaks[0]!.excerpt).toMatch(/NOT_JSON_GARBAGE/);
  });
});
