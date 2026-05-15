/**
 * Smoke eval handler (E10-B01).
 *
 * Deterministic invariants over workspace state. Each named check is a
 * cheap boolean assertion. Smoke evals are intentionally narrow — they
 * exist so the eval framework can run end-to-end against a fresh
 * workspace without needing a Claude key or seeded fixtures.
 *
 * Checks:
 *   - `fts5-index-nonempty` — `pages_fts` table contains at least one row.
 *     Trips when the operator has compiled nothing yet.
 *   - `no-failed-tasks` — zero `tasks` rows in any `failed_*` status.
 *   - `audit-chain-intact` — every trace row's stored prev_hash matches
 *     the SHA-256 of the previous row's JSONL line. Detects tampering
 *     with the append-only audit log.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

import type { EvalResult, SmokeEvalSpec } from '../types.js';

export function runSmokeEval(
  db: Database,
  workspacePath: string,
  spec: SmokeEvalSpec,
): Result<EvalResult, Error> {
  const start = Date.now();
  const threshold = spec.threshold ?? 1;

  let passed: boolean;
  let details: string;

  switch (spec.check) {
    case 'fts5-index-nonempty': {
      const r = checkFtsNonEmpty(db);
      if (!r.ok) return err(r.error);
      passed = r.value.passed;
      details = r.value.details;
      break;
    }
    case 'no-failed-tasks': {
      const r = checkNoFailedTasks(db);
      if (!r.ok) return err(r.error);
      passed = r.value.passed;
      details = r.value.details;
      break;
    }
    case 'audit-chain-intact': {
      const r = checkAuditChainIntact(db, workspacePath);
      if (!r.ok) return err(r.error);
      passed = r.value.passed;
      details = r.value.details;
      break;
    }
  }

  return ok({
    spec,
    passed,
    score: passed ? 1 : 0,
    threshold,
    details,
    durationMs: Date.now() - start,
  });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface CheckOutcome {
  passed: boolean;
  details: string;
}

function checkFtsNonEmpty(db: Database): Result<CheckOutcome, Error> {
  try {
    const row = db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM pages_fts')
      .get();
    const n = row?.n ?? 0;
    return ok({
      passed: n > 0,
      details:
        n > 0
          ? `pages_fts has ${n} rows`
          : 'pages_fts is empty — run `ico compile` to populate the FTS5 index',
    });
  } catch (e) {
    // No FTS5 table at all is a fail, not a runner crash.
    return ok({
      passed: false,
      details: `pages_fts query failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

function checkNoFailedTasks(db: Database): Result<CheckOutcome, Error> {
  try {
    const rows = db
      .prepare<[], { status: string; n: number }>(
        `SELECT status, COUNT(*) AS n FROM tasks WHERE status LIKE 'failed_%' GROUP BY status`,
      )
      .all();
    if (rows.length === 0) {
      return ok({ passed: true, details: 'no tasks in failed_* state' });
    }
    const summary = rows.map((r) => `${r.status}: ${r.n}`).join(', ');
    return ok({ passed: false, details: `failed tasks present — ${summary}` });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

interface TraceIndexRow {
  id: string;
  timestamp: string;
  file_path: string;
  line_offset: number;
}

/**
 * Walks `audit/traces/*.jsonl` in order; for each line after the first,
 * verifies its `prev_hash` field equals SHA-256 of the previous line.
 * Pulls the trace order from the SQL index so we don't have to globbing-
 * sort filenames ourselves.
 */
function checkAuditChainIntact(
  db: Database,
  workspacePath: string,
): Result<CheckOutcome, Error> {
  let rows: TraceIndexRow[];
  try {
    rows = db
      .prepare<[], TraceIndexRow>(
        `SELECT id, timestamp, file_path, line_offset
           FROM traces
          ORDER BY timestamp ASC, line_offset ASC`,
      )
      .all();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (rows.length === 0) {
    return ok({ passed: true, details: 'no traces recorded — chain is trivially intact' });
  }

  // Group rows by file (a chain restarts each daily file).
  const byFile = new Map<string, TraceIndexRow[]>();
  for (const r of rows) {
    const list = byFile.get(r.file_path) ?? [];
    list.push(r);
    byFile.set(r.file_path, list);
  }

  let total = 0;
  for (const [relPath, list] of byFile.entries()) {
    const abs = resolve(workspacePath, relPath);
    if (!existsSync(abs)) {
      return ok({
        passed: false,
        details: `trace file referenced by index does not exist: ${relPath}`,
      });
    }
    let content: string;
    try {
      content = readFileSync(abs, 'utf-8');
    } catch (e) {
      return err(
        new Error(
          `Failed to read ${relPath}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
    const lines = content.split('\n').filter((l) => l.length > 0);
    if (lines.length < list.length) {
      return ok({
        passed: false,
        details: `${relPath} has fewer JSONL lines (${lines.length}) than index rows (${list.length})`,
      });
    }
    for (let i = 1; i < lines.length; i += 1) {
      let envelope: { prev_hash: string | null };
      try {
        envelope = JSON.parse(lines[i]!) as { prev_hash: string | null };
      } catch (e) {
        return ok({
          passed: false,
          details: `${relPath}:${i + 1} is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
        });
      }
      const expectedHash = createHash('sha256').update(lines[i - 1]!, 'utf-8').digest('hex');
      if (envelope.prev_hash !== expectedHash) {
        return ok({
          passed: false,
          details: `${relPath}:${i + 1} prev_hash mismatch — chain broken`,
        });
      }
    }
    total += lines.length;
  }

  return ok({ passed: true, details: `${total} trace events; ${byFile.size} files; chain intact` });
}
