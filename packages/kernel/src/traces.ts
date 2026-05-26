/**
 * Trace event writer for the ICO audit layer (L6).
 *
 * Writes append-only JSONL envelopes to `audit/traces/YYYY-MM-DD.jsonl` and
 * indexes each event in the `traces` SQLite table. The integrity chain is
 * maintained via `prev_hash` — the SHA-256 hex digest of the previous line's
 * raw bytes.
 *
 * All functions return `Result<T, Error>` — never throw.
 */

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';

import type { TraceEnvelope } from '@ico/types';
import { err, ok, type Result } from '@ico/types';

import { redactSecrets } from './config.js';
import { sha256Hex } from './crypto.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A row from the `traces` SQLite index table.
 * `line_offset` is the byte offset of the envelope within the JSONL file.
 */
export interface TraceRecord {
  id: string;
  event_type: string;
  correlation_id: string | null;
  timestamp: string;
  file_path: string;
  line_offset: number;
  summary: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns `YYYY-MM-DD` for the current UTC date. */
function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Reads the last non-empty line from a file.
 * Returns `null` if the file doesn't exist, is empty, or contains only
 * whitespace lines.
 */
function readLastLine(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // Split on newlines, drop empty trailing entries
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;

  return lines[lines.length - 1] ?? null;
}

/**
 * Appends a row to `audit/log.md`. Creates the file with headers if it does
 * not exist. Never throws — failures are silently swallowed because the audit
 * log is a convenience view, not the authoritative record.
 */
function appendToAuditLog(
  workspacePath: string,
  timestamp: string,
  eventType: string,
  summary: string | null | undefined,
): void {
  const logPath = join(workspacePath, 'audit', 'log.md');
  const label = summary ?? eventType;
  const row = `| ${timestamp} | ${eventType} | ${label} |\n`;

  try {
    if (!existsSync(logPath)) {
      const header = [
        '# ICO Audit Log',
        '',
        '| Timestamp | Operation | Summary |',
        '|-----------|-----------|---------|',
        '',
      ].join('\n');
      writeFileSync(logPath, header, 'utf-8');
    }
    appendFileSync(logPath, row, 'utf-8');
  } catch {
    // Non-fatal — log append failures must not block event writing.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Writes a trace event to the JSONL audit file and indexes it in SQLite.
 *
 * Steps:
 *  1. Generates `event_id` (UUID v4) and `timestamp` (ISO 8601 UTC).
 *  2. Redacts secrets from `payload`.
 *  3. Computes `prev_hash` from the last line of today's JSONL file.
 *  4. Serialises the envelope to a single JSON line.
 *  5. Captures the current file size as `line_offset`, then appends the line.
 *  6. Inserts an index row into the `traces` SQLite table.
 *  7. Appends a row to `audit/log.md`.
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param eventType     - Dot-namespaced event identifier, e.g. `"source.ingest"`.
 * @param payload       - Arbitrary key/value metadata. Secrets are auto-redacted.
 * @param options       - Optional `correlationId` (UUID) and human-readable `summary`.
 * @returns `ok(envelope)` on success, or `err(Error)` on any failure.
 */
export function writeTrace(
  db: Database,
  workspacePath: string,
  eventType: string,
  payload: Record<string, unknown>,
  options?: { correlationId?: string; summary?: string },
): Result<TraceEnvelope, Error> {
  try {
    const event_id = randomUUID();
    const timestamp = new Date().toISOString();
    const correlation_id = options?.correlationId ?? null;
    const summary = options?.summary ?? null;

    // Redact secrets before persisting.
    const safePayload = redactSecrets(payload);

    // Determine today's JSONL file path (relative and absolute).
    const dateStr = utcDateString();
    const relativeFilePath = join('audit', 'traces', `${dateStr}.jsonl`);
    const absoluteFilePath = join(workspacePath, relativeFilePath);

    // Ensure the traces directory exists (idempotent).
    const tracesDir = join(workspacePath, 'audit', 'traces');
    mkdirSync(tracesDir, { recursive: true });

    // Critical section: prev_hash computation + JSONL append + SQL index
    // insert must be serialized across processes. Without this, two concurrent
    // writers read the same last line, compute identical prev_hash, and both
    // append — the hash chain breaks and `verifyAuditChain` flags the
    // discontinuity. SQLite's EXCLUSIVE transaction acquires a cross-process
    // file lock for the duration of the wrapped function (better-sqlite3
    // holds the lock for ALL work inside, not just the SQL ops). See bead
    // intentional-cognition-os-lhm + the audit-chain correctness note in
    // 000-docs/037 § "Correction (2026-05-26)".
    const insertStmt = db.prepare<
      [string, string, string | null, string, string, number, string | null],
      void
    >(
      `INSERT INTO traces (id, event_type, correlation_id, timestamp, file_path, line_offset, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const writeAndIndex = db.transaction((): TraceEnvelope => {
      const lastLine = readLastLine(absoluteFilePath);
      const prev_hash = lastLine !== null ? sha256Hex(lastLine) : null;

      const envelope: TraceEnvelope = {
        timestamp,
        event_type: eventType,
        event_id,
        correlation_id,
        payload: safePayload,
        prev_hash,
      };

      const jsonLine = JSON.stringify(envelope);

      let line_offset = 0;
      if (existsSync(absoluteFilePath)) {
        try {
          line_offset = statSync(absoluteFilePath).size;
        } catch {
          line_offset = 0;
        }
      }

      appendFileSync(absoluteFilePath, jsonLine + '\n', 'utf-8');

      insertStmt.run(
        event_id,
        eventType,
        correlation_id,
        timestamp,
        relativeFilePath,
        line_offset,
        summary,
      );

      return envelope;
    });

    // `.exclusive()` is a method on the transaction object that runs the
    // wrapped function under SQLite's EXCLUSIVE lock (vs default DEFERRED).
    // It returns the function's return value directly.
    const envelope = writeAndIndex.exclusive();

    // Best-effort: the markdown audit log lives in a separate file and is
    // not part of the integrity chain. Append outside the critical section
    // to keep the lock short.
    appendToAuditLog(workspacePath, timestamp, eventType, summary);

    return ok(envelope);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Queries the `traces` index table with optional filters.
 *
 * @param db      - Open better-sqlite3 database.
 * @param filters - Optional `eventType`, `correlationId`, and `limit` (default: all rows).
 * @returns `ok(records[])` ordered by ascending timestamp, or `err(Error)`.
 */
export function readTraces(
  db: Database,
  filters?: {
    eventType?: string;
    correlationId?: string;
    limit?: number;
  },
): Result<TraceRecord[], Error> {
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters?.eventType !== undefined) {
      conditions.push('event_type = ?');
      params.push(filters.eventType);
    }

    if (filters?.correlationId !== undefined) {
      conditions.push('correlation_id = ?');
      params.push(filters.correlationId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filters?.limit !== undefined ? `LIMIT ?` : '';
    if (filters?.limit !== undefined) {
      params.push(filters.limit);
    }

    const sql = `
      SELECT id, event_type, correlation_id, timestamp, file_path, line_offset, summary
      FROM traces
      ${where}
      ORDER BY timestamp ASC
      ${limitClause}
    `.trim();

    const rows = db.prepare<(string | number)[], TraceRecord>(sql).all(...params);

    return ok(rows);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
