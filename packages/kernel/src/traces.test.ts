import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './state.js';
import { closeDatabase, initDatabase } from './state.js';
import type { TraceRecord } from './traces.js';
import { readTraces, writeTrace } from './traces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hashes a raw string the same way the implementation does. */
function sha256Hex(line: string): string {
  return createHash('sha256').update(line, 'utf-8').digest('hex');
}

/** Returns today's JSONL file path relative to a workspace root. */
function todayJsonlPath(workspacePath: string): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  return join(workspacePath, 'audit', 'traces', `${dateStr}.jsonl`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let workspacePath: string;
let db: Database;

beforeEach(() => {
  // Create a temp workspace with the minimum required directory structure.
  workspacePath = mkdtempSync(join(tmpdir(), 'ico-traces-test-'));
  mkdirSync(join(workspacePath, 'audit', 'traces'), { recursive: true });
  mkdirSync(join(workspacePath, 'audit'), { recursive: true });

  // Use an in-memory SQLite database with the full migration suite applied.
  const result = initDatabase(':memory:');
  if (!result.ok) throw result.error;
  db = result.value;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeTrace — envelope structure
// ---------------------------------------------------------------------------

describe('writeTrace — JSONL file creation', () => {
  it('creates the JSONL file and writes a valid envelope', () => {
    const result = writeTrace(db, workspacePath, 'test.event', { action: 'hello' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const filePath = todayJsonlPath(workspacePath);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);

    const envelope = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(envelope['event_type']).toBe('test.event');
    expect(typeof envelope['event_id']).toBe('string');
    expect(typeof envelope['timestamp']).toBe('string');
    expect(envelope['payload']).toEqual({ action: 'hello' });
  });

  it('appends a trailing newline so each line is self-terminated', () => {
    writeTrace(db, workspacePath, 'test.event', {});

    const filePath = todayJsonlPath(workspacePath);
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeTrace — prev_hash integrity chain
// ---------------------------------------------------------------------------

describe('writeTrace — prev_hash integrity chain', () => {
  it('first event has prev_hash: null', () => {
    const result = writeTrace(db, workspacePath, 'chain.start', { n: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.prev_hash).toBeNull();

    const filePath = todayJsonlPath(workspacePath);
    const line = readFileSync(filePath, 'utf-8').trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['prev_hash']).toBeNull();
  });

  it("second event's prev_hash equals SHA-256 of the first event's JSON line", () => {
    const first = writeTrace(db, workspacePath, 'chain.first', { seq: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const filePath = todayJsonlPath(workspacePath);
    const firstLine = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '')[0]!;
    const expectedHash = sha256Hex(firstLine);

    const second = writeTrace(db, workspacePath, 'chain.second', { seq: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.prev_hash).toBe(expectedHash);
  });
});

// ---------------------------------------------------------------------------
// writeTrace — secret redaction
// ---------------------------------------------------------------------------

describe('writeTrace — payload secret redaction', () => {
  it('redacts an API key in the payload before persisting', () => {
    const result = writeTrace(db, workspacePath, 'api.call', {
      model: 'claude-3',
      apiKey: 'sk-ant-super-secret-12345',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The returned envelope should already have the redacted value.
    const payload = result.value.payload;
    expect(payload['apiKey']).toBe('[REDACTED]');
    expect(payload['model']).toBe('claude-3');

    // The JSONL file must also contain only the redacted form.
    const filePath = todayJsonlPath(workspacePath);
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).not.toContain('sk-ant-super-secret-12345');
    expect(raw).toContain('[REDACTED]');
  });

  it('redacts a token field in the payload', () => {
    const result = writeTrace(db, workspacePath, 'auth.check', {
      token: 'Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = result.value.payload;
    expect(payload['token']).toBe('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// writeTrace → readTraces — SQLite indexing
// ---------------------------------------------------------------------------

describe('writeTrace + readTraces — SQLite index', () => {
  it('indexes the event so readTraces can retrieve it', () => {
    const writeResult = writeTrace(db, workspacePath, 'index.test', { x: 1 });
    expect(writeResult.ok).toBe(true);
    if (!writeResult.ok) return;

    const envelope = writeResult.value;

    const readResult = readTraces(db);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) return;

    const records = readResult.value;
    expect(records).toHaveLength(1);

    const record = records[0] as TraceRecord;
    expect(record.id).toBe(envelope.event_id);
    expect(record.event_type).toBe('index.test');
    expect(record.timestamp).toBe(envelope.timestamp);
    expect(record.file_path).toMatch(/audit[/\\]traces[/\\]\d{4}-\d{2}-\d{2}\.jsonl/);
    expect(record.line_offset).toBe(0); // first event — no bytes before it
  });

  it('records line_offset > 0 for the second event', () => {
    writeTrace(db, workspacePath, 'offset.first', { n: 1 });

    const filePath = todayJsonlPath(workspacePath);
    const firstLineBytes = Buffer.byteLength(readFileSync(filePath, 'utf-8'), 'utf-8');

    writeTrace(db, workspacePath, 'offset.second', { n: 2 });

    const readResult = readTraces(db);
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) return;

    const records = readResult.value;
    expect(records).toHaveLength(2);

    const second = records[1] as TraceRecord;
    expect(second.line_offset).toBe(firstLineBytes);
  });
});

// ---------------------------------------------------------------------------
// readTraces — filters
// ---------------------------------------------------------------------------

describe('readTraces — event_type filter', () => {
  it('returns only events matching the requested event_type', () => {
    writeTrace(db, workspacePath, 'type.alpha', {});
    writeTrace(db, workspacePath, 'type.beta', {});
    writeTrace(db, workspacePath, 'type.alpha', {});

    const result = readTraces(db, { eventType: 'type.alpha' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    for (const record of result.value) {
      expect(record.event_type).toBe('type.alpha');
    }
  });

  it('returns an empty array when no events match the event_type', () => {
    writeTrace(db, workspacePath, 'type.present', {});

    const result = readTraces(db, { eventType: 'type.absent' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(0);
  });
});

describe('readTraces — correlation_id filter', () => {
  it('returns only events matching the requested correlation_id', () => {
    const cid = 'a1b2c3d4-0000-0000-0000-000000000001';

    writeTrace(db, workspacePath, 'corr.match', {}, { correlationId: cid });
    writeTrace(db, workspacePath, 'corr.no-match', {});
    writeTrace(db, workspacePath, 'corr.match', {}, { correlationId: cid });

    const result = readTraces(db, { correlationId: cid });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    for (const record of result.value) {
      expect(record.correlation_id).toBe(cid);
    }
  });
});

describe('readTraces — limit', () => {
  it('respects the limit option', () => {
    writeTrace(db, workspacePath, 'limit.ev', {});
    writeTrace(db, workspacePath, 'limit.ev', {});
    writeTrace(db, workspacePath, 'limit.ev', {});

    const result = readTraces(db, { limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
  });
});

describe('readTraces — ordering', () => {
  it('returns events ordered by timestamp ascending', () => {
    writeTrace(db, workspacePath, 'order.ev', { n: 1 });
    writeTrace(db, workspacePath, 'order.ev', { n: 2 });
    writeTrace(db, workspacePath, 'order.ev', { n: 3 });

    const result = readTraces(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const timestamps = result.value.map((r) => r.timestamp);
    const sorted = [...timestamps].sort();
    expect(timestamps).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// audit/log.md
// ---------------------------------------------------------------------------

describe('writeTrace — audit/log.md', () => {
  it('appends a pipe-delimited row to audit/log.md', () => {
    const result = writeTrace(
      db,
      workspacePath,
      'log.test',
      {},
      {
        summary: 'testing log append',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const logPath = join(workspacePath, 'audit', 'log.md');
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('log.test');
    expect(content).toContain('testing log append');
  });

  it('uses event_type as the summary column when no summary is provided', () => {
    writeTrace(db, workspacePath, 'log.no-summary', {});

    const logPath = join(workspacePath, 'audit', 'log.md');
    const content = readFileSync(logPath, 'utf-8');
    // The summary column should fall back to the event_type string.
    const occurrences = (content.match(/log\.no-summary/g) ?? []).length;
    // event_type appears at minimum once in the Operation column and once in
    // the Summary column (the fallback).
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('creates log.md with headers when it does not yet exist', () => {
    writeTrace(db, workspacePath, 'log.init', {});

    const logPath = join(workspacePath, 'audit', 'log.md');
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('# ICO Audit Log');
    expect(content).toContain('| Timestamp | Operation | Summary |');
  });
});
