/**
 * Provenance tracking for the ICO audit layer (L6).
 *
 * Records the derivation chain between source inputs and compiled outputs.
 * Each provenance record captures: "this output was derived from this input
 * via this operation." Records are dual-written to:
 *
 *   1. JSONL files at `audit/provenance/<sourceId>.jsonl`
 *   2. The `traces` SQLite table (event_type: 'provenance.record')
 *
 * All functions return `Result<T, Error>` — never throw.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

import { writeTrace } from './traces.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single provenance record describing the derivation of one output file
 * from one source input via a named compiler operation.
 */
export interface ProvenanceRecord {
  /** UUID v4 identifying this record. */
  id: string;
  /** UUID of the source that produced this output. */
  sourceId: string;
  /** Relative path to the derived file (e.g. `wiki/sources/foo.md`). */
  outputPath: string;
  /** Semantic category of the output (e.g. `'summary'`, `'concept'`, `'topic'`). */
  outputType: string;
  /** Dot-namespaced compiler operation (e.g. `'compile.summarize'`). */
  operation: string;
  /** ISO 8601 UTC timestamp of when this record was written. */
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Absolute path to the provenance directory within a workspace. */
function provenanceDir(workspacePath: string): string {
  return join(workspacePath, 'audit', 'provenance');
}

/** Absolute path to the JSONL file for a given sourceId. */
function provenanceFilePath(workspacePath: string, sourceId: string): string {
  return join(provenanceDir(workspacePath), `${sourceId}.jsonl`);
}

/**
 * Parses a JSONL file into an array of ProvenanceRecord objects, silently
 * skipping malformed lines. Returns an empty array if the file does not exist.
 */
function parseJsonlFile(filePath: string): ProvenanceRecord[] {
  if (!existsSync(filePath)) return [];

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const records: ProvenanceRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed) as ProvenanceRecord);
    } catch {
      // Malformed line — skip rather than fail the whole file.
    }
  }

  return records;
}

/** Sorts ProvenanceRecord[] by `recordedAt` ascending (lexicographic on ISO strings). */
function sortByRecordedAt(records: ProvenanceRecord[]): ProvenanceRecord[] {
  return [...records].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a provenance relationship: "source `sourceId` produced `outputPath`
 * via `operation`."
 *
 * Steps:
 *  1. Generates a UUID v4 `id` and an ISO 8601 `recordedAt` timestamp.
 *  2. Appends the JSON record as a single line to
 *     `audit/provenance/<sourceId>.jsonl`, creating the file and directory if
 *     they do not exist.
 *  3. Writes a `provenance.record` trace event via `writeTrace`.
 *  4. Returns the completed `ProvenanceRecord`.
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param params        - Fields describing the derivation relationship.
 * @returns `ok(record)` on success, or `err(Error)` on any failure.
 */
export function recordProvenance(
  db: Database,
  workspacePath: string,
  params: {
    sourceId: string;
    outputPath: string;
    outputType: string;
    operation: string;
  },
): Result<ProvenanceRecord, Error> {
  try {
    const id = randomUUID();
    const recordedAt = new Date().toISOString();

    const record: ProvenanceRecord = {
      id,
      sourceId: params.sourceId,
      outputPath: params.outputPath,
      outputType: params.outputType,
      operation: params.operation,
      recordedAt,
    };

    // Ensure the provenance directory exists (idempotent).
    mkdirSync(provenanceDir(workspacePath), { recursive: true });

    // Append to the per-source JSONL file.
    const filePath = provenanceFilePath(workspacePath, params.sourceId);
    appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');

    // Write a trace event so the provenance record appears in the audit trail.
    const traceResult = writeTrace(db, workspacePath, 'provenance.record', {
      sourceId: params.sourceId,
      outputPath: params.outputPath,
      outputType: params.outputType,
      operation: params.operation,
    });

    if (!traceResult.ok) {
      return err(traceResult.error);
    }

    return ok(record);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Forward lookup: "which sources produced this output?"
 *
 * Scans all `.jsonl` files in `audit/provenance/` and returns every record
 * whose `outputPath` matches the requested value, ordered by `recordedAt`
 * ascending.
 *
 * @param db            - Open better-sqlite3 database (unused for the JSONL
 *                        scan, present for API symmetry and future extension).
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param outputPath    - The derived file path to look up.
 * @returns `ok(records)` — an empty array when no records match.
 */
export function getProvenance(
  _db: Database,
  workspacePath: string,
  outputPath: string,
): Result<ProvenanceRecord[], Error> {
  try {
    const dir = provenanceDir(workspacePath);

    if (!existsSync(dir)) {
      return ok([]);
    }

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    const matching: ProvenanceRecord[] = [];

    for (const file of files) {
      const records = parseJsonlFile(join(dir, file));
      for (const record of records) {
        if (record.outputPath === outputPath) {
          matching.push(record);
        }
      }
    }

    return ok(sortByRecordedAt(matching));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Reverse lookup: "what was derived from this source?"
 *
 * Reads `audit/provenance/<sourceId>.jsonl` and returns all records, ordered
 * by `recordedAt` ascending.
 *
 * @param db            - Open better-sqlite3 database (unused for the JSONL
 *                        read, present for API symmetry and future extension).
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param sourceId      - UUID of the source whose derivations to look up.
 * @returns `ok(records)` — an empty array when the source has no derivations.
 */
export function getDerivations(
  _db: Database,
  workspacePath: string,
  sourceId: string,
): Result<ProvenanceRecord[], Error> {
  try {
    const filePath = provenanceFilePath(workspacePath, sourceId);
    const records = parseJsonlFile(filePath);
    return ok(sortByRecordedAt(records));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
