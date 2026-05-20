import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getDerivations,
  getProvenance,
  type ProvenanceRecord,
  recordProvenance,
} from './provenance.js';
import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import { readTraces } from './traces.js';
import { initWorkspace } from './workspace.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workspacePath: string;
let db: Database;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-provenance-test-'));

  // initWorkspace creates the full directory tree including audit/provenance/.
  const wsResult = initWorkspace('ws', base);
  if (!wsResult.ok) throw wsResult.error;
  const ws = wsResult.value;

  workspacePath = ws.root;

  const dbResult = initDatabase(ws.dbPath);
  if (!dbResult.ok) throw dbResult.error;
  db = dbResult.value;
});

afterEach(() => {
  closeDatabase(db);
  // Clean up the temp base directory (parent of workspacePath).
  const base = join(workspacePath, '..');
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// recordProvenance — JSONL file
// ---------------------------------------------------------------------------

describe('recordProvenance — JSONL file creation', () => {
  it('creates the per-source JSONL file with the correct record structure', () => {
    const sourceId = crypto.randomUUID();

    const result = recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/sources/intro.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const record = result.value;

    // UUID v4 pattern
    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(record.sourceId).toBe(sourceId);
    expect(record.outputPath).toBe('wiki/sources/intro.md');
    expect(record.outputType).toBe('summary');
    expect(record.operation).toBe('compile.summarize');
    expect(() => new Date(record.recordedAt)).not.toThrow();

    // JSONL file must exist
    const filePath = join(workspacePath, 'audit', 'provenance', `${sourceId}.jsonl`);
    expect(existsSync(filePath)).toBe(true);

    // File must contain exactly one JSON line matching the returned record
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as ProvenanceRecord;
    expect(parsed).toEqual(record);
  });

  it('appends a trailing newline so each line is self-terminated', () => {
    const sourceId = crypto.randomUUID();

    recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/sources/a.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });

    const filePath = join(workspacePath, 'audit', 'provenance', `${sourceId}.jsonl`);
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('appends multiple records for the same source to the same file', () => {
    const sourceId = crypto.randomUUID();

    recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/sources/a.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/concepts/alpha.md',
      outputType: 'concept',
      operation: 'compile.extract',
    });

    const filePath = join(workspacePath, 'audit', 'provenance', `${sourceId}.jsonl`);
    const lines = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// recordProvenance — trace event
// ---------------------------------------------------------------------------

describe('recordProvenance — trace event', () => {
  it('writes a provenance.record trace event to the traces table', () => {
    const sourceId = crypto.randomUUID();

    const result = recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/sources/traced.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });

    expect(result.ok).toBe(true);

    const tracesResult = readTraces(db, { eventType: 'provenance.record' });
    expect(tracesResult.ok).toBe(true);
    if (!tracesResult.ok) return;

    expect(tracesResult.value).toHaveLength(1);
    expect(tracesResult.value[0]!.event_type).toBe('provenance.record');
  });

  it('writes one trace event per recordProvenance call', () => {
    const sourceId = crypto.randomUUID();

    recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/sources/a.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/concepts/b.md',
      outputType: 'concept',
      operation: 'compile.extract',
    });

    const tracesResult = readTraces(db, { eventType: 'provenance.record' });
    expect(tracesResult.ok).toBe(true);
    if (!tracesResult.ok) return;

    expect(tracesResult.value).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getProvenance — forward lookup
// ---------------------------------------------------------------------------

describe('getProvenance — forward lookup', () => {
  it('finds records for a given outputPath across multiple source files', () => {
    const sourceA = crypto.randomUUID();
    const sourceB = crypto.randomUUID();
    const sharedOutput = 'wiki/topics/shared-topic.md';

    recordProvenance(db, workspacePath, {
      sourceId: sourceA,
      outputPath: sharedOutput,
      outputType: 'topic',
      operation: 'compile.synthesize',
    });
    recordProvenance(db, workspacePath, {
      sourceId: sourceB,
      outputPath: sharedOutput,
      outputType: 'topic',
      operation: 'compile.synthesize',
    });
    // Unrelated record for sourceA — should not appear
    recordProvenance(db, workspacePath, {
      sourceId: sourceA,
      outputPath: 'wiki/sources/a-only.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });

    const result = getProvenance(db, workspacePath, sharedOutput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    const sourceIds = result.value.map((r) => r.sourceId);
    expect(sourceIds).toContain(sourceA);
    expect(sourceIds).toContain(sourceB);
    for (const record of result.value) {
      expect(record.outputPath).toBe(sharedOutput);
    }
  });

  it('returns records ordered by recordedAt ascending', async () => {
    const sourceA = crypto.randomUUID();
    const sourceB = crypto.randomUUID();
    const output = 'wiki/topics/ordered.md';

    recordProvenance(db, workspacePath, {
      sourceId: sourceA,
      outputPath: output,
      outputType: 'topic',
      operation: 'compile.synthesize',
    });
    // Tiny pause so timestamps differ reliably.
    await new Promise((resolve) => setTimeout(resolve, 5));
    recordProvenance(db, workspacePath, {
      sourceId: sourceB,
      outputPath: output,
      outputType: 'topic',
      operation: 'compile.synthesize',
    });

    const result = getProvenance(db, workspacePath, output);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    const [first, second] = result.value as [ProvenanceRecord, ProvenanceRecord];
    expect(first.recordedAt <= second.recordedAt).toBe(true);
  });

  it('returns an empty array for an unknown outputPath', () => {
    // Write an unrelated record so there is at least one JSONL file to scan.
    recordProvenance(db, workspacePath, {
      sourceId: crypto.randomUUID(),
      outputPath: 'wiki/sources/something.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });

    const result = getProvenance(db, workspacePath, 'wiki/topics/ghost.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getDerivations — reverse lookup
// ---------------------------------------------------------------------------

describe('getDerivations — reverse lookup', () => {
  it('returns all outputs derived from a given source', () => {
    const sourceId = crypto.randomUUID();

    recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/sources/main-summary.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/concepts/key-idea.md',
      outputType: 'concept',
      operation: 'compile.extract',
    });

    const result = getDerivations(db, workspacePath, sourceId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    const outputPaths = result.value.map((r) => r.outputPath);
    expect(outputPaths).toContain('wiki/sources/main-summary.md');
    expect(outputPaths).toContain('wiki/concepts/key-idea.md');
    for (const record of result.value) {
      expect(record.sourceId).toBe(sourceId);
    }
  });

  it('returns records ordered by recordedAt ascending', async () => {
    const sourceId = crypto.randomUUID();

    recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/sources/first.md',
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    recordProvenance(db, workspacePath, {
      sourceId,
      outputPath: 'wiki/concepts/second.md',
      outputType: 'concept',
      operation: 'compile.extract',
    });

    const result = getDerivations(db, workspacePath, sourceId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    const [first, second] = result.value as [ProvenanceRecord, ProvenanceRecord];
    expect(first.outputPath).toBe('wiki/sources/first.md');
    expect(second.outputPath).toBe('wiki/concepts/second.md');
    expect(first.recordedAt <= second.recordedAt).toBe(true);
  });

  it('returns an empty array for an unknown sourceId', () => {
    const result = getDerivations(db, workspacePath, crypto.randomUUID());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Chain scenario: multi-source forward and reverse lookups
// ---------------------------------------------------------------------------

describe('chain scenario — source A → summary + topic, source B → summary', () => {
  it('forward and reverse lookups work correctly across the chain', () => {
    const sourceA = crypto.randomUUID();
    const sourceB = crypto.randomUUID();

    const summaryA = 'wiki/sources/a-summary.md';
    const topicAB = 'wiki/topics/shared.md';
    const summaryB = 'wiki/sources/b-summary.md';

    // Source A produces a summary and contributes to a shared topic.
    recordProvenance(db, workspacePath, {
      sourceId: sourceA,
      outputPath: summaryA,
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    recordProvenance(db, workspacePath, {
      sourceId: sourceA,
      outputPath: topicAB,
      outputType: 'topic',
      operation: 'compile.synthesize',
    });

    // Source B produces its own summary and also contributes to the shared topic.
    recordProvenance(db, workspacePath, {
      sourceId: sourceB,
      outputPath: summaryB,
      outputType: 'summary',
      operation: 'compile.summarize',
    });
    recordProvenance(db, workspacePath, {
      sourceId: sourceB,
      outputPath: topicAB,
      outputType: 'topic',
      operation: 'compile.synthesize',
    });

    // Reverse lookup for source A — should have 2 derivations.
    const derivationsA = getDerivations(db, workspacePath, sourceA);
    expect(derivationsA.ok).toBe(true);
    if (!derivationsA.ok) return;
    expect(derivationsA.value).toHaveLength(2);
    const pathsA = derivationsA.value.map((r) => r.outputPath);
    expect(pathsA).toContain(summaryA);
    expect(pathsA).toContain(topicAB);

    // Reverse lookup for source B — should have 2 derivations.
    const derivationsB = getDerivations(db, workspacePath, sourceB);
    expect(derivationsB.ok).toBe(true);
    if (!derivationsB.ok) return;
    expect(derivationsB.value).toHaveLength(2);
    const pathsB = derivationsB.value.map((r) => r.outputPath);
    expect(pathsB).toContain(summaryB);
    expect(pathsB).toContain(topicAB);

    // Forward lookup for summaryA — only source A.
    const provSummaryA = getProvenance(db, workspacePath, summaryA);
    expect(provSummaryA.ok).toBe(true);
    if (!provSummaryA.ok) return;
    expect(provSummaryA.value).toHaveLength(1);
    expect(provSummaryA.value[0]!.sourceId).toBe(sourceA);

    // Forward lookup for summaryB — only source B.
    const provSummaryB = getProvenance(db, workspacePath, summaryB);
    expect(provSummaryB.ok).toBe(true);
    if (!provSummaryB.ok) return;
    expect(provSummaryB.value).toHaveLength(1);
    expect(provSummaryB.value[0]!.sourceId).toBe(sourceB);

    // Forward lookup for shared topic — both sources.
    const provTopic = getProvenance(db, workspacePath, topicAB);
    expect(provTopic.ok).toBe(true);
    if (!provTopic.ok) return;
    expect(provTopic.value).toHaveLength(2);
    const topicSourceIds = provTopic.value.map((r) => r.sourceId);
    expect(topicSourceIds).toContain(sourceA);
    expect(topicSourceIds).toContain(sourceB);
  });
});
