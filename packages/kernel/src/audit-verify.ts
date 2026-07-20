/**
 * Audit-trail integrity verifier — walks the per-day JSONL trace files in
 * `audit/traces/` and confirms each event's `prev_hash` matches the SHA-256
 * of the previous line.
 *
 * The audit hash-chain is the trust anchor for the deterministic / proba-
 * bilistic boundary the 034-AT-NTRP thesis (§3.4, §5.1) argues for; the
 * adversarial review (Longshore 2026c) flagged that the chain was tamper-
 * evident in design but had no verification code anywhere. This module
 * closes that gap (bead `intentional-cognition-os-ziz.4`, CISO seat §2.5(1)
 * of 035-AT-DECR).
 *
 * Chain semantics (matching the `writeTrace` writer in `traces.ts`):
 *  - Each line's `prev_hash` = SHA-256 hex of the previous line's full text
 *    (UTF-8 bytes of the JSON envelope, not just the payload).
 *  - The chain SPANS DAY BOUNDARIES (G3): the first line of each day file
 *    links to the last line of the most recent earlier day file, so deleting
 *    an entire mid-chain day file is detectable by this file-walk alone —
 *    the next day's boundary link no longer matches. (Deleting the newest
 *    trailing file(s) is still undetectable by file-walk; the external
 *    chain-head anchor covers that.)
 *  - Genesis — the very first day file — starts with `prev_hash: null`.
 *  - CARRIED EXCEPTION: day files written before cross-day chaining shipped
 *    start with `prev_hash: null` even when an earlier day exists. Those
 *    pre-existing unlinked boundaries are counted in `legacyBoundaries` and
 *    reported, but are NOT breaks — the trace files are append-only by
 *    protocol and are never re-hashed or rewritten to backfill links.
 *    (A forged null boundary cannot silently splice history: editing an
 *    existing first line changes its bytes and breaks the in-file chain at
 *    line 2, and wholesale re-hashed forgeries are outside the local trust
 *    model — that is what the external anchor is for.)
 *
 * @module audit-verify
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { err, ok, type Result } from '@ico/types';

import { sha256Hex } from './crypto.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-file finding from the chain walk. */
export interface AuditChainBreak {
  /** Filename within `audit/traces/`, e.g. `2026-05-24.jsonl`. */
  file: string;
  /** Zero-indexed line number where the chain breaks. */
  lineIndex: number;
  /** What was expected vs what was found in `prev_hash`. */
  expectedPrevHash: string | null;
  actualPrevHash: string | null;
  /** Optional excerpt of the offending line (truncated to 120 chars). */
  excerpt: string;
}

/** Aggregate result of an audit-chain verify pass. */
export interface AuditVerifyResult {
  /** Number of JSONL files walked. */
  filesScanned: number;
  /** Total event count across all files. */
  totalEvents: number;
  /** Files that parsed cleanly with intact chain. */
  cleanFiles: number;
  /** Chain breaks — empty array means the audit log is unbroken. */
  breaks: AuditChainBreak[];
  /**
   * Day boundaries whose first line correctly links to the previous day's
   * last line (cross-day chaining, G3).
   */
  linkedBoundaries: number;
  /**
   * Day boundaries starting with `prev_hash: null` although an earlier day
   * file exists — files written before cross-day chaining shipped. Reported
   * as a documented carried exception, never counted as breaks and never
   * rewritten.
   */
  legacyBoundaries: number;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface ParsedLine {
  /** Raw text of the JSONL line (no trailing newline). */
  raw: string;
  /** Parsed `prev_hash` field; null if missing or explicitly null. */
  prevHash: string | null;
}

function parseLine(raw: string): ParsedLine | null {
  try {
    const obj = JSON.parse(raw) as { prev_hash?: string | null };
    const prevHash = typeof obj.prev_hash === 'string' ? obj.prev_hash : null;
    return { raw, prevHash };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify the audit-chain integrity for a workspace.
 *
 * @param workspacePath  Absolute path to the workspace root.
 * @returns `ok(AuditVerifyResult)` — operator inspects `breaks.length === 0`
 *          to decide pass/fail. `err(Error)` only on filesystem failures
 *          (the chain itself reports breaks via the result, not via err).
 */
export function verifyAuditChain(workspacePath: string): Result<AuditVerifyResult, Error> {
  const tracesDir = join(workspacePath, 'audit', 'traces');
  if (!existsSync(tracesDir)) {
    return ok({
      filesScanned: 0,
      totalEvents: 0,
      cleanFiles: 0,
      breaks: [],
      linkedBoundaries: 0,
      legacyBoundaries: 0,
    });
  }

  let files: string[];
  try {
    files = readdirSync(tracesDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const breaks: AuditChainBreak[] = [];
  let totalEvents = 0;
  let cleanFiles = 0;
  let linkedBoundaries = 0;
  let legacyBoundaries = 0;

  // Last raw line of the previous non-empty day file — the cross-day link
  // target for the next file's first line. Filenames are `YYYY-MM-DD.jsonl`,
  // so the lexicographic sort above walks files chronologically.
  let prevFileLastLine: string | null = null;

  for (const filename of files) {
    const filepath = join(tracesDir, filename);
    let content: string;
    try {
      content = readFileSync(filepath, 'utf-8');
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    // Trace files are JSONL — split, drop empty lines, walk in order.
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) {
      // An empty file contributes nothing to the chain; the boundary link
      // carries across it: `prevFileLastLine` deliberately keeps the last
      // line of the last NON-EMPTY file. This mirrors the writer —
      // `readLastLineOfPreviousDay` in traces.ts skips empty day files the
      // same way — so a day following an empty file links to the last
      // non-empty predecessor on both sides and is never misclassified as
      // a legacy boundary or a break.
      cleanFiles++;
      continue;
    }

    let prevLine: string | null = null;
    let fileBroken = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const parsed = parseLine(raw);
      if (parsed === null) {
        breaks.push({
          file: basename(filename),
          lineIndex: i,
          expectedPrevHash: prevLine !== null ? sha256Hex(prevLine) : null,
          actualPrevHash: null,
          excerpt: raw.slice(0, 120),
        });
        fileBroken = true;
        // Can't recompute next prev_hash if this line is unparseable; abort file.
        break;
      }

      if (i === 0) {
        // Day-boundary check (G3). Three cases when an earlier day exists:
        //  - links to the previous day's last line → intact cross-day chain;
        //  - `null` → legacy boundary (file written before cross-day
        //    chaining shipped) — documented carried exception, NOT a break;
        //  - anything else → break. This is exactly what a deleted mid-chain
        //    day file looks like: the first line still links to the last
        //    line of the day that vanished, which no longer matches the
        //    (older) surviving predecessor.
        if (prevFileLastLine !== null) {
          const expectedBoundary = sha256Hex(prevFileLastLine);
          if (parsed.prevHash === expectedBoundary) {
            linkedBoundaries++;
          } else if (parsed.prevHash === null) {
            legacyBoundaries++;
          } else {
            breaks.push({
              file: basename(filename),
              lineIndex: 0,
              expectedPrevHash: expectedBoundary,
              actualPrevHash: parsed.prevHash,
              excerpt: raw.slice(0, 120),
            });
            fileBroken = true;
          }
        } else if (parsed.prevHash !== null) {
          // First file in the walk but it links to something we can't see:
          // its predecessor day file is gone. Break.
          breaks.push({
            file: basename(filename),
            lineIndex: 0,
            expectedPrevHash: null,
            actualPrevHash: parsed.prevHash,
            excerpt: raw.slice(0, 120),
          });
          fileBroken = true;
        }
      } else {
        const expected = prevLine !== null ? sha256Hex(prevLine) : null;
        if (parsed.prevHash !== expected) {
          breaks.push({
            file: basename(filename),
            lineIndex: i,
            expectedPrevHash: expected,
            actualPrevHash: parsed.prevHash,
            excerpt: raw.slice(0, 120),
          });
          fileBroken = true;
          // Continue walking and re-anchor on the (potentially tampered) raw
          // line as the new baseline. This means after a mismatch we report
          // ONE break and then resume clean-chain expectations against the
          // tampered line as the new prev. Multi-line tampers in adjacent
          // positions will report only the first break, not every break —
          // honest accounting of "this file has at least one tamper, here's
          // the first offset" rather than "complete damage report." For full
          // forensics, walk the file again starting from the reported break.
        }
      }
      totalEvents++;
      prevLine = raw;
    }
    if (!fileBroken) {
      cleanFiles++;
    }
    if (prevLine !== null) {
      prevFileLastLine = prevLine;
    }
  }

  return ok({
    filesScanned: files.length,
    totalEvents,
    cleanFiles,
    breaks,
    linkedBoundaries,
    legacyBoundaries,
  });
}
