/**
 * Extended audit-surface verification (l13.7) — the surfaces `verifyAuditChain`
 * does NOT cover:
 *
 *  1. **Trace-file inventory vs the SQLite index.** Every `writeTrace` inserts
 *     an index row carrying `file_path`, so the DB is an independent record of
 *     which day files must exist and how many events each holds. A day file
 *     that is missing (including the NEWEST trailing file, which the cross-day
 *     chain walk from PR #176 cannot see) or holds fewer lines than the index
 *     says is whole-file deletion / truncation evidence.
 *  2. **Provenance sidecars.** `audit/provenance/<sourceId>.jsonl` records are
 *     unchained, but every `recordProvenance` also wrote a chained
 *     `provenance.record` trace event with the same fields — so the chained
 *     trail is the ground truth the sidecars are re-checked against. A sidecar
 *     record missing for a chained trace event is deletion evidence.
 *  3. **Spool manifests.** Each `spool/*.jsonl` batch has a
 *     `.manifest.json` sidecar carrying its SHA-256; the same digest is frozen
 *     in the chained `spool.emit.complete` trace. Both are re-checked. A spool
 *     file that was consumed (moved away by the INTKB ingester) is NOT a
 *     break; a manifest whose spool file vanished while the manifest stayed is.
 *  4. **`audit/log.md`** is DECLARED convenience-only: it is best-effort,
 *     editable markdown, deliberately outside the tamper-evident surface (its
 *     content is re-derivable from the chained traces). Verify reports its
 *     presence and size but never treats it as evidence.
 *
 * Carried-exception discipline (matching the legacy-boundary handling in
 * `audit-verify.ts`): pre-existing one-sided gaps that append-only protocol
 * forbids repairing — sidecar records written before a crash interrupted the
 * paired trace write, or historical index drift where a file holds MORE lines
 * than the index — are COUNTED and reported, never re-hashed, never rewritten,
 * and never silently promoted to breaks.
 *
 * @module audit-surfaces
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

import { sha256Hex } from './crypto.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A verified failure on one of the extended audit surfaces. */
export interface AuditSurfaceBreak {
  surface: 'trace-index' | 'provenance' | 'spool';
  code:
    | 'TRACE_FILE_MISSING' // indexed day file gone from disk (whole-file deletion)
    | 'TRACE_FILE_TRUNCATED' // fewer lines on disk than index rows
    | 'PROVENANCE_SIDECAR_MISSING' // chained provenance.record with no sidecar record
    | 'PROVENANCE_MALFORMED' // sidecar line is not valid JSON / missing fields
    | 'SPOOL_MANIFEST_MISSING' // spool file present with no manifest sidecar
    | 'SPOOL_MANIFEST_MALFORMED' // manifest is not valid JSON
    | 'SPOOL_FILE_MISSING' // manifest present but its spool file vanished
    | 'SPOOL_HASH_MISMATCH' // spool bytes no longer match the manifest digest
    | 'SPOOL_COUNT_MISMATCH' // spool line count != manifest emittedCount
    | 'SPOOL_TRACE_MISMATCH'; // manifest digest != the chained trace digest
  /** File the finding concerns (basename or relative path). */
  file: string;
  detail: string;
}

/** Aggregate result of the extended-surface verification. */
export interface AuditSurfacesResult {
  /** Distinct day files referenced by the SQLite trace index. */
  indexedTraceFiles: number;
  /** Total events in the SQLite trace index. */
  indexedEvents: number;
  /**
   * Carried exception: on-disk day files (or extra lines) the index does not
   * know about. Insertions are already tamper-evident via the in-file hash
   * chain, so these are reported, not breaks.
   */
  unindexedTraceFiles: number;
  unindexedEvents: number;
  /** Provenance sidecar files / records scanned. */
  provenanceFiles: number;
  provenanceRecords: number;
  /** Chained `provenance.record` trace events found. */
  provenanceTraceEvents: number;
  /**
   * Carried exception: sidecar records with no matching chained trace event
   * (a crash between the sidecar append and the trace write leaves exactly
   * this shape). Reported, never rewritten.
   */
  unreceiptedProvenance: number;
  /** Spool files / manifests checked in the workspace-local spool dir. */
  spoolFilesChecked: number;
  spoolManifestsChecked: number;
  /** log.md status — explicitly OUTSIDE the tamper-evident surface. */
  logMd: { present: boolean; lines: number; convenienceOnly: true };
  /** Verified failures — empty means every covered surface is consistent. */
  breaks: AuditSurfaceBreak[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readNonEmptyLines(filePath: string): string[] | null {
  try {
    return readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '');
  } catch {
    return null;
  }
}

/** Multiset add. */
function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

interface TraceScan {
  /** provenance.record payload multiset keyed sourceId␀outputPath␀operation. */
  provenanceEvents: Map<string, number>;
  provenanceEventCount: number;
  /** spool.emit.complete digests keyed by spool filename. */
  spoolDigests: Map<string, string>;
  /** Non-empty line counts per on-disk day file basename. */
  linesPerFile: Map<string, number>;
}

/** One pass over the on-disk day files, extracting what the checks need. */
function scanTraceFiles(tracesDir: string): TraceScan {
  const scan: TraceScan = {
    provenanceEvents: new Map(),
    provenanceEventCount: 0,
    spoolDigests: new Map(),
    linesPerFile: new Map(),
  };
  if (!existsSync(tracesDir)) return scan;
  const files = readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'));
  for (const filename of files) {
    const lines = readNonEmptyLines(join(tracesDir, filename)) ?? [];
    scan.linesPerFile.set(filename, lines.length);
    for (const line of lines) {
      // Cheap prefilter before the JSON.parse — most events are neither.
      const isProvenance = line.includes('"provenance.record"');
      const isSpoolComplete = line.includes('"spool.emit.complete"');
      if (!isProvenance && !isSpoolComplete) continue;
      try {
        const envelope = JSON.parse(line) as {
          event_type?: string;
          payload?: Record<string, unknown>;
        };
        const payload = envelope.payload ?? {};
        if (envelope.event_type === 'provenance.record') {
          // Only string payload fields form the key; a non-string (or absent)
          // field becomes '' — provenance.record always writes strings, so
          // this is defensive, not lossy.
          const key = [payload['sourceId'], payload['outputPath'], payload['operation']]
            .map((v) => (typeof v === 'string' ? v : ''))
            .join('\x00');
          bump(scan.provenanceEvents, key);
          scan.provenanceEventCount++;
        } else if (envelope.event_type === 'spool.emit.complete') {
          const file = payload['spoolFile'];
          const digest = payload['spoolFileSha256'];
          if (typeof file === 'string' && typeof digest === 'string') {
            scan.spoolDigests.set(file, digest);
          }
        }
      } catch {
        // Unparseable lines are the chain walk's finding, not this one's.
      }
    }
  }
  return scan;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify the extended audit surfaces of a workspace. Complements (does not
 * replace) `verifyAuditChain` — run both; the CLI `ico audit verify` does.
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root.
 */
export function verifyAuditSurfaces(
  db: Database,
  workspacePath: string,
): Result<AuditSurfacesResult, Error> {
  try {
    const breaks: AuditSurfaceBreak[] = [];
    const tracesDir = join(workspacePath, 'audit', 'traces');
    const scan = scanTraceFiles(tracesDir);

    // -----------------------------------------------------------------
    // 1. Trace-file inventory vs the SQLite index
    // -----------------------------------------------------------------
    const indexRows = db
      .prepare<
        [],
        { file_path: string; n: number }
      >(`SELECT file_path, COUNT(*) AS n FROM traces GROUP BY file_path`)
      .all();
    let indexedEvents = 0;
    const indexedBasenames = new Set<string>();
    for (const row of indexRows) {
      indexedEvents += row.n;
      const filename = basename(row.file_path);
      indexedBasenames.add(filename);
      const onDisk = scan.linesPerFile.get(filename);
      if (onDisk === undefined) {
        breaks.push({
          surface: 'trace-index',
          code: 'TRACE_FILE_MISSING',
          file: filename,
          detail: `SQLite index holds ${row.n} event(s) for this day file but it is gone from disk — whole-file deletion evidence`,
        });
      } else if (onDisk < row.n) {
        breaks.push({
          surface: 'trace-index',
          code: 'TRACE_FILE_TRUNCATED',
          file: filename,
          detail: `SQLite index holds ${row.n} event(s) but the file has ${onDisk} line(s) — truncation evidence`,
        });
      }
    }
    let unindexedTraceFiles = 0;
    let unindexedEvents = 0;
    for (const [filename, lines] of scan.linesPerFile) {
      const indexed = indexRows.find((r) => basename(r.file_path) === filename)?.n ?? 0;
      if (!indexedBasenames.has(filename)) {
        unindexedTraceFiles++;
        unindexedEvents += lines;
      } else if (lines > indexed) {
        unindexedEvents += lines - indexed;
      }
    }

    // -----------------------------------------------------------------
    // 2. Provenance sidecars vs chained provenance.record events
    // -----------------------------------------------------------------
    const provenanceDir = join(workspacePath, 'audit', 'provenance');
    const sidecarRecords = new Map<string, number>();
    let provenanceFiles = 0;
    let provenanceRecords = 0;
    if (existsSync(provenanceDir)) {
      for (const filename of readdirSync(provenanceDir).filter((f) => f.endsWith('.jsonl'))) {
        provenanceFiles++;
        const lines = readNonEmptyLines(join(provenanceDir, filename)) ?? [];
        for (let i = 0; i < lines.length; i++) {
          try {
            const record = JSON.parse(lines[i]!) as {
              sourceId?: string;
              outputPath?: string;
              operation?: string;
            };
            if (
              typeof record.sourceId !== 'string' ||
              typeof record.outputPath !== 'string' ||
              typeof record.operation !== 'string'
            ) {
              breaks.push({
                surface: 'provenance',
                code: 'PROVENANCE_MALFORMED',
                file: filename,
                detail: `line ${i}: record is missing sourceId/outputPath/operation`,
              });
              continue;
            }
            provenanceRecords++;
            bump(
              sidecarRecords,
              [record.sourceId, record.outputPath, record.operation].join('\x00'),
            );
          } catch {
            breaks.push({
              surface: 'provenance',
              code: 'PROVENANCE_MALFORMED',
              file: filename,
              detail: `line ${i}: not valid JSON`,
            });
          }
        }
      }
    }
    let unreceiptedProvenance = 0;
    for (const [key, traceCount] of scan.provenanceEvents) {
      const sidecarCount = sidecarRecords.get(key) ?? 0;
      if (sidecarCount < traceCount) {
        const [sourceId, outputPath] = key.split('\x00');
        breaks.push({
          surface: 'provenance',
          code: 'PROVENANCE_SIDECAR_MISSING',
          file: `${sourceId ?? ''}.jsonl`,
          detail:
            `chained trail has ${traceCount} provenance.record event(s) for ` +
            `${outputPath ?? '?'} but the sidecar holds ${sidecarCount} — sidecar deletion evidence`,
        });
      }
    }
    for (const [key, sidecarCount] of sidecarRecords) {
      const traceCount = scan.provenanceEvents.get(key) ?? 0;
      if (sidecarCount > traceCount) {
        // Carried exception: sidecar-append happens before the trace write,
        // so a crash between the two leaves exactly this one-sided shape.
        unreceiptedProvenance += sidecarCount - traceCount;
      }
    }

    // -----------------------------------------------------------------
    // 3. Spool files vs manifests vs chained emit traces
    // -----------------------------------------------------------------
    const spoolDir = join(workspacePath, 'spool');
    let spoolFilesChecked = 0;
    let spoolManifestsChecked = 0;
    if (existsSync(spoolDir)) {
      const entries = readdirSync(spoolDir);
      const spoolFiles = entries.filter((f) => f.endsWith('.jsonl'));
      const manifests = entries.filter((f) => f.endsWith('.manifest.json'));

      for (const filename of spoolFiles) {
        spoolFilesChecked++;
        const manifestName = `${filename}.manifest.json`;
        if (!entries.includes(manifestName)) {
          breaks.push({
            surface: 'spool',
            code: 'SPOOL_MANIFEST_MISSING',
            file: filename,
            detail: 'spool file has no .manifest.json sidecar',
          });
          continue;
        }
      }

      for (const manifestName of manifests) {
        spoolManifestsChecked++;
        const spoolName = manifestName.replace(/\.manifest\.json$/, '');
        let manifest: { spoolFileSha256?: string; emittedCount?: number };
        try {
          manifest = JSON.parse(
            readFileSync(join(spoolDir, manifestName), 'utf-8'),
          ) as typeof manifest;
        } catch {
          breaks.push({
            surface: 'spool',
            code: 'SPOOL_MANIFEST_MALFORMED',
            file: manifestName,
            detail: 'manifest is not valid JSON',
          });
          continue;
        }
        if (!entries.includes(spoolName)) {
          breaks.push({
            surface: 'spool',
            code: 'SPOOL_FILE_MISSING',
            file: spoolName,
            detail:
              'manifest present but its spool file is gone — deletion evidence (a consumed spool moves file AND manifest together)',
          });
          continue;
        }
        let content: string;
        try {
          content = readFileSync(join(spoolDir, spoolName), 'utf-8');
        } catch (e) {
          return err(e instanceof Error ? e : new Error(String(e)));
        }
        const digest = sha256Hex(content);
        if (typeof manifest.spoolFileSha256 === 'string' && digest !== manifest.spoolFileSha256) {
          breaks.push({
            surface: 'spool',
            code: 'SPOOL_HASH_MISMATCH',
            file: spoolName,
            detail: `spool bytes hash ${digest} != manifest ${manifest.spoolFileSha256}`,
          });
        }
        const lineCount = content.split('\n').filter((l) => l.trim() !== '').length;
        if (typeof manifest.emittedCount === 'number' && lineCount !== manifest.emittedCount) {
          breaks.push({
            surface: 'spool',
            code: 'SPOOL_COUNT_MISMATCH',
            file: spoolName,
            detail: `spool has ${lineCount} candidate line(s) but the manifest recorded ${manifest.emittedCount}`,
          });
        }
        const tracedDigest = scan.spoolDigests.get(spoolName);
        if (
          tracedDigest !== undefined &&
          typeof manifest.spoolFileSha256 === 'string' &&
          tracedDigest !== manifest.spoolFileSha256
        ) {
          breaks.push({
            surface: 'spool',
            code: 'SPOOL_TRACE_MISMATCH',
            file: spoolName,
            detail: `manifest digest ${manifest.spoolFileSha256} != chained spool.emit.complete digest ${tracedDigest}`,
          });
        }
      }
    }

    // -----------------------------------------------------------------
    // 4. log.md — declared convenience-only, reported but never evidence
    // -----------------------------------------------------------------
    const logPath = join(workspacePath, 'audit', 'log.md');
    const logLines = existsSync(logPath) ? (readNonEmptyLines(logPath)?.length ?? 0) : 0;

    return ok({
      indexedTraceFiles: indexRows.length,
      indexedEvents,
      unindexedTraceFiles,
      unindexedEvents,
      provenanceFiles,
      provenanceRecords,
      provenanceTraceEvents: scan.provenanceEventCount,
      unreceiptedProvenance,
      spoolFilesChecked,
      spoolManifestsChecked,
      logMd: { present: existsSync(logPath), lines: logLines, convenienceOnly: true },
      breaks,
    });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
