/**
 * `ico maintain` — scan registered mounts, ingest eligible deltas, and compile
 * them under one governed write lock.
 *
 * This is intentionally separate from the agent-driven knowledge distiller.
 * A maintenance receipt makes a mounted-source freshness claim and can say
 * `compiled`, `partial`, `verified_noop`, or `failure`; a clean process exit is
 * never used as a proxy for useful work.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

import type { Command } from 'commander';

import {
  type AffectedSet,
  calculateCost,
  type ChangedFile,
  type ClaudeClient,
  type CompletionOptions,
  type CompletionResult,
  computeAffectedSet,
  createClaudeClient,
  evaluateCostGate,
  resolvePricingModel,
} from '@ico/compiler';
import {
  appendAuditLog,
  closeDatabase,
  type Database,
  initDatabase,
  listMounts,
  listSources,
  loadConfig,
  scanForDisclosure,
  withWriteLock,
  writeTrace,
} from '@ico/kernel';
import { err, type Mount, type Result, type Source } from '@ico/types';

import { formatError, formatInfo, formatJSON, formatSuccess } from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';
import {
  type CompileContext,
  type RawSourceProvenance,
  registerChangedWorkspaceSources,
  runAffectedPipelineUnlocked,
} from './compile.js';
import { scanDirectory } from './ingest.js';

const RECEIPT_SCHEMA_VERSION = 4;
const RETIREMENT_RECEIPT_SCHEMA_VERSION = 1;
const RELOCATION_RECEIPT_SCHEMA_VERSION = 1;
const INFERENCE_BUDGET_EXCEEDED = 'INFERENCE_BUDGET_EXCEEDED';

export type MaintenanceStatus = 'compiled' | 'partial' | 'verified_noop' | 'failure';
export type CandidateKind = 'new' | 'changed' | 'pending';
export type MaintenanceBillingMode = 'metered' | 'unmetered';

export interface MaintenanceCandidate {
  kind: CandidateKind;
  originPath: string;
  mountId: string;
  mountName: string;
  relativePath: string;
  rawPath: string;
  hash: string;
  bytes: Buffer;
  copyRequired: boolean;
}

export interface MountScanEvidence {
  id: string;
  name: string;
  path: string;
  files: number;
  newestInputMtime: string | null;
  ageDays: number | null;
  stale: boolean;
  missing: boolean;
}

export interface MaintenanceScan {
  mounts: MountScanEvidence[];
  candidates: MaintenanceCandidate[];
  counts: {
    mounts: number;
    files: number;
    unchanged: number;
    legacyUnchanged: number;
    policyBlocked: number;
    governedExcluded: number;
    new: number;
    changed: number;
    pending: number;
    removed: number;
    /** Removed origins an operator already retired; they no longer block maintenance. */
    retired: number;
    /**
     * Retired origins that came back byte-identical. A normal run revives them;
     * a scan-only run reports them as pending work and changes nothing.
     */
    revived: number;
  };
  removedOrigins: string[];
  /** Source ids of retired origins that reappeared with their completed hash. */
  revivedSourceIds: string[];
  staleMounts: string[];
  missingMounts: string[];
}

export interface MaintenanceReceipt {
  schemaVersion: number;
  compileScope: 'mounted-source';
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: MaintenanceStatus | 'running';
  workspace: string;
  model: string | null;
  scan: Omit<MaintenanceScan, 'candidates'>;
  rawPaths: string[];
  plannedAffectedTypes: string[];
  compilationRowsAdded: number;
  projectedCostUsd: number | null;
  progress: {
    eligible: number;
    selected: number;
    processed: number;
    governedExcluded: number;
    failed: number;
    remaining: number;
  };
  inference: {
    /** Whether the retail-equivalent estimate is enforced as a spend ceiling. */
    billingMode: MaintenanceBillingMode;
    operations: number;
    inputTokens: number;
    outputTokens: number;
    /** Retail-equivalent estimate from exact operation usage; not an invoice charge. */
    actualCostUsd: number;
    spentTodayBeforeUsd: number;
    spentTodayAfterUsd: number;
    /** Null only when an operator explicitly selected unmetered billing. */
    dailyCeilingUsd: number | null;
  };
  errorCode: string | null;
  error: string | null;
}

interface MaintenanceOrigin {
  mountId: string;
  mountName?: unknown;
  relativePath: string;
  originPath?: unknown;
  completedHash?: unknown;
  excludedReason?: unknown;
  retiredAt?: unknown;
}

interface OriginMetadata {
  maintenance?: Record<string, unknown>;
}

export interface MaintainOptions {
  scanOnly?: boolean;
  model?: string;
  billingMode?: string;
  dailyCeilingUsd?: string;
  debounceSeconds?: string;
  maxInputAgeDays?: string;
  lockWaitSeconds?: string;
  maxCandidates?: string;
}

interface GlobalOptions {
  workspace?: string;
  json?: boolean;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeSlug(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (slug || fallback).slice(0, 80);
}

/** Build a stable collision-resistant raw path from mount identity + relative path. */
export function buildMaintenanceRawPath(
  mount: Pick<Mount, 'id' | 'name'>,
  relativePath: string,
): string {
  const extension = extname(relativePath).toLowerCase() || '.txt';
  const stem = basename(relativePath, extname(relativePath));
  const mountSlug = safeSlug(mount.name, 'mount').slice(0, 32);
  const stemSlug = safeSlug(stem, 'source');
  const identity = sha256(`${mount.id}\0${relativePath}`).slice(0, 12);
  const subdir =
    extension === '.pdf'
      ? 'papers'
      : extension === '.html' || extension === '.htm'
        ? 'articles'
        : 'notes';
  return `raw/${subdir}/${mountSlug}-${stemSlug}-${identity}${extension}`;
}

function parseOrigin(source: Source): MaintenanceOrigin | null {
  if (source.metadata === null) return null;
  try {
    const parsed = JSON.parse(source.metadata) as OriginMetadata;
    const value = parsed.maintenance;
    if (
      value === undefined ||
      typeof value['mountId'] !== 'string' ||
      typeof value['relativePath'] !== 'string'
    ) {
      return null;
    }
    return {
      mountId: value['mountId'],
      relativePath: value['relativePath'],
      ...(value['mountName'] !== undefined && { mountName: value['mountName'] }),
      ...(value['originPath'] !== undefined && { originPath: value['originPath'] }),
      ...(value['completedHash'] !== undefined && { completedHash: value['completedHash'] }),
      ...(value['excludedReason'] !== undefined && { excludedReason: value['excludedReason'] }),
      ...(value['retiredAt'] !== undefined && { retiredAt: value['retiredAt'] }),
    };
  } catch {
    return null;
  }
}

function originKey(mountId: string, relativePath: string): string {
  return `${mountId}\0${relativePath}`;
}

function newestSourceByOrigin(sources: Source[]): Map<string, Source> {
  const result = new Map<string, Source>();
  for (const source of sources) {
    const origin = parseOrigin(source);
    if (
      origin === null ||
      typeof origin.mountId !== 'string' ||
      typeof origin.relativePath !== 'string'
    ) {
      continue;
    }
    const key = originKey(origin.mountId, origin.relativePath);
    const current = result.get(key);
    if (current === undefined || current.ingested_at < source.ingested_at) result.set(key, source);
  }
  return result;
}

function sourceIdsWithSummaries(db: Database): Set<string> {
  const rows = db
    .prepare<[], { source_id: string }>(
      `SELECT DISTINCT source_id
         FROM compilations
        WHERE type = 'summary' AND source_id IS NOT NULL`,
    )
    .all();
  return new Set(rows.map((row) => row.source_id));
}

/**
 * Scan every registered mount. Content hashes are authoritative; mtimes are
 * retained only as liveness evidence. Policy-blocked files are counted as an
 * explicit governed outcome, never as an ingest error or silent omission.
 */
export function scanMountedSources(
  db: Database,
  workspacePath: string,
  options?: { maxInputAgeDays?: number; nowMs?: number },
): MaintenanceScan {
  const mountsResult = listMounts(db);
  if (!mountsResult.ok) throw mountsResult.error;
  const sourcesResult = listSources(db);
  if (!sourcesResult.ok) throw sourcesResult.error;

  const mounts = mountsResult.value;
  const sources = sourcesResult.value;
  const compiledSourceIds = sourceIdsWithSummaries(db);
  const trackedByOrigin = newestSourceByOrigin(sources);
  const sourcesByHash = new Map<string, Source[]>();
  for (const source of sources) {
    const rows = sourcesByHash.get(source.hash) ?? [];
    rows.push(source);
    sourcesByHash.set(source.hash, rows);
  }

  const nowMs = options?.nowMs ?? Date.now();
  const maxAge = options?.maxInputAgeDays ?? 0;
  const seenOrigins = new Set<string>();
  const revivedSourceIds: string[] = [];
  const evidence: MountScanEvidence[] = [];
  const candidates: MaintenanceCandidate[] = [];
  const counts = {
    mounts: mounts.length,
    files: 0,
    unchanged: 0,
    legacyUnchanged: 0,
    policyBlocked: 0,
    governedExcluded: 0,
    new: 0,
    changed: 0,
    pending: 0,
    removed: 0,
    retired: 0,
    revived: 0,
  };

  for (const mount of mounts) {
    if (!existsSync(mount.path)) {
      evidence.push({
        id: mount.id,
        name: mount.name,
        path: mount.path,
        files: 0,
        newestInputMtime: null,
        ageDays: null,
        stale: false,
        missing: true,
      });
      continue;
    }

    const files = Array.from(new Set(scanDirectory(mount.path, { respectGitIgnore: true }))).sort();
    let newestMtimeMs = 0;
    for (const file of files) {
      counts.files++;
      const relativePath = relative(mount.path, file);
      const key = originKey(mount.id, relativePath);
      seenOrigins.add(key);

      const bytes = readFileSync(file);
      const hash = sha256(bytes);
      newestMtimeMs = Math.max(newestMtimeMs, statSync(file).mtimeMs);
      if (scanForDisclosure(bytes.toString('utf-8')) !== null) {
        counts.policyBlocked++;
        continue;
      }

      const tracked = trackedByOrigin.get(key);
      if (tracked !== undefined) {
        const origin = parseOrigin(tracked);
        // A retired origin that reappears byte-identical is revived: its
        // content hash proves the retired summary was derived from these
        // exact bytes. Changed bytes fall through to a normal recompile.
        if (
          tracked.hash === hash &&
          origin?.completedHash === hash &&
          typeof origin.retiredAt === 'string'
        ) {
          counts.revived++;
          revivedSourceIds.push(tracked.id);
          continue;
        }
        if (tracked.hash === hash && origin?.completedHash === hash) {
          if (compiledSourceIds.has(tracked.id)) {
            counts.unchanged++;
            continue;
          }
          if (typeof origin.excludedReason === 'string') {
            counts.governedExcluded++;
            continue;
          }
        }
        const kind: CandidateKind = tracked.hash === hash ? 'pending' : 'changed';
        counts[kind]++;
        candidates.push({
          kind,
          originPath: file,
          mountId: mount.id,
          mountName: mount.name,
          relativePath,
          rawPath: tracked.path,
          hash,
          bytes,
          copyRequired: kind === 'changed' || !existsSync(join(workspacePath, tracked.path)),
        });
        continue;
      }

      const legacyMatches = sourcesByHash.get(hash) ?? [];
      const compiledLegacy = legacyMatches.find((source) => compiledSourceIds.has(source.id));
      if (compiledLegacy !== undefined) {
        counts.legacyUnchanged++;
        continue;
      }
      const pendingLegacy = legacyMatches.find((source) =>
        existsSync(join(workspacePath, source.path)),
      );
      const kind: CandidateKind = pendingLegacy === undefined ? 'new' : 'pending';
      counts[kind]++;
      candidates.push({
        kind,
        originPath: file,
        mountId: mount.id,
        mountName: mount.name,
        relativePath,
        rawPath: pendingLegacy?.path ?? buildMaintenanceRawPath(mount, relativePath),
        hash,
        bytes,
        copyRequired: pendingLegacy === undefined,
      });
    }

    const ageDays = newestMtimeMs > 0 ? (nowMs - newestMtimeMs) / 86_400_000 : null;
    const stale = maxAge > 0 && (ageDays === null || ageDays > maxAge);
    evidence.push({
      id: mount.id,
      name: mount.name,
      path: mount.path,
      files: files.length,
      newestInputMtime: newestMtimeMs > 0 ? new Date(newestMtimeMs).toISOString() : null,
      ageDays,
      stale,
      missing: false,
    });
  }

  const currentMountIds = new Set(mounts.map((mount) => mount.id));
  const removedOrigins: string[] = [];
  for (const [key, source] of trackedByOrigin) {
    const origin = parseOrigin(source);
    if (
      origin !== null &&
      typeof origin.mountId === 'string' &&
      currentMountIds.has(origin.mountId) &&
      !seenOrigins.has(key)
    ) {
      if (typeof origin.retiredAt === 'string') counts.retired++;
      else removedOrigins.push(key.replace('\0', ':'));
    }
  }
  removedOrigins.sort();
  counts.removed = removedOrigins.length;

  return {
    mounts: evidence,
    candidates: candidates.sort((a, b) => a.rawPath.localeCompare(b.rawPath)),
    counts,
    removedOrigins,
    revivedSourceIds: revivedSourceIds.sort(),
    staleMounts: evidence.filter((item) => item.stale).map((item) => item.name),
    missingMounts: evidence.filter((item) => item.missing).map((item) => item.name),
  };
}

function receiptScan(scan: MaintenanceScan): Omit<MaintenanceScan, 'candidates'> {
  return {
    mounts: scan.mounts,
    counts: scan.counts,
    removedOrigins: scan.removedOrigins,
    revivedSourceIds: scan.revivedSourceIds,
    staleMounts: scan.staleMounts,
    missingMounts: scan.missingMounts,
  };
}

function receiptDirectory(workspacePath: string): string {
  return join(workspacePath, '.ico', 'maintenance');
}

export function writeMaintenanceReceipt(workspacePath: string, receipt: MaintenanceReceipt): void {
  const root = receiptDirectory(workspacePath);
  const history = join(root, 'receipts');
  mkdirSync(history, { recursive: true, mode: 0o700 });
  // mkdir's mode is creation-only. Repair an existing directory on every run
  // so a previously loose umask/manual creation cannot leave receipts exposed.
  chmodSync(root, 0o700);
  chmodSync(history, 0o700);
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  for (const target of [join(history, `${receipt.runId}.json`), join(root, 'latest.json')]) {
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporary, text, { encoding: 'utf-8', mode: 0o600 });
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

export function readLatestMaintenanceReceipt(workspacePath: string): MaintenanceReceipt | null {
  try {
    return JSON.parse(
      readFileSync(join(receiptDirectory(workspacePath), 'latest.json'), 'utf-8'),
    ) as MaintenanceReceipt;
  } catch {
    return null;
  }
}

function atomicWriteCandidate(workspacePath: string, candidate: MaintenanceCandidate): void {
  if (!candidate.copyRequired) return;
  const target = join(workspacePath, candidate.rawPath);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, candidate.bytes, { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function finiteNonNegative(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  const value = finiteNonNegative(raw, fallback, label);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got "${raw ?? String(fallback)}"`);
  }
  return value;
}

function parseBillingMode(raw: string | undefined): MaintenanceBillingMode {
  const value = raw ?? 'metered';
  if (value !== 'metered' && value !== 'unmetered') {
    throw new Error(`--billing-mode must be "metered" or "unmetered", got "${value}"`);
  }
  return value;
}

interface MeterState {
  operations: number;
  inputTokens: number;
  outputTokens: number;
  actualCostUsd: number;
}

interface MeteredClientOptions {
  db: Database;
  runId: string;
  model: string;
  dailyCeilingUsd: number | null;
  spentTodayBeforeUsd: number;
  operationType: () => string;
}

/** Wrap a provider client with a one-row-per-call durable usage ledger and hard runtime ceiling. */
export function createMeteredMaintenanceClient(
  client: ClaudeClient,
  options: MeteredClientOptions,
): { client: ClaudeClient; state: MeterState } {
  const state: MeterState = {
    operations: 0,
    inputTokens: 0,
    outputTokens: 0,
    actualCostUsd: 0,
  };

  const metered: ClaudeClient = {
    async createCompletion(
      systemPrompt: string,
      userPrompt: string,
      completionOptions?: CompletionOptions,
    ): Promise<Result<CompletionResult, Error>> {
      const requestedModel = completionOptions?.model ?? options.model;
      const maxOutputTokens = completionOptions?.maxTokens ?? 4096;
      // UTF-8 bytes + a fixed protocol allowance is a deliberately conservative
      // upper bound for provider input tokens. Refuse before a call whose worst
      // case could cross the operator's ceiling; actual usage replaces it after.
      const maxInputTokens = Buffer.byteLength(systemPrompt) + Buffer.byteLength(userPrompt) + 1024;
      const worstCaseCost = calculateCost(
        maxInputTokens,
        maxOutputTokens,
        resolvePricingModel(requestedModel),
      );
      if (
        options.dailyCeilingUsd !== null &&
        options.spentTodayBeforeUsd + state.actualCostUsd + worstCaseCost > options.dailyCeilingUsd
      ) {
        return err(
          new Error(
            `[${INFERENCE_BUDGET_EXCEEDED}] next ${options.operationType()} call could raise ` +
              `the UTC-day total above $${options.dailyCeilingUsd.toFixed(2)}`,
          ),
        );
      }

      const result = await client.createCompletion(systemPrompt, userPrompt, completionOptions);
      if (!result.ok) return result;

      const sequence = state.operations + 1;
      const occurredAt = new Date().toISOString();
      try {
        options.db
          .prepare(
            `INSERT INTO inference_operations
               (id, run_id, operation_sequence, operation_type, occurred_at,
                model, input_tokens, output_tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            options.runId,
            sequence,
            options.operationType(),
            occurredAt,
            result.value.model,
            result.value.inputTokens,
            result.value.outputTokens,
          );
      } catch (error) {
        return err(
          new Error(
            `Provider call succeeded but its usage receipt could not be recorded: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }

      state.operations = sequence;
      state.inputTokens += result.value.inputTokens;
      state.outputTokens += result.value.outputTokens;
      state.actualCostUsd += calculateCost(
        result.value.inputTokens,
        result.value.outputTokens,
        resolvePricingModel(result.value.model),
      );
      return result;
    },
  };
  return { client: metered, state };
}

function maintenanceOperationTypes(candidateCount: number): string[] {
  // summarizeSource may make one validation-repair retry. Price that
  // documented maximum up front; the operation ledger records only the calls
  // actually made, so the day-spend receipt remains exact.
  return Array<string>(candidateCount * 2).fill('summary');
}

function hasCurrentSummary(db: Database, candidate: MaintenanceCandidate): boolean {
  const row = db
    .prepare<[string, string], { present: number }>(
      `SELECT 1 AS present
         FROM sources AS s
         JOIN compilations AS c ON c.source_id = s.id
        WHERE s.path = ? AND s.hash = ?
          AND c.type = 'summary' AND c.stale = 0
        ORDER BY s.ingested_at DESC, c.compiled_at DESC
        LIMIT 1`,
    )
    .get(candidate.rawPath, candidate.hash);
  return row !== undefined;
}

function currentSourceId(db: Database, candidate: MaintenanceCandidate): string {
  const row = db
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM sources
        WHERE path = ? AND hash = ?
        ORDER BY ingested_at DESC LIMIT 1`,
    )
    .get(candidate.rawPath, candidate.hash);
  if (row === undefined) {
    throw new Error(`Maintenance source is not registered: ${candidate.rawPath}`);
  }
  return row.id;
}

function markMaintenanceComplete(
  db: Database,
  candidate: MaintenanceCandidate,
  completedAt: string,
  excludedReason?: string,
): void {
  const row = db
    .prepare<[string, string], { id: string; metadata: string | null }>(
      `SELECT id, metadata FROM sources
        WHERE path = ? AND hash = ?
        ORDER BY ingested_at DESC LIMIT 1`,
    )
    .get(candidate.rawPath, candidate.hash);
  if (row === undefined) {
    throw new Error(`Completed maintenance source is not registered: ${candidate.rawPath}`);
  }
  let metadata: Record<string, unknown> = {};
  if (row.metadata !== null) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  const existing =
    typeof metadata['maintenance'] === 'object' && metadata['maintenance'] !== null
      ? (metadata['maintenance'] as Record<string, unknown>)
      : {};
  const maintenance: Record<string, unknown> = {
    ...existing,
    mountId: candidate.mountId,
    mountName: candidate.mountName,
    relativePath: candidate.relativePath,
    originPath: candidate.originPath,
    completedHash: candidate.hash,
    completedAt,
  };
  // Recompiling a source that came back ends its retirement.
  delete maintenance['retiredAt'];
  delete maintenance['retiredReason'];
  delete maintenance['retiredRunId'];
  if (excludedReason === undefined) delete maintenance['excludedReason'];
  else maintenance['excludedReason'] = excludedReason;
  metadata['maintenance'] = maintenance;
  db.prepare('UPDATE sources SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), row.id);
}

/**
 * End the retirement of sources whose files came back byte-identical: clear
 * the retirement fields and mark their compilations current again, with a
 * trace event and an audit-log line. No provider call is needed.
 */
function reviveRetiredSources(
  db: Database,
  workspacePath: string,
  sourceIds: readonly string[],
  runId: string,
): Result<void, Error> {
  try {
    const read = db.prepare<[string], { metadata: string | null }>(
      'SELECT metadata FROM sources WHERE id = ?',
    );
    const update = db.prepare<[string, string], void>(
      'UPDATE sources SET metadata = ? WHERE id = ?',
    );
    const current = db.prepare<[string], void>(
      'UPDATE compilations SET stale = 0 WHERE source_id = ?',
    );
    db.transaction(() => {
      for (const id of sourceIds) {
        const metadata = JSON.parse(read.get(id)?.metadata ?? '{}') as Record<string, unknown>;
        const maintenance = { ...(metadata['maintenance'] as Record<string, unknown>) };
        delete maintenance['retiredAt'];
        delete maintenance['retiredReason'];
        delete maintenance['retiredRunId'];
        metadata['maintenance'] = maintenance;
        update.run(JSON.stringify(metadata), id);
        current.run(id);
      }
      const trace = writeTrace(
        db,
        workspacePath,
        'source.revive',
        { runId, sourceIds: [...sourceIds] },
        { summary: `Revived ${sourceIds.length} retired source(s) that reappeared unchanged` },
      );
      if (!trace.ok) throw trace.error;
    })();
    const audit = appendAuditLog(
      workspacePath,
      'source.revive',
      `Revived ${sourceIds.length} retired source(s) that reappeared unchanged (run ${runId})`,
    );
    if (!audit.ok) return err(audit.error);
    return { ok: true, value: undefined };
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

function emptyAffected(): AffectedSet {
  return {
    changedSourcePaths: [],
    newSourcePaths: [],
    unchangedSourcePaths: [],
    affectedPages: [],
    conservativeSweep: false,
  };
}

function emptyReceiptScan(): Omit<MaintenanceScan, 'candidates'> {
  return {
    mounts: [],
    counts: {
      mounts: 0,
      files: 0,
      unchanged: 0,
      legacyUnchanged: 0,
      policyBlocked: 0,
      governedExcluded: 0,
      new: 0,
      changed: 0,
      pending: 0,
      removed: 0,
      retired: 0,
      revived: 0,
    },
    removedOrigins: [],
    revivedSourceIds: [],
    staleMounts: [],
    missingMounts: [],
  };
}

function printReceipt(receipt: MaintenanceReceipt, json: boolean): void {
  if (json) {
    process.stdout.write(`${formatJSON(receipt)}\n`);
    return;
  }
  const counts = receipt.scan.counts;
  const summary =
    `${receipt.status}: ${counts.files} files, ${counts.new} new, ` +
    `${counts.changed} changed, ${counts.pending} pending, ` +
    `${counts.policyBlocked} policy-blocked, ${receipt.progress.processed} processed, ` +
    `${receipt.progress.remaining} remaining, ${receipt.compilationRowsAdded} compilations added`;
  process.stdout.write(
    (receipt.status === 'failure' ? formatError(summary) : formatSuccess(summary)) + '\n',
  );
  process.stdout.write(
    formatInfo(`Receipt: ${join(receiptDirectory(receipt.workspace), 'latest.json')}`) + '\n',
  );
}

function emptyProgress(eligible = 0, selected = 0): MaintenanceReceipt['progress'] {
  return {
    eligible,
    selected,
    processed: 0,
    governedExcluded: 0,
    failed: 0,
    remaining: eligible,
  };
}

function emptyInference(
  billingMode: MaintenanceBillingMode,
  dailyCeilingUsd: number | null,
): MaintenanceReceipt['inference'] {
  return {
    billingMode,
    operations: 0,
    inputTokens: 0,
    outputTokens: 0,
    actualCostUsd: 0,
    spentTodayBeforeUsd: 0,
    spentTodayAfterUsd: 0,
    dailyCeilingUsd,
  };
}

interface MaintenanceDependencies {
  createClient?: (apiKey: string) => ClaudeClient;
}

export async function runMaintenance(
  workspacePath: string,
  dbPath: string,
  opts: MaintainOptions,
  dependencies: MaintenanceDependencies = {},
): Promise<MaintenanceReceipt> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();
  const maxInputAgeDays = finiteNonNegative(opts.maxInputAgeDays, 0, '--max-input-age-days');
  const billingMode = parseBillingMode(opts.billingMode);
  if (billingMode === 'unmetered' && opts.dailyCeilingUsd !== undefined) {
    throw new Error('--daily-ceiling-usd cannot be combined with --billing-mode unmetered');
  }
  const dailyCeilingUsd =
    billingMode === 'metered'
      ? finiteNonNegative(opts.dailyCeilingUsd, 1, '--daily-ceiling-usd')
      : null;
  const debounceSeconds = finiteNonNegative(opts.debounceSeconds, 300, '--debounce-seconds');
  const lockWaitSeconds = finiteNonNegative(opts.lockWaitSeconds, 10, '--lock-wait-seconds');
  const maxCandidates = positiveInteger(opts.maxCandidates, 10, '--max-candidates');
  let finalReceipt: MaintenanceReceipt | null = null;

  const lockResult = await withWriteLock(
    async () => {
      const dbResult = initDatabase(dbPath);
      if (!dbResult.ok) throw dbResult.error;
      const db = dbResult.value;
      try {
        let scan: MaintenanceScan;
        try {
          scan = scanMountedSources(db, workspacePath, { maxInputAgeDays });
        } catch (error) {
          finalReceipt = {
            schemaVersion: RECEIPT_SCHEMA_VERSION,
            compileScope: 'mounted-source',
            runId,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: 'failure',
            workspace: workspacePath,
            model: null,
            scan: emptyReceiptScan(),
            rawPaths: [],
            plannedAffectedTypes: [],
            compilationRowsAdded: 0,
            projectedCostUsd: null,
            progress: emptyProgress(),
            inference: emptyInference(billingMode, dailyCeilingUsd),
            errorCode: 'scan_failed',
            error: error instanceof Error ? error.message : String(error),
          };
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        const previous = readLatestMaintenanceReceipt(workspacePath);
        const retryOrder = new Map(
          (previous?.status === 'failure' || previous?.status === 'running'
            ? previous.rawPaths
            : []
          ).map((path, index) => [path, index]),
        );
        const orderedCandidates = [...scan.candidates].sort((a, b) => {
          const aRetry = retryOrder.get(a.rawPath);
          const bRetry = retryOrder.get(b.rawPath);
          if (aRetry !== undefined || bRetry !== undefined) {
            if (aRetry === undefined) return 1;
            if (bRetry === undefined) return -1;
            return aRetry - bRetry;
          }
          return a.rawPath.localeCompare(b.rawPath);
        });
        const selectedCandidates =
          opts.scanOnly === true ? orderedCandidates : orderedCandidates.slice(0, maxCandidates);

        const base: Omit<MaintenanceReceipt, 'status' | 'finishedAt' | 'errorCode' | 'error'> = {
          schemaVersion: RECEIPT_SCHEMA_VERSION,
          compileScope: 'mounted-source',
          runId,
          startedAt,
          workspace: workspacePath,
          model: null,
          scan: receiptScan(scan),
          rawPaths: selectedCandidates.map((candidate) => candidate.rawPath),
          plannedAffectedTypes: [],
          compilationRowsAdded: 0,
          projectedCostUsd: null,
          progress: emptyProgress(scan.candidates.length, selectedCandidates.length),
          inference: emptyInference(billingMode, dailyCeilingUsd),
        };

        const fail = (errorCode: string, error: string): MaintenanceReceipt => ({
          ...base,
          finishedAt: new Date().toISOString(),
          status: 'failure',
          errorCode,
          error,
        });

        if (scan.counts.mounts === 0) {
          finalReceipt = fail('no_mounts', 'No source mounts are registered');
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        if (scan.missingMounts.length > 0) {
          finalReceipt = fail('missing_mount', `Missing mounts: ${scan.missingMounts.join(', ')}`);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        if (scan.staleMounts.length > 0) {
          finalReceipt = fail('stale_input', `Stale mounts: ${scan.staleMounts.join(', ')}`);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        if (scan.removedOrigins.length > 0) {
          finalReceipt = fail(
            'removed_source_requires_retirement',
            `${scan.removedOrigins.length} mounted source(s) were removed; explicit retirement is required`,
          );
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        if (scan.revivedSourceIds.length > 0 && opts.scanOnly !== true) {
          const revived = reviveRetiredSources(db, workspacePath, scan.revivedSourceIds, runId);
          if (!revived.ok) {
            finalReceipt = fail('revive_failed', revived.error.message);
            writeMaintenanceReceipt(workspacePath, finalReceipt);
            return;
          }
        }

        const changed: ChangedFile[] = selectedCandidates.map((candidate) => ({
          path: candidate.rawPath,
          hash: candidate.hash,
        }));

        if (opts.scanOnly === true && scan.revivedSourceIds.length > 0) {
          finalReceipt = fail(
            'scan_found_pending_work',
            `Scan-only run found ${scan.revivedSourceIds.length} retired source(s) to revive`,
          );
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }

        if (changed.length === 0) {
          const terminalReceipt: MaintenanceReceipt = {
            ...base,
            finishedAt: new Date().toISOString(),
            status: 'verified_noop',
            errorCode: null,
            error: null,
          };
          db.prepare('UPDATE mounts SET last_indexed_at = ?').run(terminalReceipt.finishedAt);
          writeMaintenanceReceipt(workspacePath, terminalReceipt);
          finalReceipt = terminalReceipt;
          return;
        }

        const affectedResult = computeAffectedSet(db, changed);
        if (!affectedResult.ok) {
          finalReceipt = fail('diff_failed', affectedResult.error.message);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        const affected = affectedResult.value;
        // A prior run can fail after writing valid, receipted summaries (for
        // example the historical aggregate extract step timed out). Resume from
        // those durable per-source checkpoints instead of paying to summarize
        // the same hash again. The completion marker is written only below,
        // after the current run has verified the summary still resolves.
        const compileCandidates = selectedCandidates.filter(
          (candidate) => !hasCurrentSummary(db, candidate),
        );
        const compileCandidatePaths = new Set(
          compileCandidates.map((candidate) => candidate.rawPath),
        );
        const forcedPaths = compileCandidates
          .filter((candidate) => candidate.kind === 'pending')
          .map((candidate) => candidate.rawPath);
        // Scheduled maintenance makes one narrow, machine-checkable freshness
        // claim: every mounted source hash has a summary or an explicit
        // governed exclusion. Concept extraction is deliberately outside this
        // checkpoint: it aggregates summaries, so one provider timeout would
        // otherwise discard honest per-source progress for an entire batch.
        // Operators run `ico compile concepts` / `ico compile all` explicitly
        // under their own cost decision and evidence.
        const plannedAffectedTypes = maintenanceOperationTypes(compileCandidates.length);
        base.plannedAffectedTypes = [...plannedAffectedTypes];

        if (opts.scanOnly === true) {
          finalReceipt = fail(
            'scan_found_pending_work',
            `Scan-only run found ${scan.candidates.length} source path(s) requiring work`,
          );
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }

        let config: ReturnType<typeof loadConfig>;
        try {
          config = loadConfig(workspacePath);
        } catch (error) {
          finalReceipt = fail(
            'provider_config_failed',
            error instanceof Error ? error.message : String(error),
          );
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        const model = opts.model ?? config.model;
        base.model = model;
        const gate = evaluateCostGate(
          db,
          { affectedTypes: plannedAffectedTypes },
          {
            model,
            // Unmetered mode still runs the estimator for receipts and debounce,
            // but its retail-equivalent amount is not an enforced account charge.
            dailyCeilingUsd: dailyCeilingUsd ?? 1,
            enforceDailyCeiling: billingMode === 'metered',
            debounceWindowSeconds: debounceSeconds,
          },
        );
        if (!gate.ok) {
          finalReceipt = fail('cost_gate_failed', gate.error.message);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }
        base.projectedCostUsd = gate.value.projectedCostUsd;
        base.inference.spentTodayBeforeUsd = gate.value.spentTodayUsd;
        base.inference.spentTodayAfterUsd = gate.value.spentTodayUsd;
        if (
          gate.value.decision === 'coalesce' ||
          (billingMode === 'metered' && gate.value.decision === 'defer')
        ) {
          finalReceipt = fail(`cost_${gate.value.decision}`, gate.value.reason);
          writeMaintenanceReceipt(workspacePath, finalReceipt);
          return;
        }

        const running: MaintenanceReceipt = {
          ...base,
          finishedAt: null,
          status: 'running',
          errorCode: null,
          error: null,
        };
        writeMaintenanceReceipt(workspacePath, running);

        const before = db
          .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM compilations')
          .get();
        if (before === undefined) throw new Error('Could not count compilation rows before run');

        let meter: ReturnType<typeof createMeteredMaintenanceClient> | null = null;
        try {
          for (const candidate of selectedCandidates)
            atomicWriteCandidate(workspacePath, candidate);

          const provenance = new Map<string, RawSourceProvenance>();
          for (const candidate of selectedCandidates) {
            provenance.set(candidate.rawPath, {
              mountId: candidate.mountId,
              metadata: {
                maintenance: {
                  mountId: candidate.mountId,
                  mountName: candidate.mountName,
                  relativePath: candidate.relativePath,
                  originPath: candidate.originPath,
                },
              },
            });
          }
          const registrationAffected =
            affected.changedSourcePaths.length === 0 && affected.newSourcePaths.length === 0
              ? emptyAffected()
              : affected;
          registerChangedWorkspaceSources({ workspacePath, db }, changed, registrationAffected, {
            forcePaths: forcedPaths,
            provenanceByPath: provenance,
          });
          const compileCandidateIds = compileCandidates.map((candidate) =>
            currentSourceId(db, candidate),
          );

          let operationType = 'unknown';
          meter = createMeteredMaintenanceClient(
            (dependencies.createClient ?? createClaudeClient)(config.apiKey),
            {
              db,
              runId,
              model,
              dailyCeilingUsd,
              spentTodayBeforeUsd: gate.value.spentTodayUsd,
              operationType: () => operationType,
            },
          );
          const ctx: CompileContext = { workspacePath, dbPath, db, client: meter.client, model };
          const pipeline = await runAffectedPipelineUnlocked(ctx, affected, {
            forceSourceWork: forcedPaths.length > 0,
            // Keep this scheduler independently checkpointable per source.
            suppressExtract: true,
            suppressCrossSource: true,
            sourcePaths: compileCandidates.map((candidate) => candidate.rawPath),
            sourceIds: compileCandidateIds,
            onPassStart: (type) => {
              operationType = type;
            },
          });

          const after = db
            .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM compilations')
            .get();
          if (after === undefined) throw new Error('Could not count compilation rows after run');
          base.compilationRowsAdded = after.n - before.n;

          const compiled = new Set(pipeline.summary.compiledPaths);
          const skipped = new Set(pipeline.summary.skippedPaths);
          const completedAt = new Date().toISOString();
          const completed: MaintenanceCandidate[] = [];
          const failed: MaintenanceCandidate[] = [];
          for (const candidate of selectedCandidates) {
            const resumed =
              !compileCandidatePaths.has(candidate.rawPath) && hasCurrentSummary(db, candidate);
            if (compiled.has(candidate.rawPath) || resumed || skipped.has(candidate.rawPath)) {
              markMaintenanceComplete(
                db,
                candidate,
                completedAt,
                skipped.has(candidate.rawPath) ? 'compile_validation' : undefined,
              );
              completed.push(candidate);
            } else {
              failed.push(candidate);
            }
          }

          base.progress.processed = completed.length;
          base.progress.governedExcluded = completed.filter((candidate) =>
            skipped.has(candidate.rawPath),
          ).length;
          base.progress.failed = failed.length;
          base.progress.remaining = scan.candidates.length - completed.length;
          base.inference = {
            billingMode,
            operations: meter.state.operations,
            inputTokens: meter.state.inputTokens,
            outputTokens: meter.state.outputTokens,
            actualCostUsd: meter.state.actualCostUsd,
            spentTodayBeforeUsd: gate.value.spentTodayUsd,
            spentTodayAfterUsd: gate.value.spentTodayUsd + meter.state.actualCostUsd,
            dailyCeilingUsd,
          };

          if (failed.length > 0) {
            finalReceipt = fail(
              'source_compile_failed',
              `${failed.length} selected source(s) did not reach a summary or governed exclusion`,
            );
            writeMaintenanceReceipt(workspacePath, finalReceipt);
            return;
          }

          const terminalReceipt: MaintenanceReceipt = {
            ...base,
            finishedAt: completedAt,
            status: base.progress.remaining > 0 ? 'partial' : 'compiled',
            errorCode: null,
            error: null,
          };
          if (terminalReceipt.status === 'compiled') {
            db.prepare('UPDATE mounts SET last_indexed_at = ?').run(terminalReceipt.finishedAt);
          }
          writeMaintenanceReceipt(workspacePath, terminalReceipt);
          finalReceipt = terminalReceipt;
        } catch (error) {
          if (meter !== null) {
            base.inference = {
              billingMode,
              operations: meter.state.operations,
              inputTokens: meter.state.inputTokens,
              outputTokens: meter.state.outputTokens,
              actualCostUsd: meter.state.actualCostUsd,
              spentTodayBeforeUsd: base.inference.spentTodayBeforeUsd,
              spentTodayAfterUsd: base.inference.spentTodayBeforeUsd + meter.state.actualCostUsd,
              dailyCeilingUsd,
            };
          }
          const message = error instanceof Error ? error.message : String(error);
          finalReceipt = fail(
            message.includes(INFERENCE_BUDGET_EXCEEDED) ? 'cost_runtime_defer' : 'compile_failed',
            message,
          );
          writeMaintenanceReceipt(workspacePath, finalReceipt);
        }
      } finally {
        closeDatabase(db);
      }
    },
    { waitSeconds: lockWaitSeconds, requireLock: true },
  );

  if (!lockResult.ok || !lockResult.value.ran) {
    const message = !lockResult.ok
      ? lockResult.error.message
      : 'Another brain writer held the lock for the full wait window';
    if (finalReceipt === null) {
      finalReceipt = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        compileScope: 'mounted-source',
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: 'failure',
        workspace: workspacePath,
        model: null,
        scan: emptyReceiptScan(),
        rawPaths: [],
        plannedAffectedTypes: [],
        compilationRowsAdded: 0,
        projectedCostUsd: null,
        progress: emptyProgress(),
        inference: emptyInference(billingMode, dailyCeilingUsd),
        errorCode: 'write_lock_unavailable',
        error: message,
      };
      writeMaintenanceReceipt(workspacePath, finalReceipt);
    }
  }

  if (finalReceipt === null) {
    throw new Error('Maintenance run completed without a terminal receipt');
  }
  return finalReceipt;
}

// ---------------------------------------------------------------------------
// Source retirement
// ---------------------------------------------------------------------------

export interface RetireOptions {
  /** Why the sources were removed. Required; it is the governed record. */
  reason?: string;
  /** Origins to retire, as `<mount name or id>:<relative path>`. */
  origins?: string[];
  /** Retire every origin the scan currently reports as removed. */
  allRemoved?: boolean;
  dryRun?: boolean;
  lockWaitSeconds?: string;
}

export interface RetiredOrigin {
  origin: string;
  mountName: string;
  relativePath: string;
  sourceIds: string[];
  summariesMarkedStale: number;
}

export interface RetirementReceipt {
  schemaVersion: number;
  kind: 'source-retirement';
  runId: string;
  startedAt: string;
  finishedAt: string;
  workspace: string;
  dryRun: boolean;
  reason: string;
  retired: RetiredOrigin[];
  traceEventId: string | null;
}

function operationDirectory(workspacePath: string, name: 'retirements' | 'relocations'): string {
  const directory = join(receiptDirectory(workspacePath), name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function retirementDirectory(workspacePath: string): string {
  return operationDirectory(workspacePath, 'retirements');
}

function writeOperationReceipt(
  directory: string,
  receipt: RetirementReceipt | RelocationReceipt,
): string {
  const target = join(directory, `${receipt.runId}.json`);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return target;
}

/**
 * Retire mounted sources whose files were deliberately removed.
 *
 * Retirement is the governed answer to `removed_source_requires_retirement`.
 * It never deletes anything: `raw/` stays append-only and compiled pages stay
 * on disk. It records the operator's reason on every source row of the
 * origin, marks that origin's compilations stale, and writes a hash-chained
 * trace event, an audit-log line and a retirement receipt. Only origins the
 * scan currently reports as removed can be retired, and any unknown request
 * refuses the whole operation, so a typo cannot retire a live file.
 */
export async function retireRemovedSources(
  workspacePath: string,
  dbPath: string,
  opts: RetireOptions,
): Promise<{ receipt: RetirementReceipt; receiptPath: string | null }> {
  const reason = opts.reason?.trim() ?? '';
  if (reason.length < 10) {
    throw new Error('--reason is required and must say why the sources were removed');
  }
  const requested = opts.origins ?? [];
  if ((opts.allRemoved === true) === requested.length > 0) {
    throw new Error('Pass either --all-removed or one or more --origin values, not both');
  }
  const lockWaitSeconds = finiteNonNegative(opts.lockWaitSeconds, 10, '--lock-wait-seconds');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();
  let outcome: { receipt: RetirementReceipt; receiptPath: string | null } | null = null;

  const lockResult = await withWriteLock(
    () => {
      const dbResult = initDatabase(dbPath);
      if (!dbResult.ok) throw dbResult.error;
      const db = dbResult.value;
      try {
        const scan = scanMountedSources(db, workspacePath);
        // A missing mount makes every one of its files look removed. Never
        // retire a whole mount because a directory was briefly unavailable.
        if (scan.missingMounts.length > 0) {
          throw new Error(
            `Refusing to retire while mounts are missing: ${scan.missingMounts.join(', ')}`,
          );
        }
        const mountsResult = listMounts(db);
        if (!mountsResult.ok) throw mountsResult.error;
        const mountNameById = new Map(mountsResult.value.map((m) => [m.id, m.name]));
        const mountIdByName = new Map(mountsResult.value.map((m) => [m.name, m.id]));
        const removed = new Set(scan.removedOrigins);

        let selected: string[];
        if (opts.allRemoved === true) {
          selected = [...scan.removedOrigins];
        } else {
          const unknown: string[] = [];
          selected = [];
          for (const raw of requested) {
            const separator = raw.indexOf(':');
            const mountRef = separator > 0 ? raw.slice(0, separator) : '';
            const relativePath = separator > 0 ? raw.slice(separator + 1) : '';
            const mountId = mountIdByName.get(mountRef) ?? mountRef;
            const key = `${mountId}:${relativePath}`;
            if (removed.has(key)) selected.push(key);
            else unknown.push(raw);
          }
          if (unknown.length > 0) {
            throw new Error(
              `Not currently reported as removed, nothing retired: ${unknown.join(', ')}`,
            );
          }
          selected = [...new Set(selected)].sort();
        }
        if (selected.length === 0) {
          throw new Error('The scan reports no removed sources; nothing to retire');
        }

        const sourcesResult = listSources(db);
        if (!sourcesResult.ok) throw sourcesResult.error;
        const rowsByOrigin = new Map<string, Source[]>();
        for (const source of sourcesResult.value) {
          const origin = parseOrigin(source);
          if (origin === null) continue;
          const key = `${origin.mountId}:${origin.relativePath}`;
          const rows = rowsByOrigin.get(key) ?? [];
          rows.push(source);
          rowsByOrigin.set(key, rows);
        }

        const retiredAt = new Date().toISOString();
        const countStale = db.prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM compilations WHERE source_id = ? AND stale = 0',
        );
        const markStale = db.prepare<[string], void>(
          'UPDATE compilations SET stale = 1 WHERE source_id = ?',
        );
        const updateMetadata = db.prepare<[string, string], void>(
          'UPDATE sources SET metadata = ? WHERE id = ?',
        );
        const retired: RetiredOrigin[] = selected.map((key) => {
          const separator = key.indexOf(':');
          const mountId = key.slice(0, separator);
          const rows = rowsByOrigin.get(key) ?? [];
          return {
            origin: key,
            mountName: mountNameById.get(mountId) ?? mountId,
            relativePath: key.slice(separator + 1),
            sourceIds: rows.map((row) => row.id).sort(),
            summariesMarkedStale: rows.reduce(
              (total, row) => total + (countStale.get(row.id)?.n ?? 0),
              0,
            ),
          };
        });

        if (opts.dryRun === true) {
          outcome = {
            receipt: {
              schemaVersion: RETIREMENT_RECEIPT_SCHEMA_VERSION,
              kind: 'source-retirement',
              runId,
              startedAt,
              finishedAt: new Date().toISOString(),
              workspace: workspacePath,
              dryRun: true,
              reason,
              retired,
              traceEventId: null,
            },
            receiptPath: null,
          };
          return;
        }

        // The audit line and the receipt are written after the DB commit.
        // Prove both destinations are writable first so a predictable
        // failure cannot leave a committed retirement without them.
        accessSync(retirementDirectory(workspacePath), fsConstants.W_OK);
        accessSync(join(workspacePath, 'audit', 'log.md'), fsConstants.W_OK);

        const apply = db.transaction((): string => {
          for (const item of retired) {
            for (const row of rowsByOrigin.get(item.origin) ?? []) {
              const metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
              const maintenance = metadata['maintenance'] as Record<string, unknown>;
              metadata['maintenance'] = {
                ...maintenance,
                retiredAt,
                retiredReason: reason,
                retiredRunId: runId,
              };
              updateMetadata.run(JSON.stringify(metadata), row.id);
              markStale.run(row.id);
            }
          }
          const trace = writeTrace(
            db,
            workspacePath,
            'source.retire',
            { runId, reason, origins: retired.map((item) => item.origin) },
            { summary: `Retired ${retired.length} removed mounted source(s): ${reason}` },
          );
          if (!trace.ok) throw trace.error;
          return trace.value.event_id;
        });
        const traceEventId = apply();
        const afterCommit = (error: unknown): Error =>
          new Error(
            `Retirement run ${runId} is committed (trace ${traceEventId}) but its ` +
              `audit line or receipt could not be written: ${
                error instanceof Error ? error.message : String(error)
              }`,
          );

        const audit = appendAuditLog(
          workspacePath,
          'source.retire',
          `Retired ${retired.length} removed mounted source(s) (run ${runId}): ${reason}`,
        );
        if (!audit.ok) throw afterCommit(audit.error);

        const receipt: RetirementReceipt = {
          schemaVersion: RETIREMENT_RECEIPT_SCHEMA_VERSION,
          kind: 'source-retirement',
          runId,
          startedAt,
          finishedAt: new Date().toISOString(),
          workspace: workspacePath,
          dryRun: false,
          reason,
          retired,
          traceEventId,
        };
        try {
          outcome = {
            receipt,
            receiptPath: writeOperationReceipt(retirementDirectory(workspacePath), receipt),
          };
        } catch (error) {
          throw afterCommit(error);
        }
      } finally {
        closeDatabase(db);
      }
    },
    { waitSeconds: lockWaitSeconds, requireLock: true },
  );

  if (!lockResult.ok) throw lockResult.error;
  if (!lockResult.value.ran) {
    throw new Error('Another brain writer held the lock for the full wait window');
  }
  if (outcome === null) throw new Error('Retirement finished without a result');
  return outcome;
}

export interface RelocateOptions {
  /** Name or id of the mount to move. */
  mount?: string;
  /** The directory the mount should read from. */
  path?: string;
  /** Why the mount moved. Required; it is the governed record. */
  reason?: string;
  /** Accept a relocation that makes tracked origins look removed. */
  allowRemoved?: boolean;
  dryRun?: boolean;
  lockWaitSeconds?: string;
}

export interface RelocationReceipt {
  schemaVersion: number;
  kind: 'mount-relocation';
  runId: string;
  startedAt: string;
  finishedAt: string;
  workspace: string;
  dryRun: boolean;
  reason: string;
  mountId: string;
  mountName: string;
  fromPath: string;
  toPath: string;
  /** Scan counts across all mounts before and after the move. */
  before: MaintenanceScan['counts'];
  after: MaintenanceScan['counts'];
  /** This mount's origins the new directory no longer contains. */
  removedOrigins: string[];
  traceEventId: string | null;
}

/** Thrown inside the relocation transaction to roll back a dry run. */
class RelocationPreviewRollback extends Error {
  constructor() {
    super('Relocation dry run rolled back');
  }
}

/**
 * Point an existing mount at a different directory, keeping its id.
 *
 * Origins are keyed by mount id plus relative path, so a relocation keeps
 * every tracked source attached: identical files stay unchanged, differing
 * files recompile, and new files ingest on the next maintenance run. Removing
 * and re-adding the mount instead would mint a new id and make every origin
 * look removed. The move is scanned inside the same transaction that commits
 * it, and it refuses when the new directory would make tracked origins look
 * removed unless `allowRemoved` is set, so a wrong or empty directory cannot
 * silently orphan a mount.
 */
export async function relocateMount(
  workspacePath: string,
  dbPath: string,
  opts: RelocateOptions,
): Promise<{ receipt: RelocationReceipt; receiptPath: string | null }> {
  const reason = opts.reason?.trim() ?? '';
  if (reason.length < 10) {
    throw new Error('--reason is required and must say why the mount moved');
  }
  const mountRef = opts.mount?.trim() ?? '';
  if (mountRef.length === 0) throw new Error('--mount is required');
  const requestedPath = opts.path?.trim() ?? '';
  if (requestedPath.length === 0) throw new Error('--path is required');
  const toPath = resolve(requestedPath);
  if (!existsSync(toPath) || !statSync(toPath).isDirectory()) {
    throw new Error(`Not an existing directory: ${toPath}`);
  }
  const lockWaitSeconds = finiteNonNegative(opts.lockWaitSeconds, 10, '--lock-wait-seconds');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const startedAt = new Date().toISOString();
  let outcome: { receipt: RelocationReceipt; receiptPath: string | null } | null = null;

  const lockResult = await withWriteLock(
    () => {
      const dbResult = initDatabase(dbPath);
      if (!dbResult.ok) throw dbResult.error;
      const db = dbResult.value;
      try {
        const mountsResult = listMounts(db);
        if (!mountsResult.ok) throw mountsResult.error;
        const mount = mountsResult.value.find((m) => m.name === mountRef || m.id === mountRef);
        if (mount === undefined) throw new Error(`No mount found with name or id "${mountRef}"`);
        const canonical = (path: string): string =>
          existsSync(path) ? realpathSync(path) : resolve(path);
        if (canonical(mount.path) === canonical(toPath)) {
          throw new Error(`Mount "${mount.name}" already reads from ${toPath}`);
        }
        const clash = mountsResult.value.find(
          (m) => m.id !== mount.id && canonical(m.path) === canonical(toPath),
        );
        if (clash !== undefined) {
          throw new Error(`Mount "${clash.name}" already reads from ${toPath}`);
        }

        const before = scanMountedSources(db, workspacePath);
        const beforeRemoved = new Set(before.removedOrigins);
        const updatePath = db.prepare<[string, string], void>(
          'UPDATE mounts SET path = ? WHERE id = ?',
        );

        // Commit the path, rescan, and decide inside one transaction: any
        // refusal (or a dry run) throws and rolls the path back untouched.
        const state: { preview: RelocationReceipt | null; traceEventId: string | null } = {
          preview: null,
          traceEventId: null,
        };
        const apply = db.transaction(() => {
          updatePath.run(toPath, mount.id);
          const after = scanMountedSources(db, workspacePath);
          const prefix = `${mount.id}:`;
          const removedOrigins = after.removedOrigins
            .filter((key) => key.startsWith(prefix) && !beforeRemoved.has(key))
            .sort();
          state.preview = {
            schemaVersion: RELOCATION_RECEIPT_SCHEMA_VERSION,
            kind: 'mount-relocation',
            runId,
            startedAt,
            finishedAt: new Date().toISOString(),
            workspace: workspacePath,
            dryRun: opts.dryRun === true,
            reason,
            mountId: mount.id,
            mountName: mount.name,
            fromPath: mount.path,
            toPath,
            before: before.counts,
            after: after.counts,
            removedOrigins,
            traceEventId: null,
          };
          if (opts.dryRun === true) throw new RelocationPreviewRollback();
          if (removedOrigins.length > 0 && opts.allowRemoved !== true) {
            throw new Error(
              `Relocating "${mount.name}" to ${toPath} would make ${removedOrigins.length} ` +
                `tracked source(s) look removed (first: ${removedOrigins[0] ?? ''}); ` +
                'nothing changed. Pass --allow-removed to move anyway and retire them after.',
            );
          }
          const trace = writeTrace(
            db,
            workspacePath,
            'mount.relocate',
            {
              runId,
              reason,
              mountId: mount.id,
              mountName: mount.name,
              fromPath: mount.path,
              toPath,
              removedOrigins,
            },
            { summary: `Relocated mount "${mount.name}" to ${toPath}: ${reason}` },
          );
          if (!trace.ok) throw trace.error;
          state.traceEventId = trace.value.event_id;
        });

        if (opts.dryRun !== true) {
          // The audit line and the receipt are written after the DB commit.
          accessSync(operationDirectory(workspacePath, 'relocations'), fsConstants.W_OK);
          accessSync(join(workspacePath, 'audit', 'log.md'), fsConstants.W_OK);
        }
        let rolledBack = false;
        try {
          apply();
        } catch (error) {
          if (!(error instanceof RelocationPreviewRollback)) throw error;
          rolledBack = true;
        }
        if (rolledBack) {
          if (state.preview === null) throw new Error('Relocation preview was not produced');
          outcome = { receipt: state.preview, receiptPath: null };
          return;
        }
        const { preview, traceEventId: committedTrace } = state;
        if (preview === null || committedTrace === null) {
          throw new Error('Relocation committed without a trace');
        }
        const afterCommit = (error: unknown): Error =>
          new Error(
            `Relocation run ${runId} is committed (trace ${committedTrace}) but its ` +
              `audit line or receipt could not be written: ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
        const receipt: RelocationReceipt = {
          ...preview,
          finishedAt: new Date().toISOString(),
          traceEventId: committedTrace,
        };
        const audit = appendAuditLog(
          workspacePath,
          'mount.relocate',
          `Relocated mount "${mount.name}" from ${mount.path} to ${toPath} (run ${runId}): ${reason}`,
        );
        if (!audit.ok) throw afterCommit(audit.error);
        try {
          outcome = {
            receipt,
            receiptPath: writeOperationReceipt(
              operationDirectory(workspacePath, 'relocations'),
              receipt,
            ),
          };
        } catch (error) {
          throw afterCommit(error);
        }
      } finally {
        closeDatabase(db);
      }
    },
    { waitSeconds: lockWaitSeconds, requireLock: true },
  );

  if (!lockResult.ok) throw lockResult.error;
  if (!lockResult.value.ran) {
    throw new Error('Another brain writer held the lock for the full wait window');
  }
  if (outcome === null) throw new Error('Relocation finished without a result');
  return outcome;
}

export function register(program: Command): void {
  const maintain = program
    .command('maintain')
    .description('Scan mounted sources and run a receipted incremental compile')
    .option('--scan-only', 'Scan and write a receipt without ingesting or compiling')
    .option('--model <model>', 'Override the configured compiler model')
    .option(
      '--billing-mode <mode>',
      'Billing policy: metered enforces the ceiling; unmetered receipts usage without a USD stop',
      'metered',
    )
    .option('--daily-ceiling-usd <n>', 'Maximum projected UTC-day inference spend (metered only)')
    .option('--debounce-seconds <n>', 'Coalescing window for repeated triggers', '300')
    .option(
      '--max-input-age-days <n>',
      'Fail when any mount has no input newer than this; 0 disables',
      '0',
    )
    .option('--lock-wait-seconds <n>', 'Seconds to wait for the required brain write lock', '10')
    .option('--max-candidates <n>', 'Maximum mounted source candidates processed per run', '10')
    .addHelpText(
      'after',
      '\nOutcomes:\n  compiled       every eligible delta reached a compiled or governed outcome\n  partial        the bounded batch advanced, with remaining work receipted\n  verified_noop content hashes prove there was no eligible work\n  failure        stale/missing input, pending retirement, budget, lock, or compiler failure',
    )
    .action(async (opts: MaintainOptions, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      const resolved = resolveWorkspace(
        global.workspace !== undefined ? { workspace: global.workspace } : undefined,
      );
      if (!resolved.ok) {
        process.stderr.write(`${formatError(resolved.error.message)}\n`);
        process.exitCode = 1;
        return;
      }

      try {
        const receipt = await runMaintenance(resolved.value.root, resolved.value.dbPath, opts);
        printReceipt(receipt, global.json === true);
        if (receipt.status === 'failure') process.exitCode = 1;
      } catch (error) {
        process.stderr.write(
          `${formatError(error instanceof Error ? error.message : String(error))}\n`,
        );
        process.exitCode = 1;
      }
    });

  maintain
    .command('retire')
    .description('Retire mounted sources that were deliberately removed, with a receipt')
    .requiredOption('--reason <text>', 'Why the sources were removed (recorded in the receipt)')
    .option(
      '--origin <mount:path>',
      'A removed origin as <mount name or id>:<relative path>; repeatable',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--all-removed', 'Retire every origin the scan reports as removed')
    .option('--dry-run', 'Show what would be retired without writing anything')
    .option('--lock-wait-seconds <n>', 'Seconds to wait for the required brain write lock', '10')
    .action(async (opts: Omit<RetireOptions, 'origins'> & { origin?: string[] }, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      const resolved = resolveWorkspace(
        global.workspace !== undefined ? { workspace: global.workspace } : undefined,
      );
      if (!resolved.ok) {
        process.stderr.write(`${formatError(resolved.error.message)}\n`);
        process.exitCode = 1;
        return;
      }
      try {
        const { receipt, receiptPath } = await retireRemovedSources(
          resolved.value.root,
          resolved.value.dbPath,
          { ...opts, origins: opts.origin ?? [] },
        );
        if (global.json === true) {
          process.stdout.write(`${formatJSON(receipt)}\n`);
          return;
        }
        const verb = receipt.dryRun ? 'Would retire' : 'Retired';
        process.stdout.write(
          formatSuccess(`${verb} ${receipt.retired.length} removed source(s)`) + '\n',
        );
        for (const item of receipt.retired) {
          process.stdout.write(`  ${item.mountName}:${item.relativePath}\n`);
        }
        if (receiptPath !== null) {
          process.stdout.write(formatInfo(`Receipt: ${receiptPath}`) + '\n');
        }
      } catch (error) {
        process.stderr.write(
          `${formatError(error instanceof Error ? error.message : String(error))}\n`,
        );
        process.exitCode = 1;
      }
    });

  maintain
    .command('relocate')
    .description('Point a mount at a different directory, keeping its sources, with a receipt')
    .requiredOption('--mount <name>', 'Name or id of the mount to move')
    .requiredOption('--path <dir>', 'Directory the mount should read from')
    .requiredOption('--reason <text>', 'Why the mount moved (recorded in the receipt)')
    .option('--allow-removed', 'Move even if tracked sources would look removed')
    .option('--dry-run', 'Show the scan delta without writing anything')
    .option('--lock-wait-seconds <n>', 'Seconds to wait for the required brain write lock', '10')
    .action(async (opts: RelocateOptions, cmd: Command) => {
      const global = cmd.optsWithGlobals<GlobalOptions>();
      const resolved = resolveWorkspace(
        global.workspace !== undefined ? { workspace: global.workspace } : undefined,
      );
      if (!resolved.ok) {
        process.stderr.write(`${formatError(resolved.error.message)}\n`);
        process.exitCode = 1;
        return;
      }
      try {
        const { receipt, receiptPath } = await relocateMount(
          resolved.value.root,
          resolved.value.dbPath,
          opts,
        );
        if (global.json === true) {
          process.stdout.write(`${formatJSON(receipt)}\n`);
          return;
        }
        const verb = receipt.dryRun ? 'Would relocate' : 'Relocated';
        process.stdout.write(
          formatSuccess(`${verb} mount "${receipt.mountName}" to ${receipt.toPath}`) + '\n',
        );
        const keys = ['files', 'unchanged', 'changed', 'new'] as const;
        const delta = keys.map((k) => `${k} ${receipt.before[k]} -> ${receipt.after[k]}`);
        process.stdout.write(`  ${delta.join(', ')}\n`);
        process.stdout.write(`  removed by this move: ${receipt.removedOrigins.length}\n`);
        if (receiptPath !== null) {
          process.stdout.write(formatInfo(`Receipt: ${receiptPath}`) + '\n');
        }
      } catch (error) {
        process.stderr.write(
          `${formatError(error instanceof Error ? error.message : String(error))}\n`,
        );
        process.exitCode = 1;
      }
    });
}
