/**
 * External anchoring for the ICO compile-trace hash chains (l13.8).
 *
 * `verifyAuditChain` proves the per-day trace chain is *internally*
 * consistent — but a writer with local access who edits an early event AND
 * re-hashes every later line forward produces a chain that still verifies
 * clean. That is tamper-EVIDENCE against accidental or partial edits, not
 * protection against a deliberate full rewrite.
 *
 * This module mirrors the INTKB `audit-anchor` pattern: periodically
 * snapshot the chain head (the SHA-256 of the newest trace line, plus the
 * total event count) into an **append-only, hash-chained anchor log** — a
 * JSONL file where each record links to the previous one by
 * `prevAnchorHash`. `verifyIcoAnchors` then cross-checks the *current*
 * chain against every anchored snapshot: a rewrite of history before an
 * anchored position changes the line at that position, so its recomputed
 * hash no longer matches the frozen `chainHead` — a `HISTORY_REWRITTEN`
 * break the file-walk alone cannot see. Truncation below an anchored count
 * is likewise caught (`HISTORY_TRUNCATED`), which also closes the
 * trailing-file-deletion gap the cross-day chaining (G3) left open.
 *
 * The anchor log becomes externally tamper-EVIDENT only when committed
 * somewhere a local editor cannot quietly rewrite — the intended deployment
 * appends `ico-anchors.jsonl` inside the same witnessed git repo that
 * already holds INTKB's `anchors.jsonl` (`~/.teamkb/audit`), inheriting its
 * force-push-protected remote. This module owns the log + verification; the
 * caller (CLI `ico audit anchor` / post-compile hook) owns the git commit.
 * Trust model: local = integrity + ordering + rewrite-detection since the
 * last anchor; cross-actor guarantees still require the external commit.
 *
 * @module audit-anchor
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { err, ok, type Result } from '@ico/types';

import { sha256Hex } from './crypto.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One snapshot of the ICO trace-chain head, linked into an append-only log. */
export interface IcoAnchorRecord {
  schemaVersion: 1;
  /** ISO-8601 timestamp the anchor was taken. */
  anchoredAt: string;
  /** Basename of the workspace the chains belong to (disambiguates a shared log). */
  workspaceId: string;
  /** Total trace events across all day files at anchor time. */
  totalEvents: number;
  /** SHA-256 of the newest trace line ('' when there are no events yet). */
  chainHead: string;
  /** anchorHash of the previous anchor in the log (null for the first). */
  prevAnchorHash: string | null;
  /** sha256 over the canonical body (everything above) — this record's identity. */
  anchorHash: string;
}

type AnchorBody = Omit<IcoAnchorRecord, 'anchorHash'>;

/** A discrepancy between the live chains and the anchor log, or within the log. */
export interface IcoAnchorBreak {
  /** Zero-indexed position in the anchor log. */
  index: number;
  anchoredAt: string;
  reason:
    | 'ANCHOR_HASH_MISMATCH' // an anchor record itself was edited
    | 'ANCHOR_LINK_MISMATCH' // the anchor log was reordered / spliced
    | 'ANCHOR_MALFORMED' // an anchor line failed to parse
    | 'HISTORY_TRUNCATED' // the chain now has fewer events than were anchored
    | 'HISTORY_REWRITTEN'; // the line at an anchored position changed
  detail: string;
}

/** Aggregate result of an anchor cross-check. */
export interface IcoAnchorVerifyResult {
  anchorCount: number;
  anchorBreaks: IcoAnchorBreak[];
  /** True iff every anchor is self-consistent AND consistent with the chain. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Canonical body serialisation — fixed key order. */
function anchorBodyJson(b: AnchorBody): string {
  return JSON.stringify({
    schemaVersion: b.schemaVersion,
    anchoredAt: b.anchoredAt,
    workspaceId: b.workspaceId,
    totalEvents: b.totalEvents,
    chainHead: b.chainHead,
    prevAnchorHash: b.prevAnchorHash,
  });
}

/** SHA-256 hex digest identifying an anchor record (over its canonical body). */
export function computeIcoAnchorHash(body: AnchorBody): string {
  return sha256Hex(anchorBodyJson(body));
}

/** Sorted per-day trace files for a workspace ([] when the dir is absent). */
function listDayFiles(workspacePath: string): string[] {
  const tracesDir = join(workspacePath, 'audit', 'traces');
  if (!existsSync(tracesDir)) return [];
  return readdirSync(tracesDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map((f) => join(tracesDir, f));
}

/** Non-empty lines of one file. */
function readLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/** Walk the day files once: total event count + the newest raw line. */
function chainHeadInfo(workspacePath: string): { totalEvents: number; lastLine: string | null } {
  let totalEvents = 0;
  let lastLine: string | null = null;
  for (const filePath of listDayFiles(workspacePath)) {
    const lines = readLines(filePath);
    totalEvents += lines.length;
    if (lines.length > 0) lastLine = lines[lines.length - 1]!;
  }
  return { totalEvents, lastLine };
}

/** The raw trace line at 1-indexed chronological position `n`, or null. */
function lineAtPosition(workspacePath: string, n: number): string | null {
  if (n <= 0) return null;
  let seen = 0;
  for (const filePath of listDayFiles(workspacePath)) {
    const lines = readLines(filePath);
    if (seen + lines.length >= n) {
      return lines[n - seen - 1] ?? null;
    }
    seen += lines.length;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse the append-only anchor log. Returns [] when the file is absent. */
export function readIcoAnchors(anchorPath: string): Array<IcoAnchorRecord | null> {
  if (!existsSync(anchorPath)) return [];
  return readFileSync(anchorPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      try {
        return JSON.parse(l) as IcoAnchorRecord;
      } catch {
        return null; // surfaced as ANCHOR_MALFORMED by verifyIcoAnchors
      }
    });
}

/** Options for {@link appendIcoAnchor}. */
export interface AppendIcoAnchorOptions {
  /** Workspace identifier stamped on the record (defaults to the basename). */
  workspaceId?: string;
  /** Injectable clock for deterministic tests. */
  nowFn?: () => string;
}

/**
 * Snapshot the current trace-chain head and append it to the anchor log.
 * The new record links to the prior one by `prevAnchorHash`, extending the
 * anchor-log hash chain.
 *
 * No-op guard: when the chain head AND event count are identical to the last
 * anchor (nothing was compiled since), the last record is returned unchanged
 * — re-anchoring an already-witnessed head every run would bloat the log (and
 * the witnessing git history) for zero additional evidence.
 *
 * The anchor file's parent directory must already exist — the witnessed repo
 * is operator-prepared, never silently created.
 *
 * After a real append, commit the anchor file externally (git commit + push
 * of the witnessed repo) to make the snapshot tamper-EVIDENT against a later
 * local rewrite.
 */
export function appendIcoAnchor(
  workspacePath: string,
  anchorPath: string,
  opts?: AppendIcoAnchorOptions,
): Result<{ record: IcoAnchorRecord; appended: boolean }, Error> {
  try {
    const parent = dirname(anchorPath);
    if (!existsSync(parent)) {
      return err(
        new Error(
          `Anchor directory does not exist: ${parent}. The witnessed anchor repo must be prepared by the operator.`,
        ),
      );
    }

    const now = opts?.nowFn ?? ((): string => new Date().toISOString());
    const workspaceId =
      opts?.workspaceId ?? workspacePath.split('/').filter(Boolean).pop() ?? 'workspace';
    const { totalEvents, lastLine } = chainHeadInfo(workspacePath);
    const chainHead = lastLine !== null ? sha256Hex(lastLine) : '';

    const existing = readIcoAnchors(anchorPath).filter((a): a is IcoAnchorRecord => a !== null);
    const last = existing.length > 0 ? existing[existing.length - 1]! : null;
    if (last !== null && last.chainHead === chainHead && last.totalEvents === totalEvents) {
      return ok({ record: last, appended: false });
    }

    const body: AnchorBody = {
      schemaVersion: 1,
      anchoredAt: now(),
      workspaceId,
      totalEvents,
      chainHead,
      prevAnchorHash: last !== null ? last.anchorHash : null,
    };
    const record: IcoAnchorRecord = { ...body, anchorHash: computeIcoAnchorHash(body) };
    appendFileSync(anchorPath, JSON.stringify(record) + '\n', { mode: 0o600 });
    return ok({ record, appended: true });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Verify the ICO trace chains against the anchor log. Detects (a) anchor
 * records that were edited, (b) a reordered/spliced anchor log, and — the
 * point of anchoring — (c) truncation or silent rewrite of trace history
 * before any anchored position, which the per-file chain walk cannot see.
 * Never throws on tamper; filesystem failures return `err`.
 */
export function verifyIcoAnchors(
  workspacePath: string,
  anchorPath: string,
): Result<IcoAnchorVerifyResult, Error> {
  try {
    const anchors = readIcoAnchors(anchorPath);
    const anchorBreaks: IcoAnchorBreak[] = [];
    const { totalEvents } = chainHeadInfo(workspacePath);

    let expectedPrev: string | null = null;
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]!;
      if (a === null) {
        anchorBreaks.push({
          index: i,
          anchoredAt: 'unknown',
          reason: 'ANCHOR_MALFORMED',
          detail: 'anchor line is not valid JSON',
        });
        continue;
      }

      const recomputed = computeIcoAnchorHash({
        schemaVersion: a.schemaVersion,
        anchoredAt: a.anchoredAt,
        workspaceId: a.workspaceId,
        totalEvents: a.totalEvents,
        chainHead: a.chainHead,
        prevAnchorHash: a.prevAnchorHash,
      });
      if (recomputed !== a.anchorHash) {
        anchorBreaks.push({
          index: i,
          anchoredAt: a.anchoredAt,
          reason: 'ANCHOR_HASH_MISMATCH',
          detail: 'anchor record content does not match its anchorHash',
        });
      }
      if (a.prevAnchorHash !== expectedPrev) {
        anchorBreaks.push({
          index: i,
          anchoredAt: a.anchoredAt,
          reason: 'ANCHOR_LINK_MISMATCH',
          detail: `prevAnchorHash ${a.prevAnchorHash ?? 'null'} != expected ${expectedPrev ?? 'null'}`,
        });
      }
      expectedPrev = a.anchorHash;

      if (totalEvents < a.totalEvents) {
        anchorBreaks.push({
          index: i,
          anchoredAt: a.anchoredAt,
          reason: 'HISTORY_TRUNCATED',
          detail: `anchored ${a.totalEvents} events; chain now has ${totalEvents}`,
        });
      } else if (a.totalEvents > 0) {
        const line = lineAtPosition(workspacePath, a.totalEvents);
        const actualHead = line !== null ? sha256Hex(line) : null;
        if (actualHead !== a.chainHead) {
          anchorBreaks.push({
            index: i,
            anchoredAt: a.anchoredAt,
            reason: 'HISTORY_REWRITTEN',
            detail: `event ${a.totalEvents} hash ${actualHead ?? 'null'} != anchored ${a.chainHead}`,
          });
        }
      }
    }

    return ok({
      anchorCount: anchors.length,
      anchorBreaks,
      ok: anchorBreaks.length === 0,
    });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
