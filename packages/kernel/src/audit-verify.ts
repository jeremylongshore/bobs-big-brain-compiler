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
 *  - Each file `audit/traces/YYYY-MM-DD.jsonl` starts with `prev_hash: null`.
 *  - Each subsequent line's `prev_hash` = SHA-256 hex of the previous line's
 *    full text (UTF-8 bytes of the JSON envelope, not just the payload).
 *  - Chains are PER-FILE — deleting an entire day's file is detectable only
 *    by comparing against the SQLite `traces` index, not by chain walking.
 *    That's an honest v1 limitation; the chain catches in-file tampering.
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
    return ok({ filesScanned: 0, totalEvents: 0, cleanFiles: 0, breaks: [] });
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
      totalEvents++;
      prevLine = raw;
    }
    if (!fileBroken) {
      cleanFiles++;
    }
  }

  return ok({
    filesScanned: files.length,
    totalEvents,
    cleanFiles,
    breaks,
  });
}
